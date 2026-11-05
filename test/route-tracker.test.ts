import { describe, expect, it } from "vitest"
import { PromptRouteTracker } from "../src/server/route-tracker.js"

const entry = (n: number) => ({
  messageID: `msg_${n}`,
  task: { kind: "feature", tier: 2 },
  decision: { id: `dec_${n}` },
  at: n,
})

describe("PromptRouteTracker", () => {
  it("round-trips the last routed entry per session", () => {
    const tracker = new PromptRouteTracker()
    tracker.set("ses_a", entry(1) as any)
    expect(tracker.get("ses_a")?.messageID).toBe("msg_1")
  })

  it("overwrites on a second prompt for the same session", () => {
    const tracker = new PromptRouteTracker()
    tracker.set("ses_a", entry(1) as any)
    tracker.set("ses_a", entry(2) as any)
    expect(tracker.get("ses_a")?.messageID).toBe("msg_2")
    expect(tracker.size()).toBe(1)
  })

  it("clears a session", () => {
    const tracker = new PromptRouteTracker()
    tracker.set("ses_a", entry(1) as any)
    tracker.clear("ses_a")
    expect(tracker.get("ses_a")).toBeUndefined()
  })

  it("evicts the oldest entries past the bound", () => {
    const tracker = new PromptRouteTracker()
    for (let i = 0; i < 600; i += 1) tracker.set(`ses_${i.toString().padStart(4, "0")}`, entry(i) as any)
    expect(tracker.size()).toBeLessThanOrEqual(500)
    expect(tracker.get("ses_0000")).toBeUndefined()
    expect(tracker.get("ses_0599")).toBeDefined()
  })
})
