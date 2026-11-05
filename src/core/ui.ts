import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ProviderQuotaSnapshot } from "./types.js"
import { percent, usd } from "./util.js"

const run = promisify(execFile)

export type IndicatorState = "AUTO" | "MANUAL" | "PAUSED" | "DRY RUN" | "BLOCKED"

export interface Indicator {
  readonly state: IndicatorState
  readonly provider?: string
  readonly model?: string
  readonly modelLabel?: string
  readonly title?: string
}

export const providerShort = (providerID: string | undefined): string => {
  if (!providerID) return "?"
  if (providerID === "opencode-go") return "Go"
  if (providerID === "commandcode") return "CC"
  if (providerID === "opendesign") return "OD"
  return providerID
}

/**
 * Human-readable confidence state for a provider quota snapshot.
 *
 * `verified` means the provider reported the numbers. `estimated` means the
 * router modelled them from its own usage and they are a lower bound.
 * `unknown` means nothing could be established safely.
 */
export const quotaStateLabel = (snapshot: ProviderQuotaSnapshot): string => {
  if (snapshot.stale) return "stale"
  switch (snapshot.quotaState) {
    case "verified":
      return "verified"
    case "estimated":
      return "estimated"
    case "exhausted":
      return "exhausted"
    case "unavailable":
      return "unavailable"
    case "unknown":
      return "unknown"
    case "stale":
      return "stale"
    default:
      return snapshot.source === "provider"
        ? "verified"
        : snapshot.source === "estimate"
          ? "estimated"
          : "unknown"
  }
}

/**
 * Render a provider quota line.
 *
 * OpenDesign is reported in Design Plan credits, which are USD-equivalent.
 * A plan with more than one funding pool prints one line per pool rather
 * than a summed balance: the pools have different rules, and adding them
 * would suggest the total can be spent in one go.
 *
 * The purchased wallet balance is always shown separately so a non-zero
 * balance can never be mistaken for permission to spend it.
 */
export const formatQuotaLines = (snapshot: ProviderQuotaSnapshot): string[] => {
  const pools = snapshot.pools ?? []
  const lines: string[] = []
  if (pools.length > 1) {
    lines.push(`${snapshot.label} (${quotaStateLabel(snapshot)}):`)
    for (const pool of pools) {
      const windows: string[] = []
      if (pool.fiveHourUsd !== undefined && pool.fiveHourUsedPct !== undefined) {
        windows.push(`5h ${percent(pool.fiveHourUsedPct)} of ${usd(pool.fiveHourUsd)}`)
      }
      if (pool.weeklyUsd !== undefined && pool.weeklyUsedPct !== undefined) {
        windows.push(`7d ${percent(pool.weeklyUsedPct)} of ${usd(pool.weeklyUsd)}`)
      }
      const windowText = windows.length > 0 ? ` · ${windows.join(" · ")}` : " · no usage windows"
      lines.push(
        `  ${pool.label}: ${usd(pool.remainingUsd)} of ${usd(pool.monthlyUsd)} remaining${windowText}`,
      )
    }
    lines.push("  The pools are separate allowances and are never added together.")
  } else {
    const windows =
      snapshot.rolling.source === "unknown" && snapshot.weekly.source === "unknown"
        ? "no usage windows"
        : `5h ${percent(snapshot.rolling.usedPct)} · weekly ${percent(snapshot.weekly.usedPct)}`
    lines.push(
      `${snapshot.label}: ${windows} · monthly ${percent(snapshot.monthly.usedPct)} (${quotaStateLabel(snapshot)})`,
    )
  }
  if (snapshot.providerID === "opendesign") {
    const purchased = snapshot.extraCredits?.purchasedUsd ?? 0
    lines.push(
      `  Purchased wallet ${usd(purchased)} is separate from both allowances and is never spent automatically.`,
    )
    if (snapshot.monthlyRemainingUsd !== undefined) {
      lines.push(`  Design Plan allowance remaining ${usd(snapshot.monthlyRemainingUsd)}.`)
    }
  }
  if (snapshot.error) lines.push(`  ${snapshot.error}`)
  return lines
}

