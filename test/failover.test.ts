import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"

/**
 * A deterministic request rejection (the provider refused the prompt shape
 * before generating anything) must never be retried: retrying reproduces the
 * same 400 and burns turns. The router stops the retry, excludes the
 * rejecting model for this prompt, and continues the turn on the next best
 * eligible model with one router-marked synthetic notice.
 */
describe("failover for a prompt-rejected turn", () => {
  let fake: ReturnType<typeof makeCtx>
  let controller: RouterController

  beforeEach(async () => {
    sharedCore.resetForTests()
    fake = makeCtx(mkdtempSync(join(tmpdir(), "router-failover-")))
    controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
  })

  afterEach(async () => {
    await controller.dispose()
  })

  const retryHook = () => {
    const hook = fake.hooks.get("retry")
    if (!hook) throw new Error("retry hook is not registered")
    return hook
  }

  const routeAPrompt = async () => {
    // The retry hook only acts on sessions this bridge owns; the prompt hook
    // claims the session itself.
    await fake.hooks.get("prompt")!({
      sessionID: "ses_heal",
      messageID: "msg_user_1",
      prompt: { text: "Implement a feature in src/app.ts" },
    })
    const decision = (controller as any).ledger.lastDecision
    if (!decision?.chosen) throw new Error("routing did not choose a model")
    return { decision, switchesBefore: fake.switched.length, syntheticBefore: fake.syntheticCalls.length }
  }

  const rejectionEvent = (model: { providerID: string; id: string }) => ({
    sessionID: "ses_heal",
    model: { providerID: model.providerID, id: model.id },
    attempt: 1,
    error: {
      type: "provider.invalid-request",
      message: "Invalid discriminator value. Expected 'user' | 'assistant' at messages.23.role",
      status: 400,
    },
  })

  it("does not retry and fails the turn over to the next best model", async () => {
    const { decision, switchesBefore, syntheticBefore } = await routeAPrompt()
    const rejected = decision.chosen
    const event: any = rejectionEvent(rejected)
    await retryHook()(event)

    expect(event.decision).toEqual({ retry: false })
    expect(fake.switched).toHaveLength(switchesBefore + 1)
    const switchedRef = fake.switched[fake.switched.length - 1]!.model
    expect(switchedRef.providerID! + "/" + switchedRef.id!).not.toBe(rejected.providerID + "/" + rejected.id)
    expect(fake.syntheticCalls).toHaveLength(syntheticBefore + 1)
    expect(fake.syntheticCalls[fake.syntheticCalls.length - 1]!.text).toContain("[router]")
    expect(fake.syntheticCalls[fake.syntheticCalls.length - 1]!.text).toContain(rejected.providerID + "/" + rejected.id)
    const healed = (controller as any).ledger.lastDecision
    expect(healed.switchReason).toBe("selfheal")
    expect(healed.selfheal.rejected).toBe(rejected.providerID + "/" + rejected.id)
  })

  it("caps the auto-continue at one per prompt", async () => {
    await routeAPrompt()
    await retryHook()(rejectionEvent((controller as any).ledger.lastDecision.chosen) as any)
    const switchCount = fake.switched.length
    const syntheticCount = fake.syntheticCalls.length
    const event: any = rejectionEvent((controller as any).ledger.lastDecision.chosen)
    await retryHook()(event)
    expect(event.decision).toEqual({ retry: false })
    expect(fake.switched).toHaveLength(switchCount)
    expect(fake.syntheticCalls).toHaveLength(syntheticCount)
  })

  it("nots the rejection for the next prompt when no other model is eligible", async () => {
    const { decision, switchesBefore, syntheticBefore } = await routeAPrompt()
    // Make every other candidate ineligible: hold each one back the way the
    // failover's own hold path does.
    for (const candidate of decision.candidates) {
      const key = candidate.model.providerID + "/" + candidate.model.modelID
      const rejectedKey = decision.chosen.providerID + "/" + decision.chosen.id
      if (key === rejectedKey) continue
      ;(controller as any).ledger.holdModel({ providerID: candidate.model.providerID, id: candidate.model.modelID }, 60_000)
    }
    const event: any = rejectionEvent(decision.chosen)
    await retryHook()(event)

    expect(event.decision).toEqual({ retry: false })
    expect(fake.switched).toHaveLength(switchesBefore)
    expect(fake.syntheticCalls).toHaveLength(syntheticBefore)
    const healed = (controller as any).ledger.lastDecision
    expect(healed.selfheal.action).toBe("noted")
  })
})
