import { describe, expect, it } from "vitest"
import { classifyFailure } from "../src/core/failures.js"

/**
 * A spent allowance is the only reliable signal available for a provider whose
 * quota cannot be read in advance.
 *
 * OpenDesign publishes no usage endpoint for an inference key — re-verified
 * 2026-11-04: `/v1/usage` and friends return 404, the account host answers 401,
 * and inference responses carry no credit headers. So the router's own figure is
 * a lower bound and it cannot know an allowance is gone until the gateway says
 * no. These tests make sure the saying-no is understood rather than misfiled as
 * a bad request, an auth problem, or a flaky model.
 */

const classify = (input: { message: string; status?: number; type?: string }) =>
  classifyFailure({ message: input.message, status: input.status, type: input.type }, undefined)

describe("quota exhaustion is recognised", () => {
  it("treats 402 as an empty allowance", () => {
    expect(classify({ status: 402, message: "Payment Required" }).class).toBe("quota_exhausted")
  })

  it.each([
    "insufficient credits",
    "Insufficient credit balance",
    "insufficient_quota",
    "You exceeded your current quota",
    "out of credits",
    "allowance exhausted",
    "monthly quota exceeded",
  ])("recognises the phrase %j", (message) => {
    expect(classify({ status: 400, message }).class).toBe("quota_exhausted")
  })

  it("does not retry, because retrying cannot create credit", () => {
    const result = classify({ status: 402, message: "insufficient credits" })
    expect(result.retryable).toBe(false)
  })

  it("never blames the model for an empty account", () => {
    // Charging this to the model would quietly drop a perfectly good model from
    // the reliability record for a billing problem.
    const result = classify({ status: 402, message: "insufficient credits" })
    expect(result.countAgainstModel).toBe(false)
  })

  it("marks it provider-scoped, so the whole provider is held back", () => {
    expect(classify({ status: 402, message: "insufficient credits" }).providerScoped).toBe(true)
  })

  it("still lets the router move to another provider", () => {
    expect(classify({ status: 402, message: "insufficient credits" }).escalate).toBe(true)
  })
})

describe("it does not swallow neighbouring failures", () => {
  it("keeps auth as auth", () => {
    expect(classify({ status: 401, message: "invalid api key" }).class).toBe("auth")
  })

  it("keeps rate limits as rate limits", () => {
    expect(classify({ status: 429, message: "too many requests" }).class).toBe("rate_limit")
  })

  it("keeps context overflow as context overflow", () => {
    expect(classify({ status: 400, message: "maximum context length exceeded" }).class).toBe("context_overflow")
  })

  it("does not treat a generic 400 as a billing problem", () => {
    expect(classify({ status: 400, message: "bad request: messages is required" }).class).not.toBe("quota_exhausted")
  })

  it("does not treat the word 'credit' in unrelated copy as exhaustion", () => {
    expect(classify({ status: 400, message: "unsupported parameter: credit_note" }).class).not.toBe("quota_exhausted")
  })
})
