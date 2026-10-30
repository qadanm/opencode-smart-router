import type {
  CandidateEvaluation,
  CostTier,
  Mode,
  ModelQuotaSnapshot,
  ModelRecord,
  ModelRef,
  PeakPricing,
  PremiumState,
  ProviderQuotaSnapshot,
  RouterSettings,
  RoutingDecision,
  SessionState,
  TaskClass,
  TaskKind,
} from "../types.js"
import { keyOfRef, modelKey, nowId, safeError, thousands, usd } from "../util.js"
import { decidePremium, evaluateEligibility, modelPressure, providerPressure, type PremiumDecision } from "../policy/eligibility.js"
import { mayUseProvider, type InferenceMode } from "../offline/mode.js"

export interface EngineInput {
  readonly task: TaskClass
  readonly settings: RouterSettings
  readonly mode: Mode
  readonly runtime: "automatic" | "manual" | "paused"
  readonly models: ReadonlyArray<ModelRecord>
  readonly current?: ModelRef
  readonly session?: SessionState
  readonly quota: ReadonlyArray<ProviderQuotaSnapshot>
  readonly premium: PremiumState
  readonly contextTokens: number
  readonly cachedTokens: number
  readonly dryRun: boolean
  readonly now?: number
  readonly lastError?: string
  readonly modelHistory?: Readonly<Record<string, { requests: number; failures: number }>>
  /** Model key to the epoch millisecond when its failure cooldown ends. */
  readonly cooldowns?: Readonly<Record<string, number>>
  /** Provider id to the epoch millisecond when its outage backoff ends. */
  readonly providerCooldowns?: Readonly<Record<string, number>>
  /**
   * Measured generation speed per model, in output tokens per second. Only
   * consulted once a model has enough samples to be meaningful.
   */
  readonly speed?: Readonly<Record<string, { tokensPerSecond: number; samples: number }>>
  /**
   * The intelligence floor actually in force, when it differs from the
   * configured one.
   *
   * Calibration derives the floor from recorded spend and the controller
   * resolves it before routing. Passing it in keeps the eligibility gate and
   * the success estimate reading the same number; defaulting to the configured
   * value preserves every existing caller and every existing test.
   */
  readonly intelligenceFloor?: number
}

export interface EngineResult {
  readonly decision: RoutingDecision
  readonly chosenModel?: ModelRecord
  readonly premiumDecision: PremiumDecision
}

interface Evaluated {
  model: ModelRecord
  eligibility: ReturnType<typeof evaluateEligibility>
  estimate: CostEstimate
  probability: number
  pressure: number
  candidate: CandidateEvaluation
}

const outputPerStep: Record<TaskKind, number> = {
  deterministic: 200,
  mechanical: 300,
  docs: 800,
  test: 1000,
  debug: 1100,
  feature: 1300,
  refactor: 1500,
  security: 1800,
  architecture: 2000,
  design: 2400,
  unknown: 1000,
}

const stepsFor: Record<TaskKind, number> = {
  deterministic: 1,
  mechanical: 1,
  docs: 1,
  test: 2,
  debug: 3,
  feature: 3,
  refactor: 3,
  security: 3,
  architecture: 3,
  design: 3,
  unknown: 2,
}

/**
 * The share of the context a staying model reads from prompt cache.
 *
 * The remainder is re-sent as fresh input. This is a modelling assumption, not a
 * measured cache-hit rate, and it drives both the ranked estimate and the switch
 * penalty that is reported alongside it, so the two can never disagree about how
 * much a switch really costs.
 */
const CACHE_REUSE_SHARE = 0.85

const selectCostTier = (model: ModelRecord, contextTokens: number): CostTier => {
  const sorted = [...model.cost].sort((a, b) => (a.tier?.size ?? 0) - (b.tier?.size ?? 0))
  let selected = sorted[0] ?? { input: 0, output: 0, cache: { read: 0, write: 0 } }
  for (const tier of sorted) {
    if (tier.tier?.type === "context" && contextTokens >= tier.tier.size) selected = tier
  }
  return selected
}

export interface CostEstimate {
  readonly usd: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly switchPenaltyUsd: number
  readonly costTier: CostTier
  /** 2 during a documented peak window, otherwise 1. */
  readonly priceMultiplier: number
  /** Per-model credit multiplier. One for every plain USD provider. */
  readonly creditMultiplier: number
}

