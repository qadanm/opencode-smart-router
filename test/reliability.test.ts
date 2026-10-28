import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { classifyFailure } from "../src/core/failures.js"
import { buildRegistry } from "../src/core/models/registry.js"
import { LedgerStore } from "../src/core/quota/ledger.js"
import { estimateSuccess, routeTask } from "../src/core/routing/engine.js"
import { classifyTask } from "../src/core/classify/classifier.js"
import { RouterController } from "../src/server/controller.js"
import { sharedCore } from "../src/server/shared-core.js"
import { makeCtx } from "./helpers/ctx.js"
import type { RouterSettings, SessionState } from "../src/core/types.js"

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0)

/**
 * The exact payload OpenCode records when a provider stream dies after the
 * response has already started. The HTTP status is 200 because the headers
 * were delivered before the engine failed.
 */
const STREAM_FAILURE = {
  type: "provider.internal",
  message:
    "Streaming response failed: [500] EngineCore encountered an issue. See stack trace (above) for the root cause.",
  status: 200,
}

const settings = (overrides: Partial<RouterSettings> = {}): RouterSettings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  ...overrides,
  premium: { ...DEFAULT_SETTINGS.premium, ...(overrides.premium ?? {}) },
  providers: { ...structuredClone(DEFAULT_SETTINGS.providers), ...(overrides.providers ?? {}) },
})

describe("provider stream failures", () => {
  it("classifies a mid-stream provider fault as an outage, not an unknown error", () => {
    const assessment = classifyFailure({
      type: STREAM_FAILURE.type,
      message: STREAM_FAILURE.message,
      status: STREAM_FAILURE.status,
    })
    expect(assessment.class).toBe("provider_outage")
    expect(assessment.retryable).toBe(true)
    expect(assessment.countAgainstModel).toBe(true)
    expect(assessment.cooldownMs).toBeGreaterThan(0)
  })

  it("classifies a server_error stream body as an outage", () => {
    const assessment = classifyFailure({
      type: "provider.internal",
      message: '{"error":{"type":"server_error","message":"Streaming response failed"}}',
    })
    expect(assessment.class).toBe("provider_outage")
  })

  it("classifies an upstream error as an outage", () => {
    const assessment = classifyFailure({ type: "provider.internal", message: "Upstream error: connection reset" })
    expect(assessment.class).toBe("provider_outage")
  })

  it("classifies an OpenAI stream that ends without a finish reason as an outage", () => {
    const assessment = classifyFailure({
      type: "provider.invalid-output",
      message: "OpenAI Chat stream ended without finish_reason",
      status: 200,
    })
    expect(assessment.class).toBe("provider_outage")
    expect(assessment.countAgainstModel).toBe(true)
    expect(assessment.cooldownMs).toBeGreaterThan(0)
  })

  it("still recognises a rate limit and an auth failure by their error type", () => {
    expect(classifyFailure({ type: "provider.rate_limit", message: "too many requests" }).class).toBe("rate_limit")
    expect(classifyFailure({ type: "provider.auth", message: "missing api key" }).class).toBe("auth")
  })

  it("does not blame the model for a user interrupt", () => {
    const assessment = classifyFailure({ type: "aborted", message: "Step interrupted" })
    expect(assessment.class).toBe("interrupted")
    expect(assessment.countAgainstModel).toBe(false)
    expect(assessment.cooldownMs).toBe(0)
  })

  it("still classifies context overflow separately from a provider fault", () => {
    const assessment = classifyFailure({ type: "provider.internal", message: "maximum context length exceeded" })
    expect(assessment.class).toBe("context_overflow")
    expect(assessment.countAgainstModel).toBe(false)
  })
})

describe("failure cooldowns", () => {
  it("puts a model into cooldown after a provider fault", () => {
    const ledger = new LedgerStore()
    ledger.recordFailure("ses_1", { providerID: "opencode-go", id: "minimax-m3.1-flash" }, "provider_outage", "stream died", {
      countAgainstModel: true,
      cooldownMs: 5 * 60_000,
    })
    expect(ledger.isCoolingDown("opencode-go/minimax-m3.1-flash")).toBe(true)
    expect(ledger.cooldowns()["opencode-go/minimax-m3.1-flash"]).toBeGreaterThan(Date.now())
  })

  it("does not cool down a model after a user interrupt", () => {
    const ledger = new LedgerStore()
    ledger.recordFailure("ses_1", { providerID: "opencode-go", id: "minimax-m3.1-flash" }, "interrupted", "Step interrupted", {
      countAgainstModel: false,
      cooldownMs: 0,
    })
    expect(ledger.isCoolingDown("opencode-go/minimax-m3.1-flash")).toBe(false)
  })

  it("extends the cooldown when the same model fails again", () => {
    const ledger = new LedgerStore()
    const model = { providerID: "opencode-go", id: "minimax-m3.1-flash" }
    ledger.recordFailure("ses_1", model, "provider_outage", "stream died", { countAgainstModel: true, cooldownMs: 60_000 })
    const first = ledger.cooldowns()["opencode-go/minimax-m3.1-flash"]!
    ledger.recordFailure("ses_2", model, "provider_outage", "stream died", { countAgainstModel: true, cooldownMs: 60_000 })
    const second = ledger.cooldowns()["opencode-go/minimax-m3.1-flash"]!
    expect(second).toBeGreaterThan(first)
  })

  it("survives a restart", () => {
    const ledger = new LedgerStore()
    ledger.recordFailure("ses_1", { providerID: "opencode-go", id: "minimax-m3.1-flash" }, "provider_outage", "stream died", {
      countAgainstModel: true,
      cooldownMs: 5 * 60_000,
    })
    const revived = LedgerStore.hydrate(ledger.export()).ledger
    expect(revived.cooldowns?.["opencode-go/minimax-m3.1-flash"]).toBeGreaterThan(Date.now())
  })

  it("keeps a cooled-down model out of the candidate set", () => {
    const registry = buildRegistry({ live: [], settings: settings() })
    const task = classifyTask({ text: "Implement a feature in src/app.ts" } as any)
    const result = routeTask({
      task,
      settings: settings(),
      mode: "balanced",
      runtime: "automatic",
      models: registry.approved(),
      quota: [],
      premium: { mode: "off", monthlyBudgetUsd: 0, spentUsd: 0, remainingUsd: 0, oneShotGranted: false },
      contextTokens: 10_000,
      cachedTokens: 0,
      dryRun: false,
      now: NOW,
      cooldowns: { "opencode-go/minimax-m3.1-flash": NOW + 300_000 },
    })
    expect(result.decision.candidates.some((c) => c.model.modelID === "minimax-m3.1-flash")).toBe(false)
  })
})

