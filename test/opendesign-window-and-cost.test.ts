import { describe, expect, it } from "vitest"
import { probeOpenDesignQuota, weeklyWindowStart } from "../src/core/quota/opendesign.js"
import type { ProviderSettings, UsageEvent } from "../src/core/types.js"

/**
 * Two defects that shipped with passing tests around them.
 *
 * 1. The estimator recomputed price from the static table and ignored the
 *    per-request cost the host reports, so the best available number was
 *    discarded in favour of an approximation of it.
 * 2. The seven-day window was bucketed as `now - 7 days` — rolling — while the
 *    catalog declared it fixed. The catalog test passed because it checked the
 *    catalog, not the estimator.
 *
 * Both are behavioural, so these tests assert on computed figures rather than
 * on declarations.
 */

const NOW = Date.UTC(2026, 10, 4, 21, 0, 0)
const HOUR = 3_600_000
const DAY = 24 * HOUR

const settings = (over: Partial<ProviderSettings> = {}): ProviderSettings => ({
  enabled: true,
  plan: "pro",
  reserveMonthlyPct: 5,
  reserveWeeklyPct: 10,
  reserveFiveHourPct: 0,
  allowExtraUsage: false,
  probeUsage: true,
  subscriptionOnly: true,
  providerScopedQuota: true,
  ignoreFiveHourWindow: true,
  credentialSource: "explicit",
  ...over,
})

const event = (over: Partial<UsageEvent> & { at: number }): UsageEvent => ({
  id: `evt_${over.at}`,
  providerID: "opendesign",
  modelID: "deepseek-v4.1-flash",
  usd: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  source: "step",
  ...over,
})

const run = (usage: UsageEvent[], over: Partial<ProviderSettings> = {}) =>
  probeOpenDesignQuota({
    settings: settings(over),
    apiKey: "test-key",
    usage,
    // The margin is a separate concern with its own tests; this file is about
    // which cost figure is used and which events are in the window.
    uncertaintyMarginPct: 0,
    now: () => NOW,
  })

describe("the reported cost beats a recomputed one", () => {
  it("uses what the request actually cost", async () => {
    /**
     * 1M input tokens of DeepSeek V4.1 Flash is $0.30 at the published rate,
     * and the Design Plan multiplier is 0.5x, so the table predicts $0.15 of
     * credits. The host reports $1.00 of usage, which is the real charge — for
     * example because the step drew on plan model credits after the Design Plan
     * allowance was spent. The real charge must win.
     */
    const result = await run([event({ at: NOW - HOUR, usd: 1.0, input: 1_000_000 })])
    expect(result.snapshot.weekly.usedUsd ?? 0).toBeCloseTo(0.5, 6)
  })

  it("falls back to the price table when the host reports no cost", async () => {
    // A zero cost means "not reported", not "free". Assuming free would make
    // the estimate silently forget real usage.
    const result = await run([event({ at: NOW - HOUR, usd: 0, input: 1_000_000 })])
    expect(result.snapshot.weekly.usedUsd ?? 0).toBeCloseTo(0.15, 6)
  })

  it("does not apply the Design Plan multiplier to a plan-model charge", async () => {
    // Plan models are billed at the plain rate. An unreported cost for one of
    // those must not be uplifted.
    const result = await run([event({ at: NOW - HOUR, usd: 0, modelID: "gpt-6-sol", input: 1_000_000 })])
    expect(result.snapshot.pools?.find((pool) => pool.id === "plan-models")?.usedUsd ?? 0).toBeCloseTo(2, 6)
  })
})

describe("the seven-day window is fixed, not rolling", () => {
  /**
   * The window resets 22 hours from now, so it began 6 days and 2 hours ago.
   * An event from 6.5 days ago belongs to the PREVIOUS window. A rolling
   * calculation would count it and overstate this window's usage.
   */
  const resetsAt = NOW + 22 * HOUR
  const baseline = { at: NOW - HOUR, designPlanUsedPct: 0, weeklyResetsAt: resetsAt } as const

  it("computes the window start from a known reset time", () => {
    expect(weeklyWindowStart(NOW, resetsAt)).toBe(resetsAt - 7 * DAY)
  })

  it("excludes an event from the previous window", async () => {
    const stale = event({ at: NOW - 6.5 * DAY, usd: 1.0 })
    const windowed = await run([stale], { baseline: { ...baseline } })
    expect(windowed.snapshot.weekly.usedUsd ?? 0).toBeCloseTo(0, 6)

    // Without an anchor the same event is counted, which is the old behaviour.
    const unanchored = await run([stale])
    expect(unanchored.snapshot.weekly.usedUsd ?? 0).toBeGreaterThan(0)
  })

  it("still includes an event from inside the current window", async () => {
    const fresh = event({ at: NOW - 3 * DAY, usd: 1.0 })
    const result = await run([fresh], { baseline: { ...baseline } })
    expect(result.snapshot.weekly.usedUsd ?? 0).toBeGreaterThan(0)
  })

  it("leaves the monthly window alone, since it follows the billing cycle", async () => {
    const stale = event({ at: NOW - 6.5 * DAY, usd: 1.0 })
    const result = await run([stale], { baseline: { ...baseline } })
    // Outside the fixed week, inside the month.
    expect(result.snapshot.weekly.usedUsd ?? 0).toBeCloseTo(0, 6)
    expect(result.snapshot.monthly.usedUsd ?? 0).toBeGreaterThan(0)
  })
})
