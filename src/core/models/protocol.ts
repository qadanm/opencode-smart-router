import type { ModelRecord } from "../types.js"

export type ProviderProtocol = "anthropic" | "openai-compat"

/**
 * Which wire protocol the provider's serving path speaks, as far as prompt
 * shaping is concerned. The Anthropic Messages protocol is the strict one:
 * anything but `user | assistant` as a message role is a deterministic 400.
 * OpenAI-compatible gateways tolerate more shapes, so no repair is needed.
 *
 * A seeded record may carry the answer explicitly. Everything else is
 * inferred: `claude` model names are served over the Anthropic protocol by
 * every provider observed so far, and the remaining gateways are
 * OpenAI-compatible including their claude relays that translate for them.
 */
export const providerProtocol = (
  record: Pick<ModelRecord, "protocol" | "providerID" | "modelID">,
): ProviderProtocol => {
  if (record.protocol === "anthropic") return "anthropic"
  if (record.protocol === "openai-compat") return "openai-compat"
  return /claude/i.test(`${record.providerID}/${record.modelID}`) ? "anthropic" : "openai-compat"
}
