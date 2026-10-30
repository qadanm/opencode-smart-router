import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type {
  CostTier,
  ModelDefinition,
  ModelSettings,
  PremiumSettings,
  PrivacySettings,
  ProviderSettings,
  RouterSettings,
} from "./types.js"

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export interface SettingsLoadResult {
  settings: RouterSettings
  warnings: string[]
  sources: string[]
}

const providerDefaults = (plan: string, extra: Partial<ProviderSettings> = {}): ProviderSettings => ({
  enabled: true,
  plan,
  reserveMonthlyPct: 10,
  reserveWeeklyPct: 15,
  reserveFiveHourPct: 10,
  allowExtraUsage: false,
  probeUsage: true,
  ...extra,
})

export const DEFAULT_SETTINGS: RouterSettings = {
  enabled: true,
  mode: "balanced",
  dryRun: false,
  providers: {
    // OpenCode Go: per-model monthly allowances. The plan catalog holds the
    // per-model table; the provider settings only carry policy.
    "opencode-go": providerDefaults("go"),
    commandcode: providerDefaults("goat", {
      probeUsage: true,
      monthlyCreditsUsd: 70,
      fiveHourCapUsd: 14,
      weeklyCapUsd: 35,
    }),
    // OpenDesign is optional and disabled by default. A user without
    // OpenDesign credentials sees no behavior change at all.
    //
    // Pro is the default assumed tier because it is the only tier with a
    // separate plan-model pool; the catalog is authoritative for the numbers
    // and the live gateway is authoritative for entitlement.
    opendesign: providerDefaults("pro", {
      enabled: false,
      probeUsage: true,
      reserveMonthlyPct: 5,
      reserveWeeklyPct: 10,
      reserveFiveHourPct: 0,
      allowExtraUsage: false,
      subscriptionOnly: true,
      providerScopedQuota: true,
      // Pro has no five-hour Design Plan window.
      ignoreFiveHourWindow: true,
    }),
  },
  privacy: {
    allowTrainingModels: false,
    allowFreeModels: false,
    requireZdr: false,
  },
  premium: {
    mode: "ask",
    monthlyBudgetUsd: 0,
    oneShotApproval: true,
  },
  routing: {
    intelligenceFloor: 39.5,
    designFloor: 60,
    sophisticatedDesignFloor: 75,
    switchHysteresisPct: 20,
    largeContextTokens: 300_000,
    largeContextHysteresisPct: 35,
    maxEscalationsPerTask: 2,
    preferSameProvider: true,
    failClosed: true,
    protectEscalationPool: true,
    longContextFloorTokens: 1_000_000,
  },
  quota: {
    probeOpenCodeGo: true,
    probeCommandCode: true,
    probeOpenDesign: true,
    probeIntervalMinutes: 5,
    bootstrapSessions: 100,
    bootstrapDays: 31,
  },
  contextHealth: {
    enabled: true,
    warnAtTokens: 400_000,
    recommendAtTokens: 700_000,
  },
  // Preserve full context by default. Compaction is a destructive operation
  // that only ever existed to survive a small allowance.
  contextManagement: {
    mode: "native",
    enabled: true,
    compactAtTokens: 0,
    cooldownMinutes: 10,
    allowEmergencyCompaction: true,
  },
  speed: {
    enabled: true,
    weightPct: 15,
    minSamples: 3,
    slowRouteMultiple: 2.5,
  },
  ui: {
    titleIndicator: true,
    notifications: true,
    compactMode: false,
    compact: false,
  },
  logging: {
    storePromptText: false,
    decisionLogSize: 100,
    diagnostics: true,
  },
  models: {
    approved: [],
    excluded: [],
    tierOverrides: {},
    definitions: [],
  },
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asBoolean = (value: unknown, fallback: boolean, warnings: string[], path: string): boolean => {
  if (typeof value === "boolean") return value
  warnings.push(`${path} must be a boolean; using ${fallback}`)
  return fallback
}

const asNumber = (
  value: unknown,
  fallback: number,
  warnings: string[],
  path: string,
  min: number,
  max: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`${path} must be a finite number; using ${fallback}`)
    return fallback
  }
  const clamped = Math.min(max, Math.max(min, value))
  if (clamped !== value) warnings.push(`${path} was clamped to ${clamped}`)
  return clamped
}

