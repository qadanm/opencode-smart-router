import type { FailureClass, SessionState } from "./types.js"

export interface FailureInput {
  readonly type?: string
  readonly message: string
  readonly status?: number
}

export interface FailureAssessment {
  readonly class: FailureClass
  readonly retryable: boolean
  readonly capabilityFailure: boolean
  readonly escalate: boolean
  readonly cooldownMs: number
  readonly reason: string
}

const includes = (value: string, terms: ReadonlyArray<string>) => terms.some((term) => value.includes(term))

export const classifyFailure = (input: FailureInput, session?: SessionState): FailureAssessment => {
  const message = input.message.toLowerCase()
  const type = (input.type ?? "").toLowerCase()
  const status = input.status

  if (
    includes(message, [
      "context length",
      "context_length_exceeded",
      "maximum context",
      "too many tokens",
      "prompt is too long",
      "exceeds the context",
      "context window",
      "input is too long",
    ])
  ) {
    return {
      class: "context_overflow",
      retryable: false,
      capabilityFailure: false,
      escalate: false,
      cooldownMs: 0,
      reason: "Context overflow is a session-size problem, not an intelligence failure. Compact or start a handoff session.",
    }
  }

  if (status === 429 || includes(message, ["rate limit", "rate_limit", "too many requests"])) {
    return {
      class: "rate_limit",
      retryable: true,
      capabilityFailure: false,
      escalate: false,
      cooldownMs: 2 * 60_000,
      reason: "Provider rate limit; wait or use another provider. A stronger model would consume the same limit.",
    }
  }

  if (status === 401 || status === 403 || includes(message, ["unauthorized", "invalid api key", "authentication", "forbidden", "permission denied"])) {
    return {
      class: "auth",
      retryable: false,
      capabilityFailure: false,
      escalate: false,
      cooldownMs: 15 * 60_000,
      reason: "Authentication or authorization failed; escalating models cannot fix a credential problem.",
    }
  }

  if (
    includes(message, ["image", "media", "unsupported content", "invalid image", "vision", "content type"]) &&
    includes(message, ["unsupported", "invalid", "not support", "reject", "format"])
  ) {
    return {
      class: "image_rejected",
      retryable: false,
      capabilityFailure: false,
      escalate: false,
      cooldownMs: 10 * 60_000,
      reason: "The endpoint rejected the image input; route visual work only to a verified vision model.",
    }
  }

  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    includes(message, [
      "overloaded",
      "temporarily unavailable",
      "upstream",
      "service unavailable",
      "provider outage",
      "bad gateway",
      "ttft_admission_refused",
      "admission refused",
      "at capacity",
    ])
  ) {
    return {
      class: "provider_outage",
      retryable: true,
      capabilityFailure: false,
      escalate: false,
      cooldownMs: 5 * 60_000,
      reason:
        "Provider capacity or outage; retry shortly or fail over. A stronger model would hit the same capacity limit, so no escalation is warranted.",
    }
  }

  if (includes(message, ["timeout", "timed out", "econnreset", "econnrefused", "fetch failed", "socket", "network", "dns"])) {
    return {
      class: "network",
      retryable: true,
      capabilityFailure: false,
      escalate: false,
      cooldownMs: 60_000,
      reason: "Network failure; retry with backoff. This is not evidence that a stronger model is needed.",
    }
  }

  if (includes(message, ["tool", "shell command", "command failed", "exit code", "enoent", "permission denied"]) && type.includes("tool")) {
    return {
      class: "tool",
      retryable: false,
      capabilityFailure: false,
      escalate: false,
      cooldownMs: 0,
      reason: "A tool or command failed; fix the tool, dependency, or permission issue rather than escalating the model.",
    }
  }

  if (includes(message, ["invalid request", "bad request", "unsupported parameter", "malformed"])) {
    return {
      class: "invalid_request",
      retryable: false,
      capabilityFailure: false,
      escalate: false,
      cooldownMs: 5 * 60_000,
      reason: "The request shape was invalid; fix the request or provider compatibility instead of escalating.",
    }
  }

  const capabilityFailures = session?.failures.filter((failure) => failure.class === "capability").length ?? 0
  if (
    includes(message, ["cannot complete", "unable to complete", "gave up", "i don't know how", "not able to", "incomplete", "failed to implement"]) ||
    (type.includes("model") && capabilityFailures >= 1)
  ) {
    return {
      class: "capability",
      retryable: false,
      capabilityFailure: true,
      escalate: capabilityFailures < 1,
      cooldownMs: 0,
      reason: "Possible capability failure; escalate one tier only after evidence, not after a single ambiguous error.",
    }
  }

  return {
    class: "unknown",
    retryable: false,
    capabilityFailure: false,
    escalate: false,
    cooldownMs: 30_000,
    reason: "Unclassified failure; do not escalate automatically without evidence.",
  }
}

export const failureCooldown = (assessment: FailureAssessment) => assessment.cooldownMs

export const shouldAvoidProvider = (assessment: FailureAssessment) =>
  assessment.class === "auth" || assessment.class === "rate_limit" || assessment.class === "provider_outage" || assessment.class === "network"

export const shouldEscalate = (assessment: FailureAssessment) => assessment.escalate && assessment.capabilityFailure
