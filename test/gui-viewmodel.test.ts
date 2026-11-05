import { describe, expect, it } from "vitest"
import {
  formatPercent,
  formatUsd,
  formatReset,
  formatWindowUsed,
  orderCandidateRows,
  statusLine,
  summariseDecision,
  toCandidateRow,
  toProviderRow,
  type CandidateRow,
} from "../src/gui/viewmodel.js"

/**
 * The view-model is the contract between what the router decides and what a user
 * is told. These tests exist so the panel cannot quietly start lying: a blocked
 * model must keep its reason, a stale number must keep its label, and the
 * ranking must stay explainable.
 */

const candidate = (over: Partial<CandidateRow> & { key: string }): CandidateRow => ({
  name: over.key,
  tier: 2,
  verdict: "eligible",
  reason: "eligible",
  estimatedUsd: 0.004,
  effectiveCost: 0.004,
  successProbability: 0.9,
  adjustments: [],
  ...over,
})

describe("formatting", () => {
  it("keeps money at the precision the router estimates in", () => {
    expect(formatUsd(0)).toBe("$0")
    expect(formatUsd(0.0042)).toBe("$0.0042")
    expect(formatUsd(0.42)).toBe("$0.420")
    expect(formatUsd(12.5)).toBe("$12.50")
    expect(formatUsd(Number.NaN)).toBe("—")
  })

  it("never renders an unknown percentage as zero", () => {
    expect(formatPercent(62.4)).toBe("62%")
    expect(formatPercent(Number.NaN)).toBe("—")
  })
})

describe("candidate rows", () => {
  it("marks the chosen model only when it was actually eligible", () => {
    const row = toCandidateRow(
      {
        model: { providerID: "a", modelID: "one" },
        name: "One",
        tier: 2,
        eligible: true,
        reason: "cheapest eligible",
        estimatedUsd: 1,
        effectiveCost: 1,
        successProbability: 0.9,
        switchPenaltyUsd: 0,
        quotaPressure: 1,
        retained: true,
      },
      "a/one",
    )
    expect(row.verdict).toBe("chosen")

    // A model cannot be "chosen" while the engine says it is ineligible.
    const impossible = toCandidateRow(
      {
        model: { providerID: "a", modelID: "two" },
        name: "Two",
        tier: 2,
        eligible: false,
        reason: "weekly allowance 94% used",
        estimatedUsd: 1,
        effectiveCost: 1,
        successProbability: 0.9,
        switchPenaltyUsd: 0,
        quotaPressure: 1,
        retained: true,
      },
      "a/two",
    )
    expect(impossible.verdict).toBe("blocked")
  })

  it("keeps the engine's reason verbatim", () => {
    const reason = "Provider is disabled in router settings"
    const row = toCandidateRow(
      {
        model: { providerID: "x", modelID: "y" },
        name: "Y",
        tier: 3,
        eligible: false,
        reason,
        estimatedUsd: 0,
        effectiveCost: 0,
        successProbability: 0,
        switchPenaltyUsd: 0,
        quotaPressure: 0,
        retained: false,
      },
      undefined,
    )
    expect(row.reason).toBe(reason)
  })

  it("explains every multiplier that moved the ranking", () => {
    const row = toCandidateRow(
      {
        model: { providerID: "x", modelID: "z" },
        name: "Z",
        tier: 2,
        eligible: true,
        reason: "eligible",
        estimatedUsd: 1,
        effectiveCost: 0.5,
        successProbability: 0.8,
        switchPenaltyUsd: 0.25,
        quotaPressure: 1,
        retained: true,
        creditMultiplier: 0.5,
        speedFactor: 2,
        marginalPriceFactor: 0.5,
      },
      undefined,
    )
    expect(row.adjustments).toEqual(["0.5x plan credits", "2x measured speed", "0.5x expiring allowance", "$0.250 switch cost"])
  })

  it("says nothing when no multiplier applied", () => {
    const row = toCandidateRow(
      {
        model: { providerID: "x", modelID: "plain" },
        name: "Plain",
        tier: 2,
        eligible: true,
        reason: "eligible",
        estimatedUsd: 1,
        effectiveCost: 1,
        successProbability: 0.8,
        switchPenaltyUsd: 0,
        quotaPressure: 1,
        retained: true,
        creditMultiplier: 1,
        speedFactor: 1,
        marginalPriceFactor: 1,
      },
      undefined,
    )
    expect(row.adjustments).toEqual([])
  })
})

describe("ordering", () => {
  it("puts the winner first, then affordable options by cost, then blocked ones", () => {
    const rows = orderCandidateRows([
      candidate({ key: "c/cheap", effectiveCost: 0.001 }),
      candidate({ key: "b/blocked", verdict: "blocked", effectiveCost: 0 }),
      candidate({ key: "a/chosen", verdict: "chosen", effectiveCost: 0.01 }),
      candidate({ key: "d/pricey", effectiveCost: 0.02 }),
    ])
    expect(rows.map((row) => row.key)).toEqual(["a/chosen", "c/cheap", "d/pricey", "b/blocked"])
  })

  it("keeps blocked models in the list rather than hiding them", () => {
    const rows = orderCandidateRows([candidate({ key: "b/x", verdict: "blocked" })])
    expect(rows).toHaveLength(1)
  })
})