const asString = (value: unknown, fallback: string, warnings: string[], path: string): string => {
  if (typeof value === "string" && value.trim().length > 0) return value.trim()
  warnings.push(`${path} must be a non-empty string; using ${fallback}`)
  return fallback
}

const asEnum = <T extends string>(
  value: unknown,
  values: ReadonlyArray<T>,
  fallback: T,
  warnings: string[],
  path: string,
): T => {
  if (typeof value === "string" && (values as ReadonlyArray<string>).includes(value)) return value as T
  warnings.push(`${path} must be one of ${values.join(", ")}; using ${fallback}`)
  return fallback
}

const asStringArray = (value: unknown, fallback: string[], warnings: string[], path: string): string[] => {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    warnings.push(`${path} must be an array of strings; using the previous value`)
    return fallback
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
}

const validateProvider = (
  value: unknown,
  base: ProviderSettings,
  warnings: string[],
  path: string,
): ProviderSettings => {
  if (!isRecord(value)) {
    warnings.push(`${path} must be an object; using defaults`)
    return base
  }
  return {
    enabled: asBoolean(value.enabled, base.enabled, warnings, `${path}.enabled`),
    plan: asString(value.plan, base.plan, warnings, `${path}.plan`),
    reserveMonthlyPct: asNumber(value.reserveMonthlyPct, base.reserveMonthlyPct, warnings, `${path}.reserveMonthlyPct`, 0, 90),
    reserveWeeklyPct: asNumber(value.reserveWeeklyPct, base.reserveWeeklyPct, warnings, `${path}.reserveWeeklyPct`, 0, 90),
    reserveFiveHourPct: asNumber(value.reserveFiveHourPct, base.reserveFiveHourPct, warnings, `${path}.reserveFiveHourPct`, 0, 90),
    allowExtraUsage: asBoolean(value.allowExtraUsage, base.allowExtraUsage, warnings, `${path}.allowExtraUsage`),
    probeUsage: asBoolean(value.probeUsage, base.probeUsage, warnings, `${path}.probeUsage`),
    monthlyCreditsUsd:
      value.monthlyCreditsUsd === undefined
        ? base.monthlyCreditsUsd
        : asNumber(value.monthlyCreditsUsd, base.monthlyCreditsUsd ?? 0, warnings, `${path}.monthlyCreditsUsd`, 0, 1_000_000),
    fiveHourCapUsd:
      value.fiveHourCapUsd === undefined
        ? base.fiveHourCapUsd
        : asNumber(value.fiveHourCapUsd, base.fiveHourCapUsd ?? 0, warnings, `${path}.fiveHourCapUsd`, 0, 1_000_000),
    weeklyCapUsd:
      value.weeklyCapUsd === undefined
        ? base.weeklyCapUsd
        : asNumber(value.weeklyCapUsd, base.weeklyCapUsd ?? 0, warnings, `${path}.weeklyCapUsd`, 0, 1_000_000),
    credentialPath:
      value.credentialPath === undefined
        ? base.credentialPath
        : asString(value.credentialPath, base.credentialPath ?? "", warnings, `${path}.credentialPath`) || undefined,
    baseURL:
      value.baseURL === undefined
        ? base.baseURL
        : asString(value.baseURL, base.baseURL ?? "", warnings, `${path}.baseURL`) || undefined,
    controlBaseURL:
      value.controlBaseURL === undefined
        ? base.controlBaseURL
        : asString(value.controlBaseURL, base.controlBaseURL ?? "", warnings, `${path}.controlBaseURL`) || undefined,
    controlKeyPath:
      value.controlKeyPath === undefined
        ? base.controlKeyPath
        : asString(value.controlKeyPath, base.controlKeyPath ?? "", warnings, `${path}.controlKeyPath`) || undefined,
    subscriptionOnly:
      value.subscriptionOnly === undefined
        ? base.subscriptionOnly
        : asBoolean(value.subscriptionOnly, base.subscriptionOnly ?? true, warnings, `${path}.subscriptionOnly`),
    creditsPerUsd:
      value.creditsPerUsd === undefined
        ? base.creditsPerUsd
        : asNumber(value.creditsPerUsd, base.creditsPerUsd ?? 10_000, warnings, `${path}.creditsPerUsd`, 1, 10_000_000),
    uncertaintyMarginPct:
      value.uncertaintyMarginPct === undefined
        ? base.uncertaintyMarginPct
        : asNumber(
            value.uncertaintyMarginPct,
            base.uncertaintyMarginPct ?? 20,
            warnings,
            `${path}.uncertaintyMarginPct`,
            0,
            500,
          ),
    unknownQuotaPolicy:
      value.unknownQuotaPolicy === undefined
        ? base.unknownQuotaPolicy
        : asEnum(
            value.unknownQuotaPolicy,
            ["route", "block", "ask"] as const,
            base.unknownQuotaPolicy ?? "route",
            warnings,
            `${path}.unknownQuotaPolicy`,
          ),
    multiplierOverrides:
      value.multiplierOverrides === undefined
        ? base.multiplierOverrides
        : normalizeMultiplierOverrides(value.multiplierOverrides, base.multiplierOverrides, warnings, `${path}.multiplierOverrides`),
    providerScopedQuota:
      value.providerScopedQuota === undefined
        ? base.providerScopedQuota
        : asBoolean(value.providerScopedQuota, base.providerScopedQuota ?? false, warnings, `${path}.providerScopedQuota`),
    ignoreFiveHourWindow:
      value.ignoreFiveHourWindow === undefined
        ? base.ignoreFiveHourWindow
        : asBoolean(value.ignoreFiveHourWindow, base.ignoreFiveHourWindow ?? false, warnings, `${path}.ignoreFiveHourWindow`),
    ignoreWeeklyWindow:
      value.ignoreWeeklyWindow === undefined
        ? base.ignoreWeeklyWindow
        : asBoolean(value.ignoreWeeklyWindow, base.ignoreWeeklyWindow ?? false, warnings, `${path}.ignoreWeeklyWindow`),
  }
}

const finiteNonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

const normalizeMultiplierOverrides = (
  value: unknown,
  base: Readonly<Record<string, number>> | undefined,
  warnings: string[],
  path: string,
): Readonly<Record<string, number>> | undefined => {
  if (value === undefined) return base
  if (!isRecord(value)) {
    warnings.push(`${path} must be an object; using the previous value`)
    return base
  }
  const out: Record<string, number> = { ...(base ?? {}) }
  for (const [modelID, multiplier] of Object.entries(value)) {
    const parsed = finiteNonNegative(multiplier)
    if (parsed === undefined || parsed <= 0) {
      warnings.push(`${path}.${modelID} must be a positive number; the entry was ignored`)
      continue
    }
    out[modelID] = parsed
  }
  return out
}

const normalizeCostTiers = (value: unknown, index: number, warnings: string[]): CostTier[] => {
  if (!Array.isArray(value) || value.length === 0) {
    warnings.push(`models.definitions[${index}].cost must contain at least one tier; definition ignored`)
    return []
  }
  const output: CostTier[] = []
  value.forEach((item, tierIndex) => {
    if (!isRecord(item)) {
      warnings.push(`models.definitions[${index}].cost[${tierIndex}] must be an object; ignored`)
      return
    }
    const input = finiteNonNegative(item.input)
    const outputCost = finiteNonNegative(item.output)
    if (input === undefined || outputCost === undefined) {
      warnings.push(
        `models.definitions[${index}].cost[${tierIndex}] needs non-negative finite input and output; ignored`,
      )
      return
    }
    const cache = isRecord(item.cache) ? item.cache : undefined
    output.push({
      input,
      output: outputCost,
      cache: {
        read: finiteNonNegative(cache?.read) ?? 0,
        write: finiteNonNegative(cache?.write) ?? 0,
      },
    })
  })
  return output
}

