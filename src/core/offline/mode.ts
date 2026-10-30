/**
 * Offline development mode.
 *
 * The router's job is normally to choose among hosted models by cost, quota and
 * capability. Offline mode is the opposite problem: there is exactly one
 * permitted endpoint, and every other route must be impossible rather than
 * merely unlikely.
 *
 * Three properties matter more than anything else here:
 *
 *  1. **Fail closed.** If the local server is unreachable, the answer is a
 *     refusal that names the fix, not a quiet fallback to a hosted model. A
 *     silent fallback while on an airplane is the worst possible outcome,
 *     because the failure appears as a hang or a charge rather than an error.
 *  2. **No network by accident.** Offline mode has to be explicit and visible,
 *     never inferred. A dropped Wi-Fi connection must not change behavior,
 *     because inference that "works" would be indistinguishable from inference
 *     that silently used a hosted provider.
 *  3. **The online router is untouched.** Offline is a separate module and a
 *     separate settings block. Enabling it must not reorder, re-price, or
 *     re-approve a single online model.
 *
 * This module holds the policy and the arithmetic. It deliberately does not
 * perform I/O against the host, so it can be tested exhaustively.
 */

/**
 * How the router should treat the current session.
 *
 * `online` is the existing behavior and the default. `offline` restricts
 * inference to the configured local endpoint.
 */
export type InferenceMode = "online" | "offline"

/** Residency policy for the local model, expressed as an idle unload. */
export interface OfflineModelSettings {
  /** Ollama model tag, e.g. `qwen3.5:4b-q4_K_M`. */
  readonly model: string
  /** Local inference base URL. Loopback only unless deliberately overridden. */
  readonly baseURL: string
  /**
   * Context window in tokens.
   *
   * This is the KV-cache size, and it is the single largest lever on memory.
   * It is bounded below by the smallest useful coding task and above by what
   * the machine can hold alongside a simulator.
   */
  readonly contextTokens: number
  /** Upper bound on generated tokens per reply. */
  readonly maxOutputTokens: number
  /**
   * Requests the local server may run at once. One keeps a 16 GB machine from
   * holding two KV caches and thrashing.
   */
  readonly concurrency: number
  /** Minutes an idle model may stay resident before the server unloads it. */
  readonly keepAliveMinutes: number
  /** True when the model accepts image input. Verified, not assumed. */
  readonly vision: boolean
  /** True when the model supports tool calling. Verified, not assumed. */
  readonly tools: boolean
}

export interface OfflineSettings {
  readonly enabled: boolean
  readonly model: OfflineModelSettings
  /**
   * Where the local model store lives. `undefined` means the runtime default.
   * A path here is treated as mandatory: if it is missing, that is an error,
   * never a reason to fall back to the internal disk.
   */
  readonly modelStorePath?: string
}

export const DEFAULT_OFFLINE_SETTINGS: OfflineSettings = {
  // Off by default. Offline mode is chosen, never inferred.
  enabled: false,
  model: {
    model: "qwen3.5:4b-q4_K_M",
    baseURL: "http://127.0.0.1:11434",
    // 8K is the starting point agreed for this machine. It holds a component,
    // its styles, a focused diff and a screenshot's worth of description while
    // leaving room for the reply.
    contextTokens: 8_192,
    maxOutputTokens: 2_048,
    concurrency: 1,
    keepAliveMinutes: 5,
    vision: true,
    tools: true,
  },
}

/** A reason offline mode cannot serve a request, with the fix stated. */
export interface OfflineBlocker {
  readonly code:
    | "mode-disabled"
    | "endpoint-unreachable"
    | "model-missing"
    | "model-store-missing"
    | "vision-unsupported"
    | "tools-unsupported"
    | "context-too-small"
  /** One line a user can act on. */
  readonly message: string
  /** The exact command or setting that resolves it, when one exists. */
  readonly remedy?: string
}

/**
 * Loopback check.
 *
 * The server must not listen on a routable interface: on a shared or café
 * network that exposes prompt data and model control to anyone on the link.
 * `localhost`, `127.0.0.1` and `::1` are accepted; everything else is not.
 */
export const isLoopbackURL = (raw: string): boolean => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  if (host === "localhost" || host === "::1" || host === "[::1]") return true
  // 127.0.0.0/8, the whole IPv4 loopback block.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return false
}

/**
 * The model context has to hold a screenshot's description plus the code a
 * vision edit needs. Below this, the model spends its window on the image and
 * has nothing left for the change.
 */
export const MINIMUM_OFFLINE_CONTEXT = 4_096

/**
 * Decide whether offline mode may serve a request.
 *
 * Returns the first blocker rather than a list, because a user fixes one thing
 * at a time and a wall of errors hides the actionable one. The caller is
 * expected to refuse the request, never to fall through to a hosted model.
 */
