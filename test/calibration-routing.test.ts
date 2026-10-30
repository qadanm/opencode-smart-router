/**
 * Calibration must reach routing, not just compute a number.
 *
 * The regression this exists for: the intelligence floor was hand-picked, sat
 * below the cheapest eligible model, and therefore changed nothing. A
 * calibration module that produced a correct figure which routing then ignored
 * would be the same failure with more code. These tests drive the real engine.
 */

import { describe, it, expect } from "vitest"
import { routeTask, estimateSuccess } from "../src/core/routing/engine.js"
import { classifyTask } from "../src/core/classify/classifier.js"
import { buildRegistry } from "../src/core/models/registry.js"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { calibrateFloor } from "../src/core/policy/calibration.js"
import type { RouterSettings } from "../src/core/types.js"

const settings = (): RouterSettings => structuredClone(DEFAULT_SETTINGS)

const route = (s: RouterSettings, floor: number | undefined, contextTokens = 10_000) => {
  const task = classifyTask({
    text: "implement a small feature in src/app.ts",
    files: [],
    contextTokens,
    recentFailures: 0,
  })
  const registry = buildRegistry({ live: [], settings: s, definitions: [] })
  const decision = routeTask({
    task,
    settings: s,
    mode: s.mode,
    runtime: "automatic",
    models: registry.approved(),
    intelligenceFloor: floor,
    session: {
      sessionID: "ses_calibration",
      manualOverride: false,
      premiumOneShot: false,
      paused: false,
      contextTokens,
      cacheReadTokens: 0,
      stepCount: 2,
      status: "idle",
      failures: [],
      retries: 0,
      createdAt: 0,
      updatedAt: 0,
    },
    quota: [],
    premium: { mode: "off", monthlyBudgetUsd: 0, spentUsd: 0, remainingUsd: 0, oneShotGranted: false },
    contextTokens,
    cachedTokens: 0,
    dryRun: false,
    now: 0,
  })
  return decision.decision
}

const chosenKey = (decision: { chosen?: { providerID: string; id: string } }) =>
  decision.chosen ? `${decision.chosen.providerID}/${decision.chosen.id}` : "BLOCKED"

describe("the floor in force is the one the caller passes", () => {
  it("routes identically when no override is supplied", () => {
    // Existing callers must be unaffected: no override means the configured
    // floor, and the decision is the same as before calibration existed.
    const configured = route(settings(), undefined)
    const explicit = route(settings(), settings().routing.intelligenceFloor)
    expect(chosenKey(configured)).toBe(chosenKey(explicit))
  })

  it("a high floor refuses a weak model that a low floor would accept", () => {
    // mimo-v2.6-flash scores 37.9. Above 37.9 it must be excluded from
    // substantive work; below it, it becomes routable. That is the mechanism
    // calibration moves.
    const high = route(settings(), 39.5)
    const low = route(settings(), 30)
    expect(chosenKey(high)).not.toBe("BLOCKED")
    // Both may still pick the same cheap model when it clears the bar, so the
    // assertion is on eligibility, not on which model won.
    const weakAbove = high.candidates.some((c) => c.model.modelID.includes("mimo-v2.6-flash") && c.eligible)
    const weakBelow = low.candidates.some((c) => c.model.modelID.includes("mimo-v2.6-flash") && c.eligible)
    expect(weakAbove).toBe(false)
    expect(weakBelow).toBe(true)
  })

  it("admits only models at or above the floor in force", () => {
    // Ineligible candidates are dropped from the reported list rather than
    // listed with a reason, so the observable contract is that every survivor
    // clears the floor the caller passed. At 45 only mimo-v2.6-pro (46.3) can
    // survive; at 30 far more models qualify.
    const strict = route(settings(), 45)
    expect(strict.candidates.length).toBeGreaterThan(0)
    expect(
      strict.candidates.every((c) => {
        const model = buildRegistry({ live: [], settings: settings(), definitions: [] }).get(
          c.model.providerID,
          c.model.modelID,
        )
        return model === undefined || model.intelligence >= 45
      }),
    ).toBe(true)

    const relaxed = route(settings(), 30)
    expect(relaxed.candidates.length).toBeGreaterThan(strict.candidates.length)
  })
})

describe("the success estimate reads the floor in force", () => {
  const registry = () => buildRegistry({ live: [], settings: settings(), definitions: [] })

  it("penalises a below-floor model differently depending on the floor", () => {
    // mimo-v2.6-flash scores 37.9. Under a 39.5 floor it is below the bar and
    // takes the capability penalty; under a 30 floor it clears the bar and does
    // not. A literal 39.5 in estimateSuccess would return the same probability
    // for both, which is the drift this pins.
    const model = registry()
      .approved()
      .find((entry) => entry.modelID.includes("mimo-v2.6-flash"))
    expect(model).toBeDefined()
    const task = classifyTask({
      text: "implement a small feature in src/app.ts",
      files: [],
      contextTokens: 10_000,
      recentFailures: 0,
    })

    const strict = estimateSuccess({ model: model!, task, contextTokens: 10_000, intelligenceFloor: 39.5 })
    const relaxed = estimateSuccess({ model: model!, task, contextTokens: 10_000, intelligenceFloor: 30 })
    expect(strict).toBeLessThan(relaxed)
  })

  it("defaults to the configured floor when no override is given", () => {
    // Existing callers pass no floor and must behave exactly as before.
    const model = registry()
      .approved()
      .find((entry) => entry.modelID.includes("mimo-v2.6-flash"))
    const task = classifyTask({
      text: "implement a small feature in src/app.ts",
      files: [],
      contextTokens: 10_000,
      recentFailures: 0,
    })
    const implicit = estimateSuccess({ model: model!, task, contextTokens: 10_000 })
    const explicit = estimateSuccess({ model: model!, task, contextTokens: 10_000, intelligenceFloor: 39.5 })
    expect(implicit).toBe(explicit)
  })
})

describe("calibration reaches routing end to end", () => {
  it("produces a floor that the engine accepts without error", () => {
    const s = settings()
    const registry = buildRegistry({ live: [], settings: s, definitions: [] })
    const approved = registry.approved()
    const usage = approved.map((model) => ({
      providerID: model.providerID,
      modelID: model.modelID,
      requests: 25,
      usd: 25 * (model.cost?.[0]?.input ?? 1) * 0.002,
    }))
    const calibration = calibrateFloor({
      models: approved,
      usage,
      configuredFloor: s.routing.intelligenceFloor,
      settings: s,
    })
    expect(calibration.calibrated).toBe(true)

    const decision = route(s, calibration.floor)
    expect(decision.error).toBeUndefined()
    // Whatever it picks must respect the calibrated floor for substantive work.
    if (decision.chosen) {
      const chosen = decision.candidates.find(
        (c) =>
          c.model.providerID === decision.chosen!.providerID &&
          c.model.modelID === decision.chosen!.id,
      )
      expect(chosen?.eligible).toBe(true)
    }
  })
})
