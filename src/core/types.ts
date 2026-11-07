/**
 * Shared domain types for the router.
 *
 * These types are intentionally provider-neutral. Provider adapters translate
 * live OpenCode and provider metadata into these records.
 */

import type { OfflineSettings } from "./offline/mode.js"

export type Mode = "efficiency" | "balanced" | "premium"
export type TaskTier = 0 | 1 | 2 | 3
export type RuntimeMode = "automatic" | "manual" | "paused"

/**
 * How the router treats conversation size.
 *
 * - `native`           never compacts except to avoid a verified overflow.
 * - `conservative`     preserves history; compacts only to prevent overflow.
 * - `budget-optimized` the legacy aggressive strategy: compact early to keep
 *                      a session on the cheapest provider. Kept for small
 *                      plans, metered APIs and small-window models.
 */
export type ContextManagementMode = "native" | "conservative" | "budget-optimized"

export type TaskKind =
  | "deterministic"
  | "mechanical"
  | "feature"
  | "debug"
  | "refactor"
  | "design"
  | "architecture"
  | "security"
  | "test"
  | "docs"
  | "unknown"

export type FailureClass =
  | "context_overflow"
  | "rate_limit"
  | "network"
  | "auth"
  | "provider_outage"
  | "invalid_request"
  | "image_rejected"
  | "tool"
  | "capability"
  | "interrupted"
  /**
   * The provider refused because the account has no allowance left.
   *
   * Distinguished from `auth` (the credential is wrong) and from
   * `rate_limit` (too fast): here the credential is fine and the request is
   * well formed, there is simply no credit. It matters because it is the one
   * reliable signal available for a provider whose quota cannot be read —
   * retrying cannot help, and the provider should be left alone until its
   * window resets.
   */
  | "quota_exhausted"
  /**
   * The provider rejected the request shape itself (an Anthropic-protocol
   * discriminator failure is the observed case) before generating anything.
   * Retrying is useless; the router repairs, or fails the turn over to the
   * next best choice.
   */
  | "prompt_rejected"
  | "unknown"

export interface CostTier {
  readonly input: number
  readonly output: number
  readonly cache: { readonly read: number; readonly write: number }
  readonly tier?: { readonly type: "context"; readonly size: number }
}

export interface PeakPricing {
  /** Multiplier applied to every token rate inside the peak windows. */
  readonly multiplier: number
  /** UTC hour ranges [startHour, endHour); 0-24. */
  readonly windowsUtc: ReadonlyArray<{ readonly startHour: number; readonly endHour: number }>
  /** When true, peak pricing applies Monday-Friday only. */
  readonly weekdaysOnly: boolean
}

export interface ModelRecord {
  readonly key: string
  readonly providerID: string
  readonly modelID: string
  readonly name: string
  readonly context: number
  readonly maxOutput: number
  readonly inputModalities: ReadonlyArray<string>
  readonly outputModalities: ReadonlyArray<string>
  readonly tools: boolean
  readonly cost: ReadonlyArray<CostTier>
  /** Documented time-of-day pricing, when the provider changes rates. */
  readonly peakPricing?: PeakPricing
  /** Curated aggregate coding-intelligence score. Higher is better. */
  readonly intelligence: number
  /** Curated front-end and UX quality score. */
  readonly design: number
  /**
   * Per-kind capability evidence, when measured benchmarks exist. Absent
   * axes are unknown, never zero: an unscored model stays neutral in
   * ranking rather than being treated as incapable.
   */
  readonly capabilities?: {
    /** Agentic coding benchmark, percent. */
    readonly coding?: number
    /** Complex-debugging / automation benchmark, percent. */
    readonly debugging?: number
    /** Long-horizon autonomous-execution benchmark, percent. */
    readonly agentic?: number
    /** Curated architectural-reasoning score, same 0-100 scale. */
    readonly architecture?: number
  }
  readonly designEvidence: "benchmark" | "curated" | "observed" | "unverified"
  /**
   * Credit multiplier applied to this model's usage value. One for every
   * provider that bills in plain USD. OpenDesign uses it to convert the
   * dollar value of model usage into Design Plan credits.
   */
  readonly creditMultiplier?: number
  /** True when the model is funded from a pool reserved for escalation. */
  readonly escalationOnly?: boolean
  readonly premium: boolean
  readonly training: boolean
  readonly free: boolean
  readonly tier: 1 | 2 | 3
  /** False for discovered models that have not been qualified. */
  readonly approved: boolean
  readonly approvalSource: "seed" | "user" | "discovered"
  /** Monthly included usage allowance in US dollars at public list prices. */
  readonly monthlyAllowanceUsd: number
  /**
   * Which wire protocol the provider's serving path speaks. Seeded records
   * may state it; `src/core/models/protocol.ts` otherwise infers it from the
   * model family. Only the Anthropic Messages protocol forces prompt repair.
   */
  readonly protocol?: "anthropic" | "openai-compat"
  readonly notes?: string
}

