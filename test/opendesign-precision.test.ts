import { describe, expect, it } from "vitest"
import { loadSettings } from "../src/core/config.js"
import { probeOpenDesignQuota } from "../src/core/quota/opendesign.js"
import type { ProviderSettings } from "../src/core/types.js"

/**
 * OpenDesign precision.
 *
 * The situation these tests encode, measured against the real account on
 * 2026-11-04: the panel showed "5% monthly" while the account page said 42%
 * used. Both numbers were true of different things. The router can only see
 * traffic it routed itself, and the account had been used before the router
 * existed.
 *
 * There is no endpoint to read the truth: `GET /v1/models` returns 200 with an
 * inference key while /v1/usage, /v1/me, /v1/credits, /v1/billing, /v1/account,
 * /v1/subscription, /v1/limits, /v1/quota and /v1/workspaces all return 404, the
 * account-control host answers 401, and inference responses carry no credit
 * headers. Verified again on 2026-11-04.
 *
 * So precision comes from the user's own reading, folded in as a baseline that
 * expires with the window it describes.
 */

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
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

const run = (over: Partial<ProviderSettings> = {}, usage: unknown[] = []) =>
  probeOpenDesignQuota({
    settings: settings(over),
    apiKey: "test-key",
    usage: usage as never,
    now: () => NOW,
  })

const monthlyPct = (result: Awaited<ReturnType<typeof run>>) => result.snapshot.monthly.usedPct
const weeklyPct = (result: Awaited<ReturnType<typeof run>>) => result.snapshot.weekly.usedPct

describe("a reported baseline makes the estimate reflect the account", () => {
  it("seeds the weekly figure the account page is actually showing", async () => {
    // The account page reports Design Plan credits as a percentage of the
    // seven-day window ($90 on Pro) and resets it within a day. 42% of $90 is
    // $37.80, which is 10.5% of the $360 monthly allowance. Reading the 42% as a
    // share of the monthly figure would overstate usage by four times, so the
    // window the reading belongs to matters.
    const result = await run({ baseline: { at: NOW - 2 * HOUR, designPlanUsedUsd: 37.8 } })
    expect(weeklyPct(result)).toBeCloseTo(42, 0)
    expect(monthlyPct(result)).toBeCloseTo(10.5, 0)
  })

  it("keeps the provider-reported state distinct from a verified read", async () => {
    const result = await run({ baseline: { at: NOW - 2 * HOUR, designPlanUsedUsd: 37.8 } })
    expect(result.state).toBe("estimated")
    expect(result.snapshot.source).toBe("estimate")
  })

  it("says the figure started from the user's reading, not from nothing", async () => {
    const result = await run({ baseline: { at: NOW - 2 * HOUR, designPlanUsedUsd: 37.8 } })
    expect(result.snapshot.notes[0]).toContain("Starts from the usage you reported")
    expect(result.snapshot.notes.some((note) => note.includes("control key"))).toBe(true)
  })

  it("adds the router's own traffic on top of the reading", async () => {
    const usage = [
      {
        providerID: "opendesign",
        modelID: "deepseek-v4.1-flash",
        at: NOW - HOUR,
        input: 1_000_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        usd: 2,
      },
    ]
    const withoutBaseline = await run({}, usage)
    const withBaseline = await run({ baseline: { at: NOW - 3 * HOUR, designPlanUsedUsd: 37.8 } }, usage)
    expect(withBaseline.snapshot.monthly.usedUsd ?? 0).toBeGreaterThan(withoutBaseline.snapshot.monthly.usedUsd ?? 0)
  })
})

describe("a baseline expires with its window", () => {
  it("drops a reading older than the monthly window", async () => {
    const result = await run({ baseline: { at: NOW - 40 * DAY, designPlanUsedUsd: 37.8 } })
    expect(monthlyPct(result)).toBe(0)
    expect(result.snapshot.notes[0]).not.toContain("Starts from the usage you reported")
  })

  it("drops a reading from a previous weekly window but keeps it for the month", async () => {
    const result = await run({ baseline: { at: NOW - 10 * DAY, designPlanUsedUsd: 37.8 } })
    // The 7-day window has reset since, so its figure is not seeded.
    expect(weeklyPct(result)).toBe(0)
    // The monthly window still covers the reading.
    expect(monthlyPct(result)).toBeCloseTo(10.5, 0)
  })
})

describe("a malformed baseline is refused rather than half-applied", () => {
  it("ignores a baseline with no usable amount and says so", () => {
    const loaded = loadSettings({
      home: "/nonexistent-home",
      options: { providers: { opendesign: { baseline: { at: NOW } } } },
    })
    expect(loaded.settings.providers.opendesign?.baseline).toBeUndefined()
    expect(loaded.warnings.some((warning) => warning.includes("baseline"))).toBe(true)
  })

  it("ignores a baseline with no timestamp", () => {
    const loaded = loadSettings({
      home: "/nonexistent-home",
      options: { providers: { opendesign: { baseline: { designPlanUsedUsd: 10 } } } },
    })
    expect(loaded.settings.providers.opendesign?.baseline).toBeUndefined()
  })

  it("ignores a baseline dated in the future", () => {
    const loaded = loadSettings({
      home: "/nonexistent-home",
      options: { providers: { opendesign: { baseline: { at: Date.now() + DAY, designPlanUsedUsd: 10 } } } },
    })
    expect(loaded.settings.providers.opendesign?.baseline).toBeUndefined()
  })

  it("accepts an ISO timestamp and a numeric string", () => {
    const loaded = loadSettings({
      home: "/nonexistent-home",
      options: {
        providers: { opendesign: { baseline: { at: "2026-11-04T10:00:00Z", designPlanUsedUsd: "151.2" } } },
      },
    })
    expect(loaded.settings.providers.opendesign?.baseline?.designPlanUsedUsd).toBeCloseTo(151.2, 5)
    expect(loaded.settings.providers.opendesign?.baseline?.at).toBe(Date.parse("2026-11-04T10:00:00Z"))
  })
})

