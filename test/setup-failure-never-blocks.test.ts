import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"

import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"

/**
 * A setup that fails must not become a plugin that refuses prompts.
 *
 * The entry point used to install a "minimal fail-closed hook" whenever
 * `initialize()` threw, so the editor kept a hook that rejected every prompt
 * until the next reload. That is the same defect class as 0.6.0's ledger
 * throw, one layer up: a plugin that is already broken reaches for the
 * strongest available response and makes the editor unusable.
 *
 * If setup fails, the correct outcome is that this location has no router. The
 * host then behaves exactly as it would with the plugin uninstalled, which is
 * the guarantee the plugin owes its host.
 */
describe("plugin setup failure", () => {
  beforeEach(() => {
    sharedCore.resetForTests()
  })

  it("returns a working cleanup even when setup throws", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-entry-fail-")))
    fake.ctx.command.transform = () => {
      throw new Error("command registration failed")
    }
    const entry = (await import("../src/index.js")).default

    const cleanup = await entry.setup(fake.ctx)

    expect(typeof cleanup).toBe("function")
    // Disposing must be safe on a location that never initialized.
    await expect(Promise.resolve().then(() => cleanup?.())).resolves.toBeUndefined()
  })

  it("does not install a hook that refuses every prompt", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-entry-fail-hook-")))
    fake.ctx.command.transform = () => {
      throw new Error("command registration failed")
    }
    const entry = (await import("../src/index.js")).default

    const cleanup = await entry.setup(fake.ctx)

    // Either no prompt hook at all, or one that lets the prompt through. What
    // must not happen is a hook that rejects: the owner would be unable to send
    // a message, which is exactly the failure this release exists to remove.
    const fallback = fake.hooks.get("prompt")
    if (fallback) {
      await expect(
        fallback({ sessionID: "ses_setup_failed", prompt: { text: "Implement a feature" } }),
      ).resolves.toBeUndefined()
    }

    await cleanup?.()
  })

  it("records the failure so it is visible in diagnostics", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-entry-fail-diag-")))
    fake.ctx.command.transform = () => {
      throw new Error("command registration failed")
    }
    const entry = (await import("../src/index.js")).default

    const cleanup = await entry.setup(fake.ctx)

    expect(sharedCore.diagnostics().errors.some((error) => error.includes("setup"))).toBe(true)
    await cleanup?.()
  })
})
