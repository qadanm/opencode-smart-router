import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"
import type { LedgerStore } from "../src/core/quota/ledger.js"

/**
 * The legacy budget-optimized strategy, exercised explicitly.
 *
 * This is the behavior the router used unconditionally on a $10 plan: an
 * idle session is compacted before it outgrows the cheapest provider that can
 * serve it, so a long conversation keeps routing to the cheap pool. It is no
 * longer the default, but it must keep working for a user whose plan needs it.
 */
describe("budget-optimized compaction (opt-in)", () => {
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

  /**
   * The window this strategy compacts against, resolved from the live registry
   * rather than hardcoded. It moved from 328,000 to 1,048,000 when the gateway
   * budget was measured and found advisory, and a hardcoded number would make
   * these tests silently stop exercising the strategy at all.
   */
  const cheapWindow = () =>
    (controller as any).cheapestVariantContext("deepseek-v4.1-flash") as number

  /** A context size safely inside the strategy's compaction threshold. */
  const justOver = () => Math.floor(cheapWindow() * 0.95) + 5_000
  const wellUnder = () => Math.floor(cheapWindow() * 0.5)

  beforeEach(async () => {
    sharedCore.resetForTests()
    fake = makeCtx(mkdtempSync(join(tmpdir(), "router-legacy-")))
    const options = {
      ...fake.ctx.options,
      // This strategy only exists for a plan that cannot afford a long
      // session on a costly provider, so it is configured explicitly here.
      contextManagement: { mode: "budget-optimized", compactAtTokens: 0 },
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
    sessionID = `ses_legacy_${Math.random().toString(36).slice(2, 8)}`
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opendesign", id: "deepseek-v4.1-flash" }
    ledger = (controller as any).ledger as LedgerStore
    await fake.hooks.get("prompt")!({
      sessionID,
      prompt: { text: "Implement a feature in src/app.ts" },
    })
  })

  afterEach(async () => {
    await controller.dispose()
  })

  it("compacts a session at the edge of the cheap window", async () => {
    setContext(justOver())
    await goIdle()
    expect(fake.compactions.length).toBe(1)
    expect(fake.compactions[0]?.sessionID).toBe(sessionID)
  })

  it("leaves a session alone while it still fits", async () => {
    setContext(wellUnder())
    await goIdle()
    expect(fake.compactions.length).toBe(0)
  })

  it("does not compact twice within the cooldown", async () => {
    setContext(justOver())
    await goIdle()
    expect(fake.compactions.length).toBe(1)
    setContext(justOver() + 5_000)
    await goIdle()
    expect(fake.compactions.length).toBe(1)
  })

  it("compacts after a failed turn too, since the context is just as large", async () => {
    setContext(justOver())
    await goIdle("failed")
    expect(fake.compactions.length).toBe(1)
  })

  it("compacts on a clean execution, not only on idle", async () => {
    setContext(justOver())
    await controller.handleEvent({ type: "session.execution.succeeded", data: { sessionID } })
    expect(fake.compactions.length).toBe(1)
  })

  it("targets the cheapest variant's window, not the current provider's", async () => {
    // Parked on opencode-go's route; the strategy targets the cheapest
    // qualified variant's window, whatever it currently is, which is what lets
    // the session return to the cheap pool.
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opencode-go", id: "deepseek-v4.1-flash" }
    setContext(justOver())
    await goIdle()
    expect(fake.compactions.length).toBe(1)
  })
})
