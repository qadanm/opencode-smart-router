import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { classifyTask } from "../src/core/classify/classifier.js"
import { buildRegistry } from "../src/core/models/registry.js"
import { LedgerStore } from "../src/core/quota/ledger.js"
import { estimateTaskCost, routeTask } from "../src/core/routing/engine.js"
import type { ProviderQuotaSnapshot, RouterSettings, SessionState } from "../src/core/types.js"

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)
const deepseek = { providerID: "opencode-go", id: "deepseek-v4.1-flash" }

const settings = (overrides: Partial<RouterSettings> = {}): RouterSettings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  ...overrides,
  premium: { ...DEFAULT_SETTINGS.premium, ...(overrides.premium ?? {}) },
  providers: {
    ...structuredClone(DEFAULT_SETTINGS.providers),
    ...(overrides.providers ?? {}),
  },
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

const provider = (providerID: string, values: { rolling: number; weekly: number; monthly: number }): ProviderQuotaSnapshot => ({
  providerID,
  label: providerID === "opencode-go" ? "OpenCode Go Plus" : "Command Code GOAT",
  plan: providerID === "opencode-go" ? "go-plus" : "goat",
  source: "provider",
  fetchedAt: NOW,
  stale: false,
  rolling: { usedPct: values.rolling, remainingPct: 100 - values.rolling, source: "provider" },
  weekly: { usedPct: values.weekly, remainingPct: 100 - values.weekly, source: "provider" },
  monthly: { usedPct: values.monthly, remainingPct: 100 - values.monthly, source: "provider" },
  models: {},
  notes: [],
})

const quota = () => [provider("opencode-go", { rolling: 8, weekly: 39, monthly: 69 }), provider("commandcode", { rolling: 9, weekly: 72, monthly: 36 })]

const run = (input: {
  text: string
  files?: { uri: string; name?: string }[]
  current?: typeof deepseek
  currentModelKey?: string
  session?: SessionState
  settings?: RouterSettings
  quota?: ProviderQuotaSnapshot[]
  mode?: RouterSettings["mode"]
  runtime?: "automatic" | "manual" | "paused"
  dryRun?: boolean
  premium?: ReturnType<typeof premiumState>
}) => {
  const config = input.settings ?? settings()
  const registry = buildRegistry({ live: [], settings: config })
  const task = classifyTask({
    text: input.text,
    files: input.files,
    contextTokens: input.session?.contextTokens ?? 10_000,
  })
  return {
    task,
    result: routeTask({
      task,
      settings: config,
      mode: input.mode ?? config.mode,
      runtime: input.runtime ?? "automatic",
      models: registry.approved(),
      current: input.current,
      session: input.session ?? session(),
      quota: input.quota ?? quota(),
      premium: input.premium ?? premiumState(config),
      contextTokens: input.session?.contextTokens ?? 10_000,
      cachedTokens: input.session?.cacheReadTokens ?? 8_000,
      dryRun: input.dryRun ?? false,
      now: NOW,
    }),
  }
}

const premiumState = (config: RouterSettings | undefined) => {
  const settingsValue = config ?? settings()
  return {
    mode: settingsValue.premium.mode,
    monthlyBudgetUsd: settingsValue.premium.monthlyBudgetUsd,
    spentUsd: 0,
    remainingUsd: settingsValue.premium.monthlyBudgetUsd,
    oneShotGranted: false,
  }
}

