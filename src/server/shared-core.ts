import type { LiveModel } from "../core/models/registry.js"
import { LedgerStore } from "../core/quota/ledger.js"
import { QuotaService } from "../core/quota/service.js"
import { discoverOpenDesignModels, toLiveModels } from "../core/providers/opendesign.js"
import type { ProviderQuotaSnapshot, RouterSettings, UsageEvent } from "../core/types.js"
import { safeError } from "../core/util.js"

/**
 * One shared core per OpenCode server process. The SDK probe confirmed that
 * globalThis is shared across every project-location plugin instance in one
 * server process. Commands/RPC remain location-scoped, so each location gets a
 * light bridge that calls this core.
 */
export interface RuntimeOverrides {
  mode?: RouterSettings["mode"]
  paused?: boolean
  dryRun?: boolean
  premiumBudgetUsd?: number
  reserves?: Record<string, { monthlyPct?: number; weeklyPct?: number; fiveHourPct?: number }>
  excluded?: string[]
  approved?: string[]
  titleIndicator?: boolean
  compactMode?: boolean
  compact?: boolean
}

export interface CoreDiagnostics {
  coreID: string
  pid: number
  createdAt: number
  uptimeMs: number
  bridges: Array<{ id: string; directory: string; createdAt: number }>
  bridgeCount: number
  setups: number
  disposes: number
  ledgerEvents: number
  decisions: number
  sessions: number
  quotaSnapshots: number
  quotaRefreshes: number
  ledgerWrites: number
  quotaWrites: number
  lastLedgerWriteAt?: number
  lastQuotaWriteAt?: number
  quotaInitialized: boolean
  bootstrapped: boolean
  eventsHandled: number
  eventsIgnored: number
  eventStreams: number
  errors: string[]
}

export interface InitInput {
  readonly ctx: any
  readonly getSettings: () => RouterSettings
  readonly getCredentials: () => Promise<{
    goAccessToken?: string
    commandCodeIntegrationKey?: string
    commandCodeProviderKey?: string
    openDesignApiKey?: string
    openDesignControlKey?: string
  }>
}

const KEY = Symbol.for("opencode-smart-router.shared-core.v1")
const BRIDGE_GRACE_MS = 10_000
const MODEL_TTL_MS = 5 * 60_000
const UNOWNED_TTL_MS = 30_000
const UNOWNED_MAX = 2_000
const STORAGE_LEDGER = "ledger-v1"
const STORAGE_RUNTIME = "runtime-v1"
const STORAGE_QUOTA = "quota-cache-v1"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const safe = <T>(value: T): any => JSON.parse(JSON.stringify(value))

class SharedCore {
  readonly coreID = Math.random().toString(36).slice(2, 10)
  readonly pid = process.pid
  readonly createdAt = Date.now()
  ledger = new LedgerStore()
  runtime: RuntimeOverrides = {}
  quota?: QuotaService
  private readonly bridges = new Map<string, { id: string; directory: string; createdAt: number; controller?: any }>()
  private eventAbort?: AbortController
  private eventsStarted = false
  private readonly owners = new Map<string, string>()
  private readonly unowned = new Map<string, number>()
  private liveModels: LiveModel[] = []
  private modelsLoadedAt = 0
  private modelsLoading?: Promise<LiveModel[]>
  private openDesignModels: LiveModel[] = []
  private openDesignLoadedAt = 0
  private openDesignLoading?: Promise<LiveModel[]>
  private eventsHandled = 0
  private eventsIgnored = 0
  private ownerCtx?: any
  private getSettings?: () => RouterSettings
  private getCredentials?: InitInput["getCredentials"]
  private ready?: Promise<void>
  private loading?: Promise<void>
  private disposing?: Promise<void>
  private quotaInitial: ProviderQuotaSnapshot[] = []
  private ledgerTimer?: ReturnType<typeof setTimeout>
  private quotaTimer?: ReturnType<typeof setTimeout>
  private runtimeTimer?: ReturnType<typeof setTimeout>
  private bootstrapTimer?: ReturnType<typeof setTimeout>
  private quotaStartTimer?: ReturnType<typeof setTimeout>
  private shutdownTimer?: ReturnType<typeof setTimeout>
  private started = false
  private quotaInitialized = false
  private bootstrapped = false
  private ledgerWrites = 0
  private quotaWrites = 0
  private quotaRefreshes = 0
  private lastLedgerWriteAt?: number
  private lastQuotaWriteAt?: number
  private readonly errors: string[] = []
  private pushError(message: string) {
    this.errors.push(message)
    if (this.errors.length > 50) this.errors.splice(0, this.errors.length - 50)
  }
  private sequence = 0
  private setups = 0
  private disposes = 0

