import type { ProviderQuotaSnapshot, ProviderSettings, QuotaWindow } from "../types.js"
import { clamp, describePlan, pct, redact } from "../util.js"
import { resolvePlan } from "../plans/catalog.js"

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const USER_AGENT = "opencode-smart-router/0.1"
const MAX_BODY_BYTES = 256_000

export interface GoUsageProbeInput {
  readonly accessToken: string
  readonly settings: ProviderSettings
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  readonly now?: () => number
  readonly timeoutMs?: number
}

export interface GoUsageProbeResult {
  readonly snapshot: ProviderQuotaSnapshot
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const timeValue = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const parseMeter = (value: unknown): QuotaWindow | undefined => {
  if (!isRecord(value)) return undefined
  const percentValue = value.percent
  if (typeof percentValue !== "number" || !Number.isFinite(percentValue)) return undefined
  const usedPct = clamp(percentValue, 0, 100)
  return {
    usedPct,
    remainingPct: clamp(100 - usedPct, 0, 100),
    resetsAt: timeValue(value.resetsAt),
    exceeded: usedPct >= 100,
    source: "provider",
  }
}

const unknownWindow: QuotaWindow = { usedPct: 0, remainingPct: 100, source: "unknown" }

const baseSnapshot = (
  input: GoUsageProbeInput,
  now: number,
  error?: string,
  retryAfterMs?: number,
): ProviderQuotaSnapshot => ({
  providerID: "opencode-go",
  label: input.settings.plan === "go-plus" ? "OpenCode Go Plus" : "OpenCode Go",
  plan: describePlan(resolvePlan("opencode-go", input.settings.plan)?.planID, input.settings.plan),
  source: "unknown",
  fetchedAt: now,
  stale: false,
  rolling: unknownWindow,
  weekly: unknownWindow,
  monthly: unknownWindow,
  models: {},
  notes: ["Usage endpoint is read-only and consumes no inference allowance."],
  error,
  ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
})

/**
 * Read OpenCode Go's provider-reported rolling, weekly, and monthly meters.
 * The endpoint accepts the OAuth access token from OpenCode's Go connection.
 * It is a best-effort integration, not part of the public inference schema.
 */
export const probeOpenCodeGoQuota = async (input: GoUsageProbeInput): Promise<GoUsageProbeResult> => {
  const now = input.now?.() ?? Date.now()
  const fetchImpl = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? 8_000
  if (!input.accessToken) {
    return { snapshot: baseSnapshot(input, now, "No OpenCode Go access token is available") }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      redirect: "error",
      signal: controller.signal,
    })
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"))
      const retryAfterMs =
        Number.isFinite(retryAfter) && retryAfter >= 0
          ? Math.min(retryAfter * 1000, 15 * 60_000)
          : undefined
      return {
        snapshot: baseSnapshot(input, now, `Usage endpoint returned HTTP ${response.status}`, retryAfterMs),
      }
    }
    const text = await response.text()
    if (text.length > MAX_BODY_BYTES) {
      return { snapshot: baseSnapshot(input, now, "Usage response was unexpectedly large") }
    }
    const body = JSON.parse(text) as unknown
    const usage = isRecord(body) ? body.usage : undefined
    if (!isRecord(usage)) {
      return { snapshot: baseSnapshot(input, now, "Unrecognized usage response") }
    }
    const rolling = parseMeter(usage.rolling)
    const weekly = parseMeter(usage.weekly)
    const monthly = parseMeter(usage.monthly)
    if (!rolling && !weekly && !monthly) {
      return { snapshot: baseSnapshot(input, now, "Usage response contained no recognized meters") }
    }

    const notes = ["Provider-reported OpenCode Go usage.", "Read-only probe; no inference request is made."]
    const snapshot: ProviderQuotaSnapshot = {
      providerID: "opencode-go",
      label: input.settings.plan === "go-plus" ? "OpenCode Go Plus" : "OpenCode Go",
      plan: describePlan(resolvePlan("opencode-go", input.settings.plan)?.planID, input.settings.plan),
      source: "provider",
      fetchedAt: now,
      stale: false,
      rolling: rolling ?? unknownWindow,
      weekly: weekly ?? unknownWindow,
      monthly: monthly ?? unknownWindow,
      models: {},
      notes,
    }
    return { snapshot }
  } catch (error) {
    return {
      snapshot: baseSnapshot(
        input,
        now,
        controller.signal.aborted ? "Usage request timed out" : redact(error instanceof Error ? error.message : String(error)),
      ),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Exposed for tests. */
export const __goInternals = { parseMeter, timeValue, pct }
