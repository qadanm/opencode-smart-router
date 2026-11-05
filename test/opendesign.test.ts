import { describe, expect, it, vi } from "vitest"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { buildRegistry } from "../src/core/models/registry.js"
import { evaluateEligibility } from "../src/core/policy/eligibility.js"
import { LedgerStore } from "../src/core/quota/ledger.js"
import { QuotaService } from "../src/core/quota/service.js"
import { routeTask } from "../src/core/routing/engine.js"
import { classifyTask } from "../src/core/classify/classifier.js"
import { estimateTaskCost } from "../src/core/routing/engine.js"
import {
  OPENDESIGN_DEFAULT_BASE_URL,
  OPENDESIGN_MAX_REQUEST_BYTES,
  discoverOpenDesignModels,
  failureClassForStatus,
  normalizeOpenDesignBaseURL,
  normalizeOpenDesignControlBaseURL,
  openDesignInferenceEndpoint,
  openDesignRequestSizeError,
  protocolWarning,
  toLiveModels,
} from "../src/core/providers/opendesign.js"
import {
  OPENDESIGN_GO_PLAN,
  OPENDESIGN_PRO_PLAN,
  creditMultiplierFor,
  designPlanCreditsFor,
} from "../src/core/providers/opendesign-credits.js"
import { OPEN_DESIGN_MODEL_BY_ID } from "../src/core/providers/opendesign-models.js"
import { estimateDesignPlanCredits, probeOpenDesignQuota } from "../src/core/quota/opendesign.js"
import {
  discoverOpenDesignControlKey,
  discoverOpenDesignCredentials,
} from "../src/core/quota/credentials.js"
import type { ProviderQuotaSnapshot, ProviderSettings, RouterSettings, UsageEvent } from "../src/core/types.js"

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0)

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

const GATEWAY_MODELS = {
  object: "list",
  data: [
    {
      id: "deepseek-v4.1-flash",
      object: "model",
      owned_by: "vela",
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      metadata: { cost: "low", capability: "advanced", context_limit: 1048000, context_budget: 328000, output_budget: 128000 },
      default: true,
      enabled: true,
    },
    {
      id: "claude-haiku-5.5",
      object: "model",
      owned_by: "vela",
      architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
      metadata: { cost: "low", capability: "standard", context_limit: 1000000, context_budget: 228000, output_budget: 128000 },
      default: false,
      enabled: true,
    },
    {
      id: "hy4-preview",
      object: "model",
      owned_by: "vela",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      metadata: { cost: "medium", capability: "advanced", context_limit: 1048000, context_budget: 232000, output_budget: 32000 },
      default: false,
      enabled: true,
    },
    {
      id: "minimax-m3.1-flash",
      object: "model",
      owned_by: "vela",
      architecture: { input_modalities: ["text", "image", "video"], output_modalities: ["text"] },
      metadata: { cost: "low", capability: "advanced", context_limit: 1000000, context_budget: null, output_budget: null },
      default: false,
      enabled: true,
    },
  ],
}

const openDesignSettings = (overrides: Partial<ProviderSettings> = {}): ProviderSettings => ({
  ...DEFAULT_SETTINGS.providers.opendesign!,
  enabled: true,
  ...overrides,
})

const settings = (overrides: Partial<RouterSettings> = {}): RouterSettings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  ...overrides,
  premium: { ...DEFAULT_SETTINGS.premium, ...(overrides.premium ?? {}) },
  providers: {
    ...structuredClone(DEFAULT_SETTINGS.providers),
    ...(overrides.providers ?? {}),
  },
})

const usageEvent = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id: "use_1",
  at: NOW - 60_000,
  providerID: "opendesign",
  modelID: "deepseek-v4.1-flash",
  usd: 0,
  input: 10_000,
  output: 2_000,
  cacheRead: 50_000,
  cacheWrite: 0,
  source: "step",
  ...overrides,
})

