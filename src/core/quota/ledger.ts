import type {
  FailureClass,
  Ledger,
  Metrics,
  ModelQuotaSnapshot,
  ModelRecord,
  ModelRef,
  ProviderQuotaSnapshot,
  ProviderSettings,
  RoutingDecision,
  SessionState,
  UsageEvent,
} from "../types.js"
import { clamp, keyOfRef, modelKey, monthKey, nowId, pct, safeError } from "../util.js"

export const LEDGER_VERSION = 1 as const
const MAX_USAGE_EVENTS = 2_000
const MAX_DECISIONS = 120
const MAX_SESSIONS = 250
const RETENTION_MS = 40 * 24 * 60 * 60 * 1000
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const MONTH_MS = 30 * 24 * 60 * 60 * 1000

const emptyFailureCounts = (): Record<FailureClass, number> => ({
  context_overflow: 0,
  rate_limit: 0,
  network: 0,
  auth: 0,
  provider_outage: 0,
  invalid_request: 0,
  image_rejected: 0,
  tool: 0,
  capability: 0,
  interrupted: 0,
  unknown: 0,
})

export const emptyMetrics = (now = Date.now()): Metrics => ({
  startedAt: now,
  requests: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  estimatedUsd: 0,
  switches: 0,
  escalations: 0,
  retries: 0,
  preventedPremium: 0,
  manualOverrides: 0,
  dryRunDecisions: 0,
  premiumRequests: 0,
  premiumUsd: 0,
  latencyMsTotal: 0,
  latencySamples: 0,
  failures: emptyFailureCounts(),
  byModel: {},
})

