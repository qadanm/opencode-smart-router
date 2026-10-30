/**
 * Portable allowance core: public entry point.
 *
 * This module is the part of the router that is useful *without* the router.
 * It answers one question that every coding-agent user now has and that no
 * existing library models:
 *
 * > Given a set of prepaid subscriptions with nested usage windows and
 * > multiple credit pools, how much of each allowance is left, what will it
 * > cost to spend more, and when does it run out?
 *
 * Every mainstream LLM router (`litellm`, `claude-code-router`, `Portkey`,
 * `RouteLLM`) prices a request as `tokens × $/M`. That model assumes
 * pay-as-you-go. Subscriptions broke it: a plan has a five-hour window nested
 * inside a seven-day window nested inside a monthly ceiling, allowances that
 * are metered per model and do not pool, and sometimes two credit pools with
 * different draw rules and different multipliers.
 *
 * Nothing here knows about OpenCode, a plugin API, a specific provider's HTTP
 * surface, or any particular user's tier. That is the point: the same model
 * can serve a Claude Code wrapper, a Codex proxy, or a spreadsheet of your own
 * usage.
 *
 * ## What is deliberately *not* here
 *
 * - **No network access.** This package never probes a provider.
 * - **No credentials.** It consumes token counts and dollar figures that the
 *   caller obtained however they chose.
 * - **No host API.** No plugin hooks, no filesystem, no environment reads.
 * - **No secrets in errors.** Nothing in this surface accepts a secret.
 *
 * The consequence is that the whole module is pure, deterministic and
 * trivially testable, which is what makes it safe to publish.
 *
 * ## Typical use
 *
 * ```ts
 * import { resolvePlan, modelWindowCaps, forecast } from "@qadanm/opencode-smart-router/allowance"
 *
 * const plan = resolvePlan("opencode-go", "go")!
 * const caps = modelWindowCaps(plan, "deepseek-v4.1-flash")
 * // { monthlyUsd: 80, weeklyUsd: 40, fiveHourUsd: 16 }
 *
 * const projection = forecast({
 *   windowMs: 7 * 24 * 60 * 60 * 1000,
 *   now: Date.now(),
 *   spendInWindowUsd: 12.4,
 *   activityStart,
 *   remainingUsd: caps.weeklyUsd,
 *   label: "DeepSeek V4.1 Flash weekly",
 * })
 * // projection.willExhaust === true, projection.exhaustsAt === <timestamp>
 * ```
 */

// ---------------------------------------------------------------------------
// Plan model
// ---------------------------------------------------------------------------

export {
  /** Every plan this build knows about. */
  PLAN_CATALOG,
  /** The OpenDesign models funded from the shared Design Plan allowance. */
  OPENDESIGN_DESIGN_PLAN_MODELS,
  OPENDESIGN_DESIGN_PLAN_POOL,
  OPENDESIGN_PLAN_MODEL_POOL,
  /** Provider defaults, reported as `resolution: "default"`. */
  DEFAULT_PLAN_ID,
  defaultPlanIdFor,
  /** Which pool funds a model, and in what order. */
  fundingPoolFor,
  isEscalationOnlyPool,
  modelMonthlyAllowanceUsd,
  /** The nested window caps for one model, derived from its allowance. */
  modelWindowCaps,
  planById,
  planSummaryLine,
  poolDrawSequence,
  resolvePlan,
  /** Resolve a plan id and report *how* it resolved. */
  resolvePlanWithReason,
  type CreditPoolDefinition,
  type PerModelWindowRule,
  type PlanDefinition,
  type PlanResolution,
  type PoolResetKind,
  type ResolvedPlan,
} from "./core/plans/catalog.js"

// ---------------------------------------------------------------------------
// Context policy
// ---------------------------------------------------------------------------

export {
  CONTEXT_ELIGIBILITY_MARGIN_TOKENS,
  CONTEXT_SAFE_WINDOW_FRACTION,
  /** Decide whether a transcript must be compacted, and why. */
  decideCompaction,
  describeMode,
  /** The window a gateway actually accepts, not the vendor maximum. */
  practicalWindow,
  type CompactionContext,
  type CompactionDecision,
} from "./core/context/strategy.js"

// ---------------------------------------------------------------------------
// Usage accounting and forecasting
// ---------------------------------------------------------------------------

export {
  /** Project consumption from a representative recent window. */
  forecast,
  formatRelative,
  /** Assemble a per-provider report from durable aggregates. */
  buildProviderUsageReport,
  type Forecast,
  type ProviderUsageReport,
  type UsageSource,
  type WindowTotals,
} from "./core/quota/report.js"

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export type {
  ContextManagementMode,
  ContextManagementSettings,
  CreditPoolSnapshot,
  ModelMetrics,
  PeakPricing,
  UsageBucket,
  UsageEvent,
  UsageRollup,
} from "./core/types.js"
