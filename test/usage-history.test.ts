import { describe, expect, it } from "vitest"
import { LedgerStore, emptyLedger } from "../src/core/quota/ledger.js"
import { buildProviderUsageReport, forecast, formatRelative } from "../src/core/quota/report.js"
import type { UsageEvent } from "../src/core/types.js"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0)

const event = (offsetMs: number, index: number, overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id: `evt_${index}`,
  at: NOW - offsetMs,
  providerID: "opendesign",
  modelID: "deepseek-v4.1-flash",
  usd: 0.01,
  input: 1_000,
  output: 200,
  cacheRead: 9_000,
  cacheWrite: 0,
  source: "step",
  ...overrides,
})

const store = (events: UsageEvent[]) => {
  const ledger = emptyLedger(NOW)
  ledger.usage = [...events]
  return new LedgerStore(ledger)
}

describe("durable usage history", () => {
  it("keeps weekly totals even when raw events exceed the old 2,000 cap", () => {
    // 5,000 events over seven days is roughly what a heavy week produces.
    const events = Array.from({ length: 5_000 }, (_, i) =>
      event((i / 5_000) * 7 * DAY, i),
    )
    const s = store(events)
    s.prune(NOW)
    const week = s.aggregate({ since: NOW - 7 * DAY, until: NOW })
    // Every event is accounted for, whether folded or still raw.
    expect(week.requests).toBe(5_000)
    expect(week.usd).toBeCloseTo(50, 6)
    expect(week.cacheRead).toBe(5_000 * 9_000)
  })

  it("folds aged events into hourly buckets instead of discarding them", () => {
    // 3,000 events spread over ten days: older than the 48h raw horizon.
    const events = Array.from({ length: 3_000 }, (_, i) => event((i / 3_000) * 10 * DAY, i))
    const s = store(events)
    s.prune(NOW)
    const month = s.aggregate({ since: NOW - 30 * DAY, until: NOW })
    expect(month.requests).toBe(3_000)

    // The buckets are far fewer rows than the events they replaced.
    const rollup = (s as any).ledger.usageRollup
    expect(rollup.buckets.length).toBeGreaterThan(0)
    expect(rollup.buckets.length).toBeLessThan(400)
    // Raw history is bounded.
    expect((s as any).ledger.usage.length).toBeLessThanOrEqual(2_000)
  })

  it("keeps aggregates across a restart by hydrating them", () => {
    const events = Array.from({ length: 3_000 }, (_, i) => event((i / 3_000) * 10 * DAY, i))
    const s = store(events)
    s.prune(NOW)
    const exported = s.export()

    const hydrated = LedgerStore.hydrate(JSON.parse(JSON.stringify(exported)))
    const restored = new LedgerStore(hydrated.ledger)
    const month = restored.aggregate({ since: NOW - 30 * DAY, until: NOW })
    expect(month.requests).toBe(3_000)
    expect(month.usd).toBeCloseTo(30, 6)
  })

  it("does not double count an event that is both folded and still raw", () => {
    // An event exactly on the raw horizon boundary must appear once.
    const s = store([event(47 * HOUR, 0)])
    s.prune(NOW)
    const total = s.aggregate({ since: NOW - 30 * DAY, until: NOW })
    expect(total.requests).toBe(1)
  })

  it("separates billing periods so a plan change is not mixed", () => {
    // Two events far apart, in different calendar months, both old enough to
    // be folded.
    const previousMonth = Date.UTC(2026, 8, 30, 12, 0, 0)
    const s = store([
      event(NOW - previousMonth, 0),
      event(60 * DAY, 1),
    ])
    s.prune(NOW)
    const rollup = (s as any).ledger.usageRollup
    const periods = new Set(rollup.buckets.map((b: any) => b.periodID))
    expect(periods.size).toBe(2)
  })

  it("preserves historical data when hydrating an older ledger with no rollup", () => {
    const old = {
      version: 1,
      usage: [event(HOUR, 0)],
      premiumSpend: [],
      sessions: {},
      decisions: [],
      metrics: {},
      updatedAt: NOW,
    }
    const { ledger, warnings } = LedgerStore.hydrate(old)
    expect(ledger.usage).toHaveLength(1)
    // It must not crash or invent aggregates it does not have.
    expect(ledger.usageRollup).toBeUndefined()
    void warnings
  })

  it("folds an over-cap pre-aggregate ledger on load instead of discarding history", () => {
    // This is the exact upgrade scenario: the old code wrote 2,000 raw events
    // and no aggregates, and loading it must not throw the oldest ones away.
    const events = Array.from({ length: 3_000 }, (_, i) => event((i / 3_000) * 10 * DAY, i))
    const old = {
      version: 1,
      usage: events,
      premiumSpend: [],
      sessions: {},
      decisions: [],
      metrics: {},
      updatedAt: NOW,
    }
    const { ledger, warnings } = LedgerStore.hydrate(old)
    expect(warnings.join(" ")).toMatch(/Folded 1000 older usage events/)
    expect(ledger.usageRollup).toBeDefined()
    const restored = new LedgerStore(ledger)
    // Every event is still accounted for.
    expect(restored.aggregate({ since: NOW - 30 * DAY, until: NOW }).requests).toBe(3_000)
    expect(restored.aggregate({ since: NOW - 30 * DAY, until: NOW }).usd).toBeCloseTo(30, 6)
  })

  it("groups usage by model over a window", () => {
    const s = store([
      event(HOUR, 0, { modelID: "deepseek-v4.1-flash" }),
      event(HOUR, 1, { modelID: "deepseek-v4.1-flash" }),
      event(HOUR, 2, { modelID: "minimax-m3.1-flash", usd: 0.02 }),
    ])
    s.prune(NOW)
    const rows = s.usageByModel({ since: NOW - DAY, until: NOW })
    const deepseek = rows.find((row) => row.modelID === "deepseek-v4.1-flash")!
    expect(deepseek.requests).toBe(2)
    expect(deepseek.usd).toBeCloseTo(0.02, 6)
    const mini = rows.find((row) => row.modelID === "minimax-m3.1-flash")!
    expect(mini.requests).toBe(1)
  })
})