describe("decision summary", () => {
  it("returns undefined when there is no decision", () => {
    expect(summariseDecision(undefined)).toBeUndefined()
    expect(summariseDecision(null)).toBeUndefined()
  })

  it("counts eligible and blocked candidates from the engine's verdicts", () => {
    const view = summariseDecision({
      id: "dec_1",
      at: 1,
      sessionID: "ses_1",
      mode: "balanced",
      dryRun: false,
      runtime: "automatic",
      task: { kind: "code", tier: 2 },
      chosen: { providerID: "a", id: "chosen" },
      switched: true,
      switchReason: "cheaper by 40%",
      reasons: ["cheapest above the intelligence floor"],
      warnings: [],
      candidates: [
        {
        model: { providerID: "a", modelID: "chosen" },
        name: "Chosen",
          tier: 2,
          eligible: true,
          reason: "cheapest eligible",
          estimatedUsd: 0.004,
          effectiveCost: 0.004,
          successProbability: 0.87,
          switchPenaltyUsd: 0,
          quotaPressure: 1,
          retained: true,
        },
        {
          model: { providerID: "a", modelID: "blocked" },
          name: "Blocked",
          tier: 2,
          eligible: false,
          reason: "weekly allowance 94% used",
          estimatedUsd: 0,
          effectiveCost: 0,
          successProbability: 0,
          switchPenaltyUsd: 0,
          quotaPressure: 0,
          retained: false,
        },
      ],
      premium: { state: "denied" },
      quota: [],
      contextTokens: 8_000,
      cachedTokens: 0,
      estimatedUsd: 0.004,
      needsPremiumApproval: false,
      manualOverride: false,
    } as never)

    expect(view?.chosen).toBe("a/chosen")
    expect(view?.eligibleCount).toBe(1)
    expect(view?.blockedCount).toBe(1)
    expect(view?.rows[0]?.verdict).toBe("chosen")
    expect(view?.rows[1]?.reason).toBe("weekly allowance 94% used")
  })
})

describe("provider rows", () => {
  const NOW = 1_700_000_000_000
  const snapshot = (over: Record<string, unknown> = {}) =>
    ({
      providerID: "opendesign",
      label: "OpenDesign Go",
      plan: "pro",
      fetchedAt: NOW,
      stale: false,
      monthly: { usedPct: 62, remainingPct: 38, usedUsd: 223, capUsd: 360, resetsAt: NOW + 6 * 3_600_000, source: "provider" },
      weekly: { usedPct: 10, remainingPct: 90, usedUsd: 9, capUsd: 90, resetsAt: NOW + 2 * 86_400_000, source: "provider" },
      rolling: { usedPct: 4, remainingPct: 96, usedUsd: 1, capUsd: 25, source: "provider" },
      notes: [],
      models: {},
      ...over,
    }) as never

  it("keeps an estimate labelled as an estimate", () => {
    const row = toProviderRow(snapshot({ monthly: { usedPct: 20, remainingPct: 80, source: "estimate" } }), NOW)
    expect(row.source).toBe("estimate")
    expect(row.sourceLabel).toBe("estimated — lower bound")
  })

  it("reports every window, not just monthly", () => {
    const row = toProviderRow(snapshot(), NOW)
    expect(row.windows.map((w) => w.id)).toEqual(["fiveHour", "weekly", "monthly"])
    expect(row.windows.map((w) => w.label)).toEqual(["5h", "7d", "Monthly"])
    expect(row.windows.every((w) => w.reported)).toBe(true)
    expect(row.windows[2]!.usedPct).toBe(62)
    expect(row.windows[2]!.capUsd).toBe(360)
  })

  it("marks a window the provider does not report instead of showing 0%", () => {
    const row = toProviderRow(
      snapshot({ rolling: { usedPct: 0, remainingPct: 100, source: "unknown" } }),
      NOW,
    )
    const fiveHour = row.windows.find((w) => w.id === "fiveHour")!
    expect(fiveHour.reported).toBe(false)
    expect(fiveHour.sourceLabel).toBe("not reported")
  })

  it("treats an unknown monthly window as not reported, not as empty", () => {
    const row = toProviderRow(
      snapshot({ monthly: { usedPct: 0, remainingPct: 100, source: "unknown" } }),
      NOW,
    )
    expect(row.source).toBe("unknown")
    expect(row.windows.find((w) => w.id === "monthly")!.reported).toBe(false)
  })

  it("names the window that is actually exhausted", () => {
    const row = toProviderRow(
      snapshot({ weekly: { usedPct: 100, remainingPct: 0, exceeded: true, source: "provider" } }),
      NOW,
    )
    expect(row.exhausted).toBe(true)
    expect(row.exhaustedWindow).toBe("7d")
  })

  it("formats resets relative to now", () => {
    const row = toProviderRow(snapshot(), NOW)
    expect(row.windows.find((w) => w.id === "monthly")!.resetLabel).toBe("in 6h")
    expect(row.windows.find((w) => w.id === "weekly")!.resetLabel).toBe("in 2d")
  })

  it("surfaces a provider error instead of pretending the numbers are fine", () => {
    const row = toProviderRow(snapshot({ error: "401 Unauthorized" }), NOW)
    expect(row.error).toBe("401 Unauthorized")
  })

  it("carries stale and quota state through so the panel can say so", () => {
    const row = toProviderRow(snapshot({ stale: true, quotaState: "stale" }), NOW)
    expect(row.stale).toBe(true)
    expect(row.quotaState).toBe("stale")
  })

  it("exposes pools separately rather than summing them", () => {
    const row = toProviderRow(
      snapshot({
        pools: [
          { id: "plan", label: "Design Plan", source: "provider", monthlyUsd: 360, usedUsd: 18, remainingUsd: 342, usedPct: 5, resetKind: "billing-cycle", note: "Monthly" },
          { id: "wallet", label: "Purchased wallet", source: "provider", monthlyUsd: 40, usedUsd: 0, remainingUsd: 40, usedPct: 0, resetKind: "billing-cycle", note: "Never spent automatically" },
        ],
      }),
      NOW,
    )
    expect(row.pools).toHaveLength(2)
    expect(row.pools[0]!.remainingUsd).toBe(342)
    expect(row.pools[1]!.label).toBe("Purchased wallet")
  })
})

