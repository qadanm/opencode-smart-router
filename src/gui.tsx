import { Command, Panel, Plugin, Slot, usePlugin, type PanelTab } from "@opencode/plugin/gui"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { SmartRouterRpc } from "./rpc"

/**
 * P0 spike. Proves three things and nothing else:
 *
 *   1. OpenCode Desktop loads a `./gui-experimental` bundle from this package.
 *   2. A side panel and a window slot render inside the real app shell.
 *   3. The window reaches the server part over RPC (`smart-router.status`).
 *
 * It is deliberately plain. The design work starts at P2; if this does not
 * load, there is no point designing anything.
 */

interface RouterStatus {
  mode?: string
  runtime?: string
  current?: { providerID: string; id: string }
  quota?: ReadonlyArray<{ label?: string; providerID?: string; error?: string }>
  lastDecision?: {
    chosen?: { providerID: string; id: string }
    reasons?: ReadonlyArray<string>
    candidates?: ReadonlyArray<unknown>
  }
  approvedModels?: ReadonlyArray<unknown>
}

const tab: PanelTab = {
  id: "spike",
  get title() {
    return "Router"
  },
  closable: "hover",
}

function SpikePanel() {
  const ctx = usePlugin<typeof definition>()
  const [status, setStatus] = createSignal<RouterStatus | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [loading, setLoading] = createSignal(true)

  const load = async () => {
    try {
      // The server part registers SmartRouterRpc under the id "smart-router".
      const result = (await ctx.client.rpc(SmartRouterRpc).status({})) as RouterStatus
      setStatus(result)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void load()
    const timer = setInterval(() => void load(), 5_000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "8px", padding: "8px" }}>
      <span>Smart Router — spike</span>

      <Show when={loading()}>
        <span>Loading…</span>
      </Show>

      <Show when={error()}>
        <span>RPC unavailable: {error()}</span>
      </Show>

      <Show when={status()}>
        {(value) => (
          <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
            <span>
              {value().runtime ?? "?"} · {value().mode ?? "?"}
            </span>
            <span>
              current:{" "}
              {value().current ? `${value().current!.providerID}/${value().current!.id}` : "none"}
            </span>
            <span>providers: {value().quota?.length ?? 0}</span>
            <span>approved models: {value().approvedModels?.length ?? 0}</span>
            <span>candidates in last decision: {value().lastDecision?.candidates?.length ?? 0}</span>
          </div>
        )}
      </Show>
    </div>
  )
}

const definition = Plugin.define({
  i18n: {
    en: {
      "command.open": "Open Smart Router panel",
      "panel.title": "Router",
    },
  },
})

export default Plugin.define({
  ...definition,
  setup(ctx) {
    ctx.add(Command, () => ({
      id: "panel",
      title: ctx.t("command.open"),
      group: "Smart Router",
      bind: "mod+shift+r",
      slash: { name: "router-gui" },
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.toggle(`${ctx.id}:router`, session)
      },
    }))

    ctx.add(Panel, {
      id: "router",
      region: "side",
      list: (input: { open: ReadonlyArray<string> }) => (input.open.includes("spike") ? [tab] : []),
      render: () => <SpikePanel />,
    })

    ctx.add(Slot, {
      at: "window.bottom",
      render: () => <span>Router</span>,
    })
  },
})