describe("forecasting", () => {
  it("projects a weekly total from a representative basis", () => {
    const result = forecast({
      windowMs: 7 * DAY,
      now: NOW,
      spendInWindowUsd: 3,
      activityStart: NOW - 24 * HOUR,
      label: "test",
    })
    expect(result.basisHours).toBe(24)
    // $3/day projected over seven days.
    expect(result.projectedUsd).toBeCloseTo(21, 4)
    expect(result.willExhaust).toBe(false)
  })

  it("predicts exhaustion before the window resets", () => {
    const result = forecast({
      windowMs: 7 * DAY,
      now: NOW,
      spendInWindowUsd: 80,
      activityStart: NOW - 24 * HOUR,
      remainingUsd: 10,
      label: "seven-day",
    })
    expect(result.willExhaust).toBe(true)
    expect(result.exhaustsAt).toBeDefined()
    expect(result.exhaustsAt!).toBeGreaterThan(NOW)
    expect(result.explanation).toMatch(/runs out/)
  })

  it("floors the basis so a short burst is not extrapolated into a month", () => {
    const result = forecast({
      windowMs: 30 * DAY,
      now: NOW,
      spendInWindowUsd: 2,
      // Activity started five minutes ago.
      activityStart: NOW - 5 * 60_000,
      label: "monthly",
    })
    // The basis is floored at one hour, so the projection is not absurd.
    expect(result.basisHours).toBe(1)
    expect(result.projectedUsd).toBeCloseTo(2 * 24 * 30, 4)
  })

  it("formats a relative exhaustion time", () => {
    expect(formatRelative(NOW + 30 * 60_000, NOW)).toMatch(/minutes from now/)
    expect(formatRelative(NOW + 3 * HOUR, NOW)).toMatch(/hours from now/)
    expect(formatRelative(NOW + 3 * DAY, NOW)).toMatch(/days from now/)
    expect(formatRelative(NOW - 1000, NOW)).toBe("now")
  })
})

