import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, afterEach, describe, expect, it } from "vitest"
import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"
import type { LedgerStore } from "../src/core/quota/ledger.js"

/**
 * A compaction rebuilds the transcript, so the session's context size drops
 * sharply. The router has to learn that new size, because the context gate
 * decides which providers may serve the session: a stale, pre-compaction
 * number makes a session look too large for the cheap provider's window and
 * pushes the work onto a costlier one.
 *
 * The host's `session.compaction.ended` event is the signal. The router did
 * not handle it, so the stale number survived and the cheap provider stayed
 * excluded - the session kept running on the expensive route even though it
 * had just been compacted down to a fraction of its former size.
 */
describe("context size after a compaction", () => {
  let fake: ReturnType<typeof makeCtx>
  let controller: RouterController
  let ledger: LedgerStore
  let sessionID: string

  const setContext = (tokens: number) => {
    const s = (ledger as any).ledger.sessions[sessionID]
    s.contextTokens = tokens
    s.cacheReadTokens = tokens
  }

  const contextOf = () => (ledger as any).ledger.sessions[sessionID]?.contextTokens

  /** The host's transcript after a compaction: one assistant step that
   * reports the rebuilt context. */
  const transcriptOf = (tokens: number) => [
    {
      type: "assistant",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: tokens - 100, write: 0 } },
    },
  ]

  beforeEach(async () => {
    sharedCore.resetForTests()
    fake = makeCtx(mkdtempSync(join(tmpdir(), "router-compact-ctx-")))
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
    sessionID = `ses_compact_ctx_${Math.random().toString(36).slice(2, 8)}`
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opendesign", id: "deepseek-v4.1-flash" }
    ledger = (controller as any).ledger as LedgerStore
    await fake.hooks.get("prompt")!({ sessionID, prompt: { text: "Implement a feature in src/app.ts" } })
  })

  afterEach(async () => {
    fake.restoreHome()
    sharedCore.resetForTests()
  })

  it("drops the stale pre-compaction context size", async () => {
    setContext(450_000)
    expect(contextOf()).toBe(450_000)

    fake.setContextMessages(transcriptOf(95_000))
    await controller.handleEvent({ type: "session.compaction.ended", data: { sessionID } })

    // The refresh is asynchronous; give it a turn to complete.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(contextOf()).toBe(95_000)
  })

  it("keeps a session eligible for the cheap provider after compaction", async () => {
    // 450k of context exceeds OpenDesign's 328k window, so OpenDesign is
    // ineligible and the work must move to a provider with a bigger window.
    setContext(450_000)

    // After a compaction the transcript is only 95k, which fits OpenDesign.
    fake.setContextMessages(transcriptOf(95_000))
    await controller.handleEvent({ type: "session.compaction.ended", data: { sessionID } })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(contextOf()).toBeLessThanOrEqual(95_000)
    const s = (ledger as any).ledger.sessions[sessionID]
    expect(s.lastModel?.providerID).toBe("opendesign")
  })

  it("does not use the session's cumulative token total as its context size", async () => {
    // `session.get().tokens` is the lifetime total for the session, not the
    // size of the transcript a request carries. It grows without bound, so
    // using it makes a session look far larger than it is.
    const session = await fake.ctx.session.get({ sessionID })
    session.tokens = { input: 43_458_522, output: 2_556_678, reasoning: 3_113_349, cache: { read: 2_949_999_221, write: 549_175 } }

    // The transcript is genuinely small.
    fake.setContextMessages(transcriptOf(95_000))
    setContext(0)
    await fake.hooks.get("prompt")!({ sessionID, prompt: { text: "Another request in the same session" } })

    // The admission value must be the real transcript size, never the
    // 400k clamp of the cumulative total.
    expect(contextOf()).toBe(95_000)
  })

  it("reads the real transcript size at admission instead of guessing", async () => {
    // A session with a real transcript of 180k: the router must use that,
    // not a cumulative total or a fixed guess.
    fake.setContextMessages(transcriptOf(180_000))
    setContext(0)
    await fake.hooks.get("prompt")!({ sessionID, prompt: { text: "Continue the work" } })

    expect(contextOf()).toBe(180_000)
  })
})