export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

export interface ModelKey {
  readonly providerID: string
  readonly modelID: string
}

export interface TaskScope {
  readonly files: number
  readonly codeBlocks: number
  readonly longestCodeBlockLines: number
  readonly hasStackTrace: boolean
  readonly hasImage: boolean
  readonly hasScreenshot: boolean
  readonly promptChars: number
  readonly promptTokens: number
}

export interface TaskConstraints {
  /** The user explicitly asked to avoid premium or expensive models. */
  readonly avoidPremium: boolean
  /** The user explicitly asked for the strongest model. */
  readonly requestPremium: boolean
  /** The user explicitly asked for a cheap/economy model. */
  readonly requestEconomy: boolean
}

export interface TaskClass {
  readonly tier: TaskTier
  readonly kind: TaskKind
  readonly requiresVision: boolean
  readonly designIntensive: boolean
  readonly sophisticatedDesign: boolean
  readonly needsLongContext: boolean
  readonly confidence: "low" | "medium" | "high"
  readonly signals: ReadonlyArray<string>
  readonly reasons: ReadonlyArray<string>
  readonly constraints: TaskConstraints
  readonly scope: TaskScope
}

export interface CandidateEvaluation {
  readonly model: ModelKey
  readonly name: string
  readonly tier: 1 | 2 | 3
  readonly eligible: boolean
  readonly reason: string
  readonly estimatedUsd: number
  readonly effectiveCost: number
  readonly successProbability: number
  readonly switchPenaltyUsd: number
  readonly quotaPressure: number
  readonly retained: boolean
  /** Credit multiplier applied to the estimate. One for plain USD providers. */
  readonly creditMultiplier?: number
  /** Multiplier applied for measured generation speed. One when neutral. */
  readonly speedFactor?: number
  /**
   * Multiplier applied to the price because the provider's prepaid allowance is
   * expiring. One when the allowance is fresh money that will be consumed.
   */
  readonly marginalPriceFactor?: number
}

export interface QuotaWindow {
  readonly usedPct: number
  readonly remainingPct: number
  readonly usedUsd?: number
  readonly capUsd?: number
  readonly resetsAt?: number
  readonly exceeded?: boolean
  readonly source: "provider" | "estimate" | "unknown"
}

export interface ModelQuotaSnapshot {
  readonly model: ModelKey
  readonly monthlyAllowanceUsd: number
  readonly monthlyUsedUsd: number
  readonly monthlyRemainingUsd: number
  readonly monthlyUsedPct: number
  readonly fiveHourUsedUsd: number
  readonly fiveHourCapUsd: number
  readonly fiveHourUsedPct: number
  readonly weeklyUsedUsd: number
  readonly weeklyCapUsd: number
  readonly weeklyUsedPct: number
  readonly blocked: boolean
  readonly blockReason?: string
  readonly source: "provider" | "estimate" | "unknown"
}

export interface ExtraCredits {
  readonly purchasedUsd: number
  readonly freeUsd: number
  readonly totalUsd: number
}