describe("a reading stops applying when its window resets", () => {
  it("drops the weekly figure once the supplied reset time has passed, even if the reading is recent", async () => {
    // Read two hours ago, but the week it describes resets in one hour. After
    // that reset the reading belongs to a window that no longer exists.
    const result = await probeOpenDesignQuota({
      settings: settings({
        baseline: {
          at: NOW - 2 * HOUR,
          designPlanUsedUsd: 37.8,
          weeklyResetsAt: NOW + HOUR,
        },
      }),
      apiKey: "test-key",
      usage: [],
      now: () => NOW + 2 * HOUR,
    })
    expect(result.snapshot.weekly.usedPct).toBe(0)
  })

  it("keeps the figure while the window it describes is still open", async () => {
    const result = await probeOpenDesignQuota({
      settings: settings({
        baseline: {
          at: NOW - 2 * HOUR,
          designPlanUsedUsd: 37.8,
          weeklyResetsAt: NOW + 5 * HOUR,
        },
      }),
      apiKey: "test-key",
      usage: [],
      now: () => NOW,
    })
    expect(result.snapshot.weekly.usedPct).toBeCloseTo(42, 0)
  })

  it("says plainly when it had to fall back to an age-based guess", async () => {
    const result = await probeOpenDesignQuota({
      settings: settings({ baseline: { at: NOW - HOUR, designPlanUsedUsd: 37.8 } }),
      apiKey: "test-key",
      usage: [],
      now: () => NOW,
    })
    expect(result.snapshot.notes.some((note) => note.includes("weeklyResetsAt"))).toBe(true)
  })
})

describe("a percentage from the account page is converted, not guessed", () => {
  it("reads 42% as the seven-day window by default and lands where the user could check", async () => {
    // On Pro the seven-day Design Plan cap is $90, so 42% is $37.80.
    const result = await probeOpenDesignQuota({
      settings: settings({ baseline: { at: NOW - HOUR, designPlanUsedPct: 42 } }),
      apiKey: "test-key",
      usage: [],
      now: () => NOW,
    })
    expect(result.snapshot.weekly.usedPct).toBeCloseTo(42, 0)
    expect(result.snapshot.weekly.usedUsd ?? 0).toBeCloseTo(37.8, 2)
    expect(result.snapshot.monthly.usedPct).toBeCloseTo(10.5, 0)
  })

  it("honours an explicit monthly reading", async () => {
    const result = await probeOpenDesignQuota({
      settings: settings({ baseline: { at: NOW - HOUR, designPlanUsedPct: 42, pctOf: "monthly" } }),
      apiKey: "test-key",
      usage: [],
      now: () => NOW,
    })
    expect(result.snapshot.monthly.usedPct).toBeCloseTo(42, 0)
  })

  it("prefers an explicit dollar figure over a percentage", async () => {
    const result = await probeOpenDesignQuota({
      settings: settings({ baseline: { at: NOW - HOUR, designPlanUsedUsd: 45, designPlanUsedPct: 5 } }),
      apiKey: "test-key",
      usage: [],
      now: () => NOW,
    })
    expect(result.snapshot.weekly.usedUsd ?? 0).toBeCloseTo(45, 2)
  })

  it("says so instead of silently using zero when the cap is unknown", async () => {
    const result = await probeOpenDesignQuota({
      // An unrecognised plan leaves no cap to divide by.
      settings: { ...settings({ baseline: { at: NOW - HOUR, designPlanUsedPct: 42 } }), plan: "mystery-tier" },
      apiKey: "test-key",
      usage: [],
      now: () => NOW,
    })
    expect(result.snapshot.notes.some((note) => note.includes("could not be converted"))).toBe(true)
  })

  it("clamps a nonsensical percentage through config validation", () => {
    const loaded = loadSettings({
      home: "/nonexistent-home",
      options: { providers: { opendesign: { baseline: { at: NOW, designPlanUsedPct: 420 } } } },
    })
    expect(loaded.settings.providers.opendesign?.baseline?.designPlanUsedPct).toBe(100)
  })

  it("accepts a percentage on its own with no dollar figure", () => {
    const loaded = loadSettings({
      home: "/nonexistent-home",
      options: { providers: { opendesign: { baseline: { at: NOW, designPlanUsedPct: 42 } } } },
    })
    expect(loaded.settings.providers.opendesign?.baseline?.designPlanUsedPct).toBe(42)
    expect(loaded.warnings.filter((w) => w.includes("baseline"))).toHaveLength(0)
  })
})