  async init(input: InitInput): Promise<void> {
    this.setups += 1
    if (this.disposing) await this.disposing
    if (this.ready && this.ownerCtx && this.started) return this.ready
    // Several locations can initialize in the same tick when a server restores
    // its session list. Share one load; a second load would replace the ledger
    // and quota service under a bridge that already captured the first ones.
    if (this.loading) return this.loading
    this.ownerCtx = input.ctx
    this.getSettings = input.getSettings
    this.getCredentials = input.getCredentials
    this.loading = this.load().finally(() => {
      this.loading = undefined
    })
    this.ready = this.loading
    return this.loading
  }

  private async load() {
    try {
      const [savedLedger, savedRuntime, savedQuota] = await Promise.all([
        this.ownerCtx.storage.get(STORAGE_LEDGER).catch(() => undefined),
        this.ownerCtx.storage.get(STORAGE_RUNTIME).catch(() => undefined),
        this.ownerCtx.storage.get(STORAGE_QUOTA).catch(() => undefined),
      ])
      if (isRecord(savedRuntime)) this.runtime = savedRuntime as RuntimeOverrides
      const hydrated = LedgerStore.hydrate(savedLedger)
      this.ledger = new LedgerStore(hydrated.ledger)
      for (const warning of hydrated.warnings.slice(0, 5)) this.pushError(warning)
      this.quotaInitial = Array.isArray(savedQuota) ? (savedQuota as ProviderQuotaSnapshot[]) : []
      this.quota = new QuotaService({
        getSettings: () => (this.getSettings?.().providers ?? {}) as any,
        getCredentials: () => this.getCredentials?.() ?? Promise.resolve({}),
        getUsageEvents: (window) => this.ledger.usageEvents(window),
        probeIntervalMinutes: this.getSettings?.().quota.probeIntervalMinutes ?? 5,
        initial: this.quotaInitial,
        onSnapshot: (snapshot) => {
          this.quotaRefreshes += 1
          this.persistQuotaSoon()
        },
      })
      this.started = true
      // Never touch the network or enumerate sessions on the plugin-load path.
      this.bootstrapTimer = setTimeout(() => {
        void this.bootstrap()
      }, 1_000)
      this.quotaStartTimer = setTimeout(() => {
        void this.startQuota()
      }, 1_500)
    } catch (error) {
      this.pushError(safeError(error))
    }
    if (!this.quota) {
      this.quota = new QuotaService({
        getSettings: () => (this.getSettings?.().providers ?? {}) as any,
        getCredentials: () => this.getCredentials?.() ?? Promise.resolve({}),
        getUsageEvents: (window) => this.ledger.usageEvents(window),
        probeIntervalMinutes: this.getSettings?.().quota.probeIntervalMinutes ?? 5,
        initial: this.quotaInitial,
        onSnapshot: () => {
          this.quotaRefreshes += 1
          this.persistQuotaSoon()
        },
      })
    }
    if (!this.started) {
      this.started = true
      this.bootstrapTimer = setTimeout(() => {
        void this.bootstrap()
      }, 1_000)
      this.quotaStartTimer = setTimeout(() => {
        void this.startQuota()
      }, 1_500)
    }
  }

  private async bootstrap() {
    if (this.bootstrapped) return
    this.bootstrapped = true
    try {
      const settings = this.getSettings?.()
      if (!settings) return
      const limit = settings.quota.bootstrapSessions
      if (limit <= 0) return
      const result = await this.ownerCtx.session.list({ limit })
      const sessions = Array.isArray(result) ? result : (result?.data ?? [])
      const rows = sessions.map((session: any) => ({
        id: String(session.id),
        title: typeof session.title === "string" ? session.title : undefined,
        model: session.model
          ? { providerID: session.model.providerID, id: session.model.id, ...(session.model.variant ? { variant: session.model.variant } : {}) }
          : undefined,
        cost: typeof session.cost === "number" ? session.cost : 0,
        tokens: session.tokens
          ? {
              input: Number(session.tokens.input) || 0,
              output: Number(session.tokens.output) || 0,
              cache: {
                read: Number(session.tokens.cache?.read) || 0,
                write: Number(session.tokens.cache?.write) || 0,
              },
            }
          : undefined,
        updatedAt: typeof session.time?.updated === "number" ? session.time.updated : Date.now(),
      }))
      this.ledger.bootstrap(rows, {
        days: settings.quota.bootstrapDays,
        limit: settings.quota.bootstrapSessions,
      })
      this.persistSoon()
    } catch (error) {
      this.pushError(`bootstrap: ${safeError(error)}`)
    }
  }