const validateDefinitions = (value: unknown, warnings: string[]): ModelDefinition[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    warnings.push("models.definitions must be an array; ignored")
    return []
  }
  const output: ModelDefinition[] = []
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`models.definitions[${index}] must be an object; ignored`)
      return
    }
    const key = typeof entry.key === "string" ? entry.key.trim() : ""
    const providerID = typeof entry.providerID === "string" ? entry.providerID.trim() : ""
    const modelID = typeof entry.modelID === "string" ? entry.modelID.trim() : ""
    const name = typeof entry.name === "string" ? entry.name.trim() : modelID
    const tier = entry.tier === 1 || entry.tier === 2 || entry.tier === 3 ? entry.tier : 0
    if (!key || !providerID || !modelID || !tier) {
      warnings.push(`models.definitions[${index}] needs key, providerID, modelID, and tier 1-3; ignored`)
      return
    }
    const input = Array.isArray(entry.input) && entry.input.every((item) => typeof item === "string") ? entry.input : ["text"]
    const cost = normalizeCostTiers(entry.cost, index, warnings)
    if (cost.length === 0) return
    output.push({
      key,
      providerID,
      modelID,
      name,
      context: Math.max(1, Number(entry.context) || 0),
      maxOutput: Math.max(1, Number(entry.maxOutput) || 0),
      input,
      cost,
      intelligence: Math.max(0, Number(entry.intelligence) || 0),
      design: Math.max(0, Number(entry.design) || 0),
      premium: entry.premium === true,
      training: entry.training === true,
      free: entry.free === true,
      tier,
      approved: entry.approved !== false,
      monthlyAllowanceUsd: Math.max(0, Number(entry.monthlyAllowanceUsd) || 0),
    })
  })
  return output
}

const validateModels = (value: unknown, base: ModelSettings, warnings: string[]): ModelSettings => {
  if (!isRecord(value)) {
    warnings.push("models must be an object; using defaults")
    return base
  }
  const overrides: Record<string, 1 | 2 | 3> = { ...base.tierOverrides }
  if (value.tierOverrides !== undefined) {
    if (!isRecord(value.tierOverrides)) {
      warnings.push("models.tierOverrides must be an object; using the previous value")
    } else {
      for (const [key, tier] of Object.entries(value.tierOverrides)) {
        if (tier === 1 || tier === 2 || tier === 3) overrides[key] = tier
        else warnings.push(`models.tierOverrides.${key} must be 1, 2, or 3; ignored`)
      }
    }
  }
  return {
    approved: asStringArray(value.approved, base.approved as string[], warnings, "models.approved"),
    excluded: asStringArray(value.excluded, base.excluded as string[], warnings, "models.excluded"),
    tierOverrides: overrides,
    definitions: validateDefinitions(value.definitions, warnings),
  }
}

/**
 * Validate a partial settings object and merge it over a base. Unknown keys are
 * ignored with a warning; invalid values never crash plugin startup.
 */
