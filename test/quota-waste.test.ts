import { describe, expect, it } from "vitest"
import { quotaWasteFraction, quotaMarginalPriceFactor } from "../src/core/policy/eligibility.js"
import type { ProviderQuotaSnapshot } from "../src/core/types.js"

/**
 * Prepaid allowance that expires unused is already paid for, so the money is
 * gone either way and only the *use* of it is recoverable.
 *
 * That does not make expiring quota free. The correct marginal cost of spending
 * a prepaid dollar is the probability that the dollar would otherwise be
 * wasted: if the account is on track to consume the rest of the window, the
 * next request displaces real work and costs full price; if the window will
 * reset with most of it untouched, the next request costs almost nothing
 * because the alternative is losing it.
 *
 * The router used to model this with a flat 35% pressure discount, which is both
 * the wrong quantity (pressure cannot close a price gap) and the wrong shape (a
 * pool on track to be fully used got the same discount as one that would be
 * abandoned). Waste is derivable from the burn rate the window itself records,
 * so these pin that derivation instead.
 *
 * Everything here is deliberately conservative: it never claims a pool is free,
 * never rewards a pool with no headroom, and never treats quota with no known
 * reset time as expiring, because a credential that never resets has no
 * deadline to beat.
 */

const HOUR = 60 * 60 * 1000
const WEEK = 7 * 24 * HOUR
const NOW = 1_800_000_000_000

const snapshotWith = (input: {
  usedUsd: number
  capUsd: number
  resetsInMs: number
  window?: "weekly" | "monthly"
  resetsAt?: number | undefined
}): ProviderQuotaSnapshot => {
  const usedPct = (input.usedUsd / input.capUsd) * 100
  const window = {
    usedPct,
    remainingPct: 100 - usedPct,
    usedUsd: input.usedUsd,
    capUsd: input.capUsd,
    resetsAt: "resetsAt" in input ? input.resetsAt : NOW + input.resetsInMs,
    source: "provider" as const,
  }
  const empty = { usedPct: 0, remainingPct: 100, source: "unknown" as const }
  return {
    providerID: "p",
    label: "p",
    plan: "x",
    source: "provider",
    fetchedAt: NOW,
    stale: false,
    rolling: empty,
    weekly: input.window === "monthly" ? empty : window,
    monthly: input.window === "monthly" ? window : empty,
    models: {},
    notes: [],
  } as unknown as ProviderQuotaSnapshot
}

describe("how much of a window's allowance is actually about to be wasted", () => {
  it("is near one when a full pool is about to reset", () => {
    // Half of $35 spent, three hours left, and almost no time to spend the rest.
    // The burn rate over the elapsed part of the week cannot possibly consume
    // $17.50 in three hours.
    const snapshot = snapshotWith({ usedUsd: 17.5, capUsd: 35, resetsInMs: 3 * HOUR })
    expect(quotaWasteFraction(snapshot, NOW)).toBeGreaterThan(0.9)
  })

  it("is near zero when the window is on track to be fully consumed", () => {
    // 87% spent with 21 hours of a 168-hour window left: the observed burn rate
    // projects to spend the remainder before reset, so nothing is being wasted.
    const usedUsd = 0.869 * 35
    const snapshot = snapshotWith({ usedUsd, capUsd: 35, resetsInMs: 21.4 * HOUR })
    expect(quotaWasteFraction(snapshot, NOW)).toBeLessThan(0.1)
  })

  it("is zero when the reset is far away", () => {
    // A month out with half the pool spent is simply ordinary quota.
    const snapshot = snapshotWith({ usedUsd: 17.5, capUsd: 35, resetsInMs: 30 * 24 * HOUR })
    expect(quotaWasteFraction(snapshot, NOW)).toBe(0)
  })

  it("is zero when the provider never reported a reset time", () => {
    const snapshot = snapshotWith({ usedUsd: 17.5, capUsd: 35, resetsInMs: 3 * HOUR, resetsAt: undefined })
    // An unpriced, never-resetting credential has no deadline to beat.
    expect(quotaWasteFraction(snapshot, NOW)).toBe(0)
  })

  it("is zero for a pool nobody has spent anything on yet", () => {
    // Nothing has been committed to this pool, so there is nothing to recover
    // by spending it. Untouched allowance is not waste.
    const snapshot = snapshotWith({ usedUsd: 0, capUsd: 35, resetsInMs: 2 * HOUR })
    expect(quotaWasteFraction(snapshot, NOW)).toBe(0)
  })

  it("does not exceed one", () => {
    const snapshot = snapshotWith({ usedUsd: 1, capUsd: 35, resetsInMs: HOUR })
    expect(quotaWasteFraction(snapshot, NOW)).toBeLessThanOrEqual(1)
  })

  it("ignores a window that has already reset", () => {
    const snapshot = snapshotWith({ usedUsd: 20, capUsd: 35, resetsInMs: -HOUR })
    expect(quotaWasteFraction(snapshot, NOW)).toBe(0)
  })

  it("picks the window that is wasting the most", () => {
    // Weekly has real money left and is dying; monthly has room and time.
    const weeklyDying = snapshotWith({ usedUsd: 20, capUsd: 35, resetsInMs: HOUR })
    const monthlyRoom = snapshotWith({ usedUsd: 5, capUsd: 140, resetsInMs: 20 * 24 * HOUR, window: "monthly" })
    const both = {
      ...weeklyDying,
      monthly: (monthlyRoom as any).monthly,
    } as ProviderQuotaSnapshot
    expect(quotaWasteFraction(both, NOW)).toBeGreaterThan(0.9)
  })
})

