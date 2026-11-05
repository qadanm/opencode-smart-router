import { describe, expect, it } from "vitest"
import { providerProtocol } from "../src/core/models/protocol.js"

describe("providerProtocol", () => {
  it("an explicit protocol wins over the heuristic", () => {
    expect(providerProtocol({ protocol: "anthropic", providerID: "opengate", modelID: "weird-model" })).toBe("anthropic")
    expect(providerProtocol({ protocol: "openai-compat", providerID: "x", modelID: "claude-something" })).toBe(
      "openai-compat",
    )
  })

  it("infers anthropic for claude models on any provider", () => {
    expect(providerProtocol({ providerID: "commandcode", modelID: "claude-haiku-5-5" })).toBe("anthropic")
    expect(providerProtocol({ providerID: "anthropic", modelID: "claude-sonnet-5-5" })).toBe("anthropic")
  })

  it("treats everything else as openai-compat", () => {
    expect(providerProtocol({ providerID: "commandcode", modelID: "deepseek-v4.1-flash" })).toBe("openai-compat")
    expect(providerProtocol({ providerID: "opendesign", modelID: "glm-5.3-flash" })).toBe("openai-compat")
    expect(providerProtocol({ providerID: "unknown", modelID: "weird-model" })).toBe("openai-compat")
  })
})
