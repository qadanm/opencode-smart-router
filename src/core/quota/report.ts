/**
 * Usage aggregation and forecasting.
 *
 * The earlier ledger kept a flat, capped array of events, so a heavy afternoon
 * erased the start of the week and no weekly or monthly projection was
 * possible. The ledger now folds aged events into hourly buckets; this module
 * turns those into the windows a plan actually meters, and projects
 * consumption against the window that will reset first.
 *
 * Everything here is an estimate unless a provider snapshot supplied the
 * numbers, and each figure says which it is.
 */

import type { UsageEvent } from "../types.js"

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export interface WindowTotals {
  readonly since: number
  readonly until: number
  readonly requests: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly usd: number
  readonly failures: number
  readonly latencyMsTotal: number
  readonly latencySamples: number
}

export interface Forecast {
  /** Credits or dollars projected over the full window at the current rate. */
  readonly projectedUsd: number
  /** Hours of representative data the projection is based on. */
  readonly basisHours: number
  /** When the allowance would run out at the current rate, if it would. */
  readonly exhaustsAt?: number
  /** True when the projection exceeds the remaining allowance. */
  readonly willExhaust: boolean
  /** Short, plain-language explanation for a dashboard. */
  readonly explanation: string
}

export interface UsageSource {
  aggregate(input: { providerID?: string; modelID?: string; since: number; until?: number }): WindowTotals
  usageByModel(input: { since: number; until?: number }): Array<{
    providerID: string
    modelID: string
    requests: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    usd: number
  }>
  readonly usageEvents: ReadonlyArray<UsageEvent>
}

/**
 * Project consumption from a representative recent window.
 *
 * The basis is capped so a long quiet stretch cannot dilute a burst, and
 * floored so a burst of a few minutes is not extrapolated into a month. Both
 * bounds are stated in the explanation rather than hidden.
 */
export const forecast = (input: {
  windowMs: number
  now: number
  spendInWindowUsd: number
  /** Earliest instant with representative activity, if known. */
  activityStart?: number
  remainingUsd?: number
  label: string
}): Forecast => {
  const windowStart = input.now - input.windowMs
  const earliest = Math.max(windowStart, input.activityStart ?? windowStart)
  // A representative basis: at least one hour, at most the full window.
  const basisMs = Math.min(
    input.windowMs,
    Math.max(60 * 60 * 1000, input.now - earliest),
  )
  const basisHours = basisMs / (60 * 60 * 1000)
  const windowHours = input.windowMs / (60 * 60 * 1000)
  const perHour = input.spendInWindowUsd / Math.max(0.001, basisHours)
  const projectedUsd = perHour * windowHours
  const remaining = input.remainingUsd
  const willExhaust = remaining !== undefined && projectedUsd > remaining
  const exhaustsAt =
    willExhaust && perHour > 0
      ? input.now + (Math.max(0, remaining ?? 0) / perHour) * 60 * 60 * 1000
      : undefined
  const explanation = willExhaust
    ? `At the current rate the ${input.label} allowance runs out about ${formatRelative(exhaustsAt ?? input.now, input.now)}.`
    : `At the current rate the ${input.label} allowance covers the full window.`
  return {
    projectedUsd,
    basisHours,
    ...(exhaustsAt !== undefined ? { exhaustsAt } : {}),
    willExhaust,
    explanation,
  }
}

export const formatRelative = (at: number, now: number): string => {
  const delta = at - now
  if (delta <= 0) return "now"
  const hours = delta / (60 * 60 * 1000)
  if (hours < 1) return `${Math.round(delta / 60_000)} minutes from now`
  if (hours < 48) return `${hours.toFixed(1)} hours from now`
  return `${(hours / 24).toFixed(1)} days from now`
}

export interface ProviderUsageReport {
  readonly providerID: string
  readonly label: string
  readonly plan: string
  readonly source: "provider" | "estimate" | "unknown"
  readonly quotaState?: string
  readonly fiveHour: WindowTotals
  readonly weekly: WindowTotals
  readonly monthly: WindowTotals
  readonly cacheSharePct: number
  readonly byModel: Array<{
    providerID: string
    modelID: string
    requests: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    usd: number
  }>
  readonly forecasts: ReadonlyArray<{ window: string; forecast: Forecast }>
  readonly notes: ReadonlyArray<string>
}