describe("formatReset", () => {
  const NOW = 1_700_000_000_000
  it("returns undefined when there is no reset time", () => {
    expect(formatReset(undefined, NOW)).toBeUndefined()
  })
  it("says resetting once the time has passed", () => {
    expect(formatReset(NOW - 1, NOW)).toBe("resetting")
  })
  it("uses minutes, hours, then days", () => {
    expect(formatReset(NOW + 30 * 60_000, NOW)).toBe("in 30m")
    expect(formatReset(NOW + 5 * 3_600_000, NOW)).toBe("in 5h")
    expect(formatReset(NOW + 3 * 86_400_000, NOW)).toBe("in 3d")
  })
})

describe("status line", () => {
  it("says so when there is no model yet rather than showing a blank", () => {
    expect(statusLine({ runtime: "automatic", mode: "balanced" })).toBe("automatic · balanced · no model yet")
  })

  it("names the provider and model when there is one", () => {
    expect(
      statusLine({
        runtime: "automatic",
        mode: "balanced",
        current: { providerID: "opendesign", id: "deepseek-v4.1-flash" },
      }),
    ).toBe("automatic · balanced · opendesign/deepseek-v4.1-flash")
  })
})

describe("estimates are shown as lower bounds", () => {
  const NOW = 1_700_000_000_000
  const snapshot = (over: Record<string, unknown> = {}) =>
    ({
      providerID: "opendesign",
      label: "OpenDesign Pro",
      plan: "pro",
      fetchedAt: NOW,
      stale: false,
      monthly: { usedPct: 5, remainingPct: 95, usedUsd: 18, capUsd: 360, source: "estimate" },
      weekly: { usedPct: 2, remainingPct: 98, source: "estimate" },
      rolling: { usedPct: 0, remainingPct: 100, source: "unknown" },
      notes: ["Estimated from this router's own OpenDesign usage. OpenDesign publishes no quota API for an inference key."],
      models: {},
      ...over,
    }) as never

  it("prefixes an estimated percentage with ≥ so it cannot read as a measurement", () => {
    const row = toProviderRow(snapshot(), NOW)
    const monthly = row.windows.find((w) => w.id === "monthly")!
    expect(monthly.lowerBound).toBe(true)
    expect(formatWindowUsed(monthly)).toBe("≥5%")
  })

  it("shows a provider-reported percentage plainly", () => {
    const row = toProviderRow(
      snapshot({ monthly: { usedPct: 42, remainingPct: 58, source: "provider" }, notes: [] }),
      NOW,
    )
    const monthly = row.windows.find((w) => w.id === "monthly")!
    expect(monthly.lowerBound).toBe(false)
    expect(formatWindowUsed(monthly)).toBe("42%")
  })

  it("carries the reason the number is a lower bound", () => {
    const row = toProviderRow(snapshot(), NOW)
    expect(row.caveat).toContain("publishes no quota API")
  })

  it("has no caveat when the provider reported the figure itself", () => {
    const row = toProviderRow(snapshot({ monthly: { usedPct: 42, remainingPct: 58, source: "provider" } }), NOW)
    expect(row.caveat).toBeUndefined()
  })

  it("never renders a percentage for an unreported window", () => {
    const row = toProviderRow(snapshot(), NOW)
    const fiveHour = row.windows.find((w) => w.id === "fiveHour")!
    expect(formatWindowUsed(fiveHour)).toBe("—")
  })
})