describe("provider usage report", () => {
  it("reports every token class and the cache share", () => {
    const s = store([event(HOUR, 0), event(HOUR, 1)])
    s.prune(NOW)
    const report = buildProviderUsageReport({
      providerID: "opendesign",
      label: "OpenDesign Pro",
      plan: "pro",
      source: "estimate",
      now: NOW,
      source_: {
        aggregate: (window) => s.aggregate(window),
        usageByModel: (window) => s.usageByModel(window),
        usageEvents: s.usageEvents(),
      },
      hasFiveHourWindow: false,
      hasWeeklyWindow: true,
      notes: [],
    })
    expect(report.monthly.requests).toBe(2)
    expect(report.monthly.input).toBe(2_000)
    expect(report.monthly.output).toBe(400)
    expect(report.monthly.cacheRead).toBe(18_000)
    // 18,000 cache reads of 20,000 total input.
    expect(report.cacheSharePct).toBeCloseTo(90, 1)
    expect(report.byModel).toHaveLength(1)
  })

  it("marks a plan with no five-hour window as not applicable, not as 0% used", () => {
    const s = store([event(HOUR, 0)])
    s.prune(NOW)
    const report = buildProviderUsageReport({
      providerID: "opendesign",
      label: "OpenDesign Pro",
      plan: "pro",
      source: "estimate",
      now: NOW,
      source_: {
        aggregate: (window) => s.aggregate(window),
        usageByModel: (window) => s.usageByModel(window),
        usageEvents: s.usageEvents(),
      },
      hasFiveHourWindow: false,
      hasWeeklyWindow: true,
      notes: [],
    })
    expect(report.fiveHour.requests).toBe(0)
    expect(report.notes.join(" ")).toMatch(/no five-hour window/)
    // A weekly forecast exists; a five-hour one does not.
    expect(report.forecasts.some((f) => f.window === "7-day")).toBe(true)
  })

  it("includes a forecast for a plan that does meter a five-hour window", () => {
    const s = store([event(HOUR, 0, { providerID: "commandcode", modelID: "deepseek/deepseek-v4.1-flash" })])
    s.prune(NOW)
    const report = buildProviderUsageReport({
      providerID: "commandcode",
      label: "Command Code GOAT",
      plan: "goat",
      source: "provider",
      now: NOW,
      source_: {
        aggregate: (window) => s.aggregate(window),
        usageByModel: (window) => s.usageByModel(window),
        usageEvents: s.usageEvents(),
      },
      hasFiveHourWindow: true,
      hasWeeklyWindow: true,
      notes: [],
    })
    expect(report.fiveHour.requests).toBe(1)
    expect(report.forecasts.some((f) => f.window === "7-day")).toBe(true)
  })

  it("labels its confidence source", () => {
    const s = store([event(HOUR, 0)])
    s.prune(NOW)
    const report = buildProviderUsageReport({
      providerID: "opendesign",
      label: "OpenDesign Pro",
      plan: "pro",
      source: "estimate",
      quotaState: "estimated",
      now: NOW,
      source_: {
        aggregate: (window) => s.aggregate(window),
        usageByModel: (window) => s.usageByModel(window),
        usageEvents: s.usageEvents(),
      },
      hasFiveHourWindow: false,
      hasWeeklyWindow: true,
      notes: [],
    })
    expect(report.source).toBe("estimate")
    expect(report.quotaState).toBe("estimated")
  })
})

describe("speed telemetry", () => {
  it("records generation speed without treating reasoning as slowness", () => {
    const s = store([])
    s.recordUsage({
      sessionID: "ses_speed",
      model: { providerID: "opendesign", id: "deepseek-v4.1-flash" },
      cost: 0.01,
      tokens: { input: 1000, output: 500, cache: { read: 0, write: 0 } },
      latencyMs: 5_000,
      at: NOW,
    })
    const metrics = s.snapshotMetrics().byModel["opendesign/deepseek-v4.1-flash"]!
    // 500 output tokens in 5 seconds is 100 tokens/sec.
    expect(metrics.outputTokensPerSecond).toBeCloseTo(100, 1)
    expect(metrics.latencySamples).toBe(1)
  })

  it("does not divide by zero when a step produced no output", () => {
    const s = store([])
    s.recordUsage({
      sessionID: "ses_speed",
      model: { providerID: "opendesign", id: "deepseek-v4.1-flash" },
      cost: 0.01,
      tokens: { input: 1000, output: 0, cache: { read: 0, write: 0 } },
      latencyMs: 2_000,
      at: NOW,
    })
    const metrics = s.snapshotMetrics().byModel["opendesign/deepseek-v4.1-flash"]!
    expect(Number.isFinite(metrics.outputTokensPerSecond)).toBe(true)
    expect(metrics.latencySamples).toBe(1)
  })

  it("survives a hydrate round trip", () => {
    const s = store([])
    s.recordUsage({
      sessionID: "ses_speed",
      model: { providerID: "opendesign", id: "deepseek-v4.1-flash" },
      cost: 0.01,
      tokens: { input: 1000, output: 500, cache: { read: 0, write: 0 } },
      latencyMs: 5_000,
      at: NOW,
    })
    const hydrated = LedgerStore.hydrate(JSON.parse(JSON.stringify(s.export())))
    const restored = new LedgerStore(hydrated.ledger)
    const metrics = restored.snapshotMetrics().byModel["opendesign/deepseek-v4.1-flash"]!
    expect(metrics.outputTokensPerSecond).toBeCloseTo(100, 1)
    expect(metrics.latencySamples).toBe(1)
  })
})