/**
 * Build a per-provider report from durable aggregates.
 *
 * A plan with no five-hour window reports `fiveHour` with zero requests rather
 * than pretending a limit exists, so a dashboard can tell "unused" apart from
 * "not applicable".
 */
export const buildProviderUsageReport = (input: {
  providerID: string
  label: string
  plan: string
  source: "provider" | "estimate" | "unknown"
  quotaState?: string
  now: number
  source_: UsageSource
  hasFiveHourWindow: boolean
  hasWeeklyWindow: boolean
  remainingMonthlyUsd?: number
  notes: ReadonlyArray<string>
}): ProviderUsageReport => {
  const { now, source_ } = input
  const monthStart = now - 30 * DAY_MS
  const fiveHour = input.hasFiveHourWindow
    ? source_.aggregate({ providerID: input.providerID, since: now - FIVE_HOURS_MS, until: now })
    : emptyTotals(now - FIVE_HOURS_MS, now)
  const weekly = input.hasWeeklyWindow
    ? source_.aggregate({ providerID: input.providerID, since: now - WEEK_MS, until: now })
    : emptyTotals(now - WEEK_MS, now)
  const monthly = source_.aggregate({ providerID: input.providerID, since: monthStart, until: now })
  const byModel = source_.usageByModel({ since: monthStart, until: now })
    .filter((entry) => entry.providerID === input.providerID)

  const totalInput = monthly.input + monthly.cacheRead + monthly.cacheWrite
  const cacheSharePct = totalInput > 0 ? (monthly.cacheRead / totalInput) * 100 : 0

  const activityStart = earliestActivity(source_.usageEvents, input.providerID)
  const forecasts = [
    ...(input.hasFiveHourWindow
      ? [{
          window: "5-hour",
          forecast: forecast({
            windowMs: FIVE_HOURS_MS,
            now,
            spendInWindowUsd: fiveHour.usd,
            ...(activityStart !== undefined ? { activityStart } : {}),
            label: `${input.label} five-hour`,
          }),
        }]
      : []),
    ...(input.hasWeeklyWindow
      ? [{
          window: "7-day",
          forecast: forecast({
            windowMs: WEEK_MS,
            now,
            spendInWindowUsd: weekly.usd,
            ...(activityStart !== undefined ? { activityStart } : {}),
            label: `${input.label} seven-day`,
          }),
        }]
      : []),
    {
      window: "monthly",
      forecast: forecast({
        windowMs: 30 * DAY_MS,
        now,
        spendInWindowUsd: monthly.usd,
        ...(activityStart !== undefined ? { activityStart } : {}),
        ...(input.remainingMonthlyUsd !== undefined
          ? { remainingUsd: input.remainingMonthlyUsd }
          : {}),
        label: `${input.label} monthly`,
      }),
    },
  ]

  return {
    providerID: input.providerID,
    label: input.label,
    plan: input.plan,
    source: input.source,
    ...(input.quotaState ? { quotaState: input.quotaState } : {}),
    fiveHour,
    weekly,
    monthly,
    cacheSharePct,
    byModel,
    forecasts,
    notes: [
      ...input.notes,
      input.hasFiveHourWindow
        ? "This plan meters a five-hour window."
        : "This plan has no five-hour window; that row is not a limit being ignored.",
    ],
  }
}

const emptyTotals = (since: number, until: number): WindowTotals => ({
  since,
  until,
  requests: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  usd: 0,
  failures: 0,
  latencyMsTotal: 0,
  latencySamples: 0,
})

const earliestActivity = (
  events: ReadonlyArray<UsageEvent>,
  providerID: string,
): number | undefined => {
  let earliest: number | undefined
  for (const event of events) {
    if (event.providerID !== providerID) continue
    if (earliest === undefined || event.at < earliest) earliest = event.at
  }
  return earliest
}
