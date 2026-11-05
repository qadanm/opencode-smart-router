import { describe, expect, it } from "vitest"
import { providerGroups } from "../src/gui/viewmodel.js"
import { formatDecision, formatProviders } from "../src/tui/index.js"

/**
 * Providers and models, and the terminal rendering of the same data.
 *
 * The rule worth protecting: three different reasons a model is not in use must
 * stay distinguishable. Collapsing "provider has no credential", "model is
 * excluded" and "model is not approved" into "unavailable" is what makes people
 * think a model is missing.
 */

const model = (over: Partial<Parameters<typeof providerGroups>[0]["models"][number]> & { key: string }) => ({
  providerID: over.key.split("/")[0]!,
  name: over.key,
  tier: 2 as const,
  intelligence: 40,
  design: 60,
  vision: false,
  context: 200_000,
  costInput: 1,
  costOutput: 2,
  approved: true,
  excluded: false,
  ...over,
})

describe("provider groups", () => {
  const models = [
    model({ key: "opendesign/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }),
    model({ key: "opendesign/glm-5.3-flash", name: "GLM-5.3 Flash", tier: 1 }),
    model({ key: "opendesign/gpt-6-sol", name: "GPT-6 Sol", approved: false }),
    model({ key: "opendesign/old-model", name: "Old", excluded: true }),
    model({ key: "commandcode/gpt-6-luna", name: "GPT-6 Luna", providerID: "commandcode", context: 1_048_000 }),
  ]

  const groups = providerGroups({
    models,
    quota: [{ providerID: "opendesign", label: "OpenDesign Pro" }],
    activeProviders: ["opendesign"],
  })

  it("groups by provider and puts active providers first", () => {
    expect(groups.map((group) => group.providerID)).toEqual(["opendesign", "commandcode"])
  })

  it("uses the provider's own label when it has one", () => {
    expect(groups[0]!.label).toBe("OpenDesign Pro")
  })

  it("keeps the three reasons a model is unused distinct", () => {
    const byKey = new Map(groups[0]!.models.map((row) => [row.key, row.state]))
    expect(byKey.get("opendesign/deepseek-v4.1-flash")).toBe("approved")
    expect(byKey.get("opendesign/gpt-6-sol")).toBe("not approved")
    expect(byKey.get("opendesign/old-model")).toBe("excluded")
  })

  it("explains a provider that is not routing, instead of leaving it blank", () => {
    const commandcode = groups.find((group) => group.providerID === "commandcode")!
    expect(commandcode.state).toBe("not configured")
    expect(commandcode.note).toMatch(/no credential/i)
  })

  it("orders models approved-first, then by tier", () => {
    const approved = groups[0]!.models.filter((row) => row.state === "approved")
    expect(approved.map((row) => row.key)).toEqual([
      "opendesign/glm-5.3-flash",
      "opendesign/deepseek-v4.1-flash",
    ])
  })

  it("counts approved models against the total", () => {
    expect(groups[0]!.approvedCount).toBe(2)
    expect(groups[0]!.totalCount).toBe(4)
  })

  it("formats context and cost for reading, not for computing", () => {
    const luna = groups[1]!.models[0]!
    expect(luna.contextLabel).toBe("1M")
    expect(luna.costLabel).toBe("$1.00 / $2.00 per 1M")
  })
})

describe("terminal formatting", () => {
  const status = {
    runtime: "automatic",
    mode: "balanced",
    current: { providerID: "opendesign", id: "glm-5.3-flash" },
  }

  it("says so when there is no decision rather than rendering an empty box", () => {
    expect(formatDecision(status, undefined)).toMatch(/no decision yet/i)
  })

  it("reports a missing router rather than throwing", () => {
    expect(formatDecision(undefined, undefined)).toMatch(/no response/i)
  })

  it("shows the chosen model, why, and the candidates", () => {
    const text = formatDecision(status, {
      id: "d1",
      chosen: "opendesign/glm-5.3-flash",
      switched: true,
      switchReason: "cheaper",
      taskKind: "code",
      taskTier: 2,
      contextTokens: 8_000,
      estimatedUsd: 0.001,
      reasons: ["cheapest above the intelligence floor"],
      warnings: [],
      eligibleCount: 2,
      blockedCount: 1,
      rows: [
        {
          key: "opendesign/glm-5.3-flash",
          name: "GLM",
          tier: 2,
          verdict: "chosen",
          reason: "cheapest eligible",
          estimatedUsd: 0.001,
          effectiveCost: 0.001,
          successProbability: 0.9,
          adjustments: [],
        },
        {
          key: "opendesign/old",
          name: "Old",
          tier: 2,
          verdict: "blocked",
          reason: "weekly allowance 94% used",
          estimatedUsd: 0,
          effectiveCost: 0,
          successProbability: 0,
          adjustments: [],
        },
      ],
    })
    expect(text).toContain("opendesign/glm-5.3-flash")
    expect(text).toContain("cheapest above the intelligence floor")
    expect(text).toContain("weekly allowance 94% used")
    expect(text).toContain("✓")
    expect(text).toContain("·")
  })

  it("renders a lower-bound percentage as a bound in the terminal too", () => {
    const text = formatProviders([
      {
        providerID: "opendesign",
        label: "OpenDesign Pro",
        plan: "pro",
        source: "estimate",
        sourceLabel: "estimated — lower bound",
        stale: false,
        fetchedAt: 0,
        exhausted: false,
        windows: [
          {
            id: "weekly",
            label: "7d",
            usedPct: 41,
            remainingPct: 59,
            source: "estimate",
            sourceLabel: "estimated — lower bound",
            exceeded: false,
            reported: true,
            lowerBound: true,
          },
        ],
        pools: [],
        notes: [],
        caveat: "OpenDesign publishes no quota API for an inference key.",
      },
    ])
    expect(text).toContain("≥41%")
    expect(text).toContain("publishes no quota API")
  })

  it("says nothing was reported rather than showing zeros for absent windows", () => {
    const text = formatProviders([
      {
        providerID: "x",
        label: "X",
        plan: "",
        source: "unknown",
        sourceLabel: "not reported",
        stale: false,
        fetchedAt: 0,
        exhausted: false,
        windows: [],
        pools: [],
        notes: [],
      },
    ])
    expect(text).toContain("no windows reported")
  })
})
