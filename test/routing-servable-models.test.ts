import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"

import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"

/**
 * THE ROUTER MAY ONLY CHOOSE A MODEL THE HOST CAN SERVE.
 *
 * The candidate list used to be the whole approved seed catalog, which
 * describes providers in general rather than the ones configured on this
 * machine. On a fresh install that meant the router could switch a session onto
 * `opencode-go/claude-haiku-5-5`, and the next step died with "Model
 * unavailable". Verified in a real OpenCode process by
 * `scripts/isolated-e2e.sh`, scenario `real-bundle`.
 *
 * The property needs a negative test, not a positive one. Asserting that some
 * model gets chosen passes whether or not filtering happened, because the
 * fixture's host serves most of the catalog. What distinguishes the two
 * behaviors is a model that is approved but NOT served: with filtering it can
 * never be chosen, without filtering it can.
 */
describe("routing only considers models the host serves", () => {
  beforeEach(() => {
    sharedCore.resetForTests()
  })

  it("never chooses a model absent from the host's list", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-servable-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()

    const hostList = (await sharedCore.getLiveModels()).map(
      (model: any) => `${model.providerID}/${model.id}`,
    )
    expect(hostList.length).toBeGreaterThan(0)

    // A tier-3 design task is the one most likely to reach for a flagship that
    // the host does not have, which is exactly how the production failure went.
    await fake.hooks.get("prompt")!({
      sessionID: "ses_servable",
      prompt: {
        text: "Redesign the landing page to match the attached Figma mockup. Improve typography and responsive layout.",
        files: [{ uri: "file:///tmp/mock.png", name: "mock.png" }],
      },
    })

    const chosen = fake.switched.at(-1)?.model
    if (chosen) {
      expect(hostList).toContain(`${chosen.providerID}/${chosen.id}`)
    }

    // And the same for every candidate the decision considered, because a
    // servable choice among unservable candidates is still a routing bug that
    // shows up on the next prompt.
    const status = await fake.rpc().status({ sessionID: "ses_servable" })
    const candidates: any[] = (status.lastDecision as any)?.candidates ?? []
    for (const candidate of candidates) {
      const key = `${candidate.model?.providerID}/${candidate.model?.modelID}`
      expect(hostList).toContain(key)
    }

    await controller.dispose()
  })

  it("does not fall back to the unfiltered catalog when nothing is servable", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-no-fallback-")))
    const probe = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await probe.initialize()
    const hostList = (await sharedCore.getLiveModels()).map(
      (model: any) => `${model.providerID}/${model.id}`,
    )
    await probe.dispose()

    fake.ctx.options = { ...fake.ctx.options, models: { excluded: hostList } }
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()

    // The exact seam. `routingModels()` is what the routing decision receives,
    // so this is where the fallback would show. The behavioral test above
    // cannot see it: the engine independently rejects those seed models in this
    // fixture, which masks the difference. Asserting the seam is the only
    // honest way to pin the property.
    const candidates: any[] = await (controller as any).routingModels()
    expect(candidates).toHaveLength(0)

    await controller.dispose()
  })

  it("leaves the session alone when nothing servable is approved", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-no-servable-")))
    // Exclude every model the host actually serves, leaving only seed models
    // that this machine cannot resolve. `models.approved` is additive, so
    // exclusion is the only way to build the state.
    sharedCore.resetForTests()
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    const hostList = (await sharedCore.getLiveModels()).map(
      (model: any) => `${model.providerID}/${model.id}`,
    )
    await controller.dispose()

    fake.ctx.options = {
      ...fake.ctx.options,
      models: { excluded: hostList },
    }
    const isolated = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await isolated.initialize()

    await fake.hooks.get("prompt")!({
      sessionID: "ses_no_servable",
      prompt: { text: "Implement a feature in src/app.ts" },
    })

    // No switch is the correct answer: an empty candidate list means this
    // plugin has nothing it may usefully route to here, so the host behaves as
    // it would with the plugin uninstalled. The alternative, falling back to
    // the unfiltered catalog, is how an unservable model got chosen before.
    expect(fake.switched).toHaveLength(0)

    // Asserted at the decision level too, because the switch guard would also
    // refuse an unservable choice and hide the regression. With the fallback in
    // place the candidates are the whole catalog and `chosen` is populated;
    // without it there is genuinely nothing to route to.
    const status = await fake.rpc().status({ sessionID: "ses_no_servable" })
    const decision: any = status.lastDecision
    expect(decision?.candidates ?? []).toHaveLength(0)
    expect(decision?.chosen).toBeUndefined()

    await isolated.dispose()
  })
})
