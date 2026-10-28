import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, afterEach, describe, expect, it } from "vitest"
import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"
import type { LedgerStore } from "../src/core/quota/ledger.js"

/**
 * OpenDesign's gateway resolves the account's billing scope and plan
 * entitlement before it serves any request. When those internal calls fail,
 * the gateway returns these. Neither is a fault of the model that happened
 * to be serving.
 */
const BILLING_SCOPE_ERROR = {
  type: "provider.internal",
  message:
    '[code=workspace_billing_scope_unavailable] resolve Billing Scope: Get "https://amr-api.open-design.ai/api/internal/billing/scope/ax396gf0dt9047rp8w26if5r": context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
  status: 503,
}

const ENTITLEMENT_ERROR = {
  type: "provider.internal",
  message: "[code=internal_error] failed to evaluate membership entitlement",
  status: 503,
}

const MODEL_KEY = "opendesign/deepseek-v4.1-flash"

const stepFailed = (sessionID: string, error: { type: string; message: string; status?: number }, id: string) => ({
  type: "session.step.failed",
  data: { sessionID, error, assistantMessageID: id },
})

const stepSucceeded = (sessionID: string) => ({
  type: "session.step.ended",
  data: { sessionID, tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } } },
})

describe("provider-scoped gateway faults", () => {
  let fake: ReturnType<typeof makeCtx>
  let controller: RouterController
  let ledger: LedgerStore
  let sessionID: string

  beforeEach(async () => {
    // sharedCore is a module singleton and keeps one ledger across tests, so
    // clear it or a streak from an earlier case leaks into this one.
    sharedCore.resetForTests()
    fake = makeCtx(mkdtempSync(join(tmpdir(), "router-provider-backoff-")))
    controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    sessionID = `ses_provider_backoff_${Math.random().toString(36).slice(2, 8)}`
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opendesign", id: "deepseek-v4.1-flash" }
    ledger = (controller as any).ledger as LedgerStore
  })

  afterEach(async () => {
    await controller.dispose()
  })

  it("does not charge a membership entitlement failure to the model", async () => {
    const before = ledger.snapshotMetrics()
    await controller.handleEvent(stepFailed(sessionID, ENTITLEMENT_ERROR, "msg_ent_1"))
    const after = ledger.snapshotMetrics()

    expect((after.byModel[MODEL_KEY]?.failures ?? 0) - (before.byModel[MODEL_KEY]?.failures ?? 0)).toBe(0)
    expect(ledger.cooldowns()[MODEL_KEY]).toBeUndefined()
  })

  it("does not arm a model cooldown for a provider-scoped fault", async () => {
    await controller.handleEvent(stepFailed(sessionID, BILLING_SCOPE_ERROR, "msg_blip"))
    expect(ledger.cooldowns()[MODEL_KEY]).toBeUndefined()
    expect(ledger.isProviderCoolingDown("opendesign")).toBe(false)
  })

  it("keeps the provider available through a run of isolated blips", async () => {
    // Real pattern from the live incident: a blip, then successes, then
    // another blip. Each success proves the gateway is serving again.
    for (let i = 0; i < 6; i++) {
      await controller.handleEvent(stepFailed(sessionID, BILLING_SCOPE_ERROR, `msg_blip_${i}`))
      await controller.handleEvent(stepSucceeded(sessionID))
    }
    expect(ledger.isProviderCoolingDown("opendesign")).toBe(false)
  })

  it("steps back from the provider only after repeated failures with nothing succeeding", async () => {
    for (let i = 0; i < 5; i++) {
      await controller.handleEvent(stepFailed(sessionID, BILLING_SCOPE_ERROR, `msg_down_${i}`))
    }
    expect(ledger.isProviderCoolingDown("opendesign")).toBe(true)
    expect(ledger.cooldowns()[MODEL_KEY]).toBeUndefined()
  })

  it("never charges a model while the provider is stepping back", async () => {
    for (let i = 0; i < 5; i++) {
      await controller.handleEvent(stepFailed(sessionID, BILLING_SCOPE_ERROR, `msg_down2_${i}`))
    }
    const before = ledger.snapshotMetrics()
    for (let i = 0; i < 5; i++) {
      await controller.handleEvent(stepFailed(sessionID, BILLING_SCOPE_ERROR, `msg_more_${i}`))
    }
    const after = ledger.snapshotMetrics()
    expect((after.byModel[MODEL_KEY]?.failures ?? 0) - (before.byModel[MODEL_KEY]?.failures ?? 0)).toBe(0)
    expect(ledger.cooldowns()[MODEL_KEY]).toBeUndefined()
  })

  it("starts over after the provider serves a request again", async () => {
    for (let i = 0; i < 4; i++) {
      await controller.handleEvent(stepFailed(sessionID, BILLING_SCOPE_ERROR, `msg_recover_${i}`))
    }
    await controller.handleEvent(stepSucceeded(sessionID))
    for (let i = 0; i < 4; i++) {
      await controller.handleEvent(stepFailed(sessionID, BILLING_SCOPE_ERROR, `msg_after_${i}`))
    }
    // Four since the success: short of the threshold, so still serving.
    expect(ledger.isProviderCoolingDown("opendesign")).toBe(false)
  })

  it("leaves other providers untouched", async () => {
    for (let i = 0; i < 5; i++) {
      await controller.handleEvent(stepFailed(sessionID, BILLING_SCOPE_ERROR, `msg_isolate_${i}`))
    }
    expect(ledger.isProviderCoolingDown("opendesign")).toBe(true)
    expect(ledger.isProviderCoolingDown("opencode-go")).toBe(false)
    expect(ledger.isProviderCoolingDown("commandcode")).toBe(false)
  })
})
