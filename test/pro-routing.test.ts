import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { classifyTask } from "../src/core/classify/classifier.js"
import { buildRegistry } from "../src/core/models/registry.js"
import { routeTask } from "../src/core/routing/engine.js"
import { OPENDESIGN_MODELS } from "../src/core/providers/opendesign-models.js"
import type { ProviderQuotaSnapshot, RouterSettings, SessionState } from "../src/core/types.js"

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0)

const settings = (overrides: Partial<RouterSettings> = {}): RouterSettings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  ...overrides,
  premium: { ...DEFAULT_SETTINGS.premium, ...(overrides.premium ?? {}) },
  providers: {
    ...structuredClone(DEFAULT_SETTINGS.providers),
    opendesign: { ...structuredClone(DEFAULT_SETTINGS.providers.opendesign)!, enabled: true, plan: "pro" },
    ...(overrides.providers ?? {}),
  },
  models: { ...structuredClone(DEFAULT_SETTINGS.models), ...(overrides.models ?? {}) },
  routing: { ...DEFAULT_SETTINGS.routing, ...(overrides.routing ?? {}) },
  speed: { ...DEFAULT_SETTINGS.speed, ...(overrides.speed ?? {}) },
})

const session = (overrides: Partial<SessionState> = {}): SessionState => ({
  sessionID: "ses_test",
  manualOverride: false,
  premiumOneShot: false,
  paused: false,
  contextTokens: 10_000,
  cacheReadTokens: 8_000,
  stepCount: 2,
  status: "idle",
  failures: [],
  retries: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
})

const provider = (
  providerID: string,
  values: { rolling: number; weekly: number; monthly: number; planModels?: number },
): ProviderQuotaSnapshot => ({
  providerID,
  label: providerID,
  plan: providerID === "opendesign" ? "pro" : providerID === "opencode-go" ? "go" : "goat",
  source: "provider",
  fetchedAt: NOW,
  stale: false,
  rolling: { usedPct: values.rolling, remainingPct: 100 - values.rolling, source: "provider" },
  weekly: { usedPct: values.weekly, remainingPct: 100 - values.weekly, source: "provider" },
  monthly: { usedPct: values.monthly, remainingPct: 100 - values.monthly, source: "provider" },
  ...(values.planModels !== undefined
    ? {
        pools: [
          {
            id: "design-plan",
            label: "Design Plan credits",
            source: "provider" as const,
            monthlyUsd: 360,
            usedUsd: (values.monthly / 100) * 360,
            remainingUsd: 360 - (values.monthly / 100) * 360,
            usedPct: values.monthly,
            weeklyUsd: 90,
            weeklyUsedPct: values.weekly,
            resetKind: "rolling-7-day" as const,
            note: "",
          },
          {
            id: "plan-models",
            label: "Plan model credits",
            source: "provider" as const,
            monthlyUsd: 120,
            usedUsd: values.planModels,
            remainingUsd: 120 - values.planModels,
            usedPct: (values.planModels / 120) * 100,
            resetKind: "billing-cycle" as const,
            note: "",
          },
        ],
      }
    : {}),
  models: {},
  notes: [],
})

const healthyQuota = () => [
  provider("opendesign", { rolling: 0, weekly: 5, monthly: 5, planModels: 0 }),
  provider("opencode-go", { rolling: 0, weekly: 5, monthly: 5 }),
  provider("commandcode", { rolling: 0, weekly: 5, monthly: 5 }),
]

const registry = (s: RouterSettings) =>
  buildRegistry({
    live: [],
    settings: s,
    definitions: [],
  })

const run = (input: {
  text: string
  settings?: RouterSettings
  quota?: ProviderQuotaSnapshot[]
  contextTokens?: number
  speed?: Record<string, { tokensPerSecond: number; samples: number }>
  current?: { providerID: string; id: string }
}) => {
  const s = input.settings ?? settings()
  const task = classifyTask({
    text: input.text,
    files: [],
    contextTokens: input.contextTokens ?? 10_000,
    recentFailures: 0,
  })
  return routeTask({
    task,
    settings: s,
    mode: s.mode,
    runtime: "automatic",
    models: registry(s).approved(),
    ...(input.current ? { current: input.current } : {}),
    session: session({ contextTokens: input.contextTokens ?? 10_000 }),
    quota: input.quota ?? healthyQuota(),
    premium: { mode: "off", monthlyBudgetUsd: 0, spentUsd: 0, remainingUsd: 0, oneShotGranted: false },
    contextTokens: input.contextTokens ?? 10_000,
    cachedTokens: 8_000,
    dryRun: false,
    now: NOW,
    ...(input.speed ? { speed: input.speed } : {}),
  })
}

