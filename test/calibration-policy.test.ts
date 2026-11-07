import { describe, expect, it } from "vitest"

import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { DEFAULT_OFFLINE_SETTINGS } from "../src/core/offline/mode.js"
import {
  CALIBRATION_TOLERANCE,
  MAX_CALIBRATION_DROP,
  MIN_REQUESTS_FOR_COST_EVIDENCE,
  calibrateFloor,
  resolveIntelligenceFloor,
} from "../src/core/policy/calibration.js"
import type { ModelRecord, RouterSettings } from "../src/core/types.js"

/**
 * THE CALIBRATED FLOOR, AT ITS OWN SEAM.
 *
 * These properties were listed as unguarded by the mutation harness: reverting
 * each one left `test/calibration.test.ts` green, because that file covers a
 * different module (the estimator's margin) and never calls `calibrateFloor`.
 * The properties were real, the guard was pointed at the wrong place.
 *
 * `calibrateFloor` decides how capable a model must be before the router will
 * use it. A defect here is silent rather than loud: routing simply becomes
 * cheaper and worse, with no error, and the status report still says
 * "calibrated". So each bound gets a test that fails if the bound is removed.
 *
 * Every test constructs its own models and usage rows instead of leaning on the
 * seed catalog. Calibration is arithmetic over recorded traffic, and the fixture
 * should state that arithmetic explicitly.
 */

const settings = (routing: Partial<RouterSettings["routing"]> = {}, offline = false): RouterSettings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  routing: { ...structuredClone(DEFAULT_SETTINGS.routing), ...routing },
  ...(offline ? { offline: { ...structuredClone(DEFAULT_OFFLINE_SETTINGS), enabled: true } } : {}),
})

const model = (overrides: Partial<ModelRecord> = {}): ModelRecord =>
  ({
    key: "test/provider-model",
    providerID: "test",
    modelID: "provider-model",
    name: "Test",
    context: 1_000_000,
    maxOutput: 64_000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    tools: true,
    cost: [{ input: 2, output: 10 }],
    intelligence: 55,
    design: 50,
    designEvidence: "curated",
    premium: false,
    training: false,
    free: false,
    tier: 3,
    approved: true,
    approvalSource: "seed",
    monthlyAllowanceUsd: 0,
    ...overrides,
  }) as ModelRecord

/** One model at a stated capability and per-request cost. */
const priced = (modelID: string, intelligence: number, usdPerRequest: number, extra: Partial<ModelRecord> = {}) =>
  model({ modelID, key: `test/${modelID}`, intelligence, ...extra })

const usageFor = (entries: ReadonlyArray<{ model: ModelRecord; usdPerRequest: number; requests?: number }>) =>
  entries.map((entry) => ({
    providerID: entry.model.providerID,
    modelID: entry.model.modelID,
    requests: entry.requests ?? 20,
    usd: (entry.requests ?? 20) * entry.usdPerRequest,
  }))

const calibrate = (input: {
  models: ReadonlyArray<ModelRecord>
  usage: ReadonlyArray<{ providerID: string; modelID: string; requests: number; usd: number }>
  configuredFloor?: number
  routing?: Partial<RouterSettings["routing"]>
}) =>
  calibrateFloor({
    models: input.models,
    usage: input.usage,
    configuredFloor: input.configuredFloor ?? 39.5,
    settings: settings(input.routing),
  })

describe("calibration refuses to invent a floor from thin evidence", () => {
  it("keeps the configured floor below the evidence minimum", () => {
    const strong = priced("strong", 90, 0.01)
    const result = calibrate({
      models: [strong],
      usage: usageFor([{ model: strong, usdPerRequest: 0.01, requests: MIN_REQUESTS_FOR_COST_EVIDENCE - 1 }]),
      configuredFloor: 39.5,
    })

    // Four requests is a coincidence, not a measurement. The configured floor
    // must survive intact, and the result must not claim it was derived.
    expect(result.calibrated).toBe(false)
    expect(result.floor).toBe(39.5)
    expect(result.reason).toContain("not enough recorded traffic")
  })

  it("calibrates once the evidence minimum is met, so the bound is a minimum and not a veto", () => {
    const strong = priced("strong", 90, 0.01)
    const result = calibrate({
      models: [strong],
      usage: usageFor([{ model: strong, usdPerRequest: 0.01, requests: MIN_REQUESTS_FOR_COST_EVIDENCE }]),
      configuredFloor: 39.5,
    })
    expect(result.calibrated).toBe(true)
  })
})

