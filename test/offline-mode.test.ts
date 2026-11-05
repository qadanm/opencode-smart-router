import { describe, expect, it } from "vitest"
import {
  DEFAULT_OFFLINE_SETTINGS,
  MINIMUM_OFFLINE_CONTEXT,
  OFFLINE_PROVIDER_ID,
  checkOfflineReadiness,
  estimateResidentBytes,
  fitsInMemory,
  isLoopbackURL,
  keepAlive,
  mayUseProvider,
  offlineModelOptions,
  offlineRouteRefusal,
  type OfflineSettings,
} from "../src/core/offline/mode.js"
import { DEFAULT_SETTINGS, validateSettings } from "../src/core/config.js"
import { classifyTask } from "../src/core/classify/classifier.js"
import { buildRegistry } from "../src/core/models/registry.js"
import { routeTask } from "../src/core/routing/engine.js"
import type { RouterSettings } from "../src/core/types.js"
import { replyMarginFor, CONTEXT_SAFE_WINDOW_FRACTION } from "../src/core/context/strategy.js"

const offlineSettings = (): OfflineSettings => ({
  ...structuredClone(DEFAULT_OFFLINE_SETTINGS),
  enabled: true,
})

const ready = () => ({
  settings: offlineSettings(),
  endpointReachable: true,
  modelPresent: true,
})

describe("offline mode is an allow-list of one provider", () => {
  it("permits only the local provider", () => {
    expect(mayUseProvider(OFFLINE_PROVIDER_ID, "offline")).toBe(true)
    for (const hosted of ["opendesign", "opencode-go", "commandcode", "anthropic", "openai"]) {
      expect(mayUseProvider(hosted, "offline"), `${hosted} must be refused offline`).toBe(false)
    }
  })

  it("refuses a provider it has never heard of", () => {
    // The failure that matters is a provider added to the registry later. An
    // allow-list refuses it by default; a deny-list would have let it through.
    expect(mayUseProvider("some-future-provider", "offline")).toBe(false)
  })

  it("permits everything online", () => {
    for (const p of ["opendesign", "opencode-go", "ollama", "unknown-thing"]) {
      expect(mayUseProvider(p, "online")).toBe(true)
    }
  })

  it("explains the refusal in both directions", () => {
    const hosted = offlineRouteRefusal("opendesign", "offline")
    expect(hosted).toMatch(/hosted provider/i)
    expect(hosted).toMatch(/only ollama/i)
    const unknown = offlineRouteRefusal("mystery", "offline")
    expect(unknown).toMatch(/not the configured local provider/i)
    expect(offlineRouteRefusal("ollama", "offline")).toBeUndefined()
    expect(offlineRouteRefusal("opendesign", "online")).toBeUndefined()
  })
})

describe("offline mode fails closed with an actionable reason", () => {
  it("is ready when everything is present", () => {
    expect(checkOfflineReadiness(ready())).toBeUndefined()
  })

  it("refuses before anything else when the mode is off", () => {
    const blocker = checkOfflineReadiness({
      ...ready(),
      settings: { ...offlineSettings(), enabled: false },
    })
    expect(blocker?.code).toBe("mode-disabled")
    expect(blocker?.remedy).toMatch(/opencode-offline/)
  })

  it("refuses a missing endpoint and names the start command", () => {
    const blocker = checkOfflineReadiness({ ...ready(), endpointReachable: false })
    expect(blocker?.code).toBe("endpoint-unreachable")
    expect(blocker?.remedy).toMatch(/ollama serve/)
  })

  it("refuses a missing model and names the pull command", () => {
    const blocker = checkOfflineReadiness({ ...ready(), modelPresent: false })
    expect(blocker?.code).toBe("model-missing")
    expect(blocker?.remedy).toMatch(/ollama pull/)
    // The remedy must name the exact configured tag, not a generic example.
    expect(blocker?.remedy).toContain(offlineSettings().model.model)
  })

  it("refuses a missing model store instead of downloading internally", () => {
    // This is the case that would otherwise put 3 GB on the internal disk
    // without asking, which is the one thing the storage policy forbids.
    const settings: OfflineSettings = { ...offlineSettings(), modelStorePath: "/Volumes/Mac-Archive/ollama" }
    const blocker = checkOfflineReadiness({ ...ready(), settings, modelStoreMissing: true })
    expect(blocker?.code).toBe("model-store-missing")
    expect(blocker?.remedy).toMatch(/will not download a model to the internal disk/i)
  })

  it("refuses a context window too small for a screenshot", () => {
    const settings: OfflineSettings = {
      ...offlineSettings(),
      model: { ...offlineSettings().model, contextTokens: MINIMUM_OFFLINE_CONTEXT - 1 },
    }
    expect(checkOfflineReadiness({ ...ready(), settings })?.code).toBe("context-too-small")
  })

  it("refuses an image when the model has no vision", () => {
    const settings: OfflineSettings = {
      ...offlineSettings(),
      model: { ...offlineSettings().model, vision: false },
    }
    expect(checkOfflineReadiness({ ...ready(), settings, needsVision: true })?.code).toBe(
      "vision-unsupported",
    )
    // Without an image the same configuration is fine.
    expect(checkOfflineReadiness({ ...ready(), settings, needsVision: false })).toBeUndefined()
  })

  it("refuses a tool request the model cannot serve", () => {
    const settings: OfflineSettings = {
      ...offlineSettings(),
      model: { ...offlineSettings().model, tools: false },
    }
    expect(checkOfflineReadiness({ ...ready(), settings, needsTools: true })?.code).toBe(
      "tools-unsupported",
    )
  })

  it("treats a missing model store as the first blocker after the mode", () => {
    // Ordering matters: telling a user their endpoint is down when the real
    // problem is a disconnected drive sends them to the wrong fix.
    const settings: OfflineSettings = { ...offlineSettings(), modelStorePath: "/Volumes/Nope" }
    const blocker = checkOfflineReadiness({
      settings,
      endpointReachable: false,
      modelPresent: false,
      modelStoreMissing: true,
    })
    expect(blocker?.code).toBe("model-store-missing")
  })
})

