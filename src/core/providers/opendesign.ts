import type { FailureClass } from "../types.js"
import { redact } from "../util.js"
import {
  OPENDESIGN_FALLBACK_CONTEXT,
  OPENDESIGN_FALLBACK_OUTPUT,
  OPEN_DESIGN_MODEL_BY_ID,
} from "./opendesign-models.js"

/**
 * OpenDesign provider adapter.
 *
 * The adapter owns three things and nothing else:
 *
 *  1. Base URL and protocol handling for the OpenAI-compatible gateway.
 *  2. Read-only model discovery from `GET /v1/models`.
 *  3. Error and size normalization.
 *
 * It never performs inference. OpenCode owns the inference call, so this
 * adapter only makes read-only metadata requests, which consume no plan
 * credits.
 */

export const OPENDESIGN_PROVIDER_ID = "opendesign"

/** Documented OpenAI-compatible gateway. The path already contains `/v1`. */
export const OPENDESIGN_DEFAULT_BASE_URL = "https://amr-link.open-design.ai/v1"

/** Undocumented account-control host. Only used with an explicitly supplied control key. */
export const OPENDESIGN_DEFAULT_CONTROL_BASE_URL = "https://amr-api.open-design.ai/api"

/** OpenDesign documents a 50 MiB limit for the entire request body. */
export const OPENDESIGN_MAX_REQUEST_BYTES = 50 * 1024 * 1024

export const OPENDESIGN_DISCOVERY_TIMEOUT_MS = 15_000
export const OPENDESIGN_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const OPENDESIGN_USER_AGENT = "opencode-smart-router/0.1"

export type OpenDesignProtocol = "chat-completions" | "responses" | "messages"

export const OPENDESIGN_PROTOCOLS: ReadonlyArray<OpenDesignProtocol> = [
  "chat-completions",
  "responses",
  "messages",
]

/**
 * OpenDesign issue #8687 reports that the Anthropic-messages endpoint drops
 * reasoning for `deepseek-v4.1-flash`, so agents stop with `end_turn` and no
 * tool call. The OpenAI chat-completions endpoint is unaffected. The router
 * therefore refuses the messages protocol for these models unless the owner
 * explicitly overrides it.
 */
export const OPENDESIGN_MESSAGES_UNSAFE_MODELS: ReadonlySet<string> = new Set(["deepseek-v4.1-flash"])

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"

/**
 * Normalize a configured gateway base URL.
 *
 * The path must never gain a second `/v1`. A URL that already ends in `/v1`
 * is kept as-is, a bare host gets `/v1` appended, and anything else is left
 * alone so a versioned path such as `/v1beta` survives.
 */
export const normalizeOpenDesignBaseURL = (raw?: string): string => {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) return OPENDESIGN_DEFAULT_BASE_URL
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return OPENDESIGN_DEFAULT_BASE_URL
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
    return OPENDESIGN_DEFAULT_BASE_URL
  }
  let path = parsed.pathname.replace(/\/+$/, "")
  if (path === "") path = "/v1"
  parsed.pathname = path
  parsed.search = ""
  parsed.hash = ""
  return parsed.toString().replace(/\/+$/, "")
}

export const openDesignModelsEndpoint = (baseURL: string) => `${normalizeOpenDesignBaseURL(baseURL)}/models`

export const openDesignInferenceEndpoint = (baseURL: string, protocol: OpenDesignProtocol) => {
  const base = normalizeOpenDesignBaseURL(baseURL)
  switch (protocol) {
    case "responses":
      return `${base}/responses`
    case "messages":
      return `${base}/messages`
    default:
      return `${base}/chat/completions`
  }
}

export const openDesignControlEndpoint = (controlBaseURL: string, path: string) => {
  const base = (controlBaseURL ?? "").trim().replace(/\/+$/, "") || OPENDESIGN_DEFAULT_CONTROL_BASE_URL
  const suffix = path.startsWith("/") ? path : `/${path}`
  return `${base}${suffix}`
}

/**
 * Normalize the account-control base URL. Only https is accepted for a
 * remote host, because the control key is a privileged credential. A loopback
 * http URL is allowed so an isolated lab can exercise the verified path
 * without touching a real account.
 */