export const indicatorState = (input: {
  enabled: boolean
  runtimePaused: boolean
  manual: boolean
  dryRun: boolean
}): IndicatorState => {
  if (!input.enabled || input.runtimePaused) return "PAUSED"
  if (input.manual) return "MANUAL"
  if (input.dryRun) return "DRY RUN"
  return "AUTO"
}

export const stripTitlePrefix = (title: string | undefined): string => {
  if (!title) return ""
  const match = /^(AUTO|MANUAL|PAUSED|DRY RUN|BLOCKED) · [^—]*(?: — ([\s\S]*))?$/.exec(title)
  if (!match) return title.trim()
  return (match[2] ?? "").trim()
}

/**
 * The name a session should keep, independent of whatever status decoration is
 * currently in front of it.
 *
 * The failure this exists to prevent: the router used to derive the base title
 * from `session.title`, which holds the last title *the router itself wrote*. So
 * the first time the separator was lost — compact mode, a BLOCKED rewrite, a
 * title written before the generator named the chat — the prefix became the
 * name, and every later write read that prefix back as if it were a title.
 * There was no way out of that state.
 *
 * Rules:
 *   - A visible title the router did not write is the user's name. Adopt it.
 *   - Otherwise keep the base already on record.
 *   - Only fall back to stripping a prefix as a last resort, and return
 *     `undefined` rather than an empty string, so the caller can leave the
 *     session alone instead of writing a nameless title.
 */
export const resolveBaseTitle = (input: {
  currentTitle: string | undefined
  /** The exact title this router last wrote, if any. */
  lastWrittenTitle: string | undefined
  storedBase: string | undefined
}): string | undefined => {
  const visible = input.currentTitle?.trim()
  const routerWroteIt = Boolean(visible) && visible === input.lastWrittenTitle
  if (visible && !routerWroteIt) return visible
  if (input.storedBase) return input.storedBase
  const stripped = stripTitlePrefix(input.currentTitle)
  return stripped || undefined
}

export const buildIndicatorTitle = (input: {
  state: IndicatorState
  provider?: string
  modelLabel?: string
  baseTitle?: string
  compact?: boolean
}): string => {
  const provider = providerShort(input.provider)
  const model = input.modelLabel?.trim() || "model"
  const prefix = input.compact ? `${input.state} · ${model}` : `${input.state} · ${provider} · ${model}`
  const base = stripTitlePrefix(input.baseTitle)
  // A prefix on its own is not a name, and neither is the placeholder OpenCode
  // uses before the title generator has run. Compact shortens the prefix; it
  // must never delete the name, which is what it used to do.
  if (!base || base === prefix || base === "Session") return prefix
  return `${prefix} — ${base.slice(0, 150)}`
}

export class ChangeNotifier {
  private readonly last = new Map<string, number>()
  private backend: "terminal-notifier" | "osascript" | "none" | undefined

  shouldNotify(key: string, ttlMs = 10 * 60_000) {
    const now = Date.now()
    const previous = this.last.get(key)
    if (previous && now - previous < ttlMs) return false
    this.last.set(key, now)
    if (this.last.size > 100) {
      for (const [entry, at] of this.last) {
        if (now - at > ttlMs) this.last.delete(entry)
      }
    }
    return true
  }

  async notify(message: string): Promise<boolean> {
    if (!message.trim()) return false
    if (this.backend === "none") return false
    if (this.backend === "terminal-notifier" || this.backend === undefined) {
      try {
        await run(
          "terminal-notifier",
          ["-title", "OpenCode Smart Router", "-message", message.slice(0, 220), "-group", "opencode-smart-router"],
          { timeout: 1_500, maxBuffer: 4_096 },
        )
        this.backend = "terminal-notifier"
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // terminal-notifier exists but the notification was suppressed or
          // denied. Fall through to the AppleScript path once.
        }
      }
    }
    try {
      const escaped = message.replaceAll("\\", "/").replaceAll('"', "'").slice(0, 220)
      await run(
        "osascript",
        ["-e", `display notification "${escaped}" with title "OpenCode Smart Router"`],
        { timeout: 1_500, maxBuffer: 4_096 },
      )
      this.backend = "osascript"
      return true
    } catch {
      this.backend = "none"
      return false
    }
  }
}

export const __uiInternals = {
  stripTitlePrefix,
  buildIndicatorTitle,
  resolveBaseTitle,
  providerShort,
  quotaStateLabel,
}
