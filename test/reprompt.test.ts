import { describe, expect, it } from "vitest"
import { repairMessages } from "../src/core/reprompt.js"

describe("repairMessages", () => {
  it("folds mid-conversation system roles into user for anthropic", () => {
    const input = [
      { role: "user", content: "hello" },
      { role: "system", content: "New instructions" },
      { role: "assistant", content: "ok" },
    ]
    const result = repairMessages(input, { protocol: "anthropic" })
    expect(result.folded).toBe(1)
    expect(result.messages[1].role).toBe("user")
    expect(result.messages[1].content).toBe("New instructions")
    expect(input[1]?.role).toBe("system")
  })

  it("leaves a system message at index 0 untouched", () => {
    const input = [
      { role: "system", content: "You are a helpful router" },
      { role: "user", content: "hello" },
    ]
    const result = repairMessages(input, { protocol: "anthropic" })
    expect(result.folded).toBe(0)
    expect(result.messages).toBe(input)
  })

  it("returns the original array when nothing needs folding", () => {
    const input = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok" },
    ]
    const result = repairMessages(input, { protocol: "anthropic" })
    expect(result.folded).toBe(0)
    expect(result.messages).toBe(input)
  })

  it("does nothing for openai-compat providers", () => {
    const input = [
      { role: "user", content: "hello" },
      { role: "system", content: "New instructions" },
    ]
    const result = repairMessages(input, { protocol: "openai-compat" })
    expect(result.folded).toBe(0)
    expect(result.messages).toBe(input)
  })

  it("preserves part-array content and every other field when folding", () => {
    const input = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "system", content: [{ type: "text", text: "notice" }], id: "msg_s", metadata: { a: 1 } },
    ]
    const result = repairMessages(input, { protocol: "anthropic" })
    expect(result.folded).toBe(1)
    expect(result.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "notice" }],
      id: "msg_s",
      metadata: { a: 1 },
    })
  })

  it("folds multiple system roles and keeps their order", () => {
    const input = [
      { role: "user", content: "1" },
      { role: "system", content: "notice A" },
      { role: "assistant", content: "2" },
      { role: "system", content: "notice B" },
    ]
    const result = repairMessages(input, { protocol: "anthropic" })
    expect(result.folded).toBe(2)
    expect(result.messages.map((m: any) => m.role)).toEqual(["user", "user", "assistant", "user"])
  })

  it("tolerates a non-array and empty messages input", () => {
    expect(repairMessages(undefined as any, { protocol: "anthropic" })).toEqual({ messages: [], folded: 0 })
    expect(repairMessages([], { protocol: "anthropic" })).toEqual({ messages: [], folded: 0 })
  })
})
