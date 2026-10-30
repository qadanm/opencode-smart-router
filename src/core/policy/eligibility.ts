import type {
  Mode,
  ModelQuotaSnapshot,
  ModelRecord,
  PremiumState,
  ProviderQuotaSnapshot,
  QuotaWindow,
  RouterSettings,
  SessionState,
  TaskClass,
} from "../types.js"
import { keyOfRef, modelKey, pct } from "../util.js"

export interface PremiumDecision {
  readonly allowed: boolean
  readonly requiresApproval: boolean
  readonly reason: string
}

export const decidePremium = (input: {
  settings: RouterSettings
  mode: Mode
  task: TaskClass
  session?: SessionState
  premium: PremiumState
}): PremiumDecision => {
  const { settings, mode, task, session, premium } = input
  const premiumTask = task.tier === 3 || task.constraints.requestPremium
  if (!premiumTask) {
    return { allowed: false, requiresApproval: false, reason: "Premium models are reserved for premium-tier work." }
  }
  if (settings.premium.mode === "off") {
    return { allowed: false, requiresApproval: false, reason: "Premium routing is off in settings." }
  }
  if (mode === "efficiency") {
    return { allowed: false, requiresApproval: false, reason: "Maximum Efficiency locks premium models unless you select one manually." }
  }
  if (session?.premiumOneShot && settings.premium.oneShotApproval) {
    return { allowed: true, requiresApproval: false, reason: "A one-shot premium approval is active for this session." }
  }
  if (mode === "premium" && settings.premium.mode === "allowed" && premium.remainingUsd > 0) {
    return {
      allowed: true,
      requiresApproval: false,
      reason: "Premium Allowed mode has a remaining premium budget.",
    }
  }
  if (premium.remainingUsd > 0 && settings.premium.mode === "allowed") {
    return { allowed: false, requiresApproval: true, reason: "Premium is available but requires this session's approval." }
  }
  return {
    allowed: false,
    requiresApproval: true,
    reason: "Premium escalation is disabled or has no remaining budget; approval is required.",
  }
}

export interface EligibilityInput {
  readonly model: ModelRecord
  readonly task: TaskClass
  readonly settings: RouterSettings
  readonly mode: Mode
  readonly contextTokens: number
  readonly providerQuota?: ProviderQuotaSnapshot
  readonly modelQuota?: ModelQuotaSnapshot
  readonly premium: PremiumDecision
  readonly currentModelKey?: string
  readonly allowDesignRelaxation?: boolean
  /** Estimated cost of the request, used by the subscription-only guard. */
  readonly projectedUsd?: number
  /**
   * True when an ordinary-allowance route can serve this task. A model funded
   * from an escalation pool is then refused, so routine work cannot drain the
   * capacity reserved for hard problems.
   */
  readonly escalationPoolProtected?: boolean
}

export interface EligibilityResult {
  readonly eligible: boolean
  readonly reason: string
  readonly warnings: string[]
}

const providerAuthFailure = (snapshot: ProviderQuotaSnapshot | undefined): boolean => {
  if (!snapshot?.error) return false
  return /authoriz|authenticat|unauthorized|forbidden|401|403|credential/i.test(snapshot.error)
}

const providerLimitReached = (snapshot: ProviderQuotaSnapshot | undefined, settings: RouterSettings): string | undefined => {
  if (!snapshot) return undefined
  const providerSettings = settings.providers[snapshot.providerID]
  if (!providerSettings) return undefined
  const reserveMonthly = providerSettings.reserveMonthlyPct
  const reserveWeekly = providerSettings.reserveWeeklyPct
  const reserveFive = providerSettings.reserveFiveHourPct
  const extras = snapshot.extraCredits?.totalUsd ?? 0
  const windowExceeded = Boolean(snapshot.monthly.exceeded || snapshot.weekly.exceeded || snapshot.rolling.exceeded)
  if (windowExceeded) {
    if (extras > 0 && providerSettings.allowExtraUsage) return undefined
    if (extras > 0) return "Provider would spend purchased credits; automatic extra-credit use is disabled"
    return "Provider allowance is exhausted"
  }
  // Some providers report a zero remaining balance slightly before they set
  // the window's exceeded flag. Treat the balance as authoritative so a
  // request cannot knowingly roll into purchased credits.
  if (snapshot.monthlyRemainingUsd !== undefined && snapshot.monthlyRemainingUsd <= 0) {
    if (extras > 0 && providerSettings.allowExtraUsage) return undefined
    if (extras > 0) return "Provider included credits are exhausted; automatic extra-credit use is disabled"
    return "Provider allowance is exhausted"
  }
  if (snapshot.monthly.source !== "unknown" && snapshot.monthly.usedPct >= 100 - reserveMonthly) {
    return "Provider monthly allowance is at or near its configured reserve"
  }
  if (snapshot.weekly.source !== "unknown" && snapshot.weekly.usedPct >= 100 - reserveWeekly) {
    return "Provider weekly allowance is at or near its configured reserve"
  }
  if (snapshot.rolling.source !== "unknown" && snapshot.rolling.usedPct >= 100 - reserveFive) {
    return "Provider five-hour allowance is at or near its configured reserve"
  }
  return undefined
}

