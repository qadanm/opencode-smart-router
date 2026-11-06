import { appendFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import type {
  ModelRecord,
  RuntimeMode,
  ModelRef,
  PremiumState,
  ProviderQuotaSnapshot,
  RouterSettings,
  RouterStatus,
  RoutingDecision,
  SessionState,
  TaskClass,
} from "../core/types.js"
import { classifyTask, type ClassifierFile } from "../core/classify/classifier.js"
import { computeContextHealth } from "../core/context-health.js"
import { decideCompaction, describeMode } from "../core/context/strategy.js"
import { repairMessages } from "../core/reprompt.js"
import { providerProtocol } from "../core/models/protocol.js"
import { PromptRouteTracker } from "./route-tracker.js"
import { buildProviderUsageReport } from "../core/quota/report.js"
import { resolvePlan, resolvePlanWithReason } from "../core/plans/catalog.js"
import { loadSettings, validateSettings, type SettingsLoadResult } from "../core/config.js"
import { writeSettingsPatch } from "../core/config-writer.js"
import { describeConsoleReading, parseConsolePage, type UsageReading } from "../core/plan-page.js"
import { reconcileUsage } from "../core/quota/reconcile.js"
import {
  applyCredentialDefaults,
  credentialEnvVars,
  credentialFileCandidates,
  describeEnablement,
  type ProviderEvidence,
} from "../core/providers/enablement.js"
import { classifyFailure } from "../core/failures.js"
import { buildRegistry } from "../core/models/registry.js"
import type { QuotaService } from "../core/quota/service.js"
import { LedgerStore, type BootstrapSession } from "../core/quota/ledger.js"
import {
  discoverOpenDesignControlKey,
  discoverOpenDesignCredentials,
} from "../core/quota/credentials.js"
import { routeTask } from "../core/routing/engine.js"
import {
  CALIBRATION_WINDOW_MS,
  MIN_REQUESTS_FOR_COST_EVIDENCE,
  resolveIntelligenceFloor,
  type CalibrationResult,
} from "../core/policy/calibration.js"
import { decidePremium, evaluateEligibility } from "../core/policy/eligibility.js"
import { sharedCore, type RuntimeOverrides } from "./shared-core.js"
import {
  ChangeNotifier,
  formatQuotaLines,
  indicatorState,
  providerShort,
  quotaStateLabel,
  stripTitlePrefix,
  type Indicator,
} from "../core/ui.js"
import {
  discoverOpenDesignModels,
  normalizeOpenDesignBaseURL,
} from "../core/providers/opendesign.js"
import { OPEN_DESIGN_MODEL_BY_ID } from "../core/providers/opendesign-models.js"
import { creditMultiplierFor } from "../core/providers/opendesign-credits.js"
import { SmartRouterRpc } from "../rpc.js"
import {
  describePlan,
  keyOfRef,
  modelKey,
  nowId,
  parseModelKey,
  percent,
  redact,
  safeError,
  truncate,
  unique,
  usd,
} from "../core/util.js"

interface ControllerOptions {
  readonly ctx: any
  readonly pluginOptions?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * How long one reported fault is treated as the same fault. The host reports
 * a failed attempt through several channels in quick succession, so this only
 * needs to span one attempt, not one session.
 */
/**
 * How long a computed floor is reused.
 *
 * Calibration reads the usage rollup, which changes per request rather than per
 * candidate. Recomputing it for every routing decision would be wasted work in a
 * multi-step loop; this is short enough that a spend change is picked up within
 * a session.
 */
const FLOOR_CACHE_MS = 30_000

const FAULT_DEDUPE_WINDOW_MS = 30_000

/**
 * How long the router waits after triggering a compaction before it may
 * trigger another for the same session. The strategy's configured cooldown
 * supersedes this; it is retained as the documented upper bound.
 */
const ROUTER_COMPACT_COOLDOWN_MS = 10 * 60_000

/**
 * Fallbacks for the context constants. The strategy module owns the real
 * values; these names are kept so existing call sites read the same way.
 */
const CONTEXT_ELIGIBILITY_MARGIN_TOKENS = 20_000
const CONTEXT_SAFE_WINDOW_FRACTION = 0.95

/**
 * How many attempts a provider-scoped failure may have before the router
 * stops retrying. Each attempt is refused before a model runs, so it costs
 * no allowance. The delay is the only price, and it is far cheaper than a
 * turn dying and waiting for the owner to restart it.
 */
const PROVIDER_SCOPED_RETRY_ATTEMPTS = 5

/**
 * How long to avoid a provider whose allowance is spent, when nothing is known
 * about when it resets.
 *
 * Deliberately longer than a transient backoff: an empty allowance does not
 * recover in seconds, and re-probing it on every prompt costs a failed turn
 * each time to relearn the same fact. A known reset time always wins over this.
 */
const QUOTA_EXHAUSTED_FALLBACK_MS = 30 * 60 * 1000

const unwrap = <T>(value: unknown): T[] => {
  if (Array.isArray(value)) return value as T[]
  if (isRecord(value) && Array.isArray(value.data)) return value.data as T[]
  return []
}

const modelRefFrom = (value: unknown): ModelRef | undefined => {
  if (!isRecord(value)) return undefined
  if (typeof value.providerID !== "string" || typeof value.id !== "string") return undefined
  return {
    providerID: value.providerID,
    id: value.id,
    ...(typeof value.variant === "string" ? { variant: value.variant } : {}),
  }
}

const tokensFrom = (value: unknown) => {
  if (!isRecord(value)) return { input: 0, output: 0, cache: { read: 0, write: 0 } }
  const cache = isRecord(value.cache) ? value.cache : {}
  return {
    input: typeof value.input === "number" ? value.input : 0,
    output: typeof value.output === "number" ? value.output : 0,
    cache: {
      read: typeof cache.read === "number" ? cache.read : 0,
      write: typeof cache.write === "number" ? cache.write : 0,
    },
  }
}

const applyRuntime = (base: RouterSettings, runtime: RuntimeOverrides): RouterSettings => {
  const next = structuredClone(base) as any
  if (runtime.mode) next.mode = runtime.mode
  if (runtime.paused === true) next.enabled = false
  if (typeof runtime.dryRun === "boolean") next.dryRun = runtime.dryRun
  if (typeof runtime.sidebarGroups === "boolean") next.ui.sidebarGroups = runtime.sidebarGroups
  if (typeof runtime.compactMode === "boolean") {
    next.ui.compactMode = runtime.compactMode
    next.ui.compact = runtime.compactMode
    next.compactMode = runtime.compactMode
    next.compact = runtime.compactMode
  }
  if (typeof runtime.compact === "boolean") {
    next.ui.compactMode = runtime.compact
    next.ui.compact = runtime.compact
    next.compactMode = runtime.compact
    next.compact = runtime.compact
  }
  if (typeof runtime.premiumBudgetUsd === "number") next.premium.monthlyBudgetUsd = runtime.premiumBudgetUsd
  if (runtime.reserves) {
    for (const [providerID, reserve] of Object.entries(runtime.reserves)) {
      const provider = next.providers[providerID]
      if (!provider) continue
      if (typeof reserve.monthlyPct === "number") provider.reserveMonthlyPct = reserve.monthlyPct
      if (typeof reserve.weeklyPct === "number") provider.reserveWeeklyPct = reserve.weeklyPct
      if (typeof reserve.fiveHourPct === "number") provider.reserveFiveHourPct = reserve.fiveHourPct
    }
  }
  const excluded = unique([...(next.models.excluded as string[]), ...(runtime.excluded ?? [])])
  const approved = unique([...(next.models.approved as string[]), ...(runtime.approved ?? [])])
  next.models.excluded = excluded
  next.models.approved = approved
  return next as RouterSettings
}

export class RouterBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RouterBlockedError"
  }
}

export class RouterController {
  private readonly ctx: any
  private settingsBase: RouterSettings
  private settingsWarnings: string[]
  private settingsSources: string[]
  private runtime: RuntimeOverrides = {}
  private ledger: LedgerStore
  private registry = buildRegistry({
    live: [],
    settings: loadSettings({ options: {} }).settings,
  })
  private quota!: QuotaService
  private bridgeID = ""
  private readonly expectedSwitch = new Map<string, { key: string; at: number }>()
  /**
   * Request-kind latch keyed by session, written by the `model.request` hook
   * and consumed one-shot by the `context` hook (whose event carries no kind).
   * The agent loop folds prompts; title and compaction runs do not.
   */
  private readonly requestKinds = new Map<string, { kind: string; at: number }>()
  /** The routed task per session's current prompt, for prompt-rejection failover. */
  private readonly promptRoutes = new PromptRouteTracker()
  /**
   * Failovers parked because the session was still busy at rejection time,
   * flushed once the host marks the turn over. One entry, one prompt.
   */
  private readonly pendingHeals = new Map<string, { chosen: ModelRecord; base: RoutingDecision; rejectedLabel: string }>()
  /** Memoized calibrated floor; see routingFloor(). */
  private floorCache?: { at: number; value: { floor: number; calibration?: CalibrationResult } }
  /**
   * Guards against counting one logical provider failure several times.
   *
   * The host reports a single failed attempt through several channels: the
   * retry hook, `session.step.failed`, `session.execution.failed` and
   * `session.idle`. Without this guard each channel added its own strike,
   * so one fault could count three times and inflate the failure tally and
   * the cooldown that is derived from it.
   *
   * The key is the session plus the identity of the attempt itself, so a
   * genuinely new failure later in the session still counts separately.
   */
  private readonly recordedFaults = new Map<string, number>()
  /**
   * Every model a session has been seen on, keyed by model key.
   *
   * The desktop client sends the model it has saved for a session with each
   * prompt. When the router has switched that session to something else, the
   * client's saved model is stale, so the next prompt switches the session
   * back and the host reports a model change the router did not make. That
   * change is always to a model the session has already been on, which is
   * what distinguishes it from the owner picking a model they have not used.
   */
  private readonly modelsSeen = new Map<string, Set<string>>()
  /** When the router last triggered a compaction, per session. */
  private readonly routerCompactAt = new Map<string, number>()
  /** Last context-management decision per session, for diagnostics. */
  private readonly lastCompactionDecision = new Map<
    string,
    ReturnType<typeof decideCompaction>
  >()
  private readonly inflight = new Set<string>()
  private readonly promptSeen = new Set<string>()
  private readonly created = new Map<string, number>()
  private readonly stepStarted = new Map<string, number>()
  private readonly contextLoaded = new Set<string>()
  private readonly contextInflight = new Map<string, Promise<void>>()
  /** What credential detection found on this machine, for the first-run screen. */
  private detectedProviders: ReadonlyArray<{ providerID: string; hasCredential: boolean; source?: string }> = []
  /** Set once the user has seen the first-run screen. */
  private onboardingComplete = false
  private readonly explicitProviderEnable: ReadonlySet<string>
  private readonly titleQueue = new Map<string, Promise<void>>()
  private readonly notifier = new ChangeNotifier()
  private rpcRegistration: any
  private readonly registrations: any[] = []
  private readonly dirCache = new Map<string, string>()
  private readonly localDir: string
  private cleanupDone = false

  constructor(options: ControllerOptions) {
    this.ctx = options.ctx
    this.localDir = this.canonicalDir(options.ctx.location?.directory)
    const loaded = loadSettings({
      options: options.pluginOptions,
      directory: this.ctx.location?.directory,
      projectDirectory: this.ctx.location?.directory,
    })
    this.settingsBase = loaded.settings
    this.settingsWarnings = loaded.warnings
    this.settingsSources = loaded.sources
    // Which provider enable/disable flags the user wrote themselves. Detection
    // fills in the ones they never mentioned and never overrules these.
    this.explicitProviderEnable = loaded.explicitProviderEnable
    this.ledger = new LedgerStore()

    // A plan id that matches nothing must never resolve silently to whatever
    // tier this repository defaults to: that could overstate the allowance a
    // routing decision is allowed to spend.
    for (const [providerID, provider] of Object.entries(loaded.settings.providers)) {
      if (!provider?.enabled) continue
      const resolved = resolvePlanWithReason(providerID, provider.plan)
      if (resolved.resolution === "unknown") {
        this.settingsWarnings.push(
          `providers.${providerID}.plan is "${provider.plan}", which is not a known plan for ${providerID}. Using ${resolved.planID ?? "no plan"}, so quota may be miscalculated. Set a plan id from the catalog.`,
        )
      }
    }
  }

  private get settings(): RouterSettings {
    return applyRuntime(this.settingsBase, this.runtime)
  }

  /**
   * The runtime mode for one session.
   *
   * A session can be paused on its own, without touching any other session and
   * without disabling the plugin. `SessionState.paused` existed but nothing ever
   * read it, so the switch in the panel would have done nothing. Keeping the
   * rule in one place is what stops the prompt path, the status panel and the
   * compaction path from disagreeing about whether a session is routed.
   */
  private runtimeFor(session: SessionState | undefined): RuntimeMode {
    if (!this.settings.enabled) return "paused"
    if (this.runtime.paused === true) return "paused"
    if (session?.paused === true) return "paused"
    return session?.manualOverride ? "manual" : "automatic"
  }

  /** RPC and storage require plain JSON values; optional undefined is not JSON. */
  private safe<T>(value: T): any {
    return JSON.parse(JSON.stringify(value))
  }

  private persistLedgerSoon() {
    sharedCore.persistSoon()
  }

  private persistRuntime() {
    sharedCore.runtime = this.runtime
    sharedCore.persistRuntimeSoon()
  }

  private async emit(name: "decision" | "status" | "quota", data: Record<string, unknown>) {
    try {
      await this.rpcRegistration?.events.emit(name, this.safe(data))
    } catch {
      // Events are advisory; a missing GUI connection must not affect routing.
    }
  }

  private async loadModels() {
    try {
      this.modelList = await sharedCore.getLiveModels()
      this.rebuildRegistry()
    } catch (error) {
      this.settingsWarnings.push(`Could not refresh the live model catalog: ${safeError(error)}`)
    }
  }

  private rebuildRegistry() {
    const live = unwrap<any>(this.modelList ?? [])
    this.registry = buildRegistry({
      live,
      settings: this.settings,
      definitions: this.settings.models.definitions as any,
    })
  }

  private modelList: unknown = []

  async initialize(): Promise<() => void | Promise<void>> {
    // Before anything reads settings: a provider the user never configured
    // should be on only if this machine can actually reach it.
    await this.applyProviderDetection()
    await sharedCore.init({
      ctx: this.ctx,
      getSettings: () => this.settings,
      getCredentials: () => this.resolveQuotaCredentials(),
    })
    this.ledger = sharedCore.ledger
    this.runtime = sharedCore.runtime
    const quota = sharedCore.quota
    if (!quota) throw new Error("Shared quota service is not initialized")
    this.quota = quota
    this.bridgeID = sharedCore.addBridge(this.ctx.location?.directory ?? "", this)
    this.modelList = []
    this.rebuildRegistry()

    // The shared core owns quota probes, session bootstrap, and ledger writes.
    // Register the user-facing surface without awaiting any network work.
    await this.registerRpc()
    await this.registerCommands()
    await this.registerHooks()
    void this.loadModels()

    return () => this.dispose()
  }