  private async startQuota() {
    if (this.quotaInitialized || !this.quota) return
    this.quotaInitialized = true
    try {
      await this.quota.initialize()
    } catch (error) {
      this.pushError(`quota: ${safeError(error)}`)
    }
  }

  claimSession(sessionID: string, bridgeID: string) {
    if (!bridgeID) return
    this.unowned.delete(sessionID)
    if (!this.owners.has(sessionID) && this.owners.size >= 2_000) {
      const oldest = this.owners.keys().next().value
      if (oldest) this.owners.delete(oldest)
    }
    this.owners.set(sessionID, bridgeID)
  }

  releaseSession(sessionID: string) {
    this.owners.delete(sessionID)
    this.unowned.delete(sessionID)
  }

  recordError(message: string) {
    this.pushError(message)
  }

  private noteUnowned(sessionID: string) {
    if (this.unowned.size >= UNOWNED_MAX) {
      const oldest = this.unowned.keys().next().value
      if (oldest) this.unowned.delete(oldest)
    }
    this.unowned.set(sessionID, Date.now())
  }

  /** One catalog fetch per process; bridges rebuild their own registries from it. */
  async getLiveModels(force = false): Promise<LiveModel[]> {
    const fresh = this.modelsLoadedAt > 0 && Date.now() - this.modelsLoadedAt < MODEL_TTL_MS
    if ((!fresh || force) && !this.modelsLoading && this.ownerCtx?.model?.list) {
      this.modelsLoading = Promise.resolve(this.ownerCtx.model.list())
        .then((result: any) => {
          const data = Array.isArray(result) ? result : (result?.data ?? [])
          this.liveModels = Array.isArray(data) ? (data as LiveModel[]) : []
          this.modelsLoadedAt = Date.now()
          return this.liveModels
        })
        .catch((error) => {
          this.pushError(`models: ${safeError(error)}`)
          return this.liveModels
        })
        .finally(() => {
          this.modelsLoading = undefined
        })
      await this.modelsLoading
    }
    // OpenDesign models come from the provider's own gateway rather than from
    // OpenCode's catalog, so they are merged in here. The merge is one
    // shared, single-flight discovery per process.
    const openDesign = await this.getOpenDesignModels(force)
    return openDesign.length > 0 ? [...this.liveModels, ...openDesign] : this.liveModels
  }

  /**
   * Read the OpenDesign gateway's entitled model list.
   *
   * This is a read-only metadata call. It makes no inference request and
   * consumes no plan credits. It runs at most once per catalog TTL per
   * process, no matter how many project bridges are open.
   */
  async getOpenDesignModels(force = false): Promise<LiveModel[]> {
    const settings = this.getSettings?.()
    const provider = settings?.providers?.opendesign
    if (!provider?.enabled) {
      this.openDesignModels = []
      this.openDesignLoadedAt = Date.now()
      return []
    }
    const fresh = this.openDesignLoadedAt > 0 && Date.now() - this.openDesignLoadedAt < MODEL_TTL_MS
    if (!force && fresh) return this.openDesignModels
    if (this.openDesignLoading) return this.openDesignLoading
    this.openDesignLoading = (async () => {
      try {
        const credentials = (await this.getCredentials?.()) ?? {}
        if (!credentials.openDesignApiKey) {
          this.openDesignModels = []
          this.openDesignLoadedAt = Date.now()
          return []
        }
        const result = await discoverOpenDesignModels({
          apiKey: credentials.openDesignApiKey,
          ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
        })
        if (!result.ok) {
          this.pushError(`opendesign discovery: ${result.error ?? "unknown error"}`)
          // Keep the last good catalog rather than dropping every OpenDesign
          // route because one read-only probe failed.
          this.openDesignLoadedAt = Date.now()
          return this.openDesignModels
        }
        this.openDesignModels = toLiveModels(result.models) as LiveModel[]
        this.openDesignLoadedAt = Date.now()
        return this.openDesignModels
      } catch (error) {
        this.pushError(`opendesign discovery: ${safeError(error)}`)
        return this.openDesignModels
      } finally {
        this.openDesignLoading = undefined
      }
    })()
    return this.openDesignLoading
  }

  /** Local usage events, used by providers whose quota must be modelled locally. */
  usageEvents(window?: { since: number; until?: number }): ReadonlyArray<UsageEvent> {
    return this.ledger.usageEvents(window)
  }

