import type { ExtraCredits, ProviderQuotaSnapshot, ProviderSettings, QuotaWindow } from "../types.js"
import { clamp, pct, redact } from "../util.js"
import {
  describeCredentialSource,
  discoverCommandCodeCredentials,
  type CredentialCandidate,
} from "./credentials.js"

const HOST = "https://api.commandcode.ai"
const TIMEOUT_MS = 8_000
const MAX_BODY_BYTES = 1_000_000
const USER_AGENT = "opencode-smart-router/0.1"

const PLAN_CREDITS: Record<string, number> = {
  "individual-go": 10,
  "individual-go-v1": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-pro-v1": 80,
  "individual-provider": 15,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
}

const PLAN_NAMES: Record<string, string> = {
  "individual-go": "Go",
  "individual-go-v1": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-pro-v1": "Pro",
  "individual-provider": "Provider",
  "individual-max": "Max",
  "individual-ultra": "Ultra",
  "teams-pro": "Teams Pro",
}

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>
}

export interface CommandCodeProbeInput {
  readonly settings: ProviderSettings
  readonly home?: string
  readonly env?: Record<string, string | undefined>
  readonly explicitPath?: string
  readonly openCodeIntegrationKey?: string
  readonly providerSettingsKey?: string
  readonly fetchImpl?: FetchLike
  readonly now?: () => number
  readonly timeoutMs?: number
}

export interface CommandCodeProbeResult {
  readonly snapshot: ProviderQuotaSnapshot
  readonly credentialSource?: string
  readonly triedSources: ReadonlyArray<string>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const numberValue = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/^\$/, "").replaceAll(",", "")
    if (!cleaned) return undefined
    const parsed = Number(cleaned)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

const timeValue = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value >= 1e12 ? value : value * 1000
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    if (/^\d+$/.test(trimmed)) return timeValue(Number(trimmed))
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

const recordAt = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined)

const parseWindow = (value: unknown): QuotaWindow | undefined => {
  if (!isRecord(value)) return undefined
  const used = numberValue(value.used)
  const cap = numberValue(value.cap)
  if (used === undefined || cap === undefined || cap <= 0) return undefined
  return {
    usedPct: pct(used, cap),
    remainingPct: clamp(100 - pct(used, cap), 0, 100),
    usedUsd: used,
    capUsd: cap,
    resetsAt: timeValue(value.resetAt),
    exceeded: value.exceeded === true || used >= cap,
    source: "provider",
  }
}

const unknownWindow: QuotaWindow = { usedPct: 0, remainingPct: 100, source: "unknown" }

interface FetchResult {
  status: number
  body?: unknown
  error?: string
  retryAfterMs?: number
}

const fetchJson = async (
  fetchImpl: FetchLike,
  path: string,
  key: string,
  timeoutMs: number,
): Promise<FetchResult> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${HOST}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      redirect: "error",
      signal: controller.signal,
    })
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"))
      return {
        status: response.status,
        error: `HTTP ${response.status}`,
        retryAfterMs: Number.isFinite(retryAfter)
          ? Math.min(Math.max(0, retryAfter * 1000), 15 * 60_000)
          : undefined,
      }
    }
    const text = await response.text()
    if (text.length > MAX_BODY_BYTES) return { status: response.status, error: "Response body too large" }
    try {
      return { status: response.status, body: JSON.parse(text) as unknown }
    } catch {
      return { status: response.status, error: "Invalid JSON response" }
    }
  } catch (error) {
    return {
      status: 0,
      error: controller.signal.aborted ? "Request timed out" : redact(error instanceof Error ? error.message : String(error)),
    }
  } finally {
    clearTimeout(timer)
  }
}

const parseWhoami = (body: unknown): { orgID?: string; userName?: string } | undefined => {
  if (!isRecord(body) || body.success === false) return undefined
  const user = body.user
  const org = body.org
  return {
    orgID: isRecord(org) && typeof org.id === "string" ? org.id : undefined,
    userName: isRecord(user) && typeof user.userName === "string" ? user.userName : undefined,
  }
}

