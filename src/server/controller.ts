import { resolve } from "node:path"
import type {
  ModelRecord,
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
import { loadSettings, type SettingsLoadResult } from "../core/config.js"
import { classifyFailure } from "../core/failures.js"
import { buildRegistry } from "../core/models/registry.js"
import { QuotaService } from "../core/quota/service.js"
import { LedgerStore, type BootstrapSession } from "../core/quota/ledger.js"
import { routeTask } from "../core/routing/engine.js"
import { decidePremium, evaluateEligibility } from "../core/policy/eligibility.js"
import { sharedCore, type RuntimeOverrides } from "./shared-core.js"
import {
  ChangeNotifier,
  buildIndicatorTitle,
  indicatorState,
  providerShort,
  stripTitlePrefix,
  type Indicator,
} from "../core/ui.js"
import { SmartRouterRpc } from "../rpc.js"
import {
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
  if (typeof runtime.titleIndicator === "boolean") next.ui.titleIndicator = runtime.titleIndicator
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
  private readonly inflight = new Set<string>()
  private readonly promptSeen = new Set<string>()
  private readonly created = new Map<string, number>()
  private readonly stepStarted = new Map<string, number>()
  private readonly contextLoaded = new Set<string>()
  private readonly contextInflight = new Map<string, Promise<void>>()
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
    this.ledger = new LedgerStore()
  }

  private get settings(): RouterSettings {
    return applyRuntime(this.settingsBase, this.runtime)
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
    await sharedCore.init({
      ctx: this.ctx,
      getSettings: () => this.settings,
      getCredentials: () => this.resolveQuotaCredentials(),
    })
    this.ledger = sharedCore.ledger
    this.runtime = sharedCore.runtime
    this.quota =
      sharedCore.quota ??
      new QuotaService({
        getSettings: () => this.settings.providers as any,
        getCredentials: () => this.resolveQuotaCredentials(),
        probeIntervalMinutes: this.settings.quota.probeIntervalMinutes,
        initial: [],
      })
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

  private async resolveQuotaCredentials() {
    let goAccessToken: string | undefined
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
    return { goAccessToken, commandCodeIntegrationKey, commandCodeProviderKey }
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
      // A full transcript read can take seconds on a very large session. Use a
      // conservative cumulative estimate for admission, then refine it in the
      // background. This keeps prompt latency low without losing cache affinity.
      if (session.contextTokens === 0) {
        const cumulative = (Number(info?.tokens?.input) || 0) + (Number(info?.tokens?.cache?.read) || 0)
        const created = Number(info?.time?.created) || 0
        const updated = Number(info?.time?.updated) || 0
        let estimate = 0
        if (cumulative > 0) {
          estimate = Math.min(400_000, cumulative)
        } else if (info?.fork) {
          // A fork inherits a transcript but may carry no cumulative usage.
          estimate = 350_000
        } else if (created > 0 && updated - created > 60_000) {
          estimate = 150_000
        }
        if (estimate > 0) {
          this.ledger.patchSession(sessionID, {
            contextTokens: estimate,
            cacheReadTokens: Math.min(Number(info?.tokens?.cache?.read) || 0, estimate),
          })
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
      ...(session?.indicatorTitle ? { title: session.indicatorTitle } : {}),
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

  private async applyTitleNow(sessionID: string) {
    if (!this.settings.ui.titleIndicator) return
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
    const modelRef = session.pinnedModel ?? session.manualModel ?? session.lastModel
    if (!modelRef) return

    // If the user or the title generator renamed the session, adopt the new
    // base title instead of fighting it.
    if (currentTitle && currentTitle !== session.indicatorTitle) {
      const stripped = stripTitlePrefix(currentTitle) || currentTitle
      if (stripped && stripped !== session.baseTitle) {
        session.baseTitle = stripped
      }
    }
    const baseTitle = session.baseTitle || stripTitlePrefix(currentTitle) || session.title || "Session"
    const model = this.registry.get(modelRef.providerID, modelRef.id)
    const indicator = this.indicatorFor(sessionID, { ...session, baseTitle })
    const nextTitle = buildIndicatorTitle({
      state: indicator.state,
      provider: modelRef.providerID,
      modelLabel: model?.name ?? modelRef.id,
      baseTitle,
      compact: this.settings.ui.compactMode || this.settings.ui.compact || this.settings.compactMode || this.settings.compact,
    })
    if (currentTitle === nextTitle && session.indicatorTitle === nextTitle) return
    session.baseTitle = baseTitle
    session.indicatorTitle = nextTitle
    session.title = nextTitle
    this.ledger.patchSession(sessionID, {
      baseTitle,
      indicatorTitle: nextTitle,
      title: nextTitle,
    })
    try {
      await this.ctx.session.update({ sessionID, title: nextTitle })
    } catch (error) {
      this.settingsWarnings.push(`Could not update the session title indicator: ${safeError(error)}`)
    }
  }

  private async refreshKnownTitles() {
    const ids = Object.values(this.ledger.data.sessions)
      .filter((session) => this.ownsSession(session))
      .map((session) => session.sessionID)
    await Promise.allSettled(ids.map((sessionID) => this.queueTitle(sessionID)))
  }

  private async restoreTitles() {
    for (const session of Object.values(this.ledger.data.sessions)) {
      if (!this.ownsSession(session)) continue
      const base = session.baseTitle || stripTitlePrefix(session.title)
      if (!base) continue
      try {
        await this.ctx.session.update({ sessionID: session.sessionID, title: base })
        this.ledger.patchSession(session.sessionID, {
          title: base,
          indicatorTitle: undefined,
        })
      } catch (error) {
        this.settingsWarnings.push(`Could not restore session title: ${safeError(error)}`)
      }
    }
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

  private premiumState(session?: SessionState): PremiumState {
    const spent = this.ledger.premiumSpent()
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
          return providerSettings
            ? this.ledger.attachModelQuotas(snapshot, this.registry.all(), providerSettings)
            : snapshot
        })
      : []
  }

  private async ensureContextTokens(sessionID: string) {
    if (this.contextLoaded.has(sessionID)) return
    const existing = this.contextInflight.get(sessionID)
    if (existing) return existing
    const task = (async () => {
      try {
        const messages = unwrap<any>(
          await Promise.race([
            this.ctx.session.context({ sessionID }),
            new Promise((resolve) => setTimeout(() => resolve({ data: [] }), 2_500)),
          ]),
        )
        const assistant = [...messages].reverse().find((message: any) => message?.type === "assistant" && message?.tokens)
        if (assistant?.tokens) {
          const tokens = tokensFrom(assistant.tokens)
          this.sessionState(sessionID)
          this.ledger.patchSession(sessionID, {
            contextTokens: tokens.input + tokens.cache.read + tokens.cache.write,
            cacheReadTokens: tokens.cache.read,
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
    const paused = !this.settings.enabled || this.runtime.paused === true
    const runtime = paused ? "paused" : session?.manualOverride ? "manual" : "automatic"
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
      warnings,
    }
  }

  private async routePrompt(sessionID: string, text: string, files: unknown): Promise<RoutingDecision | undefined> {
    const settings = this.settings
    await this.loadSessionInfo(sessionID)
    const session = this.sessionState(sessionID)
    const runtime = !settings.enabled || this.runtime.paused === true ? "paused" : session.manualOverride ? "manual" : "automatic"
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
        models: this.registry.approved(),
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
      models: this.registry.approved(),
      current: session.lastModel,
      session,
      quota,
      premium,
      contextTokens: session.contextTokens,
      cachedTokens: session.cacheReadTokens,
      dryRun: settings.dryRun,
      modelHistory: this.ledger.snapshotMetrics().byModel,
    })

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
        const blockedTitle = buildIndicatorTitle({
          state: "BLOCKED",
          provider: session.lastModel?.providerID,
          modelLabel: currentRecord?.name ?? session.lastModel?.id,
          baseTitle: session.baseTitle || session.title,
        })
        session.indicatorTitle = blockedTitle
        session.title = blockedTitle
        this.ledger.patchSession(sessionID, { indicatorTitle: blockedTitle, title: blockedTitle })
        try {
          await this.ctx.session.update({ sessionID, title: blockedTitle })
        } catch {
          // The error is still surfaced through the blocked decision.
        }
        void this.notifyChange(
          `${sessionID}:blocked:${task.tier}:${session.lastModel?.providerID}:${session.lastModel?.id}`,
          `BLOCKED · ${currentRecord?.name ?? session.lastModel?.id ?? "current model"} — ${reason}`,
        )
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
        if (this.inflight.has(sessionID)) return
        this.inflight.add(sessionID)
        try {
          await this.routePrompt(sessionID, event.prompt?.text ?? "", event.prompt?.files)
        } catch (error) {
          if (error instanceof RouterBlockedError || (error as any)?.name === "RouterBlockedError") throw error
          this.settingsWarnings.push(`Prompt routing failed: ${safeError(error)}`)
        } finally {
          this.inflight.delete(sessionID)
        }
      }),
    )

    this.registrations.push(
      await this.ctx.session.hook("model.request", (event: any) => {
        if (sharedCore.ownerOf(event.sessionID) !== this.bridgeID) return
        if (event.model?.providerID === "opencode-go") {
          event.headers["x-opencode-session"] = event.headers["x-opencode-session"] ?? event.sessionID
        }
        if (this.settings.privacy.requireZdr && event.model?.providerID === "commandcode") {
          event.headers["x-cmd-zdr"] = "1"
        }
      }),
    )

    this.registrations.push(
      await this.ctx.session.hook("retry", (event: any) => {
        if (sharedCore.ownerOf(event.sessionID) !== this.bridgeID) return
        const session = this.ledger.getSession(event.sessionID)
        const assessment = classifyFailure(
          { type: event.error?.type, message: event.error?.message ?? "", status: event.error?.status },
          session,
        )
        this.ledger.recordFailure(event.sessionID, event.model, assessment.class, event.error?.message ?? "")
        this.ledger.recordRetry(event.sessionID)
        this.persistLedgerSoon()
        if (assessment.class === "auth" || assessment.class === "context_overflow" || assessment.class === "image_rejected") {
          event.decision = { retry: false }
          return
        }
        if (assessment.class === "capability") {
          event.decision = { retry: false }
          return
        }
        if (assessment.class === "rate_limit") {
          event.decision = { retry: true, delay: Math.max(5_000, event.error?.retryAfterMs ?? 15_000) }
          return
        }
        if (assessment.class === "provider_outage" || assessment.class === "network") {
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

  async handleEvent(event: any) {
    const type = event?.type
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
        this.persistLedgerSoon()
      }
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
      }
      this.persistLedgerSoon()
      return
    }
    if (type === "session.step.failed") {
      const sessionID = data.sessionID
      if (typeof sessionID !== "string") return
      const session = this.ledger.getSession(sessionID)
      const assessment = classifyFailure(
        { type: data.error?.type, message: data.error?.message ?? "", status: data.error?.status },
        session,
      )
      this.ledger.recordFailure(sessionID, session?.lastModel, assessment.class, data.error?.message ?? "")
      this.persistLedgerSoon()
      return
    }
    if (type === "session.retry.scheduled") {
      const sessionID = data.sessionID
      if (typeof sessionID === "string") {
        this.ledger.recordRetry(sessionID)
        this.persistLedgerSoon()
      }
    }
  }

  private async registerRpc() {
    const implementation: any = {
      status: async (input: any) => this.statusFor(input?.sessionID),
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
        void this.refreshKnownTitles()
        void this.notifyChange(
          `global:paused:${Boolean(input.paused)}`,
          input.paused ? "PAUSED · automatic routing is paused" : "AUTO · automatic routing resumed",
        )
        const summary = this.statusFor()
        void this.emit("status", { summary })
        return summary
      },
      setDryRun: async (input: any) => {
        this.runtime.dryRun = Boolean(input.dryRun)
        this.persistRuntime()
        void this.refreshKnownTitles()
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
        this.ledger.clearManual(sessionID)
        this.ledger.patchSession(sessionID, { pinnedModel: undefined, paused: false, premiumOneShot: false })
        this.persistLedgerSoon()
        void this.queueTitle(sessionID)
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
        this.runtime.titleIndicator = Boolean(input.enabled)
        this.persistRuntime()
        if (input.enabled) await this.refreshKnownTitles()
        else await this.restoreTitles()
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
        await this.ctx.session.synthetic({ sessionID, text, description: "Smart Router" })
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
          ...status.quota.map(
            (snapshot) =>
              `${snapshot.label}: 5h ${percent(snapshot.rolling.usedPct)} · weekly ${percent(snapshot.weekly.usedPct)} · monthly ${percent(snapshot.monthly.usedPct)} (${snapshot.source})`,
          ),
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
        void this.refreshKnownTitles()
        void this.notifyChange("global:paused:true", "PAUSED · automatic routing is paused")
        await notice(sessionID, "PAUSED · automatic routing is paused.")
      }),
    )

    this.registrations.push(
      await command("router-resume", "Resume automatic routing globally", async ({ sessionID }: any) => {
        this.runtime.paused = false
        this.persistRuntime()
        void this.refreshKnownTitles()
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
      await command("router-dry-run", "Enable or disable dry-run routing: /router-dry-run on|off", async ({ sessionID, prompt }: any) => {
        const value = String(prompt?.text ?? "").trim().split(/\s+/).pop()
        if (value !== "on" && value !== "off") {
          await notice(sessionID, "Usage: /router-dry-run on|off")
          return
        }
        this.runtime.dryRun = value === "on"
        this.persistRuntime()
        void this.refreshKnownTitles()
        void this.notifyChange(
          `global:dry-run:${value === "on"}`,
          value === "on" ? "DRY RUN · decisions will be explained, not applied" : "AUTO · routing will apply decisions",
        )
        await notice(sessionID, value === "on" ? "DRY RUN · decisions will be explained, not applied." : "AUTO · routing will apply decisions.")
      }),
    )

    this.registrations.push(
      await command("router-title", "Turn the persistent session-title indicator on or off: /router-title on|off", async ({ sessionID, prompt }: any) => {
        const value = String(prompt?.text ?? "").trim().split(/\s+/).pop()
        if (value !== "on" && value !== "off") {
          await notice(sessionID, "Usage: /router-title on|off")
          return
        }
        this.runtime.titleIndicator = value === "on"
        this.persistRuntime()
        if (value === "on") await this.refreshKnownTitles()
        else await this.restoreTitles()
        await notice(sessionID, value === "on" ? "Session-title indicator enabled." : "Session-title indicator disabled; base titles restored.")
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
              `  ${candidate.model.providerID}/${candidate.model.modelID}: ${candidate.eligible ? "eligible" : candidate.reason} · ${usd(candidate.effectiveCost)} expected`,
          ),
        ]
        await notice(sessionID, lines.join("\n"))
      }),
    )
  }

  private formatReport() {
    const metrics = this.ledger.snapshotMetrics()
    const modelLines = Object.entries(metrics.byModel)
      .sort((a, b) => b[1].usd - a[1].usd)
      .slice(0, 8)
      .map(([key, value]) => `${key}: ${value.requests} req · ${value.input.toLocaleString()} in · ${value.cacheRead.toLocaleString()} cache · ${value.output.toLocaleString()} out · ${usd(value.usd)}`)
    const latency = metrics.latencySamples > 0 ? `${Math.round(metrics.latencyMsTotal / metrics.latencySamples)} ms avg` : "no samples"
    return [
      `Requests: ${metrics.requests.toLocaleString()}`,
      `Tokens: ${metrics.inputTokens.toLocaleString()} fresh input, ${metrics.cacheReadTokens.toLocaleString()} cache read, ${metrics.outputTokens.toLocaleString()} output`,
      `Estimated allowance value: ${usd(metrics.estimatedUsd)} (provider-reported where available; otherwise local estimate)`,
      `Switches: ${metrics.switches} · escalations: ${metrics.escalations} · prevented premium: ${metrics.preventedPremium} · retries: ${metrics.retries}`,
      `Premium spend: ${usd(metrics.premiumUsd)} across ${metrics.premiumRequests} requests`,
      `Latency: ${latency}`,
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

  async dispose() {
    if (this.cleanupDone) return
    this.cleanupDone = true
    if (this.bridgeID) sharedCore.removeBridge(this.bridgeID)
    await Promise.allSettled(this.registrations.map((registration) => registration?.dispose?.()))
    // Never block a reload on storage. The core flushes on debounce, and the
    // grace timer performs the final flush when the last bridge leaves.
    sharedCore.persistSoon()
  }
}
