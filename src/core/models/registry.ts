import type { CostTier, ModelRecord, RouterSettings } from "../types.js"
import { modelKey } from "../util.js"
import { modelMonthlyAllowanceUsd, resolvePlan } from "../plans/catalog.js"
import { SEED_MODELS, type SeedModel } from "./seed.js"
import { OFFLINE_PROVIDER_ID } from "../offline/mode.js"

export interface LiveModel {
  readonly id: string
  readonly providerID: string
  readonly name?: string
  readonly limit?: { readonly context?: number; readonly output?: number }
  readonly capabilities?: {
    readonly tools?: boolean
    readonly input?: ReadonlyArray<string>
    readonly output?: ReadonlyArray<string>
  }
  readonly cost?: ReadonlyArray<CostTier>
  readonly enabled?: boolean
  readonly disabled?: boolean
}

export interface RegistryBuildInput {
  readonly live: ReadonlyArray<LiveModel>
  readonly settings: RouterSettings
  readonly seed?: ReadonlyArray<SeedModel>
  readonly definitions?: ReadonlyArray<SeedModel>
}

const normalizeCost = (cost: ReadonlyArray<CostTier> | undefined): CostTier[] => {
  if (!cost || cost.length === 0) return [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
  return cost.map((tier) => ({
    input: Number.isFinite(tier.input) ? tier.input : 0,
    output: Number.isFinite(tier.output) ? tier.output : 0,
    cache: {
      read: Number.isFinite(tier.cache?.read) ? tier.cache.read : 0,
      write: Number.isFinite(tier.cache?.write) ? tier.cache.write : 0,
    },
    ...(tier.tier ? { tier: { type: "context" as const, size: tier.tier.size } } : {}),
  }))
}

const fromSeed = (seed: SeedModel): ModelRecord => ({
  key: seed.key,
  providerID: seed.providerID,
  modelID: seed.modelID,
  name: seed.name,
  context: seed.context,
  maxOutput: seed.maxOutput,
  inputModalities: seed.input,
  outputModalities: ["text"],
  tools: seed.tools ?? true,
  cost: seed.cost,
  ...(seed.peakPricing ? { peakPricing: seed.peakPricing } : {}),
  intelligence: seed.intelligence,
  design: seed.design,
  designEvidence: seed.designEvidence ?? "curated",
  ...(seed.creditMultiplier && seed.creditMultiplier > 0 ? { creditMultiplier: seed.creditMultiplier } : {}),
  ...(seed.escalationOnly ? { escalationOnly: true } : {}),
  premium: seed.premium ?? false,
  training: seed.training ?? false,
  free: seed.free ?? false,
  tier: seed.tier,
  approved: seed.approved ?? true,
  approvalSource: "seed",
  monthlyAllowanceUsd: seed.monthlyAllowanceUsd,
  notes: seed.notes,
})

const mergeLive = (record: ModelRecord, live: LiveModel): ModelRecord => ({
  ...record,
  name: live.name && live.name.trim().length > 0 ? live.name : record.name,
  context: live.limit?.context && live.limit.context > 0 ? live.limit.context : record.context,
  maxOutput: live.limit?.output && live.limit.output > 0 ? live.limit.output : record.maxOutput,
  tools: live.capabilities?.tools ?? record.tools,
  inputModalities:
    live.capabilities?.input && live.capabilities.input.length > 0 ? [...live.capabilities.input] : record.inputModalities,
  outputModalities:
    live.capabilities?.output && live.capabilities.output.length > 0 ? [...live.capabilities.output] : record.outputModalities,
  cost: normalizeCost(live.cost ?? record.cost),
})

const fromLive = (live: LiveModel): ModelRecord => {
  const key = modelKey(live.providerID, live.id)
  return {
    key,
    providerID: live.providerID,
    modelID: live.id,
    name: live.name?.trim() || live.id,
    context: live.limit?.context && live.limit.context > 0 ? live.limit.context : 0,
    maxOutput: live.limit?.output && live.limit.output > 0 ? live.limit.output : 0,
    inputModalities: live.capabilities?.input ? [...live.capabilities.input] : ["text"],
    outputModalities: live.capabilities?.output ? [...live.capabilities.output] : ["text"],
    tools: live.capabilities?.tools ?? false,
    cost: normalizeCost(live.cost),
    intelligence: 0,
    design: 0,
    designEvidence: "unverified",
    premium: false,
    training: /contributor|-free$|iceman/i.test(live.id),
    free: /(^|[-/])(free|beam-free|laguna-s-2\.1-free)$/i.test(live.id),
    tier: 2,
    approved: false,
    approvalSource: "discovered",
    monthlyAllowanceUsd: 0,
    notes: "Discovered model. Not qualified for automatic routing until approved.",
  }
}

export class ModelRegistry {
  private readonly records = new Map<string, ModelRecord>()
  private readonly liveCount: number

  constructor(input: RegistryBuildInput) {
    const seeds = [...(input.seed ?? SEED_MODELS), ...(input.definitions ?? [])]
    const seedByKey = new Map(seeds.map((seed) => [seed.key, seed]))
    const liveByKey = new Map(input.live.map((model) => [modelKey(model.providerID, model.id), model]))

    this.liveCount = input.live.length

    for (const seed of seeds) {
      const live = liveByKey.get(seed.key)
      this.records.set(seed.key, live ? mergeLive(fromSeed(seed), live) : fromSeed(seed))
    }

    for (const live of input.live) {
      const key = modelKey(live.providerID, live.id)
      if (this.records.has(key)) continue
      this.records.set(key, fromLive(live))
    }

    const approved = new Set(input.settings.models.approved)
    const excluded = new Set(input.settings.models.excluded)
    const overrides = input.settings.models.tierOverrides

    for (const [key, record] of this.records) {
      const tierOverride = overrides[key]
      const explicitlyApproved = approved.has(key)
      const isExcluded = excluded.has(key)
      const providerEnabled = input.settings.providers[record.providerID]?.enabled ?? true
      const approvedBySeed = record.approvalSource === "seed" && record.approved
      // The plan catalog is authoritative for a plan-metered allowance. A
      // seed value is a fallback for a provider with no catalog entry, so a
      // plan change is a configuration change rather than a code change.
      const plan = resolvePlan(record.providerID, input.settings.providers[record.providerID]?.plan)
      const catalogAllowance = plan ? modelMonthlyAllowanceUsd(plan, record.modelID) : 0
      this.records.set(key, {
        ...record,
        tier: tierOverride ?? record.tier,
        monthlyAllowanceUsd: catalogAllowance > 0 ? catalogAllowance : record.monthlyAllowanceUsd,
        approved: providerEnabled && !isExcluded && (explicitlyApproved || approvedBySeed),
        approvalSource: explicitlyApproved ? "user" : record.approvalSource,
      })
    }
  }

  get count() {
    return this.records.size
  }

  get liveModelCount() {
    return this.liveCount
  }

  all(): ModelRecord[] {
    return [...this.records.values()]
  }

  get(providerID: string, modelID: string): ModelRecord | undefined {
    return this.records.get(modelKey(providerID, modelID))
  }

  getByKey(key: string): ModelRecord | undefined {
    return this.records.get(key)
  }

  approved(): ModelRecord[] {
    return this.all().filter((model) => model.approved)
  }

  approvedForProvider(providerID: string): ModelRecord[] {
    return this.approved().filter((model) => model.providerID === providerID)
  }

  /**
   * Models available to an offline session.
   *
   * Offline mode deliberately bypasses the online `approved` list. Approval is
   * an online-policy decision ("may this model serve paid work alongside the
   * hosted floor"), and a local model is excluded from it on purpose. Requiring
   * the owner to approve a local model for *online* routing in order to use it
   * while offline would be exactly the kind of manual configuration step this
   * feature is supposed to remove.
   *
   * The offline allow-list still applies on top of this, so the result can only
   * ever contain local models.
   */
  modelsForOffline(): ModelRecord[] {
    return this.all().filter((model) => model.providerID === OFFLINE_PROVIDER_ID)
  }
}

export const buildRegistry = (input: RegistryBuildInput) => new ModelRegistry(input)