const parseSubscription = (body: unknown): {
  planID?: string
  status?: string
  periodStart?: number
  periodEnd?: number
} => {
  const data = recordAt(body, "data")
  if (!isRecord(data)) return {}
  return {
    planID: typeof data.planId === "string" ? data.planId : undefined,
    status: typeof data.status === "string" ? data.status : undefined,
    periodStart: timeValue(data.currentPeriodStart),
    periodEnd: timeValue(data.currentPeriodEnd),
  }
}

const parseCredits = (body: unknown): {
  monthlyRemaining?: number
  purchased?: number
  free?: number
  fiveHour?: QuotaWindow
  weekly?: QuotaWindow
} => {
  const credits = recordAt(body, "credits")
  const windowLimits = recordAt(body, "windowLimits")
  return {
    monthlyRemaining: numberValue(recordAt(credits, "monthlyCredits")),
    purchased: numberValue(recordAt(credits, "purchasedCredits")),
    free: numberValue(recordAt(credits, "freeCredits")),
    fiveHour: parseWindow(recordAt(windowLimits, "fiveHour")),
    weekly: parseWindow(recordAt(windowLimits, "weekly")),
  }
}

const parseSummary = (body: unknown): { used?: number; periodStart?: number; basis?: string } => {
  if (!isRecord(body)) return {}
  return {
    used: numberValue(body.totalMonthlyCredits) ?? numberValue(body.totalCost),
    periodStart: timeValue(body.periodStart),
    basis: typeof body.periodBasis === "string" ? body.periodBasis : undefined,
  }
}

const orgPath = (path: string, orgID?: string) => (orgID ? `${path}?orgId=${encodeURIComponent(orgID)}` : path)

const summaryPath = (orgID: string | undefined, since: number | undefined) => {
  const params: string[] = []
  if (orgID) params.push(`orgId=${encodeURIComponent(orgID)}`)
  if (since) params.push(`since=${encodeURIComponent(new Date(since).toISOString())}`)
  return params.length > 0 ? `/alpha/usage/summary?${params.join("&")}` : "/alpha/usage/summary"
}

const baseSnapshot = (
  input: CommandCodeProbeInput,
  now: number,
  error?: string,
  retryAfterMs?: number,
): ProviderQuotaSnapshot => ({
  providerID: "commandcode",
  label: "Command Code",
  plan: input.settings.plan,
  source: "unknown",
  fetchedAt: now,
  stale: false,
  rolling: unknownWindow,
  weekly: unknownWindow,
  monthly: unknownWindow,
  models: {},
  notes: [],
  error,
  ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
})

const credentialCandidates = (input: CommandCodeProbeInput): CredentialCandidate[] => {
  const discovery = discoverCommandCodeCredentials({
    home: input.home,
    env: input.env,
    explicitPath: input.explicitPath ?? input.settings.credentialPath,
    openCodeIntegrationKey: input.openCodeIntegrationKey,
    providerSettingsKey: input.providerSettingsKey,
    ...(input.settings.credentialSource ? { credentialSource: input.settings.credentialSource } : {}),
  })
  return discovery.candidates.slice(0, 4)
}

/**
 * Read Command Code's account-level billing picture from the same read-only
 * alpha endpoints the official CLI uses. This function never mutates state and
 * never sends the key anywhere except https://api.commandcode.ai.
 */
