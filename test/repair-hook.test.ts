import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"

/**
 * The host builds a canonical context per model request. Mid-session system
 * notices arrive as `role: "system"` entries; the Anthropic-protocol path
 * rejects anything but `user | assistant`, so for those providers the router
 * folds every system role after index 0 into a user message before the
 * request is sent. Utility requests (title, compaction) are never repaired.
 */
describe("prompt repair via the context hook", () => {
  let fake: ReturnType<typeof makeCtx>
  let controller: RouterController

  beforeEach(async () => {
    sharedCore.resetForTests()
    fake = makeCtx(mkdtempSync(join(tmpdir(), "router-repair-")))
    controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
  })

  afterEach(async () => {
    await controller.dispose()
  })

  const contextHook = () => {
    const hook = fake.hooks.get("context")
    if (!hook) throw new Error("context hook is not registered")
    return hook
  }

  const modelRequestHook = () => {
    const hook = fake.hooks.get("model.request")
    if (!hook) throw new Error("model.request hook is not registered")
    return hook
  }

  const ownedSession = () => {
    sharedCore.claimSession("ses_repair", (controller as any).bridgeID)
  }

  it("folds mid-conversation system roles for a primary request", async () => {
    ownedSession()
    const messages = [
      { role: "user", content: "hello" },
      { role: "system", content: "New instructions from mid-session" },
      { role: "assistant", content: "ack" },
    ]
    const event: any = { sessionID: "ses_repair", model: { providerID: "commandcode", id: "claude-haiku-5-5" }, messages }
    await contextHook()(event)
    expect(event.messages[1].role).toBe("user")
    expect(event.messages[1].content).toBe("New instructions from mid-session")
  })

  it("leaves the messages alone when a system role appears only at index 0", async () => {
    ownedSession()
    const messages = [
      { role: "system", content: "You are the host" },
      { role: "user", content: "hello" },
    ]
    const event: any = { sessionID: "ses_repair", model: { providerID: "commandcode", id: "claude-haiku-5-5" }, messages }
    await contextHook()(event)
    expect(event.messages[0].role).toBe("system")
  })

  it("skips folding when the model is openai-compat", async () => {
    ownedSession()
    const messages = [
      { role: "user", content: "hello" },
      { role: "system", content: "notice" },
    ]
    const event: any = { sessionID: "ses_repair", model: { providerID: "commandcode", id: "deepseek-v4.1-flash" }, messages }
    await contextHook()(event)
    expect(event.messages).toBe(messages)
  })

  it("folds with no latched kind, defaulting to the primary agent loop", async () => {
    ownedSession()
    const messages = [
      { role: "user", content: "hello" },
      { role: "system", content: "notice" },
    ]
    const event: any = { sessionID: "ses_repair", model: { providerID: "commandcode", id: "claude-haiku-5-5" }, messages }
    await contextHook()(event)
    expect(event.messages[1].role).toBe("user")
  })

  it("skips folding for a latched non-primary request kind", async () => {
    ownedSession()
    await modelRequestHook()({ sessionID: "ses_repair", kind: "title", model: { providerID: "commandcode", id: "claude-haiku-5-5" } })
    const messages = [
      { role: "user", content: "hello" },
      { role: "system", content: "notice" },
    ]
    const event: any = { sessionID: "ses_repair", model: { providerID: "commandcode", id: "claude-haiku-5-5" }, messages }
    await contextHook()(event)
    expect(event.messages).toBe(messages)
  })

  it("skips folding for a session this bridge does not own", async () => {
    fake.sessions.set("ses_foreign", {
      id: "ses_foreign",
      projectID: "other-project",
      title: "test",
    })
    const messages = [
      { role: "user", content: "hello" },
      { role: "system", content: "notice" },
    ]
    const event: any = { sessionID: "ses_foreign", model: { providerID: "commandcode", id: "claude-haiku-5-5" }, messages }
    await contextHook()(event)
    expect(event.messages).toBe(messages)
  })
})
