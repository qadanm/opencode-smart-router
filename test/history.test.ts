import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readOpenCodeHistory, toHistoryEntry } from "../src/core/history/opencode.js"

/**
 * Reading OpenCode's own history is how the estimate learns about usage that
 * happened before the router existed. It reads a database the user did not
 * create for us, so the tests care as much about what it refuses to read as what
 * it extracts.
 */

const NOW = Date.UTC(2026, 10, 4, 21, 0, 0)

/**
 * `node:sqlite` arrived in Node 22.5, but `package.json` declares Node 20.12 as
 * the floor and CI tests that floor. On 20.12 the reader is supposed to degrade:
 * it returns no entries and a reason, and the router keeps working without
 * history import. The tests below have to model that rather than assume the
 * module exists, or the declared floor is untested in the only environment that
 * exercises it.
 *
 * `require` is used deliberately, exactly as the reader uses it, so this detects
 * the same capability the production path sees.
 */
const sqliteAvailable = (() => {
  try {
    const { DatabaseSync } = require("node:sqlite")
    return typeof DatabaseSync === "function"
  } catch {
    return false
  }
})()

/** The three states below need a real database to construct, so they cannot run
 * without `node:sqlite`. The degradation path is asserted unconditionally
 * instead, so a skipped leg still proves the contract that matters there. */
const describeWithSqlite = sqliteAvailable ? describe : describe.skip

const message = (over: Record<string, unknown> = {}, id = "m1") => ({
  id,
  data: JSON.stringify({
    role: "assistant",
    providerID: "opendesign",
    modelID: "deepseek-v4.1-flash",
    cost: 0.3,
    tokens: { input: 1_000_000, output: 0, cache: { read: 0, write: 0 } },
    time: { created: NOW },
    ...over,
  }),
})

describe("turning a message into history", () => {
  it("extracts the fields a quota window needs", () => {
    const entry = toHistoryEntry(message())
    expect(entry).toMatchObject({
      providerID: "opendesign",
      modelID: "deepseek-v4.1-flash",
      cost: 0.3,
      input: 1_000_000,
      at: NOW,
    })
  })

  it("ignores a user message, which carries no charge", () => {
    expect(toHistoryEntry(message({ role: "user" }))).toBeUndefined()
  })

  it("ignores a row with no model, rather than attributing spend to nobody", () => {
    expect(toHistoryEntry(message({ modelID: undefined }))).toBeUndefined()
  })

  it("ignores a row with no timestamp, which cannot be bucketed", () => {
    expect(toHistoryEntry(message({ time: undefined }))).toBeUndefined()
  })

  it("ignores a row with neither cost nor tokens, which is not evidence", () => {
    expect(
      toHistoryEntry(
        message({ cost: 0, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } }),
      ),
    ).toBeUndefined()
  })

  it("survives malformed JSON instead of throwing", () => {
    expect(toHistoryEntry({ id: "x", data: "{not json" })).toBeUndefined()
  })

  it("treats a negative cost as zero rather than crediting the account", () => {
    const entry = toHistoryEntry(message({ cost: -5 }))
    expect(entry?.cost).toBe(0)
  })
})

describe("reading the database", () => {
  it("reports a missing database as a reason, not an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "router-history-"))
    const result = readOpenCodeHistory({ dbPath: join(dir, "absent.db") })
    expect(result.entries).toHaveLength(0)
    expect(result.reason).toMatch(/no opencode database/i)
  })

  it("reports a non-database file rather than crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "router-history-"))
    const path = join(dir, "junk.db")
    writeFileSync(path, "this is not sqlite")
    const result = readOpenCodeHistory({ dbPath: path })
    expect(result.entries).toHaveLength(0)
    expect(result.reason).toBeDefined()
  })

  // Unconditional, because this is the contract on the declared Node floor: a
  // build without `node:sqlite` must not throw, and must say why it has no
  // history. On a newer Node this asserts the inverse branch is unreachable
  // rather than skipping the file entirely.
  it("degrades to a reason when this Node build has no node:sqlite", () => {
    if (sqliteAvailable) {
      // Newer Node: the module exists, so the guarantee is that a real database
      // is actually read. Covered by the tests below.
      expect(typeof require("node:sqlite").DatabaseSync).toBe("function")
      return
    }
    const dir = mkdtempSync(join(tmpdir(), "router-history-"))
    const path = join(dir, "opencode.db")
    writeFileSync(path, "placeholder")
    const result = readOpenCodeHistory({ dbPath: path })
    expect(result.entries).toEqual([])
    expect(result.reason).toMatch(/node:sqlite/)
  })

  describeWithSqlite("with node:sqlite available", () => {

  it("reads real rows from a real database", () => {
    // Built with node:sqlite directly so the test exercises the same reader the
    // router uses, on a database it actually produced.
    const dir = mkdtempSync(join(tmpdir(), "router-history-"))
    const path = join(dir, "opencode.db")
    const { DatabaseSync } = require("node:sqlite")
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
    const insert = db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)")
    insert.run("m1", "s1", NOW, NOW, message({}, "m1").data)
    insert.run("m2", "s1", NOW - 1000, NOW - 1000, message({ cost: 0.15 }, "m2").data)
    insert.run("m3", "s1", NOW - 2000, NOW - 2000, message({ role: "user", cost: 0 }, "m3").data)
    db.close()

    const result = readOpenCodeHistory({ dbPath: path })
    expect(result.entries).toHaveLength(2)
    expect(result.entries.map((entry) => entry.id).sort()).toEqual(["m1", "m2"])
  })

  it("honours the time bound so a huge history stays cheap", () => {
    const dir = mkdtempSync(join(tmpdir(), "router-history-"))
    const path = join(dir, "opencode.db")
    const { DatabaseSync } = require("node:sqlite")
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
    const insert = db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)")
    insert.run("recent", "s1", NOW, NOW, message({}, "recent").data)
    insert.run("old", "s1", NOW - 90 * 86_400_000, NOW, message({}, "old").data)
    db.close()

    const result = readOpenCodeHistory({ dbPath: path, sinceMs: NOW - 7 * 86_400_000 })
    expect(result.entries.map((entry) => entry.id)).toEqual(["recent"])
  })
  })
})
