import { describe, expect, it } from "vitest"
import { LedgerStore, emptyLedger, hydrateLedger } from "../src/core/quota/ledger.js"

/**
 * The plan-model pool ledger: the $120/month allowance is tracked separately
 * from Design Plan credits, survives restarts, and accounts for in-flight
 * spending recorded concurrently.
 */

const NOW = Date.UTC(2026, 10, 6, 12)

const usage = (cost: number, at = NOW) => ({
  sessionID: "ses_pool",
  model: { providerID: "opendesign", id: "claude-sonnet-5.5" },
  cost,
  tokens: { input: 1_000, output: 100, cache: { read: 0, write: 0 } },
  at,
  premium: true,
  planPool: true,
})

describe("the plan-model pool ledger", () => {
  it("accrues plan-pool spend in a monthly bucket, separate from premium spend", () => {
    const ledger = new LedgerStore()
    ledger.recordUsage(usage(3.5))
    ledger.recordUsage(usage(2.5))
    expect(ledger.planPoolSpent()).toBeCloseTo(6)
    expect(ledger.premiumSpent()).toBeCloseTo(6)
  })

  it("does not count ordinary premium spend toward the plan pool", () => {
    const ledger = new LedgerStore()
    ledger.recordUsage({
      sessionID: "ses_pool",
      model: { providerID: "commandcode", id: "claude-sonnet-5-5" },
      cost: 4,
      tokens: { input: 1_000, output: 100, cache: { read: 0, write: 0 } },
      at: NOW,
      premium: true,
    })
    expect(ledger.planPoolSpent()).toBe(0)
    expect(ledger.premiumSpent()).toBeCloseTo(4)
  })

  it("attributes spend to the month of the event, not the wall clock", () => {
    const ledger = new LedgerStore()
    const october = Date.UTC(2026, 9, 20, 12)
    ledger.recordUsage(usage(5, october))
    ledger.recordUsage(usage(2, NOW))
    expect(ledger.planPoolSpent("2026-11")).toBeCloseTo(2)
    expect(ledger.planPoolSpent("2026-10")).toBeCloseTo(5)
  })

  it("persists across restarts through hydrate", () => {
    const ledger = new LedgerStore()
    ledger.recordUsage(usage(6))
    const saved = JSON.parse(JSON.stringify(ledger.export()))
    const revived = hydrateLedger(saved)
    expect(revived.ledger.planPoolSpend.find((entry) => entry.month === "2026-11")?.usd).toBeCloseTo(6)
  })

  it("survives a hand-written ledger file that predates the bucket", () => {
    const saved = emptyLedger(NOW)
    saved.usage.push({
      id: "use_1",
      at: NOW,
      providerID: "opendesign",
      modelID: "claude-sonnet-5.5",
      usd: 2,
      input: 10,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      source: "step",
    })
    const hydrated = hydrateLedger(JSON.parse(JSON.stringify(saved)))
    expect(hydrated.ledger.planPoolSpend).toHaveLength(0)
  })
})
