import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { classifyTask } from "../src/core/classify/classifier.js"
import { buildRegistry } from "../src/core/models/registry.js"
import { routeTask } from "../src/core/routing/engine.js"
import type { ProviderQuotaSnapshot, RouterSettings } from "../src/core/types.js"

/**
 * Two ways an exhausted provider used to get work anyway.
 *
 * Both were live on 2026-11-02, when the router routed into Command Code while
 * its five-hour window was at 100%. The eligibility logic was correct and the
 * quota data was correct; the decision simply never consulted it, because:
 *
 * 1. A provider with no snapshot yet was treated as unconstrained. The quota
 *    service starts about 1.5s after the plugin loads, so a decision in that
 *    window saw nothing and permitted anything.
 * 2. A snapshot that said "exhausted" stopped saying so as soon as it aged out.
 *    `stale` was only a 0.15 cost penalty, so a refusal expired on a timer while
 *    a permission did not. A full allowance does not refill on a timer.
 *
 * These pin the corrected behaviour, and the guard that keeps it from becoming
 * over-restrictive: a provider that is not probed at all is still allowed.
 */

const NOW = 1_800_000_000_000

const snapshot = (input: {
  providerID: string
  exceeded?: boolean
  stale?: boolean
  usedPct?: number
}): ProviderQuotaSnapshot => {
  const usedPct = input.usedPct ?? (input.exceeded ? 100 : 10)
  const remainingPct = 100 - usedPct
  const window = {
    usedPct,
    remainingPct,
    usedUsd: 3,
    capUsd: 30,
    source: "provider" as const,
    ...(input.exceeded ? { exceeded: true } : {}),
  }
  return {
    providerID: input.providerID,
    label: input.providerID,
    plan: "go",
    source: "provider",
    fetchedAt: NOW,
    stale: input.stale ?? false,
    rolling: window,
    weekly: { ...window },
    monthly: { ...window, usedPct: 10, remainingPct: 90, usedUsd: 6, capUsd: 120 },
    models: {},
    notes: [],
  } as unknown as ProviderQuotaSnapshot
}

const settingsFor = (providers: Record<string, unknown>): RouterSettings => {
  const base = structuredClone(DEFAULT_SETTINGS)
  return {
    ...base,
    providers: { ...base.providers, ...(providers as any) },
  } as RouterSettings
}

const route = (quota: ProviderQuotaSnapshot[], settings: RouterSettings) => {
  const registry = buildRegistry({ live: [], settings, definitions: [] })
  const task = classifyTask({ text: "Implement a feature in src/app.ts" } as any)
  const result: any = routeTask({
    task,
    settings,
    mode: "balanced",
    runtime: "automatic",
    models: registry.approved(),
    quota,
    premium: { mode: "off", monthlyBudgetUsd: 0, spentUsd: 0, remainingUsd: 0, oneShotGranted: false },
    contextTokens: 10_000,
    cachedTokens: 0,
    dryRun: true,
    now: NOW,
    cooldowns: {},
  })
  return result.decision
}

const probeAll = {
  opendesign: { enabled: true, probeUsage: true },
  "opencode-go": { enabled: true, probeUsage: true },
  commandcode: { enabled: true, probeUsage: true },
}

describe("an exhausted provider stays excluded until a fresh probe clears it", () => {
  it("refuses a provider whose last reading said exhausted, even when the reading is stale", () => {
    // Two independent paths enforce this: the `exceeded` flag is checked before
    // anything looks at `stale`, and the reserve check (usedPct >= 100 - reserve)
    // catches the same provider on the percentage alone. Removing either one
    // leaves the other blocking, which is why this property has no single-line
    // mutation that can break it -- the redundancy is deliberate.
    const settings = settingsFor({
      opendesign: { enabled: false },
      commandcode: { ...DEFAULT_SETTINGS.providers.commandcode, enabled: true, probeUsage: true },
    })
    // Command Code is the only route, and it is exhausted but stale.
    const decision = route([snapshot({ providerID: "commandcode", exceeded: true, stale: true })], settings)
    const providers = (decision.candidates ?? []).map((candidate: any) => candidate.model.providerID)
    expect(providers).not.toContain("commandcode")
  })

  it("allows the provider again once a fresh reading says there is room", () => {
    const settings = settingsFor({
      opendesign: { enabled: false },
      commandcode: { ...DEFAULT_SETTINGS.providers.commandcode, enabled: true, probeUsage: true },
    })
    const decision = route([snapshot({ providerID: "commandcode", stale: false })], settings)
    expect(`${decision.chosen?.providerID}`).toBe("commandcode")
  })

  it("keeps excluding it while only a stale exhausted reading exists", () => {
    // Repeated decisions over the same stale data must not slowly re-admit it.
    const settings = settingsFor({
      opendesign: { enabled: false },
      commandcode: { ...DEFAULT_SETTINGS.providers.commandcode, enabled: true, probeUsage: true },
    })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const decision = route([snapshot({ providerID: "commandcode", exceeded: true, stale: true })], settings)
      const providers = (decision.candidates ?? []).map((candidate: any) => candidate.model.providerID)
      expect(providers).not.toContain("commandcode")
    }
  })
})

describe("a probe-enabled provider with no reading yet is not assumed to have room", () => {
  const allOn = settingsFor(probeAll)

  it("refuses a probe-enabled provider that has no snapshot while others do", () => {
    // The shape of the real fault: the quota service has reported for one
    // provider and not another. The unreported one might be full.
    const decision = route([snapshot({ providerID: "opendesign" })], allOn)
    const commandCode = (decision.candidates ?? []).filter(
      (candidate: any) => candidate.model.providerID === "commandcode",
    )
    expect(commandCode).toHaveLength(0)
  })

  it("still routes when nobody has reported yet", () => {
    // Blind is not the same as exhausted. With no quota at all the router must
    // keep working, or a cold start would refuse every request.
    const decision = route([], allOn)
    expect(decision.chosen).toBeDefined()
  })

  it("still routes to a provider that is not probed at all", () => {
    // Absence from the array is how "we do not track this provider" is said.
    // Refusing there would break every provider without a quota model.
    const settings = settingsFor({
      opendesign: { enabled: false },
      commandcode: { ...DEFAULT_SETTINGS.providers.commandcode, enabled: true, probeUsage: false },
    })
    const decision = route([snapshot({ providerID: "opendesign" })], settings)
    expect(decision.chosen).toBeDefined()
  })
})