export const emptyLedger = (now = Date.now()): Ledger => ({
  version: LEDGER_VERSION,
  usage: [],
  premiumSpend: [],
  sessions: {},
  decisions: [],
  metrics: emptyMetrics(now),
  cooldowns: {},
  updatedAt: now,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const finite = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback)

const asModelRef = (value: unknown): ModelRef | undefined => {
  if (!isRecord(value)) return undefined
  if (typeof value.providerID !== "string" || typeof value.id !== "string") return undefined
  return {
    providerID: value.providerID,
    id: value.id,
    ...(typeof value.variant === "string" ? { variant: value.variant } : {}),
  }
}

const asUsageEvent = (value: unknown): UsageEvent | undefined => {
  if (!isRecord(value)) return undefined
  if (typeof value.providerID !== "string" || typeof value.modelID !== "string") return undefined
  return {
    id: typeof value.id === "string" ? value.id : nowId("evt"),
    at: finite(value.at, Date.now()),
    providerID: value.providerID,
    modelID: value.modelID,
    ...(typeof value.sessionID === "string" ? { sessionID: value.sessionID } : {}),
    usd: Math.max(0, finite(value.usd)),
    input: Math.max(0, finite(value.input)),
    output: Math.max(0, finite(value.output)),
    cacheRead: Math.max(0, finite(value.cacheRead)),
    cacheWrite: Math.max(0, finite(value.cacheWrite)),
    source: value.source === "bootstrap" || value.source === "manual" ? value.source : "step",
  }
}

const asSessionState = (value: unknown): SessionState | undefined => {
  if (!isRecord(value) || typeof value.sessionID !== "string") return undefined
  return {
    sessionID: value.sessionID,
    ...(typeof value.parentID === "string" ? { parentID: value.parentID } : {}),
    ...(typeof value.projectID === "string" ? { projectID: value.projectID } : {}),
    ...(typeof value.directory === "string" ? { directory: value.directory } : {}),
    manualOverride: value.manualOverride === true,
    manualModel: asModelRef(value.manualModel),
    pinnedModel: asModelRef(value.pinnedModel),
    premiumOneShot: value.premiumOneShot === true,
    premiumOneShotAt: typeof value.premiumOneShotAt === "number" ? value.premiumOneShotAt : undefined,
    paused: value.paused === true,
    lastModel: asModelRef(value.lastModel),
    lastRoutedModel: asModelRef(value.lastRoutedModel),
    lastDecisionID: typeof value.lastDecisionID === "string" ? value.lastDecisionID : undefined,
    contextTokens: Math.max(0, finite(value.contextTokens)),
    cacheReadTokens: Math.max(0, finite(value.cacheReadTokens)),
    stepCount: Math.max(0, finite(value.stepCount)),
    status: value.status === "busy" || value.status === "idle" ? value.status : "unknown",
    failures: Array.isArray(value.failures)
      ? value.failures
          .filter(isRecord)
          .slice(-12)
          .map((failure) => ({
            class: (typeof failure.class === "string" ? failure.class : "unknown") as FailureClass,
            at: finite(failure.at),
            message: typeof failure.message === "string" ? failure.message.slice(0, 300) : "",
          }))
      : [],
    retries: Math.max(0, finite(value.retries)),
    createdAt: finite(value.createdAt, Date.now()),
    updatedAt: finite(value.updatedAt, Date.now()),
    ...(typeof value.title === "string" ? { title: value.title.slice(0, 200) } : {}),
  }
}

export const hydrateLedger = (value: unknown): { ledger: Ledger; warnings: string[] } => {
  const warnings: string[] = []
  const now = Date.now()
  if (!isRecord(value)) return { ledger: emptyLedger(now), warnings: ["No saved ledger found"] }
  if (value.version !== LEDGER_VERSION) warnings.push("Saved ledger version differs; mixing retained data")

  const metrics = isRecord(value.metrics) ? value.metrics : {}
  const byModel: Metrics["byModel"] = {}
  if (isRecord(metrics.byModel)) {
    for (const [key, entry] of Object.entries(metrics.byModel)) {
      if (!isRecord(entry)) continue
      byModel[key] = {
        requests: Math.max(0, finite(entry.requests)),
        input: Math.max(0, finite(entry.input)),
        output: Math.max(0, finite(entry.output)),
        cacheRead: Math.max(0, finite(entry.cacheRead)),
        cacheWrite: Math.max(0, finite(entry.cacheWrite)),
        usd: Math.max(0, finite(entry.usd)),
        failures: Math.max(0, finite(entry.failures)),
      }
    }
  }

  const cooldowns: Record<string, number> = {}
  if (isRecord(value.cooldowns)) {
    for (const [key, until] of Object.entries(value.cooldowns)) {
      const parsed = finite(until)
      if (parsed > 0) cooldowns[key] = parsed
    }
  }

  const sessions: Record<string, SessionState> = {}
  if (isRecord(value.sessions)) {    for (const entry of Object.values(value.sessions)) {
      const session = asSessionState(entry)
      if (session) sessions[session.sessionID] = session
    }
  }

  const decisions: RoutingDecision[] = []
  if (Array.isArray(value.decisions)) {
    for (const entry of value.decisions) {
      if (isRecord(entry) && typeof entry.id === "string" && typeof entry.at === "number") {
        decisions.push(entry as unknown as RoutingDecision)
      }
    }
  }

  const usage: UsageEvent[] = []
  if (Array.isArray(value.usage)) {
    for (const entry of value.usage) {
      const event = asUsageEvent(entry)
      if (event) usage.push(event)
    }
  }

  const failures = emptyFailureCounts()
  if (isRecord(metrics.failures)) {
    for (const key of Object.keys(failures) as FailureClass[]) {
      failures[key] = Math.max(0, finite(metrics.failures[key]))
    }
  }

  const ledger: Ledger = {
    version: LEDGER_VERSION,
    bootstrappedAt: typeof value.bootstrappedAt === "number" ? value.bootstrappedAt : undefined,
    bootstrapSource: typeof value.bootstrapSource === "string" ? value.bootstrapSource : undefined,
    cooldowns,
    usage: usage.slice(-MAX_USAGE_EVENTS),
    premiumSpend: Array.isArray(value.premiumSpend)
      ? value.premiumSpend
          .filter(isRecord)
          .map((entry) => ({ month: String(entry.month ?? ""), usd: Math.max(0, finite(entry.usd)) }))
          .filter((entry) => entry.month)
      : [],
    sessions,
    decisions: decisions.slice(0, MAX_DECISIONS),
    metrics: {
      startedAt: finite(metrics.startedAt, now),
      requests: Math.max(0, finite(metrics.requests)),
      inputTokens: Math.max(0, finite(metrics.inputTokens)),
      cacheReadTokens: Math.max(0, finite(metrics.cacheReadTokens)),
      cacheWriteTokens: Math.max(0, finite(metrics.cacheWriteTokens)),
      outputTokens: Math.max(0, finite(metrics.outputTokens)),
      estimatedUsd: Math.max(0, finite(metrics.estimatedUsd)),
      switches: Math.max(0, finite(metrics.switches)),
      escalations: Math.max(0, finite(metrics.escalations)),
      retries: Math.max(0, finite(metrics.retries)),
      preventedPremium: Math.max(0, finite(metrics.preventedPremium)),
      manualOverrides: Math.max(0, finite(metrics.manualOverrides)),
      dryRunDecisions: Math.max(0, finite(metrics.dryRunDecisions)),
      premiumRequests: Math.max(0, finite(metrics.premiumRequests)),
      premiumUsd: Math.max(0, finite(metrics.premiumUsd)),
      latencyMsTotal: Math.max(0, finite(metrics.latencyMsTotal)),
      latencySamples: Math.max(0, finite(metrics.latencySamples)),
      lastLatencyMs: typeof metrics.lastLatencyMs === "number" ? metrics.lastLatencyMs : undefined,
      failures,
      byModel,
    },
    updatedAt: now,
  }
  return { ledger, warnings }
}

export interface StepUsage {
  readonly sessionID: string
  readonly model: ModelRef
  readonly cost: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning?: number
    readonly cache: { readonly read: number; readonly write: number }
  }
  readonly at?: number
  readonly latencyMs?: number
  readonly premium?: boolean
}

