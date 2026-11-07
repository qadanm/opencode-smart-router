import { describe, expect, it } from "vitest"
import { decidePremium } from "../src/core/policy/eligibility.js"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import type { RouterSettings, TaskClass } from "../src/core/types.js"

/**
 * Premium mode "auto" escalation: the owner's standing instruction is that a
 * tier-3 task escalates without asking, paid from the plan-model pool, while
 * the budget lasts. These tests pin that contract.
 */

const task = (tier: 1 | 2 | 3, requestPremium = false): TaskClass =>
  ({
    tier,
    kind: tier === 3 ? "architecture" : "feature",
    requiresVision: false,
    designIntensive: false,
    sophisticatedDesign: false,
    needsLongContext: false,
    confidence: "high",
    signals: [],
    reasons: [],
    constraints: { avoidPremium: false, requestPremium, requestEconomy: false },
    scope: { promptTokens: 1_000, files: 0 },
  }) as unknown as TaskClass

const settings = (overrides: Partial<RouterSettings["premium"]> = {}): RouterSettings =>
  ({
    ...structuredClone(DEFAULT_SETTINGS),
    premium: { ...DEFAULT_SETTINGS.premium, ...overrides },
  }) as RouterSettings

const state = (remainingUsd: number, planPoolRemainingUsd: number | undefined = remainingUsd) => ({
  mode: "auto" as const,
  monthlyBudgetUsd: 120,
  spentUsd: 120 - remainingUsd,
  remainingUsd,
  planPoolRemainingUsd,
  oneShotGranted: false,
})

describe("premium auto mode", () => {
  it("escalates a tier-3 task automatically while the pool has budget", () => {
    const decision = decidePremium({
      settings: settings({ mode: "auto", monthlyBudgetUsd: 120 }),
      mode: "balanced",
      task: task(3),
      premium: { ...state(80, 80), mode: "auto" },
    })
    expect(decision.allowed).toBe(true)
    expect(decision.requiresApproval).toBe(false)
    expect(decision.reason).toMatch(/plan.model pool/i)
  })

  it("does not escalate tier-1 or tier-2 work in auto mode", () => {
    for (const tier of [1, 2] as const) {
      const decision = decidePremium({
        settings: settings({ mode: "auto", monthlyBudgetUsd: 120 }),
        mode: "balanced",
        task: task(tier),
        premium: { ...state(120, 120), mode: "auto" },
      })
      expect(decision.allowed, `tier ${tier}`).toBe(false)
    }
  })

  it("degrades to approval-required when the pool is exhausted, not a hard block", () => {
    const decision = decidePremium({
      settings: settings({ mode: "auto", monthlyBudgetUsd: 120 }),
      mode: "balanced",
      task: task(3),
      premium: { ...state(0, 0), mode: "auto" },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.requiresApproval).toBe(true)
  })

  it("auto never overrides an explicit off or ask", () => {
    const decision = decidePremium({
      settings: settings({ mode: "ask", monthlyBudgetUsd: 120 }),
      mode: "balanced",
      task: task(3),
      premium: { ...state(120), mode: "ask" },
    })
    expect(decision.requiresApproval).toBe(true)
  })

  it("efficiency mode still locks premium in auto", () => {
    const decision = decidePremium({
      settings: settings({ mode: "auto", monthlyBudgetUsd: 120 }),
      mode: "efficiency",
      task: task(3),
      premium: { ...state(120, 120), mode: "auto" },
    })
    expect(decision.allowed).toBe(false)
  })

  it("auto without a resolvable plan-model pool degrades to approval, not to the legacy budget", () => {
    const decision = decidePremium({
      settings: settings({ mode: "auto", monthlyBudgetUsd: 120 }),
      mode: "balanced",
      task: task(3),
      // Built inline: passing `undefined` through state() would hit the
      // default parameter and silently supply a pool that does not exist.
      premium: {
        mode: "auto",
        monthlyBudgetUsd: 120,
        spentUsd: 0,
        remainingUsd: 120,
        planPoolRemainingUsd: undefined,
        oneShotGranted: false,
      },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.requiresApproval).toBe(true)
    expect(decision.reason).toMatch(/plan-model pool/i)
  })

  it("auto with a zero budget degrades to ask behavior", () => {
    const decision = decidePremium({
      settings: settings({ mode: "auto", monthlyBudgetUsd: 0 }),
      mode: "balanced",
      task: task(3),
      premium: { mode: "auto", monthlyBudgetUsd: 0, spentUsd: 0, remainingUsd: 0, planPoolRemainingUsd: 0, oneShotGranted: false },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.requiresApproval).toBe(true)
  })
})