/**
 * The OpenDesign quota window is estimated from this router's own recorded
 * usage, because OpenDesign publishes no quota API for an inference key. That
 * estimate is only as good as the history it reads.
 *
 * It used to read `usageEvents()`, which returns the raw array alone. Once the
 * raw array overflows, the oldest events are folded into hourly buckets and
 * leave that array, so the estimate silently shrank as history aged. On a real
 * account the 7-day figure read $3.19 while the ledger had recorded $6.72, and
 * the router described a two-thirds-unused subscription as almost untouched
 * while every prompt was routed to it on that basis.
 */
describe("the quota estimate reads folded history, not just raw events", () => {
  it("reports the same total from the event stream as the aggregate does", () => {
    // Enough events over ten days to force the overflow fold.
    const events = Array.from({ length: 4_000 }, (_, i) => event((i / 4_000) * 10 * DAY, i))
    const s = store(events)
    s.prune(NOW)

    const aggregated = s.aggregate({ since: NOW - 7 * DAY, until: NOW })
    const streamed = s.usageEvents({ since: NOW - 7 * DAY, until: NOW })
      .filter((e) => e.providerID === "opendesign")
      .reduce((sum, e) => sum + e.usd, 0)

    // The two must agree. Raw-only history under-reports by whatever was folded.
    expect(streamed).toBeCloseTo(aggregated.usd, 6)
  })

  it("still accounts for history older than the raw horizon", () => {
    const events = Array.from({ length: 3_000 }, (_, i) => event((i / 3_000) * 10 * DAY, i))
    const s = store(events)
    s.prune(NOW)
    const rawOnly = (s as any).ledger.usage
      .filter((e: UsageEvent) => e.at >= NOW - 7 * DAY)
      .reduce((sum: number, e: UsageEvent) => sum + e.usd, 0)
    const streamed = s
      .usageEvents({ since: NOW - 7 * DAY, until: NOW })
      .reduce((sum, e) => sum + e.usd, 0)
    // If folding were ignored the stream would match rawOnly and lose history.
    expect(streamed).toBeGreaterThan(rawOnly)
    expect(streamed).toBeCloseTo(s.aggregate({ since: NOW - 7 * DAY, until: NOW }).usd, 6)
  })

  it("preserves per-model attribution for folded history", () => {
    const events = Array.from({ length: 3_000 }, (_, i) =>
      event((i / 3_000) * 10 * DAY, i, {
        modelID: i % 2 === 0 ? "deepseek-v4.1-flash" : "glm-5.3-flash",
      }),
    )
    const s = store(events)
    s.prune(NOW)
    const streamed = s.usageEvents({ since: NOW - 7 * DAY, until: NOW })
    const models = new Set(streamed.map((e) => e.modelID))
    // Both models must survive the fold; collapsing them would misattribute
    // pools, since Design Plan and plan-model credits are separate.
    expect(models.has("deepseek-v4.1-flash")).toBe(true)
    expect(models.has("glm-5.3-flash")).toBe(true)
  })

  it("keeps the raw path unchanged when no folding has happened", () => {
    const s = store([event(HOUR, 0), event(2 * HOUR, 1)])
    expect(s.usageEvents({ since: NOW - DAY, until: NOW })).toHaveLength(2)
  })
})
