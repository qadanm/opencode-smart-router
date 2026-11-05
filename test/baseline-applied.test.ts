import { describe, expect, it } from "vitest"
import { loadSettings } from "../src/core/config.js"
import { applyCredentialDefaults } from "../src/core/providers/enablement.js"
import { probeOpenDesignQuota } from "../src/core/quota/opendesign.js"
import type { ProviderSettings } from "../src/core/types.js"

/**
 * The bug this file exists to prevent, reported from a real screen.
 *
 * A user pasted their Plan & balance page showing 37%. The panel immediately
 * showed "≥19%", "STALE", and "estimated from this router's own usage" — their
 * reading was saved but not being used.
 *
 * Two faults compounded:
 *
 *   1. Recording wrote `{ baseline, plan }` and nothing else. OpenDesign defaults
 *      to disabled in DEFAULT_SETTINGS, and the file now said nothing about
 *      `enabled`, so the freshly written config disabled the provider it had just
 *      been given a reading for. Detection re-enabled it at startup, but the write
 *      reloaded settings without re-running detection, so it stayed off until the
 *      next restart.
 *   2. With the provider disabled the estimate fell back to router-only traffic,
 *      which is what the 19% was.
 *
 * Both assertions below are behavioural: they compute the percentage a user would
 * see, not just the shape of a config object.
 */

const NOW = Date.UTC(2026, 10, 4, 23, 0, 0)
const HOUR = 3_600_000

const baseSettings = (over: Partial<ProviderSettings> = {}): ProviderSettings => ({
  enabled: true,
  plan: "pro",
  reserveMonthlyPct: 5,
  reserveWeeklyPct: 10,
  reserveFiveHourPct: 0,
  allowExtraUsage: false,
  probeUsage: true,
  subscriptionOnly: true,
  providerScopedQuota: true,
  ignoreFiveHourWindow: true,
  credentialSource: "explicit",
  ...over,
})

describe("a pasted reading is actually used", () => {
  it("reports the percentage the user pasted", async () => {
    const result = await probeOpenDesignQuota({
      settings: baseSettings({
        baseline: { at: NOW - HOUR, designPlanUsedPct: 37, pctOf: "weekly" },
      }),
      apiKey: "test-key",
      usage: [],
      uncertaintyMarginPct: 0,
      now: () => NOW,
    })
    // 37% of the $90 seven-day cap.
    expect(result.snapshot.weekly.usedPct).toBeCloseTo(37, 0)
    expect(result.snapshot.weekly.usedUsd ?? 0).toBeCloseTo(33.3, 1)
  })

  it("says the figure starts from the reading, not from this router", async () => {
    const result = await probeOpenDesignQuota({
      settings: baseSettings({ baseline: { at: NOW - HOUR, designPlanUsedPct: 37 } }),
      apiKey: "test-key",
      usage: [],
      now: () => NOW,
    })
    expect(result.snapshot.notes[0]).toMatch(/Starts from the usage you reported/)
    expect(result.snapshot.notes[0]).not.toMatch(/this router's own/)
  })
})

describe("a written reading does not disable the provider it belongs to", () => {
  it("survives a config that mentions only a baseline", () => {
    /**
     * The exact shape the writer produced: a fragment naming one provider and one
     * key. Everything else about that provider falls back to the defaults, and the
     * OpenDesign default is `enabled: false`.
     */
    const loaded = loadSettings({
      home: "/nonexistent-home",
      options: { providers: { opendesign: { baseline: { at: NOW, designPlanUsedPct: 37 } } } },
    })
    expect(loaded.settings.providers.opendesign?.enabled).toBe(false)

    // Detection is what turns it back on, so it must run after every reload.
    const detected = applyCredentialDefaults(loaded.settings, loaded.explicitProviderEnable, [
      { providerID: "opendesign", hasCredential: true, source: "~/.config/opencode/opendesign.key" },
    ])
    expect(detected.settings.providers.opendesign?.enabled).toBe(true)
  })

  it("states enabled explicitly when the user records a reading", () => {
    // Pasting a balance is an opt-in. The writer must say so rather than rely on
    // detection, because an explicit flag is something detection never overrules.
    const loaded = loadSettings({
      home: "/nonexistent-home",
      options: { providers: { opendesign: { baseline: { at: NOW, designPlanUsedPct: 37 }, enabled: true } } },
    })
    expect(loaded.settings.providers.opendesign?.enabled).toBe(true)
    expect(loaded.explicitProviderEnable.has("opendesign")).toBe(true)
  })
})
