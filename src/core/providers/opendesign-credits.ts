/**
 * OpenDesign Design Plan credit semantics.
 *
 * OpenDesign bills a Go subscription through a shared "Design Plan" credit
 * pool. A per-model multiplier converts the dollar value of model usage into
 * Design Plan credits consumed. The five-hour and seven-day allowances are
 * nested limits inside one monthly maximum; they are not additional credits
 * and must never be added together.
 *
 * Source: https://open-design.ai/model-credits/ and
 * https://open-design.ai/help/billing/ (retrieved 2026-10-28).
 *
 * Nothing in this file is a provider charge. Every number produced here is an
 * estimate of credits, and the caller must label it as such.
 */

/**
 * Credit multiplier published for each Design Plan model.
 *
 * Multipliers apply to Design Plan credits only. A request funded from plan
 * model credits is billed at the plain usage value, so callers must pass
 * `multiplierApplies: false` for that pool. See the plan catalog.
 */
export const OPENDESIGN_CREDIT_MULTIPLIERS: Readonly<Record<string, number>> = {
  "deepseek-v4.1-flash": 0.5,
  "mimo-v2.6-flash": 1,
  "mimo-v2.6-pro": 1,
  "hy4-preview": 1,
  "deepseek-v4-flash": 1,
  "deepseek-v4-flash-vision-exp": 1,
  "deepseek-v4-pro": 1,
  "glm-5.3-flash": 1,
  "kimi-k2.7-code": 1,
  "claude-haiku-5.5": 2,
  "glm-5.3-flashx": 2,
  "gpt-6-luna": 4,
}

/**
 * Models the gateway serves inside the Design Plan group whose multiplier is
 * not published. The gateway is authoritative for entitlement, not for price.
 */
export const OPENDESIGN_UNPUBLISHED_MULTIPLIER_MODELS: ReadonlySet<string> = new Set([
  "minimax-m3.1-flash",
])

/** Neutral multiplier used when a model has no published rate. */
export const OPENDESIGN_DEFAULT_MULTIPLIER = 1

export interface OpenDesignPromotion {
  readonly id: string
  readonly modelIDs: readonly string[]
  readonly multiplier: number
  /** Epoch milliseconds, inclusive. */
  readonly startsAt: number
  /** Epoch milliseconds, exclusive. */
  readonly endsAt: number
  /**
   * False when the offer is an in-app benefit. OpenDesign states that
   * included free-use and limited-time offers do not automatically apply
   * through MCP, CLI, or API channels, so an app-only promotion must never
   * change the API credit rate.
   */
  readonly appliesToApi: boolean
  readonly note: string
}

const utc = (year: number, month: number, day: number, hour: number) =>
  Date.UTC(year, month - 1, day, hour, 0, 0)

/**
 * The DeepSeek V4.1 Flash off-peak offer documented for 2026-10-20 18:00 to
 * 2026-10-27 18:00 (UTC+8). It is recorded so an expired rate can never be
 * applied by accident, and it is marked as not applicable to API usage.
 */
export const OPENDESIGN_PROMOTIONS: ReadonlyArray<OpenDesignPromotion> = [
  {
    id: "deepseek-v4.1-flash-offpeak-2026-10",
    modelIDs: ["deepseek-v4.1-flash"],
    multiplier: 0.25,
    startsAt: utc(2026, 10, 20, 10),
    endsAt: utc(2026, 10, 27, 10),
    appliesToApi: false,
    note: "Expired and app-only; never applied to API usage.",
  },
]

export type MultiplierEvidence = "published" | "promotion" | "configured" | "unverified"

export interface CreditMultiplier {
  readonly multiplier: number
  readonly evidence: MultiplierEvidence
  readonly note?: string
}

export interface CreditMultiplierOptions {
  readonly now?: number
  /** Explicit per-model overrides. Always wins over published values. */
  readonly overrides?: Readonly<Record<string, number>>
}