  /**
   * Decide which providers this machine can actually reach.
   *
   * Runs before the shared core reads settings. A provider the user never
   * mentioned is enabled only when a credential or connection exists for it, so
   * a stranger stops getting "authentication is failing" for an account they
   * never claimed. A provider the user did mention is left exactly as they set
   * it, and any disagreement is reported rather than acted on.
   *
   * Nothing here reads a secret. Existence is enough to answer the question.
   */
  private async applyProviderDetection(): Promise<void> {
    try {
      const evidence: ProviderEvidence[] = []

      const connected = async (integration: string): Promise<boolean> => {
        try {
          const connection = await this.ctx.integration.connection.active(integration as never)
          return Boolean(connection)
        } catch {
          return false
        }
      }

      const providerKey = async (providerID: string): Promise<boolean> => {
        try {
          const provider: any = await this.ctx.provider.get({ providerID })
          const info = provider?.data ?? provider
          return typeof info?.settings?.apiKey === "string" && info.settings.apiKey.length > 0
        } catch {
          return false
        }
      }

      const fileOrEnv = (providerID: string): { has: boolean; source?: string } => {
        for (const name of credentialEnvVars(providerID)) {
          if (process.env[name]?.trim()) return { has: true, source: name }
        }
        for (const path of credentialFileCandidates(providerID, homedir())) {
          try {
            if (existsSync(path)) return { has: true, source: path.replace(homedir(), "~") }
          } catch {
            // Unreadable path is not evidence either way.
          }
        }
        return { has: false }
      }

      const goConnected = await connected("opencode")
      if (goConnected) evidence.push({ providerID: "opencode-go", hasCredential: true, source: "OpenCode connection" })

      const commandCodeConnection = await connected("commandcode")
      const commandCodeFiles = fileOrEnv("commandcode")
      const commandCodeKey = await providerKey("commandcode")
      evidence.push({
        providerID: "commandcode",
        hasCredential: commandCodeConnection || commandCodeFiles.has || commandCodeKey,
        ...(commandCodeConnection
          ? { source: "Command Code integration" }
          : commandCodeFiles.source
            ? { source: commandCodeFiles.source }
            : commandCodeKey
              ? { source: "OpenCode provider settings" }
              : {}),
      })

      const openDesignFiles = fileOrEnv("opendesign")
      const openDesignKey = await providerKey("opendesign")
      evidence.push({
        providerID: "opendesign",
        hasCredential: openDesignFiles.has || openDesignKey,
        ...(openDesignFiles.source
          ? { source: openDesignFiles.source }
          : openDesignKey
            ? { source: "OpenCode provider settings" }
            : {}),
      })

      // Keep the evidence: onboarding shows what was found, not a form.
    this.detectedProviders = evidence
    const result = applyCredentialDefaults(this.settingsBase, this.explicitProviderEnable, evidence)
      if (result.settings !== this.settingsBase) {
        this.settingsBase = result.settings
        this.rebuildRegistry()
      }
      for (const line of describeEnablement(result)) {
        if (!this.settingsWarnings.includes(line)) this.settingsWarnings.push(line)
      }
      for (const providerID of result.keptOnByChoice) {
        const line = `providers.${providerID} stays enabled with no credential found — you asked for it`
        if (!this.settingsWarnings.includes(line)) this.settingsWarnings.push(line)
      }
      for (const providerID of result.keptOffByChoice) {
        const line = `providers.${providerID} credentials found but the provider stays disabled — you asked for it`
        if (!this.settingsWarnings.includes(line)) this.settingsWarnings.push(line)
      }
    } catch (error) {
      // Detection is a convenience. A failure must never stop routing.
      this.settingsWarnings.push(`Provider detection skipped: ${safeError(error)}`)
    }
  }

  /**
   * Everything a first-run screen needs, in one call.
   *
   * The shape is deliberate: evidence first, then a single action. A new user
   * should be able to read this and know three things without clicking — what
   * the router found on their machine, what it will do with it, and whether it
   * needs anything from them (it usually does not).
   */
  private onboardingState(): {
    firstRun: boolean
    providers: ReadonlyArray<{ providerID: string; label: string; found: boolean; source?: string; enabled: boolean }>
    historyImported: number
    hasHistory: boolean
    needsReading: boolean
    mode: string
    version: string
  } {
    const enabled = this.settings.providers
    const providers = this.detectedProviders.map((entry) => ({
      providerID: entry.providerID,
      label: entry.providerID === "opencode-go" ? "OpenCode Go" : entry.providerID === "commandcode" ? "Command Code GOAT" : entry.providerID === "opendesign" ? "OpenDesign" : entry.providerID,
      found: entry.hasCredential,
      ...(entry.source ? { source: entry.source } : {}),
      enabled: enabled[entry.providerID]?.enabled ?? false,
    }))

    const imported = this.ledger
      .usageEvents()
      .filter((event) => String(event.id).startsWith("hist:"))
    return {
      // First run is "nothing has been chosen yet": no baseline, no explicit
      // provider flags. Reading a file nobody wrote is not a first run.
      firstRun: !this.onboardingComplete && this.explicitProviderEnable.size === 0,
      providers,
      historyImported: imported.length,
      hasHistory: imported.length > 0,
      needsReading: this.quotaSnapshots().some((snapshot) => snapshot.source === "estimate"),
      mode: this.settings.mode,
      version: "0.2.0",
    }
  }

  /**
   * Record what the account page showed.
   *
   * The whole point is that the user pastes what they see. They should not have
   * to know that Pro's seven-day window is $90, or divide 42% by anything — the
   * server owns the caps, so the server does the arithmetic.
   *
   * Writes through config-writer, which preserves every other key, validates the
   * result and keeps a backup, so a mistake here is recoverable.
   */
  /**
   * Read whatever console page was pasted.
   *
   * One entry point for both page types, because the user should not have to
   * decide which page we want. An allowance page seeds the estimate; a usage
   * page checks the cost model against what was actually charged. Both preview
   * before writing, because a paste is not a promise that it was understood.
   */
  private async recordPlanPage(input: {
    page?: string
    confirm?: boolean
  }): Promise<{
    ok: boolean
    message: string
    preview?: {
      kind: "allowance" | "usage"
      summary: string
      found: string[]
      missing: string[]
      /** For a usage page: whether the catalog agrees with what was charged. */
      reconciliation?: { summary: string; agree: number; differ: number; rows: ReadonlyArray<unknown> }
      apply: Record<string, unknown>
    }
    backup?: string
  }> {
    const reading = parseConsolePage(input.page ?? "")
    if (!reading) {
      return {
        ok: false,
        message:
          "That page could not be read. Paste either the Plan & balance page or the Usage page, including its model table.",
      }
    }

    if (reading.kind === "usage") {
      const reconciliation = reconcileUsage(reading as UsageReading)
      const summary = describeConsoleReading(reading)
      // A usage page tells us whether our arithmetic is right. It does not tell
      // us how much allowance is left, so nothing is written from it — writing a
      // baseline from a token table would be inventing a percentage.
      return {
        ok: true,
        message: reconciliation.differ > 0 ? `${summary} ${reconciliation.summary}` : summary,
        preview: {
          kind: "usage",
          summary,
          found: [...reading.found],
          missing: [...reading.missing],
          reconciliation: {
            summary: reconciliation.summary,
            agree: reconciliation.agree,
            differ: reconciliation.differ,
            rows: [...reconciliation.rows] as ReadonlyArray<unknown>,
          },
          apply: {},
        },
      }
    }

    if (reading.designPlanUsedPct === undefined) {
      return { ok: false, message: describeConsoleReading(reading) }
    }

    const at = Date.now()
    const baseline: Record<string, unknown> = {
      at,
      designPlanUsedPct: reading.designPlanUsedPct,
      pctOf: reading.pctOf ?? "weekly",
    }
    if (reading.resetsAt !== undefined) baseline.weeklyResetsAt = reading.resetsAt
    if (reading.periodEndsAt !== undefined) baseline.monthlyResetsAt = reading.periodEndsAt

    /**
     * Pasting a balance is an opt-in.
     *
     * Nobody records their OpenDesign usage in order to leave it switched off, so
     * the write states `enabled: true` explicitly. That also makes the intent
     * survive: an explicit flag is something detection will never overrule, which
     * is the correct relationship between a config file and a guess.
     */
    const patch: Record<string, unknown> = { providers: { opendesign: { baseline, enabled: true } } }
    if (reading.plan && resolvePlan("opendesign", reading.plan.toLowerCase())) {
      ;(patch.providers as any).opendesign.plan = reading.plan.toLowerCase()
    }

    const preview = {
      kind: "allowance" as const,
      summary: describeConsoleReading(reading),
      found: [...reading.found],
      missing: [...reading.missing],
      apply: patch,
    }

    if (input.confirm !== true) {
      return { ok: true, message: preview.summary, preview }
    }

    try {
      const result = writeSettingsPatch({
        patch,
        validate: (merged) => {
          const loaded = validateSettings(merged)
          if (loaded.settings.providers.opendesign?.baseline === undefined) {
            return "That reading could not be applied. Check the page and try again."
          }
          return undefined
        },
      })
      await this.reloadSettingsFromDisk()
      return {
        ok: true,
        message: `Recorded. ${preview.summary}.`,
        preview,
        ...(result.backup ? { backup: result.backup } : {}),
      }
    } catch (error) {
      return { ok: false, message: safeError(error) }
    }
  }

  /** Re-read settings after the GUI writes, so the panel reflects the change at once. */
  private async reloadSettingsFromDisk(): Promise<void> {
    const loaded = loadSettings({
      options: this.ctx.options,
      directory: this.ctx.location?.directory,
      projectDirectory: this.ctx.location?.directory,
    })
    this.settingsBase = loaded.settings
    this.settingsWarnings = loaded.warnings
    this.settingsSources = loaded.sources

    /**
     * Detection must run again after a reload.
     *
     * Without this, writing any config fragment that omits a provider's
     * `enabled` flag silently disables it: the file no longer says "enabled",
     * DEFAULT_SETTINGS says disabled, and the only thing that had been turning it
     * back on was startup detection. The visible symptom was a provider showing
     * as disabled immediately after the user pasted their balance into it.
     */
    await this.applyProviderDetection()
    this.rebuildRegistry()
    // Snapshots in the cache were computed from the settings that just changed,
    // so they must go before the re-probe rather than being served as stale.
    this.quota?.invalidate()
    // Re-probe what can be probed, so the panel reflects the new reading at once.
    await Promise.allSettled([
      this.quota?.refresh("opencode-go", true),
      this.quota?.refresh("commandcode", true),
      this.quota?.refresh("opendesign", true),
    ])
  }

  /**
   * When this provider's next window opens, from the best data available.
   *
   * Prefers the tightest window that has a reset time, because that is the one
   * that would unblock the account soonest. Falls back to a modest hold when
   * nothing is known, which is far better than re-probing on every prompt.
   */
  private providerResetAt(providerID: string, now = Date.now()): number {
    const fallback = now + QUOTA_EXHAUSTED_FALLBACK_MS
    const snapshot = this.quotaSnapshots().find((entry) => entry.providerID === providerID)
    if (!snapshot) return fallback
    const resets = [snapshot.rolling?.resetsAt, snapshot.weekly?.resetsAt, snapshot.monthly?.resetsAt]
      .filter((value): value is number => typeof value === "number" && value > now)
      .sort((left, right) => left - right)
    return resets[0] ?? fallback
  }

  private async resolveQuotaCredentials() {    let goAccessToken: string | undefined
    let commandCodeIntegrationKey: string | undefined
    try {
      const connection = await this.ctx.integration.connection.active("opencode")
      if (connection) {
        const credential: any = await this.ctx.integration.connection.resolve(connection)
        goAccessToken = credential?.type === "oauth" ? credential.access : credential?.type === "key" ? credential.key : undefined
      }
    } catch {
      // The Go connection is optional.
    }
    try {
      const connection = await this.ctx.integration.connection.active("commandcode")
      if (connection) {
        const credential: any = await this.ctx.integration.connection.resolve(connection)
        commandCodeIntegrationKey = credential?.type === "key" ? credential.key : credential?.type === "oauth" ? credential.access : undefined
      }
    } catch {
      // The Command Code integration may not be connected; file discovery remains.
    }
    let commandCodeProviderKey: string | undefined
    try {
      const provider = await this.ctx.provider.get({ providerID: "commandcode" })
      const info: any = (provider as any)?.data ?? provider
      commandCodeProviderKey = info?.settings?.apiKey
    } catch {
      // Ignore.
    }
    const { openDesignApiKey, openDesignControlKey } = await this.resolveOpenDesignCredentials()
    return {
      goAccessToken,
      commandCodeIntegrationKey,
      commandCodeProviderKey,
      openDesignApiKey,
      openDesignControlKey,
    }
  }

  /**
   * Resolve the OpenDesign inference key and, only when the owner configured
   * one explicitly, the account-control key.
   *
   * The inference key can call the model gateway but cannot read quota. The
   * control key can read the account's usage windows and is a privileged
   * credential, so it is never discovered automatically and never requested.
   */
  private async resolveOpenDesignCredentials(): Promise<{ openDesignApiKey?: string; openDesignControlKey?: string }> {
    const providerSettings = this.settings.providers.opendesign
    if (!providerSettings?.enabled) return {}

    let providerSettingsKey: string | undefined
    try {
      const provider: any = await this.ctx.provider.get({ providerID: "opendesign" })
      const info: any = provider?.data ?? provider
      providerSettingsKey = info?.settings?.apiKey
    } catch {
      // The provider may not be configured in OpenCode; file discovery remains.
    }

    const discovered = discoverOpenDesignCredentials({
      explicitPath: providerSettings.credentialPath,
      providerSettingsKey,
      credentialSource: providerSettings.credentialSource,
    })
    for (const warning of discovered.warnings) {
      if (!this.settingsWarnings.includes(warning)) this.settingsWarnings.push(warning)
    }

    const controls = discoverOpenDesignControlKey({
      explicitPath: providerSettings.controlKeyPath,
    })
    for (const warning of controls.warnings) {
      if (!this.settingsWarnings.includes(warning)) this.settingsWarnings.push(warning)
    }

    return {
      openDesignApiKey: discovered.candidates[0]?.key,
      openDesignControlKey: controls.candidates[0]?.key,
    }
  }

  private sessionState(sessionID: string): SessionState {
    return this.ledger.ensureSession(sessionID)
  }

  private canonicalDir(value?: string): string {
    if (!value) return ""
    const cached = this.dirCache.get(value)
    if (cached) return cached
    let out = resolve(value)
    if (out.startsWith("/private/")) out = out.slice("/private".length)
    if (this.dirCache.size >= 500) {
      const oldest = this.dirCache.keys().next().value
      if (oldest) this.dirCache.delete(oldest)
    }
    this.dirCache.set(value, out)
    return out
  }

  /**
   * A location owns a session when the project ids match, or when the
   * session's directory is the location directory or inside it. The second
   * check matters when a location is opened at a subdirectory of a project:
   * the session then carries the parent project id but still belongs here.
   */
  projectMatches(projectID?: string, directory?: string) {
    const localID = this.ctx.location?.project?.id
    if (projectID && localID && projectID === localID) return true
    const remote = this.canonicalDir(directory)
    if (this.localDir && remote) {
      return remote === this.localDir || remote.startsWith(`${this.localDir}/`)
    }
    return !projectID || !localID
  }

  private ownsSession(session: SessionState) {
    if (session.directory) return this.projectMatches(undefined, session.directory)
    const localID = this.ctx.location?.project?.id
    return !localID || !session.projectID || session.projectID === localID
  }

  private remember(set: Set<string>, id: string, max = 1_000) {
    if (!set.has(id) && set.size >= max) {
      const oldest = set.values().next().value
      if (oldest) set.delete(oldest)
    }
    set.add(id)
  }

