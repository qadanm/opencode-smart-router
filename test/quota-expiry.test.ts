import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { buildRegistry } from "../src/core/models/registry.js"
import { routeTask } from "../src/core/routing/engine.js"
import { classifyTask } from "../src/core/classify/classifier.js"
import { providerPressure, quotaExpiryDiscount } from "../src/core/policy/eligibility.js"
import type { ProviderQuotaSnapshot } from "../src/core/types.js"

/**
 * Prepaid allowance that expires unused is a sunk cost.
 *
 * The router used to rank purely on what a request would cost, which is right
 * for pay-as-you-go money and wrong for a subscription window about to reset:
 * the credits are already paid for, and the alternative to spending them is
 * losing them. On the owner's real account that meant every prompt going to the
 * provider with the larger unspent pool while a nearly-full weekly window with
 * hours left on it went unused.
 *
 * These pin the discount that makes the second case visible, and the guards that
 * stop it from becoming a licence to overspend.
 */

const HOUR = 60 * 60 * 1000
const NOW = 1_800_000_000_000

const window = (usedPct: number, resetsInMs?: number) => ({
  usedPct,
  remainingPct: 100 - usedPct,
  source: "provider" as const,
  ...(resetsInMs === undefined ? {} : { resetsAt: NOW + resetsInMs }),
})

const snapshot = (input: {
  providerID: string
  weekly: ReturnType<typeof window>
  monthly?: ReturnType<typeof window>
  source?: "provider" | "estimate"
}) =>
  ({
    providerID: input.providerID,
    label: input.providerID,
    plan: "x",
    source: input.source ?? "provider",
    fetchedAt: NOW,
    stale: false,
    rolling: { usedPct: 0, remainingPct: 100, source: "unknown" as const },
    weekly: input.weekly,
    monthly: input.monthly ?? { usedPct: 0, remainingPct: 100, source: "unknown" as const },
    models: {},
    notes: [],
  }) as unknown as ProviderQuotaSnapshot

describe("expiring quota is worth spending", () => {
  it("discounts a pool whose window is about to reset", () => {
    // 90% used but resetting in two hours: the last 10% is about to be lost.
    const expiring = snapshot({ providerID: "a", weekly: window(90, 2 * HOUR) })
    // A multiplier on pressure, so a discount is a value below one.
    expect(quotaExpiryDiscount(expiring, NOW)).toBeLessThan(1)
  })

  it("gives no discount to a pool with almost nothing left", () => {
    // Deliberately not a reward for running dry. At 99% there is too little
    // headroom to serve real work, so chasing it would strand a task mid-way.
    const nearlyDry = snapshot({ providerID: "a", weekly: window(99, 2 * HOUR) })
    expect(quotaExpiryDiscount(nearlyDry, NOW)).toBe(1)
  })

  it("gives no discount when the reset is far away", () => {
    const distant = snapshot({ providerID: "a", weekly: window(90, 30 * 24 * HOUR) })
    expect(quotaExpiryDiscount(distant, NOW)).toBe(1)
  })

  it("starts discounting only inside the expiry horizon", () => {
    // One hour inside the 24h horizon, versus one hour outside it. Without the
    // horizon check the far case would still produce a (negative) urgency and
    // silently round to no discount, which looks identical but means the guard
    // was never load-bearing.
    const inside = snapshot({ providerID: "a", weekly: window(90, 23 * HOUR) })
    const outside = snapshot({ providerID: "a", weekly: window(90, 25 * HOUR) })
    expect(quotaExpiryDiscount(inside, NOW)).toBeLessThan(1)
    expect(quotaExpiryDiscount(outside, NOW)).toBe(1)
  })

  it("gives no discount when nothing is spent yet", () => {
    // An empty pool is not "about to be wasted", it is simply untouched. Without
    // the commitment guard this case would still produce a zero discount, so the
    // test would pass for the wrong reason and the guard would go unchecked.
    const untouched = snapshot({ providerID: "a", weekly: window(0, 2 * HOUR) })
    const touched = snapshot({ providerID: "a", weekly: window(60, 2 * HOUR) })
    expect(quotaExpiryDiscount(untouched, NOW)).toBe(1)
    expect(quotaExpiryDiscount(touched, NOW)).toBeLessThan(1)
  })

  it("gives no discount when the provider never reported a reset time", () => {
    const noReset = snapshot({ providerID: "a", weekly: window(90) })
    expect(quotaExpiryDiscount(noReset, NOW)).toBe(1)
  })

  it("is bounded, so expiring quota cannot justify an unbounded overspend", () => {
    const expiring = snapshot({ providerID: "a", weekly: window(90, HOUR) })
    expect(quotaExpiryDiscount(expiring, NOW)).toBeLessThanOrEqual(1.35)
  })

  it("lowers the pressure of an expiring pool", () => {
    const expiring = snapshot({ providerID: "a", weekly: window(90, 2 * HOUR) })
    const distant = snapshot({ providerID: "a", weekly: window(90, 30 * 24 * HOUR) })
    expect(providerPressure(expiring, NOW)).toBeLessThan(providerPressure(distant, NOW))
  })

  it("does not lower pressure below the floor of what the pool has left", () => {
    const expiring = snapshot({ providerID: "a", weekly: window(90, HOUR) })
    // Still more expensive than an untouched provider: spending down quota you
    // are about to lose is worth something, but it is not free.
    const untouched = snapshot({ providerID: "a", weekly: window(0, 30 * 24 * HOUR) })
    expect(providerPressure(expiring, NOW)).toBeGreaterThan(providerPressure(untouched, NOW))
  })
})