export const probeCommandCodeQuota = async (input: CommandCodeProbeInput): Promise<CommandCodeProbeResult> => {
  const now = input.now?.() ?? Date.now()
  const fetchImpl = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? TIMEOUT_MS
  const candidates = credentialCandidates(input)
  const triedSources: string[] = []

  if (candidates.length === 0) {
    return {
      snapshot: baseSnapshot(input, now, "No Command Code credential was found that is authorized for billing"),
      triedSources,
    }
  }

  let identity: { orgID?: string; userName?: string } | undefined
  let authorized: CredentialCandidate | undefined
  let lastAuthError = ""

  for (const candidate of candidates) {
    triedSources.push(describeCredentialSource(candidate))
    const whoami = await fetchJson(fetchImpl, "/alpha/whoami?limits=1", candidate.key, timeoutMs)
    if (whoami.status === 200) {
      const parsed = parseWhoami(whoami.body)
      if (parsed) {
        identity = parsed
        authorized = candidate
        break
      }
      lastAuthError = "Unrecognized identity response"
      continue
    }
    if (whoami.status === 429) {
      return {
        snapshot: baseSnapshot(input, now, "Command Code billing API is rate limited", whoami.retryAfterMs),
        triedSources,
      }
    }
    lastAuthError = whoami.error ?? `HTTP ${whoami.status}`
  }

  if (!authorized) {
    return {
      snapshot: baseSnapshot(
        input,
        now,
        `No authorized Command Code billing credential found (${lastAuthError || "authentication failed"})`,
      ),
      triedSources,
    }
  }

  const orgID = identity?.orgID
  const [creditsResult, subscriptionResult] = await Promise.all([
    fetchJson(fetchImpl, orgPath("/alpha/billing/credits", orgID), authorized.key, timeoutMs),
    fetchJson(fetchImpl, orgPath("/alpha/billing/subscriptions", orgID), authorized.key, timeoutMs),
  ])

  if (creditsResult.status === 429 || subscriptionResult.status === 429) {
    return {
      snapshot: baseSnapshot(
        input,
        now,
        "Command Code billing API is rate limited",
        creditsResult.retryAfterMs ?? subscriptionResult.retryAfterMs,
      ),
      credentialSource: describeCredentialSource(authorized),
      triedSources,
    }
  }

  if (creditsResult.status === 401 || creditsResult.status === 403 || subscriptionResult.status === 401 || subscriptionResult.status === 403) {
    return {
      snapshot: baseSnapshot(input, now, "Command Code rejected the billing credential"),
      credentialSource: describeCredentialSource(authorized),
      triedSources,
    }
  }

  const credits = creditsResult.status === 200 ? parseCredits(creditsResult.body) : undefined
  const subscription = subscriptionResult.status === 200 ? parseSubscription(subscriptionResult.body) : undefined
  const periodStart = subscription?.periodStart
  const summaryResult = await fetchJson(fetchImpl, summaryPath(orgID, periodStart), authorized.key, timeoutMs)
  const summary = summaryResult.status === 200 ? parseSummary(summaryResult.body) : undefined

  const planID = subscription?.planID ?? input.settings.plan
  const monthlyRemaining = credits?.monthlyRemaining
  const summaryUsable =
    summary?.used !== undefined &&
    (summary.basis === "billing-period" ||
      (summary.periodStart !== undefined && periodStart !== undefined && summary.periodStart === periodStart))
  const summaryUsed = summaryUsable ? summary?.used : undefined
  // The usage summary and the credit balance are different accounting pools.
  // The remaining-credit balance is the authoritative included-credit figure:
  // when it is available, monthly usage is the stable plan grant minus that
  // balance. The summary is retained only as a diagnostic cross-check.
  const configuredGrant = input.settings.monthlyCreditsUsd && input.settings.monthlyCreditsUsd > 0
    ? input.settings.monthlyCreditsUsd
    : undefined
  // The provider's 5-hour and weekly caps are 20% and 50% of the monthly
  // grant. Prefer those provider-reported values so a plan change cannot
  // silently shift the derived percentage.
  const windowGrant =
    credits?.fiveHour?.capUsd !== undefined && credits.fiveHour.capUsd > 0
      ? credits.fiveHour.capUsd / 0.2
      : credits?.weekly?.capUsd !== undefined && credits.weekly.capUsd > 0
        ? credits.weekly.capUsd / 0.5
        : undefined
  const planGrant = windowGrant ?? PLAN_CREDITS[planID] ?? configuredGrant
  const monthlyGrant =
    planGrant ??
    (monthlyRemaining !== undefined && summaryUsed !== undefined ? monthlyRemaining + summaryUsed : undefined)
  const derivedUsed =
    monthlyRemaining !== undefined && monthlyGrant !== undefined
      ? Math.max(0, monthlyGrant - monthlyRemaining)
      : summaryUsed
  const monthlyPct = derivedUsed !== undefined && monthlyGrant && monthlyGrant > 0 ? pct(derivedUsed, monthlyGrant) : 0

  const monthly: QuotaWindow =
    monthlyRemaining !== undefined && monthlyGrant !== undefined
      ? {
          usedPct: monthlyPct,
          remainingPct: clamp(100 - monthlyPct, 0, 100),
          usedUsd: derivedUsed,
          capUsd: monthlyGrant,
          resetsAt: subscription?.periodEnd,
          exceeded: monthlyRemaining <= 0,
          source: "provider",
        }
      : unknownWindow

  const extra: ExtraCredits | undefined =
    credits?.purchased !== undefined || credits?.free !== undefined
      ? {
          purchasedUsd: credits?.purchased ?? 0,
          freeUsd: credits?.free ?? 0,
          totalUsd: (credits?.purchased ?? 0) + (credits?.free ?? 0),
        }
      : undefined

  const notes: string[] = [
    "Provider-reported from Command Code's read-only alpha billing endpoints; polling consumes no credits.",
  ]
  if (planGrant !== undefined) {
    const grantSource =
      windowGrant !== undefined
        ? "the provider's 5-hour/weekly window caps"
        : PLAN_CREDITS[planID] !== undefined
          ? "the plan registry"
          : "the configured monthly allowance"
    notes.push(
      `Monthly allowance is derived from ${grantSource}; provider-reported remaining credits are authoritative.`,
    )
  } else if (monthlyRemaining !== undefined && summaryUsed !== undefined) {
    notes.push("Monthly grant is the sum of remaining included credits and billing-period usage because no plan allowance was available.")
  }
  if (monthlyRemaining !== undefined && summaryUsed !== undefined && derivedUsed !== undefined) {
    const summaryDelta = summaryUsed - derivedUsed
    if (Math.abs(summaryDelta) >= 0.005) {
      notes.push(
        `Billing-period usage summary differs from the credit balance by $${summaryDelta.toFixed(4)}; remaining credits are authoritative.`,
      )
    }
  }
  if (summaryResult.status !== 200) notes.push(`Usage summary unavailable (${summaryResult.error ?? summaryResult.status}).`)
  if (creditsResult.status !== 200) notes.push(`Credit windows unavailable (${creditsResult.error ?? creditsResult.status}).`)
  notes.push(`Credential source: ${describeCredentialSource(authorized)}`)

  const planLabel = PLAN_NAMES[planID] ?? planID
  const error =
    creditsResult.status !== 200 && subscriptionResult.status !== 200 && summaryResult.status !== 200
      ? "Command Code billing endpoints returned no usable data"
      : undefined

  return {
    snapshot: {
      providerID: "commandcode",
      label: `Command Code ${planLabel}`,
      plan: planLabel,
      source: credits || subscription || summary ? "provider" : "unknown",
      fetchedAt: now,
      stale: false,
      rolling: credits?.fiveHour ?? unknownWindow,
      weekly: credits?.weekly ?? unknownWindow,
      monthly,
      monthlyGrantUsd: monthlyGrant,
      monthlyRemainingUsd: monthlyRemaining,
      extraCredits: extra,
      planStatus: subscription?.status,
      periodStart: subscription?.periodStart,
      periodEnd: subscription?.periodEnd,
      models: {},
      notes,
      error,
    },
    credentialSource: describeCredentialSource(authorized),
    triedSources,
  }
}

/** Exposed for tests. */
export const __commandCodeInternals = {
  numberValue,
  timeValue,
  parseWindow,
  parseWhoami,
  parseSubscription,
  parseCredits,
  parseSummary,
  summaryPath,
  orgPath,
}
