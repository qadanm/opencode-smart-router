import { describe, expect, it } from "vitest"
import { applyCredentialDefaults, describeEnablement } from "../src/core/providers/enablement.js"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import type { RouterSettings } from "../src/core/types.js"

/**
 * The rule that stops the router assuming a stranger has the author's accounts.
 *
 * The two failure modes being guarded against are symmetric, and both are worse
 * than they look: enabling a provider with no credential produces auth errors
 * for an account the user never claimed, and disabling one they do have silently
 * removes models they are paying for. Explicit configuration must win over
 * detection in both directions.
 */

const settings = (over: Partial<Record<string, boolean>> = {}): RouterSettings => ({
  ...DEFAULT_SETTINGS,
  providers: {
    ...DEFAULT_SETTINGS.providers,
    ...Object.fromEntries(
      Object.entries(over).map(([id, enabled]) => [
        id,
        { ...(DEFAULT_SETTINGS.providers[id] ?? { plan: "go" }), enabled: enabled as boolean },
      ]),
    ),
  },
}) as RouterSettings

const ninth = (result: ReturnType<typeof applyCredentialDefaults>, id: string) =>
  result.settings.providers[id]?.enabled

describe("credential-aware defaults", () => {
  it("turns on a provider that has a credential and was off", () => {
    const result = applyCredentialDefaults(
      settings({ opendesign: false }),
      new Set(),
      [{ providerID: "opendesign", hasCredential: true, source: "~/.config/opencode/opendesign.key" }],
    )
    expect(ninth(result, "opendesign")).toBe(true)
    expect(result.changes).toEqual([
      { providerID: "opendesign", from: false, to: true, reason: "credential found (~/.config/opencode/opendesign.key)" },
    ])
  })

  it("turns off a provider that has no credential and was on", () => {
    const result = applyCredentialDefaults(
      settings({ commandcode: true }),
      new Set(),
      [{ providerID: "commandcode", hasCredential: false }],
    )
    expect(ninth(result, "commandcode")).toBe(false)
    expect(result.changes[0]?.reason).toBe("no credential found on this machine")
  })

  it("leaves an explicit choice alone in both directions", () => {
    const result = applyCredentialDefaults(
      settings({ commandcode: true, opendesign: false }),
      new Set(["commandcode", "opendesign"]),
      [
        { providerID: "commandcode", hasCredential: false },
        { providerID: "opendesign", hasCredential: true, source: "env" },
      ],
    )
    // Nothing changed, but the disagreement is recorded so the UI can explain it.
    expect(ninth(result, "commandcode")).toBe(true)
    expect(ninth(result, "opendesign")).toBe(false)
    expect(result.changes).toEqual([])
    expect(result.keptOnByChoice).toEqual(["commandcode"])
    expect(result.keptOffByChoice).toEqual(["opendesign"])
  })

  it("does nothing when detection agrees with configuration", () => {
    const result = applyCredentialDefaults(
      settings({ commandcode: true }),
      new Set(),
      [{ providerID: "commandcode", hasCredential: true, source: "env" }],
    )
    expect(result.changes).toEqual([])
    expect(ninth(result, "commandcode")).toBe(true)
  })

  it("leaves a provider with no evidence untouched rather than assuming it is absent", () => {
    const before = settings({ opendesign: true })
    const result = applyCredentialDefaults(before, new Set(), [])
    expect(ninth(result, "opendesign")).toBe(true)
    expect(result.changes).toEqual([])
    expect(result.settings).toBe(before)
  })

  it("returns the same object when nothing changed, so callers can skip a re-render", () => {
    const before = settings()
    const result = applyCredentialDefaults(before, new Set(), [
      { providerID: "commandcode", hasCredential: Boolean(before.providers.commandcode?.enabled) },
    ])
    expect(result.settings).toBe(before)
  })

  it("explains every change in a sentence with a way out", () => {
    const result = applyCredentialDefaults(
      settings({ commandcode: true }),
      new Set(),
      [{ providerID: "commandcode", hasCredential: false }],
    )
    const lines = describeEnablement(result)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("providers.commandcode disabled")
    expect(lines[0]).toContain("enabled to true to force it on")
  })
})

describe("explicit-intent detection survives the merge", () => {
  it("only counts a provider whose enabled flag was actually written", async () => {
    const { loadSettings } = await import("../src/core/config.js")
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")

    const home = mkdtempSync(join(tmpdir(), "router-explicit-"))
    mkdirSync(join(home, ".config", "opencode"), { recursive: true })
    writeFileSync(
      join(home, ".config", "opencode", "smart-router.json"),
      JSON.stringify({ providers: { opendesign: { enabled: false } } }),
    )

    const loaded = loadSettings({ home })
    expect(loaded.explicitProviderEnable.has("opendesign")).toBe(true)
    // Everything else was defaulted, not chosen.
    expect(loaded.explicitProviderEnable.has("commandcode")).toBe(false)
  })

  it("treats a config with no providers block as choosing nothing", async () => {
    const { loadSettings } = await import("../src/core/config.js")
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")

    const loaded = loadSettings({ home: mkdtempSync(join(tmpdir(), "router-explicit-empty-")) })
    expect(loaded.explicitProviderEnable.size).toBe(0)
  })
})
