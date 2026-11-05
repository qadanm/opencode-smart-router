import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { classifyTask } from "../src/core/classify/classifier.js"
import { buildRegistry } from "../src/core/models/registry.js"
import { estimateTaskCost } from "../src/core/routing/engine.js"
import type { RouterSettings } from "../src/core/types.js"

/**
 * A model switch costs more than staying, because the prompt cache is lost and
 * the whole context has to be re-sent as fresh input.
 *
 * Two things have to be true about how the router expresses that, and only one
 * of them was:
 *
 * - The extra cost must be inside the estimate the router ranks on, otherwise a
 *   switch looks free and the router hops between providers to save pennies.
 * - The figure the router *reports* as the switch penalty must equal the extra
 *   cost it actually charges for the switch. If the two disagree, anyone reading
 *   the decision log (or the owner, deciding whether a switch was worth it) is
 *   told a number the router does not use.
 *
 * The second is what broke. The penalty was reported as a full context's worth
 * of input, while the estimate only charged for the share of the context that
 * was actually cached when staying, which is 85%. The reported figure was
 * therefore 17.6% higher than the one in force.
 */

const NOW = Date.UTC(2026, 9, 30, 12)

const settings = (): RouterSettings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  providers: {
    ...structuredClone(DEFAULT_SETTINGS.providers),
    opendesign: { ...structuredClone(DEFAULT_SETTINGS.providers.opendesign)!, enabled: true, plan: "pro" },
    commandcode: { ...structuredClone(DEFAULT_SETTINGS.providers.commandcode)!, enabled: true, plan: "goat" },
  },
})

const modelFor = (providerID: string, modelID: string) => {
  const s = settings()
  const model = buildRegistry({ live: [], settings: s, definitions: [] })
    .approved()
    .find((m) => m.providerID === providerID && m.modelID === modelID)
  if (!model) throw new Error(`no model ${providerID}/${modelID}`)
  return model
}

const estimate = (input: { providerID: string; modelID: string; contextTokens: number; currentModelKey?: string }) => {
  const model = modelFor(input.providerID, input.modelID)
  const task = classifyTask({
    text: "Implement a feature in src/app.ts",
    files: [],
    contextTokens: input.contextTokens,
    recentFailures: 0,
  })
  return estimateTaskCost({
    model,
    task,
    contextTokens: input.contextTokens,
    ...(input.currentModelKey ? { currentModelKey: input.currentModelKey } : {}),
    now: NOW,
  })
}

describe("the reported switch penalty is the cost actually charged for switching", () => {
  const cases = [
    { providerID: "opendesign", modelID: "deepseek-v4.1-flash" },
    { providerID: "commandcode", modelID: "deepseek/deepseek-v4.1-flash" },
  ]

  for (const target of cases) {
    for (const contextTokens of [10_000, 50_000, 200_000]) {
      it(`matches the increment for ${target.providerID} at ${contextTokens} tokens`, () => {
        const staying = estimate({
          ...target,
          contextTokens,
          currentModelKey: `${target.providerID}/${target.modelID}`,
        })
        const switching = estimate({
          ...target,
          contextTokens,
          // A different model on the same provider: the cache is still lost.
          currentModelKey: `${target.providerID}/some-other-model`,
        })

        const charged = switching.usd - staying.usd
        expect(charged).toBeGreaterThan(0)
        // The number shown to a reader must be the number the router used.
        expect(switching.switchPenaltyUsd).toBeCloseTo(charged, 10)
      })
    }
  }

  it("charges nothing to stay, and reports nothing", () => {
    const staying = estimate({
      providerID: "opendesign",
      modelID: "deepseek-v4.1-flash",
      contextTokens: 50_000,
      currentModelKey: "opendesign/deepseek-v4.1-flash",
    })
    expect(staying.switchPenaltyUsd).toBe(0)
  })

  it("scales the penalty with the context that has to be re-sent", () => {
    const small = estimate({
      providerID: "opendesign",
      modelID: "deepseek-v4.1-flash",
      contextTokens: 20_000,
      currentModelKey: "opendesign/other",
    })
    const large = estimate({
      providerID: "opendesign",
      modelID: "deepseek-v4.1-flash",
      contextTokens: 80_000,
      currentModelKey: "opendesign/other",
    })
    expect(large.switchPenaltyUsd).toBeCloseTo(small.switchPenaltyUsd * 4, 10)
  })
})
