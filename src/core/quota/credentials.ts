import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { redact } from "../util.js"

export interface CredentialCandidate {
  readonly source: string
  readonly key: string
  readonly path?: string
}

export interface CredentialDiscovery {
  readonly candidates: CredentialCandidate[]
  readonly warnings: string[]
}

const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const pickString = (record: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim().length > 0) return value.trim()
  }
  return undefined
}

const plausibleKey = (value: string): boolean => {
  const trimmed = value.trim()
  if (trimmed.length < 16 || trimmed.length > 4096) return false
  if (/\s/.test(trimmed)) return false
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) && !trimmed.startsWith("user_") && !trimmed.startsWith("cmd_")) {
    return false
  }
  return true
}

const parseEnvFile = (text: string): string | undefined => {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!match) continue
    const [, name, rawValue] = match
    if (name !== "COMMAND_CODE_API_KEY" && name !== "COMMANDCODE_API_KEY") continue
    let value = (rawValue ?? "").trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (plausibleKey(value)) return value
  }
  return undefined
}

const parseAuthJson = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined
  const direct = pickString(value, ["apiKey", "key", "access", "token"])
  if (direct && plausibleKey(direct)) return direct

  for (const outer of ["commandcode", "command-code", "commandCode", "command_code"]) {
    const nested = value[outer]
    if (isRecord(nested)) {
      const key = pickString(nested, ["apiKey", "key", "access", "token"])
      if (key && plausibleKey(key)) return key
    }
  }

  for (const outer of ["providers", "auth", "credentials"]) {
    const nested = value[outer]
    if (isRecord(nested)) {
      const entry = nested.commandcode ?? nested["command-code"] ?? nested.commandCode
      if (isRecord(entry)) {
        const key = pickString(entry, ["apiKey", "key", "access", "token"])
        if (key && plausibleKey(key)) return key
      }
    }
  }
  return undefined
}

export const readCredentialFile = (
  path: string,
  warnings: string[],
): CredentialCandidate | undefined => {
  if (!existsSync(path)) return undefined
  try {
    const stat = statSync(path)
    if (!stat.isFile()) {
      warnings.push(`Command Code credential path is not a file: ${path}`)
      return undefined
    }
    if (stat.size > MAX_CREDENTIAL_FILE_BYTES) {
      warnings.push(`Command Code credential file is unexpectedly large: ${path}`)
      return undefined
    }
    // The key is a bearer credential. Refuse group/world-readable files.
    if ((stat.mode & 0o077) !== 0) {
      warnings.push(`Ignoring Command Code credential file with group/world permissions: ${path}`)
      return undefined
    }
    const text = readFileSync(path, "utf8").trim()
    if (!text) return undefined

    let key: string | undefined
    if (text.startsWith("{")) {
      try {
        key = parseAuthJson(JSON.parse(text) as unknown)
      } catch (error) {
        warnings.push(`Could not parse ${path}: ${redact(error instanceof Error ? error.message : String(error))}`)
      }
    } else if (text.includes("=")) {
      key = parseEnvFile(text)
    } else if (plausibleKey(text)) {
      key = text
    }

    if (!key) {
      warnings.push(`No Command Code API key found in ${path}`)
      return undefined
    }
    return { source: path, key, path }
  } catch (error) {
    warnings.push(`Could not read ${path}: ${redact(error instanceof Error ? error.message : String(error))}`)
    return undefined
  }
}

export interface DiscoverCommandCodeInput {
  readonly home?: string
  readonly env?: Record<string, string | undefined>
  readonly explicitPath?: string
  readonly openCodeIntegrationKey?: string
  readonly providerSettingsKey?: string
}

/**
 * Discover a Command Code key that is authorized for the read-only alpha
 * billing surface. The provider API key configured in OpenCode is deliberately
 * last: it can serve inference but may not be authorized for /alpha endpoints.
 *
 * Only the official Command Code host receives any of these values.
 */
export const discoverCommandCodeCredentials = (input: DiscoverCommandCodeInput = {}): CredentialDiscovery => {
  const warnings: string[] = []
  const candidates: CredentialCandidate[] = []
  const seen = new Set<string>()
  const home = input.home ?? homedir()
  const env = input.env ?? process.env

  const add = (candidate: CredentialCandidate | undefined) => {
    if (!candidate || seen.has(candidate.key)) return
    seen.add(candidate.key)
    candidates.push(candidate)
  }

  const envKey = env.COMMAND_CODE_API_KEY?.trim() || env.COMMANDCODE_API_KEY?.trim()
  if (envKey && plausibleKey(envKey)) add({ source: "environment", key: envKey })

  if (input.explicitPath) add(readCredentialFile(input.explicitPath, warnings))

  const defaultFiles = [
    join(home, ".commandcode", "auth.json"),
    join(home, ".config", "opencode", "commandcode.key"),
    join(home, ".config", "opencode", "commandcode.env"),
    join(home, ".config", "opencode", "commandcode.json"),
    join(home, ".local", "share", "opencode", "auth.json"),
  ]
  for (const path of defaultFiles) add(readCredentialFile(path, warnings))

  if (input.openCodeIntegrationKey && plausibleKey(input.openCodeIntegrationKey)) {
    add({ source: "OpenCode integration", key: input.openCodeIntegrationKey })
  }
  if (input.providerSettingsKey && plausibleKey(input.providerSettingsKey)) {
    add({ source: "OpenCode provider settings", key: input.providerSettingsKey })
  }

  return { candidates, warnings }
}
