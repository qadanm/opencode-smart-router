import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseAccountReading, parseResetIn, writeSettingsPatch } from "../src/core/config-writer.js"

/**
 * The GUI writes config now, so this file needs the paranoia of a file format.
 *
 * The two ways a config writer ruins someone's day are losing the keys it did not
 * understand and leaving a half-written file behind. Both are tested here, along
 * with the parsing that exists so a user can paste "42%" instead of working out
 * that it means $37.80.
 */

const tempPath = () => join(mkdtempSync(join(tmpdir(), "router-writer-")), "smart-router.json")

describe("writing config preserves what it does not own", () => {
  it("keeps unknown and unrelated keys", () => {
    const path = tempPath()
    writeFileSync(
      path,
      JSON.stringify({
        mode: "premium",
        ui: { titleIndicator: false },
        providers: { opendesign: { enabled: true, plan: "pro" } },
        somethingFromTheFuture: { nested: [1, 2, 3] },
      }),
    )

    writeSettingsPatch({ path, patch: { providers: { opendesign: { baseline: { at: 1, designPlanUsedPct: 42 } } } } })

    const after = JSON.parse(readFileSync(path, "utf8"))
    expect(after.mode).toBe("premium")
    expect(after.ui.titleIndicator).toBe(false)
    expect(after.providers.opendesign.enabled).toBe(true)
    expect(after.providers.opendesign.plan).toBe("pro")
    expect(after.somethingFromTheFuture).toEqual({ nested: [1, 2, 3] })
    expect(after.providers.opendesign.baseline.designPlanUsedPct).toBe(42)
  })

  it("refuses to overwrite a file it cannot parse", () => {
    const path = tempPath()
    writeFileSync(path, "{ this is not json ")
    expect(() => writeSettingsPatch({ path, patch: { a: 1 } })).toThrow(/refusing to overwrite/i)
    expect(readFileSync(path, "utf8")).toBe("{ this is not json ")
  })

  it("makes a backup before replacing, and keeps them bounded", () => {
    const path = tempPath()
    writeFileSync(path, JSON.stringify({ a: 1 }))
    for (let i = 0; i < 8; i += 1) {
      writeSettingsPatch({ path, patch: { a: i + 2 }, now: () => 1_700_000_000_000 + i })
    }
    const backups = readdirSync(join(path, "..")).filter((entry) => entry.includes(".bak-"))
    expect(backups.length).toBeLessThanOrEqual(5)
  })

  it("does not apply a patch the validator rejects", () => {
    const path = tempPath()
    writeFileSync(path, JSON.stringify({ a: 1 }))
    expect(() =>
      writeSettingsPatch({ path, patch: { a: 2 }, validate: () => "nope" }),
    ).toThrow("nope")
    expect(JSON.parse(readFileSync(path, "utf8")).a).toBe(1)
  })

  it("leaves no temp file behind", () => {
    const path = tempPath()
    writeFileSync(path, JSON.stringify({ a: 1 }))
    writeSettingsPatch({ path, patch: { a: 2 } })
    expect(readdirSync(join(path, "..")).some((entry) => entry.includes(".tmp-"))).toBe(false)
  })

  it("reports which keys it changed", () => {
    const path = tempPath()
    writeFileSync(path, JSON.stringify({ a: 1 }))
    const result = writeSettingsPatch({ path, patch: { providers: { opendesign: { baseline: { at: 1 } } } } })
    expect(result.changed).toEqual(["providers.opendesign.baseline.at"])
  })
})

describe("pasting a figure from the account page", () => {
  it("reads a percentage the way the page writes it", () => {
    expect(parseAccountReading("42%")).toEqual({ kind: "pct", value: 42 })
    expect(parseAccountReading(" 42 % ")).toEqual({ kind: "pct", value: 42 })
  })

  it("reads a bare number as a percentage, because that is the page's shape", () => {
    expect(parseAccountReading("42")).toEqual({ kind: "pct", value: 42 })
  })

  it("reads a dollar amount when one is given", () => {
    expect(parseAccountReading("$37.80")).toEqual({ kind: "usd", value: 37.8 })
    expect(parseAccountReading("$1,234.50")).toEqual({ kind: "usd", value: 1234.5 })
  })

  it("accepts the edge cases that are real readings", () => {
    expect(parseAccountReading("0%")).toEqual({ kind: "pct", value: 0 })
    expect(parseAccountReading("100%")).toEqual({ kind: "pct", value: 100 })
    expect(parseAccountReading("$0")).toEqual({ kind: "usd", value: 0 })
  })

  it("refuses nonsense instead of guessing", () => {
    expect(parseAccountReading("")).toBeUndefined()
    expect(parseAccountReading("lots")).toBeUndefined()
  })
})

describe("parsing the reset phrase", () => {
  const NOW = 1_700_000_000_000

  it("reads the page's own format", () => {
    expect(parseResetIn("0d 23h", NOW)).toBe(NOW + 23 * 3_600_000)
    expect(parseResetIn("in 0 days 23 hours", NOW)).toBe(NOW + 23 * 3_600_000)
  })

  it("reads hours and minutes", () => {
    expect(parseResetIn("90m", NOW)).toBe(NOW + 90 * 60_000)
    expect(parseResetIn("2h 30m", NOW)).toBe(NOW + (2 * 60 + 30) * 60_000)
  })

  it("accepts an absolute timestamp", () => {
    expect(parseResetIn("2026-11-05T03:00:00Z", NOW)).toBe(Date.parse("2026-11-05T03:00:00Z"))
  })

  it("returns undefined rather than inventing a time", () => {
    expect(parseResetIn("", NOW)).toBeUndefined()
    expect(parseResetIn("soon", NOW)).toBeUndefined()
  })
})
