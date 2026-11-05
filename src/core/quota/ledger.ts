import type {
  FailureClass,
  Ledger,
  Metrics,
  ModelMetrics,
  ModelQuotaSnapshot,
  ModelRecord,
  ModelRef,
  ProviderQuotaSnapshot,
  ProviderSettings,
  RoutingDecision,
  SessionState,
  UsageBucket,
  UsageEvent,
  UsageRollup,
} from "../types.js"
import { clamp, keyOfRef, modelKey, monthKey, nowId, pct, safeError } from "../util.js"

export const LEDGER_VERSION = 1 as const

/**
 * How many provider-scoped failures in a row, with no successful request in
 * between, before the whole provider is treated as not serving.
 *
 * A transient blip is ridden out by the host's own retry and by the owner
 * saying "continue", because a couple of failures in a row is normal during a
 * gateway hiccup. Only a sustained failure, where every attempt fails and
 * nothing succeeds in between, is an outage worth stepping back from.
 */
export const PROVIDER_DOWN_STREAK = 5

/** How long the provider is held back once it is judged to be down. */
export const PROVIDER_BACKOFF_MS = 3 * 60_000
const MAX_USAGE_EVENTS = 2_000
const MAX_DECISIONS = 120
const MAX_SESSIONS = 250
/**
 * How long raw per-request events are kept before they are folded into hourly
 * buckets. Raw events are what the per-request detail is built from; beyond
 * this horizon the aggregates are all that any consumer needs, and they cost
 * three orders of magnitude less space.
 */
const RAW_EVENT_HORIZON_MS = 48 * 60 * 60 * 1000
/** Retention for the hourly aggregates. 400 days covers a yearly comparison. */
const ROLLUP_RETENTION_MS = 400 * 24 * 60 * 60 * 1000
/** Upper bound on hourly buckets kept in the ledger. */
const MAX_BUCKETS = 400 * 24 * 4
const RETENTION_MS = 40 * 24 * 60 * 60 * 1000
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const MONTH_MS = 30 * 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

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
  quota_exhausted: 0,
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
  timeouts: 0,
})

const emptyModelMetrics = (): ModelMetrics => ({
  requests: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  usd: 0,
  failures: 0,
  outputTokensPerSecond: 0,
  latencyMsTotal: 0,
  latencySamples: 0,
  timeoutFailures: 0,
})

