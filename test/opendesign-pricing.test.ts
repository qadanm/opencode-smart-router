import { describe, expect, it } from "vitest"
import { estimateDesignPlanCredits } from "../src/core/quota/opendesign.js"
import { OPENDESIGN_MODELS } from "../src/core/providers/opendesign-models.js"
import { OPENDESIGN_CREDIT_MULTIPLIERS } from "../src/core/providers/opendesign-credits.js"

/**
 * The model catalog must match the prices the provider publishes.
 *
 * On 2026-11-04 the catalog was checked against CoRouter's public model pages
 * and 13 of 33 models were wrong — including DeepSeek V4.1 Flash, the model in
 * active use, at a quarter of its real cost. Every routing comparison, every
 * quota percentage and every "is this cheaper than Command Code" decision is
 * computed from these numbers, so being wrong here is not a display bug.
 *
 * These are recorded from the published pages, per model ID, as of that date.
 * A failure means the catalog drifted from published pricing — either the
 * provider changed its prices (update these and the catalog together) or the
 * catalog was edited by hand.
 *
 * Source: https://corouter.open-design.ai/models/ — the `data-model-panel`
 * attribute carries the exact API model ID, so this mapping is not guessed from
 * display names.
 */
const PUBLISHED_USD_PER_MILLION: Readonly<Record<string, { input: number; output: number; cacheRead: number }>> = {
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-fable-5.1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-haiku-5.5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-opus-4.8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-5.5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5.5": { input: 2, output: 10, cacheRead: 0.2 },
  "deepseek-v4-flash": { input: 0.44, output: 1.32, cacheRead: 0.014 },
  "deepseek-v4-flash-vision-exp": { input: 0.44, output: 1.32, cacheRead: 0.014 },
  "deepseek-v4-pro": { input: 1.32, output: 3.96, cacheRead: 0.044 },
  "deepseek-v4.1-flash": { input: 0.3, output: 1.2, cacheRead: 0.006 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75, cacheRead: 0.075 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075 },
  "glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26 },
  "glm-5.3-flash": { input: 0.075, output: 0.25, cacheRead: 0.015 },
  "glm-5.3-flashx": { input: 0.37, output: 1.25, cacheRead: 0.075 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02 },
  "gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4 },
  "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2 },
  "gpt-6-astra": { input: 10, output: 50, cacheRead: 1 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2 },
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1 },
  "grok-4.5": { input: 2, output: 6, cacheRead: 0.5 },
  "grok-4.6": { input: 2, output: 6, cacheRead: 0.5 },
  "grok-4.7": { input: 2, output: 6, cacheRead: 0.5 },
  "hy4-preview": { input: 0.834, output: 2.501, cacheRead: 0.042 },
  "kimi-k2.7-code": { input: 0.95, output: 4, cacheRead: 0.19 },
  "kimi-k3": { input: 3, output: 15, cacheRead: 0.3 },
  "mimo-v2.6-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028 },
  "mimo-v2.6-pro": { input: 0.435, output: 0.87, cacheRead: 0.0036 },
  "qwen3.7-max": { input: 2.5, output: 7.5, cacheRead: 0.5 },
}

describe("the catalog matches published pricing", () => {
  const byId = new Map(OPENDESIGN_MODELS.map((model) => [model.modelID, model]))

  it.each(Object.entries(PUBLISHED_USD_PER_MILLION))("%s", (modelID, published) => {
    const spec = byId.get(modelID)
    expect(spec, `${modelID} is missing from the catalog`).toBeDefined()
    const tier = spec!.cost[0]!
    expect(tier.input, `${modelID} input`).toBeCloseTo(published.input, 6)
    expect(tier.output, `${modelID} output`).toBeCloseTo(published.output, 6)
    expect(tier.cache?.read ?? 0, `${modelID} cache read`).toBeCloseTo(published.cacheRead, 6)
  })

  it("has no catalog entry priced at zero for a paid model", () => {
    for (const model of OPENDESIGN_MODELS) {
      if (!model.approved) continue
      expect(model.cost[0]?.input, `${model.modelID} input price`).toBeGreaterThan(0)
    }
  })
})

describe("the multiplier is applied to the published price, never baked into it", () => {
  /**
   * The distinction that caused the drift: `cost()` holds the published API
   * price, and the Design Plan multiplier is a separate factor applied on top.
   * A seed that already contained the multiplier had it applied twice, and
   * nothing caught it because no test compared the two numbers.
   */
  it("charges published price x multiplier for one million input tokens", () => {
    for (const [modelID, published] of Object.entries(PUBLISHED_USD_PER_MILLION)) {
      const multiplier = OPENDESIGN_CREDIT_MULTIPLIERS[modelID] ?? 1
      const credits = estimateDesignPlanCredits({ modelID, input: 1_000_000, output: 0, cacheRead: 0 })
      expect(credits.creditsUsd, `${modelID}: ${published.input} x ${multiplier}`).toBeCloseTo(
        published.input * multiplier,
        9,
      )
    }
  })

  it("does not apply the multiplier to plan-model credits", () => {
    // Plan models are billed at their plain usage value; documented, and easy to
    // regress by passing the wrong flag.
    const withMultiplier = estimateDesignPlanCredits({
      modelID: "deepseek-v4.1-flash",
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
    })
    const plain = estimateDesignPlanCredits({
      modelID: "deepseek-v4.1-flash",
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      multiplierApplies: false,
    })
    expect(withMultiplier.creditsUsd).toBeCloseTo(0.15, 9)
    expect(plain.creditsUsd).toBeCloseTo(0.3, 9)
  })
})
