import type { ProviderQuotaSnapshot, ProviderSettings, QuotaWindow } from "../types.js"
import { probeCommandCodeQuota, type FetchLike } from "./commandcode.js"
import { probeOpenCodeGoQuota } from "./opencode-go.js"

export interface QuotaCredentials {
  readonly goAccessToken?: string
  readonly commandCodeIntegrationKey?: string
  readonly commandCodeProviderKey?: string
}

export interface QuotaServiceOptions {
  readonly getSettings: () => {
    readonly "opencode-go": ProviderSettings
    readonly commandcode: ProviderSettings
  }
  readonly getCredentials: () => Promise<QuotaCredentials>
  readonly probeIntervalMinutes: number
  readonly fetchImpl?: FetchLike
  readonly now?: () => number
  readonly onSnapshot?: (snapshot: ProviderQuotaSnapshot) => void
  readonly initial?: ReadonlyArray<ProviderQuotaSnapshot>
}

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
})

const withStale = (snapshot: ProviderQuotaSnapshot, now: number, intervalMs: number): ProviderQuotaSnapshot => ({
  ...snapshot,
  stale: now - snapshot.fetchedAt > Math.max(intervalMs * 2, 60_000),
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
    for (const providerID of ["opencode-go", "commandcode"] as const) {
      if (!settings[providerID].enabled || !settings[providerID].probeUsage) continue
      const state = this.state[providerID]
      if (!state) continue
      if ((!state.snapshot || now - state.lastAttempt > interval) && now >= state.nextAllowed && !state.inFlight) {
        void this.refresh(providerID).catch(() => undefined)
      }
    }
    return this.getCached()
  }

  async refresh(providerID: "opencode-go" | "commandcode", force = false): Promise<ProviderQuotaSnapshot> {
    const settings = this.options.getSettings()[providerID]
    const state = this.state[providerID]
    if (!state) {
      return unknownSnapshot(providerID, providerID, settings.plan, this.now(), "Unknown provider")
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

  private async probe(providerID: "opencode-go" | "commandcode", settings: ProviderSettings) {
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
    if (settings["opencode-go"].enabled && settings["opencode-go"].probeUsage) tasks.push(this.refresh("opencode-go", true))
    if (settings.commandcode.enabled && settings.commandcode.probeUsage) tasks.push(this.refresh("commandcode", true))
    if (tasks.length === 0) return this.getCached()
    await Promise.allSettled(tasks)
    return this.getCached()
  }
}

export const __quotaInternals = { backoffFor, withStale }
