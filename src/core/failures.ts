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
  /**
   * True when the failure is the provider's fault and should count against
   * the model's reliability record. A user-initiated interrupt is not.
   */
  readonly countAgainstModel: boolean
  /**
   * True when the fault is in the provider's own pre-request path (billing
   * scope, plan entitlement) rather than in the serving model. Such a fault
   * belongs to the provider as a whole and must not be charged to a model.
   */
  readonly providerScoped: boolean
  /**
   * True when the provider's gateway refused the work because it is saturated.
   *
   * Kept separate from `providerScoped` because the two need different
   * handling downstream. A billing-scope fault happens before a model is even
   * chosen, so cooling that model would be arbitrary blame. A saturated
   * gateway is a reason to step off the endpoint that just refused, so the
   * serving model is held back too.
   */
  readonly saturation?: boolean
}

const includes = (value: string, terms: ReadonlyArray<string>) => terms.some((term) => value.includes(term))

export const classifyFailure = (input: FailureInput, session?: SessionState): FailureAssessment => {
  const message = input.message.toLowerCase()
  const type = (input.type ?? "").toLowerCase()
  const status = input.status

  // A user or agent interrupt is not a provider fault and must never count
  // against a model's reliability.
  if (
    type.includes("abort") ||
    type.includes("interrupt") ||
    includes(message, ["step interrupted", "request aborted", "operation canceled", "operation cancelled", "user aborted"])
  ) {
    return {
      class: "interrupted",
      retryable: false,
      capabilityFailure: false,
      escalate: false,
      cooldownMs: 0,
      reason: "The step was interrupted; this is not evidence of a provider fault.",
      countAgainstModel: false,
      providerScoped: false,
    }
  }


  /**
   * The account is out of allowance.
   *
   * This is the compensation for every provider whose quota cannot be read in
   * advance: OpenDesign publishes no usage endpoint for an inference key, so the
   * router's own figure is a lower bound and it will not notice a spent
   * allowance until the provider says no. The first refusal is therefore the
   * signal, and it has to be used properly — retrying cannot conjure credit, and
   * hammering the same exhausted provider wastes a turn each time.
   *
   * Checked before the generic 4xx paths because gateways disagree on the status
   * code: 402 is the honest one, but a 400 or 403 with "insufficient credits" is
   * common, and treating that as `invalid_request` would blame the user's prompt
   * for an empty wallet.
   */
  if (
    // 402 is the unambiguous signal. A 5xx is never this: a server fault in the
    // billing path is an outage, not an empty account, and OpenDesign returns
    // exactly that as `workspace_billing_scope_unavailable`.
    status === 402 ||
    ((status === undefined || status < 500) &&
      includes(message, [
        "insufficient credit",
        "insufficient_credit",
        "insufficient balance",
        "insufficient_quota",
        "no credit left",
        "out of credit",
        "credit balance is",
        "credit limit reached",
        "quota exceeded",
        "quota_exceeded",
        "allowance exhausted",
        "allowance is exhausted",
        "exceeded your current quota",
      ]))
  ) {
    return {
      class: "quota_exhausted",
      retryable: false,
      capabilityFailure: false,
      escalate: true,
      cooldownMs: 0,
      reason: "The provider reports no allowance left; retrying the same model cannot help.",
      // The account is empty, not the model. Charging this to the model would
      // make a perfectly good model look unreliable and quietly drop it.
      countAgainstModel: false,
      providerScoped: true,
    }
  }

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
      countAgainstModel: false,
      providerScoped: false,
    }
  }

  if (status === 429 || includes(message, ["rate limit", "rate_limit", "too many requests"]) || type.includes("rate_limit") || type.includes("ratelimit")) {
    return {
      class: "rate_limit",
      retryable: true,
      capabilityFailure: false,
      escalate: false,
      cooldownMs: 2 * 60_000,
      reason: "Provider rate limit; wait or use another provider. A stronger model would consume the same limit.",
      countAgainstModel: true,
      providerScoped: false,
    }
  }

  if (status === 401 || status === 403 || includes(message, ["unauthorized", "invalid api key", "authentication", "forbidden", "permission denied"]) || type.includes("auth")) {
    return {
      class: "auth",
      retryable: false,
      capabilityFailure: false,
      escalate: false,
      cooldownMs: 15 * 60_000,
      reason: "Authentication or authorization failed; escalating models cannot fix a credential problem.",
      countAgainstModel: true,
      providerScoped: false,
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
      countAgainstModel: true,
      providerScoped: false,
    }
  }

  // A stream that starts and then dies reports HTTP 200 with a provider
  // error inside the stream body, so the status code alone never identifies
  // it. OpenCode surfaces these as a `provider.*` error type, most often
  // `provider.internal` (an engine fault) or `provider.invalid-output` (a
  // stream that ended without a finish reason).
  const providerType = type.startsWith("provider.") || type.includes("invalidprovideroutput")
  const streamFailure =
    providerType ||
    includes(message, [
      "streaming response failed",
      "enginecore encountered an issue",
      "server_error",
      "provider.internal",
      "invalid-output",
      "invalidprovideroutput",
      "internal server error",
      "upstream error",
      "upstream failure",
      "incomplete stream",
      "stream closed",
      "stream ended unexpectedly",
      "stream ended without finish_reason",
      "without finish_reason",
      "connection closed",
      "unexpected eof",
    ]) ||
    (/\[\s*5\d\d\s*\]/.test(message) && includes(message, ["stream", "response", "engine"]))

  // A billing-scope resolution failure happens in the provider's own billing
  // path before any model is selected. It would hit every model on that
  // provider identically, so charging it to whichever model happened to be
  // serving misattributes a provider-wide fault to one model and penalises
  // a model that did nothing wrong.
  const providerScopedBillingFault =
    includes(message, [
      "workspace_billing_scope_unavailable",
      "billing_scope_unavailable",
      "resolve billing scope",
      "billing scope unavailable",
      // OpenDesign evaluates the account's plan membership before it serves
      // any request. Failing that is also a provider-side fault.
      "membership entitlement",
      "evaluate membership",
    ]) || type.includes("billing_scope_unavailable")

  // Capacity exhaustion resembles the billing-scope case above in one respect
  // and differs in another, so it gets its own flag rather than reusing that
  // one. Like the billing fault it happens at the gateway before a model does
  // any work, so it is nothing to hold against the model's ability. Unlike the
  // billing fault, the endpoint really did refuse this request, so it must be
  // stepped away from at once.
  //
  // This matters because the alternative is worse than useless. When the
  // gateway is saturated the retry hook can only wait and try again (the host
  // exposes no way to change model mid-turn), so a fault that never reaches
  // the provider means every retry and every following prompt lands on a
  // gateway that is still refusing work.
  //
  // Deliberately narrow. Generic "overloaded", 5xx and stream failures stay
  // model-scoped: those can be a single bad route, and holding an entire
  // healthy provider back over one flaky model would be its own kind of error.
  const upstreamSaturation =
    includes(message, [
      // The gateway's own advice names the provider as the problem.
      "alternative llm api service providers",
      "service is too busy",
      // Capacity refusals raised by the admission layer.
      "ttft_admission_refused",
      "admission refused",
      "at capacity",
    ]) || (type.includes("upstream") && includes(message, ["busy", "capacity"]))

  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    streamFailure ||
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
      reason: providerScopedBillingFault
        ? "The provider's own pre-request path failed before a model was selected. This is provider-scoped, not a fault of the serving model, so it is not counted against the model's reliability."
        : upstreamSaturation
          ? "The provider's gateway is saturated. Every model behind it is affected, so the provider is counted as failing, and the endpoint that actually refused is held back too."
          : "Provider capacity or outage; retry shortly or fail over. A stronger model would hit the same capacity limit, so no escalation is warranted.",
      countAgainstModel: !providerScopedBillingFault,
      providerScoped: providerScopedBillingFault,
      ...(upstreamSaturation && !providerScopedBillingFault ? { saturation: true } : {}),
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
      countAgainstModel: true,
      providerScoped: false,
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
      countAgainstModel: false,
      providerScoped: false,
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
      countAgainstModel: true,
      providerScoped: false,
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
      countAgainstModel: true,
      providerScoped: false,
    }
  }

  return {
    class: "unknown",
    retryable: false,
    capabilityFailure: false,
    escalate: false,
    cooldownMs: 30_000,
    reason: "Unclassified failure; do not escalate automatically without evidence.",
    countAgainstModel: false,
    providerScoped: false,
  }
}

export const failureCooldown = (assessment: FailureAssessment) => assessment.cooldownMs

export const shouldAvoidProvider = (assessment: FailureAssessment) =>
  assessment.class === "auth" || assessment.class === "rate_limit" || assessment.class === "provider_outage" || assessment.class === "network"

export const shouldEscalate = (assessment: FailureAssessment) => assessment.escalate && assessment.capabilityFailure
