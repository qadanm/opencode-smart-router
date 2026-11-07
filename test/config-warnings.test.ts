import { describe, expect, it } from "vitest"
import { validateSettings } from "../src/core/config.js"

describe("config validation warnings", () => {
  // A partial config is the normal case: most files set one or two things.
  // Warning about every key the user did not write made the real problems
  // invisible, so absence and invalidity are now distinguished.
  it("stays silent for absent keys", () => {
    expect(validateSettings({ providers: { opendesign: { plan: "pro", enabled: true } } }).warnings).toEqual([])
  })
  it("still reports every value the user actually got wrong", () => {
    const r = validateSettings({
      mode: "nonsense",
      premium: { mode: "wrong", monthlyBudgetUsd: "cheap" },
      routing: { failClosed: "yes", intelligenceFloor: 200 },
      providers: { opendesign: { enabled: "true", probeUsage: 1 } },
    })
    const w = r.warnings.join(" | ")
    for (const expected of [
      "mode must be one of",
      "premium.mode must be one of",
      "premium.monthlyBudgetUsd must be a finite number",
      "routing.failClosed must be a boolean",
      "routing.intelligenceFloor was clamped",
      "providers.opendesign.enabled must be a boolean",
      "providers.opendesign.probeUsage must be a boolean",
    ]) expect(w).toContain(expected)
  })
})