  ownerOf(sessionID: string): string | undefined {
    return this.owners.get(sessionID)
  }

  noteEvent(handled: boolean) {
    if (handled) this.eventsHandled += 1
    else this.eventsIgnored += 1
  }

  addBridge(directory: string, controller?: any): string {
    // A newly loaded location may own sessions previously seen without an owner.
    this.unowned.clear()
    const id = `bridge-${this.pid}-${++this.sequence}`
    this.bridges.set(id, { id, directory, createdAt: Date.now(), controller })
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer)
      this.shutdownTimer = undefined
    }
    this.startEvents()
    return id
  }

  private startEvents() {
    if (this.eventsStarted || !this.ownerCtx?.event) return
    this.eventsStarted = true
    const abort = new AbortController()
    this.eventAbort = abort
    void (async () => {
      try {
        for await (const event of this.ownerCtx.event.subscribe({ signal: abort.signal })) {
          await this.dispatchEvent(event)
        }
      } catch (error) {
        if (!abort.signal.aborted) this.pushError(`events: ${safeError(error)}`)
      } finally {
        if (this.eventAbort === abort) {
          this.eventAbort = undefined
          this.eventsStarted = false
        }
      }
    })()
  }

  private async dispatchEvent(event: any) {
    const data = event?.data ?? {}
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    let target: any
    let targetID: string | undefined
    if (sessionID) {
      targetID = this.owners.get(sessionID)
      if (targetID) target = this.bridges.get(targetID)?.controller
      if (!target && event.type === "session.created" && typeof data.projectID === "string") {
        for (const bridge of this.bridges.values()) {
          if (bridge.controller?.projectMatches?.(data.projectID, data.location?.directory)) {
            target = bridge.controller
            targetID = bridge.id
            break
          }
        }
        if (targetID) this.claimSession(sessionID, targetID)
      }
      if (!target && this.ownerCtx?.session) {
        const seen = this.unowned.get(sessionID)
        if (seen !== undefined && Date.now() - seen < UNOWNED_TTL_MS) {
          this.noteEvent(false)
          return
        }
        try {
          const info = await this.ownerCtx.session.get({ sessionID })
          if (info?.projectID) {
            for (const bridge of this.bridges.values()) {
              if (bridge.controller?.projectMatches?.(info.projectID, info.location?.directory)) {
                target = bridge.controller
                targetID = bridge.id
                this.claimSession(sessionID, bridge.id)
                break
              }
            }
          }
        } catch {
          // Leave unowned events ignored rather than crossing projects.
        }
        if (!target) this.noteUnowned(sessionID)
      }
    }
    if (!target) {
      this.noteEvent(false)
      return
    }
    await target.handleEvent(event)
  }

  removeBridge(id: string) {
    this.bridges.delete(id)
    this.disposes += 1
    if (this.bridges.size === 0 && this.started) {
      this.shutdownTimer = setTimeout(() => {
        if (this.bridges.size === 0) void this.dispose()
      }, BRIDGE_GRACE_MS)
    }
  }

  persistSoon() {
    if (this.ledgerTimer) return
    this.ledgerTimer = setTimeout(() => {
      this.ledgerTimer = undefined
      void this.persistNow()
    }, 750)
  }

  async persistNow() {
    if (!this.ownerCtx?.storage) return
    try {
      const snapshot = safe(this.ledger.export())
      this.ledger.markClean()
      await this.ownerCtx.storage.set(STORAGE_LEDGER, snapshot)
      this.ledgerWrites += 1
      this.lastLedgerWriteAt = Date.now()
      if (this.ledger.dirtyFlag) this.persistSoon()
    } catch (error) {
      this.pushError(`persistLedger: ${safeError(error)}`)
    }
  }

  persistRuntimeSoon() {
    if (this.runtimeTimer) return
    this.runtimeTimer = setTimeout(() => {
      this.runtimeTimer = undefined
      void this.persistRuntimeNow()
    }, 250)
  }

  async persistRuntimeNow() {
    if (!this.ownerCtx?.storage) return
    try {
      await this.ownerCtx.storage.set(STORAGE_RUNTIME, safe(this.runtime))
    } catch (error) {
      this.pushError(`persistRuntime: ${safeError(error)}`)
    }
  }

  persistQuotaSoon() {
    if (this.quotaTimer) return
    this.quotaTimer = setTimeout(() => {
      this.quotaTimer = undefined
      void this.persistQuotaNow()
    }, 1_000)
  }

  async persistQuotaNow() {
    if (!this.ownerCtx?.storage || !this.quota) return
    try {
      await this.ownerCtx.storage.set(STORAGE_QUOTA, safe(this.quota.read()))
      this.quotaWrites += 1
      this.lastQuotaWriteAt = Date.now()
    } catch (error) {
      this.pushError(`persistQuota: ${safeError(error)}`)
    }
  }

  async resetLedger() {
    this.ledger.reset()
    this.bootstrapped = false
    this.persistSoon()
  }

  /** Test-only: clear in-process state between isolated test cases. */
  resetForTests() {
    this.eventAbort?.abort()
    this.eventAbort = undefined
    this.eventsStarted = false
    clearTimeout(this.ledgerTimer)
    clearTimeout(this.quotaTimer)
    clearTimeout(this.runtimeTimer)
    clearTimeout(this.bootstrapTimer)
    clearTimeout(this.quotaStartTimer)
    clearTimeout(this.shutdownTimer)
    this.ledgerTimer = undefined
    this.quotaTimer = undefined
    this.runtimeTimer = undefined
    this.bootstrapTimer = undefined
    this.quotaStartTimer = undefined
    this.shutdownTimer = undefined
    this.ledger = new LedgerStore()
    this.runtime = {}
    this.quota = undefined
    this.ownerCtx = undefined
    this.ready = undefined
    this.loading = undefined
    this.disposing = undefined
    this.started = false
    this.quotaInitialized = false
    this.bootstrapped = false
    this.bridges.clear()
    this.owners.clear()
    this.unowned.clear()
    this.liveModels = []
    this.modelsLoadedAt = 0
    this.modelsLoading = undefined
    this.openDesignModels = []
    this.openDesignLoadedAt = 0
    this.openDesignLoading = undefined
    this.errors.length = 0
    this.eventsHandled = 0
    this.eventsIgnored = 0
    this.sequence = 0
    this.setups = 0
    this.disposes = 0
    this.ledgerWrites = 0
    this.quotaWrites = 0
    this.quotaRefreshes = 0
  }

  diagnostics(): CoreDiagnostics {
    return {
      coreID: this.coreID,
      pid: this.pid,
      createdAt: this.createdAt,
      uptimeMs: Date.now() - this.createdAt,
      bridges: [...this.bridges.values()].map(({ id, directory, createdAt }) => ({ id, directory, createdAt })),
      bridgeCount: this.bridges.size,
      setups: this.setups,
      disposes: this.disposes,
      ledgerEvents: this.ledger.data.usage.length,
      decisions: this.ledger.data.decisions.length,
      sessions: Object.keys(this.ledger.data.sessions).length,
      quotaSnapshots: this.quota?.read().length ?? 0,
      quotaRefreshes: this.quotaRefreshes,
      ledgerWrites: this.ledgerWrites,
      quotaWrites: this.quotaWrites,
      lastLedgerWriteAt: this.lastLedgerWriteAt,
      lastQuotaWriteAt: this.lastQuotaWriteAt,
      quotaInitialized: this.quotaInitialized,
      bootstrapped: this.bootstrapped,
      eventsHandled: this.eventsHandled,
      eventsIgnored: this.eventsIgnored,
      eventStreams: this.eventsStarted ? 1 : 0,
      errors: this.errors.slice(-20),
    }
  }

  private dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    const running = this.teardown()
    const tracked = running.finally(() => {
      if (this.disposing === tracked) this.disposing = undefined
    })
    this.disposing = tracked
    return tracked
  }

  private async teardown() {
    if (this.shutdownTimer) clearTimeout(this.shutdownTimer)
    this.shutdownTimer = undefined
    this.eventAbort?.abort()
    this.eventAbort = undefined
    this.eventsStarted = false
    clearTimeout(this.ledgerTimer)
    clearTimeout(this.quotaTimer)
    clearTimeout(this.runtimeTimer)
    clearTimeout(this.bootstrapTimer)
    clearTimeout(this.quotaStartTimer)
    this.ledgerTimer = undefined
    this.quotaTimer = undefined
    this.runtimeTimer = undefined
    await this.persistNow()
    await this.persistRuntimeNow()
    await this.persistQuotaNow()
    this.started = false
    this.ready = undefined
    this.ownerCtx = undefined
    this.quota = undefined
    this.quotaInitialized = false
    this.quotaInitial = []
    // Keep the core object bound to the process. A later setup revives it via
    // init() (started=false) instead of creating a second core and racing on
    // the same plugin storage.
  }
}

export const sharedCore: SharedCore =
  ((globalThis as any)[KEY] as SharedCore | undefined) ??
  (((globalThis as any)[KEY] = new SharedCore()) as SharedCore)
