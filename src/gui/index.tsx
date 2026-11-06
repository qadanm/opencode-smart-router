import { Command, Panel, Plugin, Slot, usePlugin, type PanelTab, type PanelProps } from "@opencode/plugin/gui"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { SmartRouterRpc } from "../rpc.js"
import { createSidebar } from "./sidebar-controller.js"

/**
 * One controller per window. Created at module scope so both the panel toggle and
 * the plugin setup address the same instance.
 */
const sidebarFeature = createSidebar()
import {
  formatPercent,
  formatUsd,
  formatWindowUsed,
  providerGroups,
  statusLine,
  summariseDecision,
  toProviderRow,
  type DecisionView,
  type ProviderGroupView,
  type ProviderRow,
} from "./viewmodel.js"

/**
 * The Smart Router panel.
 *
 * Design intent: this should read as one product, not a debug dump with a title.
 * Three rules hold it together.
 *
 *   1. **One scale.** Every size comes from `type`, every gap from `space`. The
 *      previous version used seven font sizes chosen ad hoc, which is what makes
 *      an interface look assembled rather than designed.
 *   2. **Hierarchy by weight and space, not by lines.** Four full-width dividers
 *      with equal weight said "here are five unrelated things". Sections now
 *      carry their own label and use whitespace to separate.
 *   3. **The brand earns its place.** The mark and its teal-to-cyan gradient are
 *      the same assets shipped in `assets/`. An accent used once, on the thing
 *      that matters, reads as deliberate; used everywhere it reads as decoration.
 */

/**
 * Type scale.
 *
 * Sized against published guidance rather than taste. Body text is 14px and
 * secondary text 13px, which is the floor for comfortable reading on a desktop;
 * the previous scale ran 9.5–13px and was a caption scale applied to prose. That
 * is the single most common accessibility failure in dense interfaces, and it
 * reads as miniature rather than compact.
 *
 * `label` exists for uppercase section headings only. Uppercase with letter
 * spacing survives at 11px in a way lowercase prose does not, so it gets its own
 * step instead of being borrowed for body copy.
 *
 * Inputs are 14px to match body: the iOS zoom-on-focus behaviour starts below
 * 16px, and 16px looks oversized inside a side panel, so 14 is the compromise
 * that stays readable without zoom.
 */
const type = {
  label: "11px",
  caption: "13px",
  body: "14px",
  title: "16px",
  display: "20px",
} as const

const space = { xxs: "2px", xs: "4px", sm: "6px", md: "8px", lg: "12px", xl: "16px" } as const
const radius = { sm: "6px", md: "8px", lg: "10px" } as const

const theme = {
  text: "var(--text-primary, #e8e8ec)",
  muted: "var(--text-secondary, #9a9aa6)",
  faint: "var(--text-tertiary, #6f6f7c)",
  border: "var(--border-subtle, rgba(255,255,255,0.09))",
  borderStrong: "var(--border-default, rgba(255,255,255,0.16))",
  surface: "var(--surface-raised, rgba(255,255,255,0.04))",
  raised: "var(--surface-overlay, rgba(255,255,255,0.07))",
  good: "var(--text-success, #7ad19a)",
  warn: "var(--text-warning, #e0b463)",
  bad: "var(--text-danger, #e08a8a)",
  /** Brand accents, taken from assets/logo.svg. */
  brand: "#0f766e",
  brandTo: "#0891b2",
} as const

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace"
const brandGradient = `linear-gradient(135deg, ${theme.brand} 0%, ${theme.brandTo} 100%)`

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** A labelled region. The label is the hierarchy; no rule line needed. */
function Section(props: {
  label: string
  aside?: unknown
  children: unknown
  first?: boolean
}) {
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: space.sm,
        ...(props.first ? {} : { "padding-top": space.lg, "border-top": `1px solid ${theme.border}` }),
      }}
    >
      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "baseline", gap: space.md }}>
        <span
          style={{
            color: theme.faint,
            "font-size": type.label,
            "text-transform": "uppercase",
            "letter-spacing": "0.06em",
            "font-weight": 600,
          }}
        >
          {props.label}
        </span>
        {props.aside as never}
      </div>
      {props.children as never}
    </div>
  )
}

/** A surface that groups related values. Used sparingly: too many cards is noise. */
function Card(props: { children: unknown; accent?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: space.sm,
        padding: "10px 11px",
        "border-radius": radius.md,
        border: `1px solid ${props.accent ? theme.borderStrong : theme.border}`,
        background: theme.surface,
      }}
    >
      {props.children as never}
    </div>
  )
}

/** A label above a value. Numbers are tabular so columns line up. */
function Stat(props: { label: string; value: unknown; tone?: "good" | "warn" | "bad" | "muted" }) {
  const colour =
    props.tone === "good"
      ? theme.good
      : props.tone === "warn"
        ? theme.warn
        : props.tone === "bad"
          ? theme.bad
          : theme.muted
  return (
    <span style={{ display: "flex", "flex-direction": "column", gap: "1px", "min-width": 0 }}>
      <span style={{ color: theme.faint, "font-size": type.label }}>{props.label}</span>
      <span style={{ color: colour, "font-size": type.body, "font-variant-numeric": "tabular-nums" }}>
        {props.value as never}
      </span>
    </span>
  )
}

/** A usage meter. Width is the value; colour is the urgency. */
function Meter(props: { usedPct: number; exhausted?: boolean }) {
  const width = Math.min(100, Math.max(0, props.usedPct))
  const colour = props.exhausted
    ? theme.bad
    : width >= 80
      ? theme.warn
      : width >= 50
        ? theme.brandTo
        : theme.good
  return (
    <div
      role="meter"
      aria-valuenow={Math.round(width)}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{
        flex: 1,
        height: "3px",
        "border-radius": "2px",
        background: "rgba(255,255,255,0.09)",
        overflow: "hidden",
        "min-width": "36px",
      }}
    >
      <div style={{ width: `${width}%`, height: "100%", background: colour, "border-radius": "2px" }} />
    </div>
  )
}

function Chip(props: { children: unknown; tone?: "good" | "warn" | "bad" | "neutral" | "brand" }) {
  const bg =
    props.tone === "good"
      ? "rgba(122,209,154,0.12)"
      : props.tone === "warn"
        ? "rgba(224,180,99,0.12)"
        : props.tone === "bad"
          ? "rgba(224,138,138,0.12)"
          : props.tone === "brand"
            ? "rgba(8,145,178,0.16)"
            : "rgba(255,255,255,0.06)"
  const fg =
    props.tone === "good"
      ? theme.good
      : props.tone === "warn"
        ? theme.warn
        : props.tone === "bad"
          ? theme.bad
          : props.tone === "brand"
            ? theme.brandTo
            : theme.muted
  return (
    <span
      style={{
        background: bg,
        color: fg,
        "font-size": type.label,
        "font-weight": 600,
        "text-transform": "uppercase",
        "letter-spacing": "0.05em",
        padding: "2px 6px",
        "border-radius": "4px",
        "white-space": "nowrap",
      }}
    >
      {props.children as never}
    </span>
  )
}

