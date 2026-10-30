import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"
import type { LedgerStore } from "../src/core/quota/ledger.js"

/**
 * Context management replaced a single eager compaction rule.
 *
 * The old router compacted an idle session as soon as it approached the
 * cheapest provider's window, because a $10 allowance made a long session on
 * that provider unaffordable. That is destructive: the transcript is replaced
 * by a summary and the detail is gone.
 *
 * The default is now `native` mode, which preserves history and only acts
 * when a request would genuinely exceed the window the provider accepts.
 * `budget-optimized` keeps the old behavior for small plans.
 */
describe("context management on an idle session", () => {
  let fake: ReturnType<typeof makeCtx>
  let controller: RouterController
  let ledger: LedgerStore
  let sessionID: string

  const setContext = (tokens: number) => {
    const s = (ledger as any).ledger.sessions[sessionID]
    s.contextTokens = tokens
    s.cacheReadTokens = tokens
  }

  const goIdle = () =>
    controller.handleEvent({ type: "session.idle", data: { sessionID, outcome: "succeeded" } })

  const decision = () => (controller as any).lastCompactionDecision.get(sessionID)

  const build = async (contextManagement?: Record<string, unknown>) => {
    sharedCore.resetForTests()
    fake = makeCtx(mkdtempSync(join(tmpdir(), "router-compact-")))
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
      ...(contextManagement ? { contextManagement } : {}),
    }
    controller = new RouterController({ ctx: fake.ctx, pluginOptions: options })
    await controller.initialize()
    sessionID = `ses_compact_${Math.random().toString(36).slice(2, 8)}`
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opendesign", id: "deepseek-v4.1-flash" }
    ledger = (controller as any).ledger as LedgerStore
    await fake.hooks.get("prompt")!({
      sessionID,
      prompt: { text: "Implement a feature in src/app.ts" },
    })
  }

  afterEach(async () => {
    await controller.dispose()
  })

  describe("native mode (the default)", () => {
    beforeEach(async () => {
      await build()
    })

    it("defaults to native mode", () => {
      expect((controller as any).settings.contextManagement.mode).toBe("native")
    })

    it("does not compact a long conversation that still fits", async () => {
      setContext(200_000)
      await goIdle()
      expect(fake.compactions.length).toBe(0)
      expect(decision().reason).toMatch(/fits the verified window/)
    })

    it("does not compact an ordinary long session", async () => {
      // 900k is 86% of the measured 1,048,000 window: past any old early
      // threshold, and 920k with the margin is inside the 995,600 safe limit.
      setContext(900_000)
      await goIdle()
      expect(fake.compactions.length).toBe(0)
    })

    it("compacts when the transcript would exceed the verified window", async () => {
      // 1,010,000 + the 20k margin exceeds the measured 1,048,000 * 0.95.
      setContext(1_010_000)
      await goIdle()
      expect(fake.compactions.length).toBe(1)
      expect(decision().hardLimit).toBe(true)
    })

    it("reports an emergency compaction rather than silently truncating", async () => {
      setContext(1_040_000)
      await goIdle()
      expect(fake.compactions.length).toBe(1)
      expect(decision().reason).toMatch(/emergency/i)
    })

    it("uses the current model's accepted window, not the cheapest variant's", async () => {
      // Parked on the 1M OpenCode Go route, 900k is nowhere near its limit,
      // so nothing should be compacted.
      ledger.patchSession(sessionID, {
        lastModel: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      })
      setContext(900_000)
      await goIdle()
      expect(fake.compactions.length).toBe(0)
    })

    it("still compacts at the 1M window's real limit", async () => {
      ledger.patchSession(sessionID, {
        lastModel: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      })
      setContext(960_000)
      await goIdle()
      expect(fake.compactions.length).toBe(1)
    })

    it("honours the compaction cooldown", async () => {
      setContext(1_010_000)
      await goIdle()
      expect(fake.compactions.length).toBe(1)
      setContext(1_040_000)
      await goIdle()
      expect(fake.compactions.length).toBe(1)
    })

    it("does not compact when emergency compaction is disabled", async () => {
      await controller.dispose()
      await build({ mode: "native", allowEmergencyCompaction: false })
      setContext(1_040_000)
      await goIdle()
      expect(fake.compactions.length).toBe(0)
      expect(decision().reason).toMatch(/emergency compaction is disabled/)
    })
  })

  describe("conservative mode", () => {
    beforeEach(async () => {
      await build({ mode: "conservative" })
    })

    it("preserves history far into the window", async () => {
      // 900k + the 20k margin is inside the measured 1,048,000 window's
      // 995,600 safe limit, so conservative mode must leave it alone.
      setContext(900_000)
      await goIdle()
      expect(fake.compactions.length).toBe(0)
    })

    it("compacts only to prevent a real overflow", async () => {
      setContext(1_010_000)
      await goIdle()
      expect(fake.compactions.length).toBe(1)
      expect(decision().reason).toMatch(/only because/)
    })
  })

  describe("budget-optimized mode (the preserved legacy strategy)", () => {
    it("compacts early to stay on the cheapest route", async () => {
      await build({ mode: "budget-optimized", compactAtTokens: 120_000 })
      setContext(150_000)
      await goIdle()
      expect(fake.compactions.length).toBe(1)
      expect(decision().reason).toMatch(/cheapest qualified route/)
      expect(decision().hardLimit).toBe(false)
    })

    it("targets the cheapest variant's window rather than the current one", async () => {
      // The legacy strategy targets the cheapest qualified variant's window,
      // which is resolved at runtime rather than hardcoded. Parked on the 1M
      // OpenCode Go route, it must still compact against that variant's window
      // rather than the current provider's.
      await build({ mode: "budget-optimized" })
      ledger.patchSession(sessionID, {
        lastModel: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      })
      const cheap = (controller as any).cheapestVariantContext("deepseek-v4.1-flash") as number
      expect(cheap).toBeGreaterThan(0)
      setContext(Math.floor(cheap * 0.96))
      await goIdle()
      expect(fake.compactions.length).toBe(1)
      expect(decision().targetTokens).toBeLessThanOrEqual(Math.floor(cheap * 0.95))
    })

    it("leaves a session alone below the configured threshold", async () => {
      await build({ mode: "budget-optimized", compactAtTokens: 300_000 })
      setContext(100_000)
      await goIdle()
      expect(fake.compactions.length).toBe(0)
    })
  })

  describe("switching modes", () => {
    it("does not corrupt session state when the mode changes", async () => {
      await build({ mode: "budget-optimized", compactAtTokens: 120_000 })
      setContext(150_000)
      await goIdle()
      expect(fake.compactions.length).toBe(1)
      await controller.dispose()

      // Rebuild in native mode against the same temp directory.
      fake = makeCtx(mkdtempSync(join(tmpdir(), "router-compact-")))
      const options = {
        ...fake.ctx.options,
        providers: {
          ...fake.ctx.options.providers,
          opendesign: { ...fake.ctx.options.providers?.opendesign, enabled: true },
        },
        models: { ...fake.ctx.options.models, approved: ["opendesign/deepseek-v4.1-flash"] },
        contextManagement: { mode: "native" },
      }
      controller = new RouterController({ ctx: fake.ctx, pluginOptions: options })
      await controller.initialize()
      sessionID = "ses_switch"
      const session = await fake.ctx.session.get({ sessionID })
      session.model = { providerID: "opendesign", id: "deepseek-v4.1-flash" }
      ledger = (controller as any).ledger as LedgerStore
      await fake.hooks.get("prompt")!({ sessionID, prompt: { text: "Implement a feature" } })
      setContext(150_000)
      await goIdle()
      expect(fake.compactions.length).toBe(0)
      expect(ledger.getSession(sessionID)).toBeDefined()
    })
  })

  describe("context health reporting", () => {
    beforeEach(async () => {
      await build()
    })

    it("recommends a new session without compacting", async () => {
      // Health advice and compaction are separate mechanisms. On the 1M
      // route, 750k is worth a nudge but is nowhere near an overflow.
      ledger.patchSession(sessionID, {
        lastModel: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      })
      setContext(750_000)
      const status = (controller as any).statusFor(sessionID)
      expect(status.context.state).toBe("recommend_new_session")
      await goIdle()
      expect(fake.compactions.length).toBe(0)
      expect(decision().compact).toBe(false)
    })
  })
})
