import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, afterEach, describe, expect, it } from "vitest"
import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"
import type { LedgerStore } from "../src/core/quota/ledger.js"

/**
 * The router already prefers the cheapest qualified provider on every
 * prompt. The only thing that pushes a session off it is size: once the
 * context crosses the model's safe window the cheap route becomes
 * ineligible and the work moves to a costlier provider for no reason other
 * than the conversation's length.
 *
 * So the router compacts an idle session before it reaches that line.
 */
describe("compacting an idle session to keep it on the cheap provider", () => {
  let fake: ReturnType<typeof makeCtx>
  let controller: RouterController
  let ledger: LedgerStore
  let sessionID: string

  const setContext = (tokens: number) => {
    const s = (ledger as any).ledger.sessions[sessionID]
    s.contextTokens = tokens
    s.cacheReadTokens = tokens
  }

  const goIdle = (outcome: "succeeded" | "failed" = "succeeded") =>
    controller.handleEvent({ type: "session.idle", data: { sessionID, outcome } })

  beforeEach(async () => {
    sharedCore.resetForTests()
    fake = makeCtx(mkdtempSync(join(tmpdir(), "router-compact-")))
    // Mirror the live configuration: OpenDesign enabled and its model
    // approved, so the cheapest variant of deepseek is OpenDesign's 328k.
    const options = {
      ...fake.ctx.options,
      providers: {
        ...fake.ctx.options.providers,
        opendesign: { ...fake.ctx.options.providers?.opendesign, enabled: true },
      },
      models: {
        ...fake.ctx.options.models,
        approved: ["opendesign/deepseek-v4.1-flash"],
      },
    }
    controller = new RouterController({ ctx: fake.ctx, pluginOptions: options })
    await controller.initialize()
    sessionID = `ses_compact_${Math.random().toString(36).slice(2, 8)}`
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opendesign", id: "deepseek-v4.1-flash" }
    ledger = (controller as any).ledger as LedgerStore
    // Establish the session and its model with one routed prompt.
    await fake.hooks.get("prompt")!({ sessionID, prompt: { text: "Implement a feature in src/app.ts" } })
  })

  afterEach(async () => {
    await controller.dispose()
  })

  it("compacts a session that has grown to the edge of the cheap window", async () => {
    setContext(325_000) // 99% of OpenDesign's 328k window
    await goIdle()
    expect(fake.compactions.length).toBe(1)
    expect(fake.compactions[0]?.sessionID).toBe(sessionID)
  })

  it("leaves a session alone while it still fits comfortably", async () => {
    setContext(200_000) // 61% of the window
    await goIdle()
    expect(fake.compactions.length).toBe(0)
  })

  it("does not compact twice within the cooldown", async () => {
    setContext(325_000)
    await goIdle()
    expect(fake.compactions.length).toBe(1)
    setContext(330_000)
    await goIdle()
    expect(fake.compactions.length).toBe(1)
  })

  it("does not compact on a failed or interrupted turn", async () => {
    setContext(325_000)
    await goIdle("failed")
    expect(fake.compactions.length).toBe(0)
  })

  it("targets the cheapest variant's window, not the current provider's", async () => {
    // The session is parked on opencode-go's deepseek (1M window), but the
    // cheapest variant of the same model is OpenDesign's 328k. Compacting
    // here is what lets the session go back to the cheap pool.
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opencode-go", id: "deepseek-v4.1-flash" }
    setContext(325_000)
    await goIdle()
    expect(fake.compactions.length).toBe(1)
  })
})
