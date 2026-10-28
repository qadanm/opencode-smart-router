import { Plugin } from "@opencode/plugin"
import { RouterBlockedError, RouterController } from "./server/controller.js"
import { stripTitlePrefix } from "./core/ui.js"
import { sharedCore } from "./server/shared-core.js"

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

export default Plugin.define({
  id: "opencode-smart-router",
  async setup(ctx) {
    const controller = new RouterController({ ctx, pluginOptions: ctx.options })
    try {
      return await controller.initialize()
    } catch (error) {
      // A broken location must not take down the host or the other bridges.
      sharedCore.recordError(`setup ${ctx.location?.directory ?? ""}: ${describe(error)}`)
      await controller.dispose().catch(() => undefined)
      // A broken location must not silently execute prompts with no routing.
      // Keep a minimal fail-closed hook until the next reload.
      try {
        await ctx.session.hook("prompt", async (event: any) => {
          const sessionID = event?.sessionID
          if (!sessionID) throw new RouterBlockedError("Smart Router setup failed")
          let info: any
          try {
            info = await ctx.session.get({ sessionID })
          } catch {
            info = undefined
          }
          const localID = ctx.location?.project?.id
          if (info?.projectID && localID && info.projectID !== localID) return
          if (info) {
            try {
              const base = stripTitlePrefix(typeof info.title === "string" ? info.title : "") || "Session"
              await ctx.session.update({ sessionID, title: `BLOCKED · router setup failed — ${base}` })
            } catch {
              // The rejection below still stops admission.
            }
          }
          throw new RouterBlockedError("Smart Router setup failed; routing is unavailable")
        })
      } catch (hookError) {
        sharedCore.recordError(`setup fallback hook ${ctx.location?.directory ?? ""}: ${describe(hookError)}`)
      }
      return () => undefined
    }
  },
})
