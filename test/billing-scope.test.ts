import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { classifyFailure } from "../src/core/failures.js"
import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"
import type { LedgerStore } from "../src/core/quota/ledger.js"

/**
 * OpenDesign's gateway resolves which billing workspace an inference key
 * belongs to before it serves any request. When that internal resolution
 * times out, the gateway returns this error. It happens before a model is
 * selected, so it is a fault of the provider's billing path, not of the
 * model that happened to be serving.
 */
const BILLING_SCOPE_ERROR = {
  type: "provider.internal",
  message:
    '[code=workspace_billing_scope_unavailable] resolve Billing Scope: Get "https://amr-api.open-design.ai/api/internal/billing/scope/ax396gf0dt9047rp8w26if5r": context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
  status: 503,
}

const MODEL_KEY = "opendesign/deepseek-v4.1-flash"

describe("billing-scope failures are provider-scoped, not model-scoped", () => {
  it("does not charge a billing-scope failure against the serving model", () => {
    const assessment = classifyFailure(BILLING_SCOPE_ERROR)
    expect(assessment.class).toBe("provider_outage")
    // The fault is in the provider's billing path. It would hit every
    // OpenDesign model equally, so it must not count against one model.
    expect(assessment.countAgainstModel).toBe(false)
  })

  it("still treats it as retryable and holds the provider back", () => {
    const assessment = classifyFailure(BILLING_SCOPE_ERROR)
    expect(assessment.retryable).toBe(true)
    // A cooldown still applies, so the broken provider is stepped away from.
    expect(assessment.cooldownMs).toBeGreaterThan(0)
  })
})

describe("one logical failure is counted once", () => {
  it("does not triple-count a single failure across the retry, step and execution paths", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-billing-once-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    const sessionID = "ses_billing_once"
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opendesign", id: "deepseek-v4.1-flash" }

    const ledger = (controller as any).ledger as LedgerStore
    const before = ledger.snapshotMetrics()

    // The host reports the same underlying failure through each of its
    // channels: it schedules a retry, the step fails, the execution fails,
    // and the session settles as failed. All four describe one attempt,
    // which the host identifies with the assistant message id.
    const assistantMessageID = "msg_attempt_one"
    await controller.handleEvent({ type: "session.retry.scheduled", data: { sessionID } })
    await controller.handleEvent({
      type: "session.step.failed",
      data: { sessionID, error: BILLING_SCOPE_ERROR, assistantMessageID },
    })
    await controller.handleEvent({
      type: "session.execution.failed",
      data: { sessionID, error: BILLING_SCOPE_ERROR, assistantMessageID },
    })
    await controller.handleEvent({
      type: "session.idle",
      data: { sessionID, outcome: "failed", error: BILLING_SCOPE_ERROR, assistantMessageID },
    })

    const after = ledger.snapshotMetrics()
    const counted = (after.failures.provider_outage ?? 0) - (before.failures.provider_outage ?? 0)

    expect(counted).toBe(1)
    expect((after.byModel[MODEL_KEY]?.failures ?? 0) - (before.byModel[MODEL_KEY]?.failures ?? 0)).toBe(0)

    await controller.dispose()
  })

  it("still counts distinct failures separately", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-billing-distinct-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    const sessionID = "ses_billing_distinct"
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opendesign", id: "deepseek-v4.1-flash" }

    const ledger = (controller as any).ledger as LedgerStore
    const before = ledger.snapshotMetrics()

    // Two genuinely separate attempts, each with its own identity.
    await controller.handleEvent({
      type: "session.step.failed",
      data: { sessionID, error: BILLING_SCOPE_ERROR, assistantMessageID: "msg_attempt_a" },
    })
    await controller.handleEvent({
      type: "session.step.failed",
      data: { sessionID, error: BILLING_SCOPE_ERROR, assistantMessageID: "msg_attempt_b" },
    })

    const after = ledger.snapshotMetrics()
    const counted = (after.failures.provider_outage ?? 0) - (before.failures.provider_outage ?? 0)

    expect(counted).toBe(2)

    await controller.dispose()
  })

  it("still counts a genuine model-specific stream fault against the model", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-billing-stream-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    const sessionID = "ses_billing_stream"
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opendesign", id: "deepseek-v4.1-flash" }

    const ledger = (controller as any).ledger as LedgerStore
    const before = ledger.snapshotMetrics()

    await controller.handleEvent({
      type: "session.step.failed",
      data: {
        sessionID,
        error: {
          type: "provider.internal",
          message: "Streaming response failed: [500] EngineCore encountered an issue.",
          status: 200,
        },
      },
    })

    const after = ledger.snapshotMetrics()
    expect(
      (after.byModel[MODEL_KEY]?.failures ?? 0) - (before.byModel[MODEL_KEY]?.failures ?? 0),
    ).toBe(1)
    expect(ledger.cooldowns()[MODEL_KEY]).toBeGreaterThan(Date.now())

    await controller.dispose()
  })
})