/** Teaching empty state. Never a blank box: say what would fill it. */
function Empty(props: { title: string; body: string }) {
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "3px",
        padding: "12px 11px",
        "border-radius": radius.md,
        border: `1px dashed ${theme.border}`,
      }}
    >
      <span style={{ color: theme.muted, "font-size": type.body, "font-weight": 550 }}>{props.title}</span>
      <span style={{ color: theme.faint, "font-size": type.caption, "line-height": 1.5 }}>{props.body}</span>
    </div>
  )
}

/** A row that opens. Caret, hover, cursor and aria together — one alone is invisible. */
function Disclosure(props: {
  id: string
  open: boolean
  onToggle: () => void
  hovered: boolean
  onHover: (id: string | undefined) => void
  children: unknown
  aside?: unknown
  size?: "section" | "row"
}) {
  const section = props.size !== "row"
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
        gap: space.md,
        width: "100%",
        background: props.hovered ? theme.surface : "transparent",
        border: "none",
        "border-radius": radius.sm,
        padding: "5px 7px",
        margin: "-5px -7px",
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
            "font-size": "9px",
            "flex-shrink": 0,
            transform: props.open ? "rotate(90deg)" : "none",
            transition: "transform 120ms ease",
          }}
        >
          ▸
        </span>
        <span
          style={
            section
              ? {
                  color: theme.faint,
                  "font-size": type.label,
                  "text-transform": "uppercase",
                  "letter-spacing": "0.06em",
                  "font-weight": 600,
                }
              : { color: theme.text, "font-size": type.title, "font-weight": 550 }
          }
        >
          {props.children as never}
        </span>
      </span>
      <span style={{ display: "flex", gap: space.md, "align-items": "baseline", "flex-shrink": 0 }}>
        {props.aside as never}
      </span>
    </button>
  )
}

/** The brand mark, from assets/logo.svg: one input forking into three routes. */
function BrandMark(props: { size?: number }) {
  const size = props.size ?? 22
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 60 60"
      aria-hidden="true"
      style={{ "flex-shrink": 0, display: "block" }}
    >
      <defs>
        <linearGradient id="sr-brand" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color={theme.brand} />
          <stop offset="100%" stop-color={theme.brandTo} />
        </linearGradient>
      </defs>
      <g fill="none" stroke="url(#sr-brand)" stroke-width="4" stroke-linecap="round">
        <path d="M8 30h12" />
        <path d="M20 30c7 0 8-14 15-14h8" />
        <path d="M20 30c7 0 8 14 15 14h8" />
        <path d="M20 30h23" />
      </g>
      <circle cx="5" cy="30" r="4.5" fill="url(#sr-brand)" />
      <g fill="url(#sr-brand)">
        <rect x="45" y="10" width="9" height="9" rx="2.5" />
        <rect x="45" y="25.5" width="9" height="9" rx="2.5" />
        <rect x="45" y="41" width="9" height="9" rx="2.5" />
      </g>
    </svg>
  )
}

function BrandHeader(props: { runtime: string; mode: string }) {
  const tone = props.runtime === "paused" ? "warn" : props.runtime === "manual" ? "neutral" : "brand"
  return (
    <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", gap: space.md }}>
      <div style={{ display: "flex", gap: space.sm, "align-items": "center", "min-width": 0 }}>
        <BrandMark />
        <div style={{ display: "flex", "flex-direction": "column", gap: "0" }}>
          <span style={{ color: theme.text, "font-size": type.title, "font-weight": 650, "letter-spacing": "-0.2px" }}>
            Smart Router
          </span>
          <span style={{ color: theme.faint, "font-size": type.caption, "letter-spacing": "0.09em", "font-weight": 600 }}>
            FOR OPENCODE
          </span>
        </div>
      </div>
      <div style={{ display: "flex", gap: space.xs, "align-items": "center" }}>
        <Chip tone={tone}>{props.mode}</Chip>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Feature components
// ---------------------------------------------------------------------------

interface RouterStatus {
  mode?: string
  runtime?: string
  sidebarGroups?: boolean
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

/** Is the router choosing the model, or is the user? */
function AutoSwitch(props: { sessionID: string | undefined; auto: boolean; onChanged: () => void }) {
  const ctx = usePlugin<typeof definition>()
  const [busy, setBusy] = createSignal(false)
  const [hovered, setHovered] = createSignal(false)

  const toggle = async () => {
    if (!props.sessionID || busy()) return
    setBusy(true)
    try {
      await ctx.client.rpc(SmartRouterRpc).setSessionAuto({ sessionID: props.sessionID, auto: !props.auto })
      props.onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      disabled={busy() || !props.sessionID}
      aria-pressed={props.auto}
      title={props.auto ? "Click to keep your current model" : "Click to let the router choose"}
      style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        gap: space.md,
        width: "100%",
        padding: "9px 11px",
        "border-radius": radius.md,
        border: `1px solid ${props.auto ? "transparent" : theme.border}`,
        background: props.auto ? "rgba(8,145,178,0.10)" : hovered() ? theme.surface : "transparent",
        color: theme.text,
        cursor: busy() || !props.sessionID ? "default" : "pointer",
        font: "inherit",
        "text-align": "left",
        transition: "background 120ms ease",
      }}
    >
      <span style={{ display: "flex", "flex-direction": "column", gap: "1px" }}>
        <span style={{ "font-size": type.body, "font-weight": 600 }}>Automatic routing</span>
        <span style={{ color: props.auto ? theme.brandTo : theme.faint, "font-size": type.caption }}>
          {props.auto ? "The router picks the model for you" : "You keep your model; the router only observes"}
        </span>
      </span>
      <span
        aria-hidden="true"
        style={{
          width: "30px",
          height: "16px",
          "border-radius": "8px",
          background: props.auto ? brandGradient : "rgba(255,255,255,0.14)",
          position: "relative",
          "flex-shrink": 0,
          transition: "background 140ms ease",
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
            transition: "left 140ms ease",
          }}
        />
      </span>
    </button>
  )
}


/**
 * Sidebar grouping.
 *
 * Off by default and described as what it is: a nice extra. The desktop app has
 * no sidebar API, so this works on the app's markup; the description says so
 * once, in plain words, instead of hiding it.
 */
function SidebarToggle(props: {
  enabled: boolean
  active: boolean
  probe: { surface: string | null; rows: number; withProject: number }
  onChanged: () => void
}) {
  const ctx = usePlugin<typeof definition>()
  const [busy, setBusy] = createSignal(false)

  const toggle = async () => {
    if (busy()) return
    setBusy(true)
    try {
      await ctx.client.rpc(SmartRouterRpc).setSidebarGroups({ enabled: !props.enabled })
      props.onChanged()
    } finally {
      setBusy(false)
    }
  }

  /**
   * The old copy said "on" and did nothing when the app's markup did not match.
   * Reporting the probe keeps that honest: the panel names the layout it found,
   * the row count, and how many rows carried a project name.
   */
  const detail = () => {
    if (!props.enabled) return "Off. Turn on to group sessions by project in the sidebar."
    if (!props.active) return "On, but paused: another sidebar plugin owns this surface."
    const probe = props.probe
    if (!probe.surface) return "On. Waiting for a session sidebar to appear."
    if (probe.withProject === 0) return "On, but this sidebar shows no project names, so there is nothing to group."
    return `On. Grouping ${probe.withProject} sessions in the ${probe.surface} sidebar.`
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy()}
      aria-pressed={props.enabled}
      style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        gap: space.md,
        width: "100%",
        padding: "9px 11px",
        "border-radius": radius.md,
        border: `1px solid ${props.enabled ? "transparent" : theme.border}`,
        background: props.enabled ? "rgba(15,118,110,0.14)" : "transparent",
        color: theme.text,
        cursor: busy() ? "default" : "pointer",
        font: "inherit",
        "text-align": "left",
      }}
    >
      <span style={{ display: "flex", "flex-direction": "column", gap: "1px" }}>
        <span style={{ "font-size": type.body, "font-weight": 600 }}>Group sessions by project</span>
        <span style={{ color: props.enabled ? theme.brandTo : theme.faint, "font-size": type.caption }}>{detail()}</span>
      </span>
      <span
        aria-hidden="true"
        style={{
          width: "30px",
          height: "16px",
          "border-radius": "8px",
          background: props.enabled ? brandGradient : "rgba(255,255,255,0.14)",
          position: "relative",
          "flex-shrink": 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "2px",
            left: props.enabled ? "16px" : "2px",
            width: "12px",
            height: "12px",
            "border-radius": "50%",
            background: "#fff",
          }}
        />
      </span>
    </button>
  )
}

