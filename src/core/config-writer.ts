import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * The one place the router is allowed to write its own config.
 *
 * A settings panel that tells a user their number is wrong and then makes them
 * hand-edit JSON is not a control panel, it is a bug report. But two writers on
 * one file is how config systems rot, so every write goes through here and this
 * file is deliberately small and paranoid:
 *
 *   1. Only the keys the caller names are changed. Everything else, including
 *      keys this version does not understand, is preserved byte-for-byte in
 *      structure.
 *   2. The result is validated before it replaces anything, so the GUI cannot
 *      produce a file the loader would reject or silently repair.
 *   3. It is written to a temp file and renamed, so a crash mid-write leaves the
 *      previous config intact.
 *   4. One timestamped backup per write, keeping the last few.
 *
 * Known cost, stated plainly: JSON has no comments, so a hand-commented file
 * loses them. Callers that care can set `ui.readOnlyConfig`.
 */

export interface WriteResult {
  readonly path: string
  /** Keys the caller asked to change, flattened. */
  readonly changed: ReadonlyArray<string>
  readonly backup?: string
}

export const settingsPath = (home = homedir()): string => join(home, ".config", "opencode", "smart-router.json")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Deep merge where `patch` wins. Arrays and scalars replace wholesale. */
export const mergePatch = (base: unknown, patch: unknown): unknown => {
  if (!isRecord(patch)) return patch
  const target = isRecord(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    target[key] = isRecord(value) ? mergePatch(target[key], value) : value
  }
  return target
}

export const flattenKeys = (patch: unknown, prefix = ""): string[] => {
  if (!isRecord(patch)) return prefix ? [prefix] : []
  return Object.entries(patch).flatMap(([key, value]) =>
    isRecord(value) ? flattenKeys(value, prefix ? `${prefix}.${key}` : key) : [prefix ? `${prefix}.${key}` : key],
  )
}

const pruneBackups = (path: string, keep = 5): void => {
  try {
    const dir = dirname(path)
    const name = path.slice(dir.length + 1)
    const backups = readdirSync(dir)
      .filter((entry) => entry.startsWith(`${name}.bak-`))
      .sort()
    for (const stale of backups.slice(0, Math.max(0, backups.length - keep))) {
      unlinkSync(join(dir, stale))
    }
  } catch {
    // Backup pruning is housekeeping; never fail a write over it.
  }
}

export interface WriteSettingsOptions {
  readonly patch: unknown
  readonly home?: string
  readonly path?: string
  /** Reject the write instead of applying it. Return a message to show the user. */
  readonly validate?: (merged: unknown) => string | undefined
  readonly now?: () => number
}

export const writeSettingsPatch = (options: WriteSettingsOptions): WriteResult => {
  const path = options.path ?? settingsPath(options.home)
  const now = options.now ?? Date.now
  let existing: unknown = {}
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8")
    try {
      existing = JSON.parse(text)
    } catch (error) {
      // Refuse rather than overwrite: a broken file is the user's data, and
      // replacing it would destroy whatever they were trying to hand-edit.
      throw new Error(`Existing config is not valid JSON (${(error as Error).message}); refusing to overwrite it`)
    }
  }

  const merged = mergePatch(existing, options.patch)
  const problem = options.validate?.(merged)
  if (problem) throw new Error(problem)

  mkdirSync(dirname(path), { recursive: true })

  let backup: string | undefined
  if (existsSync(path)) {
    backup = `${path}.bak-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`
    copyFileSync(path, backup)
  }

  // Same directory, so the rename is atomic on the same filesystem.
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)

  pruneBackups(path)
  return { path, changed: flattenKeys(options.patch), ...(backup ? { backup } : {}) }
}

/**
 * Parse what a person copies off an account page.
 *
 * The page shows a percentage; the router works in dollars; somebody has to
 * divide. Accepting the text exactly as it appears removes the arithmetic and
 * with it the mistake that arithmetic invites.
 *
 *   "42%"     -> percentage 42
 *   "$37.80"  -> dollars 37.8
 *   "37.80"   -> percentage 37.8, because that is the shape the page shows
 */
export const parseAccountReading = (
  raw: string,
): { kind: "pct"; value: number } | { kind: "usd"; value: number } | undefined => {
  const text = raw.trim()
  if (!text) return undefined
  if (text.includes("%")) {
    const value = Number(text.replace("%", "").replace(/,/g, "").trim())
    return Number.isFinite(value) && value >= 0 ? { kind: "pct", value: Math.min(100, value) } : undefined
  }
  if (text.includes("$")) {
    const value = Number(text.replace("$", "").replace(/,/g, "").trim())
    return Number.isFinite(value) && value >= 0 ? { kind: "usd", value } : undefined
  }
  const value = Number(text.replace(/,/g, ""))
  return Number.isFinite(value) && value >= 0 ? { kind: "pct", value: Math.min(100, value) } : undefined
}

/**
 * Parse a "resets in" phrase into an absolute time.
 *
 * Accepts what the page writes ("0d 23h", "23h") and what people type ("2 days",
 * "in 90m"). Returns undefined rather than a guess when it cannot tell, so the
 * caller can leave the field out instead of inventing a reset.
 */
export const parseResetIn = (raw: string, now = Date.now()): number | undefined => {
  const text = raw.trim().toLowerCase()
  if (!text) return undefined
  const days = /(\d+)\s*d/.exec(text)?.[1]
  const hours = /(\d+)\s*h/.exec(text)?.[1]
  const minutes = /(\d+)\s*m/.exec(text)?.[1]
  if (days === undefined && hours === undefined && minutes === undefined) {
    const absolute = Date.parse(raw)
    return Number.isFinite(absolute) ? absolute : undefined
  }
  const d = Number(days ?? 0)
  const h = Number(hours ?? 0)
  const m = Number(minutes ?? 0)
  if (d + h + m === 0) return undefined
  return now + ((d * 24 + h) * 60 + m) * 60_000
}
