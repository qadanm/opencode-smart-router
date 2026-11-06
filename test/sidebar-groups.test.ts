import { describe, expect, it } from "vitest"
import { planGroups, type SidebarRow } from "../src/gui/groups.js"

const row = (key: string, project: string | undefined, working = false): SidebarRow => ({ key, project, working })

const headingOf = (placements: ReturnType<typeof planGroups>, key: string) =>
  placements.find((placement) => placement.key === key)?.heading

describe("planGroups", () => {
  it("leaves the app's order untouched when grouping is off", () => {
    const placements = planGroups([row("a", "alpha"), row("b", "beta"), row("c", "alpha")], false)
    expect(placements.map((placement) => placement.key)).toEqual(["a", "b", "c"])
    expect(placements.every((placement) => placement.grouped === false)).toBe(true)
  })

  it("groups sessions of the same project together", () => {
    const placements = planGroups([row("a1", "alpha"), row("b1", "beta"), row("a2", "alpha")], true)
    const order = placements.map((placement) => placement.key)
    expect(order).toEqual(["a1", "a2", "b1"])
  })

  it("gives a heading only to projects with two or more sessions", () => {
    const placements = planGroups([row("a1", "alpha"), row("b1", "beta"), row("a2", "alpha")], true)
    expect(headingOf(placements, "a1")).toBe("alpha")
    // A single-session project keeps the app's own row, which already names it.
    expect(headingOf(placements, "b1")).toBeUndefined()
  })

  it("puts working sessions, and their projects, first", () => {
    const placements = planGroups(
      [row("a1", "alpha"), row("b1", "beta", true), row("a2", "alpha", true)],
      true,
    )
    const order = placements.map((placement) => placement.key)
    // Working rows lead in the app's relative order: b1 then a2.
    expect(order.slice(0, 2)).toEqual(["b1", "a2"])
    // Their projects lead too, so alpha's remaining row follows.
    expect(order.indexOf("a1")).toBeGreaterThan(1)
  })

  it("treats rows without a project as their own unit", () => {
    const placements = planGroups([row("x", undefined), row("a1", "alpha"), row("a2", "alpha")], true)
    expect(placements.map((placement) => placement.key)).toEqual(["x", "a1", "a2"])
    expect(headingOf(placements, "x")).toBeUndefined()
    expect(headingOf(placements, "a1")).toBe("alpha")
  })

  it("marks a gap where a new project starts", () => {
    const placements = planGroups([row("a1", "alpha"), row("a2", "alpha"), row("b1", "beta")], true)
    expect(placements.find((placement) => placement.key === "a1")?.gap).toBe(false)
    expect(placements.find((placement) => placement.key === "b1")?.gap).toBe(true)
  })

  it("keeps every row exactly once", () => {
    const rows = [row("a1", "alpha"), row("b1", "beta"), row("a2", "alpha"), row("c1", undefined)]
    const placements = planGroups(rows, true)
    expect(placements.map((placement) => placement.key).sort()).toEqual(rows.map((entry) => entry.key).sort())
  })
})