describe("reliability weighting", () => {
  const model = {
    key: "opencode-go/minimax-m3.1-flash",
    providerID: "opencode-go",
    modelID: "minimax-m3.1-flash",
    name: "MiniMax M3.1 Flash",
    context: 1_000_000,
    maxOutput: 512_000,
    inputModalities: ["text", "image", "video"],
    outputModalities: ["text"],
    tools: true,
    cost: [{ input: 0.15, output: 0.6, cache: { read: 0.015, write: 0 } }],
    intelligence: 42.7,
    design: 60,
    designEvidence: "curated" as const,
    premium: false,
    training: false,
    free: false,
    tier: 2 as const,
    approved: true,
    approvalSource: "seed" as const,
    monthlyAllowanceUsd: 80,
  }

  const task = classifyTask({ text: "Implement a feature in src/app.ts" } as any)

  it("keeps a healthy model at full probability", () => {
    const probability = estimateSuccess({
      model,
      task,
      contextTokens: 10_000,
      history: { requests: 200, failures: 0 },
    })
    expect(probability).toBeGreaterThan(0.85)
  })

  it("demotes a model that repeatedly drops streams", () => {
    const healthy = estimateSuccess({ model, task, contextTokens: 10_000, history: { requests: 200, failures: 0 } })
    const flaky = estimateSuccess({ model, task, contextTokens: 10_000, history: { requests: 20, failures: 10 } })
    expect(flaky).toBeLessThan(healthy)
  })

  it("does not let a failure count exceed the request count", () => {
    const probability = estimateSuccess({ model, task, contextTokens: 10_000, history: { requests: 5, failures: 40 } })
    expect(Number.isFinite(probability)).toBe(true)
    expect(probability).toBeGreaterThanOrEqual(0.2)
  })
})

describe("controller failure attribution", () => {
  beforeEach(() => sharedCore.resetForTests())

  it("records an execution-level failure against the active model and cools it down", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-fault-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    const sessionID = "ses_fault"
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opencode-go", id: "minimax-m3.1-flash" }

    await controller.handleEvent({
      type: "session.idle",
      data: { sessionID, outcome: "failed", error: STREAM_FAILURE },
    })

    const ledger = (controller as any).ledger as LedgerStore
    const cooldown = ledger.cooldowns()["opencode-go/minimax-m3.1-flash"]
    expect(cooldown).toBeGreaterThan(Date.now())
    const metrics = ledger.snapshotMetrics()
    expect(metrics.failures.provider_outage).toBe(1)
    expect(metrics.byModel["opencode-go/minimax-m3.1-flash"]?.failures).toBe(1)
    await controller.dispose()
  })

  it("does not count a user interrupt against the model", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-int-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    const sessionID = "ses_int"
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opencode-go", id: "minimax-m3.1-flash" }

    await controller.handleEvent({
      type: "session.idle",
      data: { sessionID, outcome: "interrupted", error: { type: "aborted", message: "Step interrupted" } },
    })

    const ledger = (controller as any).ledger as LedgerStore
    expect(ledger.cooldowns()["opencode-go/minimax-m3.1-flash"]).toBeUndefined()
    expect(ledger.snapshotMetrics().byModel["opencode-go/minimax-m3.1-flash"]?.failures ?? 0).toBe(0)
    await controller.dispose()
  })

  it("attributes a step failure to the model the host is actually serving", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-attr-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    const sessionID = "ses_attr"
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opencode-go", id: "minimax-m3.1-flash" }

    await controller.handleEvent({
      type: "session.step.failed",
      data: { sessionID, error: STREAM_FAILURE },
    })

    const ledger = (controller as any).ledger as LedgerStore
    expect(ledger.cooldowns()["opencode-go/minimax-m3.1-flash"]).toBeGreaterThan(Date.now())
    await controller.dispose()
  })

  it("records a successful execution without a cooldown", async () => {
    const fake = makeCtx(mkdtempSync(join(tmpdir(), "router-ok-")))
    const controller = new RouterController({ ctx: fake.ctx, pluginOptions: fake.ctx.options })
    await controller.initialize()
    const sessionID = "ses_ok"
    const session = await fake.ctx.session.get({ sessionID })
    session.model = { providerID: "opencode-go", id: "minimax-m3.1-flash" }

    await controller.handleEvent({ type: "session.idle", data: { sessionID, outcome: "succeeded" } })

    const ledger = (controller as any).ledger as LedgerStore
    expect(ledger.cooldowns()["opencode-go/minimax-m3.1-flash"]).toBeUndefined()
    await controller.dispose()
  })
})