describe("calibration only ever lowers the floor", () => {
  it("never raises the floor above the configured value", () => {
    // A cheap, very capable model would let an unchecked algorithm set the floor
    // to 95. Calibration is not a quality ratchet: it may only relax the floor
    // toward what the owner already spends, never tighten it.
    const exceptional = priced("exceptional", 95, 0.001)
    const result = calibrate({
      models: [exceptional],
      usage: usageFor([{ model: exceptional, usdPerRequest: 0.001 }]),
      configuredFloor: 39.5,
    })

    expect(result.calibrated).toBe(true)
    expect(result.floor).toBeLessThanOrEqual(39.5)
  })

  it("never drops further than the configured maximum in one calibration", () => {
    // A cheap weak model is admitted at intelligence 10. Without the bound the
    // floor would fall to 10 and the router would start choosing models the
    // owner never agreed to run, based on a single week of cost data.
    const cheapWeak = priced("cheap-weak", 10, 0.001)
    const result = calibrate({
      models: [cheapWeak],
      usage: usageFor([{ model: cheapWeak, usdPerRequest: 0.001 }]),
      configuredFloor: 39.5,
    })

    expect(result.calibrated).toBe(true)
    expect(result.floor).toBeGreaterThanOrEqual(39.5 - MAX_CALIBRATION_DROP)
  })

  it("moves by whole points inside both bounds", () => {
    // 20 is far below 39.5 minus 12, so the drop bound is the binding
    // constraint and the floor should stop at exactly that value rather than
    // following the model down.
    const farBelow = priced("far-below", 20, 0.001)
    const result = calibrate({
      models: [farBelow],
      usage: usageFor([{ model: farBelow, usdPerRequest: 0.001 }]),
      configuredFloor: 39.5,
    })
    expect(result.floor).toBe(39.5 - MAX_CALIBRATION_DROP)
  })

  it("follows the model when it lands inside the bounds", () => {
    // 35 is inside [27.5, 39.5], so the model's own score is what should be
    // used. Without this the previous test could pass on a hard-coded value.
    const inside = priced("inside", 35, 0.001)
    const result = calibrate({
      models: [inside],
      usage: usageFor([{ model: inside, usdPerRequest: 0.001 }]),
      configuredFloor: 39.5,
    })
    expect(result.floor).toBe(35)
  })
})

