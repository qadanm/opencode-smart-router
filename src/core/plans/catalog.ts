/**
 * Subscription plan definitions.
 *
 * A plan is a set of credit pools plus the window rules that apply to each
 * pool. Nothing in this file describes a router policy: it is the published
 * shape of a subscription, so a different user with a different plan can be
 * described without touching routing code.
 *
 * The distinction that matters most, and that the old Go-only model could not
 * express, is that a plan may fund usage from more than one pool:
 *
 *  - a pool with window limits (a five-hour and/or seven-day ceiling nested
 *    inside a monthly maximum), and
 *  - a pool with no windows at all that resets once per billing cycle.
 *
 * They are separate allowances, not one interchangeable pot of money. Adding
 * them together would overstate what can be spent inside a seven-day window,
 * and spending the second pool drains the capacity reserved for escalation.
 *
 * Sources (retrieved 2026-10-29):
 *  - https://open-design.ai/model-credits/
 *  - https://open-design.ai/pricing/
 *  - https://opencode.ai/v2/docs/console/go/
 *  - Command Code account endpoints (read live by the quota adapter)
 */

/**
 * How a pool's window resets.
 *
 * `fixed-7-day` is not `rolling-7-day`, and the difference is not cosmetic.
 * OpenDesign documents that the seven-day window "starts when the subscription
 * begins and resets every 7 days" — subscribe Wednesday at 10:00 and it resets
 * the following Wednesday at 10:00. A rolling window would instead slide
 * continuously, so a request made today would still count tomorrow, and the
 * router would under-report headroom for most of the week.
 */
export type PoolResetKind = "billing-cycle" | "fixed-7-day" | "rolling-7-day"

export interface CreditPoolDefinition {
  readonly id: string
  readonly label: string
  /** Maximum credits per billing cycle, in USD-equivalent credits. */
  readonly monthlyUsd: number
  /** Ceiling inside a rolling seven-day window. Nested, never additional. */
  readonly weeklyUsd?: number
  /** Ceiling inside a rolling five-hour window. Nested, never additional. */
  readonly fiveHourUsd?: number
  /** Promotional credits included in `monthlyUsd`, reported separately. */
  readonly bonusUsd?: number
  readonly resetKind: PoolResetKind
  /**
   * Draw order. Lower numbers are consumed first. Two pools may share a
   * number only when they are genuinely interchangeable, which the catalog
   * never does.
   */
  readonly drawOrder: number
  readonly note: string
}

export interface PerModelWindowRule {
  /** Five-hour ceiling as a percentage of that model's monthly allowance. */
  readonly fiveHourPct: number
  /** Seven-day ceiling as a percentage of that model's monthly allowance. */
  readonly weeklyPct: number
}

export interface PlanDefinition {
  readonly providerID: string
  readonly planID: string
  readonly label: string
  /** Regular monthly subscription price in USD. Never a credit amount. */
  readonly monthlyPriceUsd: number
  readonly pools: ReadonlyArray<CreditPoolDefinition>
  /**
   * Monthly allowance per model, in USD-equivalent credits, for providers
   * whose allowance is metered per model rather than as one shared pool.
   */
  readonly perModelMonthlyUsd?: Readonly<Record<string, number>>
  /** Applied to each per-model allowance to derive its nested windows. */
  readonly perModelWindowRule?: PerModelWindowRule
  readonly concurrency?: number
  readonly notes: ReadonlyArray<string>
}

/**
 * The OpenDesign models funded from the shared Design Plan allowance.
 *
 * Everything the plan also serves that is not in this set draws from plan
 * model credits directly. That pool is the escalation budget, so routing must
 * never treat the two as one balance.
 */
export const OPENDESIGN_DESIGN_PLAN_MODELS: ReadonlySet<string> = new Set([
  "deepseek-v4.1-flash",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "hy4-preview",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro",
  "glm-5.3-flash",
  "kimi-k2.7-code",
  "claude-haiku-5.5",
  "glm-5.3-flashx",
  "gpt-6-luna",
  // The gateway serves MiniMax M3.1 Flash both inside and outside the Design
  // Plan group, and OpenDesign has not published which applies (see the model
  // note). Treated as Design Plan: it is an ordinary tier-2 workhorse, and
  // misclassifying it the other way would let a routine model drain the
  // escalation pool.
  "minimax-m3.1-flash",
])

