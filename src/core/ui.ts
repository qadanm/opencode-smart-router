import { execFile } from "node:child_process"
import { promisify } from "node:util"

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
  return providerID
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
  if (input.compact || !base || base === prefix || base === "Session") return prefix
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

export const __uiInternals = { stripTitlePrefix, buildIndicatorTitle, providerShort }
