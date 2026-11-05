import { Command, Panel, Plugin, Slot, usePlugin, type PanelTab, type PanelProps } from "@opencode/plugin/gui"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { SmartRouterRpc } from "../rpc.js"
import {
  formatPercent,
  formatUsd,
  formatWindowUsed,
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

      <AutoSwitch
        sessionID={props.sessionID}
        auto={(status()?.runtime ?? "automatic") === "automatic"}
        onChanged={() => void load()}
      />

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

      <Show when={providers().some((provider) => provider.source === "estimate")}>
        <AccountReading onChanged={() => void load()} />
      </Show>

      <div style={{ height: "1px", background: theme.border }} />

      <div style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
        <span style={{ color: theme.faint, "font-size": "11px", "text-transform": "uppercase", "letter-spacing": "0.04em" }}>
          Providers
        </span>
        <For each={providers()}>
          {(provider) => (
            <div
              style={{
                display: "flex",
                "flex-direction": "column",
                gap: "7px",
                padding: "10px",
                "border-radius": "8px",
                background: theme.surface,
                border: `1px solid ${theme.border}`,
              }}
            >
              <div style={{ display: "flex", "justify-content": "space-between", gap: "8px", "align-items": "baseline" }}>
                <span style={{ color: provider.error ? theme.bad : theme.text, "font-weight": 550, "font-size": "12.5px" }}>
                  {provider.label}
                </span>
                <span
                  style={{
                    color: provider.exhausted ? theme.bad : provider.stale ? theme.warn : theme.faint,
                    "font-size": "10.5px",
                    "text-transform": "uppercase",
                    "letter-spacing": "0.03em",
                  }}
                >
                  {provider.exhausted ? `${provider.exhaustedWindow} exhausted` : provider.stale ? "stale" : provider.quotaState ?? provider.source}
                </span>
              </div>

              <For each={provider.windows}>
                {(window) => (
                  <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <span
                      style={{
                        color: theme.faint,
                        "font-size": "10.5px",
                        "min-width": "52px",
                        "font-variant-numeric": "tabular-nums",
                      }}
                    >
                      {window.label}
                    </span>
                    <div
                      style={{
                        flex: 1,
                        height: "4px",
                        "border-radius": "2px",
                        background: window.reported ? "rgba(255,255,255,0.10)" : "transparent",
                        overflow: "hidden",
                        position: "relative",
                      }}
                    >
                      <Show when={window.reported}>
                        <div
                          style={{
                            width: `${Math.min(100, Math.max(0, window.usedPct))}%`,
                            height: "100%",
                            background: window.exceeded
                              ? theme.bad
                              : window.usedPct >= 80
                                ? theme.warn
                                : theme.good,
                          }}
                        />
                      </Show>
                    </div>
                    <span
                      style={{
                        color: window.reported ? (window.exceeded ? theme.bad : theme.muted) : theme.faint,
                        "font-size": "10.5px",
                        "min-width": "74px",
                        "text-align": "right",
                        "font-variant-numeric": "tabular-nums",
                      }}
                    >
                      {formatWindowUsed(window)}
                      {window.resetLabel ? ` · ${window.resetLabel}` : ""}
                    </span>
                  </div>
                )}
              </For>

              <Show when={provider.pools.length > 0}>
                <div style={{ display: "flex", "flex-direction": "column", gap: "3px", "padding-top": "3px", "border-top": `1px solid ${theme.border}` }}>
                  <For each={provider.pools}>
                    {(pool) => (
                      <div style={{ display: "flex", "justify-content": "space-between", gap: "8px" }}>
                        <span style={{ color: theme.muted, "font-size": "10.5px" }}>{pool.label}</span>
                        <span style={{ color: theme.faint, "font-size": "10.5px", "font-variant-numeric": "tabular-nums" }}>
                          {formatUsd(pool.remainingUsd)} of {formatUsd(pool.monthlyUsd)}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={provider.caveat && provider.caveat.length > 0}>
                <span style={{ color: theme.warn, "font-size": "10.5px", "line-height": 1.45 }}>
                  {provider.caveat}
                </span>
              </Show>

              <div style={{ display: "flex", "justify-content": "space-between", gap: "8px" }}>
                <span style={{ color: theme.faint, "font-size": "10.5px" }}>{provider.sourceLabel}</span>
                <Show when={provider.extraCreditsUsd !== undefined && provider.extraCreditsUsd! > 0}>
                  <span style={{ color: theme.faint, "font-size": "10.5px" }}>
                    wallet {formatUsd(provider.extraCreditsUsd!)} · never auto-spent
                  </span>
                </Show>
              </div>

              <Show when={provider.error}>
                <span style={{ color: theme.bad, "font-size": "10.5px" }}>{provider.error}</span>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}


/**
 * The switch a user actually wants: is the router choosing the model, or am I?
 *
 * Deliberately a switch, not a "stop the router" button. Turning this off keeps
 * the panel, the quota readings and the decision history working — it stops the
 * model from being changed underneath you, which is the only thing most people
 * mean by "turn it off".
 */
function AutoSwitch(props: { sessionID: string | undefined; auto: boolean; onChanged: () => void }) {
  const ctx = usePlugin<typeof definition>()
  const [busy, setBusy] = createSignal(false)

  const toggle = async () => {
    if (!props.sessionID || busy()) return
    setBusy(true)
    try {
      await ctx.client.rpc(SmartRouterRpc).setSessionAuto({
        sessionID: props.sessionID,
        auto: !props.auto,
      })
      props.onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy() || !props.sessionID}
      aria-pressed={props.auto}
      title={
        props.auto
          ? "The router is choosing the model. Click to keep your current model."
          : "Your model is kept. Click to let the router choose again."
      }
      style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        gap: "10px",
        width: "100%",
        padding: "9px 10px",
        "border-radius": "8px",
        border: `1px solid ${theme.border}`,
        background: props.auto ? theme.surface : "transparent",
        color: theme.text,
        cursor: busy() ? "default" : "pointer",
        "font-size": "12px",
        "font-family": "inherit",
        "text-align": "left",
      }}
    >
      <span style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
        <span style={{ "font-weight": 550 }}>Automatic routing</span>
        <span style={{ color: theme.faint, "font-size": "10.5px" }}>
          {props.auto ? "The router picks the model for you" : "You keep your model; the router only observes"}
        </span>
      </span>
      <span
        style={{
          width: "30px",
          height: "16px",
          "border-radius": "8px",
          background: props.auto ? theme.good : "rgba(255,255,255,0.14)",
          position: "relative",
          "flex-shrink": 0,
          transition: "background 120ms ease",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "2px",
            left: props.auto ? "16px" : "2px",
            width: "12px",
            height: "12px",
            "border-radius": "50%",
            background: "#fff",
            transition: "left 120ms ease",
          }}
        />
      </span>
    </button>
  )
}

/**
 * Record what the account page shows, as a form.
 *
 * The percentage is accepted exactly as the page writes it and converted on the
 * server, because the user should not have to know that Pro's seven-day window
 * is $90. The helper text says what the number buys, so this reads as a feature
 * rather than a chore.
 */
function AccountReading(props: { onChanged: () => void }) {
  const ctx = usePlugin<typeof definition>()
  const [reading, setReading] = createSignal("")
  const [resetsIn, setResetsIn] = createSignal("")
  const [pctOf, setPctOf] = createSignal<"weekly" | "monthly">("weekly")
  const [status, setStatus] = createSignal<{ ok: boolean; text: string } | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)

  const submit = async () => {
    if (!reading().trim() || busy()) return
    setBusy(true)
    try {
      const result: any = await ctx.client.rpc(SmartRouterRpc).recordAccountReading({
        reading: reading().trim(),
        ...(resetsIn().trim() ? { resetsIn: resetsIn().trim() } : {}),
        pctOf: pctOf(),
      })
      setStatus({
        ok: result?.ok !== false,
        text: result?.message ?? (result?.ok === false ? "Could not record that reading." : "Recorded."),
      })
      if (result?.ok !== false) {
        setReading("")
        setResetsIn("")
        props.onChanged()
      }
    } catch (cause) {
      setStatus({ ok: false, text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "7px" }}>
      <span style={{ color: theme.faint, "font-size": "11px", "text-transform": "uppercase", "letter-spacing": "0.04em" }}>
        Account reading
      </span>
      <span style={{ color: theme.muted, "font-size": "11px", "line-height": "1.45" }}>
        OpenDesign does not expose usage to an API key, so the router can only count what it routed
        itself. Paste the figure from your account page and it will count the rest of your account too.
      </span>

      <div style={{ display: "flex", gap: "6px" }}>
        <input
          value={reading()}
          onInput={(event) => setReading((event.currentTarget as HTMLInputElement).value)}
          placeholder="42%"
          aria-label="Usage from your account page"
          style={{
            flex: 1,
            padding: "7px 9px",
            "border-radius": "7px",
            border: `1px solid ${theme.border}`,
            background: "transparent",
            color: theme.text,
            "font-size": "12px",
            "font-family": "inherit",
          }}
        />
        <input
          value={resetsIn()}
          onInput={(event) => setResetsIn((event.currentTarget as HTMLInputElement).value)}
          placeholder="resets in 0d 23h"
          aria-label="Resets in, as shown on the page"
          style={{
            flex: 1,
            padding: "7px 9px",
            "border-radius": "7px",
            border: `1px solid ${theme.border}`,
            background: "transparent",
            color: theme.text,
            "font-size": "12px",
            "font-family": "inherit",
          }}
        />
      </div>

      <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
        <select
          value={pctOf()}
          onChange={(event) => setPctOf((event.currentTarget as HTMLSelectElement).value as "weekly" | "monthly")}
          aria-label="Which allowance the percentage refers to"
          style={{
            padding: "6px 8px",
            "border-radius": "7px",
            border: `1px solid ${theme.border}`,
            background: "transparent",
            color: theme.text,
            "font-size": "11px",
            "font-family": "inherit",
          }}
        >
          <option value="weekly">of the 7-day allowance</option>
          <option value="monthly">of the monthly allowance</option>
        </select>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy() || !reading().trim()}
          style={{
            "margin-left": "auto",
            padding: "6px 12px",
            "border-radius": "7px",
            border: `1px solid ${theme.border}`,
            background: reading().trim() ? theme.surface : "transparent",
            color: reading().trim() ? theme.text : theme.faint,
            "font-size": "11px",
            "font-family": "inherit",
            cursor: reading().trim() && !busy() ? "pointer" : "default",
          }}
        >
          {busy() ? "Saving…" : "Record"}
        </button>
      </div>

      <Show when={status()}>
        <span style={{ color: status()!.ok ? theme.good : theme.bad, "font-size": "10.5px", "line-height": 1.45 }}>
          {status()!.text}
        </span>
      </Show>
      <span style={{ color: theme.faint, "font-size": "10.5px", "line-height": 1.4 }}>
        A brand-new account reports 0% — enter that and the router stops guessing. A full account
        reports 100% and routing moves elsewhere until the window resets.
      </span>
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
