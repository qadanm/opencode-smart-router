import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"

import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"

/**
 * The router is an optimization layer. OpenCode works without it, and it must
 * keep working when the router is wrong.
 *
 * On 2026-11-06 a defect inside the router reached the prompt hook. The hook
 * treated an unexpected throw as "block admission" (fail closed), and fail
 * closed was the default, so one missing method made the editor refuse to send
 * any message at all, including in manual mode. The owner had to remove the
 * plugin to work.
 *
 * The contract this file holds is narrower and stronger than "fail closed": a
 * defect in the router degrades to "do not route", never to "do not work".
 * Blocking remains available, but only as an explicit opt-in for an owner who
 * would rather be stopped than pay for an unrouted request.
 *
 * The fault is injected into `patchSession`, a ledger write the routing path
 * performs directly. It is representative of the production failure: an
 * ordinary method call on the ledger that a defect renders unusable.
 */
const breakLedgerWrites = () => {
  Object.defineProperty(sharedCore.ledger, "patchSession", {
    value: () => {
      throw new TypeError("this.ledger.patchSession is not a function")
    },
    enumerable: false,
  })
}

const promptHook = (fake: ReturnType<typeof makeCtx>) => fake.hooks.get("prompt")!

describe("router failure never blocks the host", () => {
  beforeEach(() => {
    sharedCore.resetForTests()
  })

  it("serves the prompt when an internal defect throws, with defaults", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-open-default-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    breakLedgerWrites()

    await expect(
      promptHook(fake)({
        sessionID: "ses_internal_defect",
        prompt: { text: "Implement a feature in src/app.ts" },
      }),
    ).resolves.toBeUndefined()

    await controller.dispose()
  })

  it("serves the prompt in manual mode when an internal defect throws", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-open-manual-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    sharedCore.ledger.setManual("ses_manual_defect", { providerID: "opendesign", id: "glm-5.3-flash" })
    breakLedgerWrites()

    await expect(
      promptHook(fake)({
        sessionID: "ses_manual_defect",
        prompt: { text: "Implement a feature in src/app.ts" },
      }),
    ).resolves.toBeUndefined()

    await controller.dispose()
  })

  it("records what happened so the defect is visible rather than silent", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-open-recorded-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    breakLedgerWrites()

    await promptHook(fake)({
      sessionID: "ses_recorded",
      prompt: { text: "Implement a feature in src/app.ts" },
    })

    const status = await fake.rpc().status({ sessionID: "ses_recorded" })
    // The prompt went through, and the reason routing did not is recorded
    // where the owner can see it rather than swallowed.
    const warnings = status.warnings.join(" ")
    expect(warnings).toMatch(/patchSession/)
    expect(warnings).toMatch(/failed/i)

    await controller.dispose()
  })

  it("still blocks when the owner explicitly opts in", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-optin-closed-")))
    fake.ctx.options = { ...fake.ctx.options, routing: { failClosed: true } }
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    breakLedgerWrites()

    await expect(
      promptHook(fake)({
        sessionID: "ses_optin_closed",
        prompt: { text: "Implement a feature in src/app.ts" },
      }),
    ).rejects.toThrow()

    await controller.dispose()
  })
})
