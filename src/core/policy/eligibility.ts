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
import {
  CONTEXT_ELIGIBILITY_MARGIN_TOKENS,
  CONTEXT_SAFE_WINDOW_FRACTION,
  replyMarginFor,
} from "../context/strategy.js"
import { OFFLINE_PROVIDER_ID } from "../offline/mode.js"

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
  /**
   * Why the model was rejected, when that reason is worth reporting to a user.
   * `context` is the case that matters: the model is a good route but the
   * transcript no longer fits, which is a different situation from being
   * unqualified or over budget.
   */
  readonly rejectedFor?: "context"
  readonly contextRequiredTokens?: number
  readonly contextWindowTokens?: number
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
 * True when the online intelligence floor should be enforced for this model.
 *
 * Offline mode deliberately exempts local models: the owner has chosen to work
 * with what runs on the machine, and no model small enough to fit alongside a
 * simulator scores at the hosted standard floor.
 */
const substanceFloorApplies = (settings: RouterSettings, model: ModelRecord): boolean => {
  if (settings.offline?.enabled !== true) return true
  return model.providerID !== OFFLINE_PROVIDER_ID
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

  /**
   * Approval is an online-policy concept: it means "may this model serve paid
   * work alongside the hosted floor". A local model is excluded from that list
   * on purpose so it never competes with hosted models when the network is up.
   *
   * Offline mode therefore skips this check for local models. The candidate
   * list has already been restricted to them, so this cannot admit a hosted
   * model that would otherwise be refused; it only stops an unapproved local
   * model from being rejected for a reason that does not apply to it.
   */
  const offlineLocal = settings.offline?.enabled === true && model.providerID === OFFLINE_PROVIDER_ID
  if (!model.approved && !offlineLocal) {
    return { eligible: false, reason: "Model is unclassified or not approved", warnings }
  }
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

  // The margin and the safety fraction are shared with the compaction strategy
  // rather than repeated as literals. They used to be written out here as
  // `20_000` and `0.95`, which meant editing the constants in strategy.ts would
  // move the compaction threshold while leaving this routing gate behind, so a
  // session would compact at a different size than the router refuses to route
  // at. For DeepSeek V4.1 Flash that boundary is 975,600 of an advertised
  // 1,048,000 window, and the remaining 72,400 tokens are deliberate headroom
  // for the reply, tokenizer differences, and transcript growth mid-loop.
  const requiredContext =
    Math.max(input.contextTokens, task.scope.promptTokens) + replyMarginFor(model.context)
  if (model.context > 0 && requiredContext > model.context * CONTEXT_SAFE_WINDOW_FRACTION) {
    return {
      eligible: false,
      reason: `Context requirement ${requiredContext.toLocaleString()} exceeds this model's safe window`,
      warnings,
      // Machine-readable so callers can explain *this* rejection without
      // pattern-matching the message above.
      rejectedFor: "context",
      contextRequiredTokens: requiredContext,
      contextWindowTokens: model.context,
    }
  }

  const substantive = task.tier >= 2
  /**
   * The intelligence floor exists so substantive work reaches a capable model.
   * Offline mode is a deliberate exception: the owner has chosen to work with
   * whatever runs locally, and enforcing the hosted floor would make offline
   * mode permanently unusable, because no 4B model on this machine scores 39.5.
   *
   * The exception is scoped to local models only. A hosted model reached while
   * offline is already refused upstream, so this cannot lower the floor for
   * online routing.
   */
  const offlineFloorApplies = substanceFloorApplies(settings, model)
  if (substantive && offlineFloorApplies && model.intelligence < settings.routing.intelligenceFloor) {
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
