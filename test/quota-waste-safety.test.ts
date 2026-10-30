import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { classifyTask } from "../src/core/classify/classifier.js"
import { buildRegistry } from "../src/core/models/registry.js"
import { routeTask } from "../src/core/routing/engine.js"
import type { ProviderQuotaSnapshot } from "../src/core/types.js"

/**
 * Expiring allowance is cheap to spend but it is not an overdraft.
 *
 * The discount exists because a prepaid dollar about to be lost costs nothing to
 * use. It must never let the router commit to a request the pool cannot afford,
 * because that request fails, and a failed request is worse than paying full
 * price on a provider with room.
 *
 * The separation that makes this work: eligibility is checked against the raw
 * estimate, and the discount only ever touches the ranking cost. These pin that
 * boundary so a future change cannot quietly fold the discount into the figure
 * that is compared against the remaining allowance.
 */

const NOW = 1_800_000_000_000
const H = 60 * 60 * 1000

const snapshot = (input: {
  providerID: string
  weekly: { usedPct: number; remainingPct: number; usedUsd?: number; capUsd?: number; resetsAt?: number }
  monthly?: { usedPct: number; remainingPct: number; usedUsd?: number; capUsd?: number }
}): ProviderQuotaSnapshot =>
  ({
    providerID: input.providerID,
    label: input.providerID,
    plan: "x",
    source: "provider",
    fetchedAt: NOW,
    stale: false,
    rolling: { usedPct: 0, remainingPct: 100, source: "unknown" },
    weekly: { source: "provider", ...input.weekly },
    monthly: input.monthly
      ? { source: "provider", ...input.monthly }
      : { usedPct: 0, remainingPct: 100, source: "unknown" },
    models: {},
    notes: [],
  }) as unknown as ProviderQuotaSnapshot

const route = (quota: ProviderQuotaSnapshot[], contextTokens: number) => {
  const settings: any = structuredClone(DEFAULT_SETTINGS)
  settings.providers = {
    "opencode-go": { enabled: true, plan: "go", probeUsage: true, allowExtraUsage: false },
    commandcode: { enabled: true, plan: "goat", probeUsage: true, allowExtraUsage: false },
    opendesign: { enabled: true, plan: "pro", probeUsage: true, allowExtraUsage: false, subscriptionOnly: true },
  }
  const registry = buildRegistry({ live: [], settings, definitions: [] })
  const task = classifyTask({
    text: "Implement a feature in src/game.ts",
    files: [],
    contextTokens,
    recentFailures: 0,
  })
  return routeTask({
    task,
    settings,
    mode: "balanced",
    runtime: "automatic",
    models: registry.approved(),
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
    quota,
    premium: { mode: "off", monthlyBudgetUsd: 0, spentUsd: 0, remainingUsd: 0, oneShotGranted: false },
    contextTokens,
    cachedTokens: 0,
    dryRun: true,
    now: NOW,
    cooldowns: {},
    providerCooldowns: {},
  }).decision
}