  private async loadSessionInfo(sessionID: string) {
    try {
      const info: any = await this.ctx.session.get({ sessionID })
      if (!this.projectMatches(info?.projectID, info?.location?.directory)) return
      sharedCore.claimSession(sessionID, this.bridgeID)
      const model = modelRefFrom(info?.model)
      const parentID = typeof info?.parentID === "string" ? info.parentID : undefined
      const title = typeof info?.title === "string" ? info.title : undefined
      const session = this.ledger.ensureSession(sessionID, parentID, title)
      if (info?.projectID) this.ledger.patchSession(sessionID, { projectID: String(info.projectID) })
      if (info?.location?.directory) {
        this.ledger.patchSession(sessionID, { directory: String(info.location.directory) })
      }
      const baseTitle = stripTitlePrefix(typeof info?.title === "string" ? info.title : title)
      if (baseTitle && !session.baseTitle) {
        this.ledger.patchSession(sessionID, { baseTitle })
      }
      if (model) {
        this.ledger.patchSession(sessionID, {
          lastModel: model,
          ...(session.manualOverride ? { manualModel: model } : {}),
        })
      }
      // The context size decides which providers may serve this session, so
      // it has to be the size of the transcript the next request carries.
      //
      // `info.tokens` is the session's CUMULATIVE usage across its whole
      // life, not that size. It grows without bound, so it can only ever be
      // an upper bound, and using it makes a session look far larger than it
      // is - which pushes it off providers whose window it would actually
      // fit in. The transcript read below gives the real number.
      if (session.contextTokens === 0) {
        const real = await this.readCurrentContext(sessionID)
        if (real !== undefined) {
          this.ledger.patchSession(sessionID, {
            contextTokens: real.contextTokens,
            cacheReadTokens: real.cacheReadTokens,
          })
        } else {
          // The read failed. Assume a modest transcript rather than
          // inventing a number that would wrongly exclude a model.
          const created = Number(info?.time?.created) || 0
          const updated = Number(info?.time?.updated) || 0
          let estimate = 0
          if (info?.fork) {
            // A fork inherits a transcript but may carry no cumulative usage.
            estimate = 350_000
          } else if (created > 0 && updated - created > 60_000) {
            estimate = 150_000
          }
          if (estimate > 0) {
            this.ledger.patchSession(sessionID, { contextTokens: estimate, cacheReadTokens: 0 })
          }
        }
      }
    } catch {
      // The prompt can still be routed from ledger state if the read fails.
    }
  }

  private indicatorFor(sessionID: string, session: SessionState | undefined): Indicator {
    const settings = this.settings
    const state = session?.indicatorTitle?.startsWith("BLOCKED ·")
      ? "BLOCKED"
      : indicatorState({
          enabled: settings.enabled,
          runtimePaused: this.runtime.paused === true,
          manual: session?.manualOverride === true,
          dryRun: settings.dryRun,
        })
    const ref = session?.pinnedModel ?? session?.manualModel ?? session?.lastModel
    const model = ref ? this.registry.get(ref.providerID, ref.id) : undefined
    return {
      state,
      ...(ref ? { provider: providerShort(ref.providerID), model: ref.id } : {}),
      ...(model ? { modelLabel: model.name } : ref ? { modelLabel: ref.id } : {}),

    }
  }

