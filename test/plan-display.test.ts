import { describe, expect, it } from "vitest"
import { resolvePlanWithReason } from "../src/core/plans/catalog.js"
import { describePlan } from "../src/core/util.js"
import { probeOpenDesignQuota } from "../src/core/quota/opendesign.js"
import { DEFAULT_SETTINGS } from "../src/core/config.js"

/**
 * An unrecognized plan id must never be presented as a tier the build
 * understands. It must also not silently become the default tier, because that
 * would imply an allowance that was never established.
 */

describe("describing a plan to a user", () => {
  it("uses the resolved id when the plan is known", () => {
    const resolved = resolvePlanWithReason("opendesign", "pro")
    expect(describePlan(resolved.plan?.planID, "pro")).toBe("pro")
  })

  it("marks an unrecognized id as unresolved and keeps what was typed", () => {
    const resolved = resolvePlanWithReason("opendesign", "profesional")
    const shown = describePlan(resolved.plan?.planID, "profesional")
    expect(shown).toBe("unresolved (profesional)")
    // It must be obvious that this is not a catalog tier.
    expect(shown).toMatch(/^unresolved/)
  })

  it("does not invent a tier when nothing was configured", () => {
    expect(describePlan(undefined, undefined)).toBe("unresolved")
    expect(describePlan(undefined, "   ")).toBe("unresolved")
  })

  it("reaches the quota snapshot for an unknown plan", async () => {
    const result = await probeOpenDesignQuota({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS.providers.opendesign)!,
        enabled: true,
        plan: "profesional",
        monthlyCreditsUsd: undefined,
      },
      apiKey: "sk-a-test-inference-key-value",
      usage: [],
      now: () => Date.UTC(2026, 9, 29, 12),
    })
    expect(result.snapshot.plan).toBe("unresolved (profesional)")
    // Never the maintainer's own tier.
    expect(result.snapshot.plan).not.toBe("pro")
  })
})