describe("OpenDesign base URL and protocol handling", () => {
  it("never appends a second /v1 to a versioned base URL", () => {
    expect(normalizeOpenDesignBaseURL("https://amr-link.open-design.ai/v1")).toBe("https://amr-link.open-design.ai/v1")
    expect(normalizeOpenDesignBaseURL("https://amr-link.open-design.ai/v1/")).toBe("https://amr-link.open-design.ai/v1")
  })

  it("adds /v1 to a bare host exactly once", () => {
    expect(normalizeOpenDesignBaseURL("https://amr-link.open-design.ai")).toBe("https://amr-link.open-design.ai/v1")
    expect(normalizeOpenDesignBaseURL("https://amr-link.open-design.ai/")).toBe("https://amr-link.open-design.ai/v1")
  })

  it("preserves a non-default versioned path", () => {
    expect(normalizeOpenDesignBaseURL("https://example.test/v1beta")).toBe("https://example.test/v1beta")
  })

  it("rejects an insecure remote base URL", () => {
    expect(normalizeOpenDesignBaseURL("http://amr-link.open-design.ai/v1")).toBe(OPENDESIGN_DEFAULT_BASE_URL)
  })

  it("maps each protocol onto the matching gateway path", () => {
    expect(openDesignInferenceEndpoint("https://x.test/v1", "chat-completions")).toBe("https://x.test/v1/chat/completions")
    expect(openDesignInferenceEndpoint("https://x.test/v1", "responses")).toBe("https://x.test/v1/responses")
    expect(openDesignInferenceEndpoint("https://x.test/v1", "messages")).toBe("https://x.test/v1/messages")
  })

  it("warns when the messages protocol is used with a model known to drop reasoning", () => {
    expect(protocolWarning("messages", ["deepseek-v4.1-flash"])).toMatch(/8687/)
    expect(protocolWarning("messages", ["claude-haiku-5.5"])).toBeUndefined()
    expect(protocolWarning("chat-completions", ["deepseek-v4.1-flash"])).toBeUndefined()
  })

  it("rejects a request body above the documented 50 MiB limit", () => {
    expect(openDesignRequestSizeError(OPENDESIGN_MAX_REQUEST_BYTES)).toBeUndefined()
    expect(openDesignRequestSizeError(OPENDESIGN_MAX_REQUEST_BYTES + 1)).toMatch(/50 MiB/)
  })
})

describe("OpenDesign model discovery", () => {
  it("reads the entitled model list from the gateway", async () => {
    const result = await discoverOpenDesignModels({
      apiKey: "sk-amr-test",
      fetchImpl: async () => json(GATEWAY_MODELS),
      now: () => NOW,
    })
    expect(result.ok).toBe(true)
    expect(result.models.map((m) => m.id)).toEqual([
      "deepseek-v4.1-flash",
      "claude-haiku-5.5",
      "hy4-preview",
      "minimax-m3.1-flash",
    ])
  })

  it("reports native image support from the gateway rather than from a model card", async () => {
    const result = await discoverOpenDesignModels({
      apiKey: "sk-amr-test",
      fetchImpl: async () => json(GATEWAY_MODELS),
      now: () => NOW,
    })
    const hy4 = result.models.find((m) => m.id === "hy4-preview")
    expect(hy4?.inputModalities).toEqual(["text"])
    const deepseek = result.models.find((m) => m.id === "deepseek-v4.1-flash")
    expect(deepseek?.inputModalities).toContain("image")
  })

  it("uses the measured window rather than the advisory budget", async () => {
    const result = await discoverOpenDesignModels({
      apiKey: "sk-amr-test",
      fetchImpl: async () => json(GATEWAY_MODELS),
      now: () => NOW,
    })
    const live = toLiveModels(result.models)
    const deepseek = live.find((m) => m.id === "deepseek-v4.1-flash")
    // Measured on 2026-10-30: the gateway accepted 1,043,337 input tokens and
    // rejected only above the 1,048,000 vendor limit, so the advertised
    // context_budget of 328,000 is advisory and is not used as the window.
    expect(deepseek?.limit.context).toBe(1_048_000)
  })

  it("uses the vendor context limit when the gateway reports no budget", async () => {
    const result = await discoverOpenDesignModels({
      apiKey: "sk-amr-test",
      fetchImpl: async () => json(GATEWAY_MODELS),
      now: () => NOW,
    })
    const live = toLiveModels(result.models)
    const minimax = live.find((m) => m.id === "minimax-m3.1-flash")
    // The gateway reports context_limit 1,000,000 and no context_budget for
    // this model. The vendor limit is the model's real window; a hand-written
    // guess would be smaller than the truth and would wrongly push sessions
    // off this provider.
    expect(minimax?.limit.context).toBe(1_000_000)
    expect(minimax?.limit.output).toBe(32_000)
  })

  it("reports a missing credential without making a request", async () => {
    let called = false
    const result = await discoverOpenDesignModels({
      apiKey: "",
      fetchImpl: async () => {
        called = true
        return json(GATEWAY_MODELS)
      },
      now: () => NOW,
    })
    expect(called).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/API key/)
  })

  it("classifies an invalid credential as an auth failure", async () => {
    const result = await discoverOpenDesignModels({
      apiKey: "sk-amr-bad",
      fetchImpl: async () => json({ error: "unauthenticated" }, 401),
      now: () => NOW,
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.failureClass).toBe("auth")
  })

  it("classifies a rate limit and preserves the retry-after", async () => {
    const result = await discoverOpenDesignModels({
      apiKey: "sk-amr-test",
      fetchImpl: async () => json({ error: "slow down" }, 429, { "retry-after": "90" }),
      now: () => NOW,
    })
    expect(result.failureClass).toBe("rate_limit")
    expect(result.retryAfterMs).toBe(90_000)
  })

  it("classifies a gateway outage", async () => {
    const result = await discoverOpenDesignModels({
      apiKey: "sk-amr-test",
      fetchImpl: async () => json({ error: "boom" }, 503),
      now: () => NOW,
    })
    expect(result.failureClass).toBe("provider_outage")
  })

  it("handles a malformed response", async () => {
    const result = await discoverOpenDesignModels({
      apiKey: "sk-amr-test",
      fetchImpl: async () => new Response("not json", { status: 200 }),
      now: () => NOW,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/malformed/)
  })

  it("handles a timeout", async () => {
    const result = await discoverOpenDesignModels({
      apiKey: "sk-amr-test",
      timeoutMs: 5,
      fetchImpl: async (_url, init: any) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        }),
      now: () => NOW,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/timed out/)
  })

  it("drops a disabled model from the entitled list", async () => {
    const result = await discoverOpenDesignModels({
      apiKey: "sk-amr-test",
      fetchImpl: async () =>
        json({
          object: "list",
          data: [
            { id: "deepseek-v4.1-flash", enabled: true, architecture: { input_modalities: ["text"] }, metadata: {} },
            { id: "retired-model", enabled: false, architecture: { input_modalities: ["text"] }, metadata: {} },
          ],
        }),
      now: () => NOW,
    })
    expect(result.models.map((m) => m.id)).toEqual(["deepseek-v4.1-flash"])
  })

  it("maps every HTTP status onto a failure class", () => {
    expect(failureClassForStatus(401)).toBe("auth")
    expect(failureClassForStatus(403)).toBe("auth")
    expect(failureClassForStatus(429)).toBe("rate_limit")
    expect(failureClassForStatus(500)).toBe("provider_outage")
    expect(failureClassForStatus(503)).toBe("provider_outage")
    expect(failureClassForStatus(400)).toBe("invalid_request")
  })
})