const modelLimitReached = (quota: ModelQuotaSnapshot | undefined, settings: RouterSettings): string | undefined => {
  if (!quota) return undefined
  const provider = settings.providers[quota.model.providerID]
  if (!provider) return undefined
  if (quota.monthlyAllowanceUsd > 0 && quota.monthlyUsedPct >= 100 - provider.reserveMonthlyPct) {
    return "Estimated model monthly allowance is at or near its configured reserve"
  }
  if (quota.fiveHourCapUsd > 0 && quota.fiveHourUsedPct >= 100 - provider.reserveFiveHourPct) {
    return "Estimated model five-hour allowance is at or near its configured reserve"
  }
  if (quota.weeklyCapUsd > 0 && quota.weeklyUsedPct >= 100 - provider.reserveWeeklyPct) {
    return "Estimated model weekly allowance is at or near its configured reserve"
  }
  if (quota.blocked) return quota.blockReason ?? "Estimated model allowance is exhausted"
  return undefined
}

/**
 * Subscription-only guard.
 *
 * When the provider bills from a subscription allowance and purchased balance
 * is off limits, a request is only routed when it fits inside what is left of
 * the subscription. This is a client-side guard: OpenDesign's gateway makes
 * the final funding decision per request, so the router must never assume it
 * can prevent a server-side wallet charge. It only avoids sending a request
 * that it can already see would not fit.
 */
const subscriptionOnlyLimit = (
  snapshot: ProviderQuotaSnapshot | undefined,
  settings: RouterSettings,
  projectedUsd: number | undefined,
): string | undefined => {
  if (!snapshot) return undefined
  const providerSettings = settings.providers[snapshot.providerID]
  if (!providerSettings?.subscriptionOnly) return undefined
  if (projectedUsd === undefined || !Number.isFinite(projectedUsd) || projectedUsd <= 0) return undefined

  const windows: ReadonlyArray<{ readonly label: string; readonly window: QuotaWindow }> = [
    { label: "five-hour", window: snapshot.rolling },
    { label: "weekly", window: snapshot.weekly },
    { label: "monthly", window: snapshot.monthly },
  ]
  for (const { label, window } of windows) {
    if (window.source === "unknown") continue
    const cap = window.capUsd
    if (cap === undefined || cap <= 0) continue
    const used = window.usedUsd ?? 0
    const remaining = Math.max(0, cap - used)
    if (projectedUsd > remaining) {
      return `Subscription-only policy: the projected request cost ($${projectedUsd.toFixed(4)}) exceeds the remaining ${label} allowance ($${remaining.toFixed(2)})`
    }
  }
  return undefined
}

/**
 * Policy for a provider whose quota state could not be established.
 */
const unknownQuotaLimit = (
  snapshot: ProviderQuotaSnapshot | undefined,
  settings: RouterSettings,
): string | undefined => {
  if (!snapshot) return undefined
  const providerSettings = settings.providers[snapshot.providerID]
  if (!providerSettings) return undefined
  const state = snapshot.quotaState ?? (snapshot.source === "unknown" ? "unknown" : undefined)
  if (state !== "unknown" && state !== "unavailable") return undefined
  const policy = providerSettings.unknownQuotaPolicy ?? "route"
  if (policy === "route") return undefined
  if (policy === "ask") {
    return "Provider quota state is unknown; the configured policy requires explicit approval before routing here"
  }
  return "Provider quota state is unknown; the configured policy blocks routing here"
}

/**
 * Hard-requirement gate. A model is eligible only when every requirement is
 * met; expected-cost ranking happens later and never overrides these rules.
 */