describe("expiring prepaid allowance is discounted by how much would be lost", () => {
  it("barely discounts a window that is on track to be fully used", () => {
    // The owner's real Command Code weekly window: 86.9% spent with 21.4 hours
    // of 168 left. At the observed burn rate the remainder is consumed before
    // reset, so there is almost nothing to recover and the price stays near full.
    const onTrack = snapshotWith({ usedUsd: 0.869 * 35, capUsd: 35, resetsInMs: 21.4 * HOUR })
    expect(quotaMarginalPriceFactor(onTrack, NOW)).toBeGreaterThan(0.95)
    expect(quotaMarginalPriceFactor(onTrack, NOW)).toBeLessThanOrEqual(1)
  })

  it("makes allowance that will be abandoned almost free", () => {
    const abandoned = snapshotWith({ usedUsd: 17.5, capUsd: 35, resetsInMs: 3 * HOUR })
    // Near zero marginal cost, but never zero: a free tier would win every
    // comparison regardless of how little headroom it had left.
    expect(quotaMarginalPriceFactor(abandoned, NOW)).toBeLessThan(0.15)
    expect(quotaMarginalPriceFactor(abandoned, NOW)).toBeGreaterThan(0)
  })

  it("is monotone: more waste means a lower factor", () => {
    const threeHours = snapshotWith({ usedUsd: 17.5, capUsd: 35, resetsInMs: 3 * HOUR })
    const oneDay = snapshotWith({ usedUsd: 17.5, capUsd: 35, resetsInMs: 24 * HOUR })
    expect(quotaMarginalPriceFactor(threeHours, NOW)).toBeLessThan(quotaMarginalPriceFactor(oneDay, NOW))
  })

  it("does not reward a pool that is already out", () => {
    // Nothing left to spend, so there is no marginal price to lower.
    const empty = snapshotWith({ usedUsd: 35, capUsd: 35, resetsInMs: 2 * HOUR })
    expect(quotaMarginalPriceFactor(empty, NOW)).toBe(1)
  })

  it("applies to an estimated provider using the same rule", () => {
    // OpenDesign reports no reset time, so it can never be treated as expiring
    // no matter how little of its pool has been used.
    const opendesign = snapshotWith({ usedUsd: 3, capUsd: 90, resetsInMs: 6 * 24 * HOUR, resetsAt: undefined })
    expect(quotaMarginalPriceFactor(opendesign, NOW)).toBe(1)
  })

  it("reads a monthly window as a different burn rate from a weekly one", () => {
    // Same dollars left and the same hours remaining, but $110 unspent on a
    // monthly pool is a far larger loss than $5 unspent on a weekly one, and the
    // slower burn rate means it is far less likely to be consumed in time.
    const weekly = snapshotWith({ usedUsd: 30, capUsd: 35, resetsInMs: 4 * HOUR })
    const monthly = snapshotWith({ usedUsd: 30, capUsd: 140, resetsInMs: 4 * HOUR, window: "monthly" })
    expect(quotaWasteFraction(monthly, NOW)).toBeGreaterThan(quotaWasteFraction(weekly, NOW))
  })
})