export interface BootstrapSession {
  readonly id: string
  readonly title?: string
  readonly model?: ModelRef
  readonly cost: number
  readonly tokens?: {
    readonly input: number
    readonly output: number
    readonly cache: { readonly read: number; readonly write: number }
  }
  readonly updatedAt: number
}

export interface ModelUsageTotals {
  readonly monthlyUsd: number
  readonly fiveHourUsd: number
  readonly weeklyUsd: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly requests: number
}

/**
 * Local ledger for observed usage. Provider-reported totals, when available,
 * are kept in the provider snapshot; this ledger supplies per-model estimates
 * and the fallback when a provider has no readable billing endpoint.
 */
export class LedgerStore {
  private ledger: Ledger
  private dirty = false

  constructor(initial?: Ledger) {
    this.ledger = initial ?? emptyLedger()
  }

  static hydrate(value: unknown) {
    return hydrateLedger(value)
  }

  get data(): Readonly<Ledger> {
    return this.ledger
  }

  reset() {
    this.ledger = emptyLedger()
    this.dirty = true
  }

  get dirtyFlag() {
    return this.dirty
  }

  markClean() {
    this.dirty = false
  }

  private touch() {
    this.ledger.updatedAt = Date.now()
    this.dirty = true
  }

  ensureSession(sessionID: string, parentID?: string, title?: string): SessionState {
    const existing = this.ledger.sessions[sessionID]
    if (existing) {
      if (parentID && !existing.parentID) (existing as { parentID?: string }).parentID = parentID
      if (title && !existing.title) existing.title = title
      return existing
    }
    const now = Date.now()
    const session: SessionState = {
      sessionID,
      ...(parentID ? { parentID } : {}),
      manualOverride: false,
      premiumOneShot: false,
      paused: false,
      contextTokens: 0,
      cacheReadTokens: 0,
      stepCount: 0,
      status: "unknown",
      failures: [],
      retries: 0,
      createdAt: now,
      updatedAt: now,
      ...(title ? { title } : {}),
    }
    this.ledger.sessions[sessionID] = session
    this.touch()
    return session
  }

  getSession(sessionID: string): SessionState | undefined {
    return this.ledger.sessions[sessionID]
  }

  patchSession(sessionID: string, patch: Partial<SessionState>): SessionState {
    const session = this.ensureSession(sessionID)
    Object.assign(session, patch, { updatedAt: Date.now() })
    this.touch()
    return session
  }

  setManual(sessionID: string, model: ModelRef) {
    const session = this.ensureSession(sessionID)
    session.manualOverride = true
    session.manualModel = model
    session.updatedAt = Date.now()
    this.ledger.metrics.manualOverrides += 1
    this.touch()
  }

  clearManual(sessionID: string) {
    const session = this.ensureSession(sessionID)
    session.manualOverride = false
    session.manualModel = undefined
    session.updatedAt = Date.now()
    this.touch()
  }

  grantPremiumOneShot(sessionID: string) {
    const session = this.ensureSession(sessionID)
    session.premiumOneShot = true
    session.premiumOneShotAt = Date.now()
    session.updatedAt = Date.now()
    this.touch()
  }

  consumePremiumOneShot(sessionID: string) {
    const session = this.ensureSession(sessionID)
    session.premiumOneShot = false
    session.premiumOneShotAt = undefined
    session.updatedAt = Date.now()
    this.touch()
  }

