import { Plugin } from "@opencode/plugin"
import { RouterController } from "./server/controller.js"

/**
 * OpenCode loads a global plugin once per project location, and commands/RPC
 * are location-scoped. Keep one controller per loaded location. A project
 * guard in the prompt hook prevents a controller from handling another
 * project's sessions if the event stream is shared.
 */
let active: RouterController | undefined
let lifecycle: Promise<unknown> = Promise.resolve()

export default Plugin.define({
  id: "opencode-smart-router",
  setup(ctx) {
    const next = lifecycle.then(async () => {
      if (active) await active.dispose()
      const controller = new RouterController({ ctx, pluginOptions: ctx.options })
      active = controller
      const cleanup = await controller.initialize()
      return async () => {
        await cleanup?.()
        if (active === controller) active = undefined
      }
    })
    lifecycle = next.catch(() => undefined)
    return next
  },
})
