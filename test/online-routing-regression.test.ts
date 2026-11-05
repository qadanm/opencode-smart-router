import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { classifyTask } from "../src/core/classify/classifier.js"
import { buildRegistry } from "../src/core/models/registry.js"
import { routeTask } from "../src/core/routing/engine.js"
import type { RouterSettings } from "../src/core/types.js"

/**
 * Regression guard for the online router.
 *
 * The expected values below were captured by running the router *before* offline
 * mode existed, so they describe what the owner's configuration actually did,
 * not what a later edit hoped it would do. Offline mode must not move any of
 * them. If a future change reorders a priority, re-prices a model, or shifts an
 * intelligence threshold, this fails and says which case moved.
 */

const NOW = Date.UTC(2026, 9, 30, 12)

const onlineSettings = (): RouterSettings => {
  const base: RouterSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    providers: {
      ...structuredClone(DEFAULT_SETTINGS.providers),
      opendesign: {
        ...structuredClone(DEFAULT_SETTINGS.providers.opendesign)!,
        enabled: true,
        plan: "pro",
      },
    },
  }
  return base
}

const route = (settings: RouterSettings, text: string, contextTokens: number) => {
  const task = classifyTask({ text, files: [], contextTokens, recentFailures: 0 })
  const registry = buildRegistry({ live: [], settings, definitions: [] })
  const result = routeTask({
    task,
    settings,
    mode: settings.mode,
    runtime: "automatic",
    models: registry.approved(),
    session: {
      sessionID: "ses_online_regression",
      manualOverride: false,
      premiumOneShot: false,
      paused: false,
      contextTokens,
      cacheReadTokens: 0,
      stepCount: 2,
      status: "idle",
      failures: [],
      retries: 0,
      createdAt: NOW,
      updatedAt: NOW,
    },
    quota: [],
    premium: { mode: "off", monthlyBudgetUsd: 0, spentUsd: 0, remainingUsd: 0, oneShotGranted: false },
    contextTokens,
    cachedTokens: 0,
    dryRun: false,
    now: NOW,
  })
  return { chosen: result.decision.chosen, tier: task.tier, decision: result.decision }
}

describe("online routing is unchanged by offline mode", () => {
  it("keeps every recorded online decision", () => {
    // Captured from the router before offline mode existed.
    const cases: ReadonlyArray<{
      text: string
      contextTokens: number
      providerID: string
      id: string
      tier: number
    }> = [
      {
        // Was deepseek-v4.1-flash until the OpenDesign catalog was corrected
        // against published CoRouter prices on 2026-11-04. DeepSeek costs
        // $0.30 / 1M input; GLM-5.3 Flash is $0.075 and scores higher, so the
        // recorded decision moved. See test/opendesign-pricing.test.ts.
        text: "Implement a small feature in src/app.ts",
        contextTokens: 10_000,
        providerID: "opendesign",
        id: "glm-5.3-flash",
        tier: 2,
      },
      {
        text: "Implement a small feature in src/app.ts",
        contextTokens: 200_000,
        providerID: "opendesign",
        id: "glm-5.3-flash",
        tier: 2,
      },
      {
        text: "Fix this visual bug in the screenshot",
        contextTokens: 10_000,
        providerID: "opendesign",
        id: "glm-5.3-flash",
        tier: 2,
      },
      {
        text: "Design a complex architecture for this app",
        contextTokens: 50_000,
        providerID: "opendesign",
        id: "glm-5.3-flash",
        tier: 3,
      },
    ]

    for (const entry of cases) {
      const { chosen, tier } = route(onlineSettings(), entry.text, entry.contextTokens)
      expect(chosen, `no decision for "${entry.text}"`).toBeDefined()
      expect(
        `${chosen!.providerID}/${chosen!.id}`,
        `"${entry.text}" at ${entry.contextTokens} tokens changed`,
      ).toBe(`${entry.providerID}/${entry.id}`)
      expect(tier).toBe(entry.tier)
    }
  })

  it("does not narrow candidates when offline mode is off", () => {
    // The candidate list is what a routing decision can choose from. Filtering
    // hosted providers must happen only when offline is explicitly enabled,
    // otherwise a normal session silently loses most of its routes.
    const settings = onlineSettings()
    expect(settings.offline?.enabled ?? false).toBe(false)
    const { decision } = route(settings, "Implement a small feature in src/app.ts", 10_000)
    expect(decision.candidates.length).toBeGreaterThan(1)
    const providers = new Set(decision.candidates.map((c) => c.model.providerID))
    expect(providers.size).toBeGreaterThan(1)
  })

  it("still reports no offline-exclusion warning online", () => {
    const { decision } = route(onlineSettings(), "Implement a small feature in src/app.ts", 10_000)
    expect(decision.warnings.join(" ")).not.toMatch(/Offline mode/)
  })

  it("preserves the DeepSeek intelligence floor for substantive work", () => {
    // DeepSeek V4.1 Flash carries a 39.5 intelligence score and is the approved
    // standard floor. Offline mode is a deliberate exception for local work; it
    // must not lower this floor for online routing.
    const settings = onlineSettings()
    const registry = buildRegistry({ live: [], settings, definitions: [] })
    const deepseek = registry.get("opendesign", "deepseek-v4.1-flash")
    expect(deepseek?.intelligence).toBe(39.5)
    expect(settings.routing.intelligenceFloor).toBeLessThanOrEqual(deepseek!.intelligence)
  })
})
