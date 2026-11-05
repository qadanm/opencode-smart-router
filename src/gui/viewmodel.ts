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

export interface ProviderRow {
  readonly providerID: string
  readonly label: string
  /** `provider` and `estimate` are facts of different strength and are never merged. */
  readonly source: "provider" | "estimate" | "unknown"
  readonly sourceLabel: string
  readonly monthlyUsedPct: number
  readonly weeklyUsedPct: number
  readonly fiveHourUsedPct: number
  readonly error?: string
  readonly exhausted: boolean
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

const sourceLabel = (source: ProviderRow["source"]): string => {
  switch (source) {
    case "provider":
      return "verified by provider"
    case "estimate":
      return "estimated — lower bound"
    default:
      return "not probed"
  }
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

export const toProviderRow = (snapshot: ProviderQuotaSnapshot): ProviderRow => {
  const source: ProviderRow["source"] =
    snapshot.monthly?.source === "provider"
      ? "provider"
      : snapshot.monthly?.source === "estimate"
        ? "estimate"
        : "unknown"
  return {
    providerID: snapshot.providerID,
    label: snapshot.label ?? snapshot.providerID,
    source,
    sourceLabel: sourceLabel(source),
    monthlyUsedPct: snapshot.monthly?.usedPct ?? 0,
    weeklyUsedPct: snapshot.weekly?.usedPct ?? 0,
    fiveHourUsedPct: snapshot.rolling?.usedPct ?? 0,
    ...(snapshot.error ? { error: snapshot.error } : {}),
    exhausted: Boolean(snapshot.monthly?.exceeded || snapshot.weekly?.exceeded || snapshot.rolling?.exceeded),
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