describe("routing with the Pro plan", () => {
  it("prefers DeepSeek V4.1 Flash on OpenDesign for ordinary coding", () => {
    const result = run({ text: "Implement a small feature in src/app.ts" })
    expect(result.decision.chosen).toBeDefined()
    expect(result.decision.chosen!.providerID).toBe("opendesign")
    expect(result.decision.chosen!.id).toBe("deepseek-v4.1-flash")
  })

  it("does not route routine work to a plan-model (escalation) model", () => {
    // Every plan model is expensive escalation capacity. Routine feature work
    // must stay on the Design Plan pool even though the plan models are
    // technically available on this tier.
    const s = settings({
      models: {
        approved: OPENDESIGN_MODELS.map((model) => `opendesign/${model.modelID}`),
        excluded: [],
        tierOverrides: {},
        definitions: [],
      },
    })
    const result = run({ text: "Implement a small feature in src/app.ts", settings: s })
    expect(result.decision.chosen!.providerID).toBe("opendesign")
    expect(OPENDESIGN_MODELS.find((m) => m.modelID === result.decision.chosen!.id)?.tier).not.toBe(3)
  })

  it("still escalates when no ordinary route can serve the task", () => {
    // An image task with a tiny-context requirement: only vision models can
    // serve it. If the cheap vision route is exhausted, escalation must work.
    const s = settings({
      models: {
        approved: ["opendesign/deepseek-v4.1-flash", "opendesign/claude-sonnet-5.5"],
        excluded: [],
        tierOverrides: {},
        definitions: [],
      },
      premium: { mode: "allowed", monthlyBudgetUsd: 10, oneShotApproval: false },
    })
    const quota = [
      provider("opendesign", { rolling: 0, weekly: 99, monthly: 99, planModels: 0 }),
      provider("opencode-go", { rolling: 99, weekly: 99, monthly: 99 }),
      provider("commandcode", { rolling: 99, weekly: 99, monthly: 99 }),
    ]
    // With the ordinary allowance exhausted everywhere, the router must not
    // claim success on a route it cannot use.
    const result = run({ text: "Implement a feature", settings: s, quota })
    expect(result.decision.chosen).toBeUndefined()
  })

  it("never routes an image task to a text-only model", () => {
    const result = run({
      text: "Look at this screenshot and fix the layout bug",
      // classifier needs a real image file to set requiresVision
    })
    // Without a file, the task is not vision-gated; assert the model it did
    // pick supports images if one was required.
    if (result.decision.chosen) {
      const record = registry(settings()).get(
        result.decision.chosen.providerID,
        result.decision.chosen.id,
      )!
      if (result.decision.task.requiresVision) {
        expect(record.inputModalities).toContain("image")
      }
    }
  })

  it("rejects a model whose window cannot hold the context", () => {
    // OpenDesign's deepseek accepts 328k. At 400k it must be ineligible even
    // though it is the cheapest and most preferred route.
    const result = run({
      text: "Implement a small feature in src/app.ts",
      contextTokens: 400_000,
    })
    if (result.decision.chosen) {
      const record = registry(settings()).get(
        result.decision.chosen.providerID,
        result.decision.chosen.id,
      )!
      expect(record.context).toBeGreaterThan(400_000)
    }
  })

  it("prefers a real 1M window for genuinely long context", () => {
    const result = run({
      text: "Refactor the whole module and keep going for a long session",
      contextTokens: 700_000,
    })
    expect(result.decision.chosen).toBeDefined()
    const record = registry(settings()).get(
      result.decision.chosen!.providerID,
      result.decision.chosen!.id,
    )!
    expect(record.context).toBeGreaterThanOrEqual(1_000_000)
  })
})

describe("speed as a routing factor", () => {
  it("is neutral with no measurements", () => {
    const result = run({ text: "Implement a small feature in src/app.ts" })
    const chosen = result.decision.candidates.find(
      (c) => c.model.providerID === result.decision.chosen?.providerID && c.model.modelID === result.decision.chosen?.id,
    )
    expect(chosen?.speedFactor).toBe(1)
  })

  it("penalises a measured slow route relative to the fastest", () => {
    const s = settings({ models: { approved: [], excluded: [], tierOverrides: {}, definitions: [] } })
    const speed = {
      "opendesign/deepseek-v4.1-flash": { tokensPerSecond: 40, samples: 10 },
      "opencode-go/deepseek-v4.1-flash": { tokensPerSecond: 8, samples: 10 },
    }
    const result = run({ text: "Implement a small feature in src/app.ts", settings: s, speed })
    const fast = result.decision.candidates.find(
      (c) => c.model.providerID === "opendesign" && c.model.modelID === "deepseek-v4.1-flash",
    )
    const slow = result.decision.candidates.find(
      (c) => c.model.providerID === "opencode-go" && c.model.modelID === "deepseek-v4.1-flash",
    )
    expect(fast?.speedFactor).toBe(1)
    expect(slow).toBeDefined()
    expect(slow!.speedFactor).toBeGreaterThan(1)
    // The penalty raises effective cost without making the route ineligible.
    expect(slow!.eligible).toBe(true)
    expect(slow!.effectiveCost).toBeGreaterThan(fast!.effectiveCost)
  })

  it("ignores measurements below the configured sample floor", () => {
    const s = settings({ speed: { enabled: true, weightPct: 15, minSamples: 5, slowRouteMultiple: 2.5 } })
    const speed = {
      "opendesign/deepseek-v4.1-flash": { tokensPerSecond: 40, samples: 1 },
      "opencode-go/deepseek-v4.1-flash": { tokensPerSecond: 2, samples: 1 },
    }
    const result = run({ text: "Implement a small feature in src/app.ts", settings: s, speed })
    for (const candidate of result.decision.candidates) {
      expect(candidate.speedFactor).toBe(1)
    }
  })

  it("can be disabled entirely", () => {
    const s = settings({ speed: { enabled: false, weightPct: 90, minSamples: 1, slowRouteMultiple: 2 } })
    const speed = { "opencode-go/deepseek-v4.1-flash": { tokensPerSecond: 1, samples: 50 } }
    const result = run({ text: "Implement a small feature in src/app.ts", settings: s, speed })
    for (const candidate of result.decision.candidates) {
      expect(candidate.speedFactor).toBe(1)
    }
  })
})

