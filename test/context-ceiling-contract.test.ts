import { describe, expect, it } from "vitest"
import {
  CONTEXT_ELIGIBILITY_MARGIN_TOKENS,
  CONTEXT_SAFE_WINDOW_FRACTION,
  decideCompaction,
} from "../src/core/context/strategy.js"
import { evaluateEligibility } from "../src/core/policy/eligibility.js"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { buildRegistry } from "../src/core/models/registry.js"
import type { RouterSettings } from "../src/core/types.js"
import { readFileSync } from "node:fs"

/**
 * The routing ceiling and the compaction threshold must be the same number.
 *
 * Both are derived from the same two quantities: a model's window, minus a
 * margin for the reply, scaled by a safety fraction. They were computed in two
 * separate files, and one of them used the literals `20_000` and `0.95` while
 * the other used exported constants. Editing a constant would therefore have
 * moved one threshold and not the other, and the session would compact at a
 * different size than the router refuses to route at.
 *
 * For DeepSeek V4.1 Flash at its measured 1,048,000 window that boundary is
 * 975,600 tokens. The owner has chosen to keep that margin deliberately: the
 * remaining 72,400 tokens cover the reply, tokenizer differences between the
 * router's estimate and the gateway's count, and the growth of the transcript
 * during a long tool loop. Recovering the last 7% is not worth a failed turn.
 */

/** The tokens a session may actually use on a model with this window. */
const usable = (window: number) =>
  Math.floor(window * CONTEXT_SAFE_WINDOW_FRACTION) - CONTEXT_ELIGIBILITY_MARGIN_TOKENS

describe("the routing ceiling is one number, shared by both gates", () => {
  it("computes 975,600 usable tokens on the measured DeepSeek window", () => {
    // This is the number the owner signed off on. If it changes, either a
    // constant moved or the window did, and both are worth noticing.
    expect(usable(1_048_000)).toBe(975_600)
  })

  it("keeps the 72,400-token margin intact", () => {
    // 1,048,000 - 975,600. This is deliberate headroom, not slack to reclaim.
    expect(1_048_000 - usable(1_048_000)).toBe(72_400)
  })

  it("rejects routing exactly one token above the ceiling and allows the ceiling", () => {
    // OpenDesign is disabled by default, so a test that forgets this gets
    // "Provider is disabled" instead of the context verdict it is asserting on.
    const settings: RouterSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      providers: {
        ...structuredClone(DEFAULT_SETTINGS.providers),
        opendesign: { ...structuredClone(DEFAULT_SETTINGS.providers.opendesign)!, enabled: true, plan: "pro" },
      },
    }
    const registry = buildRegistry({ live: [], settings })
    const model = registry.get("opendesign", "deepseek-v4.1-flash")
    expect(model).toBeDefined()
    expect(model!.context).toBe(1_048_000)

    const atCeiling = evaluateEligibility({
      model: model!,
      task: {
        tier: 2,
        requiresVision: false,
        scope: { promptTokens: 0 },
      } as never,
      settings,
      mode: settings.mode,
      premium: { allowed: true, requiresApproval: false, reason: "" },
      contextTokens: usable(model!.context),
    })
    expect(atCeiling.eligible, "the ceiling itself must be routable").toBe(true)

    const overCeiling = evaluateEligibility({
      model: model!,
      task: {
        tier: 2,
        requiresVision: false,
        scope: { promptTokens: 0 },
      } as never,
      settings,
      mode: settings.mode,
      premium: { allowed: true, requiresApproval: false, reason: "" },
      contextTokens: usable(model!.context) + 1,
    })
    expect(overCeiling.eligible).toBe(false)
    expect(overCeiling.rejectedFor).toBe("context")
  })

  it("compacts at the same boundary the router stops routing at", () => {
    // Both gates apply the same comparison, `context + margin > window * 0.95`,
    // so the last routable size is 975,600 and compaction begins at 975,601.
    // They are strict inequalities, so the two land one token apart rather than
    // on the same value. What matters is that neither is computed from a
    // different pair of numbers, which is what would let them diverge.
    const window = 1_048_000
    const settings = DEFAULT_SETTINGS.contextManagement

    const lastRoutable = decideCompaction({
      mode: "native",
      settings,
      contextTokens: usable(window),
      effectiveWindow: window,
    })
    expect(lastRoutable.compact, "the last routable size must not compact").toBe(false)

    const firstOverflow = decideCompaction({
      mode: "native",
      settings,
      contextTokens: usable(window) + 1,
      effectiveWindow: window,
    })
    expect(firstOverflow.compact, "one token past it must compact").toBe(true)
    expect(firstOverflow.hardLimit).toBe(true)
  })

  it("derives the routing gate from the shared constants, not from literals", () => {
    // This is the regression that matters. The gate in eligibility.ts used to
    // repeat `20_000` and `0.95` as literals while strategy.ts exported these
    // constants, so changing a constant moved the compaction threshold and left
    // the routing gate behind. A test that only checks today's numbers would
    // pass either way; this one proves the gate reads the constant by overriding
    // the module-level value it consumes.
    //
    // The check is structural rather than behavioural because the constants are
    // compile-time values: reading the source is the only way to assert that the
    // literal is gone. Comment text is stripped first so the explanatory comment
    // above the gate cannot satisfy the check on its own.
    const source = readFileSync(new URL("../src/core/policy/eligibility.ts", import.meta.url), "utf8")
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
    expect(code).not.toMatch(/\+\s*20_000/)
    expect(code).not.toMatch(/\*\s*0\.95/)
    expect(code).toMatch(/CONTEXT_ELIGIBILITY_MARGIN_TOKENS/)
    expect(code).toMatch(/CONTEXT_SAFE_WINDOW_FRACTION/)
  })
})