  premiumSpent(month = monthKey()) {
    return this.ledger.premiumSpend.find((entry) => entry.month === month)?.usd ?? 0
  }

  private addPremiumSpend(usd: number) {
    if (usd <= 0) return
    const month = monthKey()
    const existing = this.ledger.premiumSpend.find((entry) => entry.month === month)
    if (existing) existing.usd += usd
    else this.ledger.premiumSpend.push({ month, usd })
    this.ledger.metrics.premiumUsd += usd
  }

  recordUsage(input: StepUsage) {
    const at = input.at ?? Date.now()
    const event: UsageEvent = {
      id: nowId("use"),
      at,
      providerID: input.model.providerID,
      modelID: input.model.id,
      sessionID: input.sessionID,
      usd: Math.max(0, input.cost),
      input: Math.max(0, input.tokens.input),
      output: Math.max(0, input.tokens.output),
      cacheRead: Math.max(0, input.tokens.cache.read),
      cacheWrite: Math.max(0, input.tokens.cache.write),
      source: "step",
    }
    this.ledger.usage.push(event)
    this.ledger.metrics.requests += 1
    this.ledger.metrics.inputTokens += event.input
    this.ledger.metrics.outputTokens += event.output
    this.ledger.metrics.cacheReadTokens += event.cacheRead
    this.ledger.metrics.cacheWriteTokens += event.cacheWrite
    this.ledger.metrics.estimatedUsd += event.usd
    if (input.premium) this.ledger.metrics.premiumRequests += 1
    if (input.latencyMs !== undefined && Number.isFinite(input.latencyMs)) {
      this.ledger.metrics.latencySamples += 1
      this.ledger.metrics.latencyMsTotal += Math.max(0, input.latencyMs)
      this.ledger.metrics.lastLatencyMs = Math.max(0, input.latencyMs)
    }
    const key = modelKey(input.model.providerID, input.model.id)
    const modelMetrics = (this.ledger.metrics.byModel[key] ??= {
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      usd: 0,
      failures: 0,
    })
    modelMetrics.requests += 1
    modelMetrics.input += event.input
    modelMetrics.output += event.output
    modelMetrics.cacheRead += event.cacheRead
    modelMetrics.cacheWrite += event.cacheWrite
    modelMetrics.usd += event.usd
    if (input.premium) this.addPremiumSpend(event.usd)

    const session = this.ensureSession(input.sessionID)
    session.lastModel = input.model
    session.contextTokens = event.input + event.cacheRead + event.cacheWrite
    session.cacheReadTokens = event.cacheRead
    session.stepCount += 1
    session.updatedAt = at
    this.prune(at)
    this.touch()
  }

  recordDecision(decision: RoutingDecision) {
    this.ledger.decisions.unshift(decision)
    this.ledger.decisions = this.ledger.decisions.slice(0, MAX_DECISIONS)
    if (decision.switched) this.ledger.metrics.switches += 1
    if (decision.dryRun) this.ledger.metrics.dryRunDecisions += 1
    if (decision.needsPremiumApproval) this.ledger.metrics.preventedPremium += 1
    if (decision.chosen?.providerID && decision.chosen) {
      const chosen = decision.candidates.find(
        (candidate) =>
          candidate.model.providerID === decision.chosen?.providerID && candidate.model.modelID === decision.chosen?.id,
      )
      const current = decision.candidates.find(
        (candidate) =>
          candidate.model.providerID === decision.current?.providerID && candidate.model.modelID === decision.current?.id,
      )
      if (chosen && current && chosen.tier > current.tier) this.ledger.metrics.escalations += 1
    }
    const session = this.ensureSession(decision.sessionID)
    session.lastDecisionID = decision.id
    if (decision.chosen) session.lastRoutedModel = decision.chosen
    session.updatedAt = decision.at
    this.touch()
  }

