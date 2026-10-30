import { describe, expect, it } from "vitest"
import {
  discoverOpenDesignModels,
  toLiveModels,
  type OpenDesignDiscoveredModel,
} from "../src/core/providers/opendesign.js"

/**
 * OpenDesign's gateway reports two context numbers per model:
 *
 *   context_limit   - the vendor's total context window
 *   context_budget  - the usable *input* budget, after the model's reserved
 *                     output has been subtracted
 *
 * `context_budget` is the number the router should use: it is what the
 * gateway will actually accept as input. But the field is not always
 * present. `minimax-m3.1-flash` reports `context_limit: 1000000` and no
 * `context_budget` at all.
 *
 * When the budget is missing, the router used to fall back to a hand-written
 * conservative guess of 232,000 - a number that has nothing to do with the
 * model. That guess is smaller than the real window by more than four times,
 * and it pushed a live session off the cheap provider and then into a
 * fail-closed block: the session's 309k context was judged against a
 * 220k ceiling that the model never had.
 *
 * The gateway's own `context_limit` is the correct value to fall back to.
 * The request that reaches the gateway carries both the input and the
 * requested output, and the router's eligibility gate already applies the
 * 0.95 safe-window fraction and the 20k margin, so a vendor limit used as
 * the fallback is conservative in exactly the way the gate expects.
 */

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

const NOW = Date.UTC(2026, 9, 29)

/** The gateway's live payload for minimax-m3.1-flash: a limit, no budget. */
const GATEWAY_MODELS = {
  object: "list",
  data: [
    {
      id: "minimax-m3.1-flash",
      object: "model",
      owned_by: "vela",
      architecture: { input_modalities: ["text", "image", "video"], output_modalities: ["text"] },
      metadata: { cost: "low", capability: "advanced", context_limit: 1000000 },
      default: false,
      enabled: true,
    },
  ],
}

describe("OpenDesign context window when the gateway reports no budget", () => {
  it("uses the gateway's context_limit instead of a hand-written guess", async () => {
    const result = await discoverOpenDesignModels({
      apiKey: "sk-amr-test",
      fetchImpl: async () => json(GATEWAY_MODELS),
      now: () => NOW,
    })
    const live = toLiveModels(result.models)
    const minimax = live.find((m) => m.id === "minimax-m3.1-flash")

    // The vendor window is 1,000,000. The old fallback used 232,000.
    expect(minimax?.limit.context).toBe(1_000_000)
  })

  it("keeps preferring the reported budget when the gateway supplies one", () => {
    const withBudget: OpenDesignDiscoveredModel = {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      contextLimit: 1048000,
      contextBudget: 328000,
      outputBudget: 128000,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      enabled: true,
      default: true,
    }
    const live = toLiveModels([withBudget])
    const deepseek = live.find((m) => m.id === "deepseek-v4.1-flash")

    // The budget is the usable input window, so it stays authoritative.
    expect(deepseek?.limit.context).toBe(328_000)
  })

  it("never reports a window larger than the vendor limit", () => {
    const live = toLiveModels([
      {
        id: "minimax-m3.1-flash",
        name: "MiniMax M3.1 Flash",
        contextLimit: 1_000_000,
        contextBudget: 4_000_000, // a nonsense budget above the vendor limit
        outputBudget: 32_000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        enabled: true,
        default: false,
      },
    ])
    expect(live[0]?.limit.context).toBeLessThanOrEqual(1_000_000)
  })

  it("falls back to the vendor limit, not a guess, when there is no seed spec", async () => {
    const result = await discoverOpenDesignModels({
      apiKey: "sk-amr-test",
      fetchImpl: async () =>
        json({
          object: "list",
          data: [
            {
              id: "brand-new-model",
              object: "model",
              owned_by: "vela",
              architecture: { input_modalities: ["text"], output_modalities: ["text"] },
              metadata: { cost: "low", capability: "advanced", context_limit: 640000 },
              default: false,
              enabled: true,
            },
          ],
        }),
      now: () => NOW,
    })
    const live = toLiveModels(result.models)
    expect(live[0]?.limit.context).toBe(640_000)
  })
})

describe("the advertised budget is a policy limit, not arithmetic", () => {
  /**
   * This distinction was documented incorrectly once, which sent readers
   * looking for a subtraction that does not exist. `context_budget` is chosen
   * by the gateway as a capability tier; it is not `context_limit` minus
   * `output_budget`.
   *
   * Verified against the live gateway on 2026-10-30: DeepSeek V4.1 Flash
   * reports limit 1,048,000 / budget 328,000 / output 128,000, and
   * 1,048,000 - 128,000 is 920,000. Across all 44 models the budget takes one
   * of a few round values (228k to 1.048M) with ratios from 22% to 100%, which
   * no subtraction produces.
   */
  it("does not derive the budget from limit minus output", () => {
    const live = toLiveModels([
      {
        id: "deepseek-v4.1-flash",
        name: "deepseek-v4.1-flash",
        contextLimit: 1_048_000,
        contextBudget: 328_000,
        outputBudget: 128_000,
        inputModalities: ["text"],
        outputModalities: ["text"],
      },
    ] as never)
    const model = live[0]!
    expect(model.limit.context).toBe(328_000)
    // The subtraction that the old documentation implied would give 920,000.
    expect(model.limit.context).not.toBe(1_048_000 - 128_000)
    // And the router keeps the reserved output budget as reported.
    expect(model.limit.output).toBe(128_000)
  })

  it("keeps a full-window model at its full window", () => {
    // Muse Spark 1.3 is the one model the gateway does not reduce; the router
    // must not clamp it to a tier value.
    const live = toLiveModels([
      {
        id: "muse-spark-1.3",
        name: "muse-spark-1.3",
        contextLimit: 1_048_000,
        contextBudget: 1_048_000,
        outputBudget: 32_000,
        inputModalities: ["text"],
        outputModalities: ["text"],
      },
    ] as never)
    expect(live[0]!.limit.context).toBe(1_048_000)
  })

  it("never lets a reported budget exceed the vendor limit", () => {
    const live = toLiveModels([
      {
        id: "some-model",
        name: "some-model",
        contextLimit: 500_000,
        contextBudget: 900_000,
        inputModalities: ["text"],
        outputModalities: ["text"],
      },
    ] as never)
    expect(live[0]!.limit.context).toBe(500_000)
  })
})
