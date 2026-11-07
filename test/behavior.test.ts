import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_SETTINGS,
  applyProjectGuardrails,
  loadSettings,
  validateSettings,
} from "../src/core/config.js"
import { computeContextHealth } from "../src/core/context-health.js"
import { classifyFailure } from "../src/core/failures.js"
import type { SessionState } from "../src/core/types.js"

const session = (overrides: Partial<SessionState> = {}): SessionState => ({
  sessionID: "ses_1",
  manualOverride: false,
  premiumOneShot: false,
  paused: false,
  contextTokens: 100_000,
  cacheReadTokens: 80_000,
  stepCount: 2,
  status: "idle",
  failures: [],
  retries: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
})

describe("failure classification", () => {
  it("does not treat context overflow as an intelligence failure", () => {
    const result = classifyFailure({ message: "prompt is too long: context_length_exceeded", status: 400 })
    expect(result.class).toBe("context_overflow")
    expect(result.escalate).toBe(false)
    expect(result.reason).toMatch(/compact|handoff/i)
  })

  it("does not escalate on network or provider outages", () => {
    expect(classifyFailure({ message: "fetch failed: ECONNRESET" }).escalate).toBe(false)
    expect(classifyFailure({ message: "upstream unavailable", status: 502 }).escalate).toBe(false)
    expect(classifyFailure({ message: "rate limit", status: 429 }).escalate).toBe(false)
    const capacity = classifyFailure({
      message: "Upstream request failed: [ttft_admission_refused] the cell is at capacity; retry shortly (after 51 s)",
    })
    expect(capacity.class).toBe("provider_outage")
    expect(capacity.retryable).toBe(true)
    expect(capacity.escalate).toBe(false)
  })

  it("does not escalate on authentication failures", () => {
    const result = classifyFailure({ message: "invalid api key", status: 401 })
    expect(result.class).toBe("auth")
    expect(result.retryable).toBe(false)
    expect(result.escalate).toBe(false)
  })

  it("allows one evidence-based capability escalation and then bounds it", () => {
    const first = classifyFailure({ message: "unable to complete the implementation" }, session())
    expect(first.class).toBe("capability")
    expect(first.escalate).toBe(true)
    const second = classifyFailure(
      { message: "unable to complete the implementation" },
      session({ failures: [{ class: "capability", at: Date.now(), message: "first" }] }),
    )
    expect(second.escalate).toBe(false)
  })

  it("does not escalate tool failures", () => {
    const result = classifyFailure({ type: "tool", message: "shell command failed with exit code 1" })
    expect(result.class).toBe("tool")
    expect(result.escalate).toBe(false)
  })
})

describe("context health", () => {
  it("warns without compacting or rewriting the conversation", () => {
    const health = computeContextHealth(session({ contextTokens: 500_000, cacheReadTokens: 400_000 }), DEFAULT_SETTINGS.contextHealth)
    expect(health.state).toBe("watch")
    expect(health.message).toMatch(/new session|fresh session/i)
    expect(health.cacheSharePct).toBe(80)
  })

  it("recommends a handoff session at the configured threshold", () => {
    const health = computeContextHealth(session({ contextTokens: 800_000, cacheReadTokens: 700_000 }), DEFAULT_SETTINGS.contextHealth)
    expect(health.state).toBe("recommend_new_session")
    expect(health.message).toMatch(/will not compact/i)
  })
})

