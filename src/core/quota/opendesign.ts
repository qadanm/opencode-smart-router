import type {
  CreditPoolSnapshot,
  ProviderQuotaSnapshot,
  ProviderSettings,
  QuotaWindow,
  UsageEvent,
} from "../types.js"
import { clamp, describePlan, pct, redact } from "../util.js"
import {
  OPENDESIGN_DEFAULT_CONTROL_BASE_URL,
  OPENDESIGN_USER_AGENT,
  failureClassForStatus,
  normalizeOpenDesignControlBaseURL,
  openDesignControlEndpoint,
  type FetchLike,
} from "../providers/opendesign.js"
import { OPEN_DESIGN_MODEL_BY_ID } from "../providers/opendesign-models.js"
import { OPENDESIGN_DESIGN_PLAN_POOL, OPENDESIGN_PLAN_MODEL_POOL, isEscalationOnlyPool, resolvePlan } from "../plans/catalog.js"
import { creditMultiplierFor } from "../providers/opendesign-credits.js"

/**
 * OpenDesign quota integration.
 *
 * OpenDesign publishes no quota API for an inference key. Re-verified on
 * 2026-10-30 against the live gateway: `GET /v1/models` returns 200 with the
 * same key, while `/v1/usage`, `/v1/me`, `/v1/credits`, `/v1/billing`,
 * `/v1/account`, `/v1/subscription`, `/v1/limits` and `/v1/quota` all return
 * 404. The key is valid and authorized for inference; there is simply no usage
 * surface for it. The account-control host rejects an inference key with HTTP
 * 401. The upstream feature request for a key-readable usage endpoint is still
 * open (nexu-io/open-design#8674), as is the control-key lifecycle request
 * (#8870).
 *
 * Three states are therefore supported:
 *
 *  - `verified`  A control key was explicitly configured, so the account's own
 *                coding-plan usage windows are read directly.
 *  - `estimated` Only the inference key is available, so the router models its
 *                own credit consumption against the published plan caps.
 *  - `unknown`   Nothing can be established safely.
 *
 * The estimated state is a lower bound: usage from the OpenDesign desktop app
 * or any other client on the same subscription is invisible to the router. A
 * configurable margin is applied and the uncertainty is reported, never hidden.
 */

export type OpenDesignQuotaState =
  | "verified"
  | "estimated"
  | "stale"
  | "unknown"
  | "exhausted"
  | "unavailable"

export interface OpenDesignQuotaInput {
  readonly settings: ProviderSettings
  readonly apiKey?: string
  readonly controlKey?: string
  readonly controlBaseURL?: string
  readonly usage: ReadonlyArray<UsageEvent>
  readonly fetchImpl?: FetchLike
  readonly now?: () => number
  readonly multiplierOverrides?: Readonly<Record<string, number>>
  /** Credits per USD as reported by the account. Defaults to the observed value. */
  readonly creditsPerUsd?: number
  /** Extra margin applied to locally observed usage, in percent. */
  readonly uncertaintyMarginPct?: number
  readonly timeoutMs?: number
}

export interface OpenDesignQuotaResult {
  readonly snapshot: ProviderQuotaSnapshot
  readonly state: OpenDesignQuotaState
}

/** Credits per USD observed from the OpenDesign account surface. */
export const OPENDESIGN_DEFAULT_CREDITS_PER_USD = 10_000

export const OPENDESIGN_DEFAULT_UNCERTAINTY_MARGIN_PCT = 20

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
/**
 * The widest window this module models.
 *
 * Exported because the caller has to hand back at least this much history for
 * the estimate to be complete. Keeping the number in one place stops the two
 * from drifting into a silent under-count.
 */
export const OPENDESIGN_MONTH_MS = 30 * 24 * 60 * 60 * 1000
const MONTH_MS = OPENDESIGN_MONTH_MS

const unknownWindow: QuotaWindow = { usedPct: 0, remainingPct: 100, source: "unknown" }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const numberOr = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const timeValue = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Estimate the Design Plan credits consumed by one request.
 *
 * This converts token counts into credits using the curated vendor list price
 * for the model and the published Design Plan multiplier. It is an estimate of
 * the underlying usage value, never an observed provider charge.
 *
 * `multiplierApplies` is false for a request funded from plan model credits:
 * OpenDesign documents that Design Plan model multipliers do not
 * automatically apply to that second pool, so applying one would understate
 * its real cost.
 */
