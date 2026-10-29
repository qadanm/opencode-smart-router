#!/usr/bin/env node
/**
 * Diagnostic: evaluate every approved model against the real eligibility
 * gate, using the live quota snapshot, and print each exclusion reason.
 *
 * Run with:  node scripts/why-no-candidates.ts <contextTokens> [quota.json]
 */
import { readFileSync } from "node:fs"
import { buildRegistry } from "../src/core/models/registry.js"
import { evaluateEligibility } from "../src/core/policy/eligibility.js"
import { loadSettings } from "../src/core/config.js"
import { estimateTaskCost } from "../src/core/routing/engine.js"

const contextTokens = Number(process.argv[2] ?? 309_321)
const quotaFile = process.argv[3] ?? "/tmp/opencode/quota.json"
const quota: any[] = JSON.parse(readFileSync(quotaFile, "utf8"))

const settings = loadSettings({ options: {} }).settings
const registry = buildRegistry({
  live: [],
  settings,
  definitions: settings.models.definitions as any,
})

const task: any = {
  tier: 2,
  kind: "feature",
  requiresVision: false,
  designIntensive: false,
  sophisticatedDesign: false,
  needsLongContext: true,
  confidence: "medium",
  signals: ["long_context"],
  reasons: ["test"],
  constraints: { avoidPremium: false, requestPremium: false, requestEconomy: false },
  scope: {
    files: 0,
    codeBlocks: 0,
    longestCodeBlockLines: 0,
    hasStackTrace: false,
    hasImage: false,
    hasScreenshot: false,
    promptChars: 211,
    promptTokens: 53,
  },
}

const premium = { allowed: false, requiresApproval: false, reason: "premium off" }

console.log(`context = ${contextTokens.toLocaleString()}`)
console.log("")
let eligible = 0
for (const model of registry.approved()) {
  const provider = quota.find((e) => e.providerID === model.providerID)
  const modelQuota = provider?.models?.[`${model.providerID}/${model.modelID}`]
  const estimate = estimateTaskCost({ model, task, contextTokens, now: Date.now() })
  const result = evaluateEligibility({
    model,
    task,
    settings,
    mode: "balanced",
    contextTokens,
    providerQuota: provider,
    modelQuota,
    premium,
    currentModelKey: undefined,
    projectedUsd: estimate.usd,
  })
  if (result.eligible) eligible++
  const required = contextTokens + 20_000
  const ctxGate =
    model.context > 0 && required > model.context * 0.95
      ? `CTX-FAIL(need ${required.toLocaleString()}, safe ${Math.floor(model.context * 0.95).toLocaleString()})`
      : "ctx-ok"
  console.log(
    `  ${result.eligible ? "ELIGIBLE" : "excluded"}  ${model.providerID}/${model.modelID.padEnd(24)} ctx=${String(model.context).padStart(9)}  ${ctxGate.padEnd(42)}  ${result.reason}`,
  )
}
console.log("")
console.log(`eligible models: ${eligible}`)

console.log("")
console.log("=== cheapestVariantContext (the compaction target) ===")
for (const modelID of ["minimax-m3.1-flash", "deepseek-v4.1-flash"]) {
  let best: { multiplier: number; context: number; provider: string } | undefined
  for (const model of registry.approved()) {
    if (model.modelID !== modelID) continue
    const multiplier = model.creditMultiplier && model.creditMultiplier > 0 ? model.creditMultiplier : 1
    if (
      !best ||
      multiplier < best.multiplier ||
      (multiplier === best.multiplier && model.context > best.context)
    ) {
      best = { multiplier, context: model.context, provider: model.providerID }
    }
  }
  console.log(
    `  ${modelID.padEnd(24)} -> target window ${best?.context.toLocaleString()} (${best?.provider}, ${best?.multiplier}x)`,
  )
  for (const model of registry.approved()) {
    if (model.modelID !== modelID) continue
    const multiplier = model.creditMultiplier && model.creditMultiplier > 0 ? model.creditMultiplier : 1
    console.log(
      `      variant: ${model.providerID}/${model.modelID}  ${multiplier}x  ctx=${model.context.toLocaleString()}`,
    )
  }
}