export const normalizeOpenDesignControlBaseURL = (raw?: string): string => {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) return OPENDESIGN_DEFAULT_CONTROL_BASE_URL
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
      return OPENDESIGN_DEFAULT_CONTROL_BASE_URL
    }
    let path = parsed.pathname.replace(/\/+$/, "")
    if (path === "") path = "/api"
    parsed.pathname = path
    parsed.search = ""
    parsed.hash = ""
    return parsed.toString().replace(/\/+$/, "")
  } catch {
    return OPENDESIGN_DEFAULT_CONTROL_BASE_URL
  }
}

export const failureClassForStatus = (status: number): FailureClass => {
  if (status === 401) return "auth"
  if (status === 403) return "auth"
  if (status === 429) return "rate_limit"
  if (status === 404) return "capability"
  if (status === 413) return "invalid_request"
  if (status >= 500) return "provider_outage"
  if (status >= 400) return "invalid_request"
  return "unknown"
}

/** Describe an oversized request without sending it. */
export const openDesignRequestSizeError = (bytes: number): string | undefined => {
  if (!Number.isFinite(bytes) || bytes <= OPENDESIGN_MAX_REQUEST_BYTES) return undefined
  const mib = (bytes / 1024 / 1024).toFixed(1)
  return `Request body is ${mib} MiB, above the OpenDesign 50 MiB limit for the entire request.`
}

export interface OpenDesignDiscoveredModel {
  readonly id: string
  readonly name: string
  /** Vendor context limit reported by the gateway. */
  readonly contextLimit: number
  /** Usable input budget reported by the gateway. Absent when unknown. */
  readonly contextBudget?: number
  /** Maximum output tokens reported by the gateway. Absent when unknown. */
  readonly outputBudget?: number
  readonly inputModalities: ReadonlyArray<string>
  readonly outputModalities: ReadonlyArray<string>
  readonly capability?: string
  readonly priceTier?: string
  readonly enabled: boolean
  readonly default: boolean
}