export const estimateDesignPlanCredits = (input: {
  readonly modelID: string
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite?: number
  readonly multiplierOverrides?: Readonly<Record<string, number>>
  readonly now?: number
  readonly multiplierApplies?: boolean
}): { creditsUsd: number; multiplier: number; evidence: string } => {
  const spec = OPEN_DESIGN_MODEL_BY_ID.get(input.modelID)
  const tier = spec?.cost?.[0]
  const multiplier = creditMultiplierFor(input.modelID, {
    now: input.now,
    ...(input.multiplierOverrides ? { overrides: input.multiplierOverrides } : {}),
  })
  const applies = input.multiplierApplies !== false
  const effectiveMultiplier = applies ? multiplier.multiplier : 1
  if (!tier) {
    return { creditsUsd: 0, multiplier: effectiveMultiplier, evidence: "no-price" }
  }
  const price = (tier.input * Math.max(0, input.input) +
    tier.output * Math.max(0, input.output) +
    (tier.cache?.read ?? 0) * Math.max(0, input.cacheRead) +
    (tier.cache?.write ?? 0) * Math.max(0, input.cacheWrite ?? 0)) /
    1_000_000
  return {
    creditsUsd: Math.max(0, price) * effectiveMultiplier,
    multiplier: effectiveMultiplier,
    evidence: applies ? multiplier.evidence : "configured",
  }
}

interface LocalWindowTotals {
  readonly rollingUsd: number
  readonly weeklyUsd: number
  readonly monthlyUsd: number
  readonly observedRequests: number
  /** Credits per pool, so the two allowances are never conflated. */
  readonly byPool: Readonly<Record<string, {
    readonly rollingUsd: number
    readonly weeklyUsd: number
    readonly monthlyUsd: number
  }>>
}

/**
 * Estimate local usage, split by the pool that funded each request.
 *
 * A Design Plan model is billed at its Design Plan multiplier while that pool
 * has credit, then at the plain rate from plan model credits. The estimate
 * applies the pool that the model draws from first, which is the correct
 * attribution for forecasting: it asks "which allowance is this consuming?"
 * rather than "what is the cheapest rate this model ever gets?".
 */
const localTotals = (
  usage: ReadonlyArray<UsageEvent>,
  providerID: string,
  now: number,
  marginPct: number,
  plan: ReturnType<typeof resolvePlan>,
  multiplierOverrides?: Readonly<Record<string, number>>,
): LocalWindowTotals => {
  const rollingCutoff = now - FIVE_HOURS_MS
  const weekCutoff = now - WEEK_MS
  const monthCutoff = now - MONTH_MS
  let rollingUsd = 0
  let weeklyUsd = 0
  let monthlyUsd = 0
  let observedRequests = 0
  const pools: Record<string, { rollingUsd: number; weeklyUsd: number; monthlyUsd: number }> = {}
  const bucket = (poolID: string) =>
    (pools[poolID] ??= { rollingUsd: 0, weeklyUsd: 0, monthlyUsd: 0 })

  for (const event of usage) {
    if (event.providerID !== providerID) continue
    const designPlan = plan
      ? plan.pools.find((pool) => pool.id === OPENDESIGN_DESIGN_PLAN_POOL)
      : undefined
    const planModels = plan
      ? plan.pools.find((pool) => pool.id === OPENDESIGN_PLAN_MODEL_POOL)
      : undefined
    const inDesignPlan = Boolean(designPlan) && !isEscalationOnlyPool(plan!, event.modelID)
    const poolID = inDesignPlan
      ? OPENDESIGN_DESIGN_PLAN_POOL
      : planModels
        ? OPENDESIGN_PLAN_MODEL_POOL
        : OPENDESIGN_DESIGN_PLAN_POOL

    const credits = estimateDesignPlanCredits({
      modelID: event.modelID,
      input: event.input,
      output: event.output,
      cacheRead: event.cacheRead,
      cacheWrite: event.cacheWrite,
      now,
      multiplierApplies: poolID === OPENDESIGN_DESIGN_PLAN_POOL,
      ...(multiplierOverrides ? { multiplierOverrides } : {}),
    }).creditsUsd
    if (credits <= 0) continue
    observedRequests += 1
    const target = bucket(poolID)
    if (event.at >= rollingCutoff) {
      rollingUsd += credits
      target.rollingUsd += credits
    }
    if (event.at >= weekCutoff) {
      weeklyUsd += credits
      target.weeklyUsd += credits
    }
    if (event.at >= monthCutoff) {
      monthlyUsd += credits
      target.monthlyUsd += credits
    }
  }
  const margin = 1 + Math.max(0, marginPct) / 100
  const scaled = (value: number) => value * margin
  return {
    rollingUsd: scaled(rollingUsd),
    weeklyUsd: scaled(weeklyUsd),
    monthlyUsd: scaled(monthlyUsd),
    observedRequests,
    byPool: Object.fromEntries(
      Object.entries(pools).map(([poolID, totals]) => [
        poolID,
        {
          rollingUsd: scaled(totals.rollingUsd),
          weeklyUsd: scaled(totals.weeklyUsd),
          monthlyUsd: scaled(totals.monthlyUsd),
        },
      ]),
    ),
  }
}

