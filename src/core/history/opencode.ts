import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Read OpenCode's own message history.
 *
 * The router's ledger only ever saw traffic it routed. Everything before the
 * first install is invisible to it, which is why an account that was already
 * 42% used looked untouched. That history is not actually missing: OpenCode
 * records every message with its provider, model, tokens, cost and timestamp in
 * a local SQLite database. Reading it gives the estimate a real starting point
 * on day one, with no paste and no guess.
 *
 * Message granularity matters, not session granularity. The Design Plan window is
 * fixed at seven days from subscription start, so an event needs its own
 * timestamp to be bucketed into the right window; a session summary carries only
 * the session's last-updated time and smears a week of work across one instant.
 *
 * Deliberate limits:
 *
 *   - **Read-only, always.** The database is opened with `readOnly: true`. This
 *     module must never be able to damage the user's history, and the cheapest
 *     way to guarantee that is to make a write impossible.
 *   - **Optional dependency.** `node:sqlite` is experimental and absent on older
 *     Node. Every failure path returns nothing plus a reason, because history is
 *     an enhancement and the router must route without it.
 *   - **Never guesses a schema.** Only the columns this needs are read, and a row
 *     that does not parse is skipped rather than defaulted.
 */

export interface HistoryEntry {
  readonly id: string
  readonly at: number
  readonly providerID: string
  readonly modelID: string
  readonly cost: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface HistoryRead {
  readonly entries: ReadonlyArray<HistoryEntry>
  /** Why nothing was read, when nothing was. */
  readonly reason?: string
  readonly dbPath?: string
}

export interface ReadHistoryOptions {
  /** Override the database location, for tests. */
  readonly dbPath?: string
  readonly home?: string
  /** Ignore anything older than this. */
  readonly sinceMs?: number
  readonly limit?: number
}

export const defaultHistoryPath = (home = homedir()): string =>
  join(home, ".local", "share", "opencode", "opencode.db")

const numberOrZero = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/**
 * Turn one stored message into a history entry, or `undefined` when the row
 * cannot support one.
 *
 * Only assistant messages carry a cost, and only a row with a provider, a model
 * and a timestamp is usable. Anything else is skipped: a defaulted model would
 * attribute real spend to the wrong provider.
 */
export const toHistoryEntry = (row: { id?: unknown; data?: unknown }): HistoryEntry | undefined => {
  let data: any
  try {
    data = typeof row.data === "string" ? JSON.parse(row.data) : row.data
  } catch {
    return undefined
  }
  if (!data || typeof data !== "object") return undefined
  if (data.role !== "assistant") return undefined

  const providerID = typeof data.providerID === "string" ? data.providerID : undefined
  const modelID = typeof data.modelID === "string" ? data.modelID : undefined
  const at = typeof data.time?.created === "number" ? data.time.created : undefined
  if (!providerID || !modelID || at === undefined) return undefined

  const cost = numberOrZero(data.cost)
  const tokens = data.tokens ?? {}
  const entry: HistoryEntry = {
    id: String(row.id ?? `${providerID}:${modelID}:${at}`),
    at,
    providerID,
    modelID,
    cost,
    input: numberOrZero(tokens.input),
    output: numberOrZero(tokens.output),
    cacheRead: numberOrZero(tokens.cache?.read),
    cacheWrite: numberOrZero(tokens.cache?.write),
  }
  // A row with no cost and no tokens is not evidence of anything.
  if (entry.cost === 0 && entry.input + entry.output + entry.cacheRead + entry.cacheWrite === 0) return undefined
  return entry
}

/**
 * Read recent history, newest first.
 *
 * Synchronous by design: `node:sqlite`'s API is synchronous, and wrapping it in a
 * promise would suggest it is cheap when it is blocking. Callers run it once at
 * startup, on a bounded number of rows.
 */
export const readOpenCodeHistory = (options: ReadHistoryOptions = {}): HistoryRead => {
  const dbPath = options.dbPath ?? defaultHistoryPath(options.home)
  if (!existsSync(dbPath)) {
    return { entries: [], reason: "No OpenCode database found on this machine", dbPath }
  }

  let DatabaseSync: any
  try {
    // Resolved lazily so a Node without the module still loads this file.
    ;({ DatabaseSync } = require("node:sqlite"))
  } catch {
    return { entries: [], reason: "This Node build has no node:sqlite; history import is unavailable", dbPath }
  }
  if (!DatabaseSync) {
    return { entries: [], reason: "node:sqlite is unavailable; history import is skipped", dbPath }
  }

  let db: any
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    // A locked database is normal while a session is writing. Not an error worth
    // surfacing as a failure; the next start will read it.
    return {
      entries: [],
      reason: `Could not open the history database read-only (${error instanceof Error ? error.message : String(error)})`,
      dbPath,
    }
  }

  try {
    const limit = Math.max(1, Math.min(options.limit ?? 5_000, 50_000))
    const since = options.sinceMs
    const sql = since
      ? "SELECT id, data FROM message WHERE time_created >= ? ORDER BY time_created DESC LIMIT ?"
      : "SELECT id, data FROM message ORDER BY time_created DESC LIMIT ?"
    const statement = db.prepare(sql)
    const rows = since ? statement.all(since, limit) : statement.all(limit)
    const entries: HistoryEntry[] = []
    for (const row of rows as Array<{ id?: unknown; data?: unknown }>) {
      const entry = toHistoryEntry(row)
      if (entry) entries.push(entry)
    }
    return { entries, dbPath }
  } catch (error) {
    return {
      entries: [],
      reason: `Could not read history (${error instanceof Error ? error.message : String(error)})`,
      dbPath,
    }
  } finally {
    try {
      db.close()
    } catch {
      // Closing a read-only handle that is already gone is not a problem.
    }
  }
}
