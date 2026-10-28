import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"
import type { LedgerStore } from "../src/core/quota/ledger.js"

const BILLING_SCOPE_ERROR = {
  type: "provider.internal",
  message:
    '[code=workspace_billing_scope_unavailable] resolve Billing Scope: Get "https://amr-api.open-design.ai/api/internal/billing/scope/ax396gf0dt9047rp8w26if5r": context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
  status: 503,
}

/**
 * Replays the event sequence the live host produced for the real incident at
 * 10:11:22-10:11:27 in session ses_e85a4fff4ffeFiAWW7bxDIj2DW, which the
 * live ledger recorded as three identical provider_outage entries in the
 * same second.
 */
describe("replay of the live incident", () => {
  it("records the live triple as one fault, and does not charge the model", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-replay-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    const sessionID = "ses_replay"
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opendesign", id: "deepseek-v4.1-flash" }

    const ledger = (controller as any).ledger as LedgerStore
    const before = ledger.snapshotMetrics()
    const KEY = "opendesign/deepseek-v4.1-flash"

    // The host emitted these three for the same failed attempt.
    await controller.handleEvent({
      type: "session.step.failed",
      data: { sessionID, error: BILLING_SCOPE_ERROR, assistantMessageID: "msg_live_1" },
    })
    await controller.handleEvent({
      type: "session.execution.failed",
      data: { sessionID, error: BILLING_SCOPE_ERROR, assistantMessageID: "msg_live_1" },
    })
    await controller.handleEvent({
      type: "session.idle",
      data: { sessionID, outcome: "failed", error: BILLING_SCOPE_ERROR, assistantMessageID: "msg_live_1" },
    })

    const after = ledger.snapshotMetrics()
    const faults = (after.failures.provider_outage ?? 0) - (before.failures.provider_outage ?? 0)
    const modelFaults = (after.byModel[KEY]?.failures ?? 0) - (before.byModel[KEY]?.failures ?? 0)

    console.log(`live replay: provider_outage=${faults} modelFaults=${modelFaults}`)
    console.log(`live replay: model cooldown set = ${Boolean(ledger.cooldowns()[KEY])}`)

    expect(faults).toBe(1)
    // A provider-wide billing fault must not penalise the serving model.
    expect(modelFaults).toBe(0)
    // No model-level cooldown may be armed for it.
    expect(ledger.cooldowns()[KEY]).toBeUndefined()

    await controller.dispose()
  })
})
