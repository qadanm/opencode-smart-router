import { Plugin } from "@opencode/plugin/tui"
import { SmartRouterRpc } from "../rpc.js"
import type { DecisionView, ProviderRow } from "../gui/viewmodel.js"

/**
 * The terminal side of the router.
 *
 * Same view-model as the desktop panel, different renderer. The `main` command
 * opens a decision inspector as a dialog; the footer slot shows the current state
 * at a glance. Nothing here reimplements routing logic — it formats the same
 * pure functions the panel uses, which is what keeps the two from disagreeing.
 *
 * Deliberately not a dashboard. A terminal user wants "what is it doing" and
 * "why", answerable without leaving the prompt.
 */

interface RouterStatus {
  mode?: string
  runtime?: string
  current?: { providerID: string; id: string }
  quota?: ReadonlyArray<unknown>
  lastDecision?: unknown
}

const tick = (ok: boolean) => (ok ? "✓" : "·")

/** A compact decision report, sized for a dialog rather than a panel. */
export const formatDecision = (status: RouterStatus | undefined, view: DecisionView | undefined): string => {
  if (!status) return "Smart Router: no response from the router."
  const head = `${status.runtime ?? "unknown"} · ${status.mode ?? "unknown"} · ${
    status.current ? `${status.current.providerID}/${status.current.id}` : "no model yet"
  }`
  if (!view) return `${head}\n\nNo decision yet in this session.`

  const lines = [head, "", `Chosen  ${view.chosen ?? "nothing eligible"}`]
  lines.push(
    `        ${view.taskKind} · tier ${view.taskTier} · ${Math.round(view.contextTokens / 1000)}k context`,
  )
  if (view.reasons.length > 0) {
    lines.push("", "Why")
    for (const reason of view.reasons.slice(0, 5)) lines.push(`  • ${reason}`)
  }
  if (view.rows.length > 0) {
    lines.push("", `Candidates (${view.eligibleCount} eligible, ${view.blockedCount} blocked)`)
    for (const row of view.rows.slice(0, 10)) {
      lines.push(`  ${tick(row.verdict !== "blocked")} ${row.key}`)
      lines.push(`      ${row.reason}`)
    }
  }
  if (view.warnings.length > 0) {
    lines.push("", "Warnings")
    for (const warning of view.warnings.slice(0, 3)) lines.push(`  ! ${warning}`)
  }
  return lines.join("\n")
}

/** Providers, one line each, with the tightest window that binds. */
export const formatProviders = (providers: ReadonlyArray<ProviderRow>): string => {
  if (providers.length === 0) return "No providers reported."
  const lines: string[] = []
  for (const provider of providers) {
    const windows = provider.windows
      .filter((window) => window.reported)
      .map((window) => `${window.label} ${window.lowerBound ? "≥" : ""}${window.usedPct}%`)
    lines.push(`${provider.label}${provider.exhausted ? " (exhausted)" : ""}`)
    lines.push(`  ${windows.length > 0 ? windows.join(" · ") : "no windows reported"} · ${provider.sourceLabel}`)
    if (provider.caveat) lines.push(`  ! ${provider.caveat}`)
  }
  return lines.join("\n")
}

export default Plugin.define({
  /**
   * Deliberately NOT nested under the server part's id.
   *
   * The GUI docs are explicit: if a plugin's id has another id nested under it,
   * or nests under one, its GUI does not load. The TUI previously used
   * "opencode-smart-router.tui", which nests under the server part's
   * "opencode-smart-router" — so adding a TUI silently disabled the desktop
   * panel, with no error beyond a generic request failure.
   *
   * A sibling id avoids the namespace collision entirely.
   */
  id: "opencode-smart-router-tui",
  setup(context) {
    // Footer: the state a user wants without opening anything.
    const stop = context.data.on("session.execution.succeeded", () => {
      void refresh()
    })

    const refresh = async () => {
      try {
        const result: any = await context.client.rpc(SmartRouterRpc).status({})
        setFooter(`${result?.runtime ?? "?"} · ${result?.mode ?? "?"}`)
      } catch {
        setFooter("router unreachable")
      }
    }

    let setFooter = (_text: string) => {}
    context.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        const [text, set] = createTerminalSignal("router")
        setFooter = set
        void refresh()
        return <text>{text()}</text>
      },
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "router.decision",
          title: "Router: why this model",
          slash: { name: "router-why" },
          palette: true,
          run: async () => {
            try {
              const result: any = await context.client.rpc(SmartRouterRpc).status({})
              const { summariseDecision, toProviderRow } = await import("../gui/viewmodel.js")
              const body = formatDecision(result, summariseDecision(result?.lastDecision))
              await context.ui.dialog.alert({ title: "Smart Router", message: body })
            } catch (cause) {
              await context.ui.dialog.alert({
                title: "Smart Router",
                message: `Could not read router status: ${cause instanceof Error ? cause.message : String(cause)}`,
              })
            }
          },
        },
        {
          id: "router.providers",
          title: "Router: providers and allowances",
          slash: { name: "router-quota" },
          palette: true,
          run: async () => {
            try {
              const result: any = await context.client.rpc(SmartRouterRpc).status({})
              const { toProviderRow } = await import("../gui/viewmodel.js")
              const rows = ((result?.quota ?? []) as unknown[]).map((snapshot) => toProviderRow(snapshot as never))
              await context.ui.dialog.alert({ title: "Providers", message: formatProviders(rows) })
            } catch (cause) {
              await context.ui.dialog.alert({
                title: "Providers",
                message: `Could not read provider status: ${cause instanceof Error ? cause.message : String(cause)}`,
              })
            }
          },
        },
      ],
      bindings: ["router.decision", "router.providers"],
    }))

    return () => stop()
  },
})

/** A minimal reactive cell, so this file needs no Solid runtime. */
function createTerminalSignal(initial: string): [() => string, (next: string) => void] {
  let value = initial
  const listeners = new Set<(next: string) => void>()
  return [() => value, (next: string) => {
    value = next
    for (const listener of listeners) listener(next)
  }]
}