export const emptyLedger = (now = Date.now()): Ledger => ({
  version: LEDGER_VERSION,
  usage: [],
  premiumSpend: [],
  sessions: {},
  decisions: [],
  metrics: emptyMetrics(now),
  cooldowns: {},
  providerCooldowns: {},
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

const asUsageBucket = (value: unknown): UsageBucket | undefined => {
  if (!isRecord(value)) return undefined
  if (typeof value.providerID !== "string" || typeof value.modelID !== "string") return undefined
  const hour = finite(value.hour)
  if (hour <= 0) return undefined
  return {
    hour: Math.floor(hour / HOUR_MS) * HOUR_MS,
    providerID: value.providerID,
    modelID: value.modelID,
    periodID: typeof value.periodID === "string" ? value.periodID : "",
    requests: Math.max(0, finite(value.requests)),
    input: Math.max(0, finite(value.input)),
    output: Math.max(0, finite(value.output)),
    cacheRead: Math.max(0, finite(value.cacheRead)),
    cacheWrite: Math.max(0, finite(value.cacheWrite)),
    usd: Math.max(0, finite(value.usd)),
    failures: Math.max(0, finite(value.failures)),
    latencyMsTotal: Math.max(0, finite(value.latencyMsTotal)),
    latencySamples: Math.max(0, finite(value.latencySamples)),
  }
}

const bucketKeyOf = (bucket: { hour: number; providerID: string; modelID: string; periodID: string }) =>
  `${bucket.hour}:${bucket.providerID}:${bucket.modelID}:${bucket.periodID}`

/**
 * Fold an event into an hourly bucket. `periodID` separates consecutive
 * billing periods, so usage from a previous plan period is never re-read as
 * if it had been spent against the current one's limits.
 */
const foldEventInto = (
  buckets: Map<string, UsageBucket>,
  event: UsageEvent,
  periodID: string,
): void => {
  const hour = Math.floor(event.at / HOUR_MS) * HOUR_MS
  const key = bucketKeyOf({ hour, providerID: event.providerID, modelID: event.modelID, periodID })
  const existing = buckets.get(key)
  if (existing) {
    existing.requests += 1
    existing.input += event.input
    existing.output += event.output
    existing.cacheRead += event.cacheRead
    existing.cacheWrite += event.cacheWrite
    existing.usd += event.usd
    return
  }
  buckets.set(key, {
    hour,
    providerID: event.providerID,
    modelID: event.modelID,
    periodID,
    requests: 1,
    input: event.input,
    output: event.output,
    cacheRead: event.cacheRead,
    cacheWrite: event.cacheWrite,
    usd: event.usd,
    failures: 0,
    latencyMsTotal: 0,
    latencySamples: 0,
  })
}

const asSessionState = (value: unknown): SessionState | undefined => {  if (!isRecord(value) || typeof value.sessionID !== "string") return undefined
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
        outputTokensPerSecond: Math.max(0, finite(entry.outputTokensPerSecond)),
        latencyMsTotal: Math.max(0, finite(entry.latencyMsTotal)),
        latencySamples: Math.max(0, finite(entry.latencySamples)),
        timeoutFailures: Math.max(0, finite(entry.timeoutFailures)),
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
  const providerCooldowns: Record<string, number> = {}
  if (isRecord(value.providerCooldowns)) {
    for (const [key, until] of Object.entries(value.providerCooldowns)) {
      const parsed = finite(until)
      if (parsed > 0) providerCooldowns[key] = parsed
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

  const buckets: UsageBucket[] = []
  const rollupInput = isRecord(value.usageRollup) ? value.usageRollup : undefined
  if (rollupInput && Array.isArray(rollupInput.buckets)) {
    for (const entry of rollupInput.buckets) {
      const bucket = asUsageBucket(entry)
      if (bucket) buckets.push(bucket)
    }
  }

  /**
   * A ledger written before aggregates existed has more raw events than the
   * cap, and truncating it on load would discard exactly the history the
   * aggregates were introduced to keep. Fold the overflow into buckets here so
   * the first load after an upgrade preserves every token.
   */
  let loadTruncated: UsageEvent[] | undefined
  if (usage.length > MAX_USAGE_EVENTS && buckets.length === 0) {
    const byKey = new Map<string, UsageBucket>()
    const overflow = usage.length - MAX_USAGE_EVENTS
    for (const event of usage.slice(0, overflow)) {
      foldEventInto(byKey, event, monthKey(event.at))
    }
    buckets.push(...byKey.values())
    loadTruncated = usage.slice(overflow)
    warnings.push(
      `Folded ${overflow} older usage events into hourly aggregates on load instead of discarding them`,
    )
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
    providerCooldowns,
    usage: loadTruncated ? loadTruncated.slice(-MAX_USAGE_EVENTS) : usage.slice(-MAX_USAGE_EVENTS),
    ...(buckets.length > 0
      ? {
          usageRollup: {
            version: 1 as const,
            buckets,
            recent: usage.slice(-MAX_USAGE_EVENTS),
            updatedAt: finite(rollupInput?.updatedAt, now),
          },
        }
      : {}),
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
      timeouts: Math.max(0, finite(metrics.timeouts)),
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
  /**
   * Consecutive provider-scoped failures with no successful request in
   * between, per provider. A short streak is a transient blip that a retry
   * rides over; a long one means the provider is genuinely not serving.
   * Ephemeral on purpose: it is only meaningful across back-to-back attempts.
   */
  private readonly providerFaultStreak = new Map<string, number>()

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
    const modelMetrics = (this.ledger.metrics.byModel[key] ??= emptyModelMetrics())
    modelMetrics.requests += 1
    modelMetrics.input += event.input
    modelMetrics.output += event.output
    modelMetrics.cacheRead += event.cacheRead
    modelMetrics.cacheWrite += event.cacheWrite
    modelMetrics.usd += event.usd
    if (input.latencyMs !== undefined && Number.isFinite(input.latencyMs) && input.latencyMs > 0) {
      const latency = Math.max(0, input.latencyMs)
      modelMetrics.latencySamples += 1
      modelMetrics.latencyMsTotal += latency
      // Generation speed is the only figure that separates a slow provider
      // from a model that simply reasons for longer: dividing by the tokens
      // actually produced normalizes for reasoning depth.
      if (event.output > 0) {
        const seconds = latency / 1000
        const instant = event.output / Math.max(0.001, seconds)
        // A cumulative mean keeps the metric stable without storing history.
        const previous = modelMetrics.outputTokensPerSecond
        modelMetrics.outputTokensPerSecond = previous > 0 ? previous * 0.7 + instant * 0.3 : instant
      }
    }
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
    options: {
      readonly countAgainstModel?: boolean
      readonly cooldownMs?: number
      readonly providerScoped?: boolean
      /** The gateway refused for capacity reasons; holds back the provider and this endpoint. */
      readonly saturation?: boolean
    } = {},
  ) {
    this.ledger.metrics.failures[failureClass] = (this.ledger.metrics.failures[failureClass] ?? 0) + 1

    // Provider-scoped faults feed the provider streak. A billing-scope fault
    // and a saturated gateway both mean the provider, not the model, is the
    // thing failing, so both count here.
    if ((options.providerScoped || options.saturation) && model) {
      const streak = (this.providerFaultStreak.get(model.providerID) ?? 0) + 1
      this.providerFaultStreak.set(model.providerID, streak)
      if (streak >= PROVIDER_DOWN_STREAK) {
        const until = Date.now() + PROVIDER_BACKOFF_MS
        this.ledger.providerCooldowns = {
          ...(this.ledger.providerCooldowns ?? {}),
          [model.providerID]: Math.max(this.ledger.providerCooldowns?.[model.providerID] ?? 0, until),
        }
      }
    }

    // A billing-scope fault happens in the provider's billing path before any
    // model is selected, so cooling the model that happened to be serving
    // would be arbitrary blame. Stop here and let the streak handle it.
    if (options.providerScoped && !options.saturation && model) {
      const session = this.ensureSession(sessionID)
      session.failures = [...session.failures, { class: failureClass, at: Date.now(), message: safeError(message) }].slice(-12)
      session.updatedAt = Date.now()
      this.touch()
      return
    }

    // A saturated gateway is a different case again: the endpoint really did
    // refuse this request, so it must be held back at once rather than after
    // the provider streak reaches five. But the refusal says nothing about how
    // capable the model is, so it is kept out of the reliability record that
    // drives the success estimate. Holding back and blaming are separate.
    if (options.saturation && model) {
      this.armModelCooldown(model, options.cooldownMs ?? 0, 1)
      const session = this.ensureSession(sessionID)
      session.failures = [...session.failures, { class: failureClass, at: Date.now(), message: safeError(message) }].slice(-12)
      session.updatedAt = Date.now()
      this.touch()
      return
    }

    // Only a provider fault counts against a model's reliability. A user
    // interrupt must never make the router distrust a healthy model.
    if (model && options.countAgainstModel !== false) {
      const key = modelKey(model.providerID, model.id)
      const metrics = (this.ledger.metrics.byModel[key] ??= emptyModelMetrics())
      metrics.failures += 1
      if (failureClass === "context_overflow" || failureClass === "rate_limit") {
        metrics.timeoutFailures += 1
        this.ledger.metrics.timeouts += 1
      }
      if ((options.cooldownMs ?? 0) > 0) {
        // Repeated faults extend the cooldown, so a model that keeps dropping
        // streams is avoided for longer each time.
        this.armModelCooldown(model, options.cooldownMs ?? 0, Math.min(4, (metrics.failures % 4) + 1))
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

  /**
   * Hold one model back from routing without touching its reliability record.
   *
   * These are separate concerns and were previously welded together: a model
   * could only be cooled by also being judged less reliable. A gateway
   * refusing for capacity is proof that this endpoint is not serving, and no
   * evidence at all about how well the model reasons.
   */
  private armModelCooldown(model: ModelRef, cooldownMs: number, strikes: number) {
    if (cooldownMs <= 0) return
    const key = modelKey(model.providerID, model.id)
    const previous = this.ledger.cooldowns?.[key] ?? 0
    const until = Date.now() + cooldownMs * Math.max(1, strikes)
    this.ledger.cooldowns = { ...(this.ledger.cooldowns ?? {}), [key]: Math.max(previous, until) }
  }

  /** Active provider outage backoffs, keyed by provider id. */
  providerCooldowns(): Readonly<Record<string, number>> {
    return this.ledger.providerCooldowns ?? {}
  }

  /**
   * Hold a provider back until a given time because its allowance is spent.
   *
   * Separate from the streak-based backoff in `recordFailure`: a spent
   * allowance is not a fault that might clear in a minute, it is a fact that
   * holds until the window resets. Never shortens an existing cooldown, so a
   * shorter guess cannot undo a longer one.
   */
  exhaustProvider(providerID: string, until: number): void {
    const current = this.ledger.providerCooldowns?.[providerID] ?? 0
    if (until <= current) return
    this.ledger.providerCooldowns = { ...(this.ledger.providerCooldowns ?? {}), [providerID]: until }
  }

  isProviderCoolingDown(providerID: string, now = Date.now()): boolean {
    const until = this.ledger.providerCooldowns?.[providerID]
    return typeof until === "number" && until > now
  }

  /**
   * A successful request proves the provider is serving again, so the
   * consecutive-failure streak starts over.
   */
  recordProviderSuccess(providerID: string) {
    if (this.providerFaultStreak.size > 0) this.providerFaultStreak.delete(providerID)
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

  /**
   * Seed the ledger from OpenCode's own message history.
   *
   * Better than `bootstrap` in three ways, all of which matter for a fixed
   * seven-day window:
   *
   *   - it is per MESSAGE, so each event carries its real timestamp and lands in
   *     the correct window instead of being smeared onto the session's last
   *     update time
   *   - it records the model that actually served each request, not the session's
   *     currently selected model
   *   - it can be re-read, because the database keeps growing and a one-shot
   *     import stops being true the moment a new session runs
   *
   * Rows already present are skipped by id, so re-reading is idempotent.
   */
  importHistory(
    entries: ReadonlyArray<{
      readonly id: string
      readonly at: number
      readonly providerID: string
      readonly modelID: string
      readonly cost: number
      readonly input: number
      readonly output: number
      readonly cacheRead: number
      readonly cacheWrite: number
    }>,
    input: { readonly now?: number; readonly source?: string } = {},
  ): { added: number; skipped: number } {
    const now = input.now ?? Date.now()
    const existing = new Set(this.ledger.usage.map((event) => event.id))
    let added = 0
    let skipped = 0
    for (const entry of entries) {
      const id = `hist:${entry.id}`
      if (existing.has(id)) {
        skipped += 1
        continue
      }
      this.ledger.usage.push({
        id,
        at: Math.min(now, entry.at),
        providerID: entry.providerID,
        modelID: entry.modelID,
        usd: Math.max(0, entry.cost),
        input: Math.max(0, entry.input),
        output: Math.max(0, entry.output),
        cacheRead: Math.max(0, entry.cacheRead),
        cacheWrite: Math.max(0, entry.cacheWrite),
        source: "bootstrap",
      })
      existing.add(id)
      added += 1
    }
    if (added > 0) {
      this.ledger.bootstrappedAt = now
      this.ledger.bootstrapSource =
        input.source ??
        `Imported ${added} messages from OpenCode history, each attributed to the model that actually served it.`
      this.prune(now)
      this.touch()
    }
    return { added, skipped }
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
  /**
   * Usage events over a window, including history that has been folded.
   *
   * This returns the raw event array when no window is given, which is the
   * cheapest thing to do and what callers that only need recent detail want.
   *
   * A windowed call must not return the raw array alone. Once usage overflows
   * the raw cap the oldest events are folded into hourly buckets and leave that
   * array, so a raw-only answer shrinks as history ages. Anything estimating a
   * weekly or monthly allowance from usage would then under-report spend on a
   * busy account, which is the opposite of failing safe: the busier the week,
   * the more the estimate says is left.
   *
   * Buckets are expanded back into synthetic events carrying the hour they
   * belong to. Attribution is per model, so pool assignment still works, but
   * the individual request detail inside a folded hour is gone by design.
   */
  usageEvents(window?: { since: number; until?: number }): ReadonlyArray<UsageEvent> {
    if (!window) return this.ledger.usage
    const { since } = window
    const until = window.until ?? Date.now()
    const raw = this.ledger.usage.filter((event) => event.at >= since && event.at <= until)
    const buckets = this.ledger.usageRollup?.buckets
    if (!buckets || buckets.length === 0) return raw

    const folded: UsageEvent[] = []
    for (const bucket of buckets) {
      if (bucket.hour < since || bucket.hour > until) continue
      folded.push({
        id: `folded_${bucket.hour}_${bucket.providerID}_${bucket.modelID}`,
        at: bucket.hour,
        providerID: bucket.providerID,
        modelID: bucket.modelID,
        usd: bucket.usd,
        input: bucket.input,
        output: bucket.output,
        cacheRead: bucket.cacheRead,
        cacheWrite: bucket.cacheWrite,
        source: "step",
      })
    }
    // A bucket and a raw event never cover the same request: folding removes
    // the event from the raw array as it creates the bucket.
    return [...folded, ...raw].sort((a, b) => a.at - b.at)
  }

  /**
   * Fold aged usage events into hourly buckets instead of discarding them.
   *
   * The previous implementation truncated the event array, so a heavy
   * afternoon silently erased the start of the week and no weekly or monthly
   * forecast was possible. Folding keeps every token accounted for at a tiny
   * fraction of the storage cost.
   */
  private foldUsage(now: number) {
    const rollup: UsageRollup = (this.ledger.usageRollup ??= {
      version: 1,
      buckets: [],
      recent: [],
      updatedAt: now,
    })
    const byKey = new Map<string, UsageBucket>()
    for (const bucket of rollup.buckets) byKey.set(bucketKeyOf(bucket), bucket)

    const rawCutoff = now - RAW_EVENT_HORIZON_MS
    const kept: UsageEvent[] = []
    // When the raw array is above the cap, the oldest events are folded even
    // if they are still inside the horizon. That keeps the in-memory array
    // bounded without losing a single token from the totals.
    const overflow = Math.max(0, this.ledger.usage.length - MAX_USAGE_EVENTS * 0.8)
    let folded = 0
    for (const event of this.ledger.usage) {
      const shouldFold = event.at < rawCutoff || folded < overflow
      if (!shouldFold) {
        kept.push(event)
        continue
      }
      folded += 1
      foldEventInto(byKey, event, this.periodIDFor(event.at))
    }
    this.ledger.usage = kept

    const bucketCutoff = now - ROLLUP_RETENTION_MS
    const buckets = [...byKey.values()].filter((bucket) => bucket.hour >= bucketCutoff)
    buckets.sort((a, b) => a.hour - b.hour)
    rollup.buckets =
      buckets.length > MAX_BUCKETS ? buckets.slice(buckets.length - MAX_BUCKETS) : buckets
    rollup.recent = kept
    rollup.updatedAt = now
  }

  /**
   * Billing period key for an instant.
   *
   * This is a calendar month boundary, which is exact for providers whose
   * allowance resets per billing cycle and a deliberate approximation for
   * providers whose period starts on a subscription anniversary. It exists to
   * keep two *different* billing periods from being summed as one, which is
   * the failure that matters here.
   */
  periodIDFor(at: number): string {
    return monthKey(at)
  }

  /** Totals over an arbitrary window, combining folded buckets and raw events. */
  aggregate(input: {
    providerID?: string
    modelID?: string
    since: number
    until?: number
  }): {
    since: number
    until: number
    requests: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    usd: number
    failures: number
    latencyMsTotal: number
    latencySamples: number
  } {
    const until = input.until ?? Date.now()
    const totals = {
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      usd: 0,
      failures: 0,
      latencyMsTotal: 0,
      latencySamples: 0,
    }
    const matches = (providerID: string, modelID: string) =>
      (!input.providerID || providerID === input.providerID) && (!input.modelID || modelID === input.modelID)

    for (const bucket of this.ledger.usageRollup?.buckets ?? []) {
      if (bucket.hour < input.since || bucket.hour > until) continue
      if (!matches(bucket.providerID, bucket.modelID)) continue
      totals.requests += bucket.requests
      totals.input += bucket.input
      totals.output += bucket.output
      totals.cacheRead += bucket.cacheRead
      totals.cacheWrite += bucket.cacheWrite
      totals.usd += bucket.usd
      totals.failures += bucket.failures
      totals.latencyMsTotal += bucket.latencyMsTotal
      totals.latencySamples += bucket.latencySamples
    }
    for (const event of this.ledger.usage) {
      if (event.at < input.since || event.at > until) continue
      if (!matches(event.providerID, event.modelID)) continue
      totals.requests += 1
      totals.input += event.input
      totals.output += event.output
      totals.cacheRead += event.cacheRead
      totals.cacheWrite += event.cacheWrite
      totals.usd += event.usd
    }
    return { ...totals, since: input.since, until }
  }

  /** Usage grouped by provider and model over a window. */
  usageByModel(input: { since: number; until?: number }): Array<{
    providerID: string
    modelID: string
    requests: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    usd: number
  }> {
    const grouped = new Map<string, {
      providerID: string
      modelID: string
      requests: number
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      usd: number
    }>()
    const until = input.until ?? Date.now()
    const add = (
      providerID: string,
      modelID: string,
      row: { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; usd: number },
    ) => {
      const key = modelKey(providerID, modelID)
      let entry = grouped.get(key)
      if (!entry) {
        entry = {
          providerID,
          modelID,
          requests: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          usd: 0,
        }
        grouped.set(key, entry)
      }
      entry.requests += row.requests
      entry.input += row.input
      entry.output += row.output
      entry.cacheRead += row.cacheRead
      entry.cacheWrite += row.cacheWrite
      entry.usd += row.usd
    }
    for (const bucket of this.ledger.usageRollup?.buckets ?? []) {
      if (bucket.hour < input.since || bucket.hour > until) continue
      add(bucket.providerID, bucket.modelID, bucket)
    }
    for (const event of this.ledger.usage) {
      if (event.at < input.since || event.at > until) continue
      add(event.providerID, event.modelID, { ...event, requests: 1 })
    }
    return [...grouped.values()].sort((a, b) => b.usd - a.usd)
  }

  prune(now = Date.now()) {
    this.foldUsage(now)
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
