import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { LedgerStore, emptyLedger, hydrateLedger } from "../src/core/quota/ledger.js"
import { buildRegistry } from "../src/core/models/registry.js"
import type { ProviderQuotaSnapshot } from "../src/core/types.js"

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)
const deepseek = { providerID: "opencode-go", id: "deepseek-v4.1-flash" }
const glm = { providerID: "opencode-go", id: "glm-5.3-flash" }

const providerSnapshot = (overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot => ({
  providerID: "opencode-go",
  label: "OpenCode Go Plus",
  plan: "go-plus",
  source: "provider",
  fetchedAt: NOW,
  stale: false,
  rolling: { usedPct: 8, remainingPct: 92, usedUsd: 1, capUsd: 14, resetsAt: NOW + 3_600_000, source: "provider" },
  weekly: { usedPct: 39, remainingPct: 61, usedUsd: 20, capUsd: 35, resetsAt: NOW + 86_400_000, source: "provider" },
  monthly: { usedPct: 69, remainingPct: 31, usedUsd: 40, capUsd: 70, resetsAt: NOW + 20 * 86_400_000, source: "provider" },
  models: {},
  notes: [],
  ...overrides,
})

describe("usage ledger", () => {
  it("records step usage and updates session context", () => {
    const ledger = new LedgerStore()
    ledger.recordUsage({
      sessionID: "ses_1",
      model: deepseek,
      cost: 0.01,
      tokens: { input: 1000, output: 200, cache: { read: 50_000, write: 0 } },
      at: NOW,
      latencyMs: 1200,
      premium: false,
    })
    expect(ledger.data.metrics.requests).toBe(1)
    expect(ledger.data.metrics.estimatedUsd).toBeCloseTo(0.01)
    expect(ledger.data.metrics.latencySamples).toBe(1)
    expect(ledger.getSession("ses_1")?.contextTokens).toBe(51_000)
    expect(ledger.getSession("ses_1")?.cacheReadTokens).toBe(50_000)
  })

  it("keeps five-hour, weekly and monthly usage separate", () => {
    const ledger = new LedgerStore()
    ledger.recordUsage({
      sessionID: "ses_1",
      model: deepseek,
      cost: 1,
      tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      at: NOW - 6 * 60 * 60 * 1000,
    })
    ledger.recordUsage({
      sessionID: "ses_1",
      model: deepseek,
      cost: 2,
      tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      at: NOW - 2 * 60 * 60 * 1000,
    })
    ledger.recordUsage({
      sessionID: "ses_1",
      model: deepseek,
      cost: 4,
      tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      at: NOW - 8 * 24 * 60 * 60 * 1000,
    })
    const totals = ledger.totalsForModel(deepseek.providerID, deepseek.id, { now: NOW })
    expect(totals.fiveHourUsd).toBe(2)
    expect(totals.weeklyUsd).toBe(3)
    expect(totals.monthlyUsd).toBe(7)
  })

  it("attributes concurrent sessions without corrupting shared totals", () => {
    const ledger = new LedgerStore()
    for (let index = 0; index < 50; index += 1) {
      ledger.recordUsage({
        sessionID: `ses_${index % 5}`,
        model: index % 2 === 0 ? deepseek : glm,
        cost: 0.01,
        tokens: { input: 10, output: 10, cache: { read: 100, write: 0 } },
        at: NOW,
      })
    }
    expect(ledger.data.metrics.requests).toBe(50)
    expect(ledger.totalsForModel(deepseek.providerID, deepseek.id, { now: NOW }).requests).toBe(25)
    expect(ledger.totalsForModel(glm.providerID, glm.id, { now: NOW }).requests).toBe(25)
    expect(ledger.data.metrics.byModel["opencode-go/deepseek-v4.1-flash"]?.usd).toBeCloseTo(0.25)
  })

  it("blocks an estimated model route at its monthly allowance", () => {
    const ledger = new LedgerStore()
    const registry = buildRegistry({ live: [], settings: DEFAULT_SETTINGS })
    const model = registry.get("opencode-go", "deepseek-v4.1-flash")!
    ledger.recordUsage({
      sessionID: "ses_1",
      model: deepseek,
      cost: model.monthlyAllowanceUsd + 1,
      tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      at: NOW,
    })
    const snapshot = providerSnapshot()
    const enriched = ledger.attachModelQuotas(snapshot, [model], DEFAULT_SETTINGS.providers["opencode-go"]!, NOW)
    const quota = enriched.models["opencode-go/deepseek-v4.1-flash"]!
    expect(quota.blocked).toBe(true)
    expect(quota.blockReason).toMatch(/monthly/i)
  })

  it("bootstraps recent sessions once and attributes cost to the selected model", () => {
    const ledger = new LedgerStore()
    const first = ledger.bootstrap(
      [
        { id: "ses_1", model: deepseek, cost: 2, updatedAt: NOW - 86_400_000, tokens: { input: 10, output: 5, cache: { read: 100, write: 0 } } },
        { id: "ses_2", model: glm, cost: 3, updatedAt: NOW - 2 * 86_400_000 },
        { id: "ses_3", model: deepseek, cost: 0, updatedAt: NOW },
      ],
      { days: 31, limit: 100, now: NOW },
    )
    expect(first.added).toBe(2)
    expect(ledger.totalsForModel(deepseek.providerID, deepseek.id, { now: NOW }).monthlyUsd).toBe(2)
    const second = ledger.bootstrap([{ id: "ses_4", model: deepseek, cost: 9, updatedAt: NOW }], { days: 31, limit: 100, now: NOW })
    expect(second.skipped).toBe(true)
  })

  it("keeps premium spend in a separate monthly pool", () => {
    const ledger = new LedgerStore()
    ledger.recordUsage({
      sessionID: "ses_1",
      model: { providerID: "commandcode", id: "claude-sonnet-5-5" },
      cost: 0.4,
      tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      at: NOW,
      premium: true,
    })
    expect(ledger.premiumSpent()).toBeCloseTo(0.4)
    expect(ledger.data.metrics.premiumRequests).toBe(1)
  })

  it("hydrates saved state and ignores corrupt entries", () => {
    const saved = emptyLedger(NOW)
    saved.usage.push({
      id: "use_1",
      at: NOW,
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
      usd: 1,
      input: 10,
      output: 1,
      cacheRead: 100,
      cacheWrite: 0,
      source: "step",
    })
    saved.sessions["ses_1"] = {
      sessionID: "ses_1",
      manualOverride: true,
      premiumOneShot: false,
      paused: false,
      contextTokens: 123,
      cacheReadTokens: 100,
      stepCount: 1,
      status: "idle",
      failures: [],
      retries: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }
    const hydrated = hydrateLedger(JSON.parse(JSON.stringify(saved)))
    expect(hydrated.ledger.usage).toHaveLength(1)
    expect(hydrated.ledger.sessions["ses_1"]?.manualOverride).toBe(true)
    const corrupt = hydrateLedger({ version: 1, usage: [{ bad: true }], sessions: { x: { sessionID: 4 } } })
    expect(corrupt.ledger.usage).toHaveLength(0)
    expect(Object.keys(corrupt.ledger.sessions)).toHaveLength(0)
  })
})