const activePromotion = (modelID: string, now: number): OpenDesignPromotion | undefined =>
  OPENDESIGN_PROMOTIONS.find(
    (promotion) =>
      promotion.appliesToApi &&
      promotion.modelIDs.includes(modelID) &&
      now >= promotion.startsAt &&
      now < promotion.endsAt,
  )

/**
 * Resolve the Design Plan credit multiplier for a model.
 *
 * `unverified` means the gateway serves the model inside the plan but no
 * multiplier is published. The router treats that as the neutral 1x rate and
 * surfaces the uncertainty instead of pretending it is exact.
 */
export const creditMultiplierFor = (modelID: string, options: CreditMultiplierOptions = {}): CreditMultiplier => {
  const override = options.overrides?.[modelID]
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return { multiplier: override, evidence: "configured" }
  }
  const now = options.now ?? Date.now()
  const promotion = activePromotion(modelID, now)
  if (promotion) {
    return { multiplier: promotion.multiplier, evidence: "promotion", note: promotion.note }
  }
  const published = OPENDESIGN_CREDIT_MULTIPLIERS[modelID]
  if (typeof published === "number" && Number.isFinite(published) && published > 0) {
    return { multiplier: published, evidence: "published" }
  }
  return {
    multiplier: OPENDESIGN_DEFAULT_MULTIPLIER,
    evidence: "unverified",
    note: OPENDESIGN_UNPUBLISHED_MULTIPLIER_MODELS.has(modelID)
      ? "Multiplier is not published for this model; the neutral 1x rate is used as an estimate."
      : "No published Design Plan multiplier; the neutral 1x rate is used as an estimate.",
  }
}

export interface OpenDesignPlanCaps {
  readonly plan: string
  /** Regular monthly subscription price, in USD. */
  readonly monthlyPriceUsd: number
  /** Maximum Design Plan credits per billing month, in USD-equivalent credits. */
  readonly designPlanMonthlyUsd: number
  /** Plan-model credits outside the Design Plan group. Zero on Go. */
  readonly planModelCreditsUsd: number
  /**
   * Maximum Design Plan credits per five-hour window, or undefined when the
   * plan has no such window. Plus, Pro and Max have none.
   */
  readonly fiveHourCapUsd?: number
  /** Maximum Design Plan credits per seven-day window. Nested, never additional. */
  readonly weeklyCapUsd?: number
}

/**
 * Published Go plan shape, retained so the Go tier stays describable.
 *
 * The catalog in `plans/catalog.ts` is authoritative for routing; this
 * constant exists for callers that need the Go numbers without importing the
 * catalog, and for documentation of the tier the router used to target.
 */
export const OPENDESIGN_GO_PLAN: OpenDesignPlanCaps = {
  plan: "go",
  monthlyPriceUsd: 10,
  designPlanMonthlyUsd: 120,
  planModelCreditsUsd: 0,
  fiveHourCapUsd: 10,
  weeklyCapUsd: 30,
}

/**
 * Published Pro plan shape.
 *
 * Pro has a seven-day Design Plan window and deliberately no five-hour
 * window. It also carries a separate plan model pool whose credits have no
 * usage windows at all and reset per billing cycle.
 */
export const OPENDESIGN_PRO_PLAN: OpenDesignPlanCaps = {
  plan: "pro",
  monthlyPriceUsd: 100,
  designPlanMonthlyUsd: 360,
  planModelCreditsUsd: 120,
  weeklyCapUsd: 90,
}

/**
 * Convert an estimated dollar value of model usage into estimated Design Plan
 * credits. The result is an estimate, never an actual provider charge.
 */
export const designPlanCreditsFor = (
  usageUsd: number,
  modelID: string,
  options: CreditMultiplierOptions = {},
): { creditsUsd: number; multiplier: number; evidence: MultiplierEvidence; note?: string } => {
  const resolved = creditMultiplierFor(modelID, options)
  const creditsUsd = Math.max(0, usageUsd) * resolved.multiplier
  return {
    creditsUsd,
    multiplier: resolved.multiplier,
    evidence: resolved.evidence,
    ...(resolved.note ? { note: resolved.note } : {}),
  }
}
