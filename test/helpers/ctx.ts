import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const liveModels = [
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
  {
    // OpenDesign's DeepSeek, served through the gateway. Compaction tests pin
    // this model because it is the one with a verified 1M window.
    id: "deepseek-v4.1-flash",
    providerID: "opendesign",
    name: "DeepSeek V4.1 Flash (OpenDesign)",
    limit: { context: 1_000_000, output: 384_000 },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
  },
  {
    // Anthropic-protocol, and served by this host. The context-repair tests
    // need such a model: repair only applies to the Anthropic protocol, so a
    // fixture that omits one cannot exercise it.
    id: "claude-haiku-5-5",
    providerID: "opencode-go",
    name: "Claude Haiku 5.5",
    limit: { context: 200_000, output: 64_000 },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    cost: [{ input: 0.8, output: 4, cache: { read: 0.08, write: 1 } }],
  },
  {
    // A premium, vision-capable model the host actually serves. It belongs in
    // the fixture for the same reason it belongs in a real model list: the
    // router may only choose models OpenCode can resolve, so a test that
    // expects a premium choice must give the host that model.
    id: "grok-4.7",
    providerID: "opencode-go",
    name: "Grok 4.7",
    limit: { context: 1_000_000, output: 128_000 },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
  },
]

export const makeCtx = (directory: string) => {
  // The router merges the user's global config file over plugin options, so
  // the test suite must not read the developer's real
  // ~/.config/opencode/smart-router.json. Point HOME at the test directory so
  // the suite is hermetic and behaves the same on every machine.
  const previousHome = process.env.HOME
  process.env.HOME = directory
  const storage = new Map<string, unknown>()
  const hooks = new Map<string, (event: any) => Promise<void> | void>()
  const commands = new Map<string, (input: any) => Promise<void>>()
  const switched: Array<{ sessionID: string; model: any }> = []
  const notices: string[] = []
  const syntheticCalls: any[] = []
  const compactions: any[] = []
  const sessions = new Map<string, any>()
  /** Messages returned by `session.context()`. Tests set this to model the
   * host's transcript, including its token counts. */
  let contextMessages: any[] = []
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
      context: async () => ({ data: contextMessages }),
      switchModel: async ({ sessionID, model }: any) => {
        const session = await ctx.session.get({ sessionID })
        session.model = model
        switched.push({ sessionID, model })
      },
      compact: async (input: any) => {
        compactions.push(input)
        const session = await ctx.session.get({ sessionID: input.sessionID })
        session.tokens = { input: 100, output: 10, cache: { read: 0, write: 0 } }
      },
      list: async () => ({ data: [] }),
      synthetic: async (input: any) => {
        syntheticCalls.push(input)
        notices.push(input.text)
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
  return {
    ctx,
    hooks,
    commands,
    switched,
    notices,
    syntheticCalls,
    compactions,
    sessions,
    titles,
    /** Replace the transcript that `session.context()` returns. */
    setContextMessages: (messages: any[]) => {
      contextMessages = messages
    },
    rpc: () => rpcImpl,
    restoreHome: () => {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    },
  }
}
