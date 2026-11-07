import type { CostTier } from "../types.js"
import { OPENDESIGN_CREDIT_MULTIPLIERS, OPENDESIGN_UNPUBLISHED_MULTIPLIER_MODELS } from "./opendesign-credits.js"
import { OPENDESIGN_DESIGN_PLAN_MODELS } from "../plans/catalog.js"

/**
 * OpenDesign model catalog.
 *
 * The gateway is authoritative for entitlement, context, output budget and
 * image support. Everything below was read from the live gateway's
 * `GET /v1/models` response on 2026-10-29, which is refreshed by the discovery
 * adapter at runtime.
 *
 * Two funding groups exist on the paid plans:
 *
 *  - **Design Plan models** draw from the shared Design Plan credit pool and
 *    are charged at their published multiplier.
 *  - **Plan models** draw from the separate plan model pool, which has no
 *    usage windows. Design Plan multipliers do not apply to them.
 *
 * Which group a model belongs to is decided by the plan catalog, not by this
 * file; `fundingPoolFor` is the single source of truth.
 *
 * Intelligence and design scores are reused from the router's existing seed
 * for the same underlying model, because the same model has the same quality
 * regardless of which subscription serves it. Models the router has never
 * scored stay unapproved until the owner approves them explicitly.
 *
 * Underlying token prices are the vendor list prices already curated in the
 * router seed. OpenDesign does not publish per-token prices for plan models;
 * for Design Plan models it publishes a credit multiplier that converts usage
 * value into credits. See docs/OPENDESIGN-INTEGRATION.md for the accuracy
 * limits of this proxy.
 */

export interface OpenDesignModelSpec {
  readonly modelID: string
  readonly name: string
  /**
   * Design Plan credit multiplier. Meaningful only for a model funded from
   * the Design Plan pool; plan models are billed at plain usage value.
   */
  readonly creditMultiplier: number
  readonly multiplierEvidence: "published" | "unverified" | "not-applicable"
  /** Usable input window the gateway reports for this model. */
  readonly context: number
  /** Maximum output tokens the gateway reports. */
  readonly maxOutput: number
  readonly input: readonly string[]
  readonly cost: readonly CostTier[]
  readonly intelligence: number
  readonly design: number
  readonly designEvidence: "benchmark" | "curated" | "observed" | "unverified"
  readonly tier: 1 | 2 | 3
  readonly approved: boolean
  readonly notes: string
  /**
   * Per-kind capability evidence. An absent axis means "not measured", never
   * zero, and each entry's provenance is named alongside it.
   */
  readonly capabilities?: {
    /** Agentic coding benchmark, percent. */
    readonly coding?: number
    /** Complex-debugging / automation benchmark, percent. */
    readonly debugging?: number
    /** Long-horizon autonomous-execution benchmark, percent. */
    readonly agentic?: number
    /** Curated architectural-reasoning score, same 0-100 scale. */
    readonly architecture?: number
  }
}

const cost = (input: number, output: number, read: number, write = 0): CostTier[] => [
  { input, output, cache: { read, write } },
]

const tieredCost = (
  base: CostTier,
  size: number,
  high: { input: number; output: number; read: number; write: number },
): CostTier[] => [
  base,
  {
    input: high.input,
    output: high.output,
    cache: { read: high.read, write: high.write },
    tier: { type: "context" as const, size },
  },
]

/**
 * Conservative fallbacks used when the gateway does not report a context or
 * output budget. A model with missing metadata is never treated as if it
 * could accept an unbounded request.
 */
export const OPENDESIGN_FALLBACK_CONTEXT = 232_000
export const OPENDESIGN_FALLBACK_OUTPUT = 32_000

const spec = (
  modelID: string,
  name: string,
  extra: Omit<OpenDesignModelSpec, "modelID" | "name" | "creditMultiplier" | "multiplierEvidence"> &
    Partial<Pick<OpenDesignModelSpec, "creditMultiplier" | "multiplierEvidence">>,
): OpenDesignModelSpec => {
  const inDesignPlan = OPENDESIGN_DESIGN_PLAN_MODELS.has(modelID)
  const published = OPENDESIGN_CREDIT_MULTIPLIERS[modelID]
  const hasPublished = typeof published === "number"
  return {
    modelID,
    name,
    creditMultiplier: extra.creditMultiplier ?? published ?? 1,
    multiplierEvidence:
      extra.multiplierEvidence ??
      (inDesignPlan ? (hasPublished ? "published" : "unverified") : "not-applicable"),
    context: extra.context,
    maxOutput: extra.maxOutput,
    input: extra.input,
    cost: extra.cost,
    intelligence: extra.intelligence,
    design: extra.design,
    designEvidence: extra.designEvidence,
    tier: extra.tier,
    approved: extra.approved,
    notes: extra.notes,
    ...(extra.capabilities ? { capabilities: extra.capabilities } : {}),
  }
}

