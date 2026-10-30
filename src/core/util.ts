import type { ModelKey, ModelRef, TaskTier } from "./types.js"

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const pct = (used: number, total: number) => (total <= 0 ? 0 : clamp((used / total) * 100, 0, 100))

export const monthKey = (at = Date.now()) => {
  const date = new Date(at)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
}

export const usd = (value: number) => {
  if (!Number.isFinite(value)) return "$0.00"
  const abs = Math.abs(value)
  if (abs > 0 && abs < 0.01) return `$${value.toFixed(5)}`
  if (abs < 1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

export const percent = (value: number) => `${value.toFixed(value >= 10 ? 0 : 1)}%`

/** Group an integer with thousands separators, for token counts in prose. */
export const thousands = (value: number) =>
  Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "0"

export const modelKey = (providerID: string, modelID: string): string => `${providerID}/${modelID}`

export const parseModelKey = (key: string): ModelKey => {
  const index = key.indexOf("/")
  if (index <= 0) return { providerID: key, modelID: "" }
  return { providerID: key.slice(0, index), modelID: key.slice(index + 1) }
}

export const keyOfRef = (ref: ModelRef | undefined): string | undefined =>
  ref ? modelKey(ref.providerID, ref.id) : undefined

export const refOfKey = (key: string, variant?: string): ModelRef => {
  const parsed = parseModelKey(key)
  return variant ? { providerID: parsed.providerID, id: parsed.modelID, variant } : { providerID: parsed.providerID, id: parsed.modelID }
}

export const refKey = (ref: ModelRef): string => modelKey(ref.providerID, ref.id)

/**
 * Small, stable hash used only for local diagnostics. It is not a security
 * primitive and must not be used to protect secrets.
 */
export const stableHash = (input: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export const truncate = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`)

export const tierLabel = (tier: TaskTier) =>
  tier === 0 ? "Deterministic" : tier === 1 ? "Economy" : tier === 2 ? "Standard" : "Premium"

export const shaLength = (value: string) => ({ hash: stableHash(value), chars: value.length })

const secretPatterns = [
  /bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(?:sk|user|key|token)-[A-Za-z0-9_-]{12,}/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
]

/** Remove values that look like credentials from diagnostic text. */
export const redact = (value: string): string => {
  let result = value
  for (const pattern of secretPatterns) result = result.replace(pattern, "[redacted]")
  return truncate(result, 500)
}

export const safeError = (error: unknown): string => {
  if (error instanceof Error) return redact(error.message)
  if (typeof error === "string") return redact(error)
  try {
    return redact(JSON.stringify(error))
  } catch {
    return "Unknown error"
  }
}

export const unique = <T>(values: ReadonlyArray<T>): T[] => [...new Set(values)]

export const isImageUri = (uri: string): boolean => {
  const lower = uri.toLowerCase()
  if (lower.startsWith("data:image/")) return true
  return /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)$/i.test(lower)
}

export const isImageName = (name: string | undefined): boolean => {
  if (!name) return false
  return /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)$/i.test(name)
}

export const nowId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