/**
 * One funding pool belonging to a plan.
 *
 * Pools are separate allowances. `monthlyUsd` is the pool's own ceiling; the
 * weekly and five-hour values nest inside it and are never added to it. A
 * pool with no window values is metered per billing cycle only.
 */
export interface CreditPoolSnapshot {
  readonly id: string
  readonly label: string
  readonly source: "provider" | "estimate" | "unknown"
  readonly monthlyUsd: number
  readonly usedUsd: number
  readonly remainingUsd: number
  readonly usedPct: number
  readonly weeklyUsd?: number
  readonly weeklyUsedPct?: number
  readonly fiveHourUsd?: number
  readonly fiveHourUsedPct?: number
  readonly resetKind: "billing-cycle" | "fixed-7-day" | "rolling-7-day"
  readonly resetsAt?: number
  readonly note: string
}

export interface ProviderQuotaSnapshot {
  readonly providerID: string
  readonly label: string
  readonly plan: string
  readonly source: "provider" | "estimate" | "unknown"
  readonly fetchedAt: number
  readonly stale: boolean
  readonly rolling: QuotaWindow
  readonly weekly: QuotaWindow
  readonly monthly: QuotaWindow
  readonly monthlyGrantUsd?: number
  readonly monthlyRemainingUsd?: number
  readonly extraCredits?: ExtraCredits
  /** Every funding pool the plan exposes, in draw order. */
  readonly pools?: ReadonlyArray<CreditPoolSnapshot>
  readonly planStatus?: string
  readonly periodStart?: number
  readonly periodEnd?: number
  readonly models: Readonly<Record<string, ModelQuotaSnapshot>>
  readonly notes: ReadonlyArray<string>
  readonly error?: string
  /** Provider-supplied retry delay on a rate-limited probe. */
  readonly retryAfterMs?: number
  /**
   * Explicit confidence state. `provider` and `estimate` map onto `source`;
   * this field also distinguishes an exhausted allowance from an unavailable
   * service, which `source` alone cannot express.
   */
  readonly quotaState?: "verified" | "estimated" | "stale" | "unknown" | "exhausted" | "unavailable"
}

export interface PremiumState {
  readonly mode: "off" | "ask" | "allowed" | "auto"
  readonly monthlyBudgetUsd: number
  readonly spentUsd: number
  readonly remainingUsd: number
  readonly oneShotGranted: boolean
  readonly oneShotGrantedAt?: number
}

export interface RoutingDecision {
  readonly id: string
  readonly at: number
  readonly sessionID: string
  readonly mode: Mode
  readonly dryRun: boolean
  readonly runtime: RuntimeMode
  readonly task: TaskClass
  readonly current?: ModelRef
  readonly chosen?: ModelRef
  readonly switched: boolean
  readonly switchReason: string
  readonly reasons: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
  readonly candidates: ReadonlyArray<CandidateEvaluation>
  readonly premium: PremiumState
  readonly quota: ReadonlyArray<ProviderQuotaSnapshot>
  readonly contextTokens: number
  readonly cachedTokens: number
  readonly estimatedUsd: number
  readonly needsPremiumApproval: boolean
  readonly manualOverride: boolean
  readonly error?: string
  /**
   * Present when the router recovered a deterministic provider rejection for
   * this prompt: which model rejected the request and what happened next.
   */
  readonly selfheal?: { readonly rejected: string; readonly action: string }
}

export interface ModelFailureRecord {
  readonly class: FailureClass
  readonly at: number
  readonly message: string
}

export interface SessionState {
  readonly sessionID: string
  readonly parentID?: string
  readonly projectID?: string
  readonly directory?: string
  manualOverride: boolean
  manualModel?: ModelRef
  pinnedModel?: ModelRef
  premiumOneShot: boolean
  premiumOneShotAt?: number
  paused: boolean
  lastModel?: ModelRef
  lastRoutedModel?: ModelRef
  lastDecisionID?: string
  /** Original user or generated title, without the router status prefix. */
  baseTitle?: string
  /** Last title written by the router, used to avoid update loops. */
  indicatorTitle?: string
  contextTokens: number
  cacheReadTokens: number
  stepCount: number
  status: "idle" | "busy" | "unknown"
  failures: ReadonlyArray<ModelFailureRecord>
  retries: number
  createdAt: number
  updatedAt: number
  title?: string
}