export const validateSettings = (input: unknown, base: RouterSettings = DEFAULT_SETTINGS): SettingsLoadResult => {
  const warnings: string[] = []
  if (!isRecord(input)) {
    return { settings: base, warnings: ["settings must be a JSON object"], sources: [] }
  }

  const providers: Record<string, ProviderSettings> = { ...base.providers }
  if (input.providers !== undefined) {
    if (!isRecord(input.providers)) {
      warnings.push("providers must be an object; using defaults")
    } else {
      for (const [id, value] of Object.entries(input.providers)) {
        providers[id] = validateProvider(value, providers[id] ?? providerDefaults("custom"), warnings, `providers.${id}`)
      }
    }
  }

  const privacyInput = isRecord(input.privacy) ? input.privacy : {}
  const privacy: PrivacySettings = {
    allowTrainingModels: asBoolean(
      privacyInput.allowTrainingModels,
      base.privacy.allowTrainingModels,
      warnings,
      "privacy.allowTrainingModels",
    ),
    allowFreeModels: asBoolean(privacyInput.allowFreeModels, base.privacy.allowFreeModels, warnings, "privacy.allowFreeModels"),
    requireZdr: asBoolean(privacyInput.requireZdr, base.privacy.requireZdr, warnings, "privacy.requireZdr"),
  }

  const premiumInput = isRecord(input.premium) ? input.premium : {}
  const premium: PremiumSettings = {
    mode: asEnum(premiumInput.mode, ["off", "ask", "allowed"] as const, base.premium.mode, warnings, "premium.mode"),
    monthlyBudgetUsd: asNumber(
      premiumInput.monthlyBudgetUsd,
      base.premium.monthlyBudgetUsd,
      warnings,
      "premium.monthlyBudgetUsd",
      0,
      100_000,
    ),
    oneShotApproval: asBoolean(premiumInput.oneShotApproval, base.premium.oneShotApproval, warnings, "premium.oneShotApproval"),
  }

  const routingInput = isRecord(input.routing) ? input.routing : {}
  const routing = {
    intelligenceFloor: asNumber(
      routingInput.intelligenceFloor,
      base.routing.intelligenceFloor,
      warnings,
      "routing.intelligenceFloor",
      0,
      100,
    ),
    designFloor: asNumber(routingInput.designFloor, base.routing.designFloor, warnings, "routing.designFloor", 0, 100),
    sophisticatedDesignFloor: asNumber(
      routingInput.sophisticatedDesignFloor,
      base.routing.sophisticatedDesignFloor,
      warnings,
      "routing.sophisticatedDesignFloor",
      0,
      100,
    ),
    switchHysteresisPct: asNumber(
      routingInput.switchHysteresisPct,
      base.routing.switchHysteresisPct,
      warnings,
      "routing.switchHysteresisPct",
      0,
      100,
    ),
    largeContextTokens: asNumber(
      routingInput.largeContextTokens,
      base.routing.largeContextTokens,
      warnings,
      "routing.largeContextTokens",
      10_000,
      5_000_000,
    ),
    largeContextHysteresisPct: asNumber(
      routingInput.largeContextHysteresisPct,
      base.routing.largeContextHysteresisPct,
      warnings,
      "routing.largeContextHysteresisPct",
      0,
      100,
    ),
    maxEscalationsPerTask: asNumber(
      routingInput.maxEscalationsPerTask,
      base.routing.maxEscalationsPerTask,
      warnings,
      "routing.maxEscalationsPerTask",
      0,
      5,
    ),
    preferSameProvider: asBoolean(
      routingInput.preferSameProvider,
      base.routing.preferSameProvider,
      warnings,
      "routing.preferSameProvider",
    ),
    failClosed: asBoolean(routingInput.failClosed, base.routing.failClosed, warnings, "routing.failClosed"),
    protectEscalationPool: asBoolean(
      routingInput.protectEscalationPool,
      base.routing.protectEscalationPool,
      warnings,
      "routing.protectEscalationPool",
    ),
    longContextFloorTokens: asNumber(
      routingInput.longContextFloorTokens,
      base.routing.longContextFloorTokens,
      warnings,
      "routing.longContextFloorTokens",
      10_000,
      10_000_000,
    ),
  }

  const quotaInput = isRecord(input.quota) ? input.quota : {}
  const quota = {
    probeOpenCodeGo: asBoolean(quotaInput.probeOpenCodeGo, base.quota.probeOpenCodeGo, warnings, "quota.probeOpenCodeGo"),
    probeCommandCode: asBoolean(quotaInput.probeCommandCode, base.quota.probeCommandCode, warnings, "quota.probeCommandCode"),
    probeOpenDesign: asBoolean(quotaInput.probeOpenDesign, base.quota.probeOpenDesign, warnings, "quota.probeOpenDesign"),
    probeIntervalMinutes: asNumber(
      quotaInput.probeIntervalMinutes,
      base.quota.probeIntervalMinutes,
      warnings,
      "quota.probeIntervalMinutes",
      0,
      1440,
    ),
    bootstrapSessions: asNumber(
      quotaInput.bootstrapSessions,
      base.quota.bootstrapSessions,
      warnings,
      "quota.bootstrapSessions",
      0,
      500,
    ),
    bootstrapDays: asNumber(quotaInput.bootstrapDays, base.quota.bootstrapDays, warnings, "quota.bootstrapDays", 0, 365),
  }

  const healthInput = isRecord(input.contextHealth) ? input.contextHealth : {}
  const contextHealth = {
    enabled: asBoolean(healthInput.enabled, base.contextHealth.enabled, warnings, "contextHealth.enabled"),
    warnAtTokens: asNumber(
      healthInput.warnAtTokens,
      base.contextHealth.warnAtTokens,
      warnings,
      "contextHealth.warnAtTokens",
      10_000,
      10_000_000,
    ),
    recommendAtTokens: asNumber(
      healthInput.recommendAtTokens,
      base.contextHealth.recommendAtTokens,
      warnings,
      "contextHealth.recommendAtTokens",
      10_000,
      10_000_000,
    ),
  }

  const uiInput = isRecord(input.ui) ? input.ui : {}
  const compactToggle = asBoolean(
    uiInput.compactMode ?? uiInput.compact ?? input.compactMode ?? input.compact,
    base.ui.compactMode || base.ui.compact,
    warnings,
    "ui.compactMode",
  )
  const ui = {
    titleIndicator: asBoolean(uiInput.titleIndicator, base.ui.titleIndicator, warnings, "ui.titleIndicator"),
    notifications: asBoolean(uiInput.notifications, base.ui.notifications, warnings, "ui.notifications"),
    compactMode: compactToggle,
    compact: compactToggle,
  }

  const loggingInput = isRecord(input.logging) ? input.logging : {}
  const logging = {
    storePromptText: asBoolean(loggingInput.storePromptText, base.logging.storePromptText, warnings, "logging.storePromptText"),
    decisionLogSize: asNumber(
      loggingInput.decisionLogSize,
      base.logging.decisionLogSize,
      warnings,
      "logging.decisionLogSize",
      10,
      2000,
    ),
    diagnostics: asBoolean(loggingInput.diagnostics, base.logging.diagnostics, warnings, "logging.diagnostics"),
  }

  const contextInput = isRecord(input.contextManagement) ? input.contextManagement : {}
  const contextManagement = {
    mode: asEnum(
      contextInput.mode,
      ["native", "conservative", "budget-optimized"] as const,
      base.contextManagement.mode,
      warnings,
      "contextManagement.mode",
    ),
    enabled: asBoolean(contextInput.enabled, base.contextManagement.enabled, warnings, "contextManagement.enabled"),
    compactAtTokens: asNumber(
      contextInput.compactAtTokens,
      base.contextManagement.compactAtTokens,
      warnings,
      "contextManagement.compactAtTokens",
      0,
      10_000_000,
    ),
    cooldownMinutes: asNumber(
      contextInput.cooldownMinutes,
      base.contextManagement.cooldownMinutes,
      warnings,
      "contextManagement.cooldownMinutes",
      1,
      1440,
    ),
    allowEmergencyCompaction: asBoolean(
      contextInput.allowEmergencyCompaction,
      base.contextManagement.allowEmergencyCompaction,
      warnings,
      "contextManagement.allowEmergencyCompaction",
    ),
  }

  const speedInput = isRecord(input.speed) ? input.speed : {}
  const speed = {
    enabled: asBoolean(speedInput.enabled, base.speed.enabled, warnings, "speed.enabled"),
    weightPct: asNumber(speedInput.weightPct, base.speed.weightPct, warnings, "speed.weightPct", 0, 100),
    minSamples: asNumber(speedInput.minSamples, base.speed.minSamples, warnings, "speed.minSamples", 1, 500),
    slowRouteMultiple: asNumber(
      speedInput.slowRouteMultiple,
      base.speed.slowRouteMultiple,
      warnings,
      "speed.slowRouteMultiple",
      1,
      20,
    ),
  }

  if (contextManagement.mode === "budget-optimized" && contextManagement.compactAtTokens <= 0) {
    warnings.push(
      "contextManagement.mode is budget-optimized but compactAtTokens is 0; only the cheapest route's verified window will trigger compaction",
    )
  }

  const settings: RouterSettings = {
    enabled: asBoolean(input.enabled, base.enabled, warnings, "enabled"),
    mode: asEnum(input.mode, ["efficiency", "balanced", "premium"] as const, base.mode, warnings, "mode"),
    dryRun: asBoolean(input.dryRun, base.dryRun, warnings, "dryRun"),
    compactMode: compactToggle,
    compact: compactToggle,
    providers,
    privacy,
    premium,
    routing,
    quota,
    contextHealth,
    contextManagement,
    speed,
    ui,
    logging,
    models: validateModels(input.models, base.models, warnings),
  }

  if (settings.premium.mode === "allowed" && settings.premium.monthlyBudgetUsd <= 0) {
    warnings.push("premium.mode is allowed but premium.monthlyBudgetUsd is 0; premium remains unavailable")
  }

  return { settings, warnings, sources: [] }
}

