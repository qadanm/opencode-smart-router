import { OPENDESIGN_MODELS } from "../providers/opendesign-models.js"
import { creditMultiplierFor } from "../providers/opendesign-credits.js"
import type { UsageReading } from "../plan-page.js"

/**
 * Check the router's cost model against what the account was actually charged.
 *
 * This is the whole reason a usage paste beats an allowance paste. A percentage
 * tells you how much allowance is left; a usage table tells you whether the
 * arithmetic that predicted it was right in the first place.
 *
 * For one model, charged credits divided by the published base price gives the
 * multiplier that was actually applied. Compare that to the multiplier the
 * catalog believes, and the disagreement — if any — is measured rather than
 * assumed. Ten wrong prices were found exactly this way, by comparing numbers
 * instead of trusting comments.
 *
 * Nothing here writes anything. A disagreement is reported for a human to
 * decide on, because a usage page is one window of one account and a catalog is
 * meant to describe everyone.
 */

export interface ReconcileRow {
  readonly modelName: string
  readonly modelID?: string
  /** Credits charged, as USD-equivalent. */
  readonly chargedUsd: number
  /** What the router's prices say that usage should have cost, before multiplier. */
  readonly baseUsd?: number
  /** chargedUsd / baseUsd — the multiplier the account actually applied. */
  readonly impliedMultiplier?: number
  /** The multiplier the catalog believes. */
  readonly catalogMultiplier?: number
  readonly verdict: "agrees" | "differs" | "unmatched" | "no-price"
  /** For a differing row, how far apart in relative terms. */
  readonly driftPct?: number
}

export interface ReconcileResult {
  readonly rows: ReadonlyArray<ReconcileRow>
  readonly agree: number
  readonly differ: number
  readonly unmatched: number
  /** One sentence for the panel. */
  readonly summary: string
}

/** Normalise a display name for matching: "DeepSeek V4.1 Flash" -> "deepseekv41flash". */
const normaliseName = (value: string): string =>
  value.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]/g, "")

const byNormalisedName = new Map(OPENDESIGN_MODELS.map((model) => [normaliseName(model.name), model]))

/** Names the console may use that differ from our label. */
const ALIASES: Readonly<Record<string, string>> = {
  deepseekv41flash: "deepseek-v4.1-flash",
  deepseekv4flash: "deepseek-v4-flash",
  deepseekv4pro: "deepseek-v4-pro",
  glm53flash: "glm-5.3-flash",
  glm53flashx: "glm-5.3-flashx",
  claudehaiku55: "claude-haiku-5.5",
  gpt6luna: "gpt-6-luna",
  mimo26flash: "mimo-v2.6-flash",
  mimo26pro: "mimo-v2.6-pro",
  kimik27code: "kimi-k2.7-code",
}

const resolveModel = (name: string) => {
  const key = normaliseName(name)
  const direct = byNormalisedName.get(key)
  if (direct) return direct
  const aliasID = ALIASES[key as keyof typeof ALIASES]
  if (aliasID) return OPENDESIGN_MODELS.find((model) => model.modelID === aliasID)
  return undefined
}

/** Within this much, a rounding difference is not a finding. */
const TOLERANCE_PCT = 5

export const reconcileUsage = (reading: UsageReading): ReconcileResult => {
  const rows: ReconcileRow[] = []

  for (const row of reading.rows) {
    if (row.chargedUsd === undefined || !row.modelName) continue
    const model = resolveModel(row.modelName)
    if (!model) {
      rows.push({
        modelName: row.modelName,
        chargedUsd: row.chargedUsd,
        verdict: "unmatched",
      })
      continue
    }

    const tier = model.cost[0]
    if (!tier) {
      rows.push({
        modelName: row.modelName,
        modelID: model.modelID,
        chargedUsd: row.chargedUsd,
        verdict: "no-price",
      })
      continue
    }

    const input = row.inputTokens ?? 0
    const output = row.outputTokens ?? 0
    const cacheRead = row.cacheReadTokens ?? 0
    // Tokens absent means the base cost cannot be reconstructed; the row still
    // proves a charge happened, which is why it is kept rather than dropped.
    const baseUsd =
      input + output + cacheRead === 0
        ? undefined
        : (tier.input * input + tier.output * output + (tier.cache?.read ?? 0) * cacheRead) / 1_000_000

    if (baseUsd === undefined || baseUsd <= 0) {
      rows.push({
        modelName: row.modelName,
        modelID: model.modelID,
        chargedUsd: row.chargedUsd,
        verdict: "no-price",
      })
      continue
    }

    const impliedMultiplier = row.chargedUsd / baseUsd
    const catalogMultiplier = creditMultiplierFor(model.modelID).multiplier
    const driftPct = catalogMultiplier === 0 ? undefined : ((impliedMultiplier - catalogMultiplier) / catalogMultiplier) * 100
    const agrees = driftPct !== undefined && Math.abs(driftPct) <= TOLERANCE_PCT

    rows.push({
      modelName: row.modelName,
      modelID: model.modelID,
      chargedUsd: row.chargedUsd,
      baseUsd,
      impliedMultiplier,
      catalogMultiplier,
      verdict: agrees ? "agrees" : "differs",
      ...(driftPct !== undefined ? { driftPct } : {}),
    })
  }

  const agree = rows.filter((row) => row.verdict === "agrees").length
  const differ = rows.filter((row) => row.verdict === "differs").length
  const unmatched = rows.filter((row) => row.verdict !== "agrees" && row.verdict !== "differs").length

  const summary =
    rows.length === 0
      ? "No charged amounts on that page, so the cost model cannot be checked from it."
      : differ === 0
        ? `The cost model matches what was charged for ${agree} of ${rows.length} model${rows.length === 1 ? "" : "s"}.`
        : `The cost model disagrees with what was charged for ${differ} of ${rows.length} model${rows.length === 1 ? "" : "s"}. That is a catalog problem, not a routing one.`

  return { rows, agree, differ, unmatched, summary }
}
