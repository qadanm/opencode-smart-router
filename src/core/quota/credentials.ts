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
  // Known provider credential prefixes are unambiguous even when they are
  // entirely snake_case, which the placeholder test below would reject.
  if (trimmed.startsWith("sk-") || trimmed.startsWith("vela_")) return true
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) && !trimmed.startsWith("user_") && !trimmed.startsWith("cmd_")) {
    return false
  }
  return true
}

const parseEnvFile = (text: string, envNames: ReadonlyArray<string>): string | undefined => {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!match) continue
    const [, name, rawValue] = match
    if (!name || !envNames.includes(name)) continue
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

const parseAuthJson = (value: unknown, outerKeys: ReadonlyArray<string>): string | undefined => {
  if (!isRecord(value)) return undefined
  const direct = pickString(value, ["apiKey", "key", "access", "token"])
  if (direct && plausibleKey(direct)) return direct

  for (const outer of outerKeys) {
    const nested = value[outer]
    if (isRecord(nested)) {
      const key = pickString(nested, ["apiKey", "key", "access", "token"])
      if (key && plausibleKey(key)) return key
    }
  }

  for (const outer of ["providers", "auth", "credentials"]) {
    const nested = value[outer]
    if (isRecord(nested)) {
      for (const inner of outerKeys) {
        const entry = nested[inner]
        if (isRecord(entry)) {
          const key = pickString(entry, ["apiKey", "key", "access", "token"])
          if (key && plausibleKey(key)) return key
        }
      }
    }
  }
  return undefined
}

export interface CredentialFileOptions {
  /** Environment variable names accepted inside an env-style file. */
  readonly envNames: ReadonlyArray<string>
  /** Top-level and nested object keys accepted inside a JSON file. */
  readonly jsonKeys: ReadonlyArray<string>
  /** Human-readable provider name used in warnings. */
  readonly label: string
}

const COMMAND_CODE_FILE_OPTIONS: CredentialFileOptions = {
  envNames: ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"],
  jsonKeys: ["commandcode", "command-code", "commandCode", "command_code"],
  label: "Command Code",
}

export const readCredentialFileWith = (
  path: string,
  warnings: string[],
  options: CredentialFileOptions,
): CredentialCandidate | undefined => {
  if (!existsSync(path)) return undefined
  try {
    const stat = statSync(path)
    if (!stat.isFile()) {
      warnings.push(`${options.label} credential path is not a file: ${path}`)
      return undefined
    }
    if (stat.size > MAX_CREDENTIAL_FILE_BYTES) {
      warnings.push(`${options.label} credential file is unexpectedly large: ${path}`)
      return undefined
    }
    // The key is a bearer credential. Refuse group/world-readable files.
    if ((stat.mode & 0o077) !== 0) {
      warnings.push(`Ignoring ${options.label} credential file with group/world permissions: ${path}`)
      return undefined
    }
    const text = readFileSync(path, "utf8").trim()
    if (!text) return undefined

    let key: string | undefined
    if (text.startsWith("{")) {
      try {
        key = parseAuthJson(JSON.parse(text) as unknown, options.jsonKeys)
      } catch (error) {
        warnings.push(`Could not parse ${path}: ${redact(error instanceof Error ? error.message : String(error))}`)
      }
    } else if (text.includes("=")) {
      key = parseEnvFile(text, options.envNames)
    } else if (plausibleKey(text)) {
      key = text
    }

    if (!key) {
      warnings.push(`No ${options.label} API key found in ${path}`)
      return undefined
    }
    return { source: path, key, path }
  } catch (error) {
    warnings.push(`Could not read ${path}: ${redact(error instanceof Error ? error.message : String(error))}`)
    return undefined
  }
}

export const readCredentialFile = (
  path: string,
  warnings: string[],
): CredentialCandidate | undefined => readCredentialFileWith(path, warnings, COMMAND_CODE_FILE_OPTIONS)

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

const OPENDESIGN_FILE_OPTIONS: CredentialFileOptions = {
  envNames: ["OPENDESIGN_API_KEY", "OPEN_DESIGN_API_KEY"],
  jsonKeys: ["opendesign", "open-design", "openDesign", "open_design"],
  label: "OpenDesign",
}

/**
 * An OpenDesign inference key is a bearer credential for the model gateway.
 * It cannot read quota, and it is not a control key.
 */
export const plausibleOpenDesignKey = (value: string): boolean => {
  const trimmed = value.trim()
  if (!plausibleKey(trimmed)) return false
  return /^sk-[A-Za-z0-9._-]{8,}$/.test(trimmed)
}

/**
 * Discover the OpenDesign inference key.
 *
 * Only the OpenDesign hosts ever receive this value. The key is never written
 * into a decision, a log, a session title, or a diagnostic bundle.
 */
export const discoverOpenDesignCredentials = (input: {
  readonly home?: string
  readonly env?: Record<string, string | undefined>
  readonly explicitPath?: string
  readonly providerSettingsKey?: string
} = {}): CredentialDiscovery => {
  const warnings: string[] = []
  const candidates: CredentialCandidate[] = []
  const seen = new Set<string>()
  const home = input.home ?? homedir()
  const env = input.env ?? process.env

  const add = (candidate: CredentialCandidate | undefined) => {
    if (!candidate || seen.has(candidate.key)) return
    if (!plausibleOpenDesignKey(candidate.key)) return
    seen.add(candidate.key)
    candidates.push(candidate)
  }

  const envKey = env.OPENDESIGN_API_KEY?.trim() || env.OPEN_DESIGN_API_KEY?.trim()
  if (envKey) {
    if (plausibleOpenDesignKey(envKey)) add({ source: "environment", key: envKey })
    else warnings.push("The OpenDesign environment key does not look like an inference key and was ignored.")
  }

  if (input.explicitPath) add(readCredentialFileWith(input.explicitPath, warnings, OPENDESIGN_FILE_OPTIONS))

  const defaultFiles = [
    join(home, ".config", "opencode", "opendesign.key"),
    join(home, ".config", "opencode", "opendesign.env"),
    join(home, ".config", "opencode", "opendesign.json"),
  ]
  for (const path of defaultFiles) add(readCredentialFileWith(path, warnings, OPENDESIGN_FILE_OPTIONS))

  if (input.providerSettingsKey) add({ source: "OpenCode provider settings", key: input.providerSettingsKey })

  return { candidates, warnings }
}

/**
 * Discover an OpenDesign account-control key.
 *
 * The control key can read the account's coding-plan usage windows. It is a
 * privileged credential, it is never discoverable from the environment, and
 * the router never requests one. It is used only when the owner points at a
 * file explicitly.
 */
export const discoverOpenDesignControlKey = (input: {
  readonly explicitPath?: string
} = {}): CredentialDiscovery => {
  const warnings: string[] = []
  const candidates: CredentialCandidate[] = []
  if (!input.explicitPath) {
    warnings.push(
      "No OpenDesign control key path is configured, so quota is reported as an estimate rather than a verified balance.",
    )
    return { candidates, warnings }
  }
  const candidate = readCredentialFileWith(input.explicitPath, warnings, {
    envNames: ["OPENDESIGN_CONTROL_KEY"],
    jsonKeys: ["opendesign-control", "opendesignControl", "control"],
    label: "OpenDesign control",
  })
  if (candidate) candidates.push(candidate)
  return { candidates, warnings }
}
