import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { makeCtx } from "./helpers/ctx.js"

/**
 * THE ADOPTION ITSELF.
 *
 * `sharedCore` is a module-level constant, resolved once when the module is
 * imported. That is why the other skew test could not guard this property: it
 * breaks the ledger on an already-built core, which the defensive reads survive,
 * but it never exercises the decision to adopt or refuse a foreign object.
 *
 * The production sequence is different. A process that already ran an older
 * version has that version's object sitting on `globalThis` when the new
 * bundle's module graph is evaluated. The lookup happens there, at import time,
 * and 0.6.0 adopted whatever it found. These tests plant a foreign core BEFORE
 * importing the module, which is the only way to test the real thing.
 *
 * `vi.resetModules()` is what makes the import fresh, so the module-level
 * lookup runs again against the planted object.
 */
const KEY = Symbol.for("opencode-smart-router.shared-core.v1")

const foreignCore = () => ({
  // No apiVersion stamp, and a method set from an older release. Adopting this
  // is what produced "this.ledger.planPoolSpent is not a function" on every
  // prompt in 0.6.0.
  coreID: "previous-version",
  pid: process.pid,
  createdAt: Date.now(),
  ledger: { premiumSpent: () => 0, patchSession: () => undefined },
  runtime: {},
})

describe("shared core adoption", () => {
  afterEach(() => {
    delete (globalThis as any)[KEY]
    vi.resetModules()
  })

  it("refuses a core left by another version", async () => {
    const planted = foreignCore()
    ;(globalThis as any)[KEY] = planted
    vi.resetModules()

    const { sharedCore } = await import("../src/server/shared-core.js")

    // The decisive assertion: the module is not using the planted object.
    expect(sharedCore).not.toBe(planted)
    expect((sharedCore as any).apiVersion).toBeDefined()
  })

  it("reports that a foreign core was present", async () => {
    ;(globalThis as any)[KEY] = foreignCore()
    vi.resetModules()

    const { inheritedForeignCore } = await import("../src/server/shared-core.js")

    expect(inheritedForeignCore).toBe(true)
  })

  it("adopts its own core, so an already-initialized process keeps sharing one", async () => {
    vi.resetModules()
    const first = await import("../src/server/shared-core.js")
    const own = first.sharedCore

    vi.resetModules()
    ;(globalThis as any)[KEY] = own
    const second = await import("../src/server/shared-core.js")

    // Re-importing the SAME version must not build a second core, or two
    // bridges would race on the same plugin storage.
    expect(second.sharedCore).toBe(own)
    expect(second.inheritedForeignCore).toBe(false)
  })

  it("a refused core does not poison routing", async () => {
    ;(globalThis as any)[KEY] = foreignCore()
    vi.resetModules()

    const { RouterController } = await import("../src/server/controller.js")
    const { sharedCore } = await import("../src/server/shared-core.js")
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-adopt-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()

    await expect(
      fake.hooks.get("prompt")!({
        sessionID: "ses_adopt",
        prompt: { text: "Implement a feature in src/app.ts" },
      }),
    ).resolves.toBeUndefined()

    await controller.dispose()
    sharedCore.resetForTests()
  })
})