export const OPENDESIGN_DESIGN_PLAN_POOL = "design-plan"
export const OPENDESIGN_PLAN_MODEL_POOL = "plan-models"

const opendesign = (
  planID: string,
  label: string,
  monthlyPriceUsd: number,
  designPlanMonthlyUsd: number,
  planModelMonthlyUsd: number,
  weeklyUsd: number | undefined,
  fiveHourUsd: number | undefined,
  concurrency: number,
  extraNotes: ReadonlyArray<string> = [],
): PlanDefinition => {
  const pools: CreditPoolDefinition[] = []
  if (designPlanMonthlyUsd > 0) {
    pools.push({
      id: OPENDESIGN_DESIGN_PLAN_POOL,
      label: "Design Plan credits",
      monthlyUsd: designPlanMonthlyUsd,
      ...(weeklyUsd !== undefined ? { weeklyUsd } : {}),
      ...(fiveHourUsd !== undefined ? { fiveHourUsd } : {}),
      resetKind: "fixed-7-day",
      drawOrder: 1,
      note:
        fiveHourUsd === undefined
          ? "Seven-day ceiling nested inside the monthly maximum. Used before plan model credits."
          : "Five-hour and seven-day ceilings nested inside the monthly maximum. Used before plan model credits.",
    })
  }
  if (planModelMonthlyUsd > 0) {
    pools.push({
      id: OPENDESIGN_PLAN_MODEL_POOL,
      label: "Plan model credits",
      monthlyUsd: planModelMonthlyUsd,
      resetKind: "billing-cycle",
      drawOrder: 2,
      note:
        "No five-hour or seven-day window. Funds plan models directly, and Design Plan models once their own credits are exhausted. Design Plan multipliers do not carry over to this pool.",
    })
  }
  return {
    providerID: "opendesign",
    planID,
    label,
    monthlyPriceUsd,
    pools,
    ...(concurrency > 0 ? { concurrency } : {}),
    notes: [
      "Credits are not cash and are not a fixed request count.",
      "Design Plan credits and plan model credits are separate pools, but they do spill: on Plus, Pro and Max, Design Plan usage draws from plan model credits once the Design Plan allowance is spent. Go has no plan model credits, so a spent window means waiting for the reset.",
      "The seven-day Design Plan window starts when the subscription starts and repeats every seven days. It is not a rolling window and does not align to Monday or the first of the month.",
      "Plan model credits have no five-hour or seven-day window; they are granted and reset per billing cycle.",
      "Unused subscription credits do not roll over.",
      ...extraNotes,
    ],
  }
}

/**
 * OpenDesign publishes four tiers. Only the shape differs between them, so
 * each is described as data rather than as a branch in the quota adapter.
 */
const OPENDESIGN_PLANS: ReadonlyArray<PlanDefinition> = [
  opendesign("go", "OpenDesign Go", 10, 120, 0, 30, 10, 10, [
    "Go includes Design Plan credits only and no plan model credits.",
  ]),
  // The seven-day Design Plan ceiling for Plus is $40, not "no cap". It was
  // undefined here, which made Plus look like it could spend the whole $160 in
  // one week — understating the real limit by 4x for anyone on that tier.
  opendesign("plus", "OpenDesign Plus", 20, 160, 20, 40, undefined, 20, [
    "Plus has a seven-day Design Plan window and no five-hour window.",
  ]),
  opendesign("pro", "OpenDesign Pro", 100, 360, 120, 90, undefined, 30, [
    "Pro has a seven-day Design Plan window and no five-hour window.",
    "The $120 plan model pool currently carries a limited-time promotional bonus and resets per billing cycle.",
  ]),
  opendesign("max", "OpenDesign Max", 200, 600, 300, 150, undefined, 30, [
    "Max has a seven-day Design Plan window and no five-hour window.",
  ]),
]