  private queueTitle(sessionID: string) {
    const previous = this.titleQueue.get(sessionID) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => this.applyTitleNow(sessionID))
      .catch(() => undefined)
      .finally(() => {
        if (this.titleQueue.get(sessionID) === next) this.titleQueue.delete(sessionID)
      })
    this.titleQueue.set(sessionID, next)
    return next
  }

  /**
   * The router never renames a session.
   *
   * A chat title is the owner's name for the work, and a plugin that rewrites it
   * to advertise which model it picked trades the owner's memory for the
   * plugin's status line. Status lives in the panel, the terminal footer and the
   * decision record instead.
   *
   * One exception remains, and it only runs against titles this plugin wrote in
   * an older version: a single pass that strips the prefix when the session is
   * next touched, so upgrades heal instead of leaving `AUTO · OD · model`
   * forever.
   */
  private async applyTitleNow(sessionID: string) {
    const session = this.ledger.getSession(sessionID)
    if (!session) return
    let info: any
    try {
      info = await this.ctx.session.get({ sessionID })
    } catch {
      info = undefined
    }
    if (!this.projectMatches(info?.projectID, info?.location?.directory)) return
    const currentTitle = typeof info?.title === "string" ? info.title : undefined

    {
      /**
       * The indicator is off. If a previous version of this plugin left its
       * prefix on the title, put the name back once, the first time the session
       * is touched. Without this, upgrading would leave every old chat reading
       * "AUTO · OD · Model — name" forever, because the prefix lives in
       * OpenCode's database and the router no longer rewrites it.
       */
      const stripped = stripTitlePrefix(currentTitle)
      if (currentTitle && stripped && stripped !== currentTitle.trim()) {
        try {
          await this.ctx.session.update({ sessionID, title: stripped })
          this.ledger.patchSession(sessionID, { title: stripped, indicatorTitle: undefined })
        } catch {
          // Leaving the prefix is better than failing the prompt over a title.
        }
      }
      return
    }

  }

  /** Strips prefixes this plugin wrote. Returns how many titles changed. */
  private async restoreTitles(): Promise<number> {
    let restored = 0
    for (const session of Object.values(this.ledger.data.sessions)) {
      if (!this.ownsSession(session)) continue
      const visible = session.title ?? session.indicatorTitle
      const base = session.baseTitle || stripTitlePrefix(visible)
      // A title that is only a prefix has no name left to restore. Rewriting it
      // to the prefix again would keep the damage; leave it for the owner.
      if (!base || base === visible) continue
      try {
        await this.ctx.session.update({ sessionID: session.sessionID, title: base })
        this.ledger.patchSession(session.sessionID, { title: base, indicatorTitle: undefined })
        restored += 1
      } catch (error) {
        this.settingsWarnings.push(`Could not restore session title: ${safeError(error)}`)
      }
    }
    return restored
  }

  private async notifyChange(key: string, message: string) {
    if (!this.settings.ui.notifications) return
    if (!this.notifier.shouldNotify(key)) return
    await this.notifier.notify(message)
  }

  private modelNotice(sessionID: string, state: string, ref: ModelRef | undefined, reason?: string) {
    if (!ref) return
    const model = this.registry.get(ref.providerID, ref.id)
    const label = `${providerShort(ref.providerID)} · ${model?.name ?? ref.id}`
    const detail = reason ? ` — ${reason}` : ""
    void this.notifyChange(
      `${sessionID}:${state}:${ref.providerID}:${ref.id}:${reason ?? ""}`,
      `${state} · ${label}${detail}`,
    )
  }

  /**
   * Measured generation speed per model, for the routing engine.
   *
   * Only models with enough samples are passed; the engine applies its own
   * minimum, so a single fast request cannot promote a model on noise.
   */
  private speedSnapshot(): Record<string, { tokensPerSecond: number; samples: number }> {
    const out: Record<string, { tokensPerSecond: number; samples: number }> = {}
    for (const [key, metrics] of Object.entries(this.ledger.snapshotMetrics().byModel)) {
      if (metrics.outputTokensPerSecond <= 0 || metrics.latencySamples <= 0) continue
      out[key] = {
        tokensPerSecond: metrics.outputTokensPerSecond,
        samples: metrics.latencySamples,
      }
    }
    return out
  }

  private premiumState(session?: SessionState): PremiumState {    const spent = this.ledger.premiumSpent()
    const budget = this.settings.premium.monthlyBudgetUsd
    return {
      mode: this.settings.premium.mode,
      monthlyBudgetUsd: budget,
      spentUsd: spent,
      remainingUsd: Math.max(0, budget - spent),
      oneShotGranted: session?.premiumOneShot === true,
      ...(session?.premiumOneShotAt ? { oneShotGrantedAt: session.premiumOneShotAt } : {}),
    }
  }

  private quotaSnapshots() {
    return this.quota
      ? this.quota.read().map((snapshot) => {
          const providerSettings = this.settings.providers[snapshot.providerID]
          // A provider-scoped allowance is one shared pool. Per-model quota
          // snapshots would count the same pool once per model.
          if (!providerSettings || providerSettings.providerScopedQuota) return snapshot
          return this.ledger.attachModelQuotas(snapshot, this.registry.all(), providerSettings)
        })
      : []
  }

  private async ensureContextTokens(sessionID: string) {
    if (this.contextLoaded.has(sessionID)) return
    const existing = this.contextInflight.get(sessionID)
    if (existing) return existing
    const task = (async () => {
      try {
        const real = await this.readCurrentContext(sessionID)
        if (real) {
          this.sessionState(sessionID)
          this.ledger.patchSession(sessionID, {
            contextTokens: real.contextTokens,
            cacheReadTokens: real.cacheReadTokens,
          })
        }
      } catch {
        // A context read failure must not block prompt admission.
      } finally {
        this.remember(this.contextLoaded, sessionID, 2_000)
        this.contextInflight.delete(sessionID)
      }
    })()
    this.contextInflight.set(sessionID, task)
    return task
  }

  /**
   * Read a session's real context size from the host's transcript.
   *
   * The authoritative value is the last assistant step: its cache-read
   * count is the size of the transcript the next request will carry. A
   * compaction message's own counts describe the transcript it replaced, so
   * those are not used.
   *
   * Returns undefined when the transcript cannot be read.
   */
  private async readCurrentContext(
    sessionID: string,
  ): Promise<{ contextTokens: number; cacheReadTokens: number } | undefined> {
    try {
      const messages = unwrap<any>(
        await Promise.race([
          this.ctx.session.context({ sessionID }),
          new Promise((resolve) => setTimeout(() => resolve({ data: [] }), 5_000)),
        ]),
      )
      const assistant = [...messages]
        .reverse()
        .find((message: any) => message?.type === "assistant" && message?.tokens)
      if (!assistant?.tokens) return undefined
      const tokens = tokensFrom(assistant.tokens)
      const contextTokens = tokens.input + tokens.cache.read + tokens.cache.write
      if (contextTokens <= 0) return undefined
      return { contextTokens, cacheReadTokens: tokens.cache.read }
    } catch {
      return undefined
    }
  }

  /**
   * Re-read a session's real context size right after a compaction.
   *
   * A compaction rebuilds the transcript, so the size the router was
   * carrying is stale. Learning the new size now - rather than at the next
   * prompt - means the cheap provider is eligible again on the very next
   * turn instead of being excluded for a size the session no longer has.
   */
  private async refreshContextAfterCompaction(sessionID: string) {
    const real = await this.readCurrentContext(sessionID)
    if (!real) return
    this.sessionState(sessionID)
    this.ledger.patchSession(sessionID, {
      contextTokens: real.contextTokens,
      cacheReadTokens: real.cacheReadTokens,
    })
    this.persistLedgerSoon()
  }

  private classifierFiles(files: unknown): ClassifierFile[] {
    if (!Array.isArray(files)) return []
    return files
      .filter(isRecord)
      .map((file) => ({
        uri: typeof file.uri === "string" ? file.uri : "",
        ...(typeof file.name === "string" ? { name: file.name } : {}),
        ...(typeof file.description === "string" ? { description: file.description } : {}),
      }))
      .filter((file) => file.uri.length > 0)
  }

  private statusFor(sessionID?: string): RouterStatus {
    if (this.settingsWarnings.length > 50) this.settingsWarnings = this.settingsWarnings.slice(-50)
    const session = sessionID ? this.ledger.getSession(sessionID) : undefined
    const current = session?.lastModel
    const runtime = this.runtimeFor(session)
    const currentModel = this.registry.get(current?.providerID ?? "", current?.id ?? "")
    const decisions = sessionID
      ? this.ledger.decisions(20).filter((decision) => decision.sessionID === sessionID)
      : this.ledger.decisions(20)
    const quota = this.quotaSnapshots()
    const warnings = [
      ...this.settingsWarnings,
      ...quota.filter((snapshot) => snapshot.error).map((snapshot) => `${snapshot.label}: ${snapshot.error}`),
    ]
    return {
      enabled: this.settings.enabled,
      mode: this.settings.mode,
      runtime,
      dryRun: this.settings.dryRun,
      sidebarGroups: this.settings.ui.sidebarGroups,
      ...(sessionID ? { sessionID } : {}),
      ...(current ? { current } : {}),
      ...(currentModel ? { currentTier: currentModel.tier } : {}),
      manualOverride: session?.manualOverride ?? false,
      ...(session?.pinnedModel ? { pinnedModel: session.pinnedModel } : {}),
      premium: this.premiumState(session),
      quota,
      context: computeContextHealth(session, this.settings.contextHealth),
      indicator: this.indicatorFor(sessionID ?? "", session),
      ...(decisions[0] ? { lastDecision: decisions[0] } : {}),
      lastDecisions: decisions,
      metrics: this.ledger.snapshotMetrics(),
      approvedModels: this.registry.approved().map((model) => ({
        key: model.key,
        tier: model.tier,
        name: model.name,
        intelligence: model.intelligence,
        design: model.design,
        vision: model.inputModalities.includes("image"),
        premium: model.premium,
      })),
      models: this.registry.all().map((model) => ({
        key: model.key,
        providerID: model.providerID,
        name: model.name,
        tier: model.tier,
        intelligence: model.intelligence,
        design: model.design,
        vision: model.inputModalities.includes("image"),
        premium: model.premium,
        context: model.context,
        costInput: model.cost[0]?.input ?? 0,
        costOutput: model.cost[0]?.output ?? 0,
        approved: model.approved,
        excluded: this.settings.models.excluded.includes(model.key),
        ...(model.notes ? { approvalNote: model.notes } : {}),
      })),
      warnings,
    }
  }

  private async markBlocked(sessionID: string, reason: string) {
    const session = this.ledger.ensureSession(sessionID)
    const ref = session.lastModel
    const model = ref ? this.registry.get(ref.providerID, ref.id) : undefined
    const label = model?.name ?? ref?.id ?? "current model"
    // Blocking a prompt must not rename the owner's chat. The refusal lives in
    // the decision record, the panel and the notice.
    this.settingsWarnings.push(`Blocked a prompt: ${reason}`)
    void this.notifyChange(`${sessionID}:blocked:${reason}`, `BLOCKED · ${label} — ${reason}`)
  }

  private recordFailedDecision(sessionID: string, text: string, files: unknown, reason: string) {
    const session = this.ledger.ensureSession(sessionID)
    const task = classifyTask({
      text,
      files: this.classifierFiles(files),
      contextTokens: session.contextTokens,
      recentFailures: session.failures.length,
    })
    const runtime = this.runtimeFor(session)
    const decision: RoutingDecision = {
      id: nowId("dec"),
      at: Date.now(),
      sessionID,
      mode: this.settings.mode,
      dryRun: this.settings.dryRun,
      runtime,
      task,
      ...(session.lastModel ? { current: session.lastModel } : {}),
      switched: false,
      switchReason: `Routing failed; the current model was kept: ${reason}`,
      reasons: [`Routing failed: ${reason}`],
      warnings: [`Routing failed: ${reason}`],
      candidates: [],
      premium: this.premiumState(session),
      quota: this.quotaSnapshots(),
      contextTokens: session.contextTokens,
      cachedTokens: session.cacheReadTokens,
      estimatedUsd: 0,
      needsPremiumApproval: false,
      manualOverride: session.manualOverride === true,
      error: reason,
    }
    this.ledger.recordDecision(decision)
    this.persistLedgerSoon()
    void this.emit("decision", { decision })
    return decision
  }

  /**
   * A routing exception must never fall through as a silent automatic route.
   * Record the failure, and when failClosed is on, block admission.
   */
  private async handleRoutingFailure(sessionID: string, text: string, files: unknown, error: unknown) {
    const reason = safeError(error)
    this.settingsWarnings.push(`Prompt routing failed: ${reason}`)
    try {
      this.recordFailedDecision(sessionID, text, files, reason)
    } catch (recordError) {
      this.settingsWarnings.push(`Could not record the failed routing decision: ${safeError(recordError)}`)
    }
    if (!this.settings.routing.failClosed) return
    await this.markBlocked(sessionID, reason)
    throw new RouterBlockedError(`Smart Router blocked this prompt: ${reason}`)
  }

  private async routePrompt(sessionID: string, text: string, files: unknown): Promise<RoutingDecision | undefined> {
    const settings = this.settings
    await this.loadSessionInfo(sessionID)
    const session = this.sessionState(sessionID)
    // A new prompt supersedes a previous blocked admission. If this prompt
    // blocks again, markBlocked sets the title again.
    if (session.indicatorTitle?.startsWith("BLOCKED ·")) {
      this.ledger.patchSession(sessionID, { indicatorTitle: undefined })
    }
    const runtime = this.runtimeFor(session)
    void this.ensureContextTokens(sessionID)

    if (runtime !== "automatic") {
      const task = classifyTask({
        text,
        files: this.classifierFiles(files),
        contextTokens: session.contextTokens,
        recentFailures: session.failures.length,
      })
      const result = routeTask({
        task,
        settings,
        mode: settings.mode,
        runtime,
        models: this.routingModels(),
        intelligenceFloor: this.routingFloor(this.routingModels()).floor,
        current: session.lastModel,
        session,
        quota: this.quotaSnapshots(),
        premium: this.premiumState(session),
        contextTokens: session.contextTokens,
        cachedTokens: session.cacheReadTokens,
        dryRun: settings.dryRun,
      })
      this.ledger.recordDecision(result.decision)
      this.persistLedgerSoon()
      void this.emit("decision", { decision: result.decision })
      return result.decision
    }

    const task = classifyTask({
      text,
      files: this.classifierFiles(files),
      contextTokens: session.contextTokens,
      recentFailures: session.failures.length,
    })
    const quota = this.quotaSnapshots()
    const effectiveMode = session.parentID && settings.mode === "premium" ? "balanced" : settings.mode
    const premium = session.parentID
      ? { ...this.premiumState(session), oneShotGranted: false }
      : this.premiumState(session)
    const result = routeTask({
      task,
      settings,
      mode: effectiveMode,
      runtime,
      models: this.routingModels(),
      intelligenceFloor: this.routingFloor(this.routingModels()).floor,
      current: session.lastModel,
      session,
      quota,
      premium,
      contextTokens: session.contextTokens,
      cachedTokens: session.cacheReadTokens,
      dryRun: settings.dryRun,
      modelHistory: this.ledger.snapshotMetrics().byModel,
      cooldowns: this.ledger.cooldowns(),
      providerCooldowns: this.ledger.providerCooldowns(),
      speed: this.speedSnapshot(),
    })
    if (session.lastModel) this.rememberModel(sessionID, session.lastModel.providerID, session.lastModel.id)

    let switchError: string | undefined
    if (result.chosenModel && result.decision.switched) {
      const target = result.chosenModel
      const key = modelKey(target.providerID, target.modelID)
      if (this.expectedSwitch.size > 500) {
        const cutoff = Date.now() - 60_000
        for (const [sid, entry] of this.expectedSwitch) if (entry.at < cutoff) this.expectedSwitch.delete(sid)
        if (this.expectedSwitch.size > 500) {
          const oldest = this.expectedSwitch.keys().next().value
          if (oldest) this.expectedSwitch.delete(oldest)
        }
      }
      // NEVER SWITCH IN THE MIDDLE OF A RUNNING TURN.
      //
      // `switchModel` changes the model for the NEXT step. If a turn is already
      // in flight, the step that is queued behind the switch resolves against a
      // provider whose registration may not be settled yet, and dies with
      // "Model unavailable: <provider>/<model>" -- which reads like a dead
      // provider and is not one. Observed live on 2026-11-03: four of six such
      // failures landed within ten seconds of the plugin being reloaded, three
      // of them within one second.
      //
      // The prompt hook normally fires before a turn starts, so this is a guard
      // for the cases where it does not: a retry, a second queued prompt, or an
      // event arriving while the session is still busy. Deferring is always safe
      // because the next prompt routes again anyway.
      const busy = this.sessionBusy(sessionID)
      if (busy) {
        this.expectedSwitch.delete(sessionID)
        this.settingsWarnings.push(
          `Deferred a switch to ${target.providerID}/${target.modelID}: the session was mid-turn. Routing again on the next prompt.`,
        )
        return
      }

      // NEVER SWITCH TO A MODEL OPENCODE DOES NOT HAVE.
      //
      // The router's candidate list is built from the GATEWAY and the seed catalog.
      // OpenCode's own model list is a third thing, and they can disagree: a model
      // the gateway serves, and the router has approved, may not be present in
      // OpenCode's provider config -- or, as on 2026-11-03, the provider's model
      // list can be empty mid-session because the plugin directory was replaced
      // underneath a running server.
      //
      // Switching to a model OpenCode cannot resolve fails the NEXT step with
      // "Model unavailable: <provider>/<model>", which looks exactly like a dead
      // gateway and is not one. Checking first costs one call and turns a broken
      // session into a skipped switch.
      const resolvable = await this.modelResolvable(target.providerID, target.modelID)
      if (!resolvable) {
        this.expectedSwitch.delete(sessionID)
        this.settingsWarnings.push(
          `Skipped a switch to ${target.providerID}/${target.modelID}: OpenCode does not currently expose that model.`,
        )
        return
      }
      this.expectedSwitch.set(sessionID, { key, at: Date.now() })
      try {
        await this.ctx.session.switchModel({
          sessionID,
          model: { providerID: target.providerID, id: target.modelID },
        })
        this.ledger.patchSession(sessionID, {
          lastModel: { providerID: target.providerID, id: target.modelID },
          lastRoutedModel: { providerID: target.providerID, id: target.modelID },
        })
        this.rememberModel(sessionID, target.providerID, target.modelID)
        if (result.decision.premium.oneShotGranted && target.premium) {
          this.ledger.consumePremiumOneShot(sessionID)
        }
      } catch (error) {
        switchError = safeError(error)
        this.expectedSwitch.delete(sessionID)
        this.settingsWarnings.push(`Model switch failed: ${switchError}`)
      }
    }

    const finalDecision: RoutingDecision = switchError
      ? {
          ...result.decision,
          error: switchError,
          switched: false,
          switchReason: `Switch failed; kept the current model. ${switchError}`,
          warnings: [...result.decision.warnings, `Switch failed: ${switchError}`],
        }
      : result.decision

    // Fail closed when the request would otherwise run on an unqualified model.
    if (runtime === "automatic" && settings.routing.failClosed && (!finalDecision.chosen || switchError)) {
      const currentRecord = session.lastModel
        ? this.registry.get(session.lastModel.providerID, session.lastModel.id)
        : undefined
      const premiumDecision = decidePremium({
        settings,
        mode: effectiveMode,
        task,
        session,
        premium,
      })
      const currentEligibility = currentRecord
        ? evaluateEligibility({
            model: currentRecord,
            task,
            settings,
            mode: effectiveMode,
            contextTokens: session.contextTokens,
            providerQuota: quota.find((entry) => entry.providerID === currentRecord.providerID),
            modelQuota: quota
              .find((entry) => entry.providerID === currentRecord.providerID)
              ?.models[`${currentRecord.providerID}/${currentRecord.modelID}`],
            premium: premiumDecision,
            currentModelKey: currentRecord.key,
          })
        : { eligible: false, reason: "No current model is recorded for this session", warnings: [] }
      if (!currentEligibility.eligible) {
        const reason = currentEligibility.reason
        await this.markBlocked(sessionID, reason)
        const blockedDecision: RoutingDecision = {
          ...finalDecision,
          error: reason,
          switched: false,
          switchReason: `Prompt blocked: ${reason}`,
          warnings: [...finalDecision.warnings, `Prompt blocked: ${reason}`],
        }
        this.ledger.recordDecision(blockedDecision)
        this.persistLedgerSoon()
        void this.emit("decision", { decision: blockedDecision })
        throw new RouterBlockedError(`Smart Router blocked this prompt: ${reason}`)
      }
    }

    this.ledger.recordDecision(finalDecision)
    this.persistLedgerSoon()
    void this.emit("decision", { decision: finalDecision })
    if (finalDecision.needsPremiumApproval) {
      void this.emit("status", { summary: { needsPremiumApproval: true, sessionID } })
      void this.notifyChange(
        `${sessionID}:premium-needed`,
        "Premium approval required. Run /router-approve for this session.",
      )
    }
    void this.queueTitle(sessionID)
    const indicator = this.indicatorFor(sessionID, this.ledger.getSession(sessionID))
    if (finalDecision.switched && finalDecision.chosen) {
      const tier = finalDecision.task.tier === 1 ? "economy" : finalDecision.task.tier === 3 ? "premium" : "standard"
      this.modelNotice(sessionID, indicator.state, finalDecision.chosen, `${tier} task · quota-aware route`)
    }
    return finalDecision
  }

  private async registerHooks() {
    this.registrations.push(
      await this.ctx.session.hook("prompt", async (event: any) => {
        const sessionID = event.sessionID
        if (!sessionID) return
        try {
          const probe: any = await this.ctx.session.get({ sessionID })
          if (!this.projectMatches(probe?.projectID, probe?.location?.directory)) return
        } catch {
          // If the location probe fails, the location-scoped hook can still run.
        }
        sharedCore.claimSession(sessionID, this.bridgeID)
        this.remember(this.promptSeen, sessionID)
        this.pendingHeals.delete(sessionID)
        if (this.inflight.has(sessionID)) return
        this.inflight.add(sessionID)
        try {
          const decision = await this.routePrompt(sessionID, event.prompt?.text ?? "", event.prompt?.files)
          if (decision) {
            // Available to the retry hook, which has no prompt linkage of its
            // own: a deterministic rejection re-routes this same task.
            this.promptRoutes.set(sessionID, {
              messageID: typeof event.messageID === "string" ? event.messageID : undefined,
              task: decision.task,
              decision,
              at: Date.now(),
            })
          }
        } catch (error) {
          if (error instanceof RouterBlockedError || (error as any)?.name === "RouterBlockedError") throw error
          await this.handleRoutingFailure(sessionID, event.prompt?.text ?? "", event.prompt?.files, error)
        } finally {
          this.inflight.delete(sessionID)
        }
      }),
    )

    this.registrations.push(
      await this.ctx.session.hook("model.request", (event: any) => {
        if (sharedCore.ownerOf(event.sessionID) !== this.bridgeID) return
        // Latch the request kind so the context hook (whose event carries no
        // kind) can tell the agent loop apart from title and compaction runs.
        // One-shot consumption keeps a stale latch from leaking to a later
        // request of another kind.
        if (typeof event.kind === "string" && event.kind) {
          if (this.requestKinds.size > 500) {
            const cutoff = Date.now() - 60_000
            for (const [sid, entry] of this.requestKinds) if (entry.at < cutoff) this.requestKinds.delete(sid)
            if (this.requestKinds.size > 500) {
              const oldest = this.requestKinds.keys().next().value
              if (oldest) this.requestKinds.delete(oldest)
            }
          }
          this.requestKinds.set(event.sessionID, { kind: event.kind, at: Date.now() })
        }
        if (event.model?.providerID === "opencode-go") {
          event.headers["x-opencode-session"] = event.headers["x-opencode-session"] ?? event.sessionID
        }
        if (this.settings.privacy.requireZdr && event.model?.providerID === "commandcode") {
          event.headers["x-cmd-zdr"] = "1"
        }
      }),
    )

    // The host emits `model.request` for every model call with the request's
    // kind and `context` with the built messages, in that order (the bundled
    // Claude integration relies on the same pairing), so a missing latch reads
    // as the agent loop: the common case, and the one that needs the repair.
    this.registrations.push(
      await this.ctx.session.hook("context", async (event: any) => {
        try {
          if (!(await this.ensureOwnership(event.sessionID))) return
          const latched = this.requestKinds.get(event.sessionID)
          this.requestKinds.delete(event.sessionID)
          if (latched && latched.kind !== "primary") return
          const session = this.ledger.getSession(event.sessionID)
          const model = event.model ?? session?.lastModel
          const record = model ? this.registry.get(model.providerID, model.id) : undefined
          const protocol = providerProtocol({
            ...(record ?? {}),
            providerID: model?.providerID ?? "",
            modelID: model?.id ?? "",
          })
          if (protocol !== "anthropic") return
          const result = repairMessages(event.messages, { protocol })
          if (result.folded > 0) event.messages = result.messages
        } catch (error) {
          // A repair failure must never escape into the model request.
          this.settingsWarnings.push(`Prompt repair failed: ${safeError(error)}`)
        }
      }),
    )

    this.registrations.push(
      await this.ctx.session.hook("retry", async (event: any) => {
        if (sharedCore.ownerOf(event.sessionID) !== this.bridgeID) return
        const session = this.ledger.getSession(event.sessionID)
        const assessment = classifyFailure(
          { type: event.error?.type, message: event.error?.message ?? "", status: event.error?.status },
          session,
        )
        // The retry hook and the step/execution/idle events can all report
        // the same fault. Record it once, and carry the cooldown through so
        // the model is actually held back when it keeps failing.
        // The host identifies a scheduled retry by its assistant message id,
        // which is the same identity the step/execution events carry.
        const attemptKey =
          typeof event.assistantMessageID === "string"
            ? event.assistantMessageID
            : typeof event.attemptID === "string"
              ? event.attemptID
              : undefined
        if (!this.alreadyRecorded(event.sessionID, assessment.class, event.error?.message ?? "", attemptKey)) {
          this.ledger.recordFailure(event.sessionID, event.model, assessment.class, event.error?.message ?? "", {
            countAgainstModel: assessment.countAgainstModel,
            cooldownMs: assessment.cooldownMs,
            providerScoped: assessment.providerScoped,
            saturation: assessment.saturation === true,
          })
        }
        this.ledger.recordRetry(event.sessionID)
        this.persistLedgerSoon()
        if (assessment.class === "auth" || assessment.class === "context_overflow" || assessment.class === "image_rejected") {
          event.decision = { retry: false }
          return
        }

        /**
         * The provider has no allowance left.
         *
         * This is the compensating control for everything the router cannot
         * read in advance. For OpenDesign it cannot read usage at all, so its
         * figure is a lower bound and a spent allowance is only discovered when
         * the gateway refuses. One refusal is enough: stop retrying this turn,
         * and hold the provider back until its window resets so the next prompt
         * routes somewhere that can actually serve it.
         *
         * Holding back for the reset, not for a few seconds, is the point. A
         * short backoff would re-probe an empty account on every prompt and burn
         * a turn each time to learn something already known.
         */
        if (assessment.class === "quota_exhausted") {
          const providerID = event.model?.providerID
          if (providerID) {
            this.ledger.exhaustProvider(providerID, this.providerResetAt(providerID))
          }
          this.settingsWarnings.push(
            `${providerID ?? "The provider"} reported no allowance left. Routing will avoid it until its window resets.`,
          )
          event.decision = { retry: false }
          this.persistLedgerSoon()
          return
        }
        if (assessment.class === "capability") {
          event.decision = { retry: false }
          return
        }
        if (assessment.class === "prompt_rejected") {
          // A deterministic rejection: the provider refused the request shape
          // before generating anything. Retrying reproduces the same 400, so
          // the turn stops immediately and the router repairs (next request)
          // or fails over to the next best choice.
          event.decision = { retry: false }
          try {
            await this.attemptSelfHeal(event.sessionID, event)
          } catch (error) {
            this.settingsWarnings.push(`Prompt-rejection failover failed: ${safeError(error)}`)
          }
          this.persistLedgerSoon()
          return
        }
        if (assessment.class === "rate_limit") {
          event.decision = { retry: true, delay: Math.max(5_000, event.error?.retryAfterMs ?? 15_000) }
          return
        }
        if (assessment.providerScoped) {
          // The provider's own pre-request path failed before a model ran, or
          // its gateway is refusing work outright, so the attempt cost nothing.
          // These failures come in runs: the gateway is slow or saturated for a
          // stretch and every immediate retry lands inside the same stretch and
          // dies with it, which is what turns a recoverable blip into a turn
          // that stops and waits for the owner to say continue. Back off long
          // enough for the stretch to pass.
          //
          // Backing off is the only thing available here: the retry hook can
          // retry with a delay or give up, but it cannot change model, so there
          // is no cheaper escape from a saturated gateway within the turn.
          if (event.attempt >= PROVIDER_SCOPED_RETRY_ATTEMPTS) {
            event.decision = { retry: false }
          } else {
            event.decision = { retry: true, delay: Math.min(40_000, 5_000 * 2 ** (event.attempt - 1)) }
          }
        } else if (assessment.class === "provider_outage" || assessment.class === "network") {
          if (event.attempt >= 3) event.decision = { retry: false }
        }
      }),
    )
  }



  private async ensureOwnership(sessionID: string): Promise<boolean> {
    const owner = sharedCore.ownerOf(sessionID)
    if (owner) return owner === this.bridgeID
    try {
      const info: any = await this.ctx.session.get({ sessionID })
      if (!this.projectMatches(info?.projectID, info?.location?.directory)) return false
      sharedCore.claimSession(sessionID, this.bridgeID)
      return true
    } catch {
      return false
    }
  }

  /**
   * Record a provider fault against the model that was actually serving the
   * session.
   *
   * The router's own session state is the primary source, but it can lag
   * behind a manual model change. The host's session record is the
   * authority, so it is consulted when the router has no model on record.
   */
  private async recordProviderFault(sessionID: string, outcome: string, error: any, attemptKey?: string) {
    const session = this.ledger.getSession(sessionID)
    let model = session?.lastModel
    if (!model) {
      try {
        const info: any = await this.ctx.session.get({ sessionID })
        const ref = modelRefFrom(info?.model)
        if (ref) {
          model = ref
          this.ledger.patchSession(sessionID, { lastModel: ref })
          this.rememberModel(sessionID, ref.providerID, ref.id)
        }
      } catch {
        // The session may already be gone; the fault is still recorded.
      }
    }
    const message =
      typeof error?.message === "string" && error.message.trim().length > 0
        ? error.message
        : outcome === "interrupted"
          ? "Step interrupted"
          : "The provider ended the response without completing it"
    const assessment = classifyFailure(
      {
        type: typeof error?.type === "string" ? error.type : outcome,
        message,
        ...(typeof error?.status === "number" ? { status: error.status } : {}),
      },
      session,
    )
    // The same fault can arrive through the retry hook and through the
    // step, execution and idle events. Record it once.
    if (this.alreadyRecorded(sessionID, assessment.class, message, attemptKey)) return
    this.ledger.recordFailure(sessionID, model, assessment.class, message, {
      countAgainstModel: assessment.countAgainstModel,
      cooldownMs: assessment.cooldownMs,
      providerScoped: assessment.providerScoped,
      saturation: assessment.saturation === true,
    })
  }

  /** Hold-back window applied to a model that deterministically rejected a prompt. */
  private static readonly PROMPT_REJECTED_HOLD_MS = 5 * 60_000

  /**
   * Recover a turn whose provider rejected the request shape.
   *
   * The model is healthy and the request cost nothing, so the router re-routes
   * the prompt's stored task with the rejecting model held back, moves the
   * session onto the next best choice, and continues the turn with one
   * router-marked synthetic notice. Everything that can be missing is missing
   * in a defined way: no banked routing, no other eligible model, or a host
   * without the needed API all degrade to leaving the failed turn as it is,
   * with the rejecting model held back so the next prompt routes elsewhere.
   * One failover per prompt, ever.
   *
   * A session that is still running its failed step must not be switched
   * mid-flight (a queued step would resolve against an unsettled model
   * registration), so the heal parks and is flushed from the turn's terminal
   * event, when the host considers the session idle.
   */
  private async attemptSelfHeal(sessionID: string, event: any): Promise<void> {
    const route = this.promptRoutes.get(sessionID)
    const rejected = modelRefFrom(event.model) ?? this.ledger.getSession(sessionID)?.lastModel
    if (!rejected) return
    const rejectedKey = modelKey(rejected.providerID, rejected.id)
    const hold = (model: ModelRef) => this.ledger.holdModel(model, RouterController.PROMPT_REJECTED_HOLD_MS)

    // One failover per prompt: the cap is set before any host call, so a
    // failure partway through cannot let a later rejection heal again.
    if (!route || route.healedAt) {
      hold(rejected)
      this.noteSelfHeal(sessionID, route, rejected, "noted")
      return
    }
    // Automatic routing only: a manual model is the owner's pick, and a paused
    // session answers for itself on the next prompt.
    if (this.runtimeFor(this.sessionState(sessionID)) !== "automatic") {
      hold(rejected)
      this.noteSelfHeal(sessionID, route, rejected, "noted")
      return
    }

    const session = this.sessionState(sessionID)
    const result = routeTask({
      task: route.task,
      settings: this.settings,
      mode: session.parentID && this.settings.mode === "premium" ? "balanced" : this.settings.mode,
      runtime: "automatic",
      models: this.routingModels(),
      intelligenceFloor: this.routingFloor(this.routingModels()).floor,
      current: rejected,
      session,
      quota: this.quotaSnapshots(),
      // A child session has no one-shot of its own: the owner approves spend,
      // not the subagent.
      premium: session.parentID ? { ...this.premiumState(session), oneShotGranted: false } : this.premiumState(session),
      contextTokens: session.contextTokens,
      cachedTokens: session.cacheReadTokens,
      dryRun: this.settings.dryRun,
      modelHistory: this.ledger.snapshotMetrics().byModel,
      cooldowns: { ...this.ledger.cooldowns(), [rejectedKey]: Date.now() + RouterController.PROMPT_REJECTED_HOLD_MS },
      providerCooldowns: this.ledger.providerCooldowns(),
      speed: this.speedSnapshot(),
    })
    const chosen = result.chosenModel
    // `decision.switched` is false under dry run: the plan explains what would
    // happen instead of doing it, and so does the heal.
    if (!chosen || !result.decision.switched || modelKey(chosen.providerID, chosen.modelID) === rejectedKey) {
      route.healedAt = Date.now()
      hold(rejected)
      this.noteSelfHeal(sessionID, route, rejected, "noted")
      return
    }
    if (
      typeof this.ctx.session.switchModel !== "function" ||
      typeof this.ctx.session.synthetic !== "function" ||
      !(await this.modelResolvable(chosen.providerID, chosen.modelID))
    ) {
      route.healedAt = Date.now()
      hold(rejected)
      this.noteSelfHeal(sessionID, route, rejected, "noted")
      return
    }

    route.healedAt = Date.now()
    hold(rejected)
    this.pendingHeals.set(sessionID, {
      chosen,
      base: result.decision,
      rejectedLabel: `${rejected.providerID}/${rejected.id}`,
    })
    if (!this.sessionBusy(sessionID)) await this.flushPendingHeal(sessionID)
  }

  /**
   * Apply a parked failover: the failed turn is over, so switching is safe.
   * Switches the session, mirrors the routing state (expected switch, last
   * model, one-shot consumption) exactly as the prompt path does, and
   * continues the turn with one router-marked notice.
   */
  private async flushPendingHeal(sessionID: string): Promise<void> {
    const heal = this.pendingHeals.get(sessionID)
    if (!heal) return
    this.pendingHeals.delete(sessionID)
    if (sharedCore.ownerOf(sessionID) !== this.bridgeID) return
    const chosen = heal.chosen
    this.expectedSwitch.set(sessionID, { key: modelKey(chosen.providerID, chosen.modelID), at: Date.now() })
    try {
      await this.ctx.session.switchModel({ sessionID, model: { providerID: chosen.providerID, id: chosen.modelID } })
      this.ledger.patchSession(sessionID, {
        lastModel: { providerID: chosen.providerID, id: chosen.modelID },
        lastRoutedModel: { providerID: chosen.providerID, id: chosen.modelID },
      })
      this.rememberModel(sessionID, chosen.providerID, chosen.modelID)
      if (heal.base.premium.oneShotGranted && chosen.premium) {
        this.ledger.consumePremiumOneShot(sessionID)
      }
      await this.ctx.session.synthetic({
        sessionID,
        text: `[router] The request was rejected on ${heal.rejectedLabel}, so the router moved it to ${chosen.providerID}/${chosen.modelID}.`,
        description: "Smart Router",
        // A fresh run, not a display notice: the failed turn was admitted under
        // the rejecting model and this is its continuation.
        resume: true,
      })
      const annotated: RoutingDecision = {
        ...heal.base,
        id: `${heal.base.id}+heal`,
        switched: true,
        switchReason: "selfheal",
        selfheal: {
          rejected: heal.rejectedLabel,
          action: `continued on ${chosen.providerID}/${chosen.modelID}`,
        },
      }
      this.ledger.recordDecision(annotated)
      void this.emit("decision", { decision: annotated })
      this.persistLedgerSoon()
    } catch (error) {
      this.expectedSwitch.delete(sessionID)
      this.settingsWarnings.push(`Self-heal switch failed: ${safeError(error)}`)
      this.persistLedgerSoon()
    }
  }

  /**
   * Record the failover's outcome without re-counting the routed prompt's own
   * metrics: fresh id, applied-switch fields neutralized. The panel line comes
   * from the annotation.
   */
  private noteSelfHeal(
    sessionID: string,
    route: { decision: RoutingDecision } | undefined,
    rejected: ModelRef,
    action: string,
  ): void {
    if (!route) return
    this.ledger.recordDecision({
      ...route.decision,
      id: `${route.decision.id}+heal-note`,
      switched: false,
      dryRun: false,
      needsPremiumApproval: false,
      chosen: route.decision.current,
      selfheal: { rejected: `${rejected.providerID}/${rejected.id}`, action },
    })
    this.persistLedgerSoon()
  }

  /** Record that a session has been on a model, so a later change back to
   * it is read as the client catching up rather than a fresh pick. */
  private rememberModel(sessionID: string, providerID: string, id: string) {
    let seen = this.modelsSeen.get(sessionID)
    if (!seen) {
      seen = new Set()
      this.modelsSeen.set(sessionID, seen)
    }
    seen.add(modelKey(providerID, id))
  }

  /**
   * The context window of the cheapest variant of a model, across providers.
   *
   * The same model id is often served by more than one provider at different
   * prices. The variant the router wants to keep a session on is the cheapest
   * one, so that variant's window is the size the session needs to fit.
   * Ties prefer the larger window.
   */
  /**
   * Whether OpenCode exposes a model RIGHT NOW.
   *
   * The router knows a model because the gateway serves it and the owner approved it.
   * OpenCode knows it only if it is in the provider's configured model list. When the
   * two disagree, switching produces a session that fails on its NEXT step with
   * "Model unavailable: provider/model", which reads like a dead provider and is not
   * one. Observed 2026-11-03: the plugin directory was replaced underneath a running
   * server, the provider's model list came back empty, and four live sessions died
   * that way.
   *
   * So ask the host instead of assuming. If the host cannot answer at all, allow the
   * switch: the previous behaviour was to try it and surface the real error, and a
   * false negative here would silently stop all routing.
   */
  /**
   * Whether a turn is currently running for this session.
   *
   * Two independent signals, because neither is complete on its own:
   *
   * - `stepStarted` is set in-process and cleared on the step's terminal event.
   *   It is the precise one, but a plugin reload empties it, so a session that
   *   was already mid-turn looks idle.
   * - `status` is persisted in the ledger and survives a reload, so it covers
   *   exactly that gap. It is also written by auto-compaction.
   *
   * Either one saying "busy" is enough. A false positive only defers a switch
   * to the next prompt, which costs nothing; a false negative breaks the turn.
   */
  private sessionBusy(sessionID: string): boolean {
    if (this.stepStarted.has(sessionID)) return true
    return this.ledger.getSession(sessionID)?.status === "busy"
  }

  private async modelResolvable(providerID: string, modelID: string): Promise<boolean> {
    // The host is the authority, but it is not always reachable. A MISSING API is not
    // a "no": it means this host cannot answer the question, so fall back to the
    // previous behaviour of attempting the switch and surfacing whatever happens.
    // Only an API that answers and returns nothing is treated as a real refusal.
    const get = this.ctx?.model?.get
    if (typeof get !== "function") return true
    try {
      const model = await get.call(this.ctx.model, providerID, modelID)
      return Boolean(model)
    } catch {
      return true
    }
  }

  /**
   * The candidate list a routing decision may choose from.
   *
   * Offline mode replaces the approved-online list with the local models. The
   * engine applies its own allow-list on top, so this is a convenience rather
   * than the security boundary; the boundary is in `routeTask` and stays there
   * even if a future caller passes the wrong list.
   */
  private routingModels() {
    if (this.settings.offline?.enabled) return this.registry.modelsForOffline()
    return this.registry.approved()
  }

  /**
   * The intelligence floor to route with.
   *
   * With calibration enabled this replaces the hand-picked number with one
   * derived from what the owner actually spent over the recorded window. It is
   * memoized briefly because it is otherwise recomputed for every decision,
   * while the underlying ledger changes per request, not per candidate.
   *
   * Offline mode bypasses it: that path has its own allow-list and its own
   * relationship with the floor, and online cost calibration must not reach
   * into it.
   */
  /**
   * Everything needed to judge whether the floor in force is trustworthy.
   *
   * Reads the ledger directly rather than the memoized routing value, so the
   * report answers for the current moment even when nothing has routed yet.
   */
  private floorReport() {
    const models = this.registry.approved()
    const configured = this.settings.routing.intelligenceFloor
    const enabled = this.settings.routing.calibrateFloor === true
    const offline = this.settings.offline?.enabled === true
    const now = Date.now()
    const usage = this.ledger.usageByModel({ since: now - CALIBRATION_WINDOW_MS })
    const calibration = resolveIntelligenceFloor(this.settings, { models, usage, now })
    const inForce = enabled && !offline ? calibration.floor : configured

    const perModel = usage
      .filter((row) => row.requests > 0)
      .map((row) => {
        const record = this.registry.get(row.providerID, row.modelID)
        return {
          model: `${row.providerID}/${row.modelID}`,
          requests: row.requests,
          usd: Number(row.usd.toFixed(6)),
          usdPerRequest: Number((row.usd / row.requests).toFixed(6)),
          intelligence: record?.intelligence ?? null,
        }
      })
      .sort((a, b) => a.usdPerRequest - b.usdPerRequest)

    return {
      calibrateFloor: enabled,
      offlineBypass: offline,
      configuredFloor: configured,
      floorInForce: inForce,
      calibrated: calibration.calibrated,
      source: calibration.calibrated ? "measured" : enabled ? "configured (not calibrated)" : "configured",
      reason: calibration.reason,
      baselineUsdPerRequest: calibration.baselineUsdPerRequest,
      admittedUsdPerRequest: calibration.admittedUsdPerRequest,
      windowDays: Math.round(CALIBRATION_WINDOW_MS / 86_400_000),
      minRequests: MIN_REQUESTS_FOR_COST_EVIDENCE,
      // What the floor actually admits, so the number has a meaning attached.
      admitted: models
        .filter((model) => !model.escalationOnly && !model.premium)
        .filter((model) => model.intelligence >= inForce)
        .map((model) => ({
          model: `${model.providerID}/${model.modelID}`,
          intelligence: model.intelligence,
          listInputUsdPerMtok: model.cost?.[0]?.input ?? null,
        }))
        .sort((a, b) => (a.listInputUsdPerMtok ?? 0) - (b.listInputUsdPerMtok ?? 0)),
      measuredTraffic: perModel,
      totalRequests: perModel.reduce((sum, row) => sum + row.requests, 0),
    }
  }

  private routingFloor(models: ReadonlyArray<ModelRecord>): { floor: number; calibration?: CalibrationResult } {
    if (this.settings.routing.calibrateFloor !== true || this.settings.offline?.enabled === true) {
      return { floor: this.settings.routing.intelligenceFloor }
    }
    const now = Date.now()
    if (this.floorCache && now - this.floorCache.at < FLOOR_CACHE_MS) return this.floorCache.value
    const calibration = resolveIntelligenceFloor(this.settings, {
      models,
      usage: this.ledger.usageByModel({ since: now - CALIBRATION_WINDOW_MS }),
      now,
    })
    const value = { floor: calibration.floor, calibration }
    this.floorCache = { at: now, value }
    return value
  }

  private cheapestVariantContext(modelID: string): number {
    let best: { multiplier: number; context: number } | undefined
    for (const model of this.registry.approved()) {
      if (model.modelID !== modelID) continue
      const multiplier = model.creditMultiplier && model.creditMultiplier > 0 ? model.creditMultiplier : 1
      if (
        !best ||
        multiplier < best.multiplier ||
        (multiplier === best.multiplier && model.context > best.context)
      ) {
        best = { multiplier, context: model.context }
      }
    }
    return best?.context ?? 0
  }

  /**
   * Router-driven conversation compaction.
   *
   * Compaction is destructive: it replaces the transcript with a summary and
   * the detail is gone. It was introduced when OpenDesign Go's $10 allowance
   * made a long session on the cheapest provider unaffordable, and it is now
   * governed by `contextManagement.mode`:
   *
   *  - `native` (default) never compacts except to avoid a verified overflow.
   *  - `conservative` compacts only to prevent a real overflow.
   *  - `budget-optimized` preserves the old early-compaction behavior for
   *    small plans and small-window models.
   *
   * In every mode the effective window is the one the provider actually
   * accepts, never a theoretical maximum.
   */
  private maybeCompactForCost(sessionID: string) {
    const settings = this.settings
    if (!settings.enabled || this.runtime.paused === true) return
    if (this.ledger.getSession(sessionID)?.paused === true) return
    if (!settings.contextManagement.enabled) return
    const session = this.ledger.getSession(sessionID)
    const model = session?.lastModel
    if (!model) return
    if (session?.status !== "idle") return
    const record = this.registry.get(model.providerID, model.id)
    if (!record || record.context <= 0) return
    const contextTokens = session?.contextTokens ?? 0
    if (contextTokens <= 0) return
    const now = Date.now()
    const cooldownMs = settings.contextManagement.cooldownMinutes * 60_000
    const last = this.routerCompactAt.get(sessionID)
    if (typeof last === "number" && now - last < cooldownMs) return

    // The window that matters is the one the *current* model accepts. The
    // cheapest variant's window is only relevant to the budget-optimized
    // strategy, which trades context for staying on the cheapest route.
    const effectiveWindow = record.context
    const cheapestWindow =
      settings.contextManagement.mode === "budget-optimized"
        ? this.cheapestVariantContext(record.modelID) || record.context
        : effectiveWindow

    const decision = decideCompaction({
      mode: settings.contextManagement.mode,
      settings: settings.contextManagement,
      contextTokens,
      effectiveWindow,
      cheapestWindow,
    })
    this.lastCompactionDecision.set(sessionID, decision)
    if (!decision.compact) return

    if (typeof this.ctx.session.compact !== "function") return
    this.routerCompactAt.set(sessionID, now)
    this.ledger.patchSession(sessionID, { status: "busy" })
    this.persistLedgerSoon()
    void Promise.resolve(
      this.ctx.session.compact({ sessionID }),
    )
      .then(() => {
        this.ledger.patchSession(sessionID, { status: "idle" })
        void this.emit("status", {
          sessionID,
          summary: {
            note: `${decision.hardLimit ? "Protected context limit" : "Compacted"}: ${decision.reason} (${(contextTokens / 1000).toFixed(0)}k to fit ${((decision.targetTokens ?? effectiveWindow) / 1000).toFixed(0)}k)`,
            contextManagement: settings.contextManagement.mode,
          },
        })
      })
      .catch((error: unknown) => {
        this.ledger.patchSession(sessionID, { status: "idle" })
        this.settingsWarnings.push(`Auto-compact failed: ${safeError(error)}`)
      })
  }

  /**
   * True when this exact failure was already recorded for the session.
   *
   * `attemptKey` identifies the failed attempt. When the host provides one
   * (the assistant message id), it is authoritative: the same attempt is
   * reported once, however many channels describe it. When it does not,
   * the error text plus a short window stands in, which still collapses the
   * channels of one attempt without merging a later, separate fault.
   */
  private alreadyRecorded(sessionID: string, failureClass: string, message: string, attemptKey?: string): boolean {
    const now = Date.now()
    const key = attemptKey
      ? `${sessionID} ${failureClass} attempt:${attemptKey}`
      : `${sessionID} ${failureClass} text:${message.slice(0, 200)}`
    const previous = this.recordedFaults.get(key)
    if (attemptKey) {
      // An attempt identity is exact, so it never expires into a new fault.
      if (previous !== undefined) return true
    } else if (typeof previous === "number" && now - previous < FAULT_DEDUPE_WINDOW_MS) {
      return true
    }
    this.recordedFaults.set(key, now)
    // Keep the map bounded; entries older than the window are dead weight.
    if (this.recordedFaults.size > 500) {
      for (const [candidate, at] of this.recordedFaults) {
        if (now - at >= FAULT_DEDUPE_WINDOW_MS) this.recordedFaults.delete(candidate)
      }
    }
    return false
  }

  async handleEvent(event: any) {
    const type = event?.type
    // Env-gated event trace. Used to learn which bus events carry a provider
    // fault; inert unless SMART_ROUTER_EVENT_LOG is set.
    const eventLog = process.env.SMART_ROUTER_EVENT_LOG
    if (eventLog) {
      try {
        appendFileSync(eventLog, `${JSON.stringify({ at: Date.now(), type, sessionID: event?.data?.sessionID, keys: Object.keys(event?.data ?? {}) })}\n`)
      } catch {
        // Diagnostics only.
      }
    }
    const data = event?.data ?? {}
    const eventSessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (eventSessionID && type !== "session.created") {
      if (!(await this.ensureOwnership(eventSessionID))) {
        sharedCore.noteEvent(false)
        return
      }
    }
    sharedCore.noteEvent(true)
    if (type === "session.created") {
      const sessionID = data.sessionID
      if (typeof sessionID !== "string") return
      if (
        !this.projectMatches(
          typeof data.projectID === "string" ? data.projectID : undefined,
          typeof data.location?.directory === "string" ? data.location.directory : undefined,
        )
      ) {
        sharedCore.noteEvent(false)
        return
      }
      if (!this.created.has(sessionID) && this.created.size >= 500) {
        const oldest = this.created.keys().next().value
        if (oldest) this.created.delete(oldest)
      }
      this.created.set(sessionID, Date.now())
      const session = this.ledger.ensureSession(sessionID, data.parentID, data.title)
      if (typeof data.projectID === "string") this.ledger.patchSession(sessionID, { projectID: data.projectID })
      if (typeof data.location?.directory === "string") {
        this.ledger.patchSession(sessionID, { directory: data.location.directory })
      }
      const base = stripTitlePrefix(typeof data.title === "string" ? data.title : undefined)
      if (base && !session.baseTitle) this.ledger.patchSession(sessionID, { baseTitle: base })
      this.persistLedgerSoon()
      return
    }
    if (type === "session.renamed") {
      const sessionID = data.sessionID
      if (typeof sessionID !== "string" || typeof data.title !== "string") return
      const session = this.ledger.getSession(sessionID)
      if (!session) return
      if (data.title === session.indicatorTitle) return
      const base = stripTitlePrefix(data.title)
      if (base) this.ledger.patchSession(sessionID, { baseTitle: base })
      void this.queueTitle(sessionID)
      return
    }
    if (type === "session.deleted") {
      if (eventSessionID) {
        sharedCore.releaseSession(eventSessionID)
        this.stepStarted.delete(eventSessionID)
        this.contextLoaded.delete(eventSessionID)
        this.expectedSwitch.delete(eventSessionID)
        this.promptSeen.delete(eventSessionID)
        this.created.delete(eventSessionID)
      }
      return
    }
    if (type === "session.model.selected") {
      const sessionID = data.sessionID
      if (typeof sessionID !== "string") return
      const model = modelRefFrom(data.model)
      if (!model) return
      const expected = this.expectedSwitch.get(sessionID)
      const key = modelKey(model.providerID, model.id)
      const isOurs = expected?.key === key && Date.now() - expected.at < 15_000
      if (isOurs) {
        this.expectedSwitch.delete(sessionID)
        return
      }
      const created = this.created.get(sessionID) ?? 0
      const initialSelection = !this.promptSeen.has(sessionID) && Date.now() - created < 5_000 && !data.previous
      if (initialSelection) return
      // A change back to a model this session has already been on is the
      // client catching up with its own saved selection, not the owner
      // picking a model. Only a model new to the session suspends routing.
      const changedModelKey = modelKey(model.providerID, model.id)
      const seen = this.modelsSeen.get(sessionID)
      const isCatchUp = seen?.has(changedModelKey) === true
      this.rememberModel(sessionID, model.providerID, model.id)
      if (isCatchUp) {
        this.ledger.patchSession(sessionID, { lastModel: model })
        this.persistLedgerSoon()
        return
      }
      this.ledger.setManual(sessionID, model)
      this.persistLedgerSoon()
      void this.emit("status", { sessionID, summary: { manualOverride: true, model } })
      void this.queueTitle(sessionID)
      this.modelNotice(sessionID, "MANUAL", model, "automatic routing suspended · /router-auto to resume")
      return
    }
    if (type === "session.execution.started") {
      const sessionID = data.sessionID
      if (typeof sessionID === "string") {
        if (!this.stepStarted.has(sessionID) && this.stepStarted.size >= 500) {
          const oldest = this.stepStarted.keys().next().value
          if (oldest) this.stepStarted.delete(oldest)
        }
        this.stepStarted.set(sessionID, Date.now())
        this.ledger.patchSession(sessionID, { status: "busy" })
        this.persistLedgerSoon()
      }
      return
    }
    if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted" || type === "session.idle") {
      const sessionID = data.sessionID
      if (typeof sessionID === "string") {
        this.ledger.patchSession(sessionID, { status: "idle" })
        this.stepStarted.delete(sessionID)
        // A failover parked because the turn was busy switches here: the turn
        // is over, so the queued-step hazard is gone.
        if (type !== "session.execution.succeeded") {
          try {
            if (!this.sessionBusy(sessionID)) await this.flushPendingHeal(sessionID)
          } catch (healError) {
            this.settingsWarnings.push(`Prompt-rejection failover failed: ${safeError(healError)}`)
          }
        }
        // `session.execution.failed` and `.interrupted` carry no outcome
        // field; the event type itself is the signal. `session.idle` does
        // carry an outcome. Recording these is what lets the router see a
        // model that keeps dropping streams.
        const outcome = typeof data.outcome === "string" ? data.outcome : undefined
        const attemptKey = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
        if (type === "session.execution.failed" || outcome === "failed") {
          await this.recordProviderFault(sessionID, "failed", data.error, attemptKey)
        } else if (type === "session.execution.interrupted" || outcome === "interrupted") {
          await this.recordProviderFault(sessionID, "interrupted", data.error, attemptKey)
        }
        // Idle is the only safe moment to compact: a running turn cannot be
        // interrupted. Compacting here keeps the session inside the cheapest
        // provider's window, so the next prompt does not get pushed onto a
        // costlier provider purely because the conversation grew.
        //
        // Note the host's `session.idle` bus event carries no outcome field
        // (only the persisted message does), so success cannot be read here.
        // `session.execution.succeeded` is the signal that a turn finished
        // cleanly; the idle event covers the rest. The compaction cooldown is
        // what stops the two from both firing.
        if (type === "session.execution.succeeded" || type === "session.idle") {
          this.maybeCompactForCost(sessionID)
        }
        this.persistLedgerSoon()
      }
      return
    }
    if (type === "session.compaction.ended" || type === "session.compaction.failed") {
      const sessionID = data.sessionID
      if (typeof sessionID !== "string") return
      // A compaction rebuilds the transcript, so the context size the router
      // has been carrying is stale: it still reflects the pre-compaction
      // session. That stale number is what the context gate uses to decide
      // whether a model can serve the session, so a session that was just
      // compacted can be wrongly excluded from the cheapest provider - it
      // looks too large for OpenDesign's window when it is not.
      //
      // Drop the cached value so the next prompt re-reads the real size.
      this.contextLoaded.delete(sessionID)
      const session = this.ledger.getSession(sessionID)
      if (session) {
        this.ledger.patchSession(sessionID, { contextTokens: 0, cacheReadTokens: 0 })
      }
      // Re-read the real size now rather than at the next prompt. The
      // compaction message's own token counts describe the transcript it
      // replaced, not the rebuilt one, so the authoritative value is the
      // last assistant step after the compaction.
      void this.refreshContextAfterCompaction(sessionID)
      this.persistLedgerSoon()
      return
    }
    if (type === "session.step.ended") {
      const sessionID = data.sessionID
      if (typeof sessionID !== "string") return
      const session = this.ledger.getSession(sessionID)
      const model = session?.lastModel
      const tokens = tokensFrom(data.tokens)
      const latency = this.stepStarted.get(sessionID) ? Date.now() - (this.stepStarted.get(sessionID) ?? Date.now()) : undefined
      if (model) {
        this.ledger.recordUsage({
          sessionID,
          model,
          cost: typeof data.cost === "number" ? data.cost : 0,
          tokens,
          at: typeof event.created === "number" ? event.created : Date.now(),
          latencyMs: latency,
          premium: this.registry.get(model.providerID, model.id)?.premium ?? false,
        })
        // A completed step is proof the provider's pre-request path worked,
        // so any run of provider-scoped failures starts over.
        this.ledger.recordProviderSuccess(model.providerID)
      }
      this.persistLedgerSoon()
      return
    }
    if (type === "session.step.failed") {
      const sessionID = data.sessionID
      if (typeof sessionID !== "string") return
      // The assistant message id identifies the attempt, so the same
      // attempt reported through several channels is counted once.
      const attemptKey = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      await this.recordProviderFault(sessionID, "failed", data.error, attemptKey)
      this.persistLedgerSoon()
      return
    }
    if (type === "session.retry.scheduled") {
      const sessionID = data.sessionID
      if (typeof sessionID === "string") {
        // This event only schedules a retry; the failure itself is recorded
        // by the retry hook or the step/execution events, so it must not
        // add a strike of its own.
        this.ledger.recordRetry(sessionID)
        this.persistLedgerSoon()
      }
    }
  }

  private async registerRpc() {
    const implementation: any = {
      status: async (input: any) => this.statusFor(input?.sessionID),
      onboarding: async () => this.onboardingState(),
      completeOnboarding: async () => {
        this.onboardingComplete = true
        return { ok: true }
      },
      recordPlanPage: async (input: any) => this.recordPlanPage(input),
      preview: async (input: any) => {
        const sessionID = input?.sessionID ?? "preview"
        const session = this.ledger.getSession(sessionID)
        const task = classifyTask({
          text: input?.text ?? "",
          files: this.classifierFiles(input?.files),
          contextTokens: session?.contextTokens ?? 0,
          recentFailures: session?.failures.length ?? 0,
        })
        const child = Boolean(session?.parentID)
        const previewMode = child && this.settings.mode === "premium" ? "balanced" : this.settings.mode
        const previewPremium = child ? { ...this.premiumState(session), oneShotGranted: false } : this.premiumState(session)
        const result = routeTask({
          task,
          settings: this.settings,
          mode: previewMode,
          runtime: session?.manualOverride ? "manual" : this.settings.enabled ? "automatic" : "paused",
          models: this.registry.approved(),
          current: session?.lastModel,
          session,
          quota: this.quotaSnapshots(),
          premium: previewPremium,
          contextTokens: session?.contextTokens ?? 0,
          cachedTokens: session?.cacheReadTokens ?? 0,
          dryRun: true,
          modelHistory: this.ledger.snapshotMetrics().byModel,
      cooldowns: this.ledger.cooldowns(),
        })
        return result.decision
      },
      setMode: async (input: any) => {
        this.runtime.mode = input.mode
        this.persistRuntime()
        const summary = this.statusFor()
        void this.emit("status", { summary })
        return summary
      },
      setPaused: async (input: any) => {
        this.runtime.paused = Boolean(input.paused)
        this.persistRuntime()
        void this.notifyChange(
          `global:paused:${Boolean(input.paused)}`,
          input.paused ? "PAUSED · automatic routing is paused" : "AUTO · automatic routing resumed",
        )
        const summary = this.statusFor()
        void this.emit("status", { summary })
        return summary
      },
      setSessionAuto: async (input: any) => {
        const sessionID = input.sessionID
        await this.loadSessionInfo(sessionID)
        const auto = Boolean(input.auto)
        this.ledger.patchSession(sessionID, { paused: !auto })
        if (auto) {
          // Handing control back means letting the router pick again; leaving a
          // manual override in place would make the switch look broken.
          this.ledger.clearManual(sessionID)
          this.ledger.patchSession(sessionID, { pinnedModel: undefined })
        }
        this.persistLedgerSoon()
        await this.queueTitle(sessionID)
        this.modelNotice(
          sessionID,
          auto ? "AUTO" : "MANUAL",
          this.ledger.getSession(sessionID)?.lastModel,
          auto ? "automatic routing resumed" : "automatic routing off for this session",
        )
        const summary = this.statusFor(sessionID)
        void this.emit("status", { sessionID, summary })
        return summary
      },
      setDryRun: async (input: any) => {
        this.runtime.dryRun = Boolean(input.dryRun)
        this.persistRuntime()
        void this.notifyChange(
          `global:dry-run:${Boolean(input.dryRun)}`,
          input.dryRun ? "DRY RUN · decisions will be explained, not applied" : "AUTO · routing will apply decisions",
        )
        const summary = this.statusFor()
        void this.emit("status", { summary })
        return summary
      },
      resumeAuto: async (input: any) => {
        const sessionID = input.sessionID
        await this.loadSessionInfo(sessionID)
        this.ledger.clearManual(sessionID)
        this.ledger.patchSession(sessionID, { pinnedModel: undefined, paused: false, premiumOneShot: false })
        this.persistLedgerSoon()
        await this.queueTitle(sessionID)
        this.modelNotice(sessionID, "AUTO", this.ledger.getSession(sessionID)?.lastModel, "automatic routing resumed")
        const summary = this.statusFor(sessionID)
        void this.emit("status", { sessionID, summary })
        return summary
      },
      pin: async (input: any) => {
        const model: ModelRef = {
          providerID: input.providerID,
          id: input.modelID,
          ...(typeof input.variant === "string" && input.variant.length > 0 ? { variant: input.variant } : {}),
        }
        this.ledger.setManual(input.sessionID, model)
        this.ledger.patchSession(input.sessionID, { pinnedModel: model, lastModel: model })
        this.rememberModel(input.sessionID, model.providerID, model.id)
        void this.queueTitle(input.sessionID)
        this.modelNotice(input.sessionID, "MANUAL", model, "pinned · /router-auto to resume")
        this.expectedSwitch.set(input.sessionID, { key: modelKey(model.providerID, model.id), at: Date.now() })
        try {
          await this.ctx.session.switchModel({ sessionID: input.sessionID, model })
        } catch (error) {
          this.expectedSwitch.delete(input.sessionID)
          this.settingsWarnings.push(`Pin switch failed: ${safeError(error)}`)
        }
        this.persistLedgerSoon()
        const summary = this.statusFor(input.sessionID)
        void this.emit("status", { sessionID: input.sessionID, summary })
        return summary
      },
      approvePremium: async (input: any) => {
        this.ledger.grantPremiumOneShot(input.sessionID)
        this.persistLedgerSoon()
        void this.notifyChange(`${input.sessionID}:premium-granted`, "Premium approval granted for this session.")
        const summary = this.statusFor(input.sessionID)
        void this.emit("status", { sessionID: input.sessionID, summary })
        return summary
      },
      denyPremium: async (input: any) => {
        this.ledger.consumePremiumOneShot(input.sessionID)
        this.persistLedgerSoon()
        void this.notifyChange(`${input.sessionID}:premium-denied`, "Premium approval cleared for this session.")
        const summary = this.statusFor(input.sessionID)
        void this.emit("status", { sessionID: input.sessionID, summary })
        return summary
      },
      excludeModel: async (input: any) => {
        const key = modelKey(input.providerID, input.modelID)
        const excluded = new Set(this.runtime.excluded ?? [])
        if (input.excluded) excluded.add(key)
        else excluded.delete(key)
        this.runtime.excluded = [...excluded]
        this.persistRuntime()
        this.rebuildRegistry()
        const summary = this.statusFor()
        void this.emit("status", { summary })
        return summary
      },
      setPremiumBudget: async (input: any) => {
        this.runtime.premiumBudgetUsd = input.usd
        this.persistRuntime()
        const summary = this.statusFor()
        void this.emit("status", { summary })
        return summary
      },
      setReserve: async (input: any) => {
        const reserves = { ...(this.runtime.reserves ?? {}) }
        reserves[input.providerID] = {
          ...(reserves[input.providerID] ?? {}),
          ...(typeof input.monthlyPct === "number" ? { monthlyPct: input.monthlyPct } : {}),
          ...(typeof input.weeklyPct === "number" ? { weeklyPct: input.weeklyPct } : {}),
          ...(typeof input.fiveHourPct === "number" ? { fiveHourPct: input.fiveHourPct } : {}),
        }
        this.runtime.reserves = reserves
        this.persistRuntime()
        const summary = this.statusFor()
        void this.emit("status", { summary })
        return summary
      },
      refreshQuota: async () => {
        await Promise.allSettled([this.quota.refresh("opencode-go", true), this.quota.refresh("commandcode", true)])
        const summary = this.statusFor()
        void this.emit("status", { summary })
        return summary
      },
      report: async () => this.report(),
      usage: async () => this.usageReport(),
      /**
       * Report the intelligence floor in force and where it came from.
       *
       * Deliberately reports the *disabled* case too. The useful answer to
       * "what is my floor" is not one number: it is whether that number was
       * measured, hand-picked, or not yet calibratable because there is no
       * traffic to calibrate against.
       */
      floor: async () => this.floorReport(),
      setCalibrateFloor: async (input: any) => {
        const enabled = Boolean(input?.enabled)
        // Routing settings are file-backed. Runtime overrides exist for mode,
        // pause and dry-run; changing a routing policy value at runtime would
        // diverge from the file and silently reset on reload, so this reports
        // exactly what to write instead of pretending it was applied.
        return {
          ...this.floorReport(),
          setting: "routing.calibrateFloor",
          requested: enabled,
          applied: false,
          instruction: enabled
            ? "Set routing.calibrateFloor to true in smart-router.json, then restart the router."
            : "Set routing.calibrateFloor to false in smart-router.json, then restart the router.",
        }
      },
      getConfig: async () => ({
        settings: (() => {
          const copy = this.safe(this.settings)
          for (const provider of Object.values(copy.providers ?? {}) as any[]) {
            if (provider && typeof provider === "object") delete provider.credentialPath
          }
          return copy
        })(),
        sources: this.settingsSources,
        warnings: this.settingsWarnings,
        runtime: this.runtime,
        ledgerUpdatedAt: this.ledger.data.updatedAt,
        models: this.registry.approved().map((model) => ({
          key: model.key,
          tier: model.tier,
          intelligence: model.intelligence,
          design: model.design,
          premium: model.premium,
          training: model.training,
          monthlyAllowanceUsd: model.monthlyAllowanceUsd,
        })),
      }),
      resetOverrides: async () => {
        for (const key of Object.keys(this.runtime) as Array<keyof RuntimeOverrides>) delete this.runtime[key]
        sharedCore.runtime = this.runtime
        this.persistRuntime()
        this.rebuildRegistry()
        const summary = this.statusFor()
        void this.emit("status", { summary })
        return summary
      },
      resetMetrics: async () => {
        await sharedCore.resetLedger()
        this.ledger = sharedCore.ledger
        this.contextLoaded.clear()
        this.contextInflight.clear()
        const summary = this.statusFor()
        void this.emit("status", { summary })
        return summary
      },
      refreshIndicator: async (input: any) => {
        await this.loadSessionInfo(input.sessionID)
        await this.queueTitle(input.sessionID)
        const summary = this.statusFor(input.sessionID)
        void this.emit("status", { sessionID: input.sessionID, summary })
        return summary
      },
      setTitleIndicator: async (input: any) => {
        // The router no longer renames sessions. `enabled: true` is accepted for
        // old callers and ignored; `enabled: false` runs the one-time cleanup of
        // titles written by earlier versions.
        if (input?.enabled !== true) await this.restoreTitles()
        const summary = this.statusFor()
        void this.emit("status", { summary })
        return summary
      },
      setSidebarGroups: async (input: any) => {
        this.runtime.sidebarGroups = Boolean(input.enabled)
        this.persistRuntime()
        const summary = this.statusFor()
        void this.emit("status", { summary })
        return summary
      },
      diagnostics: async () => sharedCore.diagnostics(),
    }
    const safeImplementation = Object.fromEntries(
      Object.entries(implementation).map(([name, handler]) => [
        name,
        async (input: any) => this.safe(await (handler as any)(input)),
      ]),
    )
    this.rpcRegistration = await this.ctx.rpc.register(SmartRouterRpc, safeImplementation)
  }

  private async registerCommands() {
    const notice = async (sessionID: string, text: string) => {
      try {
        await this.ctx.session.synthetic({ sessionID, text, description: "Smart Router", resume: false })
      } catch (error) {
        this.settingsWarnings.push(`Could not display router command output: ${safeError(error)}`)
      }
    }

    const command = (name: string, description: string, execute: (input: any) => Promise<void>) =>
      this.ctx.command.transform((editor: any) => {
        editor.add({ name, description, execute })
      })

    this.registrations.push(
      await command("router-status", "Show the current routing decision, tier and quota state", async ({ sessionID }: any) => {
        await this.loadSessionInfo(sessionID)
        await this.queueTitle(sessionID)
        const status = this.statusFor(sessionID)
        const decision = status.lastDecision
        const lines = [
          `Smart Router: ${status.indicator.state} · ${status.mode}${status.dryRun ? " · dry run" : ""}`,
          status.current ? `Current: ${status.current.providerID}/${status.current.id}${status.currentTier ? ` (tier ${status.currentTier})` : ""}` : "Current: unknown",
          decision ? `Task: tier ${decision.task.tier} ${decision.task.kind}; chosen: ${decision.chosen ? `${decision.chosen.providerID}/${decision.chosen.id}` : "none"}` : "No decision yet",
          decision ? `Why: ${decision.switchReason}` : "",
          ...status.quota.flatMap((snapshot) => formatQuotaLines(snapshot)),
          status.premium.mode !== "off"
            ? `Premium: ${status.premium.mode}, ${usd(status.premium.remainingUsd)} remaining${status.premium.oneShotGranted ? ", one-shot approved" : ""}`
            : "Premium: off",
          ...status.warnings.slice(0, 4).map((warning) => `Warning: ${warning}`),
        ].filter(Boolean)
        await notice(sessionID, lines.join("\n"))
      }),
    )

    this.registrations.push(
      await command("router-auto", "Resume automatic routing for this session", async ({ sessionID }: any) => {
        this.ledger.clearManual(sessionID)
        this.ledger.patchSession(sessionID, { pinnedModel: undefined, paused: false })
        this.persistLedgerSoon()
        void this.queueTitle(sessionID)
        this.modelNotice(sessionID, "AUTO", this.ledger.getSession(sessionID)?.lastModel, "automatic routing resumed")
        await notice(sessionID, "AUTO · automatic routing resumed for this session.")
      }),
    )

    this.registrations.push(
      await command("router-pin", "Pin a model for this session: /router-pin provider/model", async ({ sessionID, prompt }: any) => {
        const requested = String(prompt?.text ?? "").trim().split(/\s+/).pop() ?? ""
        const [modelKeyPart, variant] = requested.split("#", 2)
        const parsed = parseModelKey(modelKeyPart ?? "")
        if (!parsed.modelID) {
          await notice(sessionID, "Usage: /router-pin provider/model[#variant]")
          return
        }
        const model = {
          providerID: parsed.providerID,
          id: parsed.modelID,
          ...(variant ? { variant } : {}),
        }
        this.ledger.setManual(sessionID, model)
        this.ledger.patchSession(sessionID, { pinnedModel: model, lastModel: model })
        this.rememberModel(sessionID, model.providerID, model.id)
        this.expectedSwitch.set(sessionID, { key: requested, at: Date.now() })
        try {
          await this.ctx.session.switchModel({ sessionID, model })
          void this.queueTitle(sessionID)
          this.modelNotice(sessionID, "MANUAL", model, "pinned · /router-auto to resume")
          await notice(sessionID, `MANUAL · pinned ${requested}. Automatic routing is suspended for this session. Run /router-auto to resume.`)
        } catch (error) {
          this.expectedSwitch.delete(sessionID)
          await notice(sessionID, `Could not pin ${requested}: ${safeError(error)}`)
        }
        this.persistLedgerSoon()
      }),
    )

    this.registrations.push(
      await command("router-mode", "Set routing mode: efficiency, balanced, or premium", async ({ sessionID, prompt }: any) => {
        const mode = String(prompt?.text ?? "").trim().split(/\s+/).pop()
        if (mode !== "efficiency" && mode !== "balanced" && mode !== "premium") {
          await notice(sessionID, "Usage: /router-mode efficiency|balanced|premium")
          return
        }
        this.runtime.mode = mode
        this.persistRuntime()
        await notice(sessionID, `Routing mode set to ${mode}.`)
      }),
    )

    this.registrations.push(
      await command("router-approve", "Approve one premium request for this session", async ({ sessionID }: any) => {
        this.ledger.grantPremiumOneShot(sessionID)
        this.persistLedgerSoon()
        await notice(sessionID, "One-shot premium approval granted for this session.")
      }),
    )

    this.registrations.push(
      await command("router-pause", "Pause automatic routing globally", async ({ sessionID }: any) => {
        this.runtime.paused = true
        this.persistRuntime()
        void this.notifyChange("global:paused:true", "PAUSED · automatic routing is paused")
        await notice(sessionID, "PAUSED · automatic routing is paused.")
      }),
    )

    this.registrations.push(
      await command("router-resume", "Resume automatic routing globally", async ({ sessionID }: any) => {
        this.runtime.paused = false
        this.persistRuntime()
        void this.notifyChange("global:paused:false", "AUTO · automatic routing resumed")
        await notice(sessionID, "AUTO · automatic routing resumed.")
      }),
    )

    this.registrations.push(
      await command("router-report", "Show local usage and routing metrics", async ({ sessionID }: any) => {
        await notice(sessionID, this.formatReport())
      }),
    )

    this.registrations.push(
      await command("router-floor", "Show the intelligence floor in force and where it came from", async ({ sessionID }: any) => {
        await notice(sessionID, this.formatFloor())
      }),
    )

    this.registrations.push(
      await command("router-dry-run", "Enable or disable dry-run routing: /router-dry-run on|off", async ({ sessionID, prompt }: any) => {
        const value = String(prompt?.text ?? "").trim().split(/\s+/).pop()
        if (value !== "on" && value !== "off") {
          await notice(sessionID, "Usage: /router-dry-run on|off")
          return
        }
        this.runtime.dryRun = value === "on"
        this.persistRuntime()
        void this.notifyChange(
          `global:dry-run:${value === "on"}`,
          value === "on" ? "DRY RUN · decisions will be explained, not applied" : "AUTO · routing will apply decisions",
        )
        await notice(sessionID, value === "on" ? "DRY RUN · decisions will be explained, not applied." : "AUTO · routing will apply decisions.")
      }),
    )

    this.registrations.push(
      await command("router-title", "Strip router-written prefixes from existing session titles: /router-title off", async ({ sessionID, prompt }: any) => {
        const value = String(prompt?.text ?? "").trim().split(/\s+/).pop()
        if (value === "on") {
          await notice(sessionID, "The router no longer renames sessions. Titles stay yours; status lives in the panel and the header.")
          return
        }
        if (value !== "off") {
          await notice(sessionID, "Usage: /router-title off (strips prefixes this plugin wrote in older versions)")
          return
        }
        const restored = await this.restoreTitles()
        await notice(sessionID, `Cleaned ${restored} session title${restored === 1 ? "" : "s"}. Titles written before the separator was lost cannot be recovered.`)
      }),
    )

    this.registrations.push(
      await command("router-exclude", "Exclude a model from automatic routing: /router-exclude provider/model", async ({ sessionID, prompt }: any) => {
        const requested = String(prompt?.text ?? "").trim().split(/\s+/).pop() ?? ""
        const parsed = parseModelKey(requested)
        if (!parsed.modelID) {
          await notice(sessionID, "Usage: /router-exclude provider/model")
          return
        }
        const excluded = new Set(this.runtime.excluded ?? [])
        excluded.add(requested)
        this.runtime.excluded = [...excluded]
        this.persistRuntime()
        this.rebuildRegistry()
        await notice(sessionID, `Excluded ${requested} from automatic routing.`)
      }),
    )

    this.registrations.push(
      await command("router-premium-budget", "Set the monthly premium budget in USD: /router-premium-budget 10", async ({ sessionID, prompt }: any) => {
        const value = Number(String(prompt?.text ?? "").trim().split(/\s+/).pop())
        if (!Number.isFinite(value) || value < 0) {
          await notice(sessionID, "Usage: /router-premium-budget <usd>")
          return
        }
        this.runtime.premiumBudgetUsd = Math.max(0, Math.min(100_000, value))
        this.persistRuntime()
        await notice(sessionID, `Premium monthly budget set to ${usd(value)}.`)
      }),
    )

    this.registrations.push(
      await command("router-reserve", "Set provider reserves: /router-reserve provider monthlyPct weeklyPct fiveHourPct", async ({ sessionID, prompt }: any) => {
        const tokens = String(prompt?.text ?? "").trim().split(/\s+/).filter(Boolean)
        const tail = tokens.slice(-4)
        const providerID = tail[0]
        const monthlyPct = Number(tail[1])
        const weeklyPct = Number(tail[2])
        const fiveHourPct = Number(tail[3])
        if (!providerID || ![monthlyPct, weeklyPct, fiveHourPct].every((value) => Number.isFinite(value))) {
          await notice(sessionID, "Usage: /router-reserve provider monthlyPct weeklyPct fiveHourPct")
          return
        }
        const clampReserve = (value: number) => Math.max(0, Math.min(90, value))
        this.runtime.reserves = {
          ...(this.runtime.reserves ?? {}),
          [providerID]: {
            monthlyPct: clampReserve(monthlyPct),
            weeklyPct: clampReserve(weeklyPct),
            fiveHourPct: clampReserve(fiveHourPct),
          },
        }
        this.persistRuntime()
        await notice(sessionID, `Reserves for ${providerID}: monthly ${monthlyPct}%, weekly ${weeklyPct}%, 5h ${fiveHourPct}%.`)
      }),
    )

    this.registrations.push(
      await command("router-reset-metrics", "Reset local router metrics and session routing state: /router-reset-metrics --confirm", async ({ sessionID, prompt }: any) => {
        if (!String(prompt?.text ?? "").includes("--confirm")) {
          await notice(sessionID, "This resets local router metrics, not conversations. Run /router-reset-metrics --confirm to proceed.")
          return
        }
        await sharedCore.resetLedger()
        this.ledger = sharedCore.ledger
        this.contextLoaded.clear()
        this.contextInflight.clear()
        await notice(sessionID, "Local router metrics and routing state were reset; conversations were not changed.")
      }),
    )

    this.registrations.push(
      await command("router-diagnostics", "Show shared-core lifecycle and registration diagnostics", async ({ sessionID }: any) => {
        await notice(sessionID, JSON.stringify(sharedCore.diagnostics(), null, 2))
      }),
    )

    this.registrations.push(
      await command("router-explain", "Explain the last routing decision", async ({ sessionID }: any) => {
        const status = this.statusFor(sessionID)
        const decision = status.lastDecision
        if (!decision) {
          await notice(sessionID, "No routing decision has been recorded yet.")
          return
        }
        const lines = [
          `Decision ${decision.id} at ${new Date(decision.at).toISOString()}`,
          `Task: tier ${decision.task.tier} ${decision.task.kind} (${decision.task.confidence} confidence)`,
          `Signals: ${decision.task.signals.join(", ") || "none"}`,
          `Reasons: ${decision.reasons.join(" ") || "none"}`,
          `Chosen: ${decision.chosen ? `${decision.chosen.providerID}/${decision.chosen.id}` : "none"}`,
          `Switch: ${decision.switchReason}`,
          `Warnings: ${decision.warnings.join(" ") || "none"}`,
          ...decision.candidates.slice(0, 5).map(
            (candidate) =>
              `  ${candidate.model.providerID}/${candidate.model.modelID}: ${candidate.eligible ? "eligible" : candidate.reason} · ${usd(candidate.effectiveCost)} expected${candidate.creditMultiplier && candidate.creditMultiplier !== 1 ? ` · ${candidate.creditMultiplier}x credits` : ""}`,
          ),
          ...decision.quota.map(
            (snapshot) => `  quota ${snapshot.label}: ${quotaStateLabel(snapshot)}`,
          ),
        ]
        await notice(sessionID, lines.join("\n"))
      }),
    )

    this.registrations.push(
      await command("router-opendesign", "Show OpenDesign connection, entitlement and credit diagnostics", async ({ sessionID }: any) => {
        await notice(sessionID, await this.formatOpenDesignReport())
      }),
    )
  }

  /**
   * Report the OpenDesign connection state.
   *
   * This command makes only read-only metadata requests. It never performs
   * inference and never spends plan credits.
   */
  private async formatOpenDesignReport(): Promise<string> {
    const providerSettings = this.settings.providers.opendesign
    if (!providerSettings) return "OpenDesign is not configured."
    const lines: string[] = []
    lines.push(`OpenDesign provider: ${providerSettings.enabled ? "enabled" : "disabled"} · plan ${providerSettings.plan}`)
    lines.push(`Base URL: ${normalizeOpenDesignBaseURL(providerSettings.baseURL)}`)
    lines.push(
      `Allowance: monthly ${usd(providerSettings.monthlyCreditsUsd ?? 0)} · 5h ${usd(providerSettings.fiveHourCapUsd ?? 0)} · weekly ${usd(providerSettings.weeklyCapUsd ?? 0)} (5h and weekly are nested inside the monthly maximum)`,
    )
    lines.push(`Subscription only: ${providerSettings.subscriptionOnly !== false ? "yes" : "no"} · purchased credits allowed: ${providerSettings.allowExtraUsage ? "yes" : "no"}`)
    if (providerSettings.creditsPerUsd) lines.push(`Credits per USD: ${providerSettings.creditsPerUsd}`)

    let apiKey: string | undefined
    let controlKey: string | undefined
    try {
      const resolved = await this.resolveOpenDesignCredentials()
      apiKey = resolved.openDesignApiKey
      controlKey = resolved.openDesignControlKey
    } catch {
      // Fall through to the unknown state.
    }
    lines.push(`Inference key: ${apiKey ? "found" : "not found"}`)
    lines.push(`Control key: ${controlKey ? "found (verified quota available)" : "not configured (quota is an estimate)"}`)

    if (apiKey) {
      const result = await discoverOpenDesignModels({
        apiKey,
        ...(providerSettings.baseURL ? { baseURL: providerSettings.baseURL } : {}),
      })
      if (!result.ok) {
        lines.push(`Gateway discovery failed: ${result.error ?? "unknown error"}`)
      } else {
        lines.push(`Entitled models on the gateway: ${result.models.length}`)
        for (const model of result.models.slice(0, 20)) {
          const spec = OPEN_DESIGN_MODEL_BY_ID.get(model.id)
          const multiplier = creditMultiplierFor(model.id)
          const context = model.contextBudget ?? spec?.context ?? 0
          const vision = model.inputModalities.includes("image") ? "image" : "text only"
          lines.push(
            `  ${model.id}: ${context.toLocaleString()} usable input · ${(model.outputBudget ?? spec?.maxOutput ?? 0).toLocaleString()} output · ${vision} · ${multiplier.multiplier}x credits${multiplier.evidence === "unverified" ? " (multiplier not published)" : ""}`,
          )
        }
      }
    }

    const snapshot = this.quotaSnapshots().find((entry) => entry.providerID === "opendesign")
    if (snapshot) {
      lines.push(`Quota state: ${quotaStateLabel(snapshot)}`)
      for (const note of snapshot.notes.slice(0, 4)) lines.push(`  ${note}`)
      if (snapshot.error) lines.push(`  ${snapshot.error}`)
    }
    lines.push("No inference request was made by this command.")
    return lines.join("\n")
  }

  /**
   * One screen describing the floor, its provenance, and what it admits.
   *
   * Printed rather than summarised because the point of the command is to make
   * the number checkable. The reason line names the model and both cost figures
   * the calibration compared, so the reader can disagree with it.
   */
  private formatFloor(): string {
    const report = this.floorReport()
    const lines: string[] = []
    lines.push(`Floor in force: ${report.floorInForce.toFixed(1)} (${report.source})`)
    lines.push(`  configured: ${report.configuredFloor.toFixed(1)}`)

    if (report.offlineBypass) {
      lines.push("  calibration is inactive while offline mode is enabled")
    } else if (!report.calibrateFloor) {
      lines.push("  calibration is off; set routing.calibrateFloor to true to derive this from spend")
    } else if (!report.calibrated) {
      lines.push(`  not calibrated: ${report.reason}`)
    } else {
      lines.push(`  calibrated: ${report.reason}`)
      if (report.baselineUsdPerRequest !== null) {
        lines.push(`  measured baseline: $${report.baselineUsdPerRequest.toFixed(6)} per request over ${report.windowDays} days`)
      }
    }

    lines.push(`  needs ${report.minRequests} recorded requests; you have ${report.totalRequests}`)
    lines.push(`Admitted at this floor (${report.admitted.length}):`)
    for (const entry of report.admitted.slice(0, 10)) {
      const price = entry.listInputUsdPerMtok === null ? "?" : `$${entry.listInputUsdPerMtok}`
      lines.push(`  ${entry.model}  intel ${entry.intelligence.toFixed(1)}  ${price}/Mtok in`)
    }
    if (report.admitted.length > 10) lines.push(`  ... ${report.admitted.length - 10} more`)

    if (report.measuredTraffic.length > 0) {
      lines.push("Measured traffic:")
      for (const row of report.measuredTraffic.slice(0, 6)) {
        lines.push(`  ${row.model}  ${row.requests} req  $${row.usdPerRequest.toFixed(6)}/req`)
      }
    }
    return lines.join("\n")
  }

  private formatReport() {
    const metrics = this.ledger.snapshotMetrics()
    const modelLines = Object.entries(metrics.byModel)
      .sort((a, b) => b[1].usd - a[1].usd)
      .slice(0, 8)
      .map(([key, value]) => {
        const reliability =
          value.failures > 0
            ? ` · ${value.failures} provider fault${value.failures === 1 ? "" : "s"}`
            : ""
        const cost = key.startsWith("opendesign/")
          ? `${usd(value.usd)} est. credits`
          : usd(value.usd)
        return `${key}: ${value.requests} req · ${value.input.toLocaleString()} in · ${value.cacheRead.toLocaleString()} cache · ${value.output.toLocaleString()} out · ${cost}${reliability}`
      })
    const latency = metrics.latencySamples > 0 ? `${Math.round(metrics.latencyMsTotal / metrics.latencySamples)} ms avg` : "no samples"
    const cooldowns = Object.entries(this.ledger.cooldowns()).filter(([, until]) => until > Date.now())
    return [
      `Requests: ${metrics.requests.toLocaleString()}`,
      `Tokens: ${metrics.inputTokens.toLocaleString()} fresh input, ${metrics.cacheReadTokens.toLocaleString()} cache read, ${metrics.outputTokens.toLocaleString()} output`,
      `Estimated allowance value: ${usd(metrics.estimatedUsd)} (provider-reported where available; otherwise local estimate)`,
      `Switches: ${metrics.switches} · escalations: ${metrics.escalations} · prevented premium: ${metrics.preventedPremium} · retries: ${metrics.retries}`,
      `Premium spend: ${usd(metrics.premiumUsd)} across ${metrics.premiumRequests} requests`,
      `Latency: ${latency}`,
      ...cooldowns.map(
        ([key, until]) => `Cooling down: ${key} for another ${Math.max(0, Math.round((until - Date.now()) / 1000))}s after a provider fault`,
      ),
      ...modelLines,
    ].join("\n")
  }

  private report() {
    return {
      text: this.formatReport(),
      metrics: this.ledger.snapshotMetrics(),
      quota: this.quotaSnapshots(),
      decisions: this.ledger.decisions(20),
      status: this.statusFor(),
    }
  }

  /**
   * Durable usage report: per-provider, per-model, per-window, with forecasts.
   *
   * A provider that meters a five-hour window reports it; one that does not
   * reports an empty row, so a dashboard can distinguish "unused" from "not
   * applicable" instead of showing a limit that cannot be hit.
   */
  private usageReport() {
    const now = Date.now()
    const quota = this.quotaSnapshots()
    const providers = Object.entries(this.settings.providers)
      .filter(([, settings]) => settings.enabled)
      .map(([providerID, settings]) => {
        const snapshot = quota.find((entry) => entry.providerID === providerID)
        const resolvedPlan = resolvePlanWithReason(providerID, settings.plan)
        const plan = resolvedPlan.plan
        const designPlan = plan?.pools.find((pool) => pool.id === "design-plan")
        const hasFiveHourWindow = Boolean(
          !settings.ignoreFiveHourWindow && designPlan?.fiveHourUsd !== undefined,
        )
        const hasWeeklyWindow = Boolean(
          !settings.ignoreWeeklyWindow &&
            (designPlan?.weeklyUsd !== undefined ||
              plan?.perModelWindowRule !== undefined),
        )
        return buildProviderUsageReport({
          providerID,
          label: snapshot?.label ?? plan?.label ?? providerID,
          // A configured-but-unrecognized plan id is reported as unresolved
          // rather than echoed. Printing the raw string next to dollar figures
          // implies it is a tier this build understands.
          plan: describePlan(plan?.planID, settings.plan),
          source: snapshot?.source ?? "unknown",
          ...(snapshot?.quotaState ? { quotaState: snapshot.quotaState } : {}),
          now,
          source_: {
            aggregate: (window) => this.ledger.aggregate(window),
            usageByModel: (window) => this.ledger.usageByModel(window),
            usageEvents: this.ledger.usageEvents(),
          },
          hasFiveHourWindow,
          hasWeeklyWindow,
          ...(snapshot?.monthlyRemainingUsd !== undefined
            ? { remainingMonthlyUsd: snapshot.monthlyRemainingUsd }
            : {}),
          notes: snapshot?.notes ?? [],
        })
      })
    return {
      generatedAt: now,
      providers,
      speed: this.speedSnapshot(),
      contextManagement: {
        mode: this.settings.contextManagement.mode,
        description: describeMode(this.settings.contextManagement.mode),
        enabled: this.settings.contextManagement.enabled,
      },
      retention: {
        rawEventHorizonHours: 48,
        note: "Events older than the horizon are folded into hourly aggregates, so nothing is discarded.",
      },
    }
  }

  async dispose() {
    if (this.cleanupDone) return
    this.cleanupDone = true
    this.promptRoutes.clearAll()
    this.pendingHeals.clear()
    this.requestKinds.clear()
    if (this.bridgeID) sharedCore.removeBridge(this.bridgeID)
    await Promise.allSettled(this.registrations.map((registration) => registration?.dispose?.()))
    // Start the write immediately, but do not block a reload on storage. The
    // grace timer performs the final flush when the last bridge leaves.
    void sharedCore.persistNow()
  }
}