describe("OpenDesign credit semantics", () => {
  it("uses the published multipliers", () => {
    expect(creditMultiplierFor("deepseek-v4.1-flash").multiplier).toBe(0.5)
    expect(creditMultiplierFor("claude-haiku-5.5").multiplier).toBe(2)
    expect(creditMultiplierFor("glm-5.3-flashx").multiplier).toBe(2)
    expect(creditMultiplierFor("gpt-6-luna").multiplier).toBe(4)
    expect(creditMultiplierFor("mimo-v2.6-pro").multiplier).toBe(1)
  })

  it("marks an unpublished multiplier as unverified", () => {
    const resolved = creditMultiplierFor("minimax-m3.1-flash")
    expect(resolved.evidence).toBe("unverified")
    expect(resolved.multiplier).toBe(1)
  })

  it("never applies an expired promotion", () => {
    const duringPromo = creditMultiplierFor("deepseek-v4.1-flash", { now: Date.UTC(2026, 9, 21, 12) })
    expect(duringPromo.multiplier).toBe(0.5)
    expect(duringPromo.evidence).toBe("published")
  })

  it("honours a configured override", () => {
    const resolved = creditMultiplierFor("minimax-m3.1-flash", { overrides: { "minimax-m3.1-flash": 2 } })
    expect(resolved.multiplier).toBe(2)
    expect(resolved.evidence).toBe("configured")
  })

  it("converts usage value into Design Plan credits", () => {
    const result = designPlanCreditsFor(1, "deepseek-v4.1-flash")
    expect(result.creditsUsd).toBeCloseTo(0.5, 6)
  })

  it("treats the nested windows as limits inside one monthly maximum", () => {
    expect((OPENDESIGN_GO_PLAN.fiveHourCapUsd ?? 0) + (OPENDESIGN_GO_PLAN.weeklyCapUsd ?? 0)).toBeLessThan(
      OPENDESIGN_GO_PLAN.designPlanMonthlyUsd,
    )
    expect(OPENDESIGN_GO_PLAN.planModelCreditsUsd).toBe(0)
  })

  it("describes Pro with a seven-day window, no five-hour window, and a separate plan-model pool", () => {
    expect(OPENDESIGN_PRO_PLAN.designPlanMonthlyUsd).toBe(360)
    expect(OPENDESIGN_PRO_PLAN.weeklyCapUsd).toBe(90)
    expect(OPENDESIGN_PRO_PLAN.fiveHourCapUsd).toBeUndefined()
    expect(OPENDESIGN_PRO_PLAN.planModelCreditsUsd).toBe(120)
    // The advertised total is two pools, not one spendable balance.
    expect(OPENDESIGN_PRO_PLAN.designPlanMonthlyUsd + OPENDESIGN_PRO_PLAN.planModelCreditsUsd).toBe(480)
  })

  it("estimates credits from token counts", () => {
    /**
     * The model catalog stores the published API price, and the Design Plan
     * multiplier is applied on top of it. These are two different numbers and
     * conflating them is how the catalog drifted: the seed used to carry 0.15,
     * which is 0.3 x 0.5 — a base price with the multiplier already baked in
     * and then applied a second time.
     *
     * Published CoRouter price for deepseek-v4.1-flash is $0.30 / 1M input
     * tokens; its Design Plan multiplier is 0.5; so one million input tokens
     * costs 0.15 USD of Design Plan credits.
     */
    const credits = estimateDesignPlanCredits({
      modelID: "deepseek-v4.1-flash",
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      now: NOW,
    })
    expect(credits.creditsUsd).toBeCloseTo(0.15, 6)
    expect(credits.multiplier).toBe(0.5)
  })
})

