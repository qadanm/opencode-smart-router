import { describe, expect, it } from "vitest"
import {
  ChangeNotifier,
  buildIndicatorTitle,
  indicatorState,
  providerShort,
  stripTitlePrefix,
} from "../src/core/ui.js"

describe("persistent indicator", () => {
  it("uses compact provider names", () => {
    expect(providerShort("opencode-go")).toBe("Go")
    expect(providerShort("commandcode")).toBe("CC")
    expect(providerShort("other")).toBe("other")
  })

  it("round-trips the status prefix without losing the original title", () => {
    const title = buildIndicatorTitle({
      state: "AUTO",
      provider: "opencode-go",
      modelLabel: "Claude Haiku 5.5",
      baseTitle: "Refactor auth",
    })
    expect(title).toBe("AUTO · Go · Claude Haiku 5.5 — Refactor auth")
    expect(stripTitlePrefix(title)).toBe("Refactor auth")
    expect(stripTitlePrefix("Plain title")).toBe("Plain title")
  })

  it("keeps pause and manual states ahead of dry run", () => {
    expect(indicatorState({ enabled: true, runtimePaused: true, manual: true, dryRun: true })).toBe("PAUSED")
    expect(indicatorState({ enabled: true, runtimePaused: false, manual: true, dryRun: true })).toBe("MANUAL")
    expect(indicatorState({ enabled: true, runtimePaused: false, manual: false, dryRun: true })).toBe("DRY RUN")
    expect(indicatorState({ enabled: true, runtimePaused: false, manual: false, dryRun: false })).toBe("AUTO")
  })

  it("deduplicates repeated notification keys", () => {
    const notifier = new ChangeNotifier()
    expect(notifier.shouldNotify("same")).toBe(true)
    expect(notifier.shouldNotify("same")).toBe(false)
    expect(notifier.shouldNotify("different")).toBe(true)
  })
})