export interface UsageEvent {
  readonly id: string
  readonly at: number
  readonly providerID: string
  readonly modelID: string
  readonly sessionID?: string
  readonly usd: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly source: "step" | "bootstrap" | "manual"
}

export interface ModelMetrics {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  usd: number
  failures: number
  /** Output tokens produced per second of generation, when measurable. */
  outputTokensPerSecond: number
  /** Milliseconds from request start to a completed response, when measurable. */
  latencyMsTotal: number
  latencySamples: number
  timeoutFailures: number
}

export interface Metrics {
  startedAt: number
  requests: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  estimatedUsd: number
  switches: number
  escalations: number
  retries: number
  preventedPremium: number
  manualOverrides: number
  dryRunDecisions: number
  premiumRequests: number
  premiumUsd: number
  latencyMsTotal: number
  latencySamples: number
  lastLatencyMs?: number
  failures: Record<FailureClass, number>
  byModel: Record<string, ModelMetrics>
  /** Request-level latency samples, separate from per-model aggregates. */
  timeouts: number
}

/**
 * A durable per-hour usage bucket.
 *
 * Retaining thousands of raw events in the ledger does not scale: 2,000
 * events covered under seven hours of heavy use, which is useless for weekly
 * or monthly forecasting. Events are folded into these buckets as they age,
 * so long-horizon aggregation costs a bounded number of rows instead of
 * growing without limit, and the totals survive restarts.
 */
export interface UsageBucket {
  /** Hour start, epoch milliseconds, truncated to the hour. */
  readonly hour: number
  readonly providerID: string
  readonly modelID: string
  /** Billing period the bucket belongs to, so plan changes are separable. */
  readonly periodID: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  usd: number
  failures: number
  latencyMsTotal: number
  latencySamples: number
}

export interface UsageRollup {
  readonly version: 1
  buckets: UsageBucket[]
  /** Raw events newer than the fold horizon, retained for exact per-request detail. */
  recent: UsageEvent[]
  updatedAt: number
}

export interface Ledger {
  version: 1
  bootstrappedAt?: number
  bootstrapSource?: string
  usage: UsageEvent[]
  /** Hourly aggregates for anything older than the raw-event horizon. */
  usageRollup?: UsageRollup
  premiumSpend: Array<{ month: string; usd: number }>
  sessions: Record<string, SessionState>
  decisions: RoutingDecision[]
  metrics: Metrics
  /** Model key to the epoch millisecond when its failure cooldown ends. */
  cooldowns?: Record<string, number>
  /** Provider id to the epoch millisecond when its outage backoff ends. */
  providerCooldowns?: Record<string, number>
  updatedAt: number
}

