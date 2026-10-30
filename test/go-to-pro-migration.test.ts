import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, validateSettings } from "../src/core/config.js"
import { decideCompaction, CONTEXT_SAFE_WINDOW_FRACTION } from "../src/core/context/strategy.js"
import { resolvePlanWithReason } from "../src/core/plans/catalog.js"
import { describePlan } from "../src/core/util.js"

/**
 * Regression guards for the OpenDesign Go to Pro migration.
 *
 * The owner upgraded from Go ($10) to Pro ($100). During the Go era the router
 * compacted eagerly to keep long sessions on a cheap provider, and a config
 * carried `contextManagement.mode` values and context thresholds chosen for a
 * small allowance. Those values must not survive into a Pro profile, and a Go
 * plan identifier must never quietly take effect on a Pro configuration.
 *
 * These tests are deliberately about *cross-contamination*, not about any
 * single number. The 328,000 window itself is a separate question; what is
 * guarded here is that an old plan's behaviour cannot attach itself to the
 * active plan.
 */

const proSettings = () =>
  structuredClone({
    ...DEFAULT_SETTINGS,
    providers: {
      ...DEFAULT_SETTINGS.providers,
      opendesign: { ...DEFAULT_SETTINGS.providers.opendesign, enabled: true, plan: "pro" },
    },
  })

describe("a Pro profile cannot inherit Go-era compaction", () => {
  it("defaults to native mode, which does not compact early", () => {
    // native is the only mode that leaves a transcript alone until it genuinely
    // cannot fit. If a future default flips to budget-optimized, every Pro user
    // silently gets the Go behaviour back.
    expect(DEFAULT_SETTINGS.contextManagement.mode).toBe("native")
    expect(DEFAULT_SETTINGS.contextManagement.compactAtTokens).toBe(0)
  })

  it("does not compact a transcript that fits, in any mode that is not budget-optimized", () => {
    const settings = DEFAULT_SETTINGS.contextManagement
    for (const mode of ["native", "conservative"] as const) {
      const decision = decideCompaction({
        mode,
        settings,
        contextTokens: 200_000,
        effectiveWindow: 328_000,
      })
      expect(decision.compact, `${mode} must leave a fitting transcript alone`).toBe(false)
      expect(decision.hardLimit).toBe(false)
    }
  })

  it("never compacts early even when compactAtTokens is set, unless budget-optimized", () => {
    // compactAtTokens is the old early-compaction knob. In native it must be
    // inert, because a leftover small value from the Go era would otherwise
    // keep cutting long sessions on a large Pro allowance.
    const settings = { ...DEFAULT_SETTINGS.contextManagement, compactAtTokens: 50_000 }
    for (const mode of ["native", "conservative"] as const) {
      const decision = decideCompaction({
        mode,
        settings,
        contextTokens: 120_000,
        effectiveWindow: 1_000_000,
      })
      expect(decision.compact, `${mode} must ignore compactAtTokens`).toBe(false)
    }
  })

  it("compacts only at the real window boundary in native mode", () => {
    const settings = DEFAULT_SETTINGS.contextManagement
    const window = 1_048_000
    const boundary = Math.floor(window * CONTEXT_SAFE_WINDOW_FRACTION)

    const justUnder = decideCompaction({
      mode: "native",
      settings,
      contextTokens: boundary - 40_000,
      effectiveWindow: window,
    })
    expect(justUnder.compact).toBe(false)

    const over = decideCompaction({
      mode: "native",
      settings,
      contextTokens: boundary,
      effectiveWindow: window,
    })
    expect(over.compact).toBe(true)
    expect(over.hardLimit).toBe(true)
  })

  it("keeps budget-optimized available but opt-in", () => {
    // The legacy subsystem must still work, so it can be productized later. It
    // just must not be reachable without someone choosing it.
    const settings = { ...DEFAULT_SETTINGS.contextManagement, compactAtTokens: 50_000 }
    const decision = decideCompaction({
      mode: "budget-optimized",
      settings,
      contextTokens: 120_000,
      effectiveWindow: 1_000_000,
      cheapestWindow: 232_000,
    })
    expect(decision.compact).toBe(true)
    expect(decision.hardLimit).toBe(false)
  })
})

describe("a Go plan identifier cannot outrank an active Pro configuration", () => {
  it("resolves the configured Pro plan, not the provider default", () => {
    const resolved = resolvePlanWithReason("opendesign", "pro")
    expect(resolved.resolution).toBe("exact")
    expect(resolved.planID).toBe("pro")
    expect(resolved.plan?.monthlyPriceUsd).toBe(100)
    // Go is $10/month; Pro must not resolve to it.
    expect(resolvePlanWithReason("opendesign", "pro").plan?.monthlyPriceUsd).not.toBe(10)
  })

  it("does not fall back to Go when the plan is unknown", () => {
    // Getting this wrong is worse than a wrong window: the router would model
    // a $100 subscription against a $10 allowance and block every session.
    const resolved = resolvePlanWithReason("opendesign", "not-a-plan")
    expect(resolved.resolution).toBe("unknown")
    expect(resolved.plan).toBeUndefined()
    expect(resolved.planID).toBeUndefined()
  })

  it("describes an unknown plan as unresolved rather than naming a tier", () => {
    const label = describePlan(undefined, "not-a-plan")
    expect(label).toMatch(/unresolved/)
    expect(label).not.toMatch(/\bgo\b/i)
  })

  it("keeps Go resolvable for a profile that actually chose it", () => {
    // A guard against over-correcting: Go must still work for Go users.
    const resolved = resolvePlanWithReason("opendesign", "go")
    expect(resolved.resolution).toBe("exact")
    expect(resolved.planID).toBe("go")
    expect(resolved.plan?.monthlyPriceUsd).toBe(10)
  })

  it("survives a settings round-trip with the Pro plan and native context", () => {
    // validateSettings is what turns the persisted JSON into live settings. A
    // default that overwrites an explicit value here would silently undo the
    // migration on the next load.
    const loaded = validateSettings(
      {
        providers: { opendesign: { enabled: true, plan: "pro" } },
        contextManagement: { mode: "native", enabled: true, compactAtTokens: 0 },
      },
      DEFAULT_SETTINGS,
    ).settings
    expect(loaded.providers.opendesign?.plan).toBe("pro")
    expect(loaded.contextManagement.mode).toBe("native")
    expect(loaded.contextManagement.compactAtTokens).toBe(0)
  })

  it("does not let a project file downgrade the plan silently", () => {
    // applyProjectGuardrails is meant to tighten, not to change which
    // subscription is being accounted for.
    const base = proSettings()
    expect(base.providers.opendesign.plan).toBe("pro")
    expect(base.providers.opendesign.enabled).toBe(true)
  })
})
