/**
 * Calibrated routing threshold.
 *
 * The intelligence floor used to be a hand-picked constant (39.5). That made it
 * impossible to answer the only question that matters about it: why that number
 * and not another one. It also silently sat *below* the cheapest eligible
 * model, so changing it did nothing at all.
 *
 * This module derives the threshold from the owner's own recorded traffic
 * instead. It follows the convention RouteLLM established for the same problem:
 * pick the model that minimizes cost subject to a measured quality target,
 * rather than by intuition.
 *
 * Crucially the target is a *cost* target, not a quality one. The router's job
 * is to keep spending at the same level it has actually been spending while
 * preferring capable models, not to decide how good the work should be. Quality
 * targets expressed as "95% of a stronger model" need preference data over model
 * pairs, which is expensive and which this owner does not have.
 *
 * When there is not enough recorded traffic, this returns undefined and the
 * router keeps its configured floor. A calibration built on four requests would
 * be a fabrication dressed up as evidence.
 */

import type { ModelRecord, RouterSettings } from "../types.js"
/**
 * One row of recorded spend per model.
 *
 * Mirrors the shape `LedgerStore.usageByModel` returns. Declared here rather
 * than imported so calibration depends on the data it consumes, not on the
 * ledger implementation that happens to produce it.
 */
export interface ModelUsageRow {
  readonly providerID: string
  readonly modelID: string
  readonly requests: number
  readonly usd: number
}

/**
 * How much recorded spend a model needs before its cost figure is trusted.
 *
 * Below this the per-model cost is dominated by whichever single request
 * happened to be long, so including it would let one unlucky session set the
 * baseline for everything after it.
 */
export const MIN_REQUESTS_FOR_COST_EVIDENCE = 5

/**
 * The traffic window used to calibrate.
 *
 * Two weeks is long enough to cover a normal working rhythm, including the
 * occasional expensive day, and short enough that a price change or a new model
 * is reflected rather than averaged away for months.
 */
export const CALIBRATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/**
 * How much above the measured average cost a model may sit and still be chosen.
 *
 * A small allowance matters because the baseline includes sessions whose model
 * was badly chosen. Clamping to exactly the average would entrench those
 * choices; a modest margin lets a slightly pricier but more capable model win
 * when the difference is immaterial.
 */
export const CALIBRATION_TOLERANCE = 1.05

/**
 * A hard ceiling on how far calibration may move the threshold.
 *
 * The measured baseline can drift low if recent traffic happened to be trivial.
 * Without a bound, one cheap afternoon could lower the effective quality gate
 * far enough to send substantive work to a model that cannot do it. This keeps
 * a bad baseline from becoming a routable decision: at most this many points of
 * intelligence may be given up relative to the configured floor.
 *
 * The bound is asymmetric on purpose. Calibration may never *raise* the
 * threshold above the configured floor, because raising it would silently
 * exclude models the owner already approved and would make the router stricter
 * than its own settings claim.
 */
export const MAX_CALIBRATION_DROP = 12

export interface CalibrationInput {
  /** Every approved model the router may choose, with its intelligence score. */
  readonly models: ReadonlyArray<ModelRecord>
  /** Recorded per-model spend for the calibration window. */
  readonly usage: ReadonlyArray<ModelUsageRow>
  /** The configured floor, used as the ceiling and as the evidence-free answer. */
  readonly configuredFloor: number
  readonly settings: RouterSettings
  /** Injected for determinism in tests. */
  readonly now?: number
}

export interface CalibrationResult {
  /** The threshold routing should actually use. */
  readonly floor: number
  /**
   * Whether the value was derived from recorded traffic.
   *
   * False means the configured floor was returned because there was not enough
   * evidence. Callers surface this, so a user can tell the difference between
   * "calibrated" and "not yet calibrated" instead of seeing one number and
   * assuming it was measured.
   */
  readonly calibrated: boolean
  /** Average cost per request across the window, in USD. Null when unmeasured. */
  readonly baselineUsdPerRequest: number | null
  /** How the threshold was arrived at, in one line, for the status output. */
  readonly reason: string
  /** Cost of the model the threshold admits as the cheapest capable option. */
  readonly admittedUsdPerRequest: number | null
}

/**
 * The configured floor if the owner pinned it, otherwise a calibrated value.
 *
 * An explicit `intelligenceFloor` in settings always wins. Calibration is for
 * the owner who asked not to maintain that number by hand, not a way to
 * override someone who set it deliberately.
 */
export const resolveIntelligenceFloor = (
  settings: RouterSettings,
  input: Omit<CalibrationInput, "settings" | "configuredFloor">,
): CalibrationResult => {
  const configured = settings.routing.intelligenceFloor
  const off = offlineFloorBypassActive(settings)
  const base: CalibrationResult = {
    floor: configured,
    calibrated: false,
    baselineUsdPerRequest: null,
    reason: "using the configured floor",
    admittedUsdPerRequest: null,
  }
  if (settings.routing.calibrateFloor !== true) return base
  const result = calibrateFloor({ ...input, settings, configuredFloor: configured })
  // Offline mode has its own allow-list and its own exemption from the floor.
  // Calibration is an online-cost concern, so it must not change offline
  // behavior in either direction.
  return off ? base : result
}