describe("calibration ignores models it must not learn from", () => {
  it("never calibrates on an escalation-pool model", () => {
    // The escalation pool is paid from a separate allowance. Letting it set the
    // floor spends the owner's plan budget on defining a threshold for ordinary
    // work, which is exactly the confusion this release exists to remove.
    const escalation = priced("flagship", 99, 0.001, { escalationOnly: true })
    const ordinary = priced("ordinary", 40, 0.5)
    const result = calibrate({
      models: [escalation, ordinary],
      usage: usageFor([
        { model: escalation, usdPerRequest: 0.001 },
        { model: ordinary, usdPerRequest: 0.5 },
      ]),
      configuredFloor: 39.5,
    })

    // Escalation-only is excluded, so the admitted model is the ordinary one.
    expect(result.reason).not.toContain("flagship")
  })

  it("never calibrates on a premium model", () => {
    const premium = priced("premium-model", 99, 0.001, { premium: true })
    const ordinary = priced("ordinary", 40, 0.5)
    const result = calibrate({
      models: [premium, ordinary],
      usage: usageFor([
        { model: premium, usdPerRequest: 0.001 },
        { model: ordinary, usdPerRequest: 0.5 },
      ]),
      configuredFloor: 39.5,
    })
    expect(result.reason).not.toContain("premium-model")
  })

  it("never calibrates on a model with no recorded traffic", () => {
    // Substituting a list price for a missing measurement calibrates against the
    // vendor's assumptions rather than this owner's usage. The unmeasured model
    // must be ignored even though it is cheap and capable.
    const measured = priced("measured", 40, 0.2)
    const unmeasured = priced("unmeasured", 99, 0.0001)
    const result = calibrate({
      models: [measured, unmeasured],
      usage: usageFor([{ model: measured, usdPerRequest: 0.2 }]),
      configuredFloor: 39.5,
    })

    expect(result.reason).toContain("measured")
    expect(result.reason).not.toContain("unmeasured")
  })

  it("does not admit a model priced above the measured baseline plus tolerance", () => {
    // The baseline is what the owner already spends per request. A model costing
    // materially more than that is not a cost-neutral replacement, however
    // capable it is.
    const baselineModel = priced("baseline-model", 40, 0.1)
    const tooDear = priced("too-dear", 95, 0.1 * CALIBRATION_TOLERANCE * 1.5)
    const result = calibrate({
      models: [baselineModel, tooDear],
      usage: usageFor([
        { model: baselineModel, usdPerRequest: 0.1, requests: 100 },
        { model: tooDear, usdPerRequest: 0.1 * CALIBRATION_TOLERANCE * 1.5, requests: 1 },
      ]),
      configuredFloor: 39.5,
    })

    expect(result.reason).not.toContain("too-dear")
  })
})

describe("zero-cost traffic is not evidence of free inference", () => {
  it("refuses to calibrate when recorded traffic has no measurable cost", () => {
    // A zero baseline means the arithmetic would divide by a number that says
    // nothing. Treating it as a valid baseline admits every model for free,
    // because any per-request cost satisfies a zero ceiling.
    const any = priced("any", 55, 0)
    const result = calibrate({
      models: [any],
      usage: usageFor([{ model: any, usdPerRequest: 0 }]),
      configuredFloor: 39.5,
    })

    expect(result.calibrated).toBe(false)
    expect(result.floor).toBe(39.5)
    expect(result.reason).toContain("no measurable cost")
  })
})

describe("calibration is opt-in and stays out of offline mode", () => {
  it("does not run when the owner has not enabled it", () => {
    const cheapWeak = priced("cheap-weak", 10, 0.001)
    // The opt-in gate lives in the resolver, which is what routing calls. The
    // pure function is arithmetic and has no opinion about policy.
    const result = resolveIntelligenceFloor(settings({ calibrateFloor: false }), {
      models: [cheapWeak],
      usage: usageFor([{ model: cheapWeak, usdPerRequest: 0.001 }]),
    })

    expect(result.calibrated).toBe(false)
    expect(result.floor).toBe(39.5)
  })

  it("does not change offline behavior even when enabled", () => {
    // Offline mode has its own allow-list and its own exemption from the floor.
    // Calibration is an online cost concern, so it must not move the offline
    // floor in either direction.
    const cheapWeak = priced("cheap-weak", 10, 0.001)
    const online = resolveIntelligenceFloor(settings({ calibrateFloor: true }), {
      models: [cheapWeak],
      usage: usageFor([{ model: cheapWeak, usdPerRequest: 0.001 }]),
    })
    const offline = resolveIntelligenceFloor(settings({ calibrateFloor: true }, true), {
      models: [cheapWeak],
      usage: usageFor([{ model: cheapWeak, usdPerRequest: 0.001 }]),
    })

    // The online run calibrates (so this test cannot pass by calibration being
    // inert), and the offline run returns the configured floor unchanged.
    expect(online.calibrated).toBe(true)
    expect(offline.calibrated).toBe(false)
    expect(offline.floor).toBe(39.5)
  })
})
