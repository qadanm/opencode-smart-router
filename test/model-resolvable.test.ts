import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"

/**
 * The router must not switch a session to a model OpenCode cannot resolve.
 *
 * THE DEFECT THIS PINS (observed live, 2026-11-03):
 *
 *   Model unavailable: opendesign/deepseek-v4.1-flash
 *
 * The gateway served that model. The subscription was valid. The API key worked: a
 * direct completion against the provider returned HTTP 200. The model was even listed
 * by `opencode models`. What went wrong was that the provider's model list was empty
 * for a moment, because the plugin directory had been replaced underneath a running
 * OpenCode server. The router had already switched the session to that model, so the
 * next step failed while resolving it, and four live sessions died with a message
 * that reads like a dead provider.
 *
 * The router builds its candidates from the gateway and the seed catalog. OpenCode's
 * model list is a third, independent thing. When they disagree the switch must be
 * skipped rather than performed.
 *
 * The inverse matters just as much: a host that CANNOT answer the question (no
 * `model` API, or a throw) must not be read as a refusal, or routing stops dead.
 */

const dir = () => mkdtempSync(join(tmpdir(), "router-resolvable-"))

describe("switching only to models the host actually exposes", () => {
  beforeEach(() => sharedCore.resetForTests())

  /** Run one prompt and report whether a switch happened. */
  async function routeOnce(mutate: (ctx: any) => void) {
    const fake = makeCtx(dir())
    mutate(fake.ctx)
    const controller = new RouterController({
      ctx: fake.ctx,
      pluginOptions: fake.ctx.options,
    } as never)
    await controller.initialize()
    const prompt = fake.hooks.get("prompt")!
    await prompt({
      sessionID: "ses_resolvable",
      prompt: { text: "Implement a feature in src/app.ts" },
    })
    await controller.dispose?.()
    return fake.switched
  }

  it("skips the switch when the host has the model API and does not have the model", async () => {
    const switched = await routeOnce((ctx) => {
      // The host answers, and the answer is "I do not have any of these".
      ctx.model = { get: async () => undefined }
    })
    // This is the fix: previously the switch went ahead and the session died on its
    // next step with "Model unavailable".
    expect(switched).toHaveLength(0)
  })

  it("allows the switch when the host does have the model", async () => {
    const switched = await routeOnce((ctx) => {
      ctx.model = {
        get: async (providerID: string, modelID: string) => ({ providerID, modelID }),
      }
    })
    expect(switched.length).toBeGreaterThan(0)
  })

  it("does not read a missing model API as a refusal", async () => {
    // Older hosts, and every test double, have no `ctx.model`. Routing must continue.
    const switched = await routeOnce((ctx) => {
      delete ctx.model
    })
    expect(switched.length).toBeGreaterThan(0)
  })

  it("does not read a throwing model API as a refusal", async () => {
    const switched = await routeOnce((ctx) => {
      ctx.model = {
        get: async () => {
          throw new Error("host unavailable")
        },
      }
    })
    expect(switched.length).toBeGreaterThan(0)
  })
})
