import type { ProviderQuotaSnapshot, ProviderSettings, QuotaWindow, UsageEvent } from "../types.js"
import { probeCommandCodeQuota, type FetchLike } from "./commandcode.js"
import { probeOpenCodeGoQuota } from "./opencode-go.js"
import { probeOpenDesignQuota, OPENDESIGN_MONTH_MS } from "./opendesign.js"

export interface QuotaCredentials {
  readonly goAccessToken?: string
  readonly commandCodeIntegrationKey?: string
  readonly commandCodeProviderKey?: string
  /** OpenDesign inference key. It cannot read quota. */
  readonly openDesignApiKey?: string
  /** OpenDesign account-control key. Only used when explicitly configured. */
  readonly openDesignControlKey?: string
}

export interface QuotaServiceOptions {
  readonly getSettings: () => Readonly<Record<string, ProviderSettings>>
  readonly getCredentials: () => Promise<QuotaCredentials>
  readonly probeIntervalMinutes: number
  readonly fetchImpl?: FetchLike
  readonly now?: () => number
  readonly onSnapshot?: (snapshot: ProviderQuotaSnapshot) => void
  readonly initial?: ReadonlyArray<ProviderQuotaSnapshot>
  /**
   * Local usage events, used by providers whose quota must be modelled.
   *
   * The argument is the window the probe needs, not a hint. A provider that
   * models a 30-day allowance cannot be handed fewer than 30 days of history:
   * history that has aged out of the raw event array has been folded into
   * hourly buckets, and a caller that ignores the window returns the raw array
   * alone and under-reports spend exactly when the account is busiest.
   */
  readonly getUsageEvents?: (window?: { since: number; until?: number }) => ReadonlyArray<UsageEvent>
}

/** Providers the router can probe. Order does not imply preference. */
export const QUOTA_PROVIDER_IDS = ["opencode-go", "commandcode", "opendesign"] as const

export type QuotaProviderID = (typeof QUOTA_PROVIDER_IDS)[number]

interface ProviderState {
  snapshot?: ProviderQuotaSnapshot
  lastAttempt: number
  nextAllowed: number
  failures: number
  inFlight?: Promise<ProviderQuotaSnapshot>
}

const unknownWindow: QuotaWindow = { usedPct: 0, remainingPct: 100, source: "unknown" }

const unknownSnapshot = (
  providerID: string,
  label: string,
  plan: string,
  now: number,
  error: string,
): ProviderQuotaSnapshot => ({
  providerID,
  label,
  plan,
  source: "unknown",
  fetchedAt: now,
  stale: false,
  rolling: unknownWindow,
  weekly: unknownWindow,
  monthly: unknownWindow,
  models: {},
  notes: [],
  error,
  quotaState: "unknown",
})

const withStale = (snapshot: ProviderQuotaSnapshot, now: number, intervalMs: number): ProviderQuotaSnapshot => ({
  ...snapshot,
  stale: now - snapshot.fetchedAt > Math.max(intervalMs * 2, 60_000),
  ...(snapshot.quotaState && snapshot.quotaState !== "unknown" && snapshot.quotaState !== "unavailable"
    ? { quotaState: now - snapshot.fetchedAt > Math.max(intervalMs * 2, 60_000) ? ("stale" as const) : snapshot.quotaState }
    : {}),
})

const backoffFor = (failures: number) => {
  const steps = [30_000, 2 * 60_000, 5 * 60_000, 15 * 60_000]
  return steps[Math.min(Math.max(failures, 1) - 1, steps.length - 1)] ?? 15 * 60_000
}

/**
 * Caches provider-reported quota, probes on a conservative interval, and backs
 * off independently per provider. Snapshots are read-only and contain no
 * credentials.
 */
export class QuotaService {
  private readonly options: QuotaServiceOptions
  private readonly state: Record<string, ProviderState> = {
    "opencode-go": { lastAttempt: 0, nextAllowed: 0, failures: 0 },
    commandcode: { lastAttempt: 0, nextAllowed: 0, failures: 0 },
    opendesign: { lastAttempt: 0, nextAllowed: 0, failures: 0 },
  }

  constructor(options: QuotaServiceOptions) {
    this.options = options
    const now = options.now?.() ?? Date.now()
    for (const snapshot of options.initial ?? []) {
      const state = this.state[snapshot.providerID]
      if (!state) continue
      state.snapshot = { ...snapshot, stale: true }
      state.lastAttempt = snapshot.fetchedAt
    }
    void now
  }

  private intervalMs() {
    return Math.max(1, this.options.probeIntervalMinutes) * 60_000
  }

  private now() {
    return this.options.now?.() ?? Date.now()
  }

  getCached(): ProviderQuotaSnapshot[] {
    const now = this.now()
    const interval = this.intervalMs()
    return Object.values(this.state)
      .map((state) => state.snapshot)
      .filter((snapshot): snapshot is ProviderQuotaSnapshot => Boolean(snapshot))
      .map((snapshot) => withStale(snapshot, now, interval))
  }

