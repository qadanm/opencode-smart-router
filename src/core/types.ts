/**
 * Shared domain types for the router.
 *
 * These types are intentionally provider-neutral. Provider adapters translate
 * live OpenCode and provider metadata into these records.
 */

export type Mode = "efficiency" | "balanced" | "premium"
export type TaskTier = 0 | 1 | 2 | 3
export type RuntimeMode = "automatic" | "manual" | "paused"

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
  readonly designEvidence: "benchmark" | "curated" | "observed" | "unverified"
  readonly premium: boolean
  readonly training: boolean
  readonly free: boolean
  readonly tier: 1 | 2 | 3
  /** False for discovered models that have not been qualified. */
  readonly approved: boolean
  readonly approvalSource: "seed" | "user" | "discovered"
  /** Monthly included usage allowance in US dollars at public list prices. */
  readonly monthlyAllowanceUsd: number
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
  readonly planStatus?: string
  readonly periodStart?: number
  readonly periodEnd?: number
  readonly models: Readonly<Record<string, ModelQuotaSnapshot>>
  readonly notes: ReadonlyArray<string>
  readonly error?: string
  /** Provider-supplied retry delay on a rate-limited probe. */
  readonly retryAfterMs?: number
}

export interface PremiumState {
  readonly mode: "off" | "ask" | "allowed"
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
}

export interface Ledger {
  version: 1
  bootstrappedAt?: number
  bootstrapSource?: string
  usage: UsageEvent[]
  premiumSpend: Array<{ month: string; usd: number }>
  sessions: Record<string, SessionState>
  decisions: RoutingDecision[]
  metrics: Metrics
  updatedAt: number
}

export interface ProviderSettings {
  readonly enabled: boolean
  readonly plan: string
  readonly reserveMonthlyPct: number
  readonly reserveWeeklyPct: number
  readonly reserveFiveHourPct: number
  readonly allowExtraUsage: boolean
  readonly probeUsage: boolean
  readonly monthlyCreditsUsd?: number
  readonly fiveHourCapUsd?: number
  readonly weeklyCapUsd?: number
  /** Optional explicit credential file for a read-only quota probe. */
  readonly credentialPath?: string
}

export interface PrivacySettings {
  readonly allowTrainingModels: boolean
  readonly allowFreeModels: boolean
  readonly requireZdr: boolean
}

export interface PremiumSettings {
  readonly mode: "off" | "ask" | "allowed"
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
}

export interface QuotaSettings {
  readonly probeOpenCodeGo: boolean
  readonly probeCommandCode: boolean
  readonly probeIntervalMinutes: number
  readonly bootstrapSessions: number
  readonly bootstrapDays: number
}

export interface ContextHealthSettings {
  readonly enabled: boolean
  readonly warnAtTokens: number
  readonly recommendAtTokens: number
}

export interface UiSettings {
  /** Prefix the session title with AUTO / MANUAL / PAUSED / DRY RUN and the current model. */
  readonly titleIndicator: boolean
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
  readonly ui: UiSettings
  readonly logging: LoggingSettings
  readonly models: ModelSettings
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
  readonly warnings: ReadonlyArray<string>
}