describe("endpoint must be loopback", () => {
  it("accepts loopback forms", () => {
    for (const url of [
      "http://127.0.0.1:11434",
      "http://localhost:11434",
      "http://[::1]:11434",
      "http://127.1.2.3:11434",
    ]) {
      expect(isLoopbackURL(url), url).toBe(true)
    }
  })

  it("refuses routable addresses", () => {
    for (const url of [
      "http://0.0.0.0:11434",
      "http://192.168.1.20:11434",
      "http://10.0.0.5:11434",
      "https://api.openai.com/v1",
      "http://127.0.0.1.evil.test:11434",
    ]) {
      expect(isLoopbackURL(url), url).toBe(false)
    }
  })

  it("refuses an unparseable value", () => {
    expect(isLoopbackURL("not a url")).toBe(false)
    expect(isLoopbackURL("")).toBe(false)
  })
})

describe("offline model options are per-request, not server-wide", () => {
  it("carries the context and output caps", () => {
    const options = offlineModelOptions(offlineSettings().model)
    expect(options.num_ctx).toBe(8_192)
    expect(options.num_predict).toBe(2_048)
  })

  it("uses low temperature so the model does not rewrite working code", () => {
    expect(offlineModelOptions(offlineSettings().model).temperature).toBe(0.2)
  })

  it("expresses keep-alive in the form the API expects", () => {
    expect(keepAlive(offlineSettings().model)).toBe("5m")
    expect(keepAlive({ ...offlineSettings().model, keepAliveMinutes: 0 })).toBe("0m")
  })
})

describe("memory planning refuses to make the machine unusable", () => {
  it("computes a resident estimate above the weights", () => {
    const bytes = estimateResidentBytes({
      weightsBytes: 2_650_000_000,
      contextTokens: 8_192,
      kvBytesPerToken: 40_000,
      overheadBytes: 400_000_000,
    })
    expect(bytes).toBeGreaterThan(2_650_000_000)
  })

  it("rejects a model that would not fit the available share", () => {
    // 4 GB model against 3 GB available must be refused rather than swap the
    // machine into unusability.
    expect(fitsInMemory({ estimatedBytes: 4_000_000_000, availableBytes: 3_000_000_000, maxShare: 0.8 })).toBe(false)
    expect(fitsInMemory({ estimatedBytes: 2_000_000_000, availableBytes: 6_000_000_000, maxShare: 0.8 })).toBe(true)
  })
})