export interface ProviderSettings {
  readonly enabled: boolean
  /**
   * Plan identifier resolved against the plan catalog. A plan is described as
   * data, so a different user's tier needs no code change.
   */
  readonly plan: string
  readonly reserveMonthlyPct: number
  readonly reserveWeeklyPct: number
  readonly reserveFiveHourPct: number
  readonly allowExtraUsage: boolean
  readonly probeUsage: boolean
  /**
   * Explicit caps. Each overrides the plan catalog value when set, which is
   * how a user can correct a stale catalog entry without a code change.
   */
  readonly monthlyCreditsUsd?: number
  readonly fiveHourCapUsd?: number
  readonly weeklyCapUsd?: number
  /**
   * When set, every pool is treated as having no window ceiling of the given
   * kind, regardless of what the catalog says. Used to model a plan that has
   * advertised the removal of a window.
   */
  readonly ignoreFiveHourWindow?: boolean
  readonly ignoreWeeklyWindow?: boolean
  /** Optional explicit credential file for a read-only quota probe. */
  readonly credentialPath?: string
  /**
   * A reading of the account's own usage, supplied by the user, that the router
   * adds its own traffic to.
   *
   * This exists because OpenDesign publishes no quota endpoint for an inference
   * key and the router refuses to scrape a browser session. Without a control
   * key the best available number was "traffic this router routed", which
   * under-reports badly on any account that was used before the router was
   * installed — one user saw 5% while the account was 42% used.
   *
   * A baseline is not a guess: it is a figure the user read off their own
   * account, with the time they read it. The router labels the result as
   * "reported by your account at <time> plus this router's traffic" and drops it
   * once the relevant window has reset, because a stale reading inside a fresh
   * window would be a new lie in the other direction.
   */
  readonly baseline?: {
    /** Epoch ms when the user read these figures. */
    readonly at: number
    /** Design Plan credits used at that moment, in USD-equivalent. */
    readonly designPlanUsedUsd?: number
    /**
     * Design Plan credits used at that moment, as the percentage the account
     * page displays.
     *
     * The page shows a percentage, not dollars, so asking for a dollar figure
     * asks the user to do conversion arithmetic against a cap they may not know.
     * Taking the percentage and converting it here removes that step and the
     * mistake it invites — reading "42%" as 42% of the month when the page means
     * 42% of the week overstates usage fourfold.
     */
    readonly designPlanUsedPct?: number
    /** Plan model credits used at that moment, as the percentage shown. */
    readonly planModelsUsedPct?: number
    /**
     * Which window a supplied percentage refers to. Defaults to `weekly`,
     * because that is the window OpenDesign's account page reports.
     */
    readonly pctOf?: "weekly" | "monthly"
    /** Plan model credits used at that moment, in USD-equivalent. */
    readonly planModelsUsedUsd?: number
    /**
     * When the seven-day window resets, if the account page showed it.
     *
     * Without it the router has to guess, and the guess is wrong in a way that
     * matters: "the reading is younger than seven days" is not the same as "the
     * window has not reset". A weekly window can reset an hour after you read
     * the page, after which your 42% describes a window that no longer exists
     * and seeding it into the new one overstates usage.
     */
    readonly weeklyResetsAt?: number
    /** When the monthly allowance resets, if the account page showed it. */
    readonly monthlyResetsAt?: number
    /** Where the reading came from, for display. Defaults to the account page. */
    readonly source?: string
  }
  /**
   * Whether the router may read well-known credential files without being
   * told exactly where. `explicit` (the default) reads only configured paths
   * and the environment; `auto` also scans the provider's own files; `off`
   * reads nothing from disk.
   *
   * The default is deliberately conservative: automatically harvesting
   * secrets from predictable paths is not something a router should do
   * without the operator saying so.
   */
  readonly credentialSource?: "explicit" | "auto" | "off"
  /**
   * Gateway base URL. Only providers with a configurable endpoint use it.
   * OpenDesign accepts the OpenAI-compatible gateway root; a path that
   * already contains the version is never extended again.
   */
  readonly baseURL?: string
  /** Account-control base URL, used only for an explicitly supplied control key. */
  readonly controlBaseURL?: string
  /** Optional explicit file holding an account-control key. */
  readonly controlKeyPath?: string
  /**
   * Refuse to route when the subscription allowance is exhausted, so the
   * gateway cannot fall back to purchased wallet balance.
   */
  readonly subscriptionOnly?: boolean
  /** Credits per USD, when the provider denominates its allowance in credits. */
  readonly creditsPerUsd?: number
  /** Safety margin applied to locally estimated usage, in percent. */
  readonly uncertaintyMarginPct?: number
  /** What to do when the provider's quota state cannot be established. */
  readonly unknownQuotaPolicy?: "route" | "block" | "ask"
  /** Explicit per-model credit multiplier overrides. */
  readonly multiplierOverrides?: Readonly<Record<string, number>>
  /**
   * True when the provider's allowance is one shared pool rather than a
   * per-model allowance. Per-model quota snapshots are skipped in that case,
   * because they would count the same pool more than once.
   */
  readonly providerScopedQuota?: boolean
}

