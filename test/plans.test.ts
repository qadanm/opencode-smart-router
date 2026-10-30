import { describe, expect, it } from "vitest"
import {
  OPENDESIGN_DESIGN_PLAN_MODELS,
  OPENDESIGN_DESIGN_PLAN_POOL,
  OPENDESIGN_PLAN_MODEL_POOL,
  PLAN_CATALOG,
  defaultPlanIdFor,
  fundingPoolFor,
  isEscalationOnlyPool,
  modelMonthlyAllowanceUsd,
  modelWindowCaps,
  planSummaryLine,
  poolDrawSequence,
  resolvePlan,
} from "../src/core/plans/catalog.js"
import { DEFAULT_SETTINGS, validateSettings } from "../src/core/config.js"

describe("plan catalog", () => {
  it("recognises OpenDesign Pro with two separate pools", () => {
    const plan = resolvePlan("opendesign", "pro")
    expect(plan).toBeDefined()
    expect(plan!.label).toBe("OpenDesign Pro")
    expect(plan!.monthlyPriceUsd).toBe(100)
    expect(plan!.pools).toHaveLength(2)

    const designPlan = plan!.pools.find((pool) => pool.id === OPENDESIGN_DESIGN_PLAN_POOL)!
    expect(designPlan.monthlyUsd).toBe(360)
    expect(designPlan.weeklyUsd).toBe(90)
    // Pro has no five-hour Design Plan window.
    expect(designPlan.fiveHourUsd).toBeUndefined()

    const planModels = plan!.pools.find((pool) => pool.id === OPENDESIGN_PLAN_MODEL_POOL)!
    expect(planModels.monthlyUsd).toBe(120)
    // The plan model pool has no usage windows at all.
    expect(planModels.weeklyUsd).toBeUndefined()
    expect(planModels.fiveHourUsd).toBeUndefined()
    expect(planModels.resetKind).toBe("billing-cycle")
  })

  it("never adds the two pools into one spendable balance", () => {
    const plan = resolvePlan("opendesign", "pro")!
    const designPlan = plan.pools.find((pool) => pool.id === OPENDESIGN_DESIGN_PLAN_POOL)!
    const planModels = plan.pools.find((pool) => pool.id === OPENDESIGN_PLAN_MODEL_POOL)!
    // The advertised $480 is two allowances with different rules.
    expect(designPlan.monthlyUsd + planModels.monthlyUsd).toBe(480)
    expect(designPlan.weeklyUsd).toBeLessThanOrEqual(designPlan.monthlyUsd)
    expect(planModels.weeklyUsd).toBeUndefined()
  })

  it("funds Design Plan models from the Design Plan pool", () => {
    const plan = resolvePlan("opendesign", "pro")!
    for (const modelID of ["deepseek-v4.1-flash", "glm-5.3-flash", "claude-haiku-5.5"]) {
      expect(OPENDESIGN_DESIGN_PLAN_MODELS.has(modelID)).toBe(true)
      expect(fundingPoolFor(plan, modelID)?.id).toBe(OPENDESIGN_DESIGN_PLAN_POOL)
      expect(isEscalationOnlyPool(plan, modelID)).toBe(false)
    }
  })

  it("funds plan models from the separate pool and marks them escalation-only", () => {
    const plan = resolvePlan("opendesign", "pro")!
    for (const modelID of ["claude-sonnet-5.5", "gpt-6-astra", "kimi-k3", "grok-4.7"]) {
      expect(OPENDESIGN_DESIGN_PLAN_MODELS.has(modelID)).toBe(false)
      expect(fundingPoolFor(plan, modelID)?.id).toBe(OPENDESIGN_PLAN_MODEL_POOL)
      expect(isEscalationOnlyPool(plan, modelID)).toBe(true)
    }
  })

  it("does not apply a Design Plan multiplier to the plan model pool", () => {
    const plan = resolvePlan("opendesign", "pro")!
    // deepseek is 0.5x inside the Design Plan pool.
    const deepseek = poolDrawSequence(plan, "deepseek-v4.1-flash")
    expect(deepseek[0]!.multiplierApplies).toBe(true)
    expect(deepseek[0]!.pool.id).toBe(OPENDESIGN_DESIGN_PLAN_POOL)
    // After the Design Plan pool is exhausted it keeps working, but the
    // multiplier does not follow it into the second pool.
    expect(deepseek[1]!.pool.id).toBe(OPENDESIGN_PLAN_MODEL_POOL)
    expect(deepseek[1]!.multiplierApplies).toBe(false)

    // A plan model draws from plan model credits at plain value.
    const sonnet = poolDrawSequence(plan, "claude-sonnet-5.5")
    expect(sonnet).toHaveLength(1)
    expect(sonnet[0]!.pool.id).toBe(OPENDESIGN_PLAN_MODEL_POOL)
    expect(sonnet[0]!.multiplierApplies).toBe(false)
  })

  it("keeps Go with a five-hour window and no plan model pool", () => {
    const plan = resolvePlan("opendesign", "go")!
    expect(plan.pools).toHaveLength(1)
    const designPlan = plan.pools[0]!
    expect(designPlan.fiveHourUsd).toBe(10)
    expect(designPlan.weeklyUsd).toBe(30)
    expect(designPlan.monthlyUsd).toBe(120)
    expect(plan.pools.some((pool) => pool.id === OPENDESIGN_PLAN_MODEL_POOL)).toBe(false)
  })

  it("recognises OpenCode Go as Go, not Go Plus", () => {
    const go = resolvePlan("opencode-go", "go")!
    expect(go.label).toBe("OpenCode Go")
    expect(go.monthlyPriceUsd).toBe(10)
    expect(modelMonthlyAllowanceUsd(go, "deepseek-v4.1-flash")).toBe(80)

    const plus = resolvePlan("opencode-go", "go-plus")!
    expect(plus.label).toBe("OpenCode Go Plus")
    expect(plus.monthlyPriceUsd).toBe(40)
    // Go Plus allowances are real, and distinct from Go.
    expect(modelMonthlyAllowanceUsd(plus, "deepseek-v4.1-flash")).toBe(160)
  })

  it("derives OpenCode Go's nested windows from each model's own allowance", () => {
    const go = resolvePlan("opencode-go", "go")!
    const caps = modelWindowCaps(go, "deepseek-v4.1-flash")
    expect(caps.monthlyUsd).toBe(80)
    expect(caps.weeklyUsd).toBe(40) // 50%
    expect(caps.fiveHourUsd).toBe(16) // 20%
    // The windows nest inside the monthly figure, never add to it.
    expect(caps.weeklyUsd).toBeLessThan(caps.monthlyUsd)

    // A model with a smaller allowance gets proportionally smaller windows.
    const mini = modelWindowCaps(go, "minimax-m3.1-flash")
    expect(mini.monthlyUsd).toBe(20)
    expect(mini.weeklyUsd).toBe(10)
    expect(mini.fiveHourUsd).toBe(4)
  })

  it("keeps Command Code GOAT unchanged", () => {
    const goat = resolvePlan("commandcode", "goat")!
    expect(goat.label).toBe("Command Code GOAT")
    expect(goat.monthlyPriceUsd).toBe(10)
    expect(goat.pools).toHaveLength(1)
    expect(goat.pools[0]!.monthlyUsd).toBe(70)
    expect(goat.pools[0]!.fiveHourUsd).toBe(14)
    expect(goat.pools[0]!.weeklyUsd).toBe(35)
  })

  it("falls back to a sensible plan for an unknown or empty plan id", () => {
    expect(resolvePlan("opendesign", undefined)?.planID).toBe("pro")
    expect(resolvePlan("opendesign", "nonexistent")?.planID).toBe("pro")
    expect(resolvePlan("opencode-go", undefined)?.planID).toBe("go")
    expect(resolvePlan("commandcode", undefined)?.planID).toBe("goat")
    // A provider with no catalog entry resolves to nothing rather than guessing.
    expect(resolvePlan("unknown-provider", "x")).toBeUndefined()
  })

  it("maps legacy plan aliases without silently describing the wrong tier", () => {
    expect(resolvePlan("opencode-go", "goplus")?.planID).toBe("go-plus")
    expect(resolvePlan("opendesign", "go-plus")?.planID).toBe("plus")
  })

  it("describes a plan in one line", () => {
    const line = planSummaryLine(resolvePlan("opendesign", "pro")!)
    expect(line).toContain("OpenDesign Pro")
    expect(line).toContain("$100")
    expect(line).toContain("Design Plan credits $360")
    expect(line).toContain("Plan model credits $120")
    expect(line).toContain("nested")
  })

  it("keeps every catalog plan internally consistent", () => {
    for (const plan of PLAN_CATALOG) {
      expect(plan.monthlyPriceUsd).toBeGreaterThan(0)
      expect(plan.pools.length).toBeGreaterThan(0)
      for (const pool of plan.pools) {
        expect(pool.monthlyUsd).toBeGreaterThan(0)
        if (pool.weeklyUsd !== undefined) {
          expect(pool.weeklyUsd).toBeLessThanOrEqual(pool.monthlyUsd)
        }
        if (pool.fiveHourUsd !== undefined) {
          expect(pool.fiveHourUsd).toBeLessThanOrEqual(pool.weeklyUsd ?? pool.monthlyUsd)
        }
      }
      // Draw order must be unambiguous.
      const orders = plan.pools.map((pool) => pool.drawOrder)
      expect(new Set(orders).size).toBe(orders.length)
    }
  })

  it("exposes the default plan id per provider", () => {
    expect(defaultPlanIdFor("opendesign")).toBe("pro")
    expect(defaultPlanIdFor("opencode-go")).toBe("go")
    expect(defaultPlanIdFor("commandcode")).toBe("goat")
    expect(defaultPlanIdFor("other")).toBeUndefined()
  })
})