const isPeakPricingActive = (now: number, peak: PeakPricing): boolean => {
  const date = new Date(now)
  const day = date.getUTCDay()
  if (peak.weekdaysOnly && (day === 0 || day === 6)) return false
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600
  return peak.windowsUtc.some((window) => hour >= window.startHour && hour < window.endHour)
}

/**
 * Estimate the total request cost of a task across its whole agent loop rather
 * than a single call. The estimate includes later steps and treats a model
 * switch as a cache loss. Documented peak pricing is applied using the supplied
 * time; omitting `now` uses the current time.
 */
export const estimateTaskCost = (input: {
  model: ModelRecord
  task: TaskClass
  contextTokens: number
  currentModelKey?: string
  now?: number
}): CostEstimate => {
  const { model, task } = input
  const context = Math.max(input.contextTokens, task.scope.promptTokens)
  const sameModel = input.currentModelKey === modelKey(model.providerID, model.modelID)
  const steps = stepsFor[task.kind]
  const tier = selectCostTier(model, context)
  const peakMultiplier =
    model.peakPricing && isPeakPricingActive(input.now ?? Date.now(), model.peakPricing) && model.peakPricing.multiplier > 0
      ? model.peakPricing.multiplier
      : 1
  const outputPer = Math.min(outputPerStep[task.kind] * (task.tier === 3 ? 1.5 : 1), model.maxOutput || outputPerStep[task.kind])
  const output = outputPer * steps
  // Staying on a model reuses the prompt cache. Switching loses it, so the whole
  // context is re-sent as fresh input instead of being read from cache. Both
  // halves of that trade depend on the same cached share, which is why it is
  // named once and used by the estimate and by the reported penalty alike.
  const cachedShare = sameModel ? CACHE_REUSE_SHARE : 0
  const freshInput = task.scope.promptTokens + context * (1 - cachedShare) + context * 0.05 * (steps - 1)
  const cacheRead = context * cachedShare + context * 0.95 * (steps - 1)
  // A live catalog entry or a hand-written definition can omit cache pricing.
  // Price it as zero rather than letting the router throw and fail open.
  const inputPrice = (Number.isFinite(tier.input) ? tier.input : 0) * peakMultiplier
  const outputPrice = (Number.isFinite(tier.output) ? tier.output : 0) * peakMultiplier
  const cacheReadPrice = (Number.isFinite(tier.cache?.read) ? (tier.cache?.read ?? 0) : 0) * peakMultiplier
  const cost =
    (freshInput * inputPrice) / 1_000_000 +
    (output * outputPrice) / 1_000_000 +
    (cacheRead * cacheReadPrice) / 1_000_000
  // The extra cost a switch actually adds, which is the cached share of the
  // context moving from cache-read price to full input price. Reporting the whole
  // context here charged the reader 17.6% more than the estimate in force.
  const switchPenaltyUsd = sameModel
    ? 0
    : Math.max(0, (context * CACHE_REUSE_SHARE * (inputPrice - cacheReadPrice)) / 1_000_000)
  // OpenDesign converts the dollar value of usage into Design Plan credits
  // with a per-model multiplier. The result is still an estimate of credits,
  // never an observed provider charge.
  const creditMultiplier = model.creditMultiplier && model.creditMultiplier > 0 ? model.creditMultiplier : 1
  return {
    usd: Math.max(0, cost) * creditMultiplier,
    input: freshInput,
    output,
    cacheRead,
    cacheWrite: 0,
    switchPenaltyUsd: switchPenaltyUsd * creditMultiplier,
    costTier: tier,
    priceMultiplier: peakMultiplier,
    creditMultiplier,
  }
}

const observedSuccess = (model: ModelRecord, session: EngineInput["session"], _key: string): number => {
  // Only capability failures should reduce a model's expected success rate.
  // Provider, network, auth, tool, and context-overflow errors are handled by
  // their own recovery paths.
  if (!session) return 0.95
  const capabilityFailures = session.failures.filter((failure) => failure.class === "capability").length
  return Math.max(0.55, 0.95 - capabilityFailures * 0.1)
}