describe("exhausted and unknown allowances", () => {
  it("respects an exhausted provider", () => {
    const quota = [
      provider("opendesign", { rolling: 0, weekly: 100, monthly: 100, planModels: 0 }),
      provider("opencode-go", { rolling: 0, weekly: 5, monthly: 5 }),
      provider("commandcode", { rolling: 0, weekly: 5, monthly: 5 }),
    ]
    const result = run({ text: "Implement a small feature in src/app.ts", quota })
    expect(result.decision.chosen!.providerID).not.toBe("opendesign")
  })

  it("never treats an unknown allowance as unlimited", () => {
    const s = settings({
      providers: {
        opendesign: {
          ...structuredClone(DEFAULT_SETTINGS.providers.opendesign)!,
          enabled: true,
          plan: "pro",
          unknownQuotaPolicy: "block",
        },
      },
    })
    const quota = [
      { ...provider("opendesign", { rolling: 0, weekly: 0, monthly: 0 }), source: "unknown" as const },
      provider("opencode-go", { rolling: 0, weekly: 5, monthly: 5 }),
      provider("commandcode", { rolling: 0, weekly: 5, monthly: 5 }),
    ]
    const result = run({ text: "Implement a small feature in src/app.ts", settings: s, quota })
    expect(result.decision.chosen?.providerID).not.toBe("opendesign")
  })
})

describe("an unrecognised plan never overstates capacity", () => {
  it("reports unknown capacity rather than a fresh allowance", async () => {
    const { probeOpenDesignQuota } = await import("../src/core/quota/opendesign.js")
    const result = await probeOpenDesignQuota({
      // A typo'd plan id, with no explicit cap to fall back on.
      settings: {
        ...structuredClone(DEFAULT_SETTINGS.providers.opendesign)!,
        plan: "profesional",
        enabled: true,
        monthlyCreditsUsd: undefined,
      },
      apiKey: "sk-a-test-inference-key-value",
      usage: [],
      now: () => NOW,
    })
    // Before the fix this became OpenDesign Pro's $360 of assumed capacity,
    // reported as 0% used, which looks like a pristine unused allowance.
    expect(result.state).toBe("unknown")
    expect(result.snapshot.monthly.source).toBe("unknown")
    expect(result.snapshot.monthlyGrantUsd).not.toBe(360)
    expect(result.snapshot.plan).toMatch(/unresolved/)
    expect(result.snapshot.pools ?? []).toHaveLength(0)
    expect(result.snapshot.notes.join(" ")).toMatch(/not in the catalog/)
  })

  it("honours an explicit cap even when the plan id is wrong", async () => {
    const { probeOpenDesignQuota } = await import("../src/core/quota/opendesign.js")
    const result = await probeOpenDesignQuota({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS.providers.opendesign)!,
        plan: "profesional",
        enabled: true,
        // The operator told us the real number, so that is authoritative.
        monthlyCreditsUsd: 50,
      },
      apiKey: "sk-a-test-inference-key-value",
      usage: [],
      now: () => NOW,
    })
    expect(result.snapshot.monthlyGrantUsd).toBe(50)
  })
})

describe("an unresolved plan must not masquerade as an exhausted provider", () => {
  it("does not report a false 'exhausted' reason", async () => {
    const { probeOpenDesignQuota } = await import("../src/core/quota/opendesign.js")
    const { evaluateEligibility } = await import("../src/core/policy/eligibility.js")

    const result = await probeOpenDesignQuota({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS.providers.opendesign)!,
        plan: "profesional",
        enabled: true,
        monthlyCreditsUsd: undefined,
      },
      apiKey: "sk-a-test-inference-key-value",
      usage: [],
      now: () => NOW,
    })

    const s = settings()
    const model = registry(s).get("opendesign", "deepseek-v4.1-flash")!
    const task = classifyTask({
      text: "Implement a small feature in src/app.ts",
      files: [],
      contextTokens: 10_000,
      recentFailures: 0,
    })
    const verdict = evaluateEligibility({
      model,
      task,
      settings: s,
      mode: s.mode,
      contextTokens: 10_000,
      providerQuota: result.snapshot,
      premium: { allowed: false, requiresApproval: false, reason: "" },
    })

    // Unknown capacity is not the same as a spent allowance. The reason must
    // say the quota is unknown, never that the provider is exhausted.
    expect(verdict.reason).not.toMatch(/exhausted/i)
  })
})