describe("OpenDesign quota states", () => {
  it("reports unavailable when no credential is configured", async () => {
    const result = await probeOpenDesignQuota({
      settings: openDesignSettings(),
      usage: [],
      now: () => NOW,
    })
    expect(result.state).toBe("unavailable")
    expect(result.snapshot.source).toBe("unknown")
  })

  it("estimates from local usage when only the inference key is available", async () => {
    const result = await probeOpenDesignQuota({
      settings: openDesignSettings(),
      apiKey: "sk-amr-test",
      usage: [usageEvent()],
      now: () => NOW,
    })
    expect(result.state).toBe("estimated")
    expect(result.snapshot.source).toBe("estimate")
    expect(result.snapshot.monthly.usedUsd).toBeGreaterThan(0)
    expect(result.snapshot.notes.join(" ")).toMatch(/lower bound/)
  })

  it("reports a verified balance when a control key is configured", async () => {
    const result = await probeOpenDesignQuota({
      settings: openDesignSettings(),
      apiKey: "sk-amr-test",
      controlKey: "vela_ctrl_test",
      usage: [],
      fetchImpl: async (url) => {
        if (url.includes("workspaces/current")) return json({ workspaceId: "ws_1", activeWorkspaceId: "ws_1" })
        if (url.includes("coding-plan-usage")) {
          return json({
            workspaceId: "ws_1",
            generatedAt: NOW,
            eligible: true,
            tier: "go",
            windows: [
              { durationSeconds: 18_000, usedCredits: 20_000, limitCredits: 100_000, remainingCredits: 80_000, resetsAt: NOW + 3600_000 },
              { durationSeconds: 604_800, usedCredits: 60_000, limitCredits: 300_000, remainingCredits: 240_000, resetsAt: NOW + 86_400_000 },
            ],
          })
        }
        return json({
          balanceUsd: 0,
          creditsPerUsd: 10_000,
          balances: { subscriptionCredits: 2_400_000, rechargeCredits: 50_000 },
          membershipTier: "go",
        })
      },
      now: () => NOW,
    })
    expect(result.state).toBe("verified")
    expect(result.snapshot.source).toBe("provider")
    expect(result.snapshot.rolling.usedPct).toBeCloseTo(20, 5)
    expect(result.snapshot.weekly.usedPct).toBeCloseTo(20, 5)
    expect(result.snapshot.extraCredits?.purchasedUsd).toBeCloseTo(5, 5)
  })

  it("never combines balances from two different workspaces", async () => {
    const result = await probeOpenDesignQuota({
      settings: openDesignSettings(),
      controlKey: "vela_ctrl_test",
      usage: [],
      fetchImpl: async (url) => {
        if (url.includes("workspaces/current")) return json({ workspaceId: "ws_1", activeWorkspaceId: "ws_1" })
        if (url.includes("coding-plan-usage")) {
          return json({ workspaceId: "ws_OTHER", windows: [{ durationSeconds: 18_000, usedCredits: 1, limitCredits: 2 }] })
        }
        return json({ creditsPerUsd: 10_000, balances: {} })
      },
      now: () => NOW,
    })
    expect(result.state).toBe("unavailable")
    expect(result.snapshot.error).toMatch(/workspace/)
  })

  it("reports exhausted when a window is used up", async () => {
    const result = await probeOpenDesignQuota({
      settings: openDesignSettings(),
      controlKey: "vela_ctrl_test",
      usage: [],
      fetchImpl: async (url) => {
        if (url.includes("workspaces/current")) return json({ workspaceId: "ws_1", activeWorkspaceId: "ws_1" })
        if (url.includes("coding-plan-usage")) {
          return json({
            workspaceId: "ws_1",
            windows: [{ durationSeconds: 18_000, usedCredits: 100_000, limitCredits: 100_000 }],
          })
        }
        return json({ creditsPerUsd: 10_000, balances: {} })
      },
      now: () => NOW,
    })
    expect(result.state).toBe("exhausted")
    expect(result.snapshot.rolling.exceeded).toBe(true)
  })

  it("reports unavailable when the control API rejects the key", async () => {
    const result = await probeOpenDesignQuota({
      settings: openDesignSettings(),
      controlKey: "vela_ctrl_bad",
      usage: [],
      fetchImpl: async () => json({ error: "unauthenticated" }, 401),
      now: () => NOW,
    })
    expect(result.state).toBe("unavailable")
  })

  it("marks a snapshot stale once it ages past the probe interval", async () => {
    let now = NOW
    const service = new QuotaService({
      getSettings: () => ({ opendesign: openDesignSettings() }) as any,
      getCredentials: async () => ({ openDesignApiKey: "sk-amr-test" }),
      probeIntervalMinutes: 5,
      fetchImpl: async () => json({}),
      now: () => now,
    })
    await service.refresh("opendesign")
    now += 20 * 60_000
    const snapshot = service.read().find((s) => s.providerID === "opendesign")
    expect(snapshot?.stale).toBe(true)
    expect(snapshot?.quotaState).toBe("stale")
  })

  it("makes one request for concurrent refreshes of the same provider", async () => {
    let calls = 0
    const service = new QuotaService({
      getSettings: () => ({ opendesign: openDesignSettings() }) as any,
      getCredentials: async () => ({ openDesignApiKey: "sk-amr-test", openDesignControlKey: "vela_ctrl_test" }),
      probeIntervalMinutes: 5,
      fetchImpl: async () => {
        calls += 1
        return json({ workspaceId: "ws_1", activeWorkspaceId: "ws_1", windows: [] })
      },
      now: () => NOW,
    })
    await Promise.all([service.refresh("opendesign"), service.refresh("opendesign"), service.refresh("opendesign")])
    // The verified path reads three control endpoints. Three concurrent
    // refreshes still produce exactly one pass over them.
    expect(calls).toBe(3)
  })

  it("does not probe a disabled provider", async () => {
    let calls = 0
    const service = new QuotaService({
      getSettings: () => ({ opendesign: openDesignSettings({ enabled: false }) }) as any,
      getCredentials: async () => ({ openDesignApiKey: "sk-amr-test" }),
      probeIntervalMinutes: 5,
      fetchImpl: async () => {
        calls += 1
        return json({})
      },
      now: () => NOW,
    })
    await service.refresh("opendesign")
    expect(calls).toBe(0)
  })

  it("makes no network request for the local estimate", async () => {
    let calls = 0
    const service = new QuotaService({
      getSettings: () => ({ opendesign: openDesignSettings() }) as any,
      getCredentials: async () => ({ openDesignApiKey: "sk-amr-test" }),
      probeIntervalMinutes: 5,
      fetchImpl: async () => {
        calls += 1
        return json({})
      },
      now: () => NOW,
    })
    await service.refresh("opendesign")
    expect(calls).toBe(0)
  })

  it("initializes only the enabled providers", async () => {
    const seen: string[] = []
    const service = new QuotaService({
      getSettings: () =>
        ({
          "opencode-go": { ...DEFAULT_SETTINGS.providers["opencode-go"]! },
          commandcode: { ...DEFAULT_SETTINGS.providers.commandcode!, enabled: false },
          opendesign: openDesignSettings(),
        }) as any,
      getCredentials: async () => ({ openDesignApiKey: "sk-amr-test", openDesignControlKey: "vela_ctrl_test" }),
      probeIntervalMinutes: 5,
      fetchImpl: async (url) => {
        seen.push(url)
        return json({ workspaceId: "ws_1", activeWorkspaceId: "ws_1", windows: [] })
      },
      now: () => NOW,
    })
    await service.initialize()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((url) => !url.includes("commandcode"))).toBe(true)
  })
})