/**
 * The models the gateway serves for this account.
 *
 * Entitlement is confirmed at runtime from `GET /v1/models`; a model missing
 * from that response is not plan-eligible even if it appears here.
 */
export const OPENDESIGN_MODELS: ReadonlyArray<OpenDesignModelSpec> = [
  // ---------------------------------------------------------------------------
  // Design Plan models. Charged at their published multiplier.
  // ---------------------------------------------------------------------------
  spec("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", {
    context: 1_048_000,
    maxOutput: 128_000,
    input: ["text", "image"],
    cost: cost(0.3, 1.2, 0.006),
    intelligence: 39.5,
    design: 65,
    designEvidence: "observed",
    tier: 2,
    approved: true,
    notes:
      "0.5x Design Plan credits. Gateway default. Served as DeepSeek-V4.1-Flash-1017 (2026-10-17 checkpoint). Native image input. The gateway advertises context_budget 328,000 but does not enforce it: measured on 2026-10-30 at 1,043,337 input tokens with HTTP 200, and rejected only above the 1,048,000 vendor limit. The seed carries the measured window.",
  }),
  spec("claude-haiku-5.5", "Claude Haiku 5.5", {
    context: 228_000,
    maxOutput: 128_000,
    input: ["text", "image", "pdf"],
    cost: tieredCost(cost(0.1, 0.5, 0.01, 0.125)[0]!, 100_000, {
      input: 0.5,
      output: 2.5,
      read: 0.05,
      write: 0.625,
    }),
    intelligence: 43.4,
    design: 70,
    designEvidence: "curated",
    tier: 2,
    approved: true,
    notes: "2x Design Plan credits. Highest design score inside the Design Plan group.",
  }),
  spec("glm-5.3-flash", "GLM-5.3-Flash", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "video"],
    cost: cost(0.075, 0.25, 0.015),
    intelligence: 41.8,
    design: 65,
    designEvidence: "curated",
    tier: 2,
    approved: true,
    notes: "1x Design Plan credits. Native image and video input.",
  }),
  spec("minimax-m3.1-flash", "MiniMax M3.1 Flash", {
    context: 1_000_000,
    maxOutput: OPENDESIGN_FALLBACK_OUTPUT,
    input: ["text", "image", "video"],
    cost: cost(0.15, 0.6, 0.015),
    intelligence: 42.7,
    design: 60,
    designEvidence: "curated",
    tier: 2,
    approved: true,
    notes:
      "The gateway reports a 1M vendor limit but no context_budget for this model, so the vendor limit is used. Confirmed against models.dev (1,000,000) and by 475 successful calls with no context-length error. The gateway also serves this model outside the Design Plan group; OpenDesign has not published which group or multiplier applies, so the neutral 1x rate is used and the uncertainty is reported.",
  }),
  spec("mimo-v2.6-pro", "MiMo-V2.6-Pro", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "audio", "video"],
    cost: cost(0.435, 0.87, 0.0036),
    intelligence: 46.3,
    design: 62,
    designEvidence: "curated",
    tier: 2,
    approved: true,
    notes: "1x Design Plan credits. Highest intelligence score inside the Design Plan group.",
  }),
  spec("mimo-v2.6-flash", "MiMo-V2.6-Flash", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "audio", "video"],
    cost: cost(0.14, 0.28, 0.0028),
    intelligence: 37.9,
    design: 50,
    designEvidence: "curated",
    tier: 1,
    approved: true,
    notes: "1x Design Plan credits. Economy tier; below the standard intelligence floor.",
  }),
  spec("gpt-6-luna", "GPT-6 Luna", {
    context: 400_000,
    maxOutput: 128_000,
    input: ["text", "image", "pdf"],
    cost: tieredCost(cost(0.1, 0.5, 0.01, 0.125)[0]!, 272_000, {
      input: 0.2,
      output: 0.75,
      read: 0.02,
      write: 0.25,
    }),
    intelligence: 38.1,
    design: 55,
    designEvidence: "curated",
    tier: 1,
    approved: true,
    notes: "4x Design Plan credits, the most expensive Design Plan route. 400k usable input window.",
  }),
  spec("deepseek-v4-pro", "DeepSeek V4 Pro", {
    context: 328_000,
    maxOutput: 128_000,
    input: ["text"],
    cost: cost(1.32, 3.96, 0.044),
    intelligence: 36,
    design: 55,
    designEvidence: "curated",
    tier: 2,
    approved: false,
    notes: "Text only and below the standard intelligence floor. Requires explicit approval.",
  }),
  spec("deepseek-v4-flash", "DeepSeek V4 Flash", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text"],
    cost: cost(0.44, 1.32, 0.014),
    intelligence: 0,
    design: 0,
    designEvidence: "unverified",
    tier: 2,
    approved: false,
    notes:
      "Served upstream by DeepSeek-V4.1-Flash-1017 (DeepSeek retired the legacy name but still accepts and bills it). Unscored under this id; the price is a conservative upper bound borrowed from V4 Pro. Set an explicit price in models.definitions before approving.",
  }),
  spec("deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash Vision Exp", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image"],
    cost: cost(0.44, 1.32, 0.014),
    intelligence: 0,
    design: 0,
    designEvidence: "unverified",
    tier: 2,
    approved: false,
    notes:
      "Unscored. Conservative upper-bound price; set an explicit price in models.definitions before approving.",
  }),
  spec("glm-5.3-flashx", "GLM-5.3-Flash-X", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "pdf", "video"],
    cost: cost(0.37, 1.25, 0.075),
    intelligence: 0,
    design: 0,
    designEvidence: "unverified",
    tier: 2,
    approved: false,
    notes:
      "2x Design Plan credits. Unscored; conservative upper-bound price borrowed from GLM-5.3. Set an explicit price in models.definitions before approving.",
  }),
  spec("hy4-preview", "Hunyuan H4 Preview", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text"],
    cost: cost(0.834, 2.501, 0.042),
    intelligence: 0,
    design: 0,
    designEvidence: "unverified",
    tier: 1,
    approved: false,
    notes: "Unscored and text only. Requires explicit approval.",
  }),
  spec("kimi-k2.7-code", "Kimi K2.7 Code", {
    context: 262_000,
    maxOutput: 32_000,
    input: ["text", "image"],
    cost: cost(0.95, 4, 0.19),
    intelligence: 0,
    design: 0,
    designEvidence: "unverified",
    tier: 2,
    approved: false,
    notes:
      "Unscored. Conservative upper-bound price borrowed from Kimi K3; set an explicit price in models.definitions before approving.",
  }),

  // ---------------------------------------------------------------------------
  // Plan models. Funded from the separate plan model pool, which has no usage
  // windows. Only available on Plus, Pro and Max.
  // ---------------------------------------------------------------------------
  spec("claude-sonnet-5.5", "Claude Sonnet 5.5", {
    // Probed 2026-11-06: one request with 819,383 random-filler prompt tokens
    // returned 200, finish stop, all three mid-document sentinels retrieved,
    // $1.62. The catalog is raised to the smallest probed-verified figure,
    // rounded down; the advertised 1M is NOT assumed from an 800K pass.
    context: 800_000,
    maxOutput: 128_000,
    input: ["text", "image", "pdf"],
    cost: cost(2, 10, 0.2, 2.5),
    intelligence: 56,
    design: 90,
    designEvidence: "curated",
    tier: 3,
    approved: true,
    capabilities: { coding: 64, debugging: 72, agentic: 42, architecture: 88 },
    notes:
      "Plan model. Premier design and architecture quality. Funded from plan model credits, so routing here consumes escalation capacity rather than routine allowance. Capabilities: Terminal-Bench 4.0 64 percent, AutomationBench 72 percent, FrontierCode 2.0 42 percent (Artificial Analysis v5.0.1, 2026-11-06, max reasoning; independent evaluations, not guarantees); architecture 88 curated. Auto-approved for tier-3 escalation by owner instruction 2026-11-06. Context probed 2026-11-06: 800K verified end-to-end (819,383 prompt tokens accepted, sentinels at start/middle/end retrieved, no truncation, $1.62); advertised 1M remains unverified.",
  }),
  spec("gpt-6-sol", "GPT-6 Sol", {
    context: 304_000,
    maxOutput: 32_000,
    input: ["text", "image", "pdf"],
    cost: tieredCost(cost(2, 10, 0.2, 2.5)[0]!, 272_000, { input: 4, output: 15, read: 0.4, write: 5 }),
    intelligence: 0,
    design: 88,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored in the router's curated set. Explicit approval required.",
  }),
  spec("gpt-6.1-sol", "GPT-6.1 Sol", {
    // Probed 2026-11-06: one request with 820,701 prompt tokens returned 200,
    // finish stop, all three sentinels retrieved, $2.74 - and the long-context
    // surcharge (input $4/M above 272K) was billed, confirming tiered pricing
    // applies exactly as cataloged. Raised to 800K (verified), not 1M.
    context: 800_000,
    maxOutput: 128_000,
    input: ["text", "image", "pdf"],
    cost: tieredCost(cost(2, 10, 0.1, 2.5)[0]!, 272_000, { input: 4, output: 15, read: 0.2, write: 5 }),
    intelligence: 55,
    design: 88,
    designEvidence: "unverified",
    tier: 3,
    approved: true,
    capabilities: { coding: 56, debugging: 65, agentic: 41, architecture: 86 },
    notes:
      "Plan model. Intelligence 55 on Artificial Analysis v5.0.1 (2026-11-06), tied with Sonnet 5.5 on that index; the per-kind capabilities break the tie toward Sonnet for agentic coding. Sol used far fewer generated tokens on the same suite, so it stays the cheaper tier-3 route on short fresh contexts. Capabilities: Terminal-Bench 4.0 56 percent, AutomationBench 65 percent, FrontierCode 2.0 41 percent, same index and configuration. Architecture 86 curated. Long-context tier doubles input to 4 and raises output to 15 above 272K. Auto-approved for tier-3 escalation by owner instruction 2026-11-06. Context probed 2026-11-06: 800K verified end-to-end (820,701 prompt tokens accepted with sentinels retrieved, no truncation, $2.74 billed at the tiered long-context rate); advertised 1M remains unverified.",
  }),
  spec("gpt-6-astra", "GPT-6 Astra", {
    context: 400_000,
    maxOutput: 128_000,
    input: ["text", "image", "pdf"],
    cost: tieredCost(cost(10, 50, 1, 12.5)[0]!, 272_000, { input: 20, output: 75, read: 2, write: 25 }),
    intelligence: 0,
    design: 88,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model, frontier-priced. Never selected automatically without explicit approval.",
  }),
  spec("claude-opus-5.5", "Claude Opus 5.5", {
    context: 328_000,
    maxOutput: 128_000,
    input: ["text", "image", "pdf"],
    cost: cost(4, 20, 0.2, 5),
    intelligence: 0,
    design: 92,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("claude-opus-5", "Claude Opus 5", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "pdf"],
    cost: cost(5, 25, 0.5, 6.25),
    intelligence: 0,
    design: 91,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("claude-opus-4.8", "Claude Opus 4.8", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "pdf"],
    cost: cost(5, 25, 0.5, 6.25),
    intelligence: 0,
    design: 90,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("claude-sonnet-5", "Claude Sonnet 5", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "pdf"],
    cost: cost(2, 10, 0.2, 2.5),
    intelligence: 0,
    design: 88,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("claude-fable-5.1", "Claude Fable 5.1", {
    context: 328_000,
    maxOutput: 128_000,
    input: ["text", "image", "pdf"],
    cost: cost(10, 50, 0.25, 12.5),
    intelligence: 0,
    design: 90,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model, frontier-priced. Never selected automatically without explicit approval.",
  }),
  spec("claude-fable-5", "Claude Fable 5", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "pdf"],
    cost: cost(10, 50, 1, 12.5),
    intelligence: 0,
    design: 89,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model, frontier-priced. Never selected automatically without explicit approval.",
  }),
  spec("muse-spark-1.3", "Muse Spark 1.3", {
    context: 1_048_000,
    maxOutput: 32_000,
    input: ["text", "image", "video", "pdf", "audio"],
    cost: cost(1.25, 4.25, 0.15),
    intelligence: 48.1,
    design: 82,
    designEvidence: "curated",
    tier: 3,
    approved: false,
    notes:
      "Plan model. Strong design quality and a 1,048,000-token window. Funded from plan model credits; escalate here deliberately, not by default.",
  }),
  spec("muse-wonder", "Muse Wonder", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "video", "pdf", "audio"],
    cost: cost(4, 20, 0.2),
    intelligence: 0,
    design: 86,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("gemini-4-argon", "Gemini 4 Argon", {
    context: 264_000,
    maxOutput: 64_000,
    input: ["text", "image", "video", "audio", "pdf"],
    cost: cost(2, 10, 0.1),
    intelligence: 0,
    design: 85,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("gemini-3.8-flash", "Gemini 3.8 Flash", {
    context: 264_000,
    maxOutput: 64_000,
    input: ["text", "image", "video", "audio", "pdf"],
    cost: cost(0.75, 3.75, 0.075),
    intelligence: 0,
    design: 78,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("gemini-3.7-flash", "Gemini 3.7 Flash", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "video", "audio", "pdf"],
    cost: cost(0.75, 3.75, 0.075),
    intelligence: 0,
    design: 76,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("kimi-k3", "Kimi K3", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "video"],
    cost: cost(3, 15, 0.3, 3),
    intelligence: 43.6,
    design: 72,
    designEvidence: "curated",
    tier: 3,
    approved: false,
    notes: "Plan model. Strong design quality; funded from plan model credits.",
  }),
  spec("kimi-k3.1-pro", "Kimi K3.1 Pro", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "video"],
    cost: cost(2, 10, 0.2, 2),
    intelligence: 0,
    design: 75,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("grok-4.7", "Grok 4.7", {
    context: 328_000,
    maxOutput: 128_000,
    input: ["text", "image", "pdf"],
    cost: tieredCost(cost(2, 6, 0.5)[0]!, 200_000, { input: 4, output: 12, read: 1, write: 0 }),
    intelligence: 46.4,
    design: 75,
    designEvidence: "curated",
    tier: 3,
    approved: false,
    notes: "Plan model. Funded from plan model credits.",
  }),
  spec("grok-4.6", "Grok 4.6", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "pdf"],
    cost: tieredCost(cost(2, 6, 0.5)[0]!, 200_000, { input: 4, output: 12, read: 1, write: 0 }),
    intelligence: 0,
    design: 74,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("grok-4.5", "Grok 4.5", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "pdf"],
    cost: tieredCost(cost(2, 6, 0.5)[0]!, 200_000, { input: 4, output: 12, read: 0.6, write: 0 }),
    intelligence: 0,
    design: 72,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("gpt-5.6-sol", "GPT-5.6 Sol", {
    context: 304_000,
    maxOutput: 32_000,
    input: ["text", "image", "pdf"],
    cost: tieredCost(cost(4, 20, 0.4, 5)[0]!, 272_000, { input: 8, output: 30, read: 0.8, write: 10 }),
    intelligence: 0,
    design: 85,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("gpt-5.6-terra", "GPT-5.6 Terra", {
    context: 304_000,
    maxOutput: 32_000,
    input: ["text", "image", "pdf"],
    cost: tieredCost(cost(2, 12, 0.2, 2.5)[0]!, 272_000, { input: 4, output: 18, read: 0.4, write: 5 }),
    intelligence: 0,
    design: 84,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("gpt-5.6-luna", "GPT-5.6 Luna", {
    context: 304_000,
    maxOutput: 32_000,
    input: ["text", "image", "pdf"],
    cost: tieredCost(cost(0.2, 1.2, 0.02, 0.25)[0]!, 272_000, { input: 0.4, output: 1.8, read: 0.04, write: 0.5 }),
    intelligence: 0,
    design: 60,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("gpt-6.1-terra", "GPT-6.1 Terra", {
    context: 304_000,
    maxOutput: 32_000,
    input: ["text", "image", "pdf"],
    cost: tieredCost(cost(2, 12, 0.2, 2.5)[0]!, 272_000, { input: 4, output: 18, read: 0.4, write: 5 }),
    intelligence: 0,
    design: 87,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("qwen3.7-max", "Qwen3.7 Max", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "video"],
    cost: cost(2.5, 7.5, 0.5, 3.125),
    intelligence: 0,
    design: 70,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored. Explicit approval required.",
  }),
  spec("glm-5.2", "GLM-5.2", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text"],
    cost: cost(1.4, 4.4, 0.26),
    intelligence: 0,
    design: 78,
    designEvidence: "unverified",
    tier: 3,
    approved: false,
    notes: "Plan model. Unscored and text only. Explicit approval required.",
  }),
]

export const OPEN_DESIGN_MODEL_BY_ID: ReadonlyMap<string, OpenDesignModelSpec> = new Map(
  OPENDESIGN_MODELS.map((model) => [model.modelID, model]),
)

/** Models whose multiplier is not published, exposed for status reporting. */
export const OPENDESIGN_MODELS_WITHOUT_PUBLISHED_MULTIPLIER: readonly string[] = [
  ...OPENDESIGN_UNPUBLISHED_MULTIPLIER_MODELS,
]

/** Models funded from the separate plan model pool. */
export const OPENDESIGN_PLAN_MODEL_IDS: readonly string[] = OPENDESIGN_MODELS
  .filter((model) => !OPENDESIGN_DESIGN_PLAN_MODELS.has(model.modelID))
  .map((model) => model.modelID)