function DecisionInspector(props: { view: DecisionView | undefined; hovered: string | undefined; onHover: (id: string | undefined) => void; expanded: boolean; onToggle: () => void }) {
  return (
    <Section
      label="Last decision"
      aside={
        <Show when={props.view}>
          <span style={{ color: theme.faint, "font-size": type.caption }}>
            {props.view!.eligibleCount} eligible · {props.view!.blockedCount} blocked
          </span>
        </Show>
      }
    >
      <Show
        when={props.view}
        fallback={
          <Empty
            title="No decision yet"
            body="Send a prompt and the router will explain which model it chose, and why it beat the others."
          />
        }
      >
        <Card accent>
          <div style={{ display: "flex", "justify-content": "space-between", gap: space.md, "align-items": "baseline" }}>
            <span
              style={{
                "font-family": mono,
                "font-size": type.body,
                color: theme.text,
                "font-weight": 600,
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "white-space": "nowrap",
              }}
            >
              {props.view!.chosen ?? "nothing eligible"}
            </span>
            <Chip tone={props.view!.chosen ? "good" : "bad"}>{props.view!.chosen ? "chosen" : "blocked"}</Chip>
          </div>

          <div style={{ display: "flex", gap: space.xl, "flex-wrap": "wrap" }}>
            <Stat label="est. cost" value={formatUsd(props.view!.estimatedUsd)} />
            <Stat label="task" value={`${props.view!.taskKind} · T${props.view!.taskTier}`} />
            <Stat label="context" value={`${Math.round(props.view!.contextTokens / 1000)}k`} />
          </div>

          <Show when={props.view!.reasons.length > 0}>
            <div style={{ display: "flex", "flex-direction": "column", gap: "3px", "padding-top": space.xs }}>
              <span style={{ color: theme.faint, "font-size": type.caption, "text-transform": "uppercase", "letter-spacing": "0.05em" }}>
                Why
              </span>
              <For each={props.view!.reasons}>
                {(reason) => (
                  <div style={{ display: "flex", gap: space.sm, "align-items": "baseline" }}>
                    <span style={{ color: theme.brandTo, "font-size": type.caption, "line-height": "1.6" }}>›</span>
                    <span style={{ color: theme.muted, "font-size": type.caption, "line-height": 1.5 }}>{reason}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={props.view!.selfheal}>
            <div style={{ display: "flex", gap: space.sm, "align-items": "baseline", "padding-top": space.xs }}>
              <span style={{ color: theme.brandTo, "font-size": type.caption, "line-height": "1.6" }}>›</span>
              <span style={{ color: theme.text, "font-size": type.caption, "line-height": 1.5 }}>
                Self-healed: {props.view!.selfheal}
              </span>
            </div>
          </Show>
        </Card>

        <Show when={props.view!.rows.length > 0}>
          <Disclosure
            id="candidates"
            size="row"
            open={props.expanded}
            onToggle={props.onToggle}
            hovered={props.hovered === "candidates"}
            onHover={props.onHover}
            aside={
              <span style={{ color: theme.faint, "font-size": type.caption }}>
                {props.view!.rows.length} considered
              </span>
            }
          >
            <span style={{ "font-size": type.caption, "font-weight": 500, color: theme.muted }}>Candidates</span>
          </Disclosure>

          <Show when={props.expanded}>
            <div style={{ display: "flex", "flex-direction": "column", gap: "1px" }}>
              <For each={props.view!.rows}>
                {(row) => (
                  <div
                    style={{
                      display: "flex",
                      "flex-direction": "column",
                      gap: "2px",
                      padding: "6px 8px",
                      "border-radius": radius.sm,
                      background: row.verdict === "chosen" ? "rgba(8,145,178,0.08)" : "transparent",
                    }}
                  >
                    <div style={{ display: "flex", "justify-content": "space-between", gap: space.md, "align-items": "baseline" }}>
                      <span
                        style={{
                          "font-family": mono,
                          "font-size": type.caption,
                          color: row.verdict === "blocked" ? theme.faint : theme.text,
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}
                      >
                        {row.key}
                      </span>
                      <span style={{ display: "flex", gap: space.md, "flex-shrink": 0 }}>
                        <span style={{ color: theme.muted, "font-size": type.caption, "font-variant-numeric": "tabular-nums" }}>
                          {formatUsd(row.effectiveCost)}
                        </span>
                        <span style={{ color: theme.faint, "font-size": type.caption, "font-variant-numeric": "tabular-nums" }}>
                          {formatPercent(row.successProbability * 100)}
                        </span>
                      </span>
                    </div>
                    <span style={{ color: theme.faint, "font-size": type.caption, "line-height": 1.45 }}>
                      {row.reason}
                      {row.adjustments.length > 0 ? ` · ${row.adjustments.join(" · ")}` : ""}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </Section>
  )
}

/** Providers, not their catalogs. See the note in providerGroups(). */
function ProviderList(props: { status: RouterStatus | undefined }) {
  const [open, setOpen] = createSignal(true)
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

  const activeGroups = () => groups().filter((group) => group.state === "active")
  const inactiveGroups = () => groups().filter((group) => group.state !== "active")

  const Row = (rowProps: { group: ProviderGroupView }) => (
    <div
      style={{
        display: "flex",
        "justify-content": "space-between",
        gap: space.md,
        "align-items": "center",
        padding: "7px 9px",
        "border-radius": radius.sm,
        border: `1px solid ${theme.border}`,
        background: rowProps.group.state === "active" ? theme.surface : "transparent",
      }}
    >
      <span style={{ display: "flex", "flex-direction": "column", gap: "2px", "min-width": 0 }}>
        <span style={{ "font-size": type.body, "font-weight": 550, color: theme.text }}>{rowProps.group.label}</span>
        <Show when={rowProps.group.note}>
          <span style={{ color: theme.faint, "font-size": type.caption, "line-height": 1.4 }}>{rowProps.group.note}</span>
        </Show>
      </span>
      <span style={{ display: "flex", gap: space.md, "align-items": "center", "flex-shrink": 0 }}>
        <span style={{ color: theme.faint, "font-size": type.caption }}>
          {rowProps.group.approvedCount}/{rowProps.group.totalCount}
        </span>
        <Chip tone={rowProps.group.state === "active" ? "brand" : "neutral"}>
          {rowProps.group.state === "active" ? "active" : "off"}
        </Chip>
      </span>
    </div>
  )

  return (
    <Section
      label="Providers"
      aside={
        <span style={{ color: theme.faint, "font-size": type.caption }}>
          {activeGroups().length} active
          {inactiveGroups().length > 0 ? ` · ${inactiveGroups().length} off` : ""}
        </span>
      }
    >
      <Disclosure
        id="providers"
        open={open()}
        onToggle={() => setOpen((value) => !value)}
        hovered={hovered() === "providers"}
        onHover={setHovered}
        aside={
          <span style={{ color: theme.faint, "font-size": type.caption }}>
            {open() ? "hide" : "show"}
          </span>
        }
      >
        <span style={{ "font-size": type.caption, "font-weight": 500, color: theme.muted }}>
          {open() ? "Configured" : "Show configured"}
        </span>
      </Disclosure>

      <Show when={open()}>
        <For each={activeGroups()}>{(group) => <Row group={group} />}</For>

        <Show when={inactiveGroups().length > 0}>
          <Disclosure
            id="not-configured"
            open={notConfiguredOpen()}
            onToggle={() => setNotConfiguredOpen((value) => !value)}
            hovered={hovered() === "not-configured"}
            onHover={setHovered}
            aside={<span style={{ color: theme.faint, "font-size": type.caption }}>{inactiveGroups().length}</span>}
          >
            <span style={{ "font-size": type.caption, "font-weight": 500, color: theme.muted }}>Not configured</span>
          </Disclosure>
          <Show when={notConfiguredOpen()}>
            <For each={inactiveGroups()}>{(group) => <Row group={group} />}</For>
          </Show>
        </Show>
      </Show>
    </Section>
  )
}

/** Allowances, one card per provider, with every window it reports. */
function Allowances(props: { providers: ReadonlyArray<ProviderRow> }) {
  return (
    <Section
      label="Allowances"
      aside={
        <span style={{ color: theme.faint, "font-size": type.caption }}>
          {props.providers.length} provider{props.providers.length === 1 ? "" : "s"}
        </span>
      }
    >
      <Show
        when={props.providers.length > 0}
        fallback={<Empty title="No quota data" body="No provider has reported an allowance yet." />}
      >
        <For each={props.providers}>
          {(provider) => (
            <Card>
              <div style={{ display: "flex", "justify-content": "space-between", gap: space.md, "align-items": "center" }}>
                <span style={{ "font-size": type.body, "font-weight": 550, color: provider.error ? theme.bad : theme.text }}>
                  {provider.label}
                </span>
                <span style={{ display: "flex", gap: space.xs, "align-items": "center" }}>
                  <Show when={provider.stale}>
                    <Chip tone="warn">stale</Chip>
                  </Show>
                  <Show when={provider.exhausted}>
                    <Chip tone="bad">{provider.exhaustedWindow} spent</Chip>
                  </Show>
                  <Show when={!provider.exhausted && !provider.stale}>
                    <Chip tone={provider.source === "provider" ? "good" : "neutral"}>
                      {provider.source === "provider" ? "verified" : "estimated"}
                    </Chip>
                  </Show>
                </span>
              </div>

              <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                <For each={provider.windows}>
                  {(window) => (
                    <div style={{ display: "flex", "align-items": "center", gap: space.md }}>
                      <span
                        style={{
                          color: theme.faint,
                          "font-size": type.caption,
                          "min-width": "42px",
                          "font-variant-numeric": "tabular-nums",
                        }}
                      >
                        {window.label}
                      </span>
                      <Show when={window.reported} fallback={<span style={{ flex: 1 }} />}>
                        <Meter usedPct={window.usedPct} exhausted={window.exceeded} />
                      </Show>
                      <span
                        style={{
                          color: window.exceeded ? theme.bad : window.reported ? theme.muted : theme.faint,
                          "font-size": type.caption,
                          "min-width": "82px",
                          "text-align": "right",
                          "font-variant-numeric": "tabular-nums",
                          "flex-shrink": 0,
                        }}
                      >
                        {window.reported ? formatWindowUsed(window) : "—"}
                        {window.resetLabel ? ` · ${window.resetLabel}` : ""}
                      </span>
                    </div>
                  )}
                </For>
              </div>

              <Show when={provider.pools.length > 0}>
                <div style={{ display: "flex", "flex-direction": "column", gap: "2px", "padding-top": space.xs }}>
                  <For each={provider.pools}>
                    {(pool) => (
                      <div style={{ display: "flex", "justify-content": "space-between", gap: space.md }}>
                        <span style={{ color: theme.faint, "font-size": type.caption }}>{pool.label}</span>
                        <span style={{ color: theme.muted, "font-size": type.caption, "font-variant-numeric": "tabular-nums" }}>
                          {formatUsd(pool.remainingUsd)} of {formatUsd(pool.monthlyUsd)}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={provider.caveat}>
                <span style={{ color: theme.warn, "font-size": type.caption, "line-height": 1.45 }}>{provider.caveat}</span>
              </Show>
              <Show when={provider.error}>
                <span style={{ color: theme.bad, "font-size": type.caption }}>{provider.error}</span>
              </Show>
            </Card>
          )}
        </For>
      </Show>
    </Section>
  )
}

/**
 * Paste any console page, once.
 *
 * Every console page is accepted and the type is detected, because making the
 * user choose the right page first is a step that exists only because the
 * software was not paying attention.
 */
function AccountPaste(props: { onChanged: () => void }) {
  const ctx = usePlugin<typeof definition>()
  const [page, setPage] = createSignal("")
  const [preview, setPreview] = createSignal<any | undefined>(undefined)
  const [status, setStatus] = createSignal<{ ok: boolean; text: string } | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)
  const [focused, setFocused] = createSignal(false)
  const [hovered, setHovered] = createSignal(false)

  const reset = () => {
    setPage("")
    setPreview(undefined)
  }

  const read = async (confirm: boolean) => {
    if (!page().trim() || busy()) return
    setBusy(true)
    try {
      const result: any = await ctx.client.rpc(SmartRouterRpc).recordPlanPage({ page: page(), confirm })
      setStatus({ ok: result?.ok !== false, text: result?.message ?? "" })
      if (result?.ok && !confirm) setPreview(result.preview)
      else if (result?.ok && confirm) {
        reset()
        props.onChanged()
      }
    } catch (cause) {
      setStatus({ ok: false, text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusy(false)
    }
  }

  const button = (label: string, enabled: boolean, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      style={{
        padding: "5px 11px",
        "border-radius": radius.sm,
        border: `1px solid ${enabled ? theme.borderStrong : theme.border}`,
        background: enabled ? theme.raised : "transparent",
        color: enabled ? theme.text : theme.faint,
        "font-size": type.caption,
        font: enabled ? "inherit" : `${type.caption} inherit`,
        "font-weight": 500,
        cursor: enabled ? "pointer" : "default",
      }}
    >
      {label}
    </button>
  )

  return (
    <Section label="Account reading">
      <span style={{ color: theme.faint, "font-size": type.caption, "line-height": 1.5 }}>
        OpenDesign exposes no usage API, so the router can only count what it routed itself. Paste your{" "}
        <strong style={{ color: theme.text }}>Plan &amp; balance</strong> page to replace the estimate with your
        real position — it carries the percentage, the window it belongs to, and when it resets.
      </span>

      <textarea
        value={page()}
        onInput={(event) => {
          setPage((event.currentTarget as HTMLTextAreaElement).value)
          setPreview(undefined)
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Paste your Plan & balance page — navigation and all is fine."
        aria-label="Paste your OpenDesign Plan and balance page"
        rows={3}
        style={{
          width: "100%",
          resize: "vertical",
          padding: "8px 9px",
          "border-radius": radius.sm,
          border: `1px solid ${focused() ? theme.brandTo : theme.border}`,
          background: "transparent",
          color: theme.text,
          "font-size": type.caption,
          "font-family": "inherit",
          "line-height": 1.5,
          "box-sizing": "border-box",
          outline: "none",
          transition: "border-color 120ms ease",
        }}
      />

      <Show when={preview()}>
        <Card>
          <span style={{ color: theme.text, "font-size": type.caption, "line-height": 1.5 }}>{preview().summary}</span>
          <Show when={preview().missing?.length > 0}>
            <span style={{ color: theme.warn, "font-size": type.caption }}>
              Not on the page: {preview().missing.join(", ")}
            </span>
          </Show>
          <Show when={preview().reconciliation}>
            <span
              style={{
                color: preview().reconciliation.differ > 0 ? theme.warn : theme.good,
                "font-size": type.caption,
                "line-height": 1.45,
              }}
            >
              {preview().reconciliation.summary}
            </span>
            <For each={preview().reconciliation.rows.filter((row: any) => row.verdict === "differs")}>
              {(row: any) => (
                <span style={{ color: theme.faint, "font-size": type.caption }}>
                  {row.modelName}: charged {row.chargedUsd.toFixed(2)}, implied {row.impliedMultiplier?.toFixed(2)}× vs
                  catalog {row.catalogMultiplier?.toFixed(2)}×
                </span>
              )}
            </For>
          </Show>
        </Card>
      </Show>

      <div
        style={{ display: "flex", gap: space.sm }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <Show
          when={preview()}
          fallback={button(busy() ? "Reading…" : "Read page", Boolean(page().trim()) && !busy(), () => void read(false))}
        >
          <Show when={preview().kind === "allowance"}>
            {button(busy() ? "Saving…" : "Use this", !busy(), () => void read(true))}
          </Show>
          {button(preview().kind === "usage" ? "Done" : "Cancel", !busy(), reset)}
        </Show>
      </div>

      <Show when={status()}>
        <span
          style={{
            color: status()!.ok ? theme.good : theme.bad,
            "font-size": type.caption,
            "line-height": 1.45,
          }}
        >
          {status()!.text}
        </span>
      </Show>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------


/**
 * First run.
 *
 * The rule: show evidence, ask for nothing, offer one way forward.
 *
 * A new user has just installed a router they do not yet trust. A questionnaire
 * asks them to do the work of finding out what is on the machine; this does that
 * and reports back. Most of the time they will read it and press one button,
 * because detection already did the thinking.
 *
 * The screen is a sequence of facts about *their* machine — what was found, what
 * was imported, what it will cost them — and only then a single action. That
 * ordering is the whole design: trust is built by being right about small things
 * before asking for a decision.
 */

/**
 * Open the console, as a button that admits it is working.
 *
 * Two problems with the link it replaces.
 *
 * It did not look clickable. `↗` on tinted text at 10px reads as a footnote, not
 * an action, so it needed hover, underline and a border to say so.
 *
 * It also hung. An `<a target="_blank">` inside a panel hands the URL to the host
 * and waits for it to decide, which can take seconds with no feedback — the
 * exact conditions under which a user concludes the app has frozen. Opening
 * through `ctx.system.openExternal` is direct, and because this is a button it
 * can report that something happened.
 *
 * The fallback matters more than the happy path: if the system call throws, the
 * URL is shown so the page can still be reached. An action that fails silently is
 * worse than one that never existed.
 */
function OpenConsoleButton() {
  const ctx = usePlugin<typeof definition>()
  const [state, setState] = createSignal<"idle" | "opening" | "failed">("idle")
  const [hovered, setHovered] = createSignal(false)
  const url = "https://open-design.ai/cloud/dashboard"

  const open = () => {
    if (state() === "opening") return
    setState("opening")
    try {
      ctx.system.openExternal(url)
      // There is no completion signal from the OS, so the spinner is cleared on
      // a timer rather than pretending to know when the browser appeared.
      setTimeout(() => setState("idle"), 900)
    } catch {
      setState("failed")
    }
  }

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: space.xs }}>
      <button
        type="button"
        onClick={open}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        disabled={state() === "opening"}
        aria-busy={state() === "opening"}
        title={url}
        style={{
          display: "inline-flex",
          "align-items": "center",
          gap: "6px",
          "align-self": "flex-start",
          padding: "6px 10px",
          "border-radius": radius.sm,
          border: `1px solid ${hovered() ? theme.brandTo : theme.borderStrong}`,
          background: hovered() ? "rgba(8,145,178,0.12)" : "transparent",
          color: theme.brandTo,
          "font-size": type.caption,
          "font-weight": 550,
          "font-family": "inherit",
          cursor: state() === "opening" ? "default" : "pointer",
          "text-decoration": hovered() ? "underline" : "none",
          "text-underline-offset": "2px",
          transition: "background 120ms ease, border-color 120ms ease",
        }}
      >
        <span aria-hidden="true" style={{ "font-size": "11px" }}>
          {state() === "opening" ? "◌" : "↗"}
        </span>
        {state() === "opening" ? "Opening…" : "Open Plan & balance"}
      </button>

      <Show when={state() === "opening"}>
        <span style={{ color: theme.faint, "font-size": type.caption }}>
          Handing off to your browser — the page opens in a new tab.
        </span>
      </Show>

      <Show when={state() === "failed"}>
        <span style={{ color: theme.warn, "font-size": type.caption, "line-height": 1.45 }}>
          Could not open the browser automatically. Open this address yourself:{" "}
          <span style={{ "font-family": mono, color: theme.text }}>{url}</span>
        </span>
      </Show>
    </div>
  )
}

function Onboarding(props: { state: any; onDone: () => void }) {
  const ctx = usePlugin<typeof definition>()
  const [busy, setBusy] = createSignal(false)
  const [hovered, setHovered] = createSignal<string | undefined>(undefined)
  const [reading, setReading] = createSignal("")
  const [readingDone, setReadingDone] = createSignal(false)
  const [readingBusy, setReadingBusy] = createSignal(false)
  const [readingFocused, setReadingFocused] = createSignal(false)
  const [readingStatus, setReadingStatus] = createSignal<{ ok: boolean; text: string } | undefined>(undefined)

  /** Is OpenDesign actually configured on this machine? */
  const hasOpenDesign = () =>
    (props.state?.providers ?? []).some((provider: any) => provider.providerID === "opendesign" && provider.found)

  /**
   * Record the pasted page, in place.
   *
   * Deliberately not a separate screen: the user is told *why* this matters and
   * asked for it in the same breath. Moving them somewhere else to do it breaks
   * the explanation away from the action.
   */
  const recordReading = async (confirm: boolean) => {
    if (!reading().trim() || readingBusy()) return
    setReadingBusy(true)
    try {
      const result: any = await ctx.client.rpc(SmartRouterRpc).recordPlanPage({
        page: reading(),
        confirm: true,
      })
      setReadingStatus({ ok: result?.ok !== false, text: result?.message ?? "" })
      if (result?.ok !== false) setReadingDone(true)
    } catch (cause) {
      setReadingStatus({ ok: false, text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setReadingBusy(false)
    }
  }

  const finish = async () => {
    if (busy()) return
    setBusy(true)
    try {
      await ctx.client.rpc(SmartRouterRpc).completeOnboarding({})
      props.onDone()
    } finally {
      setBusy(false)
    }
  }

  const found = () => (props.state?.providers ?? []).filter((provider: any) => provider.found)
  const missing = () => (props.state?.providers ?? []).filter((provider: any) => !provider.found)

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: space.lg,
        padding: "18px 16px",
        color: theme.text,
        "font-size": type.body,
        height: "100%",
        "overflow-y": "auto",
        "box-sizing": "border-box",
        "font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
        "-webkit-font-smoothing": "antialiased",
      }}
    >
      {/* Hero. The first screen sets the register: this is a product with a
          point of view, not a preferences dialog. */}
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          gap: space.sm,
          "align-items": "center",
          "text-align": "center",
          padding: "10px 0 4px",
        }}
      >
        <BrandMark size={44} />
        <span
          style={{
            "font-size": type.display,
            "font-weight": 700,
            "letter-spacing": "-0.4px",
            "line-height": 1.25,
          }}
        >
          Your router is ready
        </span>
        <span style={{ color: theme.muted, "font-size": type.caption, "line-height": 1.5, "max-width": "260px" }}>
          It found what is already on this machine and configured itself. Here is exactly what it did.
        </span>
      </div>

      <Section label="Found on this machine" first>
        <Show
          when={found().length > 0}
          fallback={
            <Empty
              title="No provider credentials found"
              body="Add a key for OpenCode Go, Command Code or OpenDesign in OpenCode, then reopen this panel."
            />
          }
        >
          <For each={found()}>
            {(provider: any) => (
              <div
                style={{
                  display: "flex",
                  "justify-content": "space-between",
                  gap: space.md,
                  "align-items": "center",
                  padding: "8px 9px",
                  "border-radius": radius.sm,
                  border: `1px solid ${theme.border}`,
                  background: theme.surface,
                }}
              >
                <span style={{ display: "flex", "flex-direction": "column", gap: "1px", "min-width": 0 }}>
                  <span style={{ "font-size": type.body, "font-weight": 550 }}>{provider.label}</span>
                  <Show when={provider.source}>
                    <span style={{ color: theme.faint, "font-size": type.caption }}>{provider.source}</span>
                  </Show>
                </span>
                <Chip tone={provider.enabled ? "good" : "neutral"}>
                  {provider.enabled ? "enabled" : "off"}
                </Chip>
              </div>
            )}
          </For>
        </Show>
      </Section>

      {/* What it learned. This is the part that makes the product feel like it
          did work on the user's behalf rather than asking them to do it. */}
      <Section
        label="Learned from your history"
        aside={
          <span style={{ color: theme.faint, "font-size": type.caption }}>
            {props.state?.hasHistory ? "imported" : "none yet"}
          </span>
        }
      >
        <Show
          when={props.state?.hasHistory}
          fallback={
            <Empty
              title="Nothing to import yet"
              body="Once you have used OpenCode, the router reads that history so day one is not a guess."
            />
          }
        >
          <Card accent>
            <span style={{ "font-size": type.body }}>
              <strong style={{ "font-weight": 650 }}>{props.state.historyImported}</strong>{" "}
              <span style={{ color: theme.muted }}>
                request{props.state.historyImported === 1 ? "" : "s"} from OpenCode's own database
              </span>
            </span>
            <span style={{ color: theme.faint, "font-size": type.caption, "line-height": 1.5 }}>
              Each one carries its own timestamp and the model that served it, so the seven-day window starts
              accurate instead of empty.
            </span>
          </Card>
        </Show>
      </Section>

      <Section label="What it will do">
        <div style={{ display: "flex", "flex-direction": "column", gap: "5px" }}>
          <For
            each={[
              "Pick the cheapest model that can actually do the job, and say why.",
              "Stop before an allowance runs out, not after a request fails.",
              "Count what you spend here, and never guess silently.",
            ]}
          >
            {(line) => (
              <div style={{ display: "flex", gap: space.sm, "align-items": "baseline" }}>
                <span style={{ color: theme.brandTo, "font-size": type.caption }}>›</span>
                <span style={{ color: theme.muted, "font-size": type.caption, "line-height": 1.5 }}>{line}</span>
              </div>
            )}
          </For>
        </div>
      </Section>

      {/* The one thing detection cannot know.
          OpenDesign publishes no usage API, so the router cannot see the account
          — only its own traffic. Rather than leave that as a footnote, the step
          is asked for here, once, with the reason stated plainly. Getting this
          wrong is what made a 42%-used account look 5% used. */}
      <Show when={hasOpenDesign()}>
        <Section
          label="One thing it cannot see"
          aside={<Chip tone="warn">needed for accuracy</Chip>}
        >
          <Card>
            <span style={{ "font-size": type.body, "font-weight": 550 }}>
              OpenDesign does not expose usage to an API key
            </span>
            <span style={{ color: theme.muted, "font-size": type.caption, "line-height": 1.55 }}>
              So the router can only count what <em>it</em> has routed. Anything you spent before installing
              it — in the desktop app, or with another tool — is invisible, which makes its estimate far too
              optimistic.
            </span>
            <span style={{ color: theme.muted, "font-size": type.caption, "line-height": 1.55 }}>
              Paste your <strong style={{ color: theme.text }}>Plan &amp; balance</strong> page once and it
              knows your real position. This is the only page worth pasting: it carries the percentage, which
              window it belongs to, and when it resets.
            </span>

            <Show when={!readingDone()}>
              <OpenConsoleButton />

              <textarea
                value={reading()}
                onInput={(event) => setReading((event.currentTarget as HTMLTextAreaElement).value)}
                placeholder="Paste the whole page here — the navigation and all is fine."
                aria-label="Paste your OpenDesign Plan and balance page"
                rows={3}
                style={{
                  width: "100%",
                  resize: "vertical",
                  padding: "8px 9px",
                  "border-radius": radius.sm,
                  border: `1px solid ${readingFocused() ? theme.brandTo : theme.border}`,
                  background: "transparent",
                  color: theme.text,
                  "font-size": type.caption,
                  "font-family": "inherit",
                  "line-height": 1.5,
                  "box-sizing": "border-box",
                  outline: "none",
                }}
              />
              <div style={{ display: "flex", gap: space.sm, "align-items": "center" }}>
                <button
                  type="button"
                  onClick={() => void recordReading(false)}
                  disabled={!reading().trim() || readingBusy()}
                  style={{
                    padding: "5px 11px",
                    "border-radius": radius.sm,
                    border: `1px solid ${theme.borderStrong}`,
                    background: reading().trim() ? theme.raised : "transparent",
                    color: reading().trim() ? theme.text : theme.faint,
                    "font-size": type.caption,
                    "font-family": "inherit",
                    cursor: reading().trim() ? "pointer" : "default",
                  }}
                >
                  {readingBusy() ? "Reading…" : "Check it"}
                </button>
                <span style={{ color: theme.faint, "font-size": type.caption }}>
                  Optional — you can skip and paste later.
                </span>
              </div>
              <Show when={readingStatus()}>
                {(current) => (
                  <span
                    style={{
                      color: current().ok ? theme.good : theme.bad,
                      "font-size": type.caption,
                      "line-height": 1.45,
                    }}
                  >
                    {current().text}
                  </span>
                )}
              </Show>
            </Show>

            <Show when={readingDone()}>
              <span style={{ color: theme.good, "font-size": type.caption }}>
                Recorded. Your allowance now starts from what the account actually shows.
              </span>
            </Show>
          </Card>
        </Section>
      </Show>

      <Show when={missing().length > 0 && !hasOpenDesign()}>
        <Section label="Not needed yet">
          <span style={{ color: theme.faint, "font-size": type.caption, "line-height": 1.5 }}>
            {missing().length} provider{missing().length === 1 ? "" : "s"} had no credential and stayed off.
            They are listed under Providers whenever you want them.
          </span>
        </Section>
      </Show>

      {/* One action. A first-run screen with a maze of choices is a settings
          page pretending to be a welcome. */}
      <button
        type="button"
        onClick={() => void finish()}
        onMouseEnter={() => setHovered("done")}
        onMouseLeave={() => setHovered(undefined)}
        disabled={busy()}
        style={{
          "margin-top": "auto",
          padding: "10px 12px",
          "border-radius": radius.md,
          border: "none",
          background: brandGradient,
          color: "#fff",
          "font-size": type.body,
          "font-weight": 600,
          font: "inherit",
          cursor: busy() ? "default" : "pointer",
          opacity: busy() ? 0.7 : hovered() === "done" ? 0.92 : 1,
          transition: "opacity 120ms ease",
        }}
      >
        {busy() ? "Starting…" : "Start routing"}
      </button>
    </div>
  )
}

function SmartRouterPanel(props: { sessionID: string | undefined }) {
  const ctx = usePlugin<typeof definition>()
  const [status, setStatus] = createSignal<RouterStatus | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [at, setAt] = createSignal<number | undefined>(undefined)
  const [expandedCandidates, setExpandedCandidates] = createSignal(false)
  const [hovered, setHovered] = createSignal<string | undefined>(undefined)
  const [onboarding, setOnboarding] = createSignal<any | undefined>(undefined)

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
    /**
     * Ask about first run, but never wait for the answer.
     *
     * This used to be a gate: nothing rendered until the call settled. When the
     * method did not settle — an older server build that does not know it — the
     * panel rendered as an empty box forever. An optional check must never be
     * able to blank the whole surface.
     *
     * So the dashboard paints immediately and onboarding replaces it if it
     * arrives and says this is a fresh install. On a fresh install that swap
     * happens within a frame or two; everywhere else the answer is "no" and
     * nothing changes.
     */


    void (async () => {
      try {
        const state: any = await Promise.race([
          ctx.client.rpc(SmartRouterRpc).onboarding({}),
          // A stuck call must not hold the panel open on a blank state.
          new Promise((resolve) => setTimeout(() => resolve(undefined), 1_500)),
        ])
        if (state?.firstRun) setOnboarding(state)
      } catch {
        // A router that cannot describe itself should still show the panel.
      }
    })()
    const timer = setInterval(() => void load(), 3_000)
    // The panel only reflects the window-scoped controller's state.
    const reflectTimer = setInterval(() => {
      setSidebar(sidebarFeature.active())
      setSidebarProbe(sidebarFeature.probe())
    }, 1_500)
    onCleanup(() => {
      clearInterval(timer)
      clearInterval(reflectTimer)
    })
  })

  const [sidebar, setSidebar] = createSignal(sidebarFeature.active())
  const [sidebarProbe, setSidebarProbe] = createSignal(sidebarFeature.probe())

  const view = (): DecisionView | undefined => summariseDecision(status()?.lastDecision as never)
  const providers = (): ProviderRow[] =>
    ((status()?.quota ?? []) as never[]).map((snapshot) => toProviderRow(snapshot))
  const needsReading = () => providers().some((provider) => provider.source === "estimate")

  return (
    <Show
      when={!onboarding()}
      fallback={
        <Onboarding
          state={onboarding()}
          onDone={() => {
            setOnboarding(undefined)
            void load()
          }}
        />
      }
    >
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: space.lg,
        padding: "14px 14px 18px",
        color: theme.text,
        "font-size": type.body,
        height: "100%",
        "overflow-y": "auto",
        "box-sizing": "border-box",
        "font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
        "-webkit-font-smoothing": "antialiased",
      }}
    >
      <div style={{ display: "flex", "flex-direction": "column", gap: "3px" }}>
        <BrandHeader runtime={status()?.runtime ?? "connecting"} mode={status()?.mode ?? "—"} />
        <div style={{ display: "flex", "justify-content": "space-between", gap: space.md, "align-items": "baseline" }}>
          <span
            style={{
              "font-family": mono,
              "font-size": type.caption,
              color: status()?.current ? theme.muted : theme.faint,
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            {status()?.current ? `${status()!.current!.providerID}/${status()!.current!.id}` : "no model yet"}
          </span>
          <span style={{ color: theme.faint, "font-size": type.caption, "flex-shrink": 0 }}>
            {at() ? relative(at()!) : "connecting…"}
          </span>
        </div>
      </div>

      <Show when={error()}>
        <Card>
          <span style={{ color: theme.bad, "font-size": type.caption }}>Router unreachable: {error()}</span>
          <span style={{ color: theme.faint, "font-size": type.caption }}>
            The plugin may have failed to load. Check Settings → Extensions → Plugins.
          </span>
        </Card>
      </Show>

      <AutoSwitch
        sessionID={props.sessionID}
        auto={(status()?.runtime ?? "automatic") === "automatic"}
        onChanged={() => void load()}
      />

      <SidebarToggle
        enabled={status()?.sidebarGroups === true}
        active={sidebar()}
        probe={sidebarProbe()}
        onChanged={() => void load()}
      />

      <DecisionInspector
        view={view()}
        expanded={expandedCandidates()}
        onToggle={() => setExpandedCandidates((value) => !value)}
        hovered={hovered()}
        onHover={setHovered}
      />

      <Allowances providers={providers()} />

      <Show when={needsReading()}>
        <AccountPaste onChanged={() => void load()} />
      </Show>

      <ProviderList status={status()} />
    </div>
    </Show>
  )
}

const tab: PanelTab = {
  id: "router",
  get title() {
    return "Router"
  },
  closable: "hover",
}

const definition = Plugin.define({
  i18n: {
    en: {
      "command.open": "Open Smart Router",
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
      render: (props: PanelProps) => <SmartRouterPanel sessionID={props.session.id} />,
    })

    /**
     * Open the panel by itself, once, when a session first becomes available.
     *
     * Two constraints shape this.
     *
     * A side panel belongs to a session — `sessions.current()` is undefined on
     * Home and on a draft — so there is nothing to attach to until the user opens
     * a conversation. That is why this cannot fire at launch.
     *
     * And it must not fight the user. Closing the panel is a decision, so this
     * runs at most once per window and only when the tab is genuinely closed. The
     * `layout.ready()` guard matters: before the layout loads, every read reports
     * an empty layout, so acting earlier would reopen a tab somebody had
     * deliberately closed in a previous session.
     */
    const panelKey = `${ctx.id}:router`
    /**
     * Open once per session, not once per window.
     *
     * The first version wrote a single `autoOpened` flag and gave up after thirty
     * seconds. Both were wrong for the ordinary sequence — launch the app, look
     * around on Home, then open a session — because no session exists for the
     * first thirty seconds, and the flag could never be reset for the next one.
     *
     * Keying on the session means each conversation gets the panel once, and
     * closing it stays closed for that conversation.
     */
    const openedFor = new Set<string>()
    /**
     * Every step is wrapped: this runs inside `setup`, and a GUI whose setup throws
     * does not lose its panel, it loses the plugin.
     */
    const tryAutoOpen = () => {
      try {
        if (!ctx.layout.ready()) return
        const session = ctx.sessions.current()
        if (!session) return
        if (openedFor.has(session.key)) return
        // Before the stored layout loads every read reports an empty layout, so
        // this must not act until `ready()` is true or it reopens a tab the user
        // deliberately closed.
        if (ctx.layout.state(panelKey, session) !== "closed") {
          openedFor.add(session.key)
          return
        }
        openedFor.add(session.key)
        ctx.layout.open(panelKey, session)
      } catch {
        // Auto-open is best effort; never surface as a plugin failure.
      }
    }
    /**
     * A slow poll rather than an event, because there is no session-routed event
     * to subscribe to and 800ms costs nothing. It runs for the life of the window
     * instead of stopping: the window is what owns the panel, and the user may
     * open their first session minutes after launch.
     */
    const autoOpenTimer = setInterval(tryAutoOpen, 800)

    /**
     * Sidebar grouping belongs to the window, not to the panel tab: the sidebar
     * is visible whether or not the panel is open, so closing the panel must not
     * un-group the sidebar. `setup` owns the controller; the panel only reports
     * its state and flips the setting through RPC.
     */
    sidebarFeature.onNewSession((project) => {
      /**
       * Start a session in the project a heading names. The directory comes from
       * the app's project list by name, newest first; a miss opens a plain draft
       * so the user is never left with a button that does nothing.
       */
      void (async () => {
        try {
          const result: any = await ctx.client.project.list()
          const projects: any[] = Array.isArray(result?.data) ? result.data : []
          const match = projects
            .filter((entry) => (entry.name || String(entry.canonical ?? "").split("/").pop()) === project)
            .sort((left, right) => (right.time?.active ?? 0) - (left.time?.active ?? 0))[0]
          const session = ctx.sessions.current()
          if (match?.canonical && session) {
            ctx.layout.draft({ server: session.server.id, directory: match.canonical, prompt: "" })
            return
          }
        } catch {
          // Fall through to the plain draft.
        }
        try {
          const session = ctx.sessions.current()
          if (session) ctx.layout.draft({ server: session.server.id, directory: session.directory, prompt: "" })
        } catch {
          // The app's own picker remains available.
        }
      })()
    })
    let sidebarWanted: boolean | undefined
    const sidebarTimer = setInterval(() => {
      void (async () => {
        try {
          const status: any = await ctx.client.rpc(SmartRouterRpc).status({})
          const want = status?.sidebarGroups === true
          if (want === sidebarWanted) return
          sidebarWanted = want
          sidebarFeature.sync(want)
        } catch {
          // A failed status read leaves the sidebar as it is.
        }
      })()
    }, 1_500)

    ctx.add(Slot, {
      at: "window.bottom",
      render: () => (
        <span style={{ display: "inline-flex", "align-items": "center", gap: "5px" }}>
          <BrandMark size={12} />
          <span style={{ "font-size": type.caption, color: theme.faint }}>Smart Router</span>
        </span>
      ),
    })

    // Cleanup: the interval belongs to this plugin's lifetime. Placed after every
    // registration, because a return before `ctx.add` would skip that contribution.
    return () => {
      clearInterval(autoOpenTimer)
      clearInterval(sidebarTimer)
      sidebarFeature.destroy()
    }
  },
})