export interface OpenDesignDiscoveryResult {
  readonly ok: boolean
  readonly models: ReadonlyArray<OpenDesignDiscoveredModel>
  readonly error?: string
  readonly status?: number
  readonly failureClass?: FailureClass
  readonly retryAfterMs?: number
  readonly fetchedAt: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/

/** Map gateway modality names onto the router's modality vocabulary. */
export const normalizeModality = (value: string): string => {
  const lower = value.trim().toLowerCase()
  switch (lower) {
    case "image":
    case "images":
      return "image"
    case "file":
    case "files":
    case "pdf":
      return "pdf"
    case "audio":
      return "audio"
    case "video":
      return "video"
    case "text":
    default:
      return "text"
  }
}

const parseModel = (value: unknown): OpenDesignDiscoveredModel | undefined => {
  if (!isRecord(value)) return undefined
  const id = typeof value.id === "string" ? value.id.trim() : ""
  if (!id || !MODEL_ID_PATTERN.test(id)) return undefined
  const architecture = isRecord(value.architecture) ? value.architecture : undefined
  const metadata = isRecord(value.metadata) ? value.metadata : undefined
  const rawInput = Array.isArray(architecture?.input_modalities)
    ? (architecture!.input_modalities as unknown[]).filter((item): item is string => typeof item === "string")
    : []
  const rawOutput = Array.isArray(architecture?.output_modalities)
    ? (architecture!.output_modalities as unknown[]).filter((item): item is string => typeof item === "string")
    : []
  const inputModalities = rawInput.length > 0 ? [...new Set(rawInput.map(normalizeModality))] : ["text"]
  const outputModalities = rawOutput.length > 0 ? [...new Set(rawOutput.map(normalizeModality))] : ["text"]
  const contextLimit = Number(metadata?.context_limit)
  const contextBudget = Number(metadata?.context_budget)
  const outputBudget = Number(metadata?.output_budget)
  return {
    id,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : id,
    contextLimit: Number.isFinite(contextLimit) && contextLimit > 0 ? contextLimit : 0,
    ...(Number.isFinite(contextBudget) && contextBudget > 0 ? { contextBudget } : {}),
    ...(Number.isFinite(outputBudget) && outputBudget > 0 ? { outputBudget } : {}),
    inputModalities,
    outputModalities,
    ...(typeof metadata?.capability === "string" ? { capability: metadata.capability } : {}),
    ...(typeof metadata?.cost === "string" ? { priceTier: metadata.cost } : {}),
    enabled: value.enabled !== false,
    default: value.default === true,
  }
}

/**
 * Read the account's entitled model list from the gateway.
 *
 * This is a read-only metadata call. It consumes no plan credits and makes no
 * inference request.
 */
export const discoverOpenDesignModels = async (input: {
  readonly baseURL?: string
  readonly apiKey: string
  readonly fetchImpl?: FetchLike
  readonly now?: () => number
  readonly timeoutMs?: number
}): Promise<OpenDesignDiscoveryResult> => {
  const now = input.now?.() ?? Date.now()
  const fetchImpl = input.fetchImpl ?? fetch
  if (!input.apiKey) {
    return { ok: false, models: [], error: "No OpenDesign API key is available", fetchedAt: now }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? OPENDESIGN_DISCOVERY_TIMEOUT_MS)
  try {
    const response = await fetchImpl(openDesignModelsEndpoint(input.baseURL ?? ""), {
      method: "GET",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        accept: "application/json",
        "user-agent": OPENDESIGN_USER_AGENT,
      },
      redirect: "error",
      signal: controller.signal,
    })
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"))
      const retryAfterMs =
        Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter * 1000, 15 * 60_000) : undefined
      return {
        ok: false,
        models: [],
        error: `Model discovery returned HTTP ${response.status}`,
        status: response.status,
        failureClass: failureClassForStatus(response.status),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        fetchedAt: now,
      }
    }
    const text = await response.text()
    if (text.length > OPENDESIGN_MAX_RESPONSE_BYTES) {
      return {
        ok: false,
        models: [],
        error: "Model discovery response was unexpectedly large",
        failureClass: "invalid_request",
        fetchedAt: now,
      }
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return {
        ok: false,
        models: [],
        error: "Model discovery returned a malformed response",
        failureClass: "invalid_request",
        fetchedAt: now,
      }
    }
    const rows = isRecord(body) && Array.isArray(body.data) ? body.data : undefined
    if (!rows) {
      return {
        ok: false,
        models: [],
        error: "Model discovery response did not contain a model list",
        failureClass: "invalid_request",
        fetchedAt: now,
      }
    }
    const models = rows
      .map(parseModel)
      .filter((model): model is OpenDesignDiscoveredModel => Boolean(model))
      .filter((model) => model.enabled)
    return { ok: true, models, fetchedAt: now }
  } catch (error) {
    return {
      ok: false,
      models: [],
      error: controller.signal.aborted
        ? "Model discovery timed out"
        : redact(error instanceof Error ? error.message : String(error)),
      failureClass: controller.signal.aborted ? "network" : "network",
      fetchedAt: now,
    }
  } finally {
    clearTimeout(timer)
  }
}

export interface OpenDesignLiveModel {
  readonly id: string
  readonly providerID: string
  readonly name: string
  readonly limit: { readonly context: number; readonly output: number }
  readonly capabilities: {
    readonly tools: boolean
    readonly input: ReadonlyArray<string>
    readonly output: ReadonlyArray<string>
  }
  readonly cost: ReadonlyArray<{ input: number; output: number; cache: { read: number; write: number } }>
  readonly enabled: boolean
}

/**
 * Models whose real input ceiling has been measured against the live gateway
 * and found to be the vendor `context_limit`, not the advisory
 * `context_budget`.
 *
 * `context_budget` is not a hard input limit. It is metadata describing the
 * share one deployment expects to serve, and the gateway does not enforce it.
 * Measured on 2026-10-30 with single-request probes on `deepseek-v4.1-flash`
 * (`max_tokens: 1`, synthetic unique filler, so nothing could be prefix-cached):
 *
 *   355,588 tokens -> 200      753,476 tokens -> 200
 *   999,593 tokens -> 200    1,043,337 tokens -> 200
 *   ~1,060,000 tokens -> 400 context_length_exceeded
 *
 * The enforced ceiling is therefore the vendor limit of 1,048,000, confirmed on
 * both sides of the boundary. The total cost of the probes was $0.006.
 *
 * This is deliberately a per-model allowlist and not a blanket rule. Only one
 * model has been measured; the others keep the conservative budget reading,
 * because assuming a larger window than a provider accepts fails mid-session
 * with an opaque rejection. Extending this set requires its own probe.
 */
export const VERIFIED_FULL_WINDOW_MODELS: ReadonlySet<string> = new Set([
  "deepseek-v4.1-flash",
])