describe("configuration", () => {
  it("has safe defaults", () => {
    expect(DEFAULT_SETTINGS.mode).toBe("balanced")
    expect(DEFAULT_SETTINGS.premium.mode).toBe("auto")
    expect(DEFAULT_SETTINGS.premium.monthlyBudgetUsd).toBe(120)
    expect(DEFAULT_SETTINGS.privacy.allowTrainingModels).toBe(false)
    expect(DEFAULT_SETTINGS.providers.commandcode!.allowExtraUsage).toBe(false)
  })

  it("validates and clamps invalid values without throwing", () => {
    const result = validateSettings({
      mode: "nonsense",
      quota: { probeIntervalMinutes: -10 },
      premium: { monthlyBudgetUsd: -5 },
      routing: { intelligenceFloor: 200 },
    })
    expect(result.settings.mode).toBe("balanced")
    expect(result.settings.quota.probeIntervalMinutes).toBe(0)
    expect(result.settings.premium.monthlyBudgetUsd).toBe(0)
    expect(result.settings.routing.intelligenceFloor).toBe(100)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it("loads global settings and lets a project tighten them", () => {
    const home = mkdtempSync(join(tmpdir(), "router-config-"))
    const project = mkdtempSync(join(tmpdir(), "router-project-"))
    mkdirSync(join(home, ".config", "opencode"), { recursive: true })
    mkdirSync(join(project, ".opencode"), { recursive: true })
    writeFileSync(
      join(home, ".config", "opencode", "smart-router.json"),
      JSON.stringify({ premium: { mode: "allowed", monthlyBudgetUsd: 20 }, privacy: { allowTrainingModels: false } }),
      { mode: 0o600 },
    )
    writeFileSync(
      join(project, ".opencode", "smart-router.json"),
      JSON.stringify({ premium: { mode: "allowed", monthlyBudgetUsd: 50 }, privacy: { allowTrainingModels: true } }),
      { mode: 0o600 },
    )
    const loaded = loadSettings({ home, projectDirectory: project })
    expect(loaded.settings.premium.mode).toBe("allowed")
    expect(loaded.settings.premium.monthlyBudgetUsd).toBe(20)
    // A checked-in project file cannot enable training models.
    expect(loaded.settings.privacy.allowTrainingModels).toBe(false)
    expect(loaded.warnings.join(" ")).toMatch(/training/i)
  })

  it("validates user-defined model qualifications", () => {
    const result = validateSettings({
      models: {
        definitions: [
          {
            key: "lab/model",
            providerID: "lab",
            modelID: "model",
            name: "Lab Model",
            context: 100000,
            maxOutput: 8192,
            input: ["text", "image"],
            cost: [{ input: 0.1, output: 0.2, cache: { read: 0.01, write: 0 } }],
            intelligence: 42,
            design: 65,
            tier: 2,
            approved: true,
            monthlyAllowanceUsd: 100,
          },
        ],
      },
    })
    expect(result.settings.models.definitions).toHaveLength(1)
    expect(result.settings.models.definitions[0]?.key).toBe("lab/model")
  })

  it("normalizes a user cost tier without cache pricing", () => {
    const result = validateSettings({
      models: {
        definitions: [
          {
            key: "lab/no-cache",
            providerID: "lab",
            modelID: "no-cache",
            name: "No Cache",
            context: 100000,
            maxOutput: 8192,
            input: ["text"],
            cost: [{ input: 0.1, output: 0.2 }],
            intelligence: 42,
            design: 65,
            tier: 2,
            approved: true,
          },
        ],
      },
    })
    expect(result.settings.models.definitions[0]?.cost[0]?.cache).toEqual({ read: 0, write: 0 })
  })

  it("rejects a user definition with no usable cost tier", () => {
    const result = validateSettings({
      models: {
        definitions: [
          {
            key: "lab/broken-cost",
            providerID: "lab",
            modelID: "broken-cost",
            name: "Broken Cost",
            context: 100000,
            maxOutput: 8192,
            input: ["text"],
            cost: [{ input: "not-a-number", output: 0.2 }],
            intelligence: 42,
            design: 65,
            tier: 2,
            approved: true,
          },
        ],
      },
    })
    expect(result.settings.models.definitions).toHaveLength(0)
    expect(result.warnings.some((warning) => warning.includes("cost"))).toBe(true)
  })

  it("keeps project settings from loosening global extra-credit policy", () => {
    const global = validateSettings({
      providers: { commandcode: { ...DEFAULT_SETTINGS.providers.commandcode!, allowExtraUsage: false } },
    }).settings
    const warnings: string[] = []
    const project = applyProjectGuardrails(global, { providers: { commandcode: { allowExtraUsage: true } } }, warnings)
    expect(project.providers.commandcode!.allowExtraUsage).toBe(false)
  })
})
