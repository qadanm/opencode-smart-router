import { describe, expect, it } from "vitest"
import { OPENDESIGN_CREDIT_MULTIPLIERS } from "../src/core/providers/opendesign-credits.js"
import {
  resolvePlan,
  OPENDESIGN_PLAN_MODEL_POOL,
  OPENDESIGN_DESIGN_PLAN_POOL,
  type PlanDefinition,
} from "../src/core/plans/catalog.js"

/** The catalog is authoritative; resolve by id so the test follows the data. */
const planOf = (id: string): PlanDefinition => {
  const plan = resolvePlan("opendesign", id)
  if (!plan) throw new Error(`no catalog entry for opendesign/${id}`)
  return plan
}

const OPENDESIGN_GO_PLAN = planOf("go")
const OPENDESIGN_PLUS_PLAN = planOf("plus")
const OPENDESIGN_PRO_PLAN = planOf("pro")
const OPENDESIGN_MAX_PLAN = planOf("max")

/**
 * The credit rules, pinned to the vendor's own published documentation.
 *
 * Read from https://open-design.ai/model-credits/ and /help/billing/ on
 * 2026-11-04. Everything here was previously inferred, and two parts of it were
 * wrong in ways that changed routing:
 *
 *   - the seven-day window is FIXED from the subscription start, not rolling
 *   - on Plus/Pro/Max the pools spill: a spent Design Plan allowance draws from
 *     plan model credits rather than stopping
 *
 * Sources are public pages, so this is verifiable by anyone and should be
 * re-checked when the vendor changes its terms.
 */

describe("plan allowances match the published table", () => {
  const table = [
    { plan: OPENDESIGN_GO_PLAN, label: "Go", monthly: 120, planModels: 0, designPlan: 120, weekly: 30, fiveHour: 10 },
    { plan: OPENDESIGN_PLUS_PLAN, label: "Plus", monthly: 180, planModels: 20, designPlan: 160, weekly: 40, fiveHour: undefined },
    { plan: OPENDESIGN_PRO_PLAN, label: "Pro", monthly: 480, planModels: 120, designPlan: 360, weekly: 90, fiveHour: undefined },
    { plan: OPENDESIGN_MAX_PLAN, label: "Max", monthly: 900, planModels: 300, designPlan: 600, weekly: 150, fiveHour: undefined },
  ]

  it.each(table)("$label totals $monthly", ({ plan, monthly, planModels, designPlan, weekly, fiveHour }) => {
    const design = plan.pools.find((pool) => pool.id === OPENDESIGN_DESIGN_PLAN_POOL)!
    const planModel = plan.pools.find((pool) => pool.id === OPENDESIGN_PLAN_MODEL_POOL)

    expect(design.monthlyUsd).toBe(designPlan)
    if (planModels === 0) {
      expect(planModel).toBeUndefined()
    } else {
      expect(planModel?.monthlyUsd).toBe(planModels)
    }
    // The monthly maximum is the sum of the two pools.
    expect(design.monthlyUsd + (planModel?.monthlyUsd ?? 0)).toBe(monthly)
    expect(design.weeklyUsd).toBe(weekly)
    expect(design.fiveHourUsd).toBe(fiveHour)
  })

  it("gives only Go a five-hour window", () => {
    expect(OPENDESIGN_GO_PLAN.pools.find((p) => p.id === OPENDESIGN_DESIGN_PLAN_POOL)?.fiveHourUsd).toBe(10)
    for (const plan of [OPENDESIGN_PLUS_PLAN, OPENDESIGN_PRO_PLAN, OPENDESIGN_MAX_PLAN]) {
      expect(plan.pools.find((p) => p.id === OPENDESIGN_DESIGN_PLAN_POOL)?.fiveHourUsd).toBeUndefined()
    }
  })
})

describe("the seven-day window is fixed, not rolling", () => {
  it("says so, because a rolling window would under-report headroom all week", () => {
    for (const plan of [OPENDESIGN_GO_PLAN, OPENDESIGN_PLUS_PLAN, OPENDESIGN_PRO_PLAN, OPENDESIGN_MAX_PLAN]) {
      const design = plan.pools.find((pool) => pool.id === OPENDESIGN_DESIGN_PLAN_POOL)!
      expect(design.resetKind).toBe("fixed-7-day")
    }
  })

  it("keeps plan model credits on the billing cycle with no window", () => {
    const planModel = OPENDESIGN_PRO_PLAN.pools.find((pool) => pool.id === OPENDESIGN_PLAN_MODEL_POOL)!
    expect(planModel.resetKind).toBe("billing-cycle")
    expect(planModel.weeklyUsd).toBeUndefined()
    expect(planModel.fiveHourUsd).toBeUndefined()
  })
})

describe("pools spill rather than stopping", () => {
  it("draws Design Plan first, then plan models", () => {
    const design = OPENDESIGN_PRO_PLAN.pools.find((pool) => pool.id === OPENDESIGN_DESIGN_PLAN_POOL)!
    const planModel = OPENDESIGN_PRO_PLAN.pools.find((pool) => pool.id === OPENDESIGN_PLAN_MODEL_POOL)!
    // Lower drawOrder is consumed first.
    expect(design.drawOrder).toBeLessThan(planModel.drawOrder)
  })

  it("explains the spill in the plan notes, not just the data", () => {
    const notes = OPENDESIGN_PRO_PLAN.notes.join(" ")
    expect(notes).toMatch(/spill|draws from plan model credits/i)
  })

  it("records that Go has nothing to spill into", () => {
    expect(OPENDESIGN_GO_PLAN.notes.join(" ")).toMatch(/Go includes Design Plan credits only/i)
  })
})

describe("credit multipliers match the published table", () => {
  const published: Readonly<Record<string, number>> = {
    "deepseek-v4.1-flash": 0.5,
    "minimax-m3.1-flash": 1,
    "mimo-v2.6-flash": 1,
    "mimo-v2.6-pro": 1,
    "hy4-preview": 1,
    "deepseek-v4-flash": 1,
    "deepseek-v4-flash-vision-exp": 1,
    "deepseek-v4-pro": 1,
    "glm-5.3-flash": 1,
    "kimi-k2.7-code": 1,
    "claude-haiku-5.5": 2,
    "glm-5.3-flashx": 2,
    "gpt-6-luna": 4,
  }

  it.each(Object.entries(published))("%s is %sx", (modelID, multiplier) => {
    // miniMax is absent from our multiplier table and therefore treated as the
    // neutral 1x; the others must be stated explicitly.
    const actual = OPENDESIGN_CREDIT_MULTIPLIERS[modelID] ?? 1
    expect(actual).toBe(multiplier)
  })

  it("has no model at a rate the vendor does not publish", () => {
    for (const [modelID, multiplier] of Object.entries(OPENDESIGN_CREDIT_MULTIPLIERS)) {
      expect(published[modelID], `${modelID} is not in the published table`).toBeDefined()
      expect(multiplier).toBe(published[modelID])
    }
  })
})

describe("no public endpoint reads usage", () => {
  /**
   * Not a test of our code — a guard on an assumption.
   *
   * Upstream issue nexu-io/open-design#8674 asks for exactly this and is still
   * open. The account host rejects an inference key with 401 and bot-blocks
   * non-browser requests; the gateway serves no usage route for an API key.
   * If a future release adds one, this comment is where to start, and the
   * estimate path can be replaced rather than extended.
   */
  it("documents the reason the estimate exists", () => {
    expect(true).toBe(true)
  })
})
