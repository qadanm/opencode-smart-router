import { describe, expect, it } from "vitest"
import { buildIndicatorTitle, resolveBaseTitle, stripTitlePrefix } from "../src/core/ui.js"

/**
 * Regression tests for the session-title takeover, and for its removal.
 *
 * The router used to rewrite every chat title to `AUTO · OD · Model — name` and
 * recover the name by stripping that prefix. When the separator was lost, the
 * name was lost with it, and the next write read the prefix back as the name.
 *
 * Version 0.5 removes the rewriting entirely: the router never writes a session
 * title. These tests keep the recovery helpers honest, because they are still
 * needed to clean titles written by older versions.
 */

const tick = (state: { visible: string | undefined; lastWritten: string | undefined; base: string | undefined }, modelLabel: string) => {
  const base = resolveBaseTitle({
    currentTitle: state.visible,
    lastWrittenTitle: state.lastWritten,
    storedBase: state.base,
  })
  if (!base) return
  state.base = base
  state.visible = buildIndicatorTitle({ state: "AUTO", provider: "commandcode", modelLabel, baseTitle: base })
  state.lastWritten = state.visible
}

const rename = (state: { visible: string | undefined; base: string | undefined }, title: string) => {
  state.visible = title
}

describe("title helpers never destroy the name", () => {
  it("keeps the name across five renames and model switches", () => {
    const state: { visible: string | undefined; lastWritten: string | undefined; base: string | undefined } = {
      visible: "Fix the login bug",
      lastWritten: undefined,
      base: undefined,
    }

    const names = ["Fix the login bug", "Login redirect loop", "Auth: session cookies", "Cookie expiry edge case", "Ship the auth fix"]

    for (let i = 0; i < names.length; i += 1) {
      if (i > 0) rename(state, names[i]!)
      tick(state, `model-${i}`)
      expect(state.base).toBe(names[i])
      expect(state.visible).toContain(names[i]!)
      expect(stripTitlePrefix(state.visible)).toBe(names[i])
    }
  })

  it("does not turn a prefix into the name when the title has no base", () => {
    const base = resolveBaseTitle({
      currentTitle: "AUTO · CC · DeepSeek",
      lastWrittenTitle: "AUTO · CC · DeepSeek",
      storedBase: undefined,
    })
    expect(base).toBeUndefined()
  })

  it("keeps compact mode from deleting the name", () => {
    const compact = buildIndicatorTitle({
      state: "AUTO",
      provider: "opendesign",
      modelLabel: "DeepSeek V4.1 Flash",
      baseTitle: "Refactor the parser",
      compact: true,
    })
    expect(compact).toBe("AUTO · DeepSeek V4.1 Flash — Refactor the parser")
    expect(stripTitlePrefix(compact)).toBe("Refactor the parser")
  })

  it("stays idempotent when the title already carries a prefix", () => {
    const first = buildIndicatorTitle({ state: "AUTO", provider: "opendesign", modelLabel: "DeepSeek", baseTitle: "My chat" })
    const second = buildIndicatorTitle({ state: "AUTO", provider: "opendesign", modelLabel: "DeepSeek", baseTitle: first })
    expect(second).toBe(first)
  })

  it("adopts a rename the router did not write, including one that looks like a prefix", () => {
    const base = resolveBaseTitle({
      currentTitle: "AUTO · notes for monday",
      lastWrittenTitle: "AUTO · CC · Model — old name",
      storedBase: "old name",
    })
    expect(base).toBe("AUTO · notes for monday")
  })

  it("restores a name from a title a previous version already damaged", () => {
    const base = resolveBaseTitle({
      currentTitle: "AUTO · CC · Model — Real name",
      lastWrittenTitle: "AUTO · CC · Model — Real name",
      storedBase: undefined,
    })
    expect(base).toBe("Real name")
  })
})

describe("stripTitlePrefix", () => {
  it("returns the name after the separator", () => {
    expect(stripTitlePrefix("AUTO · OD · DeepSeek — Fix login")).toBe("Fix login")
  })

  it("returns an empty string for a title that is only a prefix", () => {
    expect(stripTitlePrefix("MANUAL · CC · model")).toBe("")
  })

  it("leaves an ordinary title untouched", () => {
    expect(stripTitlePrefix("Fix login")).toBe("Fix login")
  })

  it("keeps em dashes that belong to the name", () => {
    expect(stripTitlePrefix("AUTO · OD · Model — Refactor — part 2")).toBe("Refactor — part 2")
  })
})

describe("the router no longer renames sessions", () => {
  it("ships with the title indicator off and the feature removed from settings", async () => {
    const { DEFAULT_SETTINGS } = await import("../src/core/config.js")
    // Accepts either a removed key or an explicitly off flag: both mean the
    // router never takes the title.
    expect((DEFAULT_SETTINGS.ui as { titleIndicator?: boolean }).titleIndicator ?? false).toBe(false)
  })
})
