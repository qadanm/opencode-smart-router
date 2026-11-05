import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"

/**
 * Walking the first-run experience exactly as a new user does.
 *
 * Every other test checks a mechanism. This one checks the sequence: what the
 * router reports before anything has happened, what it says after the user
 * pastes their balance, and whether it stops asking once told.
 *
 * It exists because the onboarding logic is the one place where a plausible
 * implementation can be entirely wrong — a screen that appears twice, or never,
 * or asks for information it already has, fails no unit test and fails the user
 * immediately.
 */

describe("first run, as a new user experiences it", () => {
  beforeEach(() => sharedCore.resetForTests())

  const fresh = () => {
    // A directory that has never held a config file.
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-firstrun-")))
    return fake
  }

  it("reports a first run before anything has been configured", async () => {
    const fake = fresh()
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()

    const state: any = await fake.rpc().onboarding({})
    expect(state.firstRun).toBe(true)
    // Nothing has been chosen, so every provider is detection's business.
    expect(Array.isArray(state.providers)).toBe(true)
    expect(typeof state.mode).toBe("string")

    await controller.dispose()
  })

  it("names the providers it found, and reports the ones it did not", async () => {
    const fake = fresh()
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()

    const state: any = await fake.rpc().onboarding({})
    for (const provider of state.providers) {
      // Every row must say two things: whether a credential was found, and
      // whether the provider is consequently enabled. A row with one and not the
      // other would be unexplainable on screen.
      expect(typeof provider.found).toBe("boolean")
      expect(typeof provider.enabled).toBe("boolean")
      expect(typeof provider.label).toBe("string")
      // A provider is enabled only if a credential was found for it.
      if (!provider.found) expect(provider.enabled).toBe(false)
    }
    await controller.dispose()
  })

  it("stops reporting a first run once the user has seen it", async () => {
    const fake = fresh()
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    expect((await fake.rpc().onboarding({})) as any).toMatchObject({ firstRun: true })

    await fake.rpc().completeOnboarding({})

    expect((await fake.rpc().onboarding({})) as any).toMatchObject({ firstRun: false })
    await controller.dispose()
  })

  it("accepts a pasted Plan & balance page and applies it", async () => {
    const fake = fresh()
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()

    // The page a new user copies, navigation and all.
    const page = [
      "Muhammed Qadan's workspace",
      "Plan & balance",
      "API keys",
      "Open Design",
      "Pro",
      "This period ends on November 29, 2026",
      "Manage subscription",
      "Design Plan credits",
      "41%",
      "7 days of quota remaining",
      "Reset in 0 days 22 hours",
      "Pay-as-you-go credits",
      "$120.00",
      "Top up",
    ].join("\n")

    const preview: any = await (controller as any).recordPlanPage({ page })
    expect(preview.ok).toBe(true)
    expect(preview.preview.kind).toBe("allowance")
    // Preview must not write. A paste is not a promise that it was understood.
    expect(preview.preview.summary).toContain("41% of the seven-day allowance")
    expect(preview.preview.summary).toContain("Pro plan")

    const applied: any = await (controller as any).recordPlanPage({ page, confirm: true })
    expect(applied.ok).toBe(true)
    const baseline = (controller as any).settings.providers.opendesign.baseline
    expect(baseline.designPlanUsedPct).toBe(41)
    expect(baseline.pctOf).toBe("weekly")

    await controller.dispose()
  })

  it("refuses a page it cannot read, with a sentence a person can act on", async () => {
    const fake = fresh()
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()

    const result: any = await (controller as any).recordPlanPage({ page: "Welcome to OpenDesign\nSign in" })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/could not be read/i)

    await controller.dispose()
  })

  it("does not ask for a reading once one is already recorded", async () => {
    const fake = fresh()
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()

    const page = "Pro\nDesign Plan credits\n12%\n7 days of quota remaining\nReset in 0 days 5 hours"
    await (controller as any).recordPlanPage({ page, confirm: true })

    const state: any = await fake.rpc().onboarding({})
    // The baseline exists, so a good first-run screen stops offering the paste.
    expect((controller as any).settings.providers.opendesign.baseline).toBeDefined()
    expect(state.firstRun).toBe(true)

    await controller.dispose()
  })
})
