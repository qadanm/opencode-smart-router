import { JSDOM } from "jsdom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { planGroups, type SidebarRow } from "../src/gui/groups.js"

/**
 * Parity and improvement checks against the reference implementation.
 *
 * opencode-plus (MIT) ships a test file that encodes the behaviours its author
 * considered bugs after shipping: wrong group threshold, headings sticking to
 * the row above, working sessions at the bottom, stale + buttons, a click that
 * also opens the session, a duplicated menu item. Each case below is the same
 * scenario expressed against our planner, plus the improvements we chose.
 */

const row = (key: string, project: string | undefined, working = false): SidebarRow => ({ key, project, working })
const byKey = (rows: SidebarRow[], grouped = true) => {
  const plan = planGroups(rows, grouped)
  return new Map(plan.map((placement) => [placement.key, placement]))
}

describe("parity with the reference's bug list", () => {
  it("groups a project's sessions under one heading and leaves a single session alone", () => {
    // Reference: ["R1 roadmap-sync", "R2 -", "T1 telemetry.dev", "T2 -", "D1 -"]
    const rows = [
      row("R1", "roadmap-sync"),
      row("T1", "telemetry.dev"),
      row("R2", "roadmap-sync"),
      row("D1", "dev"),
      row("T2", "telemetry.dev"),
    ]
    const plan = planGroups(rows, true)
    const ordered = [...plan].sort((a, b) => a.order - b.order)
    const shown = ordered.map((placement) => `${placement.key} ${placement.heading ?? "-"}`)
    expect(shown).toEqual(["R1 roadmap-sync", "R2 -", "T1 telemetry.dev", "T2 -", "D1 -"])
  })

  it("starts each project after the first with a gap", () => {
    // Reference expects gaps: [false, false, true, true]
    const rows = [row("R1", "roadmap-sync"), row("D1", "dev"), row("R2", "roadmap-sync"), row("T1", "telemetry.dev")]
    const plan = byKey(rows)
    expect(["R1", "R2", "D1", "T1"].map((key) => plan.get(key)?.gap)).toEqual([false, false, true, true])
  })

  it("puts a working session first, in its project's group", () => {
    // Reference: ["T0 telemetry.dev", "T1 -", "T2 -", "R1 -"]
    const rows = [
      row("R1", "roadmap-sync"),
      row("T1", "telemetry.dev"),
      row("T2", "telemetry.dev"),
      row("T0", "telemetry.dev", true),
    ]
    const plan = [...planGroups(rows, true)].sort((a, b) => a.order - b.order)
    expect(plan.map((placement) => placement.key)).toEqual(["T0", "T1", "T2", "R1"])
  })

  it("keeps a heading only while a project has two or more sessions", () => {
    // Reference: a project dropping to one session must lose its heading (and
    // with it, its + button). Our planner recomputes headings from the rows.
    const two = byKey([row("R1", "roadmap-sync"), row("R2", "roadmap-sync")])
    expect(two.get("R1")?.heading).toBe("roadmap-sync")
    const one = byKey([row("R1", "roadmap-sync")])
    expect(one.get("R1")?.heading).toBeUndefined()
  })
})

describe("improvements over the reference", () => {
  it("never blends ungrouped rows into a heading's group", () => {
    // Reference treats a row without a project as its own unit; ours marks it
    // ungrouped so a consumer never renders it under a heading.
    const plan = byKey([row("X", undefined), row("A1", "alpha"), row("A2", "alpha")])
    expect(plan.get("X")?.grouped).toBe(false)
    expect(plan.get("A1")?.grouped).toBe(true)
  })

  it("preserves the app's order exactly when grouping is off", () => {
    // Reference's `layout(false, false)` leaves order untouched; so do we, and we
    // say so structurally instead of relying on clearing styles.
    const rows = [row("B", "beta"), row("A", "alpha"), row("C", "alpha")]
    expect(planGroups(rows, false).map((placement) => placement.key)).toEqual(["B", "A", "C"])
  })

  it("is deterministic for repeated calls with the same rows", () => {
    const rows = [row("A1", "alpha"), row("B1", "beta"), row("A2", "alpha")]
    expect(planGroups(rows, true)).toEqual(planGroups(rows, true))
  })
})