describe("settings validation treats offline as its own block", () => {
  it("defaults to disabled", () => {
    // Present in DEFAULT_SETTINGS so the block is visible, but off.
    expect(DEFAULT_SETTINGS.offline).toBeDefined()
    expect(DEFAULT_SETTINGS.offline?.enabled).toBe(false)
    expect(DEFAULT_OFFLINE_SETTINGS.enabled).toBe(false)
  })

  it("warns and falls back to loopback for a routable endpoint", () => {
    // A routable base URL would mean "local" inference that is not local, so it
    // must not be accepted silently.
    const result = validateSettings(
      { offline: { enabled: true, model: { baseURL: "http://192.168.1.9:11434" } } },
      DEFAULT_SETTINGS,
    )
    expect(result.settings.offline?.model.baseURL).toBe("http://127.0.0.1:11434")
    expect(result.warnings.join(" ")).toMatch(/not a loopback address/i)
  })

  it("keeps a valid loopback endpoint and model tag", () => {
    // validateSettings is called with merged config in loadSettings, so this
    // starts from the full default rather than a fragment; a fragment produces
    // unrelated warnings about every absent sibling block.
    const merged = structuredClone(DEFAULT_SETTINGS) as RouterSettings
    const withOffline: RouterSettings = {
      ...merged,
      offline: {
        ...structuredClone(DEFAULT_OFFLINE_SETTINGS),
        enabled: true,
        model: { ...DEFAULT_OFFLINE_SETTINGS.model, contextTokens: 16_384 },
      },
    }
    const result = validateSettings(withOffline, DEFAULT_SETTINGS)
    expect(result.settings.offline?.enabled).toBe(true)
    expect(result.settings.offline?.model.model).toBe("qwen3.5:4b-q4_K_M")
    expect(result.settings.offline?.model.contextTokens).toBe(16_384)
    expect(result.warnings).toEqual([])
  })

  it("warns when the context is below the screenshot minimum", () => {
    const result = validateSettings(
      { offline: { enabled: true, model: { contextTokens: 2_048 } } },
      DEFAULT_SETTINGS,
    )
    expect(result.warnings.join(" ")).toMatch(/below the 4096/i)
  })
})