describe("settings defaults for the new plans", () => {
  it("defaults OpenDesign to Pro with no five-hour window", () => {
    const od = DEFAULT_SETTINGS.providers.opendesign!
    expect(od.plan).toBe("pro")
    expect(od.ignoreFiveHourWindow).toBe(true)
    expect(od.subscriptionOnly).toBe(true)
  })

  it("defaults OpenCode Go to the Go plan", () => {
    expect(DEFAULT_SETTINGS.providers["opencode-go"]!.plan).toBe("go")
  })

  it("defaults context management to native", () => {
    expect(DEFAULT_SETTINGS.contextManagement.mode).toBe("native")
    expect(DEFAULT_SETTINGS.contextManagement.allowEmergencyCompaction).toBe(true)
  })

  it("defaults escalation-pool protection on and long context at 1M", () => {
    expect(DEFAULT_SETTINGS.routing.protectEscalationPool).toBe(true)
    expect(DEFAULT_SETTINGS.routing.longContextFloorTokens).toBe(1_000_000)
  })

  it("accepts an explicit plan and window suppression from a config file", () => {
    const { settings, warnings } = validateSettings({
      providers: {
        opendesign: { plan: "pro", ignoreFiveHourWindow: true },
      },
    })
    expect(settings.providers.opendesign!.plan).toBe("pro")
    expect(settings.providers.opendesign!.ignoreFiveHourWindow).toBe(true)
    // No warning may concern the two fields that were supplied.
    expect(warnings.join(" ")).not.toMatch(/ignoreFiveHourWindow/)
    expect(warnings.join(" ")).not.toMatch(/providers\.opendesign\.plan/)
  })

  it("rejects an unknown context-management mode instead of silently compacting", () => {
    const { settings, warnings } = validateSettings({
      contextManagement: { mode: "aggressive" },
    })
    expect(settings.contextManagement.mode).toBe("native")
    expect(warnings.join(" ")).toMatch(/contextManagement.mode/)
  })

  it("warns when budget-optimized mode has no explicit threshold", () => {
    const { warnings } = validateSettings({
      contextManagement: { mode: "budget-optimized", compactAtTokens: 0 },
    })
    expect(warnings.join(" ")).toMatch(/compactAtTokens is 0/)
  })

  it("clamps an absurd speed weight rather than trusting it", () => {
    const { settings } = validateSettings({ speed: { weightPct: 900 } })
    expect(settings.speed.weightPct).toBe(100)
  })
})