export const estimateSuccess = (input: {
  model: ModelRecord
  task: TaskClass
  contextTokens: number
  session?: SessionState
  currentModelKey?: string
  history?: { requests: number; failures: number }
  /**
   * The floor in force for this request.
   *
   * This used to be a literal `39.5`, which meant raising or lowering the floor
   * moved the eligibility gate but left this quality penalty behind at the old
   * number. Two gates reading the same policy from different sources is exactly
   * the drift the context-margin work removed, so the value is passed in now.
   */
  intelligenceFloor?: number
}): number => {
  const { model, task } = input
  let probability: number
  if (task.tier <= 1) {
    probability = model.tier === 1 ? 0.93 : 0.97
  } else if (task.tier === 2) {
    probability = model.tier === 2 ? 0.94 : 0.97
  } else {
    probability = model.tier === 3 ? 0.93 : 0.7
  }
  if (model.training) probability -= 0.05
  if (task.designIntensive) {
    const threshold = task.sophisticatedDesign ? 75 : 60
    if (model.design < threshold) probability *= 0.72
  }
  const floor = input.intelligenceFloor ?? 39.5
  if (task.tier >= 2 && model.intelligence < floor) probability *= 0.7
  if (model.context > 0 && input.contextTokens > model.context * 0.8) probability *= 0.9
  if (model.context > 0 && input.contextTokens > model.context * 0.95) probability *= 0.6
  probability *= observedSuccess(model, input.session, modelKey(model.providerID, model.modelID)) / 0.95
  if (input.history && input.history.requests >= 3) {
    // Reliability is weighted more heavily than before. A model that drops
    // streams is not worth a lower token price, because every dropped turn
    // costs a full retry of the accumulated context.
    const total = input.history.requests + input.history.failures
    const successRate = total > 0 ? Math.max(0, input.history.requests) / total : 1
    probability *= 0.6 + 0.4 * successRate
  }
  return Math.max(0.2, Math.min(0.99, probability))
}

const premiumState = (input: EngineInput): PremiumState => input.premium

/**
 * Speed penalty for a candidate, as a multiplier on its effective cost.
 *
 * Speed is measured as output tokens per second, which is the only figure
 * that separates a slow provider from a model that simply reasons for longer:
 * a model that emits 3,000 reasoning tokens before answering is not "slow" in
 * the same sense as one that takes four times as long to emit the same
 * answer.
 *
 * With no samples the penalty is neutral. Once a model has been measured it
 * is compared against the fastest eligible route rather than against an
 * absolute number, so the penalty adapts as providers change.
 */
const speedPenalty = (
  input: EngineInput,
  key: string,
  fastestTokensPerSecond: number,
): number => {
  if (!input.settings.speed.enabled) return 1
  const measure = input.speed?.[key]
  if (!measure || measure.samples < input.settings.speed.minSamples) return 1
  if (measure.tokensPerSecond <= 0 || fastestTokensPerSecond <= 0) return 1
  const ratio = measure.tokensPerSecond / fastestTokensPerSecond
  // A route at the fastest observed speed is unpenalised. Below that the
  // configured weight scales the shortfall, so a route half as fast costs
  // more than one at parity but never becomes ineligible.
  const shortfall = Math.max(0, 1 - ratio)
  const weight = input.settings.speed.weightPct / 100
  const penalty = 1 + shortfall * weight * 2
  // A route far slower than the fastest is penalised harder, because the
  // owner's stated preference puts responsiveness ahead of shaving pennies.
  const multiple = ratio > 0 ? 1 / ratio : input.settings.speed.slowRouteMultiple
  if (multiple >= input.settings.speed.slowRouteMultiple) {
    return penalty * (1 + weight)
  }
  return penalty
}

const providerFor = (quota: ReadonlyArray<ProviderQuotaSnapshot>, providerID: string) =>
  quota.find((snapshot) => snapshot.providerID === providerID)

const modelQuotaFor = (snapshot: ProviderQuotaSnapshot | undefined, model: ModelRecord): ModelQuotaSnapshot | undefined =>
  snapshot?.models[modelKey(model.providerID, model.modelID)]

const toRef = (model: ModelRecord): ModelRef => ({ providerID: model.providerID, id: model.modelID })