export const checkOfflineReadiness = (input: {
  readonly settings: OfflineSettings
  /** True when the local endpoint answered a health probe. */
  readonly endpointReachable: boolean
  /** True when the configured model appears in the local server's model list. */
  readonly modelPresent: boolean
  /** True when `modelStorePath` is set and that path does not exist. */
  readonly modelStoreMissing?: boolean
  /** True when the current request carries an image. */
  readonly needsVision?: boolean
  /** True when the current request needs tool calling. */
  readonly needsTools?: boolean
}): OfflineBlocker | undefined => {
  const { settings } = input
  if (!settings.enabled) {
    return {
      code: "mode-disabled",
      message: "Offline mode is not enabled for this session.",
      remedy: "Run `opencode-offline` to start a local session.",
    }
  }
  if (input.modelStoreMissing) {
    return {
      code: "model-store-missing",
      message: `The configured model store is not available at ${settings.modelStorePath}.`,
      remedy:
        "Reconnect the drive that holds the model store, or unset offline.modelStorePath to use the default location. The router will not download a model to the internal disk while a store is configured.",
    }
  }
  if (!input.endpointReachable) {
    return {
      code: "endpoint-unreachable",
      message: `No local inference server answered at ${settings.model.baseURL}.`,
      remedy: `Start it with \`ollama serve\`, then confirm with \`curl ${settings.model.baseURL}/api/version\`.`,
    }
  }
  if (!input.modelPresent) {
    return {
      code: "model-missing",
      message: `The local server does not have ${settings.model.model} installed.`,
      remedy: `Install it with \`ollama pull ${settings.model.model}\` while connected.`,
    }
  }
  if (settings.model.contextTokens < MINIMUM_OFFLINE_CONTEXT) {
    return {
      code: "context-too-small",
      message: `Offline context is ${settings.model.contextTokens} tokens, below the ${MINIMUM_OFFLINE_CONTEXT}-token minimum for a screenshot-driven edit.`,
      remedy: "Raise `offline.model.contextTokens`, or accept text-only work.",
    }
  }
  if (input.needsVision && !settings.model.vision) {
    return {
      code: "vision-unsupported",
      message: "This request includes an image, but the configured offline model has no image input.",
      remedy: "Configure a vision-capable offline model, or send the request without an image.",
    }
  }
  if (input.needsTools && !settings.model.tools) {
    return {
      code: "tools-unsupported",
      message: "This request needs file or shell tools, but the configured offline model cannot call tools.",
      remedy: "Configure a tool-calling offline model.",
    }
  }
  return undefined
}

/**
 * Providers that must never be used while offline.
 *
 * Kept as an explicit list for refusal messages and for auditing the registry,
 * not as the enforcement mechanism. Enforcement is an allow-list of exactly one
 * provider, so a hosted provider added to the registry later cannot silently
 * become reachable offline.
 */
export const HOSTED_PROVIDERS: ReadonlySet<string> = new Set([
  "opendesign",
  "opencode-go",
  "commandcode",
  "openrouter",
  "groq",
  "cerebras",
  "google",
  "anthropic",
  "openai",
])

export const OFFLINE_PROVIDER_ID = "ollama"

/**
 * True when an inference request may be sent in the current mode.
 *
 * Offline is an allow-list of one. Anything not named is refused, including
 * providers this module has never heard of, because the failure mode of
 * guessing wrong is a silent hosted request on an airplane.
 */
export const mayUseProvider = (providerID: string, mode: InferenceMode): boolean => {
  if (mode === "online") return true
  return providerID === OFFLINE_PROVIDER_ID
}

/**
 * Whether a route is permitted, with the reason when it is not.
 *
 * Separate from `mayUseProvider` so callers can log or surface a precise
 * explanation instead of a bare boolean, and so a known hosted provider gets a
 * better message than an unknown one.
 */
export const offlineRouteRefusal = (
  providerID: string,
  mode: InferenceMode,
): string | undefined => {
  if (mode === "online") return undefined
  if (providerID === OFFLINE_PROVIDER_ID) return undefined
  if (HOSTED_PROVIDERS.has(providerID)) {
    return `Offline mode refuses ${providerID}: it is a hosted provider, and only ${OFFLINE_PROVIDER_ID} may serve an offline session.`
  }
  return `Offline mode refuses ${providerID}: it is not the configured local provider, and offline mode permits only ${OFFLINE_PROVIDER_ID}.`
}

/**
 * Translate the mode into an Ollama model options block.
 *
 * These values are passed on every request rather than being baked into the
 * server, so an online session sharing the same daemon is unaffected.
 */
export const offlineModelOptions = (
  settings: OfflineModelSettings,
): Record<string, string | number> => ({
  // KV cache and prompt ceiling. Lowering this is the cheapest memory win.
  num_ctx: settings.contextTokens,
  // Per-reply generation cap, so one runaway generation cannot fill the window.
  num_predict: settings.maxOutputTokens,
  // Deterministic-ish sampling for code edits. High temperature makes a 4B
  // model rewrite working code that did not need touching.
  temperature: 0.2,
  top_p: 0.9,
  repeat_penalty: 1.05,
})

/** Ollama's idle-unload duration, expressed the way its API expects. */
export const keepAlive = (settings: OfflineModelSettings): string => `${settings.keepAliveMinutes}m`

/**
 * Estimate the resident memory a quantized model needs, given its file size.
 *
 * The weights are the file. On top of that the runtime holds the KV cache,
 * which scales with context, layers and hidden size; rather than model that
 * precisely for one architecture, this uses a conservative per-token figure
 * measured for this model class and documents it as an estimate.
 *
 * The caller must treat this as a planning number, not a measurement.
 */
export const estimateResidentBytes = (input: {
  readonly weightsBytes: number
  readonly contextTokens: number
  /** Measured or estimated KV bytes per token. */
  readonly kvBytesPerToken: number
  /** Runtime overhead: graph, tokenizer, buffers. */
  readonly overheadBytes: number
}): number =>
  input.weightsBytes + input.contextTokens * input.kvBytesPerToken + input.overheadBytes

/**
 * Decide whether a model may be loaded given currently available memory.
 *
 * The headroom is deliberate: macOS needs room to page, the simulator holds a
 * few hundred megabytes of its own, and a machine that is already swapping
 * before the model loads will not recover. Returning false is not a failure of
 * the model; it is the scheduler refusing to make the machine unusable.
 */
export const fitsInMemory = (input: {
  readonly estimatedBytes: number
  /** Memory the OS could hand out without heavy paging. */
  readonly availableBytes: number
  /** Fraction of available memory this workload may claim. */
  readonly maxShare: number
}): boolean => input.estimatedBytes <= input.availableBytes * input.maxShare
