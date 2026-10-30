import { describe, expect, it } from "vitest"
import { classifyFailure } from "../src/core/failures.js"
import { LedgerStore, PROVIDER_DOWN_STREAK } from "../src/core/quota/ledger.js"

/**
 * The live error this file is about, captured from a real turn in
 * `dev/car-spotter-game` on 2026-10-30. Four attempts in 72 seconds, all to the
 * same model, and then the turn died on the owner's screen.
 *
 * The message says in plain words that the fault is the provider's, not the
 * model's: "We advise users to temporarily switch to alternative LLM API
 * service providers." The router used to disagree, charging all four failures
 * to `opendesign/deepseek-v4.1-flash` and leaving every sibling model on the
 * same saturated gateway fully eligible.
 */
const BUSY_ERROR = {
  type: "provider.internal",
  message:
    "[code=upstream_error] Service is too busy. We advise users to temporarily switch to alternative LLM API service providers. (request_id: e859cec3-0f60-4acb-962b-4fbea75f01a1)",
}

const MODEL = { providerID: "opendesign", id: "deepseek-v4.1-flash" }

describe("gateway saturation is provider-scoped, not model-scoped", () => {
  it("does not charge a busy gateway against the model's intelligence record", () => {
    const assessment = classifyFailure(BUSY_ERROR)
    expect(assessment.class).toBe("provider_outage")
    // The gateway refused before any model did work, so this is not evidence
    // about the model's ability. But the endpoint that refused must be stepped
    // away from, which is what `saturation` says separately from `providerScoped`.
    expect(assessment.saturation).toBe(true)
    expect(assessment.providerScoped).toBe(false)
  })

  it("still retries and still steps back, because the fault is transient", () => {
    const assessment = classifyFailure(BUSY_ERROR)
    expect(assessment.retryable).toBe(true)
    expect(assessment.escalate).toBe(false)
    expect(assessment.cooldownMs).toBeGreaterThan(0)
  })

  it("holds the refusing endpoint back on the very first failure", () => {
    const store = new LedgerStore()
    const assessment = classifyFailure(BUSY_ERROR)
    store.recordFailure("ses_busy", MODEL, assessment.class, BUSY_ERROR.message, {
      countAgainstModel: assessment.countAgainstModel,
      cooldownMs: assessment.cooldownMs,
      providerScoped: assessment.providerScoped,
      saturation: assessment.saturation === true,
    })

    // This is the regression the first version of the fix introduced: moving
    // the fault wholesale to the provider left the model uncooled until the
    // five-failure streak, so prompts two through five walked straight back
    // into the gateway that had just refused them.
    expect(store.cooldowns()["opendesign/deepseek-v4.1-flash"]).toBeGreaterThan(Date.now())
    // One blip is not enough to condemn the whole provider.
    expect(store.isProviderCoolingDown("opendesign")).toBe(false)
  })

  it("arms a provider backoff once the gateway keeps refusing", () => {
    const store = new LedgerStore()
    for (let attempt = 0; attempt < PROVIDER_DOWN_STREAK; attempt += 1) {
      const assessment = classifyFailure(BUSY_ERROR)
      store.recordFailure("ses_busy", MODEL, assessment.class, BUSY_ERROR.message, {
        countAgainstModel: assessment.countAgainstModel,
        cooldownMs: assessment.cooldownMs,
        providerScoped: assessment.providerScoped,
        saturation: assessment.saturation === true,
      })
    }

    // The whole provider steps back, so no sibling model walks into the same
    // saturated gateway on the next prompt.
    expect(Object.keys(store.providerCooldowns())).toContain("opendesign")
    expect(store.isProviderCoolingDown("opendesign")).toBe(true)
  })

  it("does not count a busy gateway against the model's reliability", () => {
    const store = new LedgerStore()
    const assessment = classifyFailure(BUSY_ERROR)
    store.recordFailure("ses_busy", MODEL, assessment.class, BUSY_ERROR.message, {
      countAgainstModel: assessment.countAgainstModel,
      cooldownMs: assessment.cooldownMs,
      providerScoped: assessment.providerScoped,
      saturation: assessment.saturation === true,
    })
    // Holding the endpoint back and blaming the model are different things:
    // the cooldown is armed, but the model's failure count stays clean.
    const metrics = store.snapshotMetrics()
    expect(metrics.byModel["opendesign/deepseek-v4.1-flash"]?.failures ?? 0).toBe(0)
  })
})

describe("the provider scope stays narrow", () => {
  /**
   * The point of the narrow match. A single model can drop a stream or return a
   * 5xx while its provider serves everything else fine; cooling the whole
   * provider for that would strand a working pool.
   */
  it("keeps a plain 5xx model-scoped", () => {
    const assessment = classifyFailure({ status: 503, message: "Service Unavailable" })
    expect(assessment.class).toBe("provider_outage")
    expect(assessment.providerScoped).toBe(false)
    expect(assessment.saturation).toBeFalsy()
    expect(assessment.countAgainstModel).toBe(true)
  })

  it("keeps a single model's stream failure model-scoped", () => {
    const assessment = classifyFailure({
      type: "provider.internal",
      message: "Streaming response failed: enginecore encountered an issue",
    })
    expect(assessment.class).toBe("provider_outage")
    expect(assessment.providerScoped).toBe(false)
    // A dropped stream is one bad route, not a saturated gateway.
    expect(assessment.saturation).toBeFalsy()
    expect(assessment.countAgainstModel).toBe(true)
  })

  it("still treats the billing-scope fault as provider-scoped", () => {
    const assessment = classifyFailure({
      type: "provider.internal",
      message: "[code=workspace_billing_scope_unavailable] resolve Billing Scope: context deadline exceeded",
      status: 503,
    })
    expect(assessment.providerScoped).toBe(true)
    expect(assessment.countAgainstModel).toBe(false)
  })

  it("does not turn a rate limit into a provider outage", () => {
    const assessment = classifyFailure({ status: 429, message: "too many requests" })
    expect(assessment.class).toBe("rate_limit")
    expect(assessment.providerScoped).toBe(false)
  })

  it("recognises capacity refusals from the admission layer", () => {
    const assessment = classifyFailure({
      message: "Upstream request failed: [ttft_admission_refused] the cell is at capacity; retry shortly (after 51 s)",
    })
    expect(assessment.class).toBe("provider_outage")
    expect(assessment.saturation).toBe(true)
  })
})