const offlineFloorBypassActive = (settings: RouterSettings): boolean => settings.offline?.enabled === true

/**
 * Derive a floor from recorded spend.
 *
 * The algorithm is deliberately small and auditable:
 *
 *  1. Total recorded spend and requests across the window give an average cost
 *     per request. That average *is* the budget: it is what the owner already
 *     spends, so honoring it is not a quality trade-off, it is a consistency
 *     requirement.
 *  2. Among approved, non-escalation models that clear the hard context gate,
 *     find the cheapest one whose cost per request does not exceed the average
 *     by more than the tolerance.
 *  3. That model's intelligence score becomes the floor, bounded so it can only
 *     move down from the configured value and never by more than
 *     MAX_CALIBRATION_DROP.
 *
 * The floor is then a statement of fact about the catalog: "this is the least
 * capable model I am willing to run, and it costs no more than I already spend."
 */
export const calibrateFloor = (input: CalibrationInput): CalibrationResult => {
  const configured = input.configuredFloor
  const usage = input.usage ?? []

  let totalUsd = 0
  let totalRequests = 0
  for (const row of usage) {
    if (!Number.isFinite(row.usd) || row.usd < 0) continue
    if (!Number.isFinite(row.requests) || row.requests <= 0) continue
    totalUsd += row.usd
    totalRequests += row.requests
  }

  if (totalRequests < MIN_REQUESTS_FOR_COST_EVIDENCE) {
    return {
      floor: configured,
      calibrated: false,
      baselineUsdPerRequest: null,
      reason: `not enough recorded traffic to calibrate (${totalRequests} of ${MIN_REQUESTS_FOR_COST_EVIDENCE} requests)`,
      admittedUsdPerRequest: null,
    }
  }

  const baseline = totalUsd / totalRequests
  if (!Number.isFinite(baseline) || baseline <= 0) {
    return {
      floor: configured,
      calibrated: false,
      baselineUsdPerRequest: null,
      reason: "recorded traffic has no measurable cost, so there is nothing to calibrate against",
      admittedUsdPerRequest: null,
    }
  }

  const ceiling = baseline * CALIBRATION_TOLERANCE
  const perRequest = perRequestCosts(usage)

  // Only models that actually served traffic have a measured cost. A model with
  // no recorded requests has no evidence about *this owner's* workload, and
  // substituting a list price would calibrate against the vendor's assumptions
  // rather than the owner's usage.
  const candidates = input.models
    .filter((model) => !model.escalationOnly && !model.premium)
    .filter((model) => model.intelligence > 0)
    .map((model) => {
      const measured = perRequest.get(`${model.providerID}/${model.modelID}`)
      return measured === undefined ? undefined : { model, cost: measured }
    })
    .filter((entry): entry is { model: ModelRecord; cost: number } => entry !== undefined)
    .filter((entry) => entry.cost <= ceiling)
    .sort((a, b) => b.model.intelligence - a.model.intelligence)

  if (candidates.length === 0) {
    return {
      floor: configured,
      calibrated: false,
      baselineUsdPerRequest: baseline,
      reason:
        "every model with recorded traffic costs more than the measured baseline, so no threshold could be met",
      admittedUsdPerRequest: null,
    }
  }

  // The most capable model that fits the budget is the one worth naming: it is
  // what the threshold exists to admit.
  const best = candidates[0]!
  const bounded = Math.min(configured, Math.max(best.model.intelligence, configured - MAX_CALIBRATION_DROP))

  return {
    floor: bounded,
    calibrated: true,
    baselineUsdPerRequest: baseline,
    reason:
      `${best.model.providerID}/${best.model.modelID} costs $${best.cost.toFixed(4)} per request ` +
      `against a measured baseline of $${baseline.toFixed(4)}`,
    admittedUsdPerRequest: best.cost,
  }
}

/**
 * Cost per request for each model that has recorded traffic.
 *
 * Requests rather than tokens, because a long cheap request and a short
 * expensive one both occupy a turn of the owner's attention, and the budget
 * being respected is spend for work done.
 */
const perRequestCosts = (usage: ReadonlyArray<ModelUsageRow>): Map<string, number> => {
  const costs = new Map<string, number>()
  for (const row of usage) {
    if (!Number.isFinite(row.usd) || row.usd < 0) continue
    if (!Number.isFinite(row.requests) || row.requests <= 0) continue
    costs.set(`${row.providerID}/${row.modelID}`, row.usd / row.requests)
  }
  return costs
}
