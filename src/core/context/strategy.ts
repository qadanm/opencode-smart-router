/**
 * Context-management strategies.
 *
 * These are deliberately separate mechanisms, because they solve different
 * problems and have very different costs:
 *
 *  - **Provider prompt caching** happens on the provider's side. The router
 *    never controls it; it only avoids destroying it by needlessly switching
 *    models. There is nothing to configure and it must never be disabled.
 *  - **Context budgeting** is arithmetic done before a request: does the
 *    transcript fit the model window the provider actually accepts?
 *  - **Compaction** is destructive. It replaces the transcript with a summary
 *    and permanently loses detail. On the old $10 plan it was the only way to
 *    keep a long session on the cheapest provider, so the router compacted
 *    eagerly.
 *
 * Only the third is a strategy. The three modes below differ almost entirely
 * in *when*, and *whether*, compaction happens.
 */

import type { ContextManagementMode, ContextManagementSettings } from "../types.js"

/** A margin added on top of the measured transcript before judging fit. */
export const CONTEXT_ELIGIBILITY_MARGIN_TOKENS = 20_000

/** The fraction of a model's window a request must stay under. */
export const CONTEXT_SAFE_WINDOW_FRACTION = 0.95

export interface CompactionDecision {
  readonly compact: boolean
  /** Why this decision was reached, in plain language for the owner. */
  readonly reason: string
  /** The transcript size that triggered the decision, when one did. */
  readonly triggerTokens?: number
  /** The size compaction is trying to get under, when relevant. */
  readonly targetTokens?: number
  /** True when the host's verified limit, not a router preference, drove it. */
  readonly hardLimit: boolean
}

const no: (reason: string) => CompactionDecision = (reason) => ({ compact: false, reason, hardLimit: false })

export interface CompactionContext {
  readonly mode: ContextManagementMode
  readonly settings: ContextManagementSettings
  readonly contextTokens: number
  /**
   * The largest window the session can actually use on the provider it is on.
   * This is the provider's accepted limit, never a theoretical maximum.
   */
  readonly effectiveWindow: number
  /**
   * The window of the cheapest qualified route. On the budget-optimized mode
   * this is smaller than `effectiveWindow`, and staying inside it is what
   * keeps a session on the cheapest provider.
   */
  readonly cheapestWindow?: number
}

/**
 * Decide whether to compact.
 *
 * All three modes keep a real safety floor: a request that would exceed the
 * provider's verified window must be handled before it is sent, because the
 * alternative is a failed turn or silent truncation by the provider. They
 * differ in whether *any* earlier compaction happens.
 */
export const decideCompaction = (input: CompactionContext): CompactionDecision => {
  const { mode, settings, contextTokens, effectiveWindow } = input
  if (!settings.enabled) {
    return { compact: false, reason: "Context management is disabled; native context handling only.", hardLimit: false }
  }
  if (contextTokens <= 0) return no("No measured context size yet.")
  if (effectiveWindow <= 0) return no("The model's accepted context window is unknown; no router-driven compaction.")

  const required = contextTokens + CONTEXT_ELIGIBILITY_MARGIN_TOKENS
  const safeLimit = effectiveWindow * CONTEXT_SAFE_WINDOW_FRACTION
  const overflow = required > safeLimit

  if (mode === "native") {
    // Native mode still refuses to knowingly send an over-window request.
    // The host's own compaction is the preferred recovery; the router only
    // steps in when the request genuinely cannot fit.
    if (!overflow) return no("Native mode: the transcript fits the verified window.")
    if (settings.allowEmergencyCompaction === false) {
      return {
        compact: false,
        reason: "Native mode: transcript is at the verified limit, but emergency compaction is disabled.",
        triggerTokens: contextTokens,
        targetTokens: Math.floor(safeLimit),
        hardLimit: true,
      }
    }
    return {
      compact: true,
      reason: "Native mode emergency compaction: the transcript would exceed the model's verified window.",
      triggerTokens: contextTokens,
      targetTokens: Math.floor(safeLimit),
      hardLimit: true,
    }
  }

  if (mode === "conservative") {
    if (!overflow) return no("Conservative mode: the transcript fits the verified window; history preserved.")
    return {
      compact: true,
      reason: "Conservative mode: compacting only because the transcript would exceed the verified window.",
      triggerTokens: contextTokens,
      targetTokens: Math.floor(safeLimit),
      hardLimit: true,
    }
  }

  // budget-optimized: the legacy behavior, preserved deliberately.
  const target = input.cheapestWindow && input.cheapestWindow > 0 ? input.cheapestWindow : effectiveWindow
  const targetLimit = target * CONTEXT_SAFE_WINDOW_FRACTION
  const threshold = Math.min(
    targetLimit,
    settings.compactAtTokens > 0 ? settings.compactAtTokens : Number.POSITIVE_INFINITY,
  )
  if (required <= threshold) return no("Budget-optimized mode: inside the configured compact threshold.")

  const hardLimit = required > safeLimit
  return {
    compact: true,
    reason: hardLimit
      ? "Budget-optimized mode: compacting to stay inside the verified window of the cheapest qualified route."
      : "Budget-optimized mode: compacting early to keep this session on the cheapest qualified route.",
    triggerTokens: contextTokens,
    targetTokens: Math.floor(threshold),
    hardLimit,
  }
}

/**
 * The practical window for a model.
 *
 * A model's theoretical maximum and the window a gateway will actually accept
 * are different numbers. The adapter reports the accepted value into
 * `ModelRecord.context`, and this helper exists so the distinction is explicit
 * wherever a limit is used rather than being re-derived at each call site.
 */
export const practicalWindow = (model: { context: number; maxOutput: number }): number => {
  if (model.context <= 0) return 0
  // Output budget is part of the same window on providers that reserve it
  // inside the context length. Subtracting it would double-count when the
  // provider already reports a net input budget, so only a sanity floor is
  // applied here; the authoritative figure is the reported window.
  return model.context
}

export const describeMode = (mode: ContextManagementMode): string => {
  switch (mode) {
    case "native":
      return "Native: no router-driven compaction unless the transcript would exceed the verified window."
    case "conservative":
      return "Conservative: history preserved; compaction only to prevent a real overflow."
    case "budget-optimized":
      return "Budget-optimized: compacts early to keep sessions on the cheapest qualified route."
    default:
      return "Unknown mode."
  }
}
