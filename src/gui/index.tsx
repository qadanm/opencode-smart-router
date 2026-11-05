import { Command, Panel, Plugin, Slot, usePlugin, type PanelTab, type PanelProps } from "@opencode/plugin/gui"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { SmartRouterRpc } from "../rpc.js"
import {
  formatPercent,
  formatUsd,
  formatWindowUsed,
  providerGroups,
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
  models?: Parameters<typeof providerGroups>[0]["models"]
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

      <ProviderModels status={status()} />

      <div style={{ height: "1px", background: theme.border }} />

      <Show when={providers().some((provider) => provider.source === "estimate")}>
        <PlanPagePaste onChanged={() => void load()} />
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
 * Paste the Plan & balance page. Once.
 *
 * Earlier versions asked for a percentage, a window and a reset time as three
 * separate fields. That is asking the user to do the parsing, and to know which
 * of two allowances the page's percentage refers to — the exact arithmetic
 * mistake this feature exists to prevent.
 *
 * So: one box, paste, see what the router understood, confirm. The preview is
 * not decoration. The user pasted a page and is entitled to see what it was
 * taken to mean before anything is written.
 */
function PlanPagePaste(props: { onChanged: () => void }) {
  const ctx = usePlugin<typeof definition>()
  const [page, setPage] = createSignal("")
  const [preview, setPreview] = createSignal<any | undefined>(undefined)
  const [status, setStatus] = createSignal<{ ok: boolean; text: string } | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)

  const reset = () => {
    setPage("")
    setPreview(undefined)
  }

  const read = async (confirm: boolean) => {
    if (!page().trim() || busy()) return
    setBusy(true)
    try {
      const result: any = await ctx.client.rpc(SmartRouterRpc).recordPlanPage({
        page: page(),
        confirm,
      })
      setStatus({ ok: result?.ok !== false, text: result?.message ?? "" })
      if (result?.ok && !confirm) {
        setPreview(result.preview)
      } else if (result?.ok && confirm) {
        reset()
        props.onChanged()
      }
    } catch (cause) {
      setStatus({ ok: false, text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
      <span style={{ color: theme.faint, "font-size": "11px", "text-transform": "uppercase", "letter-spacing": "0.04em" }}>
        Account balance
      </span>
      <span style={{ color: theme.muted, "font-size": "11px", "line-height": "1.45" }}>
        OpenDesign does not expose usage to an API key, so the router can only see what it routed
        itself. Paste <strong style={{ color: theme.text }}>either</strong> console page and it works
        out which one it got. <em>Plan &amp; balance</em> seeds your real usage; <em>Usage</em> checks
        whether the router's cost model matches what you were charged.
      </span>

      <textarea
        value={page()}
        onInput={(event) => {
          setPage((event.currentTarget as HTMLTextAreaElement).value)
          setPreview(undefined)
        }}
        placeholder={"Paste Plan & balance or Usage — navigation and all is fine."}
        aria-label="Paste your Plan and balance page"
        rows={3}
        style={{
          width: "100%",
          resize: "vertical",
          padding: "8px 9px",
          "border-radius": "7px",
          border: `1px solid ${theme.border}`,
          background: "transparent",
          color: theme.text,
          "font-size": "11px",
          "font-family": "inherit",
          "line-height": 1.45,
          "box-sizing": "border-box",
        }}
      />

      <Show when={preview()}>
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "4px",
            padding: "8px 9px",
            "border-radius": "7px",
            border: `1px solid ${theme.border}`,
            background: theme.surface,
          }}
        >
          <span style={{ color: theme.text, "font-size": "11.5px", "line-height": 1.45 }}>
            {preview().summary}
          </span>
          <Show when={preview().missing?.length > 0}>
            <span style={{ color: theme.warn, "font-size": "10.5px" }}>
              Not on the page: {preview().missing.join(", ")}
            </span>
          </Show>

          <Show when={preview().reconciliation}>
            <span
              style={{
                color: preview().reconciliation.differ > 0 ? theme.warn : theme.good,
                "font-size": "10.5px",
                "line-height": 1.45,
              }}
            >
              {preview().reconciliation.summary}
            </span>
            <For each={preview().reconciliation.rows.filter((row: any) => row.verdict === "differs")}>
              {(row: any) => (
                <span style={{ color: theme.faint, "font-size": "10.5px" }}>
                  {row.modelName}: charged {row.chargedUsd.toFixed(2)}, implied{" "}
                  {row.impliedMultiplier?.toFixed(2)}x vs catalog {row.catalogMultiplier?.toFixed(2)}x
                </span>
              )}
            </For>
          </Show>
        </div>
      </Show>

      <div style={{ display: "flex", gap: "6px" }}>
        <Show
          when={preview()}
          fallback={
            <button
              type="button"
              onClick={() => void read(false)}
              disabled={busy() || !page().trim()}
              style={buttonStyle(Boolean(page().trim()) && !busy())}
            >
              {busy() ? "Reading…" : "Read page"}
            </button>
          }
        >
          {/* A usage page is evidence about the catalog, not a reading of the
              allowance, so there is nothing to apply. Offering "Use this"
              would imply otherwise. */}
          <Show when={preview().kind === "allowance"}>
            <button type="button" onClick={() => void read(true)} disabled={busy()} style={buttonStyle(!busy())}>
              {busy() ? "Saving…" : "Use this"}
            </button>
          </Show>
          <button type="button" onClick={reset} disabled={busy()} style={buttonStyle(false)}>
            {preview().kind === "usage" ? "Done" : "Cancel"}
          </button>
        </Show>
      </div>

      <Show when={status()}>
        <span style={{ color: status()!.ok ? theme.good : theme.bad, "font-size": "10.5px", "line-height": 1.45 }}>
          {status()!.text}
        </span>
      </Show>
      <span style={{ color: theme.faint, "font-size": "10.5px", "line-height": 1.4 }}>
        A new account reads 0%. A spent one reads 100%, and routing leaves the provider until the
        window resets.
      </span>
    </div>
  )
}

const buttonStyle = (enabled: boolean) => ({
  padding: "6px 12px",
  "border-radius": "7px",
  border: `1px solid ${theme.border}`,
  background: enabled ? theme.surface : "transparent",
  color: enabled ? theme.text : theme.faint,
  "font-size": "11px",
  "font-family": "inherit",
  cursor: enabled ? "pointer" : "default",
})


/**
 * Providers and their models.
 *
 * The question this answers is "why is that model not being used?", which has
 * three different answers that must not be collapsed into one: the provider has
 * no credential on this machine, the model is deliberately excluded, or the
 * model simply is not approved. "Unavailable" for all three is what makes people
 * think a model has gone missing.
 */
/**
 * A disclosure row: something you can open.
 *
 * The affordance is the hard part. A row that merely responds to a click is
 * invisible as a control — no border, no cursor change, no hover, nothing that
 * says "there is more behind this". So every toggle here gets all four: a
 * rotating caret, a hover fill, `cursor: pointer`, and `aria-expanded`. The
 * caret sits in a fixed-width box so the labels do not shift when it rotates,
 * which is the small detail that makes a list feel built rather than assembled.
 */
function Disclosure(props: {
  id: string
  open: boolean
  onToggle: () => void
  /** Left content. */
  children: unknown
  /** Right content, e.g. counts. */
  aside?: unknown
  subdued?: boolean
  hovered: boolean
  onHover: (id: string | undefined) => void
}) {
  return (
    <button
      type="button"
      onClick={props.onToggle}
      onMouseEnter={() => props.onHover(props.id)}
      onMouseLeave={() => props.onHover(undefined)}
      aria-expanded={props.open}
      title={props.open ? "Collapse" : "Expand"}
      style={{
        display: "flex",
        "justify-content": "space-between",
        "align-items": "center",
        gap: "8px",
        width: "100%",
        background: props.hovered ? theme.surface : "transparent",
        border: "none",
        "border-radius": "6px",
        padding: "6px 6px",
        margin: "-6px -6px",
        color: "inherit",
        font: "inherit",
        cursor: "pointer",
        "text-align": "left",
        transition: "background 100ms ease",
      }}
    >
      <span style={{ display: "flex", gap: "7px", "align-items": "center", "min-width": 0 }}>
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: "9px",
            color: props.hovered ? theme.text : theme.faint,
            "font-size": "10px",
            "flex-shrink": 0,
            transform: props.open ? "rotate(90deg)" : "none",
            transition: "transform 120ms ease",
          }}
        >
          ▸
        </span>
        {props.children as never}
      </span>
      <span style={{ display: "flex", gap: "8px", "align-items": "baseline", "flex-shrink": 0 }}>
        {props.aside as never}
      </span>
    </button>
  )
}