export interface PrivacySettings {
  readonly allowTrainingModels: boolean
  readonly allowFreeModels: boolean
  readonly requireZdr: boolean
}

export interface PremiumSettings {
  readonly mode: "off" | "ask" | "allowed" | "auto"
  readonly monthlyBudgetUsd: number
  readonly oneShotApproval: boolean
}

export interface RoutingSettings {
  readonly intelligenceFloor: number
  readonly designFloor: number
  readonly sophisticatedDesignFloor: number
  readonly switchHysteresisPct: number
  readonly largeContextTokens: number
  readonly largeContextHysteresisPct: number
  readonly maxEscalationsPerTask: number
  readonly preferSameProvider: boolean
  /** Reject a prompt when the current model is unqualified and no eligible route exists. */
  readonly failClosed: boolean
  /**
   * Refuse to route a task to a model funded from a pool reserved for
   * escalation while a design-plan-funded model can serve it. This keeps a
   * plan-model pool from being drained by routine work.
   */
  readonly protectEscalationPool: boolean
  /** Minimum model window considered adequate when a task needs long context. */
  readonly longContextFloorTokens: number
  /**
   * Derive the intelligence floor from recorded spend instead of trusting the
   * hand-picked `intelligenceFloor`.
   *
   * The configured floor remains the ceiling: calibration may only lower it.
   * This is opt-in because it changes which model serves real work, and a
   * router that silently re-derives its own quality gate on upgrade would be
   * surprising.
   */
  readonly calibrateFloor?: boolean
}

export interface QuotaSettings {
  readonly probeOpenCodeGo: boolean
  readonly probeCommandCode: boolean
  readonly probeOpenDesign: boolean
  readonly probeIntervalMinutes: number
  readonly bootstrapSessions: number
  readonly bootstrapDays: number
}

export interface ContextHealthSettings {
  readonly enabled: boolean
  readonly warnAtTokens: number
  readonly recommendAtTokens: number
}

/**
 * Router-driven context management.
 *
 * `compactAtTokens` is only consulted in `budget-optimized` mode. It exists so
 * a budget-conscious user can set an explicit early threshold; it is
 * deliberately ignored in the other two modes so a leftover value from an old
 * configuration can never reintroduce eager compaction.
 */
export interface ContextManagementSettings {
  readonly mode: ContextManagementMode
  readonly enabled: boolean
  readonly compactAtTokens: number
  /** Minimum time between router-initiated compactions for one session. */
  readonly cooldownMinutes: number
  /**
   * When `native` mode hits the verified window, allow one emergency
   * compaction rather than failing the turn. Disabling it means the host's own
   * handling is the only recovery.
   */
  readonly allowEmergencyCompaction: boolean
}

/** Measured-speed awareness in routing. */
export interface SpeedSettings {
  readonly enabled: boolean
  /**
   * How much a slow route is penalised relative to the fastest eligible one.
   * Zero treats speed as irrelevant; one doubles the effective cost of a
   * route that is twice as slow as the fastest.
   */
  readonly weightPct: number
  /** Samples required before measured speed is trusted over a neutral prior. */
  readonly minSamples: number
  /** A route slower than this multiple of the fastest is heavily penalised. */
  readonly slowRouteMultiple: number
}

export interface UiSettings {
  /** Send a native macOS notification when the provider or model changes. */
  readonly notifications: boolean
  /** Use a shorter, denser indicator title and UI chrome (compact mode). */
  readonly compactMode: boolean
  /** Alias for compactMode. */
  readonly compact: boolean
}

export interface LoggingSettings {
  readonly storePromptText: boolean
  readonly decisionLogSize: number
  readonly diagnostics: boolean
}