const windowFrom = (
  usedUsd: number,
  capUsd: number,
  resetsAt: number | undefined,
  source: "provider" | "estimate",
): QuotaWindow => {
  const usedPct = capUsd > 0 ? pct(usedUsd, capUsd) : 0
  return {
    usedPct,
    remainingPct: clamp(100 - usedPct, 0, 100),
    usedUsd,
    capUsd,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    exceeded: capUsd > 0 && usedUsd >= capUsd,
    source,
  }
}

const baseSnapshot = (
  input: OpenDesignQuotaInput,
  now: number,
  error?: string,
  retryAfterMs?: number,
  notes: ReadonlyArray<string> = [],
): ProviderQuotaSnapshot => {
  const plan = resolvePlan("opendesign", input.settings.plan)
  return {
    providerID: "opendesign",
    label: plan?.label ?? "OpenDesign",
    plan: describePlan(plan?.planID, input.settings.plan),
    source: "unknown",
    fetchedAt: now,
    stale: false,
    rolling: unknownWindow,
    weekly: unknownWindow,
    monthly: unknownWindow,
    models: {},
    notes: [...notes],
    ...(error ? { error } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  }
}

/**
 * The caps a plan exposes, honoring explicit overrides and any advertised
 * removal of a window.
 *
 * OpenDesign Pro has a seven-day Design Plan window and no five-hour window.
 * An explicit `fiveHourCapUsd` from an older Go configuration must not
 * reintroduce the window the user's plan does not have, which is why the
 * plan shape is consulted before the override.
 */
const capsFor = (settings: ProviderSettings) => {
  const plan = resolvePlan("opendesign", settings.plan)
  const designPlan = plan?.pools.find((pool) => pool.id === OPENDESIGN_DESIGN_PLAN_POOL)
  const planModels = plan?.pools.find((pool) => pool.id === OPENDESIGN_PLAN_MODEL_POOL)
  const monthly = settings.monthlyCreditsUsd && settings.monthlyCreditsUsd > 0
    ? settings.monthlyCreditsUsd
    : designPlan?.monthlyUsd ?? 0
  const weeklyFromPlan = settings.ignoreWeeklyWindow ? undefined : designPlan?.weeklyUsd
  const fiveFromPlan = settings.ignoreFiveHourWindow ? undefined : designPlan?.fiveHourUsd
  return {
    monthly,
    weekly: weeklyFromPlan ?? (settings.ignoreWeeklyWindow ? undefined : settings.weeklyCapUsd),
    rolling: fiveFromPlan ?? (settings.ignoreFiveHourWindow ? undefined : settings.fiveHourCapUsd),
    planModelsMonthly: planModels?.monthlyUsd ?? 0,
    hasPlanModelPool: Boolean(planModels),
    hasFiveHourWindow: fiveFromPlan !== undefined,
    hasWeeklyWindow: weeklyFromPlan !== undefined,
    plan,
    /**
     * True when the configured plan id matches nothing in the catalog and no
     * explicit cap was supplied. Capacity is then unknown, not zero: reporting
     * zero would look like a fresh, unused allowance and silently let the
     * router over-spend.
     */
    unresolved: !plan && !(settings.monthlyCreditsUsd && settings.monthlyCreditsUsd > 0),
  }
}

interface ControlFetchResult {
  readonly ok: boolean
  readonly body?: unknown
  readonly error?: string
  readonly status?: number
  readonly retryAfterMs?: number
}

const controlFetch = async (
  url: string,
  controlKey: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<ControlFetchResult> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${controlKey}`,
        accept: "application/json",
        "user-agent": OPENDESIGN_USER_AGENT,
      },
      redirect: "error",
      signal: controller.signal,
    })
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"))
      const retryAfterMs =
        Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter * 1000, 15 * 60_000) : undefined
      return {
        ok: false,
        error: `Account control request returned HTTP ${response.status}`,
        status: response.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      }
    }
    const text = await response.text()
    if (text.length > 2 * 1024 * 1024) {
      return { ok: false, error: "Account control response was unexpectedly large" }
    }
    try {
      return { ok: true, body: JSON.parse(text) as unknown }
    } catch {
      return { ok: false, error: "Account control response was malformed" }
    }
  } catch (error) {
    return {
      ok: false,
      error: controller.signal.aborted
        ? "Account control request timed out"
        : redact(error instanceof Error ? error.message : String(error)),
    }
  } finally {
    clearTimeout(timer)
  }
}

interface ControlWindow {
  readonly kind: "rolling" | "weekly" | "monthly"
  readonly usedCredits: number
  readonly limitCredits: number
  readonly remainingCredits: number
  readonly resetsAt?: number
}

const classifyWindow = (durationSeconds: number): ControlWindow["kind"] | undefined => {
  if (durationSeconds <= 0) return undefined
  if (durationSeconds <= 6 * 3600) return "rolling"
  if (durationSeconds <= 8 * 86400) return "weekly"
  if (durationSeconds <= 32 * 86400) return "monthly"
  return undefined
}

const parseControlWindows = (value: unknown): ControlWindow[] => {
  if (!Array.isArray(value)) return []
  const out: ControlWindow[] = []
  for (const row of value) {
    if (!isRecord(row)) continue
    const duration = numberOr(row.durationSeconds)
    if (duration === undefined) continue
    const kind = classifyWindow(duration)
    if (!kind) continue
    const usedCredits = numberOr(row.usedCredits) ?? 0
    const limitCredits = numberOr(row.limitCredits) ?? 0
    const remainingCredits = numberOr(row.remainingCredits) ?? Math.max(0, limitCredits - usedCredits)
    const resetsAt = timeValue(row.resetsAt)
    out.push({ kind, usedCredits, limitCredits, remainingCredits, ...(resetsAt !== undefined ? { resetsAt } : {}) })
  }
  return out
}

/**
 * Build one snapshot per funding pool.
 *
 * The pools are reported side by side rather than summed. A plan card that
 * advertises "$480 total" is advertising two allowances with different rules,
 * so adding them into a single balance would tell a user they can spend it in
 * one go, which is not true.
 */
const buildPoolSnapshots = (input: {
  caps: ReturnType<typeof capsFor>
  used: Readonly<Record<string, { rollingUsd: number; weeklyUsd: number; monthlyUsd: number }>>
  source: "provider" | "estimate"
  creditsPerUsd: number
  resetsAt?: number
}): CreditPoolSnapshot[] => {
  const { caps, used, source } = input
  const out: CreditPoolSnapshot[] = []
  const designUsed = used[OPENDESIGN_DESIGN_PLAN_POOL] ?? { rollingUsd: 0, weeklyUsd: 0, monthlyUsd: 0 }
  if (caps.monthly > 0) {
    out.push({
      id: OPENDESIGN_DESIGN_PLAN_POOL,
      label: "Design Plan credits",
      source,
      monthlyUsd: caps.monthly,
      usedUsd: designUsed.monthlyUsd,
      remainingUsd: Math.max(0, caps.monthly - designUsed.monthlyUsd),
      usedPct: pct(designUsed.monthlyUsd, caps.monthly),
      ...(caps.weekly !== undefined
        ? { weeklyUsd: caps.weekly, weeklyUsedPct: pct(designUsed.weeklyUsd, caps.weekly) }
        : {}),
      ...(caps.rolling !== undefined
        ? { fiveHourUsd: caps.rolling, fiveHourUsedPct: pct(designUsed.rollingUsd, caps.rolling) }
        : {}),
      resetKind: "rolling-7-day",
      ...(input.resetsAt !== undefined ? { resetsAt: input.resetsAt } : {}),
      note: caps.hasFiveHourWindow
        ? "Five-hour and seven-day ceilings nest inside the monthly maximum."
        : "Seven-day ceiling nests inside the monthly maximum. This plan has no five-hour window.",
    })
  }
  if (caps.hasPlanModelPool && caps.planModelsMonthly > 0) {
    const planUsed = used[OPENDESIGN_PLAN_MODEL_POOL] ?? { rollingUsd: 0, weeklyUsd: 0, monthlyUsd: 0 }
    out.push({
      id: OPENDESIGN_PLAN_MODEL_POOL,
      label: "Plan model credits",
      source,
      monthlyUsd: caps.planModelsMonthly,
      usedUsd: planUsed.monthlyUsd,
      remainingUsd: Math.max(0, caps.planModelsMonthly - planUsed.monthlyUsd),
      usedPct: pct(planUsed.monthlyUsd, caps.planModelsMonthly),
      resetKind: "billing-cycle",
      ...(input.resetsAt !== undefined ? { resetsAt: input.resetsAt } : {}),
      note: "No five-hour or seven-day window. Design Plan multipliers do not apply to this pool.",
    })
  }
  return out
}

const planNotes = (caps: ReturnType<typeof capsFor>): string[] => {
  const notes: string[] = []
  if (caps.plan) notes.push(`Plan: ${caps.plan.label}.`)
  notes.push(
    caps.hasFiveHourWindow
      ? "This plan has a five-hour Design Plan window."
      : "This plan has no five-hour Design Plan window.",
  )
  if (caps.hasPlanModelPool && caps.planModelsMonthly > 0) {
    notes.push(
      `A separate plan model pool of $${caps.planModelsMonthly}/month is reported independently and is never added to the Design Plan allowance.`,
    )
  }
  return notes
}

/**
 * Read the account's coding-plan usage windows and wallet balance.
 *
 * The control key is a privileged credential. It is only used when the owner
 * explicitly configures one; the router never obtains one on its own and never
 * asks for a browser session.
 */
const probeVerified = async (
  input: OpenDesignQuotaInput,
  now: number,
): Promise<OpenDesignQuotaResult> => {
  const fetchImpl = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? 12_000
  const controlBase = normalizeOpenDesignControlBaseURL(input.controlBaseURL ?? OPENDESIGN_DEFAULT_CONTROL_BASE_URL)
  const controlKey = input.controlKey ?? ""

  const current = await controlFetch(
    openDesignControlEndpoint(controlBase, "/v1/workspaces/current"),
    controlKey,
    fetchImpl,
    timeoutMs,
  )
  if (!current.ok || !isRecord(current.body)) {
    return {
      snapshot: baseSnapshot(input, now, current.error ?? "Could not read the current workspace", current.retryAfterMs, [
        "Verified quota is unavailable.",
      ]),
      state: "unavailable",
    }
  }
  const workspaceId =
    typeof current.body.activeWorkspaceId === "string"
      ? current.body.activeWorkspaceId
      : typeof current.body.workspaceId === "string"
        ? current.body.workspaceId
        : undefined
  if (!workspaceId) {
    return {
      snapshot: baseSnapshot(input, now, "The account did not report an active workspace", undefined, [
        "Verified quota is unavailable.",
      ]),
      state: "unavailable",
    }
  }

  const usage = await controlFetch(
    openDesignControlEndpoint(controlBase, `/v1/workspaces/${encodeURIComponent(workspaceId)}/billing/coding-plan-usage`),
    controlKey,
    fetchImpl,
    timeoutMs,
  )
  if (!usage.ok || !isRecord(usage.body)) {
    return {
      snapshot: baseSnapshot(input, now, usage.error ?? "Could not read coding-plan usage", usage.retryAfterMs, [
        "Verified quota is unavailable.",
      ]),
      state: "unavailable",
    }
  }
  // Never combine a workspace's usage with another workspace's balance.
  const reportedWorkspace = typeof usage.body.workspaceId === "string" ? usage.body.workspaceId : undefined
  if (reportedWorkspace && reportedWorkspace !== workspaceId) {
    return {
      snapshot: baseSnapshot(input, now, "The usage response did not match the active workspace", undefined, [
        "Balances from different workspaces are never combined.",
      ]),
      state: "unavailable",
    }
  }

  const summary = await controlFetch(
    openDesignControlEndpoint(controlBase, "/v1/billing/summary"),
    controlKey,
    fetchImpl,
    timeoutMs,
  )
  const summaryBody = summary.ok && isRecord(summary.body) ? summary.body : undefined
  const creditsPerUsd = numberOr(summaryBody?.creditsPerUsd) ?? input.creditsPerUsd ?? OPENDESIGN_DEFAULT_CREDITS_PER_USD
  const balances = isRecord(summaryBody?.balances) ? (summaryBody!.balances as Record<string, unknown>) : undefined
  const rechargeCredits = numberOr(balances?.rechargeCredits) ?? 0
  const subscriptionCredits = numberOr(balances?.subscriptionCredits) ?? 0
  const purchasedUsd = rechargeCredits / creditsPerUsd

  const windows = parseControlWindows(usage.body.windows)
  const caps = capsFor(input.settings)
  const find = (kind: ControlWindow["kind"]) => windows.find((window) => window.kind === kind)

  const toWindow = (window: ControlWindow | undefined, fallbackCapUsd: number): QuotaWindow => {
    if (!window || window.limitCredits <= 0) {
      return { usedPct: 0, remainingPct: 100, source: "unknown" }
    }
    const usedPct = pct(window.usedCredits, window.limitCredits)
    return {
      usedPct,
      remainingPct: clamp(100 - usedPct, 0, 100),
      usedUsd: window.usedCredits / creditsPerUsd,
      capUsd: window.limitCredits / creditsPerUsd,
      ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
      exceeded: window.usedCredits >= window.limitCredits,
      source: "provider",
    }
  }

  const rolling = toWindow(find("rolling"), caps.rolling ?? 0)
  const weekly = toWindow(find("weekly"), caps.weekly ?? 0)
  const monthlyWindow = find("monthly")
  const monthly = monthlyWindow
    ? toWindow(monthlyWindow, caps.monthly)
    : {
        usedPct: 0,
        remainingPct: 100,
        source: "unknown" as const,
      }

  const periodStart = timeValue(summaryBody?.subscriptionCurrentPeriodStart)
  const periodEnd = timeValue(summaryBody?.subscriptionCurrentPeriodEnd)
  const monthlyRemainingUsd = monthlyWindow
    ? monthlyWindow.remainingCredits / creditsPerUsd
    : subscriptionCredits > 0
      ? subscriptionCredits / creditsPerUsd
      : undefined

  const pools = buildPoolSnapshots({
    caps,
    used: {
      [OPENDESIGN_DESIGN_PLAN_POOL]: {
        rollingUsd: rolling.usedUsd ?? 0,
        weeklyUsd: weekly.usedUsd ?? 0,
        monthlyUsd: monthly.usedUsd ?? 0,
      },
      [OPENDESIGN_PLAN_MODEL_POOL]: {
        rollingUsd: 0,
        weeklyUsd: 0,
        // The control surface reports Design Plan consumption; plan model
        // credits are reported as a remaining balance only.
        monthlyUsd: Math.max(0, caps.planModelsMonthly - subscriptionCredits / creditsPerUsd),
      },
    },
    source: "provider",
    creditsPerUsd,
    ...(periodEnd !== undefined ? { resetsAt: periodEnd } : {}),
  })

  const notes = [
    "Provider-reported OpenDesign coding-plan usage.",
    "Read-only probe; no inference request is made.",
    `Workspace ${workspaceId}.`,
    ...planNotes(caps),
  ]
  if (purchasedUsd > 0) {
    notes.push(
      `Wallet balance ${purchasedUsd.toFixed(2)} USD is separate from the subscription allowance and is not used for automatic routing.`,
    )
  }

  const snapshot: ProviderQuotaSnapshot = {
    providerID: "opendesign",
    label: caps.plan?.label ?? "OpenDesign",
    plan: describePlan(caps.plan?.planID, input.settings.plan),
    source: "provider",
    fetchedAt: now,
    stale: false,
    rolling,
    weekly,
    monthly,
    // A verified probe reads the real limits from the account, so it reports
    // the provider's own grant when the catalog could not name the plan.
    monthlyGrantUsd: caps.monthly > 0 ? caps.monthly : monthly.capUsd ?? 0,
    ...(monthlyRemainingUsd !== undefined ? { monthlyRemainingUsd } : {}),
    extraCredits: {
      purchasedUsd,
      freeUsd: 0,
      totalUsd: purchasedUsd,
    },
    pools,
    planStatus: typeof summaryBody?.membershipTier === "string" ? summaryBody.membershipTier : undefined,
    ...(periodStart !== undefined ? { periodStart } : {}),
    ...(periodEnd !== undefined ? { periodEnd } : {}),
    models: {},
    notes,
  }
  const exhausted = Boolean(rolling.exceeded || weekly.exceeded || monthly.exceeded)
  return { snapshot, state: exhausted ? "exhausted" : "verified" }
}

/**
 * Model the router's own credit consumption against the published plan caps.
 */

/**
 * Fold a user-supplied account reading into the local totals.
 *
 * A baseline is a real figure the user read from their own account, so it is
 * stronger evidence than the router's own traffic — but only inside the window
 * it was taken in. Once a window has reset, the reading describes the previous
 * window and including it would overstate usage just as badly as omitting it
 * understated it. So each window accepts the baseline only while the reading is
 * newer than that window's start.
 */
const applyBaseline = (
  totals: LocalWindowTotals,
  baseline: ProviderSettings["baseline"],
  now: number,
): { totals: LocalWindowTotals; applied: boolean; windows: string[]; usedFallbackReset?: boolean } => {
  if (!baseline) return { totals, applied: false, windows: [] }
  const designPlan = Math.max(0, baseline.designPlanUsedUsd ?? 0)
  const planModels = Math.max(0, baseline.planModelsUsedUsd ?? 0)
  if (designPlan === 0 && planModels === 0) return { totals, applied: false, windows: [] }

  /**
   * A window accepts the reading until that window RESETS — not merely until the
   * reading is older than the window's length.
   *
   * These differ, and the difference is not academic. A seven-day window that
   * resets 23 hours from now (the account page shows this) means the reading
   * describes the window ending in 23 hours. Seeding it into the window that
   * begins afterwards would attribute a previous window's usage to a fresh one.
   *
   * When the account page gave a reset time, trust it. Otherwise fall back to
   * age, and say that the fallback was used.
   */
  const resetPassed = (resetsAt: number | undefined) => resetsAt !== undefined && now >= resetsAt
  const withinRolling = baseline.at >= now - FIVE_HOURS_MS && !resetPassed(baseline.weeklyResetsAt)
  const withinWeekly = baseline.at >= now - WEEK_MS && !resetPassed(baseline.weeklyResetsAt)
  const withinMonthly = baseline.at >= now - MONTH_MS && !resetPassed(baseline.monthlyResetsAt)
  if (!withinMonthly) return { totals, applied: false, windows: [] }

  const windows: string[] = []
  if (withinRolling) windows.push("5h")
  if (withinWeekly) windows.push("7d")
  windows.push("monthly")

  const designRolling = withinRolling ? designPlan : 0
  const designWeekly = withinWeekly ? designPlan : 0
  const planRolling = withinRolling ? planModels : 0
  const planWeekly = withinWeekly ? planModels : 0

  const byPool = { ...totals.byPool }
  const designBucket = byPool[OPENDESIGN_DESIGN_PLAN_POOL] ?? { rollingUsd: 0, weeklyUsd: 0, monthlyUsd: 0 }
  const planBucket = byPool[OPENDESIGN_PLAN_MODEL_POOL] ?? { rollingUsd: 0, weeklyUsd: 0, monthlyUsd: 0 }
  if (designPlan > 0) {
    byPool[OPENDESIGN_DESIGN_PLAN_POOL] = {
      rollingUsd: designBucket.rollingUsd + designRolling,
      weeklyUsd: designBucket.weeklyUsd + designWeekly,
      monthlyUsd: designBucket.monthlyUsd + designPlan,
    }
  }
  if (planModels > 0) {
    byPool[OPENDESIGN_PLAN_MODEL_POOL] = {
      rollingUsd: planBucket.rollingUsd + planRolling,
      weeklyUsd: planBucket.weeklyUsd + planWeekly,
      monthlyUsd: planBucket.monthlyUsd + planModels,
    }
  }

  return {
    applied: true,
    windows,
    usedFallbackReset: baseline.weeklyResetsAt === undefined,
    totals: {
      rollingUsd: totals.rollingUsd + designRolling + planRolling,
      weeklyUsd: totals.weeklyUsd + designWeekly + planWeekly,
      monthlyUsd: totals.monthlyUsd + designPlan + planModels,
      observedRequests: totals.observedRequests,
      byPool,
    },
  }
}

const probeEstimated = (input: OpenDesignQuotaInput, now: number): OpenDesignQuotaResult => {
  const caps = capsFor(input.settings)
  const marginPct = input.uncertaintyMarginPct ?? OPENDESIGN_DEFAULT_UNCERTAINTY_MARGIN_PCT
  const local = localTotals(
    input.usage,
    "opendesign",
    now,
    marginPct,
    caps.plan,
    input.multiplierOverrides,
  )
  const seeded = applyBaseline(local, input.settings.baseline, now)
  const totals = seeded.totals
  // A window the plan does not have is never reported as a measured 0%.
  // Reporting "0% of a five-hour window" would imply a ceiling that could be
  // hit, when the plan has no such limit.
  const rolling = caps.rolling !== undefined
    ? windowFrom(totals.rollingUsd, caps.rolling, undefined, "estimate")
    : { ...unknownWindow, usedUsd: totals.rollingUsd }
  const weekly = caps.weekly !== undefined
    ? windowFrom(totals.weeklyUsd, caps.weekly, undefined, "estimate")
    : { ...unknownWindow, usedUsd: totals.weeklyUsd }
  const monthly = caps.unresolved
    ? { ...unknownWindow, usedUsd: totals.monthlyUsd }
    : windowFrom(totals.monthlyUsd, caps.monthly, undefined, "estimate")
  const pools = buildPoolSnapshots({
    caps,
    used: totals.byPool,
    source: "estimate",
    creditsPerUsd: OPENDESIGN_DEFAULT_CREDITS_PER_USD,
  })
  const notes = [
    seeded.applied
      ? `Starts from the usage you reported on ${new Date(input.settings.baseline!.at).toISOString().slice(0, 10)} and adds every OpenDesign request this router has routed since.`
      : "Estimated from this router's own OpenDesign usage. OpenDesign publishes no quota API for an inference key.",
    seeded.applied
      ? `The reported reading still excludes other clients, and a ${marginPct}% margin is applied, so this remains a lower bound. A control key gives the account's exact figures.`
      : `A ${marginPct}% safety margin is applied. Usage from the OpenDesign app or other clients on the same subscription is not visible, so this is a lower bound.`,
    "Wallet balance is not included and is never used for automatic routing.",
    ...planNotes(caps),
  ]
  if (seeded.applied) {
    notes.push(
      seeded.usedFallbackReset
        ? `The reported reading applies to: ${seeded.windows.join(", ")}. No reset time was supplied, so the router assumes the reading stays valid for its window length. Add baseline.weeklyResetsAt to be exact.`
        : `The reported reading applies to: ${seeded.windows.join(", ")} until that window resets.`,
    )
  }
  if (caps.unresolved) {
    notes.push(
      `The configured plan "${input.settings.plan}" is not in the catalog, so the allowance is unknown rather than zero. Set a plan id from the catalog or an explicit monthlyCreditsUsd.`,
    )
  }
  if (totals.observedRequests === 0) {
    notes.push(
      seeded.applied
        ? "No OpenDesign requests have been routed through this router since that reading, so the figure is still exactly what you reported."
        : "No OpenDesign requests have been routed through this router yet, so the estimate starts at zero.",
    )
  }
  const snapshot: ProviderQuotaSnapshot = {
    providerID: "opendesign",
    label: caps.plan?.label ?? "OpenDesign",
    plan: describePlan(caps.plan?.planID, input.settings.plan),
    source: "estimate",
    fetchedAt: now,
    stale: false,
    rolling,
    weekly,
    monthly,
    monthlyGrantUsd: caps.monthly,
    // An unresolved plan has no known allowance, so a "remaining balance" of
    // zero would be a fabrication. Omitting the field lets the eligibility
    // gate fall through to the unknown-quota policy rather than reporting the
    // provider as exhausted.
    ...(caps.unresolved ? {} : { monthlyRemainingUsd: Math.max(0, caps.monthly - totals.monthlyUsd) }),
    pools,
    models: {},
    notes,
  }
  if (caps.unresolved) return { snapshot, state: "unknown" }
  const exhausted = Boolean(monthly.exceeded || weekly.exceeded)
  return { snapshot, state: exhausted ? "exhausted" : "estimated" }
}

/**
 * Resolve the OpenDesign quota state.
 *
 * A control key, when explicitly configured, produces verified provider
 * numbers. Otherwise the router falls back to its own estimate. It never
 * acquires a control key, never uses a browser session, and never treats a
 * wallet balance as permission to spend.
 */
export const probeOpenDesignQuota = async (
  input: OpenDesignQuotaInput,
): Promise<OpenDesignQuotaResult> => {
  const now = input.now?.() ?? Date.now()
  if (!input.settings.enabled) {
    return {
      snapshot: baseSnapshot(input, now, "OpenDesign is disabled in router settings", undefined, [
        "The provider is disabled; it takes no part in routing.",
      ]),
      state: "unavailable",
    }
  }
  if (input.controlKey) {
    return probeVerified(input, now)
  }
  if (!input.apiKey) {
    return {
      snapshot: baseSnapshot(input, now, "No OpenDesign credential is configured", undefined, [
        "Add an OpenDesign API key, or configure a control key for verified quota.",
      ]),
      state: "unavailable",
    }
  }
  return probeEstimated(input, now)
}

export const __opendesignQuotaInternals = {
  classifyWindow,
  parseControlWindows,
  localTotals,
  windowFrom,
  failureClassForStatus,
}
