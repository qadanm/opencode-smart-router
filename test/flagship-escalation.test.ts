import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { classifyTask } from "../src/core/classify/classifier.js"
import { buildRegistry } from "../src/core/models/registry.js"
import { routeTask } from "../src/core/routing/engine.js"
import type { ProviderQuotaSnapshot, RouterSettings, SessionState } from "../src/core/types.js"

/**
 * The escalation-pool guard learns the difference between "an ordinary route
 * exists" and "an ordinary route can serve this task".
 *
 * Before: any eligible ordinary-allowance model blocked every escalationOnly
 * model, so a tier-3 task was always served by a standard model running at
 * ~0.7 expected success even though the owner pays for flagship capacity.
 *
 * After: the pool is protected only when an ordinary route meets the same
 * quality bar a tier-3 model would (probability >= 0.85). Tier-1 and tier-2
 * tasks always keep full protection, so routine work never drains the pool.
 */

const NOW = Date.UTC(2026, 10, 6, 12)

const onlineSettings = (): RouterSettings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  providers: {
    ...structuredClone(DEFAULT_SETTINGS.providers),
    opendesign: {
      ...structuredClone(DEFAULT_SETTINGS.providers.opendesign)!,
      enabled: true,
      plan: "pro",
    },
  },
})

const session = (contextTokens = 10_000): SessionState => ({
  sessionID: "ses_flagship",
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
})

const provider = (providerID: string, monthlyUsedPct: number): ProviderQuotaSnapshot => ({
  providerID,
  label: providerID,
  plan: "pro",
  source: "provider",
  fetchedAt: NOW,
  stale: false,
  rolling: { usedPct: monthlyUsedPct, remainingPct: 100 - monthlyUsedPct, source: "provider" },
  weekly: { usedPct: monthlyUsedPct, remainingPct: 100 - monthlyUsedPct, source: "provider" },
  monthly: { usedPct: monthlyUsedPct, remainingPct: 100 - monthlyUsedPct, source: "provider" },
  models: {},
  notes: [],
})

const route = (settings: RouterSettings, text: string, contextTokens = 10_000) => {
  const task = classifyTask({ text, files: [], contextTokens, recentFailures: 0 })
  const registry = buildRegistry({ live: [], settings, definitions: [] })
  const result = routeTask({
    task,
    settings,
    mode: settings.mode,
    runtime: "automatic",
    models: registry.approved(),
    session: session(contextTokens),
    quota: [provider("opendesign", 10)],
    premium: {
      mode: settings.premium.mode,
      monthlyBudgetUsd: settings.premium.monthlyBudgetUsd,
      spentUsd: 0,
      remainingUsd: settings.premium.monthlyBudgetUsd,
      // The controller resolves the Pro plan's plan-models pool (120/month);
      // auto mode gates on this, not on remainingUsd.
      planPoolRemainingUsd: 120,
      oneShotGranted: false,
    },
    contextTokens,
    cachedTokens: 0,
    dryRun: false,
    now: NOW,
  })
  return { task, result }
}

describe("the escalation pool serves what ordinary allowance cannot", () => {
  it("escalates a tier-3 architecture task to a flagship automatically", () => {
    const { task, result } = route(
      onlineSettings(),
      "Design a complex architecture for this multi-tenant app with event sourcing and a migration plan",
    )
    expect(task.tier).toBe(3)
    expect(result.chosenModel).toBeDefined()
    expect(result.chosenModel?.premium, "tier-3 work reaches the plan-model pool").toBe(true)
    expect(result.decision.needsPremiumApproval).toBe(false)
  })

  it("keeps tier-2 feature work on the ordinary Design Plan pool", () => {
    const { task, result } = route(
      onlineSettings(),
      "Implement a responsive settings page with theme switching and keyboard navigation",
    )
    expect(task.tier).toBe(2)
    expect(result.chosenModel?.premium, "ordinary work never drains the flagship pool").toBe(false)
  })

  it("keeps tier-1 mechanical work on the ordinary pool", () => {
    const { task, result } = route(
      onlineSettings(),
      "Change the button background color to #2563eb in src/components/Button.tsx",
    )
    expect(task.tier).toBe(1)
    expect(result.chosenModel?.premium).toBe(false)
  })

  it("falls back to the strongest ordinary model when the pool is spent", () => {
    const settings = onlineSettings()
    const task = classifyTask({
      text: "Design a complex architecture for this multi-tenant app with event sourcing and a migration plan",
      files: [],
      contextTokens: 10_000,
      recentFailures: 0,
    })
    const registry = buildRegistry({ live: [], settings, definitions: [] })
    const result = routeTask({
      task,
      settings,
      mode: settings.mode,
      runtime: "automatic",
      models: registry.approved(),
      session: session(),
      quota: [provider("opendesign", 10)],
      premium: {
        mode: "auto",
        monthlyBudgetUsd: 120,
        spentUsd: 120,
        remainingUsd: 0,
        planPoolRemainingUsd: 0,
        oneShotGranted: false,
      },
      contextTokens: 10_000,
      cachedTokens: 0,
      dryRun: false,
      now: NOW,
    })
    expect(result.chosenModel).toBeDefined()
    expect(result.chosenModel?.premium, "exhaustion degrades, never fails the task").toBe(false)
    expect(result.decision.needsPremiumApproval).toBe(true)
  })
})
