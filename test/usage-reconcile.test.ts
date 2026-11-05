import { describe, expect, it } from "vitest"
import { parseConsolePage } from "../src/core/plan-page.js"
import { reconcileUsage } from "../src/core/quota/reconcile.js"

/**
 * A usage paste earns its complexity by checking the cost model, so these tests
 * are about arithmetic that can be wrong in a way a percentage page never shows.
 */

const NOW = Date.UTC(2026, 10, 4, 21, 0, 0)

/** A usage table as a console would render it: model, tokens, credits charged. */
const USAGE_PAGE = `Usage
Oct 28, 2026 – Nov 4, 2026
Model
Input tokens
Output tokens
Credits
DeepSeek V4.1 Flash
1,000,000
0
$0.15
GLM-5.3 Flash
2,000,000
0
$0.15
Claude Haiku 5.5
1,000,000
0
$0.20
Total
$0.50`

describe("detecting which page was pasted", () => {
  it("recognises a usage page", () => {
    const reading = parseConsolePage(USAGE_PAGE, NOW)
    expect(reading?.kind).toBe("usage")
  })

  it("recognises an allowance page", () => {
    const reading = parseConsolePage(
      `Pro
Design Plan credits
41%
7 days of quota remaining
Reset in 0 days 22 hours`,
      NOW,
    )
    expect(reading?.kind).toBe("allowance")
  })

  it("returns nothing for a page it cannot read, rather than a half-reading", () => {
    expect(parseConsolePage("Welcome to OpenDesign\nSign in", NOW)).toBeUndefined()
  })
})

describe("checking the cost model against what was charged", () => {
  const page = parseConsolePage(USAGE_PAGE, NOW)
  const result = reconcileUsage(page as never)

  it("finds the models by display name", () => {
    const matched = result.rows.filter((row) => row.modelID !== undefined)
    expect(matched.map((row) => row.modelID).sort()).toEqual([
      "claude-haiku-5.5",
      "deepseek-v4.1-flash",
      "glm-5.3-flash",
    ])
  })

  it("derives the multiplier actually applied", () => {
    // 1M input tokens of DeepSeek V4.1 Flash is $0.30 of usage at 1x; $0.15
    // charged means the 0.5x Design Plan multiplier was really applied.
    const deepseek = result.rows.find((row) => row.modelID === "deepseek-v4.1-flash")!
    expect(deepseek.baseUsd).toBeCloseTo(0.3, 6)
    expect(deepseek.impliedMultiplier).toBeCloseTo(0.5, 6)
    expect(deepseek.catalogMultiplier).toBe(0.5)
    expect(deepseek.verdict).toBe("agrees")
  })

  it("agrees on a 2x model as well as a 0.5x one", () => {
    const haiku = result.rows.find((row) => row.modelID === "claude-haiku-5.5")!
    expect(haiku.impliedMultiplier).toBeCloseTo(2, 6)
    expect(haiku.verdict).toBe("agrees")
  })

  it("says so plainly when everything lines up", () => {
    expect(result.agree).toBe(3)
    expect(result.differ).toBe(0)
    expect(result.summary).toMatch(/matches what was charged/)
  })

  it("reports a disagreement with the size of the gap", () => {
    // Charged double what the catalog predicts for a 1x model.
    const wrong = parseConsolePage(USAGE_PAGE.replace("GLM-5.3 Flash\n2,000,000\n0\n$0.15", "GLM-5.3 Flash\n2,000,000\n0\n$0.30"), NOW)
    const checked = reconcileUsage(wrong as never)
    const glm = checked.rows.find((row) => row.modelID === "glm-5.3-flash")!
    expect(glm.verdict).toBe("differs")
    expect(glm.impliedMultiplier).toBeCloseTo(2, 6)
    expect(glm.driftPct).toBeCloseTo(100, 0)
    expect(checked.summary).toMatch(/disagrees/)
  })

  it("tolerates rounding without calling it a finding", () => {
    // 0.5 of $0.30 is $0.15; $0.152 is a rounding difference, not a wrong price.
    const rounded = parseConsolePage(USAGE_PAGE.replace("$0.15", "$0.152"), NOW)
    const checked = reconcileUsage(rounded as never)
    const deepseek = checked.rows.find((row) => row.modelID === "deepseek-v4.1-flash")!
    expect(deepseek.verdict).toBe("agrees")
  })

  it("keeps a row it cannot match instead of dropping the evidence", () => {
    const unknown = parseConsolePage(`${USAGE_PAGE}\nSome Future Model\n5,000\n0\n$1.00`, NOW)
    const checked = reconcileUsage(unknown as never)
    expect(checked.rows.some((row) => row.verdict === "unmatched")).toBe(true)
    expect(checked.unmatched).toBeGreaterThan(0)
  })

  it("does not invent a multiplier when the page shows no tokens", () => {
    const creditsOnly = parseConsolePage(
      `Usage
DeepSeek V4.1 Flash
$0.15
GLM-5.3 Flash
$0.15
Claude Haiku 5.5
$0.20`,
      NOW,
    )
    const checked = reconcileUsage(creditsOnly as never)
    // Charges are known, token counts are not, so no verdict is claimed.
    expect(checked.rows.every((row) => row.verdict === "no-price" || row.verdict === "unmatched")).toBe(true)
  })
})
