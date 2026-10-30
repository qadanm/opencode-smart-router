/**
 * Calibration tests.
 *
 * The behaviour under test is a policy decision, so these assert the things a
 * wrong implementation would silently get wrong: inventing over a floor from
 * thin evidence, letting a cheap afternoon drag the gate down indefinitely,
 * and moving the floor in the one direction that could exclude models the owner
 * already approved.
 */

import { describe, it, expect } from "vitest"
import {
  calibrateFloor,
  resolveIntelligenceFloor,
  CALIBRATION_TOLERANCE,
  MAX_CALIBRATION_DROP,
  MIN_REQUESTS_FOR_COST_EVIDENCE,
} from "../src/core/policy/calibration.js"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { buildRegistry } from "../src/core/models/registry.js"
import type { ModelRecord, RouterSettings } from "../src/core/types.js"

const settings = (overrides: Partial<RouterSettings["routing"]> = {}): RouterSettings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  routing: { ...structuredClone(DEFAULT_SETTINGS.routing), ...overrides },
})

/** A model list with a plausible spread of intelligence scores. */
const models = () => {
  const registry = buildRegistry({ live: [], settings: settings(), definitions: [] })
  return registry.approved()
}

const usage = (rows: Array<[string, string, number, number]>) =>
  rows.map(([providerID, modelID, requests, usd]) => ({ providerID, modelID, requests, usd }))

describe("calibration refuses to invent a threshold", () => {
  it("returns the configured floor when there is too little traffic", () => {
    const result = calibrateFloor({
      models: models(),
      usage: usage([["opencode-go", "claude-haiku-5-5", 2, 0.02]]),
      configuredFloor: 39.5,
      settings: settings(),
    })
    expect(result.calibrated).toBe(false)
    expect(result.floor).toBe(39.5)
    expect(result.baselineUsdPerRequest).toBeNull()
    expect(result.reason).toContain("not enough recorded traffic")
  })

  it("names the shortfall so the user knows what to wait for", () => {
    const result = calibrateFloor({
      models: models(),
      usage: usage([["opencode-go", "claude-haiku-5-5", 3, 0.03]]),
      configuredFloor: 39.5,
      settings: settings(),
    })
    expect(result.reason).toContain(String(MIN_REQUESTS_FOR_COST_EVIDENCE))
  })

  it("treats zero-cost traffic as unmeasurable rather than as free", () => {
    const result = calibrateFloor({
      models: models(),
      usage: usage([["opencode-go", "claude-haiku-5-5", 50, 0]]),
      configuredFloor: 39.5,
      settings: settings(),
    })
    expect(result.calibrated).toBe(false)
    expect(result.reason).toContain("no measurable cost")
  })

  it("ignores malformed rows instead of averaging them in", () => {
    const result = calibrateFloor({
      models: models(),
      usage: [
        ...usage([["opencode-go", "claude-haiku-5-5", 10, 1]]),
        { providerID: "x", modelID: "y", requests: Number.NaN, usd: 5 },
        { providerID: "x", modelID: "z", requests: 5, usd: Number.NaN },
        { providerID: "x", modelID: "w", requests: -3, usd: -1 },
      ],
      configuredFloor: 39.5,
      settings: settings(),
    })
    expect(result.baselineUsdPerRequest).toBeCloseTo(0.1, 6)
  })
})

