import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockState = vi.hoisted(() => ({ fail: true }))

vi.mock("../src/core/routing/engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/routing/engine.js")>()
  return {
    ...actual,
    routeTask: (...args: any[]) => {
      if (mockState.fail) throw new Error("engine exploded")
      return (actual.routeTask as any)(...args)
    },
  }
})

import { RouterBlockedError, RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"

describe("routing exception policy", () => {
  beforeEach(() => {
    mockState.fail = true
    sharedCore.resetForTests()
  })

  it("blocks admission when the routing engine throws", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-blocked-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    await expect(
      fake.hooks.get("prompt")!({ sessionID: "ses_boom", prompt: { text: "Implement a feature in src/app.ts" } }),
    ).rejects.toBeInstanceOf(RouterBlockedError)
    const status = await fake.rpc().status({ sessionID: "ses_boom" })
    expect(status.lastDecision?.error).toContain("engine exploded")
    expect(fake.switched).toHaveLength(0)
    // Blocking a prompt must not rename the owner's chat.
    const session = await fake.ctx.session.get({ sessionID: "ses_boom" })
    expect(session.title).toBe("test")
    expect((await fake.rpc().status({ sessionID: "ses_boom" })).warnings.join(" ")).toContain("Blocked a prompt")
    await controller.dispose()
  })

  it("records the actual runtime on a failed decision", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-paused-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    await fake.rpc().setPaused({ paused: true })
    await expect(
      fake.hooks.get("prompt")!({ sessionID: "ses_paused", prompt: { text: "Implement a feature" } }),
    ).rejects.toBeInstanceOf(RouterBlockedError)
    const status = await fake.rpc().status({ sessionID: "ses_paused" })
    expect(status.lastDecision?.runtime).toBe("paused")
    await controller.dispose()
  })

  it("clears BLOCKED after a successful routed prompt", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-clear-blocked-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    await expect(
      fake.hooks.get("prompt")!({ sessionID: "ses_recover", prompt: { text: "Implement a feature in src/app.ts" } }),
    ).rejects.toBeInstanceOf(RouterBlockedError)
    let session = await fake.ctx.session.get({ sessionID: "ses_recover" })
    expect(session.title).toBe("test")

    mockState.fail = false
    await expect(
      fake.hooks.get("prompt")!({ sessionID: "ses_recover", prompt: { text: "Implement a feature in src/app.ts" } }),
    ).resolves.toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 25))
    session = await fake.ctx.session.get({ sessionID: "ses_recover" })
    expect(session.title).toBe("test")
    await controller.dispose()
  })

  it("records the failure and continues when failClosed is disabled", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-open-")))
    fake.ctx.options = { ...fake.ctx.options, routing: { failClosed: false } }
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    await expect(
      fake.hooks.get("prompt")!({ sessionID: "ses_open", prompt: { text: "Implement a feature in src/app.ts" } }),
    ).resolves.toBeUndefined()
    const status = await fake.rpc().status({ sessionID: "ses_open" })
    expect(status.lastDecision?.error).toContain("engine exploded")
    expect(fake.switched).toHaveLength(0)
    await controller.dispose()
  })
})