describe("a discount on expiring allowance is not permission to overspend", () => {
  it("reports the discounted ranking cost separately from the raw estimate", () => {
    const quota = [
      snapshot({
        providerID: "commandcode",
        weekly: { usedPct: 50, remainingPct: 50, usedUsd: 17.5, capUsd: 35, resetsAt: NOW + 2 * H },
        monthly: { usedPct: 20, remainingPct: 80, usedUsd: 14, capUsd: 70 },
      }),
      snapshot({
        providerID: "opendesign",
        weekly: { usedPct: 1, remainingPct: 99, usedUsd: 1, capUsd: 90 },
        monthly: { usedPct: 1, remainingPct: 99, usedUsd: 1, capUsd: 360 },
      }),
    ]
    const decision: any = route(quota, 20_000)
    const cc = (decision.candidates ?? []).find(
      (c: any) => c.model.providerID === "commandcode" && c.model.modelID === "deepseek-v4.1-flash",
    )
    expect(cc).toBeDefined()
    // The discount is visible, and it is strictly a ranking adjustment.
    expect(cc.marginalPriceFactor).toBeLessThan(1)
    expect(cc.effectiveCost).toBeLessThan(cc.estimatedUsd * cc.quotaPressure)
  })

  it("still refuses a request that does not fit the remaining allowance", () => {
    // A subscription-only pool with almost nothing left, however close to reset,
    // may not be chosen for a request larger than what remains. The discount must
    // not make an unaffordable request look affordable.
    const quota = [
      snapshot({
        providerID: "opendesign",
        weekly: { usedPct: 99.5, remainingPct: 0.5, usedUsd: 89.55, capUsd: 90, resetsAt: NOW + H },
        monthly: { usedPct: 99.5, remainingPct: 0.5, usedUsd: 89.55, capUsd: 90 },
      }),
      snapshot({
        providerID: "opencode-go",
        weekly: { usedPct: 40, remainingPct: 60, usedUsd: 10, capUsd: 25, resetsAt: NOW + 60 * H },
        monthly: { usedPct: 40, remainingPct: 60, usedUsd: 20, capUsd: 50 },
      }),
    ]
    const decision: any = route(quota, 200_000)
    const chosen = decision.chosen
    expect(chosen).toBeDefined()
    // Whatever is chosen, it must not be the pool that cannot pay for the work.
    expect(`${chosen.providerID}/${chosen.id}`).not.toContain("opendesign")
  })

  it("never lets a discounted pool be chosen at a cost above its headroom", () => {
    const quota = [
      snapshot({
        providerID: "commandcode",
        weekly: { usedPct: 99.9, remainingPct: 0.1, usedUsd: 34.97, capUsd: 35, resetsAt: NOW + H },
        monthly: { usedPct: 20, remainingPct: 80, usedUsd: 14, capUsd: 70 },
      }),
      snapshot({
        providerID: "opendesign",
        weekly: { usedPct: 1, remainingPct: 99, usedUsd: 1, capUsd: 90 },
        monthly: { usedPct: 1, remainingPct: 99, usedUsd: 1, capUsd: 360 },
      }),
    ]
    const decision: any = route(quota, 100_000)
    const chosen = (decision.candidates ?? []).find(
      (c: any) => c.model.providerID === decision.chosen?.providerID && c.model.modelID === decision.chosen?.id,
    )
    expect(chosen).toBeDefined()
    // The estimate of what the request costs must not exceed the pool's headroom
    // when the pool is the one that would pay for it.
    const weeklyLeft = 35 - 34.97
    if (decision.chosen.providerID === "commandcode") {
      expect(chosen.estimatedUsd).toBeLessThanOrEqual(weeklyLeft + 0.01)
    }
  })
})

describe("routing acts on expiring allowance", () => {
  const twoPools = (commandCodeResetsIn: number) => [
    snapshot({
      providerID: "commandcode",
      weekly: { usedPct: 50, remainingPct: 50, usedUsd: 17.5, capUsd: 35, resetsAt: NOW + commandCodeResetsIn },
      monthly: { usedPct: 20, remainingPct: 80, usedUsd: 14, capUsd: 70 },
    }),
    snapshot({
      providerID: "opendesign",
      weekly: { usedPct: 2, remainingPct: 98, usedUsd: 1.8, capUsd: 90 },
      monthly: { usedPct: 2, remainingPct: 98, usedUsd: 1.8, capUsd: 360 },
    }),
  ]

  it("spends a pool whose allowance is about to be lost", () => {
    // Half of $35 unspent with ninety minutes left: at the observed burn rate
    // that money is headed for the bin, so using it costs almost nothing.
    const decision: any = route(twoPools(1.5 * H), 20_000)
    expect(`${decision.chosen?.providerID}`).toBe("commandcode")
  })

  it("leaves the cheaper pool alone once the expiring one is on track", () => {
    // The same pool with three days left is being consumed at a rate that will
    // use it, so there is nothing to recover and ordinary price should rule.
    const decision: any = route(twoPools(72 * H), 20_000)
    expect(`${decision.chosen?.providerID}`).toBe("opendesign")
  })

  it("does not chase a pool that would run dry mid-request", () => {
    // $0.30 left and expiring in minutes. Spending it cannot carry a 200k-token
    // request, so the router must pay full price where there is room.
    const nearlyDry = [
      snapshot({
        providerID: "commandcode",
        weekly: { usedPct: 99.1, remainingPct: 0.9, usedUsd: 34.7, capUsd: 35, resetsAt: NOW + 0.25 * H },
        monthly: { usedPct: 20, remainingPct: 80, usedUsd: 14, capUsd: 70 },
      }),
      snapshot({
        providerID: "opendesign",
        weekly: { usedPct: 2, remainingPct: 98, usedUsd: 1.8, capUsd: 90 },
        monthly: { usedPct: 2, remainingPct: 98, usedUsd: 1.8, capUsd: 360 },
      }),
    ]
    const decision: any = route(nearlyDry, 200_000)
    expect(`${decision.chosen?.providerID}`).toBe("opendesign")
  })
})