/**
 * OpenCode Go per-model monthly allowances.
 *
 * Each model has its own monthly dollar allowance; the five-hour ceiling is
 * 20% of that model's monthly figure and the weekly ceiling is 50%. The
 * windows nest inside the monthly figure, so they are never added to it.
 */
const GO_MODEL_ALLOWANCES: Readonly<Record<string, number>> = {
  "deepseek-v4.1-flash": 80,
  "deepseek-v4-pro": 15,
  "glm-5.3-flash": 60,
  "glm-5.3": 15,
  "glm-5.2": 60,
  "minimax-m3.1-flash": 20,
  "mimo-v2.6-flash": 60,
  "mimo-v2.6-pro": 15,
  "claude-haiku-5-5": 15,
  "gpt-6-luna": 15,
  "gpt-6-luna-high": 15,
  "kimi-k3": 15,
  "kimi-k3.1-pro": 15,
  "kimi-k2.7-code": 60,
  "grok-4.7": 15,
  "qwen3.8-max": 15,
  "qwen3.8-flash": 30,
  "step-5-preview": 15,
  "longcat-2.0": 60,
  hy3: 60,
  "hy4-preview": 30,
  "gemini-4-argon": 30,
}

const GO_PLUS_MODEL_ALLOWANCES: Readonly<Record<string, number>> = {
  "deepseek-v4.1-flash": 160,
  "deepseek-v4-pro": 60,
  "glm-5.3-flash": 180,
  "glm-5.3": 120,
  "glm-5.2": 180,
  "minimax-m3.1-flash": 80,
  "mimo-v2.6-flash": 120,
  "mimo-v2.6-pro": 60,
  "claude-haiku-5-5": 60,
  "gpt-6-luna": 60,
  "kimi-k3": 60,
  "kimi-k3.1-pro": 60,
  "kimi-k2.7-code": 180,
  "grok-4.7": 60,
  "qwen3.8-max": 60,
  "qwen3.8-flash": 90,
  "step-5-preview": 60,
  "longcat-2.0": 240,
  hy3: 240,
  "hy4-preview": 120,
  "gemini-4-argon": 120,
}

const openCodeGoPlan = (
  planID: string,
  label: string,
  monthlyPriceUsd: number,
  allowances: Readonly<Record<string, number>>,
): PlanDefinition => ({
  providerID: "opencode-go",
  planID,
  label,
  monthlyPriceUsd,
  pools: [
    {
      id: "per-model",
      label: "Per-model monthly allowances",
      // There is no shared pool; the monthly total is the sum of the
      // per-model ceilings for reporting only.
      monthlyUsd: Object.values(allowances).reduce((sum, value) => sum + value, 0),
      resetKind: "billing-cycle",
      drawOrder: 1,
      note:
        "Each model has its own monthly dollar allowance. The five-hour and weekly ceilings are percentages of that model's allowance, not separate credit.",
    },
  ],
  perModelMonthlyUsd: allowances,
  perModelWindowRule: { fiveHourPct: 20, weeklyPct: 50 },
  notes: [
    "Allowances are per model and do not pool across models.",
    "Token prices are identical on Go, Go Plus and Go Teams; only the allowances differ.",
  ],
})

/**
 * Command Code GOAT. The quota adapter reads the authoritative caps live from
 * the account endpoints, so these values are the documented fallback only.
 */
const COMMANDCODE_PLANS: ReadonlyArray<PlanDefinition> = [
  {
    providerID: "commandcode",
    planID: "goat",
    label: "Command Code GOAT",
    monthlyPriceUsd: 10,
    pools: [
      {
        id: "monthly",
        label: "GOAT monthly credits",
        monthlyUsd: 70,
        weeklyUsd: 35,
        fiveHourUsd: 14,
        resetKind: "billing-cycle",
        drawOrder: 1,
        note: "One shared pool with five-hour and weekly ceilings nested inside the monthly maximum.",
      },
    ],
    notes: ["Read from Command Code's read-only account endpoints; the account response is authoritative."],
  },
]

export const PLAN_CATALOG: ReadonlyArray<PlanDefinition> = [
  ...OPENDESIGN_PLANS,
  openCodeGoPlan("go", "OpenCode Go", 10, GO_MODEL_ALLOWANCES),
  openCodeGoPlan("go-plus", "OpenCode Go Plus", 40, GO_PLUS_MODEL_ALLOWANCES),
  ...COMMANDCODE_PLANS,
]

