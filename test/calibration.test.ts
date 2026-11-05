import { describe, expect, it } from "vitest"
import {
  DEFAULT_MARGIN_PCT,
  MIN_CALIBRATION_SAMPLES,
  calibrate,
  calibrationSamples,
  effectiveMarginPct,
} from "../src/core/quota/calibration.js"
import { probeOpenDesignQuota } from "../src/core/quota/opendesign.js"
import type { ProviderSettings, UsageEvent } from "../src/core/types.js"

/**
 * Calibration removes the recurring paste, so the risk it carries is that it
 * makes the estimate confidently wrong. These tests are mostly about when it
 * should refuse to narrow the margin.
 */

const NOW = Date.UTC(2026, 10, 4, 21, 0, 0)
const HOUR = 3_600_000

const event = (over: Partial<UsageEvent> & { at: number }): UsageEvent => ({
  id: `e${over.at}`,
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

/** 1M input tokens of DeepSeek V4.1 Flash: $0.30 usage, 0.5x, so $0.15 of credits. */
const accurate = (at: number) => event({ at, usd: 0.3, input: 1_000_000 })

describe("gathering samples", () => {
  it("ignores events with no reported charge, because they teach nothing", () => {
    const samples = calibrationSamples([event({ at: NOW, usd: 0, input: 1_000_000 })])
    expect(samples).toHaveLength(0)
  })

  it("ignores events with no tokens, because there is nothing to compare", () => {
    const samples = calibrationSamples([event({ at: NOW, usd: 1, input: 0, output: 0 })])
    expect(samples).toHaveLength(0)
  })

  it("compares in the same units by applying the multiplier to the charge", () => {
    const [sample] = calibrationSamples([accurate(NOW)])
    expect(sample!.computedUsd).toBeCloseTo(0.15, 6)
    expect(sample!.reportedUsd).toBeCloseTo(0.15, 6)
  })
})

describe("narrowing the margin only on real evidence", () => {
  it("keeps the default margin when there is no evidence", () => {
    const result = calibrate([])
    expect(result.suggestedMarginPct).toBe(DEFAULT_MARGIN_PCT)
    expect(result.trustworthy).toBe(false)
  })

  it("keeps the default until the sample is large enough", () => {
    const samples = calibrationSamples(
      Array.from({ length: MIN_CALIBRATION_SAMPLES - 1 }, (_, i) => accurate(NOW - i * HOUR)),
    )
    const result = calibrate(samples)
    expect(result.trustworthy).toBe(false)
    expect(result.suggestedMarginPct).toBe(DEFAULT_MARGIN_PCT)
  })

  it("narrows the margin once the evidence agrees", () => {
    const samples = calibrationSamples(
      Array.from({ length: 10 }, (_, i) => accurate(NOW - i * HOUR)),
    )
    const result = calibrate(samples)
    expect(result.trustworthy).toBe(true)
    expect(result.ratio).toBeCloseTo(1, 6)
    expect(result.suggestedMarginPct).toBeLessThan(DEFAULT_MARGIN_PCT)
  })

  it("never narrows below a floor, because one price change undoes perfect history", () => {
    const samples = calibrationSamples(
      Array.from({ length: 50 }, (_, i) => accurate(NOW - i * HOUR)),
    )
    expect(calibrate(samples).suggestedMarginPct).toBeGreaterThanOrEqual(5)
  })

  it("keeps the wide margin and warns when charges imply a wrong price", () => {
    // Charged 4x what the catalog predicts, consistently.
    const samples = calibrationSamples(
      Array.from({ length: 10 }, (_, i) =>
        event({ at: NOW - i * HOUR, usd: 0.3 * 4, input: 1_000_000 }),
      ),
    )
    const result = calibrate(samples)
    expect(result.warning).toBeDefined()
    expect(result.warning).toMatch(/price error/i)
    // The estimator must not adopt a margin derived from numbers it distrusts.
    expect(effectiveMarginPct(samples)).toBe(DEFAULT_MARGIN_PCT)
  })
})

describe("the estimator uses the calibrated margin", () => {
  const settings = (): ProviderSettings => ({
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
  })

  const run = (usage: UsageEvent[]) =>
    probeOpenDesignQuota({ settings: settings(), apiKey: "k", usage, now: () => NOW })

  it("applies the default margin with no history", async () => {
    const one = event({ at: NOW - HOUR, usd: 0, input: 1_000_000 })
    const result = await run([one])
    // $0.15 of credits plus the 20% default margin.
    expect(result.snapshot.weekly.usedUsd ?? 0).toBeCloseTo(0.15 * 1.2, 5)
  })

  it("applies a narrower margin once history agrees", async () => {
    const history = Array.from({ length: 10 }, (_, i) => accurate(NOW - i * HOUR))
    const result = await run(history)
    const weekly = result.snapshot.weekly.usedUsd ?? 0
    const raw = 0.15 * 10
    // Some margin remains, but less than the 20% default.
    expect(weekly).toBeGreaterThan(raw)
    expect(weekly).toBeLessThan(raw * 1.2)
  })

  it("lets an explicit margin override calibration", async () => {
    const history = Array.from({ length: 10 }, (_, i) => accurate(NOW - i * HOUR))
    const result = await probeOpenDesignQuota({
      settings: settings(),
      apiKey: "k",
      usage: history,
      uncertaintyMarginPct: 0,
      now: () => NOW,
    })
    expect(result.snapshot.weekly.usedUsd ?? 0).toBeCloseTo(0.15 * 10, 6)
  })
})
