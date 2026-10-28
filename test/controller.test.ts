import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { RouterBlockedError, RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"

const liveModels = [
  {
    id: "deepseek-v4.1-flash",
    providerID: "opencode-go",
    name: "DeepSeek V4.1 Flash",
    limit: { context: 1_000_000, output: 384_000 },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
  },
  {
    id: "glm-5.3-flash",
    providerID: "opencode-go",
    name: "GLM-5.3-Flash",
    limit: { context: 1_000_000, output: 131_072 },
    capabilities: { tools: true, input: ["text", "image", "video"], output: ["text"] },
    cost: [{ input: 0.15, output: 0.5, cache: { read: 0.03, write: 0 } }],
  },
  {
    id: "deepseek-v4.1-flash",
    providerID: "commandcode",
    name: "DeepSeek V4.1 Flash (GOAT)",
    limit: { context: 1_000_000, output: 384_000 },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
  },
  {
    id: "claude-sonnet-5-5",
    providerID: "commandcode",
    name: "Claude Sonnet 5.5",
    limit: { context: 1_000_000, output: 128_000 },
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
    cost: [{ input: 2, output: 10, cache: { read: 0.1, write: 2.5 } }],
  },
]

const makeCtx = (directory: string) => {
  const storage = new Map<string, unknown>()
  const hooks = new Map<string, (event: any) => Promise<void> | void>()
  const commands = new Map<string, (input: any) => Promise<void>>()
  const switched: Array<{ sessionID: string; model: any }> = []
  const notices: string[] = []
  const sessions = new Map<string, any>()
  const titles = new Map<string, string>()
  let rpcImpl: any
  const ctx: any = {
    app: { version: "2.1.4" },
    location: { directory, project: { id: "prj", directory, canonical: directory } },
    options: {
      quota: { probeOpenCodeGo: false, probeCommandCode: false },
      premium: { mode: "ask", monthlyBudgetUsd: 0, oneShotApproval: true },
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
    },
    model: { list: async () => ({ data: liveModels }) },
    provider: {
      list: async () => ({ data: [{ id: "opencode-go" }, { id: "commandcode" }] }),
      get: async () => ({ data: { id: "commandcode", settings: {} } }),
    },
    integration: { connection: { active: async () => undefined, resolve: async () => undefined } },
    session: {
      hook: async (name: string, callback: any) => {
        hooks.set(name, callback)
        return { dispose: async () => undefined }
      },
      get: async ({ sessionID }: any) => {
        if (!sessions.has(sessionID)) {
          sessions.set(sessionID, {
            id: sessionID,
            parentID: undefined,
            model: undefined,
            title: "test",
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            cost: 0,
            time: { created: Date.now(), updated: Date.now() },
          })
        }
        return sessions.get(sessionID)
      },
      context: async () => ({ data: [] }),
      switchModel: async ({ sessionID, model }: any) => {
        const session = await ctx.session.get({ sessionID })
        session.model = model
        switched.push({ sessionID, model })
      },
      list: async () => ({ data: [] }),
      synthetic: async ({ text }: any) => {
        notices.push(text)
      },
      update: async ({ sessionID, title }: any) => {
        const session = await ctx.session.get({ sessionID })
        session.title = title
        titles.set(sessionID, title)
      },
    },
    event: {
      subscribe: async function* () {
        return
      },
    },
    rpc: {
      register: async (_contract: any, impl: any) => {
        rpcImpl = impl
        return { events: { emit: async () => undefined }, dispose: async () => undefined }
      },
    },
    command: {
      transform: (callback: any) => {
        callback({
          add: (command: any) => {
            commands.set(command.name, command.execute)
          },
        })
        return { dispose: async () => undefined }
      },
    },
  }
  return { ctx, hooks, commands, switched, notices, sessions, titles, rpc: () => rpcImpl }
}

describe("plugin controller integration", () => {
  beforeEach(() => sharedCore.resetForTests())

  it("routes the admitted prompt before it runs and records the decision", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-ctrl-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    const prompt = fake.hooks.get("prompt")!
    await prompt({ sessionID: "ses_a", prompt: { text: "Implement a feature in src/app.ts" } })
    expect(fake.switched).toHaveLength(1)
    expect(fake.switched[0]?.model.providerID).toBeDefined()
    const status = await fake.rpc().status({ sessionID: "ses_a" })
    expect(status.lastDecision?.chosen).toBeDefined()
    expect(status.lastDecision?.switched).toBe(true)
    await controller.dispose()
  })

  it("respects a manual model selection event", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-ctrl-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    const prompt = fake.hooks.get("prompt")!
    await prompt({ sessionID: "ses_b", prompt: { text: "Implement a feature in src/app.ts" } })
    const before = fake.switched.length
    await (controller as any).handleEvent({
      type: "session.model.selected",
      data: {
        sessionID: "ses_b",
        model: { providerID: "commandcode", id: "claude-sonnet-5-5" },
        previous: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      },
    })
    await prompt({ sessionID: "ses_b", prompt: { text: "Implement another feature in src/app.ts" } })
    expect(fake.switched.length).toBe(before)
    const status = await fake.rpc().status({ sessionID: "ses_b" })
    expect(status.manualOverride).toBe(true)
    expect(status.runtime).toBe("manual")
    await controller.dispose()
  })

  it("honors a one-shot premium approval for a premium task", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-ctrl-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    await fake.rpc().approvePremium({ sessionID: "ses_c" })
    await fake.hooks.get("prompt")!({
      sessionID: "ses_c",
      prompt: {
        text: "Redesign the landing page to match the attached Figma mockup. Improve typography and responsive layout.",
        files: [{ uri: "file:///tmp/mock.png", name: "mock.png" }],
      },
    })
    const chosen = fake.switched.at(-1)?.model
    const status = await fake.rpc().status({ sessionID: "ses_c" })
    const approved = status.approvedModels.find((model: any) => model.key === `${chosen.providerID}/${chosen.id}`)
    expect(approved?.premium).toBe(true)
    expect(approved?.vision).toBe(true)
    await controller.dispose()
  })

  it("does not switch in dry-run mode and exposes status commands", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-ctrl-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    await fake.rpc().setDryRun({ dryRun: true })
    await fake.hooks.get("prompt")!({ sessionID: "ses_d", prompt: { text: "Implement a feature in src/app.ts" } })
    expect(fake.switched).toHaveLength(0)
    const status = await fake.rpc().status({ sessionID: "ses_d" })
    expect(status.dryRun).toBe(true)
    expect(status.lastDecision?.chosen).toBeDefined()
    expect(fake.commands.has("router-status")).toBe(true)
    await fake.commands.get("router-status")!({ sessionID: "ses_d", prompt: { text: "" } })
    expect(fake.notices.length).toBeGreaterThan(0)
    await controller.dispose()
  })

  it("persists runtime controls and can reset local metrics", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-ctrl-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    await fake.rpc().setMode({ mode: "efficiency" })
    await fake.rpc().setPremiumBudget({ usd: 12 })
    await fake.rpc().setReserve({ providerID: "opencode-go", monthlyPct: 20, weeklyPct: 25, fiveHourPct: 30 })
    const config = await fake.rpc().getConfig({})
    expect(config.settings.mode).toBe("efficiency")
    expect(config.settings.premium.monthlyBudgetUsd).toBe(12)
    expect(config.settings.providers["opencode-go"].reserveMonthlyPct).toBe(20)
    const reset = await fake.rpc().resetMetrics({})
    expect(reset.metrics.requests).toBe(0)
    expect(fake.commands.has("router-reset-metrics")).toBe(true)
    await controller.dispose()
  })

  it("does not cascade premium routing into subagent sessions", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-ctrl-")))
    fake.sessions.set("ses_child", {
      id: "ses_child",
      parentID: "ses_parent",
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      title: "child",
      tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      time: { created: Date.now(), updated: Date.now() },
    })
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    await fake.rpc().setMode({ mode: "premium" })
    await fake.rpc().setPremiumBudget({ usd: 25 })
    await fake.hooks.get("prompt")!({
      sessionID: "ses_child",
      prompt: {
        text: "Redesign the landing page to match the attached Figma mockup. Improve typography and responsive layout.",
        files: [{ uri: "file:///tmp/mock.png", name: "mock.png" }],
      },
    })
    const chosen = fake.switched.at(-1)?.model
    const status = await fake.rpc().status({ sessionID: "ses_child" })
    const approved = status.approvedModels.find((model: any) => model.key === `${chosen.providerID}/${chosen.id}`)
    expect(approved?.premium).toBe(false)
    await controller.dispose()
  })

  it("writes a persistent AUTO/MANUAL title and exposes the indicator state", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-ctrl-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    await fake.rpc().pin({
      sessionID: "ses_title",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
      variant: "max",
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(fake.titles.get("ses_title")).toMatch(/^MANUAL · Go · DeepSeek V4\.1 Flash/)
    expect((await fake.rpc().status({ sessionID: "ses_title" })).indicator.state).toBe("MANUAL")
    await fake.rpc().resumeAuto({ sessionID: "ses_title" })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(fake.titles.get("ses_title")).toMatch(/^AUTO · Go · DeepSeek V4\.1 Flash/)
    expect((await fake.rpc().status({ sessionID: "ses_title" })).indicator.state).toBe("AUTO")
    await fake.rpc().setTitleIndicator({ enabled: false })
    expect(fake.titles.get("ses_title")).toBe("test")
    await fake.rpc().setTitleIndicator({ enabled: true })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(fake.titles.get("ses_title")).toMatch(/^AUTO · Go · DeepSeek V4\.1 Flash/)
    await controller.dispose()
  })

  it("shares one ledger and quota service when two bridges initialize concurrently", async () => {
    const first = makeCtx(mkdtempSync(join(tmpdir(), "router-race-a-")))
    const second = makeCtx(mkdtempSync(join(tmpdir(), "router-race-b-")))
    const a = new RouterController({ ctx: first.ctx, pluginOptions: first.ctx.options })
    const b = new RouterController({ ctx: second.ctx, pluginOptions: second.ctx.options })
    await Promise.all([a.initialize(), b.initialize()])
    expect((a as any).ledger).toBe(sharedCore.ledger)
    expect((b as any).ledger).toBe(sharedCore.ledger)
    expect((a as any).quota).toBe(sharedCore.quota)
    expect((b as any).quota).toBe(sharedCore.quota)
    await first.hooks.get("prompt")!({ sessionID: "ses_race_a", prompt: { text: "Implement a feature in src/a.ts" } })
    await second.hooks.get("prompt")!({ sessionID: "ses_race_b", prompt: { text: "Implement a feature in src/b.ts" } })
    expect(sharedCore.diagnostics().decisions).toBeGreaterThanOrEqual(2)
    await a.dispose()
    await b.dispose()
  })

  it("shares one core across independent project bridges", async () => {
    const first = makeCtx(mkdtempSync(join(tmpdir(), "router-ctrl-a-")))
    const second = makeCtx(mkdtempSync(join(tmpdir(), "router-ctrl-b-")))
    const a = new RouterController({ ctx: first.ctx, pluginOptions: first.ctx.options })
    const b = new RouterController({ ctx: second.ctx, pluginOptions: second.ctx.options })
    await a.initialize()
    await b.initialize()
    const shared = sharedCore.diagnostics()
    expect(shared.bridgeCount).toBe(2)
    expect(shared.coreID).toBe(sharedCore.diagnostics().coreID)
    expect(first.commands.size).toBeGreaterThan(10)
    expect(second.commands.size).toBeGreaterThan(10)
    await first.hooks.get("prompt")!({ sessionID: "ses_a", prompt: { text: "Implement a feature in src/a.ts" } })
    await second.hooks.get("prompt")!({ sessionID: "ses_b", prompt: { text: "Implement a feature in src/b.ts" } })
    expect(sharedCore.diagnostics().decisions).toBeGreaterThanOrEqual(2)
    await a.dispose()
    expect(sharedCore.diagnostics().bridgeCount).toBe(1)
    await b.dispose()
    expect(sharedCore.diagnostics().bridgeCount).toBe(0)
  })

  it("ignores global model and step events from another project bridge", async () => {
    const first = makeCtx(mkdtempSync(join(tmpdir(), "router-ctrl-a-")))
    const second = makeCtx(mkdtempSync(join(tmpdir(), "router-ctrl-b-")))
    const a = new RouterController({ ctx: first.ctx, pluginOptions: first.ctx.options })
    const b = new RouterController({ ctx: second.ctx, pluginOptions: second.ctx.options })
    await a.initialize()
    await b.initialize()
    await first.hooks.get("prompt")!({ sessionID: "ses_owned", prompt: { text: "Implement a feature in src/a.ts" } })
    const before = sharedCore.diagnostics()
    await (b as any).handleEvent({
      type: "session.model.selected",
      data: {
        sessionID: "ses_owned",
        model: { providerID: "commandcode", id: "claude-sonnet-5-5" },
        previous: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      },
    })
    expect((a as any).statusFor("ses_owned").manualOverride).toBe(false)
    await (b as any).handleEvent({
      type: "session.step.ended",
      data: { sessionID: "ses_owned", cost: 1, tokens: { input: 10, output: 1, cache: { read: 0, write: 0 } } },
    })
    const after = sharedCore.diagnostics()
    expect(after.eventsIgnored).toBeGreaterThan(before.eventsIgnored)
    expect(after.ledgerEvents).toBe(before.ledgerEvents)
    await (a as any).handleEvent({
      type: "session.model.selected",
      data: {
        sessionID: "ses_owned",
        model: { providerID: "commandcode", id: "claude-sonnet-5-5" },
        previous: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      },
    })
    expect((a as any).statusFor("ses_owned").manualOverride).toBe(true)
    await a.dispose()
    await b.dispose()
  })

  it("fails closed when no qualified route exists and the current model is unqualified", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-ctrl-")))
    fake.ctx.options = {
      ...fake.ctx.options,
      providers: {
        "opencode-go": { enabled: false, probeUsage: false },
        commandcode: { enabled: false, probeUsage: false },
      },
      routing: { failClosed: true },
    }
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    await expect(
      fake.hooks.get("prompt")!({ sessionID: "ses_block", prompt: { text: "Implement a feature in src/app.ts" } }),
    ).rejects.toBeInstanceOf(RouterBlockedError)
    const status = await fake.rpc().status({ sessionID: "ses_block" })
    expect(status.lastDecision?.error).toMatch(/provider|model|eligible/i)
    await controller.dispose()
  })

  it("can opt out of fail-closed behavior", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-ctrl-")))
    fake.ctx.options = {
      ...fake.ctx.options,
      providers: {
        "opencode-go": { enabled: false, probeUsage: false },
        commandcode: { enabled: false, probeUsage: false },
      },
      routing: { failClosed: false },
    }
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    await expect(
      fake.hooks.get("prompt")!({ sessionID: "ses_open", prompt: { text: "Implement a feature in src/app.ts" } }),
    ).resolves.toBeUndefined()
    await controller.dispose()
  })

  it("routes a session whose directory is inside the location even when the project id differs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-ctrl-sub-"))
    const fake = makeCtx(dir)
    const info = await fake.ctx.session.get({ sessionID: "ses_sub" })
    info.projectID = "parent-project"
    info.location = { directory: join(dir, "packages", "app") }
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    await fake.hooks.get("prompt")!({ sessionID: "ses_sub", prompt: { text: "Implement a feature in src/app.ts" } })
    const status = await fake.rpc().status({ sessionID: "ses_sub" })
    expect(status.lastDecision).toBeDefined()
    await controller.dispose()
  })

  it("ignores a session outside the location directory", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-ctrl-out-")))
    const info = await fake.ctx.session.get({ sessionID: "ses_out" })
    info.projectID = "other-project"
    info.location = { directory: "/tmp/router-unrelated-location" }
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    await fake.hooks.get("prompt")!({ sessionID: "ses_out", prompt: { text: "Implement a feature in src/app.ts" } })
    const status = await fake.rpc().status({ sessionID: "ses_out" })
    expect(status.lastDecision).toBeUndefined()
    await controller.dispose()
  })

  it("pauses globally without touching the current model", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-ctrl-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    await fake.rpc().setPaused({ paused: true })
    await fake.hooks.get("prompt")!({ sessionID: "ses_e", prompt: { text: "Implement a feature in src/app.ts" } })
    expect(fake.switched).toHaveLength(0)
    const status = await fake.rpc().status({ sessionID: "ses_e" })
    expect(status.runtime).toBe("paused")
    await controller.dispose()
  })
})
