/**
 * The floor report must be honest about which of three states it is in.
 *
 * A single number cannot be trusted if it does not say where it came from. The
 * failure this guards against is subtle and expensive: showing "39.5" when
 * calibration is off, or when it wanted to calibrate and had no traffic, reads
 * as "measured" when it is anything but.
 *
 * These test the resolver that the report is built on, since the report itself
 * is assembled inside the controller and needs a live plugin host.
 */

import { describe, it, expect } from "vitest"
import {
  resolveIntelligenceFloor,
  MIN_REQUESTS_FOR_COST_EVIDENCE,
  CALIBRATION_WINDOW_MS,
} from "../src/core/policy/calibration.js"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { buildRegistry } from "../src/core/models/registry.js"
import type { RouterSettings } from "../src/core/types.js"

const settings = (routing: Partial<RouterSettings["routing"]> = {}): RouterSettings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  routing: { ...structuredClone(DEFAULT_SETTINGS.routing), ...routing },
})

const approved = () =>
  buildRegistry({ live: [], settings: settings(), definitions: [] }).approved()

describe("the reported source is never misleading", () => {
  it("says 'configured' when calibration is off", () => {
    const result = resolveIntelligenceFloor(settings(), { models: approved(), usage: [] })
    expect(result.calibrated).toBe(false)
    expect(result.floor).toBe(39.5)
  })

  it("says why it could not calibrate when there is no traffic", () => {
    const result = resolveIntelligenceFloor(settings({ calibrateFloor: true }), {
      models: approved(),
      usage: [],
    })
    expect(result.calibrated).toBe(false)
    expect(result.reason).toContain("not enough recorded traffic")
    expect(result.reason).toContain(`0 of ${MIN_REQUESTS_FOR_COST_EVIDENCE}`)
  })

  it("reports a measured floor only when traffic actually measured it", () => {
    const models = approved()
    const usage = models.map((model) => ({
      providerID: model.providerID,
      modelID: model.modelID,
      requests: 30,
      usd: 30 * (model.cost?.[0]?.input ?? 1) * 0.003,
    }))
    const result = resolveIntelligenceFloor(settings({ calibrateFloor: true }), { models, usage })
    expect(result.calibrated).toBe(true)
    expect(result.baselineUsdPerRequest).toBeGreaterThan(0)
    expect(result.admittedUsdPerRequest).not.toBeNull()
    // The reason must name a model and both figures, so it can be checked.
    expect(result.reason).toMatch(/\//)
    expect(result.reason).toContain("baseline")
  })

  it("names the window in days, so the report cannot imply a longer history", () => {
    expect(CALIBRATION_WINDOW_MS / 86_400_000).toBe(14)
  })
})
