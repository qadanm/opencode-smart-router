import type { CandidateEvaluation, ModelKey, ProviderQuotaSnapshot, RoutingDecision } from "../core/types.js"

/**
 * The GUI's view-model.
 *
 * Pure functions over the data the server already produces. No Solid, no DOM,
 * no RPC — so every rule below is testable in plain Node, and the TUI renderer
 * can reuse it unchanged.
 *
 * The rule this file exists to enforce: the panel shows the router's own words.
 * If the engine says a model was ineligible because the weekly window is spent,
 * that sentence is displayed. The view-model formats and orders; it never
 * invents or softens a reason.
 */

export type Verdict = "chosen" | "eligible" | "blocked"

export interface CandidateRow {
  readonly key: string
  readonly name: string
  readonly tier: number
  readonly verdict: Verdict
  readonly reason: string
  readonly estimatedUsd: number
  readonly effectiveCost: number
  readonly successProbability: number
  /** Why the ranking moved this model, when a multiplier applied. Empty otherwise. */
  readonly adjustments: ReadonlyArray<string>
}

export interface DecisionView {
  readonly id: string
  readonly chosen: string | undefined
  readonly switched: boolean
  readonly switchReason: string
  readonly taskKind: string
  readonly taskTier: number
  readonly contextTokens: number
  readonly estimatedUsd: number
  readonly reasons: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
  readonly eligibleCount: number
  readonly blockedCount: number
  readonly rows: ReadonlyArray<CandidateRow>
}

export type WindowID = "fiveHour" | "weekly" | "monthly"

export interface QuotaWindowView {
  readonly id: WindowID
  /** Short label used in the panel: 5h, 7d, Monthly. */
  readonly label: string
  readonly usedPct: number
  readonly remainingPct: number
  readonly usedUsd?: number
  readonly capUsd?: number
  readonly resetsAt?: number
  readonly resetLabel?: string
  readonly source: "provider" | "estimate" | "unknown"
  readonly sourceLabel: string
  readonly exceeded: boolean
  /**
   * Whether the provider reports this window at all. A window that does not
   * exist for a plan is different from a window at 0%, and showing "0%" for a
   * five-hour cap that does not apply would be a lie.
   */
  readonly reported: boolean
  /**
   * True when the figure is a lower bound the router derived itself, not a
   * measurement from the provider.
   *
   * This matters more than it looks. OpenDesign publishes no quota endpoint for
   * an inference key, so the router estimates from the traffic it routed itself.
   * A user whose account was already 42% used before installing the router saw
   * "5% monthly" — a true statement about the router's own traffic, and a
   * dangerously wrong impression of their account. A lower bound must never be
   * rendered as a measurement.
   */
  readonly lowerBound: boolean
}

export interface PoolRow {
  readonly id: string
  readonly label: string
  readonly source: "provider" | "estimate" | "unknown"
  readonly sourceLabel: string
  readonly monthlyUsd: number
  readonly usedUsd: number
  readonly remainingUsd: number
  readonly usedPct: number
  readonly weeklyPct?: number
  readonly fiveHourPct?: number
  readonly resetLabel?: string
  readonly note: string
}

export interface ProviderRow {
  readonly providerID: string
  readonly label: string
  readonly plan: string
  /** `provider` and `estimate` are facts of different strength and are never merged. */
  readonly source: "provider" | "estimate" | "unknown"
  readonly sourceLabel: string
  readonly quotaState?: string
  readonly stale: boolean
  readonly fetchedAt: number
  /** The tightest window that is exhausted, if any. */
  readonly exhausted: boolean
  readonly exhaustedWindow?: string
  /** 5h, 7d, monthly — always all three, with `reported` telling the truth. */
  readonly windows: ReadonlyArray<QuotaWindowView>
  readonly pools: ReadonlyArray<PoolRow>
  readonly monthlyRemainingUsd?: number
  readonly extraCreditsUsd?: number
  readonly error?: string
  readonly notes: ReadonlyArray<string>
  /** The sentence that explains why a figure is a lower bound, if it is one. */
  readonly caveat?: string
}

const sourceLabelOf = (source: "provider" | "estimate" | "unknown"): string => {
  switch (source) {
    case "provider":
      return "verified by provider"
    case "estimate":
      return "estimated — lower bound"
    default:
      return "not reported"
  }
}

