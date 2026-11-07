import { describe, expect, it } from "vitest"
import { estimateSuccess } from "../src/core/routing/engine.js"
import type { ModelRecord, TaskClass } from "../src/core/types.js"

/**
 * Per-kind capability scores: benchmark evidence may shift a CLOSE ranking,
 * never overrule a hard gate, and a model without evidence stays neutral -
 * an unscored model is not a zero-capability model.
 */

const task = (overrides: Partial<TaskClass> = {}): TaskClass =>
  ({
    tier: 3,
    kind: "debug",
    requiresVision: false,
    designIntensive: false,
    sophisticatedDesign: false,
    needsLongContext: false,
    confidence: "high",
    signals: [],
    reasons: [],
    constraints: { avoidPremium: false, requestPremium: false, requestEconomy: false },
    scope: { promptTokens: 1_000, files: 0 },
    ...overrides,
  }) as unknown as TaskClass

const model = (overrides: Partial<ModelRecord> = {}): ModelRecord =>
  ({
    key: "opendesign/test",
    providerID: "opendesign",
    modelID: "test",
    name: "Test",
    context: 1_000_000,
    maxOutput: 64_000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    tools: true,
    cost: [{ input: 2, output: 10, cache: { read: 0.2, write: 2.5 } }],
    intelligence: 55,
    design: 90,
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

const success = (m: ModelRecord, t: TaskClass) =>
  estimateSuccess({ model: m, task: t, contextTokens: 10_000, intelligenceFloor: 39.5 })

describe("per-kind capability scores", () => {
  it("favors the stronger coding benchmark on an otherwise tied ranking", () => {
    const sonnet = model({
      modelID: "claude-sonnet-5.5",
      capabilities: { coding: 64, debugging: 72, agentic: 42, architecture: 88 },
    })
    const sol = model({
      modelID: "gpt-6.1-sol",
      capabilities: { coding: 56, debugging: 65, agentic: 41, architecture: 86 },
    })
    const debugTask = task({ kind: "debug" })
    expect(success(sonnet, debugTask)).toBeGreaterThan(success(sol, debugTask))
  })

  it("keeps a model without capability evidence neutral", () => {
    const plain = model({})
    const evidenced = model({ capabilities: { coding: 90, debugging: 90, agentic: 90, architecture: 90 } })
    const featureTask = task({ kind: "feature" })
    expect(success(evidenced, featureTask)).toBeGreaterThan(success(plain, featureTask))
    expect(success(plain, featureTask)).toBeGreaterThan(0.9)
  })

  it("caps the per-kind nudge so benchmarks cannot overrule hard advantages", () => {
    // DeepSeek is far below the floor for tier-3; a big coding score must not
    // lift it above a floor-passing model.
    const weakButScored = model({
      intelligence: 33,
      tier: 2,
      capabilities: { coding: 99, debugging: 99, agentic: 99, architecture: 99 },
    })
    const strongUnscored = model({ intelligence: 45 })
    const debugTask = task({ kind: "debug" })
    expect(success(strongUnscored, debugTask)).toBeGreaterThan(success(weakButScored, debugTask))
  })

  it("rewards architecture capability on architecture tasks, not on docs tasks", () => {
    const architect = model({ capabilities: { architecture: 95 } })
    const plain = model({})
    const archTask = task({ kind: "architecture" })
    const docsTask = task({ kind: "docs" })
    expect(success(architect, archTask)).toBeGreaterThan(success(plain, archTask))
    expect(success(architect, docsTask)).toBe(success(plain, docsTask))
  })
})