  /**
   * Return the freshest available snapshots without making a prompt wait on a
   * slow provider. Stale data is refreshed in the background.
   */
  read(): ProviderQuotaSnapshot[] {
    const now = this.now()
    const interval = this.intervalMs()
    const settings = this.options.getSettings()
    for (const providerID of QUOTA_PROVIDER_IDS) {
      const providerSettings = settings[providerID]
      if (!providerSettings?.enabled || !providerSettings.probeUsage) continue
      const state = this.state[providerID]
      if (!state) continue
      if ((!state.snapshot || now - state.lastAttempt > interval) && now >= state.nextAllowed && !state.inFlight) {
        void this.refresh(providerID).catch(() => undefined)
      }
    }
    return this.getCached()
  }

  /**
   * Drop every cached snapshot.
   *
   * Called when settings change underneath the service — a pasted baseline is the
   * case that matters. The cache holds snapshots computed from the *previous*
   * settings, and a stale one is served with `stale: true` while a fresh probe is
   * still pending. Without this the panel can show a percentage that predates the
   * reading it was given, which reads as "my paste did nothing" even though it was
   * applied.
   */
  invalidate(): void {
    for (const state of Object.values(this.state)) {
      state.snapshot = undefined
      state.lastAttempt = 0
      state.nextAllowed = 0
    }
  }

  async refresh(providerID: QuotaProviderID | string, force = false): Promise<ProviderQuotaSnapshot> {
    const settings = this.options.getSettings()[providerID]
    const state = this.state[providerID]
    if (!settings || !state) {
      return unknownSnapshot(providerID, providerID, settings?.plan ?? "unknown", this.now(), "Unknown provider")
    }
    if (!settings.enabled || !settings.probeUsage) {
      return (
        state.snapshot ??
        unknownSnapshot(providerID, providerID, settings.plan, this.now(), "Quota probing is disabled for this provider")
      )
    }
    if (state.inFlight) return state.inFlight
    const now = this.now()
    if (!force && now < state.nextAllowed) {
      return state.snapshot ?? unknownSnapshot(providerID, providerID, settings.plan, now, "Quota probe is cooling down")
    }

    state.lastAttempt = now
    const task = this.probe(providerID, settings)
      .then((snapshot) => {
        state.snapshot = snapshot
        state.failures = snapshot.error ? state.failures + 1 : 0
        const retryAfter = snapshot.retryAfterMs === undefined
          ? undefined
          : Math.min(Math.max(0, snapshot.retryAfterMs), 15 * 60_000)
        state.nextAllowed = snapshot.error
          ? this.now() + (retryAfter ?? backoffFor(state.failures))
          : 0
        this.options.onSnapshot?.(snapshot)
        return snapshot
      })
      .catch((error) => {
        state.failures += 1
        state.nextAllowed = this.now() + backoffFor(state.failures)
        const snapshot = unknownSnapshot(
          providerID,
          providerID,
          settings.plan,
          this.now(),
          error instanceof Error ? error.message : String(error),
        )
        state.snapshot = snapshot
        this.options.onSnapshot?.(snapshot)
        return snapshot
      })
      .finally(() => {
        state.inFlight = undefined
      })

    state.inFlight = task
    return task
  }

  private async probe(providerID: string, settings: ProviderSettings) {
    const credentials = await this.options.getCredentials()
    if (providerID === "opencode-go") {
      const result = await probeOpenCodeGoQuota({
        accessToken: credentials.goAccessToken ?? "",
        settings,
        fetchImpl: this.options.fetchImpl,
        now: this.options.now,
      })
      return result.snapshot
    }
    if (providerID === "opendesign") {
      // Ask for the widest window the model uses. Without it the estimator
      // receives only the raw event array, and every hour of history that has
      // been folded into a bucket stops counting.
      const now = this.options.now?.() ?? Date.now()
      const result = await probeOpenDesignQuota({
        settings,
        apiKey: credentials.openDesignApiKey,
        controlKey: credentials.openDesignControlKey,
        usage: this.options.getUsageEvents?.({ since: now - OPENDESIGN_MONTH_MS, until: now }) ?? [],
        fetchImpl: this.options.fetchImpl,
        now: this.options.now,
        ...(settings.controlBaseURL ? { controlBaseURL: settings.controlBaseURL } : {}),
        ...(settings.creditsPerUsd !== undefined ? { creditsPerUsd: settings.creditsPerUsd } : {}),
        ...(settings.uncertaintyMarginPct !== undefined ? { uncertaintyMarginPct: settings.uncertaintyMarginPct } : {}),
        ...(settings.multiplierOverrides ? { multiplierOverrides: settings.multiplierOverrides } : {}),
      })
      return { ...result.snapshot, quotaState: result.state }
    }
    const result = await probeCommandCodeQuota({
      settings,
      openCodeIntegrationKey: credentials.commandCodeIntegrationKey,
      providerSettingsKey: credentials.commandCodeProviderKey,
      fetchImpl: this.options.fetchImpl,
      now: this.options.now,
    })
    return result.snapshot
  }

  async initialize(): Promise<ProviderQuotaSnapshot[]> {
    const settings = this.options.getSettings()
    const tasks: Array<Promise<ProviderQuotaSnapshot>> = []
    for (const providerID of QUOTA_PROVIDER_IDS) {
      const providerSettings = settings[providerID]
      if (providerSettings?.enabled && providerSettings.probeUsage) tasks.push(this.refresh(providerID, true))
    }
    if (tasks.length === 0) return this.getCached()
    await Promise.allSettled(tasks)
    return this.getCached()
  }
}

export const __quotaInternals = { backoffFor, withStale }