const PLAN_BY_KEY: ReadonlyMap<string, PlanDefinition> = new Map(
  PLAN_CATALOG.map((plan) => [`${plan.providerID}/${plan.planID}`, plan]),
)

/**
 * The plan each provider assumes when settings name nothing usable.
 *
 * These are *fallbacks*, not recommendations. Every one of them is reported as
 * `resolution: "default"` so a caller can warn that an assumption was made
 * rather than silently pretending the user configured that tier.
 */
export const DEFAULT_PLAN_ID: Readonly<Record<string, string>> = {
  opendesign: "pro",
  "opencode-go": "go",
  commandcode: "goat",
}

/** The catalog default plan for a provider, if the provider is described. */
export const defaultPlanIdFor = (providerID: string): string | undefined => DEFAULT_PLAN_ID[providerID]

/**
 * Providers whose plan IDs are aliases the router still encounters in older
 * configuration files. Mapping them keeps an old config from silently
 * describing a plan the user no longer has.
 */
const PLAN_ALIASES: Readonly<Record<string, string>> = {
  "opendesign/go-plus": "plus",
  "opendesign/max-plan": "max",
  "opencode-go/goplus": "go-plus",
  "opencode-go/go+": "go-plus",
}

/**
 * How a plan id was resolved.
 *
 * - `exact`   the configured id is a catalog entry
 * - `alias`   a legacy id was mapped to its current equivalent
 * - `default` no usable id was configured, so the provider default applies
 * - `unknown` an id was configured but matches nothing, so the default applies
 */
export type PlanResolution = "exact" | "alias" | "default" | "unknown"

export interface ResolvedPlan {
  readonly plan: PlanDefinition | undefined
  readonly resolution: PlanResolution
  /** The id actually matched, useful for diagnostics. */
  readonly planID: string | undefined
}

/**
 * Resolve a plan id, reporting *how* it was resolved.
 *
 * A silent fallback is dangerous on a billing boundary: a typo in `plan` would
 * otherwise grant whatever tier this repository happens to default to, which
 * could overstate a user's allowance by an order of magnitude.
 *
 * An *unknown* id therefore resolves to no plan at all rather than to the
 * default. Callers treat "no plan" as unknown capacity, not as the maintainer's
 * tier. `resolution: "default"` is reserved for the case where no id was
 * configured at all, which is a documented starting point rather than a typo.
 */
export const resolvePlanWithReason = (
  providerID: string,
  planID: string | undefined,
): ResolvedPlan => {
  const requested = (planID ?? "").trim().toLowerCase()
  if (requested) {
    const aliasTarget = PLAN_ALIASES[`${providerID}/${requested}`]
    if (aliasTarget) {
      const plan = PLAN_BY_KEY.get(`${providerID}/${aliasTarget}`)
      if (plan) return { plan, resolution: "alias", planID: plan.planID }
    }
    const direct = PLAN_BY_KEY.get(`${providerID}/${requested}`)
    if (direct) return { plan: direct, resolution: "exact", planID: direct.planID }
    // Configured but unrecognized: refuse to guess a tier.
    return { plan: undefined, resolution: "unknown", planID: undefined }
  }
  const fallback = DEFAULT_PLAN_ID[providerID]
  return {
    plan: fallback ? PLAN_BY_KEY.get(`${providerID}/${fallback}`) : undefined,
    resolution: fallback ? "default" : "unknown",
    planID: fallback,
  }
}

export const resolvePlan = (providerID: string, planID: string | undefined): PlanDefinition | undefined =>
  resolvePlanWithReason(providerID, planID).plan

export const planById = (providerID: string, planID: string): PlanDefinition | undefined =>
  PLAN_BY_KEY.get(`${providerID}/${planID}`)

/**
 * Which pool funds a model.
 *
 * OpenDesign is the only provider in the catalog with more than one pool, so
 * this is where the Design Plan / plan model split is applied. A provider
 * whose model is not named in the Design Plan group draws from plan model
 * credits directly.
 */