describe("routing engine", () => {
  it("selects a qualified economical route for a trivial CSS change", () => {
    const { task, result } = run({ text: "Change the button background color to #2563eb in src/components/Button.tsx" })
    expect(task.tier).toBe(1)
    expect(result.decision.chosen).toBeDefined()
    expect(result.chosenModel?.premium).toBe(false)
    expect(result.chosenModel?.tier === 1 || result.chosenModel?.tier === 2).toBe(true)
  })

  it("enforces the standard intelligence floor for ordinary feature work", () => {
    const { task, result } = run({
      text: "Implement a responsive settings page with theme switching, keyboard navigation, and loading and error states.",
    })
    expect(task.tier).toBe(2)
    expect(result.chosenModel?.intelligence).toBeGreaterThanOrEqual(39.5)
    expect(result.chosenModel?.premium).toBe(false)
  })

  it("does not select a premium model for a sophisticated redesign without approval", () => {
    const { task, result } = run({
      text: "Redesign the landing page to match the attached Figma mockup. Improve typography, spacing, and responsive layout.",
      files: [{ uri: "file:///tmp/figma-mockup.png", name: "figma-mockup.png" }],
    })
    expect(task.tier).toBe(3)
    expect(result.chosenModel?.premium).toBe(false)
    expect(result.decision.needsPremiumApproval).toBe(true)
    expect(result.decision.warnings.join(" ")).toMatch(/Premium route suggested/)
    expect(result.decision.chosen?.id).not.toBe("glm-5.3")
  })

  it("never routes a screenshot task to a text-only model", () => {
    const { task, result } = run({
      text: "Debug this screenshot: the sidebar overlaps the header on small screens.",
      files: [{ uri: "file:///tmp/sidebar-screenshot.png", name: "sidebar-screenshot.png" }],
    })
    expect(task.requiresVision).toBe(true)
    expect(result.chosenModel?.inputModalities).toContain("image")
    expect(result.decision.chosen?.id).not.toBe("glm-5.3")
  })

  it("excludes unclassified discovered models", () => {
    const config = settings()
    const registry = buildRegistry({
      live: [
        {
          id: "brand-new-unscored",
          providerID: "opencode-go",
          name: "Brand New",
          limit: { context: 1_000_000, output: 10_000 },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
        },
      ],
      settings: config,
    })
    expect(registry.approved().some((model) => model.modelID === "brand-new-unscored")).toBe(false)
  })

  it("uses a premium model only after a one-shot approval", () => {
    const config = settings({ premium: { ...DEFAULT_SETTINGS.premium, mode: "ask", monthlyBudgetUsd: 0 } })
    const approvedSession = session({ premiumOneShot: true, premiumOneShotAt: NOW })
    const { result } = run({
      text: "Redesign the landing page to match the attached Figma mockup. Improve typography, spacing, and responsive layout.",
      files: [{ uri: "file:///tmp/figma-mockup.png", name: "figma-mockup.png" }],
      settings: config,
      session: approvedSession,
      premium: { ...premiumState(config), oneShotGranted: true, remainingUsd: 0 },
    })
    expect(result.chosenModel?.premium).toBe(true)
    expect(result.decision.switched).toBe(true)
    expect(result.decision.needsPremiumApproval).toBe(false)
  })

  it("avoids a provider whose five-hour window is near its reserve", () => {
    const config = settings()
    const { result } = run({
      text: "Implement a feature in src/app.ts",
      settings: config,
      quota: [provider("opencode-go", { rolling: 5, weekly: 20, monthly: 30 }), provider("commandcode", { rolling: 95, weekly: 30, monthly: 30 })],
    })
    expect(result.decision.chosen?.providerID).toBe("opencode-go")
  })

  it("blocks a provider at its weekly limit", () => {
    const { result } = run({
      text: "Implement a feature in src/app.ts",
      quota: [provider("opencode-go", { rolling: 5, weekly: 20, monthly: 30 }), provider("commandcode", { rolling: 5, weekly: 100, monthly: 30 })],
    })
    expect(result.decision.chosen?.providerID).toBe("opencode-go")
  })

  it("fails closed when only an exhausted provider with extra credits is available", () => {
    const config = settings({
      providers: {
        "opencode-go": { ...DEFAULT_SETTINGS.providers["opencode-go"]!, enabled: false },
        commandcode: { ...DEFAULT_SETTINGS.providers.commandcode!, reserveMonthlyPct: 0, reserveWeeklyPct: 0, reserveFiveHourPct: 0 },
      },
    })
    const exhausted: ProviderQuotaSnapshot = {
      ...provider("commandcode", { rolling: 20, weekly: 40, monthly: 100 }),
      monthly: { usedPct: 100, remainingPct: 0, source: "provider", exceeded: true },
      extraCredits: { purchasedUsd: 10, freeUsd: 0, totalUsd: 10 },
    }
    const { result } = run({
      text: "Implement a feature in src/app.ts",
      settings: config,
      quota: [exhausted],
    })
    expect(result.decision.chosen).toBeUndefined()
    expect(result.decision.warnings.join(" ")).toMatch(/No approved model|exhausted|credits/i)
  })

  it("keeps a large-context session on its current model instead of paying a cache-loss switch", () => {
    const config = settings()
    const large = session({ contextTokens: 600_000, cacheReadTokens: 550_000 })
    const { result } = run({
      text: "Implement a small feature in src/app.ts",
      current: deepseek,
      session: large,
      settings: config,
    })
    expect(result.decision.chosen?.providerID).toBe("opencode-go")
    expect(result.decision.chosen?.id).toBe("deepseek-v4.1-flash")
    expect(result.decision.switched).toBe(false)
  })

  it("respects manual selection and paused runtime", () => {
    const manual = run({ text: "Implement a feature", runtime: "manual" })
    expect(manual.result.decision.switched).toBe(false)
    expect(manual.result.decision.manualOverride).toBe(true)
    const paused = run({ text: "Implement a feature", runtime: "paused" })
    expect(paused.result.decision.switched).toBe(false)
    expect(paused.result.decision.runtime).toBe("paused")
  })

  it("locks premium in Maximum Efficiency mode", () => {
    const config = settings({ premium: { ...DEFAULT_SETTINGS.premium, mode: "allowed", monthlyBudgetUsd: 10 } })
    const { result } = run({
      text: "Redesign the landing page. Improve typography and responsive layout.",
      settings: config,
      mode: "efficiency",
    })
    expect(result.chosenModel?.premium).toBe(false)
    expect(result.decision.needsPremiumApproval).toBe(false)
  })

  it("permits premium in Premium Allowed mode when a budget is configured", () => {
    const config = settings({ premium: { ...DEFAULT_SETTINGS.premium, mode: "allowed", monthlyBudgetUsd: 10 } })
    const { result } = run({
      text: "Redesign the landing page. Improve typography and responsive layout.",
      settings: config,
      mode: "premium",
      premium: { ...premiumState(config), mode: "allowed", monthlyBudgetUsd: 10, remainingUsd: 10 },
    })
    expect(result.chosenModel?.premium).toBe(true)
    expect(result.decision.switched).toBe(true)
  })

  it("does not switch in dry-run mode", () => {
    const { result } = run({ text: "Implement a feature in src/app.ts", dryRun: true })
    expect(result.decision.switched).toBe(false)
    expect(result.decision.dryRun).toBe(true)
    expect(result.decision.chosen).toBeDefined()
  })

  it("prices cache loss when switching models", () => {
    const registry = buildRegistry({ live: [], settings: settings() })
    const model = registry.get("opencode-go", "deepseek-v4.1-flash")!
    const task = classifyTask({ text: "Implement a feature in src/app.ts" })
    const same = estimateTaskCost({ model, task, contextTokens: 600_000, currentModelKey: "opencode-go/deepseek-v4.1-flash" })
    const different = estimateTaskCost({ model, task, contextTokens: 600_000, currentModelKey: "commandcode/deepseek-v4.1-flash" })
    expect(different.usd).toBeGreaterThan(same.usd)
    expect(different.switchPenaltyUsd).toBeGreaterThan(0)
  })
})

describe("quota-aware provider preference", () => {
  it("prefers the provider whose tightest short window has more headroom", () => {
    const { result } = run({
      text: "Implement a feature in src/app.ts",
      quota: [
        provider("opencode-go", { rolling: 0, weekly: 39, monthly: 69 }),
        provider("commandcode", { rolling: 0, weekly: 72, monthly: 36 }),
      ],
    })
    expect(result.decision.chosen?.providerID).toBe("opencode-go")
    expect(result.decision.reasons.join(" ")).toMatch(/OpenCode Go Plus/)
  })
})