describe("the offline flag is the only switch", () => {
  const withOffline = (enabled: boolean): RouterSettings => ({
    ...structuredClone(DEFAULT_SETTINGS),
    providers: {
      ...structuredClone(DEFAULT_SETTINGS.providers),
      opendesign: { ...structuredClone(DEFAULT_SETTINGS.providers.opendesign)!, enabled: true, plan: "pro" },
    },
    offline: { ...structuredClone(DEFAULT_OFFLINE_SETTINGS), enabled },
  })

  const run = (settings: RouterSettings, text: string, contextTokens = 10_000) => {
    const task = classifyTask({ text, files: [], contextTokens, recentFailures: 0 })
    const registry = buildRegistry({ live: [], settings, definitions: [] })
    return routeTask({
      task,
      settings,
      mode: settings.mode,
      runtime: "automatic",
      models: registry.approved(),
      session: {
        sessionID: "ses_offline_flag",
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
  }

  it("fails closed when no local model is registered", () => {
    // The registry has no ollama model in this fixture, which is the realistic
    // case before a local model is installed. The result must be a refusal, not
    // a fallback to DeepSeek.
    const result = run(withOffline(true), "Implement a small feature in src/app.ts")
    expect(result.decision.chosen).toBeUndefined()
    expect(result.decision.switchReason).toMatch(/No hosted provider will be used/i)
    expect(result.decision.warnings.join(" ")).toMatch(/fails closed/i)
    expect(result.decision.warnings.join(" ")).toMatch(/opencode-online/)
  })

  it("never returns a hosted provider while offline", () => {
    const result = run(withOffline(true), "Implement a small feature in src/app.ts")
    const chosen = result.decision.chosen
    if (chosen) expect(chosen.providerID).toBe(OFFLINE_PROVIDER_ID)
  })

  it("reports how many hosted models it excluded", () => {
    const result = run(withOffline(true), "Implement a small feature in src/app.ts")
    expect(result.decision.warnings.join(" ")).toMatch(/excluded .* hosted model/i)
  })

  it("leaves online routing completely alone", () => {
    const online = run(withOffline(false), "Implement a small feature in src/app.ts")
    const offline = run(withOffline(true), "Implement a small feature in src/app.ts")
    expect(`${online.decision.chosen?.providerID}/${online.decision.chosen?.id}`).toBe(
      "opendesign/glm-5.3-flash",
    )
    // The same task in offline mode must NOT produce the online answer.
    expect(`${offline.decision.chosen?.providerID}/${offline.decision.chosen?.id}`).not.toBe(
      "opendesign/glm-5.3-flash",
    )
  })
})

describe("the reply margin scales with small windows", () => {
  it("keeps the flat 20,000 margin for large windows", () => {
    // Unchanged behavior for the hosted models: the 1,048,000-token DeepSeek
    // window still reserves exactly 20,000 as it did before offline mode.
    expect(replyMarginFor(1_048_000)).toBe(20_000)
    expect(replyMarginFor(1_000_000)).toBe(20_000)
  })

  it("shrinks the margin for a small local window", () => {
    // A flat 20,000-token margin against an 8,192-token window is larger than
    // the window itself, so every offline request would be rejected before it
    // started. The margin must scale down instead.
    expect(replyMarginFor(8_192)).toBe(1_024)
    expect(replyMarginFor(8_192)).toBeLessThan(8_192)
  })

  it("never returns a negative or unbounded margin", () => {
    expect(replyMarginFor(0)).toBe(20_000)
    expect(replyMarginFor(-1)).toBe(20_000)
    expect(replyMarginFor(Number.NaN)).toBe(20_000)
    expect(replyMarginFor(120_000)).toBe(15_000)
  })

  it("leaves roughly 6,758 tokens of transcript in an 8K window", () => {
    const window = 8_192
    const usable = Math.floor(window * CONTEXT_SAFE_WINDOW_FRACTION) - replyMarginFor(window)
    expect(usable).toBe(6_758)
  })
})

describe("offline routing reaches the local model and nothing else", () => {
  const online = (): RouterSettings => ({
    ...structuredClone(DEFAULT_SETTINGS),
    providers: {
      ...structuredClone(DEFAULT_SETTINGS.providers),
      opendesign: { ...structuredClone(DEFAULT_SETTINGS.providers.opendesign)!, enabled: true, plan: "pro" },
    },
  })

  const offline = (): RouterSettings => ({
    ...online(),
    offline: { ...structuredClone(DEFAULT_OFFLINE_SETTINGS), enabled: true },
  })

  const route = (settings: RouterSettings, contextTokens: number, text = "Implement a small feature in src/app.ts") => {
    const task = classifyTask({ text, files: [], contextTokens, recentFailures: 0 })
    const registry = buildRegistry({ live: [], settings, definitions: [] })
    const models = settings.offline?.enabled ? registry.modelsForOffline() : registry.approved()
    return routeTask({
      task,
      settings,
      mode: settings.mode,
      runtime: "automatic",
      models,
      session: {
        sessionID: "ses_offline_route",
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
    }).decision
  }

  const chosenKey = (decision: { chosen?: { providerID: string; id: string } }) =>
    decision.chosen ? `${decision.chosen.providerID}/${decision.chosen.id}` : "BLOCKED"

  it("selects the local model when offline", () => {
    expect(chosenKey(route(offline(), 4_000))).toBe("ollama/qwen3.5:4b-q4_K_M")
  })

  it("still selects DeepSeek when online", () => {
    expect(chosenKey(route(online(), 4_000))).toBe("opendesign/glm-5.3-flash")
  })

  it("keeps the local model out of online routing even though it is registered", () => {
    const registry = buildRegistry({ live: [], settings: online(), definitions: [] })
    const local = registry.get("ollama", "qwen3.5:4b-q4_K_M")
    expect(local).toBeDefined()
    expect(local!.approved).toBe(false)
    expect(registry.approved().some((m) => m.providerID === "ollama")).toBe(false)
  })

  it("exposes the local model to offline even though it is unapproved", () => {
    const registry = buildRegistry({ live: [], settings: offline(), definitions: [] })
    const offlineModels = registry.modelsForOffline()
    expect(offlineModels.length).toBeGreaterThan(0)
    expect(offlineModels.every((m) => m.providerID === "ollama")).toBe(true)
  })

  it("routes exactly up to the 8K boundary and refuses past it", () => {
    // 8,192 * 0.95 - 1,024 = 6,758 usable transcript tokens.
    expect(chosenKey(route(offline(), 6_758))).toBe("ollama/qwen3.5:4b-q4_K_M")
    expect(chosenKey(route(offline(), 6_759))).toBe("BLOCKED")
  })

  it("still serves a vision request offline", () => {
    expect(chosenKey(route(offline(), 4_000, "Fix this visual bug in the screenshot"))).toBe(
      "ollama/qwen3.5:4b-q4_K_M",
    )
  })

  it("refuses rather than switching to a hosted model when the transcript is too large", () => {
    // The critical guarantee: no silent fallback. A large transcript offline is
    // a refusal, because the alternative is a hosted request on an airplane.
    const decision = route(offline(), 100_000)
    expect(decision.chosen).toBeUndefined()
    const providers = decision.candidates.map((c) => c.model.providerID)
    expect(providers).not.toContain("opendesign")
    expect(providers).not.toContain("opencode-go")
  })
})
