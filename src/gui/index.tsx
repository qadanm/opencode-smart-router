import { Command, Panel, Plugin, Slot, usePlugin, type PanelTab, type PanelProps } from "@opencode/plugin/gui"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { SmartRouterRpc } from "../rpc.js"
import {
  formatPercent,
  formatUsd,
  statusLine,
  summariseDecision,
  toProviderRow,
  type DecisionView,
  type ProviderRow,
} from "./viewmodel.js"

/**
 * P2 — the Decision Inspector.
 *
 * Everything shown here comes from the routing engine. The panel formats and
 * orders; it never invents a reason. A candidate the engine rejected keeps the
 * engine's sentence, because "why can't I use this model" is the question a user
 * asks most often and the one a prettier UI is most likely to fudge.
 *
 * Styling is deliberately local for now. P7 introduces the token set; keeping
 * one small object here makes that a mechanical swap rather than a rewrite.
 */

const theme = {
  bg: "transparent",
  text: "var(--text-primary, #e6e6eb)",
  muted: "var(--text-secondary, #9a9aa6)",
  faint: "var(--text-tertiary, #6f6f7c)",
  border: "var(--border-subtle, rgba(255,255,255,0.10))",
  surface: "var(--surface-raised, rgba(255,255,255,0.04))",
  good: "var(--text-success, #7ad19a)",
  warn: "var(--text-warning, #e0b463)",
  bad: "var(--text-danger, #e08a8a)",
}

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace"

const tab: PanelTab = {
  id: "router",
  get title() {
    return "Router"
  },
  closable: "hover",
}

interface RouterStatus {
  mode?: string
  runtime?: string
  current?: { providerID: string; id: string }
  quota?: ReadonlyArray<unknown>
  lastDecision?: unknown
  approvedModels?: ReadonlyArray<unknown>
}