/**
 * Project files may tighten privacy or spending, but they cannot loosen global
 * policy. This protects a work repository from enabling training models or
 * premium spend through a checked-in config file.
 */
export const applyProjectGuardrails = (
  globalSettings: RouterSettings,
  projectInput: unknown,
  warnings: string[],
): RouterSettings => {
  const candidate = validateSettings(projectInput, globalSettings).settings
  const tightened: RouterSettings = {
    ...candidate,
    enabled: globalSettings.enabled && candidate.enabled,
    privacy: {
      allowTrainingModels: globalSettings.privacy.allowTrainingModels && candidate.privacy.allowTrainingModels,
      allowFreeModels: globalSettings.privacy.allowFreeModels && candidate.privacy.allowFreeModels,
      requireZdr: globalSettings.privacy.requireZdr || candidate.privacy.requireZdr,
    },
    premium: {
      ...candidate.premium,
      mode:
        globalSettings.premium.mode === "off" || candidate.premium.mode === "off"
          ? "off"
          : globalSettings.premium.mode === "ask" || candidate.premium.mode === "ask"
            ? "ask"
            : "allowed",
      monthlyBudgetUsd: Math.min(globalSettings.premium.monthlyBudgetUsd, candidate.premium.monthlyBudgetUsd),
    },
    providers: Object.fromEntries(
      Object.entries(candidate.providers).map(([id, provider]) => {
        const globalProvider = globalSettings.providers[id]
        if (!globalProvider) return [id, { ...provider, enabled: false, allowExtraUsage: false }]
        return [
          id,
          {
            ...provider,
            enabled: globalProvider.enabled && provider.enabled,
            allowExtraUsage: globalProvider.allowExtraUsage && provider.allowExtraUsage,
          },
        ]
      }),
    ),
  }

  if (candidate.privacy.allowTrainingModels && !globalSettings.privacy.allowTrainingModels) {
    warnings.push("Project config tried to enable training models; global privacy setting kept it disabled")
  }
  if (candidate.premium.mode === "allowed" && globalSettings.premium.mode !== "allowed") {
    warnings.push("Project config tried to enable automatic premium routing; global setting kept it restricted")
  }
  return tightened
}

const readJson = (path: string, warnings: string[]): unknown | undefined => {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch (error) {
    warnings.push(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export interface LoadSettingsInput {
  options?: unknown
  directory?: string
  home?: string
  projectDirectory?: string
}

export const loadSettings = (input: LoadSettingsInput = {}): SettingsLoadResult => {
  const warnings: string[] = []
  const sources: string[] = []
  const home = input.home ?? homedir()
  const globalPath = join(home, ".config", "opencode", "smart-router.json")

  let settings = DEFAULT_SETTINGS

  if (input.options !== undefined) {
    settings = validateSettings(input.options, settings).settings
    sources.push("plugin options")
  }

  const globalInput = readJson(globalPath, warnings)
  if (globalInput !== undefined) {
    settings = validateSettings(globalInput, settings).settings
    sources.push(globalPath)
  }

  const projectDirectory = input.projectDirectory ?? input.directory
  if (projectDirectory) {
    const projectPath = join(projectDirectory, ".opencode", "smart-router.json")
    const projectInput = readJson(projectPath, warnings)
    if (projectInput !== undefined) {
      settings = applyProjectGuardrails(settings, projectInput, warnings)
      sources.push(projectPath)
    }
  }

  return { settings, warnings, sources }
}