export const fundingPoolFor = (plan: PlanDefinition, modelID: string): CreditPoolDefinition | undefined => {
  if (plan.providerID === "opendesign") {
    const designPlan = plan.pools.find((pool) => pool.id === OPENDESIGN_DESIGN_PLAN_POOL)
    const planModels = plan.pools.find((pool) => pool.id === OPENDESIGN_PLAN_MODEL_POOL)
    if (OPENDESIGN_DESIGN_PLAN_MODELS.has(modelID)) return designPlan ?? planModels
    return planModels ?? designPlan
  }
  return [...plan.pools].sort((a, b) => a.drawOrder - b.drawOrder)[0]
}

/** True when the model is funded from a pool reserved for escalation. */
export const isEscalationOnlyPool = (plan: PlanDefinition, modelID: string): boolean => {
  if (plan.providerID !== "opendesign") return false
  return !OPENDESIGN_DESIGN_PLAN_MODELS.has(modelID)
}

/**
 * Design Plan credits are consumed before plan model credits. Once the first
 * pool is exhausted a Design Plan model keeps working, but the published
 * multiplier does not follow it into the second pool, so the effective credit
 * rate rises. Callers must not apply a Design Plan multiplier blindly.
 */
export const poolDrawSequence = (
  plan: PlanDefinition,
  modelID: string,
): ReadonlyArray<{ pool: CreditPoolDefinition; multiplierApplies: boolean }> => {
  const primary = fundingPoolFor(plan, modelID)
  if (!primary) return []
  const sequence = [{ pool: primary, multiplierApplies: plan.providerID !== "opendesign" || primary.id === OPENDESIGN_DESIGN_PLAN_POOL }]
  if (plan.providerID !== "opendesign") return sequence
  const designPlan = plan.pools.find((pool) => pool.id === OPENDESIGN_DESIGN_PLAN_POOL)
  const planModels = plan.pools.find((pool) => pool.id === OPENDESIGN_PLAN_MODEL_POOL)
  if (primary.id === OPENDESIGN_DESIGN_PLAN_POOL && planModels) {
    sequence.push({ pool: planModels, multiplierApplies: false })
  } else if (primary.id === OPENDESIGN_PLAN_MODEL_POOL && designPlan && OPENDESIGN_DESIGN_PLAN_MODELS.has(modelID)) {
    // A Design Plan model always draws its own pool first.
    sequence.unshift({ pool: designPlan, multiplierApplies: true })
  }
  return sequence
}

/** Monthly per-model allowance for plan-metered providers. */
export const modelMonthlyAllowanceUsd = (plan: PlanDefinition, modelID: string): number => {
  const table = plan.perModelMonthlyUsd
  if (!table) return 0
  return table[modelID] ?? 0
}

/** The nested window caps for one model, derived from its monthly allowance. */
export const modelWindowCaps = (
  plan: PlanDefinition,
  modelID: string,
): { monthlyUsd: number; weeklyUsd: number; fiveHourUsd: number } => {
  const monthlyUsd = modelMonthlyAllowanceUsd(plan, modelID)
  const rule = plan.perModelWindowRule
  if (!rule || monthlyUsd <= 0) return { monthlyUsd, weeklyUsd: 0, fiveHourUsd: 0 }
  return {
    monthlyUsd,
    weeklyUsd: monthlyUsd * (rule.weeklyPct / 100),
    fiveHourUsd: monthlyUsd * (rule.fiveHourPct / 100),
  }
}

export const planSummaryLine = (plan: PlanDefinition): string => {
  const parts = plan.pools.map((pool) => {
    const windows = [
      pool.fiveHourUsd !== undefined ? `5h $${pool.fiveHourUsd}` : undefined,
      pool.weeklyUsd !== undefined ? `7d $${pool.weeklyUsd}` : undefined,
    ].filter((entry): entry is string => Boolean(entry))
    const suffix = windows.length > 0 ? ` (${windows.join(", ")} nested)` : ""
    return `${pool.label} $${pool.monthlyUsd}/mo${suffix}`
  })
  return `${plan.label} ($${plan.monthlyPriceUsd}/mo): ${parts.join(" + ")}`
}