const relative = (at: number): string => {
  const delta = Date.now() - at
  if (delta < 5_000) return "just now"
  if (delta < 60_000) return `${Math.round(delta / 1_000)}s ago`
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`
  return `${Math.round(delta / 3_600_000)}h ago`
}

const Row = (props: { label: string; children: unknown }) => (
  <div style={{ display: "flex", gap: "8px", "align-items": "baseline" }}>
    <span style={{ color: theme.faint, "min-width": "92px", "font-size": "11px" }}>{props.label}</span>
    <span style={{ color: theme.text, "font-size": "12px" }}>{props.children as never}</span>
  </div>
)

const Verdict = (props: { verdict: string }) => {
  const colour = props.verdict === "chosen" ? theme.good : props.verdict === "eligible" ? theme.muted : theme.bad
  return <span style={{ color: colour, "font-size": "11px", "font-weight": 500 }}>{props.verdict}</span>
}

function DecisionInspector(props: { sessionID: string | undefined }) {
  const ctx = usePlugin<typeof definition>()
  const [status, setStatus] = createSignal<RouterStatus | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [at, setAt] = createSignal<number | undefined>(undefined)

  const load = async () => {
    const sessionID = props.sessionID
    if (!sessionID) return
    try {
      const result = (await ctx.client.rpc(SmartRouterRpc).status({ sessionID })) as RouterStatus
      setStatus(result)
      setAt(Date.now())
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  onMount(() => {
    void load()
    const timer = setInterval(() => void load(), 3_000)
    onCleanup(() => clearInterval(timer))
  })

  const view = (): DecisionView | undefined => summariseDecision(status()?.lastDecision as never)
  const providers = (): ProviderRow[] =>
    ((status()?.quota ?? []) as never[]).map((snapshot) => toProviderRow(snapshot))

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "14px",
        padding: "14px",
        color: theme.text,
        "font-size": "12px",
        height: "100%",
        "overflow-y": "auto",
        background: theme.bg,
      }}
    >
      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "baseline" }}>
        <span style={{ "font-weight": 600, "font-size": "13px" }}>Smart Router</span>
        <span style={{ color: theme.faint, "font-size": "11px" }}>
          {at() ? relative(at()!) : "connecting…"}
        </span>
      </div>

      <Row label="state">{statusLine(status() ?? {})}</Row>

      <Show when={error()}>
        <div style={{ color: theme.bad, "font-size": "11px" }}>RPC unavailable: {error()}</div>
      </Show>

      <div style={{ height: "1px", background: theme.border }} />

      <Show
        when={view()}
        fallback={
          <div style={{ color: theme.muted, "font-size": "12px", "line-height": 1.5 }}>
            No decision yet in this session. Send a prompt and the router will explain what it chose and
            why.
          </div>
        }
      >
        {(decision) => (
          <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
            <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
              <span style={{ color: theme.faint, "font-size": "11px", "text-transform": "uppercase" }}>
                Chosen
              </span>
              <span style={{ "font-family": mono, "font-size": "12px", color: theme.good }}>
                {decision().chosen ?? "nothing eligible"}
              </span>
              <div style={{ display: "flex", gap: "12px", "flex-wrap": "wrap" }}>
                <span style={{ color: theme.muted }}>
                  {formatUsd(decision().estimatedUsd)} estimated
                </span>
                <span style={{ color: theme.muted }}>
                  task {decision().taskKind} · tier {decision().taskTier}
                </span>
                <span style={{ color: theme.muted }}>
                  {Math.round(decision().contextTokens / 1000)}k context
                </span>
              </div>
            </div>

            <Show when={decision().reasons.length > 0}>
              <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                <span style={{ color: theme.faint, "font-size": "11px", "text-transform": "uppercase" }}>
                  Why
                </span>
                <For each={decision().reasons}>
                  {(reason) => (
                    <div style={{ display: "flex", gap: "6px", color: theme.text, "line-height": 1.45 }}>
                      <span style={{ color: theme.faint }}>•</span>
                      <span>{reason}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
              <div style={{ display: "flex", "justify-content": "space-between" }}>
                <span style={{ color: theme.faint, "font-size": "11px", "text-transform": "uppercase" }}>
                  Candidates
                </span>
                <span style={{ color: theme.faint, "font-size": "11px" }}>
                  {decision().eligibleCount} eligible · {decision().blockedCount} blocked
                </span>
              </div>

              <div style={{ display: "flex", "flex-direction": "column" }}>
                <For each={decision().rows}>
                  {(row) => (
                    <div
                      style={{
                        display: "flex",
                        "flex-direction": "column",
                        gap: "2px",
                        padding: "7px 8px",
                        "border-bottom": `1px solid ${theme.border}`,
                        background: row.verdict === "chosen" ? theme.surface : "transparent",
                      }}
                    >
                      <div style={{ display: "flex", "justify-content": "space-between", gap: "8px" }}>
                        <span
                          style={{
                            "font-family": mono,
                            "font-size": "11px",
                            color: row.verdict === "blocked" ? theme.muted : theme.text,
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                        >
                          {row.key}
                        </span>
                        <span style={{ display: "flex", gap: "10px", "flex-shrink": 0 }}>
                          <span style={{ color: theme.muted, "font-size": "11px" }}>
                            {formatUsd(row.effectiveCost)}
                          </span>
                          <span style={{ color: theme.muted, "font-size": "11px" }}>
                            {formatPercent(row.successProbability * 100)}
                          </span>
                          <Verdict verdict={row.verdict} />
                        </span>
                      </div>
                      <span style={{ color: theme.faint, "font-size": "11px", "line-height": 1.4 }}>
                        {row.reason}
                        {row.adjustments.length > 0 ? ` · ${row.adjustments.join(" · ")}` : ""}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>
        )}
      </Show>

      <div style={{ height: "1px", background: theme.border }} />

      <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
        <span style={{ color: theme.faint, "font-size": "11px", "text-transform": "uppercase" }}>
          Providers
        </span>
        <For each={providers()}>
          {(provider) => (
            <div style={{ display: "flex", "flex-direction": "column", gap: "3px" }}>
              <div style={{ display: "flex", "justify-content": "space-between", gap: "8px" }}>
                <span style={{ color: provider.error ? theme.bad : theme.text }}>{provider.label}</span>
                <span style={{ color: theme.muted, "font-size": "11px" }}>
                  {provider.exhausted ? "exhausted" : formatPercent(provider.monthlyUsedPct) + " monthly"}
                </span>
              </div>
              <span style={{ color: theme.faint, "font-size": "11px" }}>
                {provider.sourceLabel}
                {provider.error ? ` · ${provider.error}` : ""}
              </span>
            </div>
          )}
        </For>
      </div>
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

/**
 * The tab id and the id the command toggles must be the same string:
 * `ctx.layout.toggle()` keys on `${plugin}:${tab id}` and `list()` receives the
 * stored *tab* ids. They disagreed once and the side region opened empty.
 */
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
      list: (input) => (input.open.includes("router") ? [tab] : []),
      render: (props: PanelProps) => <DecisionInspector sessionID={props.session.id} />,
    })

    ctx.add(Slot, {
      at: "window.bottom",
      render: () => <span style={{ "font-size": "11px", color: theme.faint }}>Router</span>,
    })
  },
})
