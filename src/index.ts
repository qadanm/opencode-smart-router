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
      // A broken location must not take down the host or the other bridges, and
      // it must not take the owner's ability to send a prompt with it.
      //
      // This branch used to install a "minimal fail-closed hook" that rejected
      // every prompt until the next reload. That turned a failed setup into a
      // disabled editor, which is the worst possible response to a plugin that
      // is already not working. Verified in scripts/isolated-e2e.sh: a plugin
      // hook that throws fails the request outright, so a hook here is not a
      // safety net.
      //
      // The correct outcome is that this location has no router. OpenCode then
      // behaves exactly as it would with the plugin uninstalled, which is the
      // guarantee the plugin owes its host. The failure stays visible in
      // diagnostics and in the status RPC of any bridge that did start.
      sharedCore.recordError(`setup ${ctx.location?.directory ?? ""}: ${describe(error)}`)
      await controller.dispose().catch(() => undefined)
      return () => undefined
    }
  },
})