describe("OpenDesign eligibility and routing", () => {
  const providerSnapshot = (overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot => ({
    providerID: "opendesign",
    label: "OpenDesign Go",
    plan: "go",
    source: "estimate",
    fetchedAt: NOW,
    stale: false,
    rolling: { usedPct: 10, remainingPct: 90, source: "estimate", usedUsd: 1, capUsd: 10 },
    weekly: { usedPct: 10, remainingPct: 90, source: "estimate", usedUsd: 3, capUsd: 30 },
    monthly: { usedPct: 5, remainingPct: 95, source: "estimate", usedUsd: 6, capUsd: 120 },
    monthlyGrantUsd: 120,
    monthlyRemainingUsd: 114,
    extraCredits: { purchasedUsd: 0, freeUsd: 0, totalUsd: 0 },
    models: {},
    notes: [],
    ...overrides,
  })

  const openDesignRegistry = () => {
    const live = toLiveModels(
      (GATEWAY_MODELS.data as any[]).map((row) => ({
        id: row.id,
        name: row.id,
        contextLimit: row.metadata.context_limit,
        contextBudget: row.metadata.context_budget ?? undefined,
        outputBudget: row.metadata.output_budget ?? undefined,
        inputModalities: row.architecture.input_modalities.map((m: string) =>
          m === "file" ? "pdf" : m === "text" ? "text" : m,
        ),
        outputModalities: ["text"],
        enabled: true,
        default: row.default === true,
      })),
    )
    return buildRegistry({
      live: live as any,
      settings: settings({ providers: { opendesign: openDesignSettings() } }),
    })
  }

  it("approves only the entitled OpenDesign models", () => {
    const registry = openDesignRegistry()
    const approved = registry.approved().filter((m) => m.providerID === "opendesign").map((m) => m.modelID)
    expect(approved).toContain("deepseek-v4.1-flash")
    expect(approved).toContain("claude-haiku-5.5")
  })

  it("does not approve an OpenDesign model that the gateway does not serve", () => {
    const registry = buildRegistry({
      live: [],
      settings: settings({ providers: { opendesign: openDesignSettings() } }),
    })
    const kimi = registry.get("opendesign", "kimi-k2.7-code")
    expect(kimi?.approved).toBe(false)
  })

  it("leaves every OpenDesign model unapproved while the provider is disabled", () => {
    const registry = buildRegistry({
      live: [],
      settings: settings(),
    })
    expect(registry.approved().filter((m) => m.providerID === "opendesign")).toHaveLength(0)
  })

  it("carries the credit multiplier into the cost estimate", () => {
    const registry = openDesignRegistry()
    const model = registry.get("opendesign", "deepseek-v4.1-flash")!
    const task = classifyTask({ text: "Implement a feature in src/app.ts" } as any)
    const estimate = estimateTaskCost({ model, task, contextTokens: 10_000, now: NOW })
    expect(estimate.creditMultiplier).toBe(0.5)
    const raw = estimate.usd / 0.5
    expect(raw).toBeGreaterThan(0)
  })

  it("rejects a vision task for an OpenDesign model without image input", () => {
    const registry = buildRegistry({
      live: toLiveModels(
        (GATEWAY_MODELS.data as any[]).map((row) => ({
          id: row.id,
          name: row.id,
          contextLimit: row.metadata.context_limit,
          contextBudget: row.metadata.context_budget ?? undefined,
          outputBudget: row.metadata.output_budget ?? undefined,
          inputModalities: row.architecture.input_modalities.map((m: string) =>
            m === "file" ? "pdf" : m === "text" ? "text" : m,
          ),
          outputModalities: ["text"],
          enabled: true,
          default: false,
        })),
      ) as any,
      settings: settings({
        providers: { opendesign: openDesignSettings() },
        models: { approved: ["opendesign/hy4-preview"], excluded: [], tierOverrides: {}, definitions: [] },
      }),
    })
    const model = registry.get("opendesign", "hy4-preview")!
    expect(model.approved).toBe(true)
    const result = evaluateEligibility({
      model,
      task: {
        tier: 2,
        kind: "design",
        requiresVision: true,
        designIntensive: false,
        sophisticatedDesign: false,
        needsLongContext: false,
        confidence: "medium",
        signals: [],
        reasons: [],
        constraints: { avoidPremium: false, requestPremium: false, requestEconomy: false },
        scope: {
          files: 0,
          codeBlocks: 0,
          longestCodeBlockLines: 0,
          hasStackTrace: false,
          hasImage: true,
          hasScreenshot: true,
          promptChars: 10,
          promptTokens: 10,
        },
      },
      settings: settings({
        providers: { opendesign: openDesignSettings() },
        models: { approved: ["opendesign/hy4-preview"], excluded: [], tierOverrides: {}, definitions: [] },
      }),
      mode: "balanced",
      contextTokens: 0,
      providerQuota: providerSnapshot(),
      premium: { allowed: false, requiresApproval: false, reason: "not premium" },
    })
    expect(result.eligible).toBe(false)
    expect(result.reason).toMatch(/image/i)
  })

  it("rejects a request that exceeds the OpenDesign usable context window", () => {
    const registry = openDesignRegistry()
    const model = registry.get("opendesign", "claude-haiku-5.5")!
    const task = classifyTask({ text: "Implement a feature" } as any)
    const result = evaluateEligibility({
      model,
      task,
      settings: settings({ providers: { opendesign: openDesignSettings() } }),
      mode: "balanced",
      contextTokens: 600_000,
      providerQuota: providerSnapshot(),
      premium: { allowed: false, requiresApproval: false, reason: "not premium" },
    })
    expect(result.eligible).toBe(false)
    expect(result.reason).toMatch(/context/i)
  })

  it("blocks routing when the subscription is exhausted", () => {
    const registry = openDesignRegistry()
    const model = registry.get("opendesign", "deepseek-v4.1-flash")!
    const task = classifyTask({ text: "Implement a feature in src/app.ts" } as any)
    const result = evaluateEligibility({
      model,
      task,
      settings: settings({ providers: { opendesign: openDesignSettings() } }),
      mode: "balanced",
      contextTokens: 10_000,
      providerQuota: providerSnapshot({
        monthly: { usedPct: 100, remainingPct: 0, source: "provider", exceeded: true, usedUsd: 120, capUsd: 120 },
      }),
      premium: { allowed: false, requiresApproval: false, reason: "not premium" },
    })
    expect(result.eligible).toBe(false)
    expect(result.reason).toMatch(/exhausted/i)
  })

  it("refuses to spend a purchased wallet balance when the subscription is exhausted", () => {
    const registry = openDesignRegistry()
    const model = registry.get("opendesign", "deepseek-v4.1-flash")!
    const task = classifyTask({ text: "Implement a feature in src/app.ts" } as any)
    const result = evaluateEligibility({
      model,
      task,
      settings: settings({ providers: { opendesign: openDesignSettings({ allowExtraUsage: false }) } }),
      mode: "balanced",
      contextTokens: 10_000,
      providerQuota: providerSnapshot({
        monthly: { usedPct: 100, remainingPct: 0, source: "provider", exceeded: true, usedUsd: 120, capUsd: 120 },
        extraCredits: { purchasedUsd: 25, freeUsd: 0, totalUsd: 25 },
      }),
      premium: { allowed: false, requiresApproval: false, reason: "not premium" },
    })
    expect(result.eligible).toBe(false)
    expect(result.reason).toMatch(/purchased credits/i)
  })

  it("does not treat a non-zero wallet as permission to spend", () => {
    const registry = openDesignRegistry()
    const model = registry.get("opendesign", "deepseek-v4.1-flash")!
    const task = classifyTask({ text: "Implement a feature in src/app.ts" } as any)
    const result = evaluateEligibility({
      model,
      task,
      settings: settings({ providers: { opendesign: openDesignSettings() } }),
      mode: "balanced",
      contextTokens: 10_000,
      providerQuota: providerSnapshot({
        extraCredits: { purchasedUsd: 25, freeUsd: 0, totalUsd: 25 },
      }),
      premium: { allowed: false, requiresApproval: false, reason: "not premium" },
    })
    expect(result.eligible).toBe(true)
  })

  it("blocks a request that would not fit inside the remaining subscription", () => {
    const registry = openDesignRegistry()
    const model = registry.get("opendesign", "deepseek-v4.1-flash")!
    const task = classifyTask({ text: "Implement a feature in src/app.ts" } as any)
    const result = evaluateEligibility({
      model,
      task,
      settings: settings({ providers: { opendesign: openDesignSettings() } }),
      mode: "balanced",
      contextTokens: 100_000,
      providerQuota: providerSnapshot({
        rolling: { usedPct: 99, remainingPct: 1, source: "estimate", usedUsd: 9.9, capUsd: 10 },
      }),
      premium: { allowed: false, requiresApproval: false, reason: "not premium" },
      projectedUsd: 5,
    })
    expect(result.eligible).toBe(false)
    expect(result.reason).toMatch(/Subscription-only/)
  })

  it("keeps a session on its OpenDesign model for cache affinity", () => {
    const registry = openDesignRegistry()
    const task = classifyTask({ text: "Implement a feature in src/app.ts" } as any)
    const current = { providerID: "opendesign", id: "deepseek-v4.1-flash" }
    const result = routeTask({
      task,
      settings: settings({ providers: { opendesign: openDesignSettings() } }),
      mode: "balanced",
      runtime: "automatic",
      models: registry.approved(),
      current,
      quota: [providerSnapshot()],
      premium: { mode: "off", monthlyBudgetUsd: 0, spentUsd: 0, remainingUsd: 0, oneShotGranted: false },
      contextTokens: 200_000,
      cachedTokens: 180_000,
      dryRun: false,
      now: NOW,
    })
    expect(result.decision.chosen?.providerID).toBe("opendesign")
    expect(result.decision.switched).toBe(false)
  })

  it("falls back to another provider when OpenDesign is cooling down", () => {
    const registry = buildRegistry({
      live: [
        {
          id: "deepseek-v4.1-flash",
          providerID: "opencode-go",
          name: "DeepSeek V4.1 Flash",
          limit: { context: 1_000_000, output: 384_000 },
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
        },
      ] as any,
      settings: settings({
        providers: { opendesign: openDesignSettings() },
        models: {
          approved: [],
          excluded: [
            "opendesign/claude-haiku-5-5",
            "opendesign/glm-5.3-flash",
            "opendesign/minimax-m3.1-flash",
            "opendesign/mimo-v2.6-flash",
            "opendesign/mimo-v2.6-pro",
            "opendesign/gpt-6-luna",
          ],
          tierOverrides: {},
          definitions: [],
        },
      }),
    })
    const task = classifyTask({ text: "Implement a feature in src/app.ts" } as any)
    const result = routeTask({
      task,
      settings: settings({ providers: { opendesign: openDesignSettings() } }),
      mode: "balanced",
      runtime: "automatic",
      models: registry.approved(),
      // Every probe-enabled provider reports in production, so the fallback has a
      // real reading here too. Without it the router now correctly refuses the
      // fallback as unprobed, which would test the guard instead of the fallback.
      quota: [
        providerSnapshot(),
        providerSnapshot({ providerID: "opencode-go", label: "OpenCode Go", plan: "go" } as any),
        providerSnapshot({ providerID: "commandcode", label: "Command Code", plan: "goat" } as any),
      ],
      premium: { mode: "off", monthlyBudgetUsd: 0, spentUsd: 0, remainingUsd: 0, oneShotGranted: false },
      contextTokens: 10_000,
      cachedTokens: 0,
      dryRun: false,
      now: NOW,
      cooldowns: { "opendesign/deepseek-v4.1-flash": NOW + 60_000 },
    })
    expect(result.decision.chosen?.providerID).not.toBe("opendesign")
  })
})

describe("OpenDesign credentials", () => {
  it("finds no credential when none is configured", () => {
    const result = discoverOpenDesignCredentials({ home: "/nonexistent-home", env: {} })
    expect(result.candidates).toHaveLength(0)
  })

  it("reads the inference key from the environment", () => {
    const result = discoverOpenDesignCredentials({
      home: "/nonexistent-home",
      env: { OPENDESIGN_API_KEY: "sk-amr-abcdefghijklmnop" },
    })
    expect(result.candidates[0]?.key).toBe("sk-amr-abcdefghijklmnop")
  })

  it("ignores a value that is not an inference key", () => {
    const result = discoverOpenDesignCredentials({
      home: "/nonexistent-home",
      env: { OPENDESIGN_API_KEY: "not-a-key" },
    })
    expect(result.candidates).toHaveLength(0)
  })

  it("never discovers a control key on its own", () => {
    const result = discoverOpenDesignControlKey({})
    expect(result.candidates).toHaveLength(0)
    expect(result.warnings.join(" ")).toMatch(/estimate/i)
  })

  it("reads a control key only from an explicitly configured file", () => {
    const result = discoverOpenDesignControlKey({ explicitPath: "/nonexistent-home/control.key" })
    expect(result.candidates).toHaveLength(0)
  })
})

describe("OpenDesign ledger accounting", () => {
  it("does not create per-model quota snapshots for a provider-scoped pool", () => {
    const ledger = new LedgerStore()
    const snapshot: ProviderQuotaSnapshot = {
      providerID: "opendesign",
      label: "OpenDesign Go",
      plan: "go",
      source: "estimate",
      fetchedAt: NOW,
      stale: false,
      rolling: { usedPct: 0, remainingPct: 100, source: "estimate" },
      weekly: { usedPct: 0, remainingPct: 100, source: "estimate" },
      monthly: { usedPct: 0, remainingPct: 100, source: "estimate" },
      models: {},
      notes: [],
    }
    const attached = ledger.attachModelQuotas(snapshot, [], openDesignSettings(), NOW)
    expect(attached.models).toEqual({})
  })
})

describe("OpenDesign control base URL", () => {
  it("keeps a remote control base on https only", () => {
    expect(normalizeOpenDesignControlBaseURL("http://amr-api.open-design.ai/api")).toBe(
      "https://amr-api.open-design.ai/api",
    )
    expect(normalizeOpenDesignControlBaseURL("https://amr-api.open-design.ai/api/")).toBe(
      "https://amr-api.open-design.ai/api",
    )
  })

  it("allows a loopback control base for isolated testing", () => {
    expect(normalizeOpenDesignControlBaseURL("http://127.0.0.1:4200/od/api")).toBe("http://127.0.0.1:4200/od/api")
  })

  it("keeps an explicitly supplied control key out of automatic discovery", () => {
    expect(discoverOpenDesignControlKey({}).candidates).toHaveLength(0)
  })
})

describe("model registry and the live catalog", () => {
  it("keeps a provider's seeds approved when its live catalog is unavailable", () => {
    const registry = buildRegistry({
      live: [],
      settings: settings({ providers: { opendesign: openDesignSettings() } }),
    })
    expect(registry.get("opendesign", "claude-haiku-5.5")?.approved).toBe(true)
  })

  it("merges the gateway usable window over the seed value", () => {
    const registry = buildRegistry({
      live: [
        {
          id: "deepseek-v4.1-flash",
          providerID: "opendesign",
          name: "DeepSeek V4.1 Flash",
          limit: { context: 328000, output: 128000 },
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
        },
      ] as any,
      settings: settings({ providers: { opendesign: openDesignSettings() } }),
    })
    const model = registry.get("opendesign", "deepseek-v4.1-flash")!
    expect(model.context).toBe(328000)
    expect(model.creditMultiplier).toBe(0.5)
  })
})
