import { Plugin } from "@opencode/plugin"
import { RouterController } from "./server/controller.js"
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
      return () => undefined
    }
  },
})