function ProviderModels(props: { status: RouterStatus | undefined }) {
  /**
   * What is open, and why.
   *
   * The providers that can serve a request right now are expanded, because they
   * are the answer to the question the panel exists to answer. Providers with no
   * credential are collapsed, because they are reference material until somebody
   * configures them.
   *
   * The signal tracks *collapsed* ids rather than expanded ones so that the
   * default is "open" without needing to know the provider list, which arrives
   * asynchronously and would otherwise leave everything closed on first paint.
   */
  const [collapsedActive, setCollapsedActive] = createSignal<ReadonlyArray<string>>([])
  const [expandedInactive, setExpandedInactive] = createSignal<ReadonlyArray<string>>([])
  const [sectionOpen, setSectionOpen] = createSignal(true)
  const [notConfiguredOpen, setNotConfiguredOpen] = createSignal(false)
  const [hovered, setHovered] = createSignal<string | undefined>(undefined)

  const groups = () => {
    const status = props.status
    if (!status?.models) return []
    const active = ((status.quota ?? []) as Array<{ providerID?: string; error?: string }>)
      .filter((snapshot) => !snapshot.error)
      .map((snapshot) => snapshot.providerID ?? "")
    return providerGroups({
      models: status.models,
      quota: (status.quota ?? []) as Array<{ providerID: string; label?: string }>,
      activeProviders: active,
    })
  }

  /**
   * How many models to show per provider before asking.
   *
   * Five is enough to see what will be chosen and what it costs; the rest is
   * reference. The full list is one click away.
   */
  const PREVIEW_MODELS = 5
  const [expandedAll, setExpandedAll] = createSignal<ReadonlyArray<string>>([])

  const approvedModelsOf = (group: ReturnType<typeof groups>[number]) =>
    group.models.filter((model) => model.state === "approved")
  const unapprovedCount = (group: ReturnType<typeof groups>[number]) =>
    group.models.length - approvedModelsOf(group).length

  const visibleModels = (group: ReturnType<typeof groups>[number]) => {
    const approved = approvedModelsOf(group)
    if (expandedAll().includes(group.providerID)) return approved
    return approved.slice(0, PREVIEW_MODELS)
  }

  const hiddenCount = (group: ReturnType<typeof groups>[number]) =>
    approvedModelsOf(group).length - visibleModels(group).length

  const toggleAll = (providerID: string) =>
    setExpandedAll((current) =>
      current.includes(providerID) ? current.filter((id) => id !== providerID) : [...current, providerID],
    )

  const activeGroups = () => groups().filter((group) => group.state === "active")
  const inactiveGroups = () => groups().filter((group) => group.state !== "active")

  const ProviderCard = (cardProps: { group: ReturnType<typeof groups>[number]; defaultOpen: boolean }) => {
    const id = cardProps.group.providerID
    const isOpen = () =>
      cardProps.defaultOpen ? !collapsedActive().includes(id) : expandedInactive().includes(id)
    const toggle = () =>
      cardProps.defaultOpen
        ? setCollapsedActive((current) =>
            current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
          )
        : setExpandedInactive((current) =>
            current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
          )

    return (
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          gap: "6px",
          padding: "9px 10px",
          "border-radius": "8px",
          border: `1px solid ${theme.border}`,
          background: cardProps.defaultOpen ? theme.surface : "transparent",
        }}
      >
        <Disclosure
          id={id}
          open={isOpen()}
          onToggle={toggle}
          hovered={hovered() === id}
          onHover={setHovered}
          aside={
            <>
              <span style={{ color: theme.faint, "font-size": "10.5px" }}>
                {cardProps.group.approvedCount} of {cardProps.group.totalCount} approved
              </span>
              <span
                style={{
                  color: cardProps.defaultOpen ? theme.good : theme.faint,
                  "font-size": "10px",
                  "text-transform": "uppercase",
                  "letter-spacing": "0.04em",
                  "font-weight": 600,
                }}
              >
                {cardProps.defaultOpen ? "active" : "not configured"}
              </span>
            </>
          }
        >
          <span style={{ "font-size": "12.5px", "font-weight": 550, color: theme.text }}>
            {cardProps.group.label}
          </span>
        </Disclosure>

        <Show when={cardProps.group.note}>
          <span style={{ color: theme.warn, "font-size": "10.5px", "line-height": 1.45 }}>
            {cardProps.group.note}
          </span>
        </Show>

        <Show when={isOpen()}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "3px", "margin-top": "2px" }}>
            {/* Approved models only, and only the cheapest few of them.
                The question this panel answers is "what can route right now",
                not "what does the catalog contain". A provider with 39 entries
                buried the decision, the allowances and the settings under a
                scroll of model names nobody reads. */}
            <For each={visibleModels(cardProps.group)}>
              {(model) => (
                <div style={{ display: "flex", "justify-content": "space-between", gap: "8px", "align-items": "baseline" }}>
                  <span
                    style={{
                      "font-family": mono,
                      "font-size": "10.5px",
                      color: theme.text,
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      "white-space": "nowrap",
                    }}
                  >
                    {model.key.split("/").slice(1).join("/")}
                  </span>
                  <span style={{ display: "flex", gap: "8px", "flex-shrink": 0, "align-items": "baseline" }}>
                    <span style={{ color: theme.faint, "font-size": "10.5px" }}>{model.contextLabel}</span>
                    <span style={{ color: theme.faint, "font-size": "10.5px" }}>{model.costLabel}</span>
                  </span>
                </div>
              )}
            </For>

            <Show when={hiddenCount(cardProps.group) > 0}>
              <button
                type="button"
                onClick={() => toggleAll(id)}
                onMouseEnter={() => setHovered(`all:${id}`)}
                onMouseLeave={() => setHovered(undefined)}
                style={{
                  background: hovered() === `all:${id}` ? theme.surface : "transparent",
                  border: "none",
                  "border-radius": "5px",
                  padding: "3px 6px",
                  margin: "1px -6px -2px",
                  color: theme.muted,
                  font: "inherit",
                  "font-size": "10.5px",
                  cursor: "pointer",
                  "text-align": "left",
                }}
              >
                {expandedAll().includes(id)
                  ? "Show fewer"
                  : `${hiddenCount(cardProps.group)} more${unapprovedCount(cardProps.group) > 0 ? ` · ${unapprovedCount(cardProps.group)} not routable` : ""}`}
              </button>
            </Show>
          </div>
        </Show>
      </div>
    )
  }

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
      <Disclosure
        id="section"
        open={sectionOpen()}
        onToggle={() => setSectionOpen((open) => !open)}
        hovered={hovered() === "section"}
        onHover={setHovered}
        aside={
          <span style={{ color: theme.faint, "font-size": "10.5px" }}>
            {activeGroups().length} active
            {inactiveGroups().length > 0 ? ` · ${inactiveGroups().length} not configured` : ""}
          </span>
        }
      >
        <span
          style={{
            color: theme.faint,
            "font-size": "11px",
            "text-transform": "uppercase",
            "letter-spacing": "0.04em",
          }}
        >
          Providers &amp; models
        </span>
      </Disclosure>

      <Show when={sectionOpen()}>
        <For each={activeGroups()}>
          {(group) => <ProviderCard group={group} defaultOpen={true} />}
        </For>

        {/* Providers with nothing to route to are their own section: not part of
            the current picture, but hiding them is how a user never discovers
            the router supports a service they already pay for. */}
        <Show when={inactiveGroups().length > 0}>
          <div
            style={{
              display: "flex",
              "flex-direction": "column",
              gap: "6px",
              "padding-top": "2px",
              "border-top": `1px solid ${theme.border}`,
            }}
          >
            <Disclosure
              id="not-configured"
              open={notConfiguredOpen()}
              onToggle={() => setNotConfiguredOpen((open) => !open)}
              hovered={hovered() === "not-configured"}
              onHover={setHovered}
              aside={
                <span style={{ color: theme.faint, "font-size": "10.5px" }}>
                  {inactiveGroups().length}
                </span>
              }
            >
              <span style={{ color: theme.muted, "font-size": "11.5px" }}>
                Not configured
              </span>
            </Disclosure>

            <Show when={notConfiguredOpen()}>
              <For each={inactiveGroups()}>
                {(group) => <ProviderCard group={group} defaultOpen={false} />}
              </For>
            </Show>
          </div>
        </Show>
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