/**
 * Convert gateway discovery into the router's live-model shape so the model
 * registry merges gateway metadata over the curated seed.
 *
 * The window the router uses is the largest one the gateway is known to accept,
 * which is not always `context_budget`:
 *
 *  - For a model in `VERIFIED_FULL_WINDOW_MODELS`, the vendor `context_limit`
 *    has been measured as the real ceiling, so the advisory budget is ignored.
 *    On `deepseek-v4.1-flash` this is the difference between 328,000 and
 *    1,048,000, and treating the budget as binding discarded roughly 716,000
 *    usable tokens.
 *  - For every other model the budget is still used, because it is the only
 *    claim the gateway makes and it has not been tested.
 *
 * `context_budget` is not always present. `minimax-m3.1-flash` reports only
 * `context_limit: 1000000`. The fallback for that case used to be a
 * hand-written 232k guess, which is not a property of the model: it made a
 * live session's 309k context look four times larger than the model ever
 * was, pushed the session off the cheap provider, and then failed closed
 * because no provider was left that could serve it.
 *
 * The gateway's own `context_limit` is the correct fallback, and it is an upper
 * bound in every case, so a reported budget can never exceed the vendor limit
 * it lives inside.
 */
export const toLiveModels = (
  discovered: ReadonlyArray<OpenDesignDiscoveredModel>,
  providerID = OPENDESIGN_PROVIDER_ID,
): OpenDesignLiveModel[] => {
  const out: OpenDesignLiveModel[] = []
  for (const model of discovered) {
    const spec = OPEN_DESIGN_MODEL_BY_ID.get(model.id)
    const vendorLimit = model.contextLimit > 0 ? model.contextLimit : 0
    const measured = VERIFIED_FULL_WINDOW_MODELS.has(model.id)
    const reported = measured ? vendorLimit : (model.contextBudget ?? vendorLimit)
    // A reported window can never be larger than the vendor limit it lives
    // inside, whichever claim produced it.
    const context =
      reported > 0 && (vendorLimit === 0 || reported <= vendorLimit)
        ? reported
        : vendorLimit > 0
          ? vendorLimit
          : (spec?.context ?? OPENDESIGN_FALLBACK_CONTEXT)
    const output = model.outputBudget ?? spec?.maxOutput ?? OPENDESIGN_FALLBACK_OUTPUT
    const cost = spec?.cost ?? [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
    out.push({
      id: model.id,
      providerID,
      name: model.name,
      limit: { context, output },
      capabilities: {
        tools: true,
        input: model.inputModalities,
        output: model.outputModalities,
      },
      cost: cost.map((tier) => ({
        input: tier.input,
        output: tier.output,
        cache: { read: tier.cache?.read ?? 0, write: tier.cache?.write ?? 0 },
      })),
      enabled: model.enabled,
    })
  }
  return out
}

/**
 * Reject a protocol that is known to break specific models.
 */
export const protocolWarning = (
  protocol: OpenDesignProtocol,
  modelIDs: ReadonlyArray<string>,
): string | undefined => {
  if (protocol !== "messages") return undefined
  const risky = modelIDs.filter((id) => OPENDESIGN_MESSAGES_UNSAFE_MODELS.has(id))
  if (risky.length === 0) return undefined
  return `The Anthropic-messages protocol is reported to drop reasoning for ${risky.join(", ")} (OpenDesign issue #8687), which stalls agents that rely on tool calls. Use chat-completions instead.`
}

/** Build the OpenCode provider entry that points OpenCode at OpenDesign. */
export const openDesignProviderConfigTemplate = (input: {
  readonly providerID?: string
  readonly baseURL?: string
  readonly apiKeyEnv?: string
  readonly modelIDs?: ReadonlyArray<string>
}): Record<string, unknown> => {
  const providerID = input.providerID ?? OPENDESIGN_PROVIDER_ID
  const baseURL = normalizeOpenDesignBaseURL(input.baseURL)
  const apiKeyEnv = input.apiKeyEnv ?? "OPENDESIGN_API_KEY"
  const models = (input.modelIDs ?? []).map((id) => ({ id, name: id }))
  return {
    [providerID]: {
      name: "OpenDesign Go",
      package: "@opencode/ai/providers/openai-compatible",
      options: {
        baseURL,
        apiKey: `{env:${apiKeyEnv}}`,
      },
      ...(models.length > 0 ? { models } : {}),
    },
  }
}