export const evaluateEligibility = (input: EligibilityInput): EligibilityResult => {
  const { model, task, settings, mode, providerQuota, modelQuota, premium } = input
  const warnings: string[] = []
  const providerSettings = settings.providers[model.providerID]
  if (!providerSettings?.enabled) return { eligible: false, reason: "Provider is disabled in router settings", warnings }
  if (providerAuthFailure(providerQuota)) {
    return { eligible: false, reason: "Provider authentication is failing; fix the connection before routing here", warnings }
  }

  if (!model.approved) return { eligible: false, reason: "Model is unclassified or not approved", warnings }
  if (model.training && !settings.privacy.allowTrainingModels) {
    return { eligible: false, reason: "Training-enabled model is blocked by privacy policy", warnings }
  }
  if (model.free && !settings.privacy.allowFreeModels) {
    return { eligible: false, reason: "Free promotional model is blocked by privacy policy", warnings }
  }
  if (task.requiresVision && !model.inputModalities.includes("image")) {
    return { eligible: false, reason: "Task includes an image and this model has no native image input", warnings }
  }
  if (!model.tools) {
    return { eligible: false, reason: "Model does not support tool calling", warnings }
  }

  const requiredContext = Math.max(input.contextTokens, task.scope.promptTokens) + 20_000
  if (model.context > 0 && requiredContext > model.context * 0.95) {
    return { eligible: false, reason: `Context requirement ${requiredContext.toLocaleString()} exceeds this model's safe window`, warnings }
  }

  const substantive = task.tier >= 2
  if (substantive && model.intelligence < settings.routing.intelligenceFloor) {
    return {
      eligible: false,
      reason: `Intelligence ${model.intelligence.toFixed(1)} is below the ${settings.routing.intelligenceFloor.toFixed(1)} floor for substantive work`,
      warnings,
    }
  }
  if (task.tier <= 1 && model.tier === 3) {
    return { eligible: false, reason: "Premium models are not used for trivial or mechanical work", warnings }
  }

  let designFallbackThreshold: number | undefined
  if (task.designIntensive) {
    const threshold = task.sophisticatedDesign ? settings.routing.sophisticatedDesignFloor : settings.routing.designFloor
    if (model.design < threshold) {
      if (input.allowDesignRelaxation) {
        designFallbackThreshold = threshold
        warnings.push(
          `Design capability ${model.design} is below the preferred ${threshold} threshold; selected as the best available fallback`,
        )
      } else {
        return {
          eligible: false,
          reason: `Design capability ${model.design} is below the ${threshold} threshold`,
          warnings,
        }
      }
    }
  }

  if (model.premium) {
    if (!premium.allowed) {
      return { eligible: false, reason: premium.reason, warnings }
    }
    if (task.tier < 3 && !task.constraints.requestPremium) {
      return { eligible: false, reason: "Premium models are reserved for premium-tier work", warnings }
    }
  }

  // An escalation pool is capacity, not routine allowance. When an
  // ordinary-allowance route can already serve the task, spending the
  // escalation pool on it converts a cheap request into a scarce one.
  if (model.escalationOnly && input.escalationPoolProtected) {
    return {
      eligible: false,
      reason:
        "This model is funded from an escalation pool, and an ordinary-allowance route can serve this task",
      warnings,
    }
  }

  const providerLimit = providerLimitReached(providerQuota, settings)
  if (providerLimit) return { eligible: false, reason: providerLimit, warnings }
  const unknownLimit = unknownQuotaLimit(providerQuota, settings)
  if (unknownLimit) return { eligible: false, reason: unknownLimit, warnings }
  const subscriptionLimit = subscriptionOnlyLimit(providerQuota, settings, input.projectedUsd)
  if (subscriptionLimit) return { eligible: false, reason: subscriptionLimit, warnings }
  const modelLimit = modelLimitReached(modelQuota, settings)
  if (modelLimit) return { eligible: false, reason: modelLimit, warnings }

  // Maximum Efficiency mode prefers economy for qualifying work but still
  // permits standard models when the task clears the standard floor.
  if (mode === "efficiency" && task.tier >= 2 && model.tier === 1) {
    return { eligible: false, reason: "Economy models cannot handle substantive engineering in Maximum Efficiency mode", warnings }
  }

  if (designFallbackThreshold !== undefined) {
    return {
      eligible: true,
      reason: `Eligible only as a design fallback: design ${model.design} is below the ${designFallbackThreshold} threshold`,
      warnings,
    }
  }

  return { eligible: true, reason: "Meets every hard requirement", warnings }
}

export const providerPressure = (snapshot: ProviderQuotaSnapshot | undefined): number => {
  if (!snapshot) return 1.5
  const allUnknown =
    snapshot.monthly.source === "unknown" && snapshot.weekly.source === "unknown" && snapshot.rolling.source === "unknown"
  if (allUnknown) return 1.5
  const monthly = snapshot.monthly.source === "unknown" ? 0 : snapshot.monthly.usedPct
  const weekly = snapshot.weekly.source === "unknown" ? 0 : snapshot.weekly.usedPct
  const rolling = snapshot.rolling.source === "unknown" ? 0 : snapshot.rolling.usedPct
  return (
    1 +
    1.5 * (monthly / 100) ** 2 +
    2.5 * (weekly / 100) ** 2 +
    2.5 * (rolling / 100) ** 2 +
    (snapshot.stale ? 0.15 : 0)
  )
}

export const modelPressure = (quota: ModelQuotaSnapshot | undefined): number => {
  if (!quota) return 1
  return (
    1 +
    1.5 * (quota.monthlyUsedPct / 100) ** 2 +
    1 * (quota.fiveHourUsedPct / 100) ** 2 +
    1 * (quota.weeklyUsedPct / 100) ** 2
  )
}

export const providerUtilization = (snapshot: ProviderQuotaSnapshot | undefined): number => {
  if (!snapshot) return 0
  return Math.max(
    snapshot.monthly.source === "unknown" ? 0 : snapshot.monthly.usedPct,
    snapshot.weekly.source === "unknown" ? 0 : snapshot.weekly.usedPct,
    snapshot.rolling.source === "unknown" ? 0 : snapshot.rolling.usedPct,
  )
}

export const modelKeyFor = (model: ModelRecord) => modelKey(model.providerID, model.modelID)
export const currentKey = (current: { providerID: string; id: string } | undefined) => keyOfRef(current)
export const utilizationPct = (used: number, cap: number) => pct(used, cap)
