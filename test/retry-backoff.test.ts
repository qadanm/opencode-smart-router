import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, afterEach, describe, expect, it } from "vitest"
import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"

/**
 * A provider-scoped failure is refused before a model runs, so it costs no
 * allowance. The gateway fails these in runs — it is slow for a stretch and
 * every immediate retry lands inside the same stretch — so the router backs
 * off between attempts instead of dying into the bad window and leaving the
 * turn stopped until the owner says continue.
 */
describe("retrying a provider-scoped failure", () => {
  let fake: ReturnType<typeof makeCtx>
  let controller: RouterController

  beforeEach(async () => {
    sharedCore.resetForTests()
    fake = makeCtx(mkdtempSync(join(tmpdir(), "router-retry-")))
    controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
  })

  afterEach(async () => {
    await controller.dispose()
  })

  const retryHook = () => {
    const hook = fake.hooks.get("retry")!
    if (!hook) throw new Error("retry hook is not registered")
    return hook
  }

  beforeEach(async () => {
    // The retry hook only acts on sessions this bridge owns.
    sharedCore.claimSession("ses_retry", (controller as any).bridgeID)
  })

  const attempt = (n: number) => ({
    sessionID: "ses_retry",
    model: { providerID: "opendesign", id: "deepseek-v4.1-flash" },
    error: {
      type: "provider.internal",
      message:
        '[code=workspace_billing_scope_unavailable] resolve Billing Scope: Get "https://amr-api.open-design.ai/api/internal/billing/scope/x": context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
      status: 503,
    },
    attempt: n,
    decision: undefined as undefined | { retry: boolean; delay?: number },
  })

  it("backs off between attempts instead of retrying immediately", async () => {
    const hook = retryHook()
    const delays: Array<number | undefined> = []
    for (let n = 1; n <= 4; n++) {
      const event = attempt(n) as any
      await hook(event)
      expect(event.decision?.retry).toBe(true)
      delays.push(event.decision?.delay)
    }
    // Escalating: each attempt waits longer than the last.
    const numeric: number[] = delays.map((d) => d ?? 0)
    for (let i = 1; i < numeric.length; i++) {
      expect(numeric[i]!).toBeGreaterThan(numeric[i - 1]!)
    }
    // The first wait is short, the last is bounded.
    expect(numeric[0]).toBeGreaterThanOrEqual(5_000)
    expect(numeric[numeric.length - 1]).toBeLessThanOrEqual(40_000)
  })

  it("stops retrying after five attempts", async () => {
    const hook = retryHook()
    const event = attempt(5) as any
    await hook(event)
    expect(event.decision).toEqual({ retry: false })
  })

  it("leaves a model-scoped stream fault on the short path", async () => {
    const hook = retryHook()
    const event = {
      sessionID: "ses_retry",
      model: { providerID: "opendesign", id: "deepseek-v4.1-flash" },
      error: {
        type: "provider.internal",
        message: "Streaming response failed: [500] EngineCore encountered an issue.",
        status: 200,
      },
      attempt: 1,
      decision: undefined as undefined | { retry: boolean; delay?: number },
    } as any
    await hook(event)
    // Not provider-scoped, so no long backoff is imposed.
    expect(event.decision).toBeUndefined()
  })
})