export interface ModelDefinition {
  readonly key: string
  readonly providerID: string
  readonly modelID: string
  readonly name: string
  readonly context: number
  readonly maxOutput: number
  readonly input: ReadonlyArray<string>
  readonly cost: ReadonlyArray<CostTier>
  readonly intelligence: number
  readonly design: number
  readonly premium?: boolean
  readonly training?: boolean
  readonly free?: boolean
  readonly tier: 1 | 2 | 3
  readonly approved?: boolean
  readonly monthlyAllowanceUsd: number
}

export interface ModelSettings {
  readonly approved: ReadonlyArray<string>
  readonly excluded: ReadonlyArray<string>
  readonly tierOverrides: Readonly<Record<string, 1 | 2 | 3>>
  /** User-defined metadata for qualifying models that are not in the seed. */
  readonly definitions: ReadonlyArray<ModelDefinition>
}

export interface RouterSettings {
  readonly enabled: boolean
  readonly mode: Mode
  readonly dryRun: boolean
  /** Top-level alias for ui.compactMode (compact mode toggle). */
  readonly compactMode?: boolean
  /** Top-level alias for ui.compactMode (compact mode toggle). */
  readonly compact?: boolean
  readonly providers: Readonly<Record<string, ProviderSettings>>
  readonly privacy: PrivacySettings
  readonly premium: PremiumSettings
  readonly routing: RoutingSettings
  readonly quota: QuotaSettings
  readonly contextHealth: ContextHealthSettings
  readonly contextManagement: ContextManagementSettings
  readonly speed: SpeedSettings
  readonly ui: UiSettings
  readonly logging: LoggingSettings
  readonly models: ModelSettings
  /**
   * Offline development mode. Absent means the defaults, which keep it off.
   *
   * This is a separate top-level block rather than a field inside `routing`
   * so that enabling offline mode cannot alter a single online routing value.
   */
  readonly offline?: OfflineSettings
}

export interface ContextHealth {
  readonly tokens: number
  readonly cacheRead: number
  readonly cacheSharePct: number
  readonly state: "healthy" | "watch" | "recommend_new_session"
  readonly message: string
}

export interface RouterStatus {
  readonly enabled: boolean
  readonly mode: Mode
  readonly runtime: RuntimeMode
  readonly dryRun: boolean
  readonly sessionID?: string
  readonly current?: ModelRef
  readonly currentTier?: 1 | 2 | 3
  readonly manualOverride: boolean
  readonly pinnedModel?: ModelRef
  readonly premium: PremiumState
  readonly quota: ReadonlyArray<ProviderQuotaSnapshot>
  readonly context: ContextHealth
  readonly indicator: {
    readonly state: "AUTO" | "MANUAL" | "PAUSED" | "DRY RUN" | "BLOCKED"
    readonly title?: string
    readonly provider?: string
    readonly model?: string
    readonly modelLabel?: string
  }
  readonly lastDecision?: RoutingDecision
  readonly lastDecisions: ReadonlyArray<RoutingDecision>
  readonly metrics: Metrics
  readonly approvedModels: ReadonlyArray<{
    key: string
    tier: 1 | 2 | 3
    name: string
    intelligence: number
    design: number
    vision: boolean
    premium: boolean
  }>
  /**
   * Every model in the catalog, with the facts a routing decision turns on.
   *
   * The panel needs to answer "why is this model not being used" without the
   * user reading the source. That means carrying approval and exclusion, not
   * just the approved subset, plus the cost and window that drove the ranking.
   */
  readonly models: ReadonlyArray<{
    readonly key: string
    readonly providerID: string
    readonly name: string
    readonly tier: 1 | 2 | 3
    readonly intelligence: number
    readonly design: number
    readonly vision: boolean
    readonly premium: boolean
    readonly context: number
    readonly costInput: number
    readonly costOutput: number
    readonly approved: boolean
    readonly excluded: boolean
    /** Why it is not approved, when that is a decision rather than a gap. */
    readonly approvalNote?: string
  }>
  readonly warnings: ReadonlyArray<string>
}
