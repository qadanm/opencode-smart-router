import type { CostTier } from "../types.js"
import { OPENDESIGN_CREDIT_MULTIPLIERS, OPENDESIGN_UNPUBLISHED_MULTIPLIER_MODELS } from "./opendesign-credits.js"

/**
 * OpenDesign model catalog.
 *
 * The gateway is authoritative for entitlement, context, output budget, and
 * image support. Everything below was read from the live OpenDesign gateway's
 * `GET /v1/models` response on 2026-10-28 and is refreshed by the discovery
 * adapter at runtime.
 *
 * Intelligence and design scores are reused from the router's existing seed for
 * the same underlying model, because the same underlying model has the same
 * quality regardless of which subscription serves it. Models that the router
 * has never scored stay unapproved until the owner approves them explicitly.
 *
 * Underlying token prices are the vendor list prices already curated in the
 * router seed. OpenDesign does not publish per-token prices for plan models;
 * it publishes a credit multiplier that converts usage value into credits.
 * See docs/OPENDESIGN-INTEGRATION.md for the accuracy limits of this proxy.
 */

export interface OpenDesignModelSpec {
  readonly modelID: string
  readonly name: string
  /** Design Plan credit multiplier for this model. */
  readonly creditMultiplier: number
  readonly multiplierEvidence: "published" | "unverified"
  /** Effective usable input window reported by the gateway. */
  readonly context: number
  /** Maximum output tokens reported by the gateway. */
  readonly maxOutput: number
  readonly input: readonly string[]
  readonly cost: readonly CostTier[]
  readonly intelligence: number
  readonly design: number
  readonly designEvidence: "benchmark" | "curated" | "observed" | "unverified"
  readonly tier: 1 | 2 | 3
  readonly approved: boolean
  readonly notes: string
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
 * output budget. They are the most common values observed across the
 * OpenDesign gateway catalog, so a model with missing metadata is never
 * treated as if it could accept an unbounded request.
 */
export const OPENDESIGN_FALLBACK_CONTEXT = 232_000
export const OPENDESIGN_FALLBACK_OUTPUT = 32_000

const spec = (
  modelID: string,
  name: string,
  extra: Omit<OpenDesignModelSpec, "modelID" | "name" | "creditMultiplier" | "multiplierEvidence"> &
    Partial<Pick<OpenDesignModelSpec, "creditMultiplier" | "multiplierEvidence">>,
): OpenDesignModelSpec => {
  const published = OPENDESIGN_CREDIT_MULTIPLIERS[modelID]
  const hasPublished = typeof published === "number"
  return {
    modelID,
    name,
    creditMultiplier: extra.creditMultiplier ?? published ?? 1,
    multiplierEvidence: extra.multiplierEvidence ?? (hasPublished ? "published" : "unverified"),
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
  }
}

/**
 * The Design Plan group the gateway serves for this account. Entitlement is
 * confirmed at runtime from `GET /v1/models`; a model missing from that
 * response is not plan-eligible even if it appears here.
 */
export const OPENDESIGN_MODELS: ReadonlyArray<OpenDesignModelSpec> = [
  spec("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", {
    context: 328_000,
    maxOutput: 128_000,
    input: ["text", "image"],
    cost: cost(0.15, 0.6, 0.003),
    intelligence: 39.5,
    design: 65,
    designEvidence: "observed",
    tier: 2,
    approved: true,
    notes: "0.5x credits. Gateway default model. Native image input and a 328k usable input window.",
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
    notes: "2x credits. Highest design score available inside the Design Plan group.",
  }),
  spec("glm-5.3-flash", "GLM-5.3-Flash", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "video"],
    cost: cost(0.15, 0.5, 0.03),
    intelligence: 41.8,
    design: 65,
    designEvidence: "curated",
    tier: 2,
    approved: true,
    notes: "1x credits. Native image and video input.",
  }),
  spec("minimax-m3.1-flash", "MiniMax M3.1 Flash", {
    context: OPENDESIGN_FALLBACK_CONTEXT,
    maxOutput: OPENDESIGN_FALLBACK_OUTPUT,
    input: ["text", "image", "video"],
    cost: cost(0.15, 0.6, 0.015),
    intelligence: 42.7,
    design: 60,
    designEvidence: "curated",
    tier: 2,
    approved: true,
    notes:
      "Gateway reports no context or output budget, so the conservative 232k window is used. Multiplier is not published; the neutral 1x rate is an estimate.",
  }),
  spec("mimo-v2.6-pro", "MiMo-V2.6-Pro", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image", "audio", "video"],
    cost: cost(0.435, 0.87, 0.003625),
    intelligence: 46.3,
    design: 62,
    designEvidence: "curated",
    tier: 2,
    approved: true,
    notes: "1x credits. Highest intelligence score inside the Design Plan group.",
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
    notes: "1x credits. Economy tier; below the standard intelligence floor.",
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
    notes: "4x credits, the most expensive plan route. Largest usable input window at 400k.",
  }),
  spec("deepseek-v4-pro", "DeepSeek V4 Pro", {
    context: 328_000,
    maxOutput: 128_000,
    input: ["text"],
    cost: cost(0.66, 1.98, 0.022),
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
    cost: cost(0.66, 1.98, 0.022),
    intelligence: 0,
    design: 0,
    designEvidence: "unverified",
    tier: 2,
    approved: false,
    notes:
      "Unscored. The price is a conservative upper bound borrowed from DeepSeek V4 Pro; set an explicit price in models.definitions before approving.",
  }),
  spec("deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash Vision Exp", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text", "image"],
    cost: cost(0.66, 1.98, 0.022),
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
    cost: cost(1.4, 4.4, 0.26),
    intelligence: 0,
    design: 0,
    designEvidence: "unverified",
    tier: 2,
    approved: false,
    notes:
      "Unscored. Conservative upper-bound price borrowed from GLM-5.3; set an explicit price in models.definitions before approving.",
  }),
  spec("hy4-preview", "Hunyuan H4 Preview", {
    context: 232_000,
    maxOutput: 32_000,
    input: ["text"],
    cost: cost(0.14, 0.58, 0.035),
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
    cost: cost(3, 15, 0.3, 3),
    intelligence: 0,
    design: 0,
    designEvidence: "unverified",
    tier: 2,
    approved: false,
    notes:
      "Unscored. Conservative upper-bound price borrowed from Kimi K3; set an explicit price in models.definitions before approving.",
  }),
]

export const OPEN_DESIGN_MODEL_BY_ID: ReadonlyMap<string, OpenDesignModelSpec> = new Map(
  OPENDESIGN_MODELS.map((model) => [model.modelID, model]),
)

/** Models whose multiplier is not published, exposed for status reporting. */
export const OPENDESIGN_MODELS_WITHOUT_PUBLISHED_MULTIPLIER: readonly string[] = [
  ...OPENDESIGN_UNPUBLISHED_MULTIPLIER_MODELS,
]