describe("calibration derives the threshold from measured spend", () => {
  const registry = buildRegistry({ live: [], settings: settings(), definitions: [] })
  const approved = registry.approved()

  it("picks the most capable model that fits the measured budget", () => {
    // Give every approved model enough traffic at a cost proportional to its
    // list price, so the baseline is meaningful and the cheapest capable model
    // is identifiable.
    const rows = approved.map((model) => {
      const price = model.cost?.[0]?.input ?? 1
      return { providerID: model.providerID, modelID: model.modelID, requests: 20, usd: 20 * price * 0.001 }
    })
    const result = calibrateFloor({
      models: approved,
      usage: rows,
      configuredFloor: 39.5,
      settings: settings(),
    })
    expect(result.calibrated).toBe(true)
    expect(result.baselineUsdPerRequest).toBeGreaterThan(0)
    // The admitted model must be no more expensive than the ceiling, and its
    // score must be the floor in force.
    expect(result.admittedUsdPerRequest).not.toBeNull()
    expect(result.admittedUsdPerRequest!).toBeLessThanOrEqual(
      result.baselineUsdPerRequest! * CALIBRATION_TOLERANCE + 1e-9,
    )
    expect(result.floor).toBeLessThanOrEqual(39.5)
  })

  it("never raises the floor above the configured value", () => {
    // Every model priced absurdly high: nothing should fit the budget, and the
    // floor must not move up to compensate.
    const rows = approved.map((model) => ({
      providerID: model.providerID,
      modelID: model.modelID,
      requests: 10,
      usd: 0.01,
    }))
    const result = calibrateFloor({
      models: approved,
      usage: rows,
      configuredFloor: 39.5,
      settings: settings(),
    })
    expect(result.floor).toBeLessThanOrEqual(39.5)
  })

  it("clamps how far a cheap baseline may drag the floor down", () => {
    // hy3 scores 25.3, far below the 39.5 floor. A naive calibration would drop
    // the gate to 25.3 and send substantive work to a model this owner already
    // decided is too weak. The bound must stop that.
    const weak = approved.find((model) => model.modelID.includes("hy3") && !model.escalationOnly && !model.premium)
    if (!weak) return
    const result = calibrateFloor({
      models: approved,
      usage: [{ providerID: weak.providerID, modelID: weak.modelID, requests: 100, usd: 1 }],
      configuredFloor: 39.5,
      settings: settings(),
    })
    expect(result.calibrated).toBe(true)
    // The clamp, not the model's score, is what decides.
    expect(result.floor).toBe(39.5 - MAX_CALIBRATION_DROP)
    expect(result.floor).toBeGreaterThan(weak.intelligence)
  })

  it("does not admit escalation-only models", () => {
    // A cheap escalation-pool model must not become the threshold's reason,
    // because routine work may not drain that pool.
    //
    // Isolating the filter takes care: the clamp alone can mask a missing
    // filter when the pool model is far below the configured floor. So the
    // cheap escalation model here scores only slightly below the floor, inside
    // the calibration drop allowance. Filtered, nothing fits and the floor
    // stands. Unfiltered, the floor would drop to that model's score.
    const template = buildRegistry({ live: [], settings: settings(), definitions: [] })
      .approved()
      .find((model) => !model.premium)!
    const cheapEscalation: ModelRecord = {
      ...template,
      key: "opendesign/cheap-escalation",
      providerID: "opendesign",
      modelID: "cheap-escalation",
      name: "Cheap Escalation",
      // Just inside the calibration drop allowance, so the clamp cannot mask a
      // missing filter.
      intelligence: 35,
      escalationOnly: true,
      premium: false,
    }

    const result = calibrateFloor({
      models: [cheapEscalation],
      usage: [{ providerID: "opendesign", modelID: "cheap-escalation", requests: 50, usd: 0.05 }],
      configuredFloor: 39.5,
      settings: settings(),
    })
    expect(result.calibrated).toBe(false)
    expect(result.floor).toBe(39.5)
  })

  it("refuses to calibrate on models with no recorded traffic", () => {
    const result = calibrateFloor({
      models: approved,
      usage: usage([["opencode-go", "not-a-real-model", 100, 1]]),
      configuredFloor: 39.5,
      settings: settings(),
    })
    expect(result.calibrated).toBe(false)
  })
})

describe("calibration is opt-in and cannot reach offline mode", () => {
  const registry = buildRegistry({ live: [], settings: settings(), definitions: [] })
  const approved = registry.approved()
  const rows = approved.map((model) => ({
    providerID: model.providerID,
    modelID: model.modelID,
    requests: 20,
    usd: 0.02,
  }))

  it("is off by default", () => {
    expect(DEFAULT_SETTINGS.routing.calibrateFloor).toBe(false)
  })

  it("returns the configured floor when the flag is off", () => {
    const result = resolveIntelligenceFloor(settings(), { models: approved, usage: rows })
    expect(result.calibrated).toBe(false)
    expect(result.floor).toBe(39.5)
  })

  it("does not calibrate while offline", () => {
    const offline = {
      ...settings({ calibrateFloor: true }),
      offline: { ...structuredClone(DEFAULT_SETTINGS.offline!), enabled: true },
    }
    const result = resolveIntelligenceFloor(offline, { models: approved, usage: rows })
    expect(result.calibrated).toBe(false)
    expect(result.floor).toBe(39.5)
  })
})