const candidateFor = (
  input: EngineInput,
  model: ModelRecord,
  eligibility: { eligible: boolean; reason: string; warnings: string[] },
  estimate: CostEstimate,
  probability: number,
  pressure: number,
  currentModelKey: string | undefined,
  speedFactor = 1,
): CandidateEvaluation => {
  const expectedTotal = (estimate.usd * (1 + (1 - probability) * 2)) * pressure * speedFactor
  return {
    model: { providerID: model.providerID, modelID: model.modelID },
    name: model.name,
    tier: model.tier,
    eligible: eligibility.eligible,
    reason: eligibility.reason,
    estimatedUsd: estimate.usd,
    effectiveCost: expectedTotal,
    successProbability: probability,
    switchPenaltyUsd: estimate.switchPenaltyUsd,
    quotaPressure: pressure,
    retained: keyOfRef(input.current) === modelKey(model.providerID, model.modelID),
    creditMultiplier: estimate.creditMultiplier,
    speedFactor,
  }
}

/**
 * Deterministic routing engine. It never calls a model to classify or decide.
 * Every candidate is evaluated against hard requirements first, then ranked by
 * expected total quota cost, with a cache-aware affinity threshold.
 */
export const routeTask = (input: EngineInput): EngineResult => {
  const now = input.now ?? Date.now()
  // One value for the whole decision. The eligibility gate and the success
  // estimate must never disagree about the floor in force.
  const floor = input.intelligenceFloor ?? input.settings.routing.intelligenceFloor
  const warnings: string[] = []
  const reasons: string[] = []
  const currentKey = keyOfRef(input.current)
  const premiumDecision = decidePremium({
    settings: input.settings,
    mode: input.mode,
    task: input.task,
    session: input.session,
    premium: input.premium,
  })

  /**
   * Offline mode narrows the candidate set to the local provider before any
   * other evaluation runs.
   *
   * This is deliberately the first thing that happens and the only place the
   * restriction is applied. Filtering here means quotas, escalation, premium
   * approval and the cost model all operate on a list that cannot contain a
   * hosted provider, so no later branch can reintroduce one. A refusal is
   * explicit rather than a silent empty result: an offline session with no
   * usable local model must say so.
   */
  const inferenceMode: InferenceMode = input.settings.offline?.enabled ? "offline" : "online"
  let candidateModels = input.models
  if (inferenceMode === "offline") {
    candidateModels = input.models.filter((model) => mayUseProvider(model.providerID, inferenceMode))
    const refused = input.models.filter((model) => !mayUseProvider(model.providerID, inferenceMode))
    if (refused.length > 0) {
      const providers = [...new Set(refused.map((model) => model.providerID))].sort()
      warnings.push(
        `Offline mode excluded ${refused.length} hosted model${refused.length === 1 ? "" : "s"} from ${providers.join(", ")}.`,
      )
    }
    if (candidateModels.length === 0) {
      const decision: RoutingDecision = {
        id: nowId("dec"),
        at: now,
        sessionID: input.session?.sessionID ?? "unknown",
        mode: input.mode,
        dryRun: input.dryRun,
        runtime: input.runtime,
        task: input.task,
        current: input.current,
        switched: false,
        switchReason:
          "Offline mode has no local model available. No hosted provider will be used.",
        reasons: ["Offline mode is enabled and no offline-capable model is in the registry."],
        warnings: [
          ...warnings,
          "Offline mode fails closed: configure a local model, or run `opencode-online` to restore hosted routing.",
        ],
        candidates: [],
        premium: premiumState(input),
        quota: input.quota,
        contextTokens: input.contextTokens,
        cachedTokens: input.cachedTokens,
        estimatedUsd: 0,
        needsPremiumApproval: false,
        manualOverride: false,
      }
      return { decision, premiumDecision }
    }
  }
  if (input.runtime === "paused") {
    const decision: RoutingDecision = {
      id: nowId("dec"),
      at: now,
      sessionID: input.session?.sessionID ?? "unknown",
      mode: input.mode,
      dryRun: input.dryRun,
      runtime: input.runtime,
      task: input.task,
      current: input.current,
      switched: false,
      switchReason: "Routing is paused; the current model is unchanged.",
      reasons: ["Pause switch is active."],
      warnings: [],
      candidates: [],
      premium: premiumState(input),
      quota: input.quota,
      contextTokens: input.contextTokens,
      cachedTokens: input.cachedTokens,
      estimatedUsd: 0,
      needsPremiumApproval: false,
      manualOverride: false,
    }
    return { decision, premiumDecision }
  }

  if (input.runtime === "manual") {
    const decision: RoutingDecision = {
      id: nowId("dec"),
      at: now,
      sessionID: input.session?.sessionID ?? "unknown",
      mode: input.mode,
      dryRun: input.dryRun,
      runtime: input.runtime,
      task: input.task,
      current: input.current,
      switched: false,
      switchReason: "Manual model selection is active for this session; the router did not override it.",
      reasons: ["Manual override respected."],
      warnings: [],
      candidates: [],
      premium: premiumState(input),
      quota: input.quota,
      contextTokens: input.contextTokens,
      cachedTokens: input.cachedTokens,
      estimatedUsd: 0,
      needsPremiumApproval: false,
      manualOverride: true,
    }
    return { decision, premiumDecision }
  }

  /**
   * Models that were rejected purely because the transcript would not fit.
   *
   * This is recorded rather than silently skipped because it is the one
   * rejection a user is most likely to misread. A large session quietly stops
   * being routed to the configured default, and without this note the only
   * visible signal is that some other model is suddenly in use.
   */
  const contextRejected: Array<{ model: ModelRecord; required: number; window: number; usd: number; tier: number }> = []

  const evaluate = (designRelaxation: 0 | 1 | 2) => {
    const taskForEvaluation =
      designRelaxation === 1 ? { ...input.task, sophisticatedDesign: false } : input.task
    // The fastest measured eligible model sets the reference point for the
    // speed penalty, so the comparison is always against what this account
    // can actually achieve right now.
    let fastestTokensPerSecond = 0
    for (const model of candidateModels) {
      const measure = input.speed?.[modelKey(model.providerID, model.modelID)]
      if (!measure || measure.samples < input.settings.speed.minSamples) continue
      if (measure.tokensPerSecond > fastestTokensPerSecond) fastestTokensPerSecond = measure.tokensPerSecond
    }

    /**
     * Pass one evaluates every candidate without the escalation-pool guard.
     * The guard is only applied once an ordinary-allowance route is known to
     * be available: otherwise a task that genuinely needs escalation would be
     * blocked outright instead of being escalated.
     */
    const run = (protectEscalation: boolean) => {
      const out: Evaluated[] = []
      for (const model of candidateModels) {
      const provider = providerFor(input.quota, model.providerID)
      const modelQuota = modelQuotaFor(provider, model)
      const key = modelKey(model.providerID, model.modelID)
      // A model that just dropped a stream is held out for a cooling period
      // instead of being re-selected on the next prompt.
      const cooldownUntil = input.cooldowns?.[key]
      if (typeof cooldownUntil === "number" && cooldownUntil > now) {
        continue
      }
      // A provider whose own pre-request path has failed several attempts in
      // a row is not serving anyone. Step back from every model it offers
      // and let another provider take the work. If no provider is left the
      // router fails closed and keeps the current model, so this can never
      // block a prompt outright.
      const providerCooldownUntil = input.providerCooldowns?.[model.providerID]
      if (typeof providerCooldownUntil === "number" && providerCooldownUntil > now) {
        continue
      }
      // The estimate is computed first so the subscription-only guard can
      // check the projected request cost against what is left of the
      // subscription allowance.
      const estimate = estimateTaskCost({
        model,
        task: input.task,
        contextTokens: input.contextTokens,
        currentModelKey: currentKey,
        now,
      })
      const eligibility = evaluateEligibility({
        intelligenceFloor: floor,
        model,
        task: taskForEvaluation,
        settings: input.settings,
        mode: input.mode,
        contextTokens: input.contextTokens,
        providerQuota: provider,
        modelQuota,
        premium: premiumDecision,
        currentModelKey: currentKey,
        allowDesignRelaxation: designRelaxation === 2,
        projectedUsd: estimate.usd,
        escalationPoolProtected: protectEscalation,
      })
        if (!eligibility.eligible) {
          // Record only a context-capacity rejection. It is deterministic,
          // actionable ("start a new session"), and otherwise invisible.
          if (eligibility.rejectedFor === "context" && eligibility.contextRequiredTokens !== undefined && eligibility.contextWindowTokens !== undefined) {
            contextRejected.push({
              model,
              required: eligibility.contextRequiredTokens,
              window: eligibility.contextWindowTokens,
              usd: estimate.usd,
              tier: model.tier,
            })
          }
          continue
        }
        const eligibleReason =
          designRelaxation === 1 && input.task.sophisticatedDesign
            ? `Standard design route: design ${model.design} is below the sophisticated ${input.settings.routing.sophisticatedDesignFloor} threshold`
            : eligibility.reason
        const displayedEligibility = eligibleReason === eligibility.reason ? eligibility : { ...eligibility, reason: eligibleReason }
        const probability = estimateSuccess({
          model,
          task: input.task,
          contextTokens: input.contextTokens,
          session: input.session,
          currentModelKey: currentKey,
          history: input.modelHistory?.[modelKey(model.providerID, model.modelID)],
          intelligenceFloor: floor,
        })
        const pressure = providerPressure(provider, now) * modelPressure(modelQuota)
        const speedFactor = speedPenalty(input, modelKey(model.providerID, model.modelID), fastestTokensPerSecond)
        const candidate = candidateFor(input, model, displayedEligibility, estimate, probability, pressure, currentKey, speedFactor)
        out.push({ model, eligibility: displayedEligibility, estimate, probability, pressure, candidate })
      }
      return out.sort((a, b) => a.candidate.effectiveCost - b.candidate.effectiveCost)
    }

    const unprotected = run(false)
    if (!input.settings.routing.protectEscalationPool) return unprotected
    // Only protect the escalation pool when an ordinary-allowance route can
    // actually serve the task. A task that needs escalation must still be
    // able to escalate.
    const ordinaryAvailable = unprotected.some((entry) => !entry.model.escalationOnly && !entry.model.premium)
    if (!ordinaryAvailable) return unprotected
    return run(true)
  }

  let evaluated = evaluate(0)
  if (evaluated.length === 0 && input.task.designIntensive) {
    // First fall back to the standard design floor, which keeps a qualified
    // design model instead of jumping straight to the cheapest model overall.
    evaluated = evaluate(1)
    if (evaluated.length > 0) {
      warnings.push("No model met the sophisticated design threshold; using the best qualified standard design route.")
    }
  }
  if (evaluated.length === 0 && input.task.designIntensive) {
    evaluated = evaluate(2)
    if (evaluated.length > 0) {
      warnings.push("No model met the standard design floor; using the best available design-capable fallback.")
    }
  }

  // Premium tasks without approval still need a deliberately chosen standard
  // fallback rather than silently keeping an unqualified cheap model.
  let premiumFallback = false
  if (evaluated.length === 0 && input.task.tier === 3) {
    const relaxedPremium: PremiumDecision = { allowed: false, requiresApproval: premiumDecision.requiresApproval, reason: premiumDecision.reason }
    const fallbackModels = candidateModels
      .filter((model) => !model.premium)
      .map((model) => {
        const provider = providerFor(input.quota, model.providerID)
        const modelQuota = modelQuotaFor(provider, model)
        const key = modelKey(model.providerID, model.modelID)
        const cooldownUntil = input.cooldowns?.[key]
        if (typeof cooldownUntil === "number" && cooldownUntil > now) return undefined
        const estimate = estimateTaskCost({
          model,
          task: input.task,
          contextTokens: input.contextTokens,
          currentModelKey: currentKey,
          now,
        })
        const eligibility = evaluateEligibility({
          intelligenceFloor: floor,
          model,
          task: { ...input.task, designIntensive: false, sophisticatedDesign: false },
          settings: input.settings,
          mode: input.mode,
          contextTokens: input.contextTokens,
          providerQuota: provider,
          modelQuota,
          premium: relaxedPremium,
          currentModelKey: currentKey,
          allowDesignRelaxation: true,
          projectedUsd: estimate.usd,
        })
        if (!eligibility.eligible) return undefined
        const probability = estimateSuccess({
          model,
          task: input.task,
          contextTokens: input.contextTokens,
          session: input.session,
          currentModelKey: currentKey,
          history: input.modelHistory?.[modelKey(model.providerID, model.modelID)],
          intelligenceFloor: floor,
        })
        const pressure = providerPressure(provider, now) * modelPressure(modelQuota)
        return { model, eligibility, estimate, probability, pressure, candidate: candidateFor(input, model, eligibility, estimate, probability, pressure, currentKey) }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((a, b) => a.candidate.effectiveCost - b.candidate.effectiveCost)
    if (fallbackModels.length > 0) {
      evaluated = fallbackModels
      premiumFallback = true
      warnings.push("Premium is unavailable; selected the best qualified standard fallback.")
    }
  }

  if (evaluated.length === 0) {
    warnings.push("No approved model meets every hard requirement; the current model was left unchanged.")
    const decision: RoutingDecision = {
      id: nowId("dec"),
      at: now,
      sessionID: input.session?.sessionID ?? "unknown",
      mode: input.mode,
      dryRun: input.dryRun,
      runtime: input.runtime,
      task: input.task,
      current: input.current,
      switched: false,
      switchReason: "No eligible route was found; the router failed closed and kept the current model.",
      reasons: [...input.task.reasons, ...warnings],
      warnings,
      candidates: [],
      premium: premiumState(input),
      quota: input.quota,
      contextTokens: input.contextTokens,
      cachedTokens: input.cachedTokens,
      estimatedUsd: 0,
      needsPremiumApproval: premiumDecision.requiresApproval,
      manualOverride: false,
      ...(input.lastError ? { error: safeError(input.lastError) } : {}),
    }
    return { decision, premiumDecision }
  }

  const best = evaluated[0]!
  const currentEval = currentKey
    ? evaluated.find((entry) => modelKey(entry.model.providerID, entry.model.modelID) === currentKey)
    : undefined
  const largeContext = input.contextTokens >= input.settings.routing.largeContextTokens
  const hysteresis = largeContext
    ? input.settings.routing.largeContextHysteresisPct
    : input.settings.routing.switchHysteresisPct

  let chosen = best
  let keptForAffinity = false
  if (currentEval && currentEval.model.tier >= input.task.tier && currentEval.candidate.eligible) {
    const savings = currentEval.candidate.effectiveCost - best.candidate.effectiveCost
    const threshold = currentEval.candidate.effectiveCost * (hysteresis / 100)
    if (best.model !== currentEval.model && savings < threshold) {
      chosen = currentEval
      keptForAffinity = true
    }
  }

  const chosenRef = toRef(chosen.model)
  const sameAsCurrent = currentKey === modelKey(chosen.model.providerID, chosen.model.modelID)
  const wouldSwitch = !sameAsCurrent
  const needsPremiumApproval =
    premiumDecision.requiresApproval &&
    (input.task.tier === 3 || input.task.constraints.requestPremium) &&
    input.settings.premium.mode !== "off" &&
    input.mode !== "efficiency"

  if (input.task.tier === 3 && !premiumDecision.allowed && input.mode !== "efficiency" && input.settings.premium.mode !== "off") {
    const bestPremium = candidateModels
      .filter((model) => model.premium && model.approved)
      .map((model) => {
        const provider = providerFor(input.quota, model.providerID)
        const modelQuota = modelQuotaFor(provider, model)
        const eligibility = evaluateEligibility({
          intelligenceFloor: floor,
          model,
          task: input.task,
          settings: input.settings,
          mode: input.mode,
          contextTokens: input.contextTokens,
          providerQuota: provider,
          modelQuota,
          premium: { allowed: true, requiresApproval: true, reason: "Premium suggestion" },
          currentModelKey: currentKey,
          allowDesignRelaxation: false,
        })
        if (!eligibility.eligible) return undefined
        const estimate = estimateTaskCost({
          model,
          task: input.task,
          contextTokens: input.contextTokens,
          currentModelKey: currentKey,
          now,
        })
        return { model, estimate }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((a, b) => {
        if (input.task.designIntensive || input.task.sophisticatedDesign) {
          if (b.model.design !== a.model.design) return b.model.design - a.model.design
        } else if (b.model.intelligence !== a.model.intelligence) {
          return b.model.intelligence - a.model.intelligence
        }
        return a.estimate.usd - b.estimate.usd
      })[0]
    if (bestPremium) {
      warnings.push(
        `Premium route suggested: ${bestPremium.model.name} (${usd(bestPremium.estimate.usd)} estimated). Approve once with /router-approve or set a premium budget.`,
      )
    }
  }

  if (premiumFallback) {
    warnings.push("This task is premium-tier, but automatic premium escalation is unavailable.")
  }
  if (largeContext && wouldSwitch) {
    warnings.push("Large context detected; switching increases fresh-input cost because prompt cache is model-specific.")
  }
  // Explain a context-driven switch in terms the user can act on. Without this,
  // a large session silently stops using the configured default and the only
  // visible signal is that some other model is suddenly in use.
  //
  // Two conditions keep this from becoming noise. The model must be at least
  // as capable as what was chosen, and cheaper, so it would have won had it
  // fit. Comparing against the chosen model rather than the task tier matters:
  // a premium task served by a standard fallback should still report that a
  // cheaper standard model was displaced by size. And if its display name
  // matches the chosen model's, the provider is named too, because "DeepSeek
  // was skipped" while DeepSeek is running reads as a bug.
  const viableOnMerit = contextRejected.filter(
    (entry) =>
      (entry.model.providerID !== chosen.model.providerID || entry.model.modelID !== chosen.model.modelID) &&
      entry.tier >= chosen.model.tier &&
      entry.usd < chosen.candidate.estimatedUsd,
  )
  const displaced =
    viableOnMerit.find(
      (entry) =>
        input.current?.providerID === entry.model.providerID && input.current?.id === entry.model.modelID,
    ) ?? [...viableOnMerit].sort((a, b) => a.usd - b.usd)[0]
  if (displaced) {
    const sameName = displaced.model.name === chosen.model.name
    const label = sameName ? `${displaced.model.name} on ${displaced.model.providerID}` : displaced.model.name
    warnings.push(
      `${label} was skipped for this turn: the transcript needs about ${thousands(displaced.required)} tokens of context and that model's window is ${thousands(displaced.window)}. Start a new session to route to it again.`,
    )
  }
  if (chosen.model.premium) {
    reasons.push(`Premium route approved: ${chosen.model.name}.`)
  }
  if (keptForAffinity) {
    reasons.push(`Kept ${currentEval!.model.name} for cache affinity; the estimated savings were below the ${hysteresis}% switch threshold.`)
  } else if (wouldSwitch) {
    reasons.push(
      `Selected ${chosen.model.name} as the least-cost qualified route after expected retries and quota pressure (${usd(chosen.candidate.estimatedUsd)} estimated raw cost, ${usd(chosen.candidate.effectiveCost)} expected).`,
    )
  } else {
    reasons.push(`Already on ${chosen.model.name}, the least-cost qualified route.`)
  }

  const quotaNotes = input.quota
    .filter((snapshot) => snapshot.source === "provider")
    .map(
      (snapshot) =>
        `${snapshot.label}: ${snapshot.rolling.usedPct.toFixed(0)}% 5h, ${snapshot.weekly.usedPct.toFixed(0)}% weekly, ${snapshot.monthly.usedPct.toFixed(0)}% monthly`,
    )
  reasons.push(...quotaNotes)

  const candidates = evaluated
    .slice(0, 12)
    .map((entry) => ({
      ...entry.candidate,
      retained: keptForAffinity ? entry.model === currentEval?.model : entry.model === chosen.model,
    }))
  if (currentEval && !candidates.some((candidate) => candidate.model.providerID === currentEval.model.providerID && candidate.model.modelID === currentEval.model.modelID)) {
    candidates.push({ ...currentEval.candidate, retained: keptForAffinity })
  }

  const switchReason = !wouldSwitch
    ? keptForAffinity
      ? "Kept the current model for cache affinity."
      : "The current model already is the least-cost qualified route."
    : input.dryRun
      ? `Dry run: would switch to ${chosen.model.name}.`
      : `Switch to ${chosen.model.name}.`

  const decision: RoutingDecision = {
    id: nowId("dec"),
    at: now,
    sessionID: input.session?.sessionID ?? "unknown",
    mode: input.mode,
    dryRun: input.dryRun,
    runtime: input.runtime,
    task: input.task,
    current: input.current,
    chosen: chosenRef,
    switched: wouldSwitch && !input.dryRun,
    switchReason,
    reasons: [...input.task.reasons, ...reasons],
    warnings,
    candidates,
    premium: premiumState(input),
    quota: input.quota,
    contextTokens: input.contextTokens,
    cachedTokens: input.cachedTokens,
    estimatedUsd: chosen.candidate.estimatedUsd,
    needsPremiumApproval,
    manualOverride: false,
    ...(input.lastError ? { error: safeError(input.lastError) } : {}),
  }
  return { decision, chosenModel: chosen.model, premiumDecision }
}
