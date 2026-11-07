import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"

/**
 * A running OpenCode server keeps the plugin module it loaded. Installing a new
 * version writes a new directory and moves the config pointer, but the process
 * that already ran keeps its module graph. On the next start the new bundle is
 * imported into a process where `globalThis[Symbol.for(...shared-core.v1)]`
 * already holds a SharedCore built by the PREVIOUS version.
 *
 * That is what happened in 0.6.0: the core was already started, so `init()`
 * returned early and kept the OLD ledger, which had no `planPoolSpent()`. Every
 * prompt then threw inside `premiumState()`, and because `routing.failClosed`
 * defaults to true the throw became a refusal to send any message at all,
 * including in manual mode.
 *
 * The setup below reproduces exactly that: a fully started shared core whose
 * ledger only answers the older API, then a new controller on top of it.
 */
const oldLedgerOf = (ledger: any) => {
  // The methods live on the prototype, so the only faithful way to model an
  // older class is to shadow them with own properties that answer `undefined`.
  // That is exactly what a caller sees when the method does not exist:
  // `this.ledger.planPoolSpent` is undefined and calling it throws.
  const old = Object.create(ledger)
  Object.defineProperty(old, "planPoolSpent", { value: undefined, enumerable: false })
  Object.defineProperty(old, "addPlanPoolSpend", { value: undefined, enumerable: false })
  return old
}

const startCoreThenDowngradeLedger = async (fake: ReturnType<typeof makeCtx>) => {
  // The owner's configuration: OpenDesign on the Pro plan. This matters,
  // because the pool budget is only read when a plan resolves; that read is
  // what reached for the method the older ledger did not have.
  fake.ctx.options = {
    ...fake.ctx.options,
    providers: { opendesign: { enabled: true, plan: "pro" } },
  }
  // A previous version ran and left the process-wide core started. It is NOT
  // disposed: that is the whole problem. The next bundle imports, reads
  // globalThis[KEY], and inherits this object.
  const previous = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
  await previous.initialize()
  ;(sharedCore as any).ledger = oldLedgerOf(sharedCore.ledger)
}

describe("shared core version skew", () => {
  beforeEach(() => {
    sharedCore.resetForTests()
  })
  afterEach(() => {
    sharedCore.resetForTests()
  })

  it("does not fail a prompt when the inherited ledger lacks a newer method", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-skew-")))
    await startCoreThenDowngradeLedger(fake)

    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()

    await expect(
      fake.hooks.get("prompt")!({
        sessionID: "ses_skew",
        prompt: { text: "Implement a feature in src/app.ts" },
      }),
    ).resolves.toBeUndefined()

    await controller.dispose()
  })

  it("still serves a prompt in manual mode when the inherited ledger is older", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-skew-manual-")))
    await startCoreThenDowngradeLedger(fake)

    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    // Manual mode is the runtime the owner fell back to when the router broke.
    sharedCore.ledger.setManual("ses_skew_manual", { providerID: "opendesign", id: "glm-5.3-flash" })

    await expect(
      fake.hooks.get("prompt")!({
        sessionID: "ses_skew_manual",
        prompt: { text: "Implement a feature in src/app.ts" },
      }),
    ).resolves.toBeUndefined()

    await controller.dispose()
  })

  it("reports status instead of throwing when the inherited ledger is older", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-skew-status-")))
    await startCoreThenDowngradeLedger(fake)

    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()

    const status = await fake.rpc().status({ sessionID: "ses_skew" })
    expect(status.enabled).toBeDefined()

    await controller.dispose()
  })
})