describe("routing prefers quota that is about to expire", () => {
  /**
   * Two pools priced close together, so the only difference the router can see
   * is which one is about to lose its allowance. This isolates the mechanism
   * from the separate question of how far a discount should reach.
   */
  const pair = (expiringResetsIn: number): ProviderQuotaSnapshot[] => [
    snapshot({
      providerID: "opencode-go",
      weekly: window(60, 60 * 24 * HOUR),
      monthly: window(30, 30 * 24 * HOUR),
    }),
    snapshot({
      providerID: "commandcode",
      weekly: window(88, expiringResetsIn),
      monthly: window(43, 24 * 24 * HOUR),
    }),
  ]

  const decide = (quotaSnapshots: ProviderQuotaSnapshot[]) => {
    const settings: any = structuredClone(DEFAULT_SETTINGS)
    settings.providers = {
      "opencode-go": { enabled: true, plan: "go", probeUsage: true, allowExtraUsage: false },
      commandcode: { enabled: true, plan: "goat", probeUsage: true, allowExtraUsage: false },
      opendesign: { enabled: true, plan: "pro", probeUsage: true, allowExtraUsage: false, subscriptionOnly: true },
    }
    const registry = buildRegistry({ live: [], settings, definitions: [] })
    const contextTokens = 20_000
    const task = classifyTask({
      text: "implement a feature in src/game.ts",
      files: [],
      contextTokens,
      recentFailures: 0,
    })
    const result: any = routeTask({
      task,
      settings,
      mode: "balanced",
      runtime: "automatic",
      models: registry.approved(),
      current: undefined,
      session: {
        sessionID: "x",
        manualOverride: false,
        premiumOneShot: false,
        paused: false,
        contextTokens,
        cacheReadTokens: 0,
        stepCount: 5,
        status: "idle",
        failures: [],
        retries: 0,
        createdAt: 0,
        updatedAt: 0,
      } as any,
      quota: quotaSnapshots,
      premium: { mode: "off", monthlyBudgetUsd: 0, spentUsd: 0, remainingUsd: 0, oneShotGranted: false },
      contextTokens,
      cachedTokens: 0,
      dryRun: true,
      now: NOW,
      cooldowns: {},
      providerCooldowns: {},
    })
    return result.decision
  }

  const pressureOf = (decision: any, providerID: string) =>
    (decision.candidates ?? []).find((c: any) => c.model.providerID === providerID)?.quotaPressure

  it("lowers an expiring pool's pressure relative to a distant one", () => {
    const expiring = decide(pair(2 * HOUR))
    const distant = decide(pair(28 * 24 * HOUR))
    // The same pool, the same fill level; only the reset time differs.
    expect(pressureOf(expiring, "commandcode")).toBeLessThan(pressureOf(distant, "commandcode"))
  })

  it("leaves pressure untouched when nothing is about to expire", () => {
    const distant = decide(pair(28 * 24 * HOUR))
    // 88% weekly plus 43% monthly, with no expiry relief.
    const expected = 1 + 1.5 * 0.43 ** 2 + 2.5 * 0.88 ** 2
    expect(pressureOf(distant, "commandcode")).toBeCloseTo(expected, 4)
  })
})