const windowLabels: Record<WindowID, string> = {
  fiveHour: "5h",
  weekly: "7d",
  monthly: "Monthly",
}

/** Human reset time. Absolute once it is far away; relative while it matters. */
export const formatReset = (at: number | undefined, now = Date.now()): string | undefined => {
  if (at === undefined) return undefined
  const delta = at - now
  if (delta <= 0) return "resetting"
  const minutes = Math.round(delta / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `in ${hours}h`
  const days = Math.round(hours / 24)
  return `in ${days}d`
}

const toWindow = (
  id: WindowID,
  window: { usedPct?: number; remainingPct?: number; usedUsd?: number; capUsd?: number; resetsAt?: number; exceeded?: boolean; source?: "provider" | "estimate" | "unknown" } | undefined,
  now: number,
): QuotaWindowView => {
  const source = window?.source ?? "unknown"
  const usedPct = window?.usedPct ?? 0
  // A window is reported when the provider said anything about it. A cap with no
  // source is an absent window, not an empty one.
  const reported = source !== "unknown" && (window?.capUsd !== undefined || usedPct > 0)
  return {
    id,
    label: windowLabels[id],
    usedPct,
    remainingPct: window?.remainingPct ?? Math.max(0, 100 - usedPct),
    ...(window?.usedUsd !== undefined ? { usedUsd: window.usedUsd } : {}),
    ...(window?.capUsd !== undefined ? { capUsd: window.capUsd } : {}),
    ...(window?.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
    ...(formatReset(window?.resetsAt, now) ? { resetLabel: formatReset(window?.resetsAt, now)! } : {}),
    source,
    sourceLabel: sourceLabelOf(source),
    exceeded: Boolean(window?.exceeded),
    reported,
    lowerBound: source === "estimate",
  }
}

export const toProviderRow = (snapshot: ProviderQuotaSnapshot, now = Date.now()): ProviderRow => {
  const source: ProviderRow["source"] =
    snapshot.monthly?.source === "provider"
      ? "provider"
      : snapshot.monthly?.source === "estimate"
        ? "estimate"
        : "unknown"
  const windows = [
    toWindow("fiveHour", snapshot.rolling, now),
    toWindow("weekly", snapshot.weekly, now),
    toWindow("monthly", snapshot.monthly, now),
  ]
  const exhaustedWindow = windows.find((window) => window.exceeded)
  const pools: PoolRow[] = (snapshot.pools ?? []).map((pool) => ({
    id: pool.id,
    label: pool.label,
    source: pool.source,
    sourceLabel: sourceLabelOf(pool.source),
    monthlyUsd: pool.monthlyUsd,
    usedUsd: pool.usedUsd,
    remainingUsd: pool.remainingUsd,
    usedPct: pool.usedPct,
    ...(pool.weeklyUsedPct !== undefined ? { weeklyPct: pool.weeklyUsedPct } : {}),
    ...(pool.fiveHourUsedPct !== undefined ? { fiveHourPct: pool.fiveHourUsedPct } : {}),
    ...(formatReset(pool.resetsAt, now) ? { resetLabel: formatReset(pool.resetsAt, now)! } : {}),
    note: pool.note,
  }))

  return {
    providerID: snapshot.providerID,
    label: snapshot.label ?? snapshot.providerID,
    plan: snapshot.plan ?? "",
    source,
    sourceLabel: sourceLabelOf(source),
    ...(snapshot.quotaState ? { quotaState: snapshot.quotaState } : {}),
    stale: Boolean(snapshot.stale),
    fetchedAt: snapshot.fetchedAt ?? now,
    exhausted: Boolean(exhaustedWindow),
    ...(exhaustedWindow ? { exhaustedWindow: exhaustedWindow.label } : {}),
    windows,
    pools,
    ...(snapshot.monthlyRemainingUsd !== undefined ? { monthlyRemainingUsd: snapshot.monthlyRemainingUsd } : {}),
    ...(snapshot.extraCredits ? { extraCreditsUsd: snapshot.extraCredits.totalUsd } : {}),
    ...(snapshot.error ? { error: snapshot.error } : {}),
    notes: snapshot.notes ?? [],
    ...(source === "estimate" ? { caveat: (snapshot.notes ?? [])[0] } : {}),
  }
}

/** Money at the precision the router actually estimates in. */
export const formatUsd = (value: number): string => {
  if (!Number.isFinite(value)) return "—"
  if (value === 0) return "$0"
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

export const formatPercent = (value: number): string => (Number.isFinite(value) ? `${Math.round(value)}%` : "—")

/**
 * A percentage as the panel should show it.
 *
 * `≥` is not decoration: it tells the reader the real figure is at least this,
 * and may be far higher. Without it, an estimate reads as a measurement.
 */
export const formatWindowUsed = (window: { usedPct: number; lowerBound: boolean; reported: boolean }): string => {
  if (!window.reported) return "—"
  const value = formatPercent(window.usedPct)
  return window.lowerBound ? `≥${value}` : value
}

/**
 * Explain the multipliers that changed a candidate's rank.
 *
 * These exist because a user who sees two prices and one winner will assume the
 * cheaper one won. When it did not, the panel has to say which multiplier moved
 * it, or the ranking looks arbitrary.
 */
export const rankingAdjustments = (candidate: CandidateEvaluation): ReadonlyArray<string> => {
  const notes: string[] = []
  const credit = candidate.creditMultiplier
  if (credit !== undefined && credit !== 1) notes.push(`${credit}x plan credits`)
  const speed = candidate.speedFactor
  if (speed !== undefined && speed !== 1) notes.push(`${speed}x measured speed`)
  const marginal = candidate.marginalPriceFactor
  if (marginal !== undefined && marginal !== 1) notes.push(`${marginal}x expiring allowance`)
  if (candidate.switchPenaltyUsd > 0) notes.push(`${formatUsd(candidate.switchPenaltyUsd)} switch cost`)
  return notes
}

/** `provider/model`, the same shape the engine uses for model identity. */
export const keyOf = (model: ModelKey): string => `${model.providerID}/${model.modelID}`

export const toCandidateRow = (candidate: CandidateEvaluation, chosen: string | undefined): CandidateRow => {
  const key = keyOf(candidate.model)
  return {
    key,
    name: candidate.name,
    tier: candidate.tier,
    verdict: key === chosen && candidate.eligible ? "chosen" : candidate.eligible ? "eligible" : "blocked",
    reason: candidate.reason,
    estimatedUsd: candidate.estimatedUsd,
    effectiveCost: candidate.effectiveCost,
    successProbability: candidate.successProbability,
    adjustments: rankingAdjustments(candidate),
  }
}

/**
 * Order for display: what won, then what could have, cheapest first, then what
 * could not and why. A blocked model is never hidden — "why can't I use this"
 * is the question a user asks most often.
 */
const verdictRank: Record<Verdict, number> = { chosen: 0, eligible: 1, blocked: 2 }

export const orderCandidateRows = (rows: ReadonlyArray<CandidateRow>): ReadonlyArray<CandidateRow> =>
  [...rows].sort((left, right) => {
    const byVerdict = verdictRank[left.verdict] - verdictRank[right.verdict]
    if (byVerdict !== 0) return byVerdict
    if (left.verdict === "blocked") return left.key.localeCompare(right.key)
    return left.effectiveCost - right.effectiveCost || left.key.localeCompare(right.key)
  })

export const summariseDecision = (decision: RoutingDecision | undefined | null): DecisionView | undefined => {
  if (!decision) return undefined
  const chosenKey = decision.chosen ? `${decision.chosen.providerID}/${decision.chosen.id}` : undefined
  const rows = orderCandidateRows(decision.candidates.map((candidate) => toCandidateRow(candidate, chosenKey)))
  return {
    id: decision.id,
    chosen: chosenKey,
    switched: decision.switched,
    switchReason: decision.switchReason,
    taskKind: decision.task?.kind ?? "unknown",
    taskTier: decision.task?.tier ?? 0,
    contextTokens: decision.contextTokens,
    estimatedUsd: decision.estimatedUsd,
    reasons: decision.reasons ?? [],
    warnings: decision.warnings ?? [],
    eligibleCount: rows.filter((row) => row.verdict !== "blocked").length,
    blockedCount: rows.filter((row) => row.verdict === "blocked").length,
    rows,
  }
}

/** The one-line state shown above the decision, and in the footer slot. */
export const statusLine = (input: {
  runtime?: string
  mode?: string
  current?: { providerID: string; id: string } | undefined
}): string => {
  const parts = [input.runtime ?? "unknown", input.mode ?? "unknown"]
  parts.push(input.current ? `${input.current.providerID}/${input.current.id}` : "no model yet")
  return parts.join(" · ")
}