  recordFailure(
    sessionID: string,
    model: ModelRef | undefined,
    failureClass: FailureClass,
    message: string,
    options: { readonly countAgainstModel?: boolean; readonly cooldownMs?: number } = {},
  ) {
    this.ledger.metrics.failures[failureClass] = (this.ledger.metrics.failures[failureClass] ?? 0) + 1
    // Only a provider fault counts against a model's reliability. A user
    // interrupt must never make the router distrust a healthy model.
    if (model && options.countAgainstModel !== false) {
      const key = modelKey(model.providerID, model.id)
      const metrics = (this.ledger.metrics.byModel[key] ??= {
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        usd: 0,
        failures: 0,
      })
      metrics.failures += 1
      const cooldownMs = options.cooldownMs ?? 0
      if (cooldownMs > 0) {
        // Repeated faults extend the cooldown, so a model that keeps dropping
        // streams is avoided for longer each time.
        const previous = this.ledger.cooldowns?.[key] ?? 0
        const strikes = Math.min(4, (metrics.failures % 4) + 1)
        const until = Date.now() + cooldownMs * strikes
        this.ledger.cooldowns = { ...(this.ledger.cooldowns ?? {}), [key]: Math.max(previous, until) }
      }
    }
    const session = this.ensureSession(sessionID)
    session.failures = [...session.failures, { class: failureClass, at: Date.now(), message: safeError(message) }].slice(-12)
    session.updatedAt = Date.now()
    this.touch()
  }

  /** Active failure cooldowns, keyed by model key. */
  cooldowns(): Readonly<Record<string, number>> {
    return this.ledger.cooldowns ?? {}
  }

  isCoolingDown(modelKeyValue: string, now = Date.now()): boolean {
    const until = this.ledger.cooldowns?.[modelKeyValue]
    return typeof until === "number" && until > now
  }

  recordRetry(sessionID: string) {
    this.ledger.metrics.retries += 1
    const session = this.ensureSession(sessionID)
    session.retries += 1
    session.updatedAt = Date.now()
    this.touch()
  }

