import { creditMultiplierFor } from "../providers/opendesign-credits.js"
import { estimateDesignPlanCredits } from "./opendesign.js"
import type { UsageEvent } from "../types.js"

/**
 * Calibrate the estimate against what the provider actually charged.
 *
 * Every completed step carries a real charge, so the router can compare its own
 * arithmetic with the truth on every request it routes. That makes the safety
 * margin a measured quantity rather than a guess: a fresh install has no
 * evidence and needs a wide margin; after a few dozen requests that agree
 * closely, the margin can shrink because the disagreement has been observed to
 * be small.
 *
 * This is the piece that removes the recurring paste. The paste still matters
 * once, for usage that happened before the router existed — nothing local can
 * see that — but the ongoing drift is now self-correcting.
 *
 * Two rules keep it honest:
 *
 *   - **Only reported charges count.** An event with no cost teaches nothing
 *     about accuracy; counting it as agreement would manufacture confidence.
 *   - **Calibration never overrides the catalog.** It adjusts the margin applied
 *     to this account's traffic. A systematic disagreement big enough to imply a
 *     wrong price is reported, not silently absorbed, because that is a catalog
 *     bug rather than a property of one account.
 */

export interface CalibrationSample {
  readonly modelID: string
  /** Credits the router computed from tokens and the catalog. */
  readonly computedUsd: number
  /** Credits the provider actually charged. */
  readonly reportedUsd: number
}

export interface CalibrationResult {
  readonly samples: number
  /** Provider charged / router computed, weighted by the router's own figure. */
  readonly ratio: number
  /** Mean absolute percentage error between the two, 0 when they agree exactly. */
  readonly meanErrorPct: number
  /**
   * Margin to apply instead of the default, in percent.
   *
   * Shrinks as the error shrinks, never below zero, and never removes the
   * margin entirely: an account with fifty agreeing samples is still one price
   * change away from being wrong.
   */
  readonly suggestedMarginPct: number
  /** True when the evidence is strong enough to act on. */
  readonly trustworthy: boolean
  /** Set when the disagreement is large enough to look like a catalog error. */
  readonly warning?: string
}

/** Below this, the sample is too small to distinguish agreement from luck. */
export const MIN_CALIBRATION_SAMPLES = 5

/** The margin applied when there is no evidence at all. */
export const DEFAULT_MARGIN_PCT = 20

/**
 * A ratio this far from 1 means the catalog and the provider disagree
 * systematically — a wrong price, not noise.
 */
const SYSTEMATIC_DRIFT = 0.25

export const calibrationSamples = (
  usage: ReadonlyArray<UsageEvent>,
  providerID = "opendesign",
): ReadonlyArray<CalibrationSample> => {
  const samples: CalibrationSample[] = []
  for (const event of usage) {
    if (event.providerID !== providerID) continue
    // No charge reported means no evidence about accuracy.
    if (event.usd <= 0) continue
    if (event.input + event.output + event.cacheRead + event.cacheWrite === 0) continue
    const computed = estimateDesignPlanCredits({
      modelID: event.modelID,
      input: event.input,
      output: event.output,
      cacheRead: event.cacheRead,
      cacheWrite: event.cacheWrite,
      multiplierApplies: true,
    }).creditsUsd
    if (computed <= 0) continue
    // The multiplier is applied to the reported charge as well, so the two are
    // compared in the same units.
    const multiplier = creditMultiplierFor(event.modelID).multiplier
    samples.push({
      modelID: event.modelID,
      computedUsd: computed,
      reportedUsd: event.usd * multiplier,
    })
  }
  return samples
}

export const calibrate = (
  samples: ReadonlyArray<CalibrationSample>,
  options: { readonly baselineMarginPct?: number } = {},
): CalibrationResult => {
  const baseMargin = options.baselineMarginPct ?? DEFAULT_MARGIN_PCT
  if (samples.length === 0) {
    return {
      samples: 0,
      ratio: 1,
      meanErrorPct: 0,
      suggestedMarginPct: baseMargin,
      trustworthy: false,
    }
  }

  let computedTotal = 0
  let reportedTotal = 0
  let errorTotal = 0
  for (const sample of samples) {
    computedTotal += sample.computedUsd
    reportedTotal += sample.reportedUsd
    errorTotal += Math.abs(sample.reportedUsd - sample.computedUsd) / sample.computedUsd
  }

  const ratio = computedTotal > 0 ? reportedTotal / computedTotal : 1
  const meanErrorPct = (errorTotal / samples.length) * 100
  const trustworthy = samples.length >= MIN_CALIBRATION_SAMPLES

  // With evidence, the margin tracks observed error with a small floor. Without
  // it, the default stands.
  const suggestedMarginPct = trustworthy
    ? Math.max(5, Math.round(meanErrorPct))
    : baseMargin

  const systematic = Math.abs(ratio - 1) > SYSTEMATIC_DRIFT

  return {
    samples: samples.length,
    ratio,
    meanErrorPct,
    suggestedMarginPct,
    trustworthy,
    ...(systematic
      ? {
          warning:
            `Charges are ${(ratio * 100).toFixed(0)}% of what the catalog predicts across ${samples.length} requests. ` +
            `That looks like a price error rather than noise, so the margin was not narrowed. Check the model catalog against the published prices.`,
        }
      : {}),
  }
}

/**
 * The margin the estimator should use.
 *
 * Calibration narrows the margin only when the evidence agrees. A systematic
 * disagreement keeps the wide default and raises a warning, because trusting
 * calibrated-but-wrong numbers would be worse than trusting none.
 */
export const effectiveMarginPct = (
  samples: ReadonlyArray<CalibrationSample>,
  baselineMarginPct?: number,
): number => {
  const result = calibrate(samples, baselineMarginPct !== undefined ? { baselineMarginPct } : {})
  if (result.warning) return baselineMarginPct ?? DEFAULT_MARGIN_PCT
  return result.suggestedMarginPct
}
