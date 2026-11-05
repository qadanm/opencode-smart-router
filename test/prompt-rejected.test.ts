import { describe, expect, it } from "vitest"
import { classifyFailure } from "../src/core/failures.js"

describe("prompt_rejected failure class", () => {
  // The tuck-session error, verbatim. It contains neither "invalid request"
  // nor a meaningful status classification, which is why it slipped into the
  // provider-stream rule and its deterministic 400 got retried as if it were
  // an outage.
  it("classifies the anthropic role-discriminator 400 as prompt_rejected", () => {
    const a = classifyFailure({
      type: "provider.invalid-request",
      message: "Invalid discriminator value. Expected 'user' | 'assistant' at messages.23.role",
      status: 400,
    })
    expect(a.class).toBe("prompt_rejected")
    expect(a.retryable).toBe(false)
    expect(a.countAgainstModel).toBe(false)
    expect(a.providerScoped).toBe(false)
    expect(a.cooldownMs).toBe(300_000)
  })

  it("classifies invalid-request with no status as prompt_rejected", () => {
    const a = classifyFailure({
      type: "provider.invalid-request",
      message: "Invalid discriminator value. Expected 'user' | 'assistant' at messages.2.role",
    })
    expect(a.class).toBe("prompt_rejected")
  })

  it("matches anthropic invalid_request_error bodies naming message positions", () => {
    const a = classifyFailure({
      type: "provider.invalid-request",
      message: "invalid_request_error: messages.67.role Invalid discriminator value",
    })
    expect(a.class).toBe("prompt_rejected")
  })

  it("keeps stream engine faults as provider_outage", () => {
    const a = classifyFailure({ type: "provider.internal", message: "enginecore encountered an issue" })
    expect(a.class).toBe("provider_outage")
  })

  it("keeps generic bad requests as invalid_request", () => {
    const a = classifyFailure({
      message: "The request shape was invalid: unsupported parameter foo",
      status: 400,
    })
    expect(a.class).toBe("invalid_request")
  })
})
