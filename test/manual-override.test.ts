import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, afterEach, describe, expect, it } from "vitest"
import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"
import type { LedgerStore } from "../src/core/quota/ledger.js"

/**
 * The desktop client sends the model it has saved for a session with every
 * prompt. When the router has switched that session to something else, the
 * client's saved model is stale, so the next prompt switches the session back
 * and the host reports a model change the router did not make.
 *
 * That change is always to a model the session has already been on. A model
 * the session has never used can only be a deliberate pick.
 */
describe("a model change back to a model the session has used", () => {
  let fake: ReturnType<typeof makeCtx>
  let controller: RouterController
  let ledger: LedgerStore
  let sessionID: string

  beforeEach(async () => {
    sharedCore.resetForTests()
    fake = makeCtx(mkdtempSync(join(tmpdir(), "router-manual-")))
    controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    sessionID = `ses_manual_${Math.random().toString(36).slice(2, 8)}`
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opendesign", id: "deepseek-v4.1-flash" }
    ledger = (controller as any).ledger as LedgerStore
  })

  afterEach(async () => {
    await controller.dispose()
  })

  const modelSelected = (id: string, from: string) => ({
    type: "session.model.selected",
    data: {
      sessionID,
      model: { providerID: "opendesign", id },
      previous: { providerID: "opendesign", id: from },
    },
  })

  const manualOverride = () =>
    Boolean((ledger as any).ledger.sessions[sessionID]?.manualOverride)

  it("does not suspend automatic routing when the client catches up", async () => {
    // The session was routed on its current model, so the router knows it.
    await fake.hooks.get("prompt")!({ sessionID, prompt: { text: "Implement a feature in src/app.ts" } })

    // The client re-applies the model it has saved — the one the session was
    // already on before the router moved it.
    await controller.handleEvent(modelSelected("deepseek-v4.1-flash", "glm-5.3-flash"))

    expect(manualOverride()).toBe(false)
  })

  it("still suspends routing for a model the session has never used", async () => {
    await controller.handleEvent({
      type: "session.model.selected",
      data: {
        sessionID,
        model: { providerID: "commandcode", id: "claude-sonnet-5-5" },
        previous: { providerID: "opendesign", id: "deepseek-v4.1-flash" },
      },
    })

    expect(manualOverride()).toBe(true)
  })
})