  bootstrap(sessions: ReadonlyArray<BootstrapSession>, input: { days: number; limit: number; now?: number }) {
    if (this.ledger.bootstrappedAt) return { added: 0, skipped: true }
    const now = input.now ?? Date.now()
    const cutoff = now - input.days * 24 * 60 * 60 * 1000
    const eligible = sessions
      .filter((session) => session.cost > 0 && session.updatedAt >= cutoff && session.model)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, input.limit))

    for (const session of eligible) {
      const model = session.model
      if (!model) continue
      this.ledger.usage.push({
        id: nowId("boot"),
        at: Math.min(now, session.updatedAt),
        providerID: model.providerID,
        modelID: model.id,
        sessionID: session.id,
        usd: Math.max(0, session.cost),
        input: Math.max(0, session.tokens?.input ?? 0),
        output: Math.max(0, session.tokens?.output ?? 0),
        cacheRead: Math.max(0, session.tokens?.cache.read ?? 0),
        cacheWrite: Math.max(0, session.tokens?.cache.write ?? 0),
        source: "bootstrap",
      })
    }

    this.ledger.bootstrappedAt = now
    this.ledger.bootstrapSource = `Recent sessions (${eligible.length}) attributed to each session's selected model; approximate when a session switched models.`
    this.prune(now)
    this.touch()
    return { added: eligible.length, skipped: false }
  }

  totalsForModel(providerID: string, modelID: string, input: { now?: number; periodStart?: number } = {}): ModelUsageTotals {
    const now = input.now ?? Date.now()
    const periodStart = input.periodStart ?? now - MONTH_MS
    const fiveHourCutoff = now - FIVE_HOURS_MS
    const weekCutoff = now - WEEK_MS
    let monthlyUsd = 0
    let fiveHourUsd = 0
    let weeklyUsd = 0
    let inputTokens = 0
    let output = 0
    let cacheRead = 0
    let requests = 0
    for (const event of this.ledger.usage) {
      if (event.providerID !== providerID || event.modelID !== modelID) continue
      if (event.at >= periodStart) {
        monthlyUsd += event.usd
        inputTokens += event.input
        output += event.output
        cacheRead += event.cacheRead
        requests += 1
      }
      if (event.at >= fiveHourCutoff) fiveHourUsd += event.usd
      if (event.at >= weekCutoff) weeklyUsd += event.usd
    }
    return { monthlyUsd, fiveHourUsd, weeklyUsd, input: inputTokens, output, cacheRead, requests }
  }

  modelQuotaSnapshots(
    providerID: string,
    models: ReadonlyArray<ModelRecord>,
    provider: ProviderQuotaSnapshot | undefined,
    settings: ProviderSettings,
    now = Date.now(),
  ): Record<string, ModelQuotaSnapshot> {
    const periodStart = provider?.periodStart ?? (provider?.monthly.resetsAt ? provider.monthly.resetsAt - MONTH_MS : now - MONTH_MS)
    const result: Record<string, ModelQuotaSnapshot> = {}
    for (const model of models) {
      if (model.providerID !== providerID) continue
      const totals = this.totalsForModel(providerID, model.modelID, { now, periodStart })
      const monthlyCap = model.monthlyAllowanceUsd > 0 ? model.monthlyAllowanceUsd : 0
      const fiveHourCap = monthlyCap > 0 ? monthlyCap * 0.2 : 0
      const weeklyCap = monthlyCap > 0 ? monthlyCap * 0.5 : 0
      const monthlyUsedPct = monthlyCap > 0 ? pct(totals.monthlyUsd, monthlyCap) : 0
      const fiveHourUsedPct = fiveHourCap > 0 ? pct(totals.fiveHourUsd, fiveHourCap) : 0
      const weeklyUsedPct = weeklyCap > 0 ? pct(totals.weeklyUsd, weeklyCap) : 0
      let blocked = false
      let blockReason: string | undefined
      if (monthlyCap > 0 && monthlyUsedPct >= 100) {
        blocked = true
        blockReason = "Estimated monthly model allowance exhausted"
      } else if (fiveHourCap > 0 && fiveHourUsedPct >= 100) {
        blocked = true
        blockReason = "Estimated five-hour model allowance exhausted"
      } else if (weeklyCap > 0 && weeklyUsedPct >= 100) {
        blocked = true
        blockReason = "Estimated weekly model allowance exhausted"
      }
      const key = modelKey(providerID, model.modelID)
      result[key] = {
        model: { providerID, modelID: model.modelID },
        monthlyAllowanceUsd: monthlyCap,
        monthlyUsedUsd: totals.monthlyUsd,
        monthlyRemainingUsd: Math.max(0, monthlyCap - totals.monthlyUsd),
        monthlyUsedPct,
        fiveHourUsedUsd: totals.fiveHourUsd,
        fiveHourCapUsd: fiveHourCap,
        fiveHourUsedPct,
        weeklyUsedUsd: totals.weeklyUsd,
        weeklyCapUsd: weeklyCap,
        weeklyUsedPct,
        blocked,
        ...(blockReason ? { blockReason } : {}),
        source: "estimate",
      }
    }
    return result
  }

  attachModelQuotas(
    provider: ProviderQuotaSnapshot,
    models: ReadonlyArray<ModelRecord>,
    settings: ProviderSettings,
    now = Date.now(),
  ): ProviderQuotaSnapshot {
    return {
      ...provider,
      models: this.modelQuotaSnapshots(provider.providerID, models, provider, settings, now),
    }
  }

  snapshotMetrics(): Metrics {
    return structuredClone(this.ledger.metrics)
  }

  /**
   * Raw usage events, used by providers whose allowance must be modelled from
   * local activity rather than read from a provider endpoint.
   */
  usageEvents(): ReadonlyArray<UsageEvent> {
    return this.ledger.usage
  }

  prune(now = Date.now()) {
    const cutoff = now - RETENTION_MS
    if (this.ledger.usage.length > MAX_USAGE_EVENTS * 0.8) {
      this.ledger.usage = this.ledger.usage.filter((event) => event.at >= cutoff).slice(-MAX_USAGE_EVENTS)
    } else {
      this.ledger.usage = this.ledger.usage.filter((event) => event.at >= cutoff)
    }
    if (this.ledger.decisions.length > MAX_DECISIONS) this.ledger.decisions = this.ledger.decisions.slice(0, MAX_DECISIONS)
    const sessions = Object.values(this.ledger.sessions)
    if (sessions.length > MAX_SESSIONS) {
      sessions
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, sessions.length - MAX_SESSIONS)
        .forEach((session) => delete this.ledger.sessions[session.sessionID])
    }
  }

  export(): Ledger {
    this.prune()
    return structuredClone(this.ledger)
  }

  get lastDecision(): RoutingDecision | undefined {
    return this.ledger.decisions[0]
  }

  decisions(limit = 10): RoutingDecision[] {
    return this.ledger.decisions.slice(0, clamp(limit, 1, MAX_DECISIONS))
  }

  modelMetrics(key: string) {
    return this.ledger.metrics.byModel[key]
  }

  sessionModelKey(sessionID: string) {
    return keyOfRef(this.ledger.sessions[sessionID]?.lastModel)
  }
}
