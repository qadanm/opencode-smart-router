import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { redact } from "../util.js"

/**
 * Credential discovery from the local filesystem.
 *
 * ## Security model
 *
 * This module reads bearer credentials that belong to the user and that the
 * user has already placed on disk for their own tools. It is therefore a
 * *local trust* component, not an authentication component: it never grants
 * access to anything the user could not already reach themselves.
 *
 * Even so, silently harvesting secrets from predictable paths is a pattern
 * that deserves explicit, documented containment, because a router that
 * "finds" credentials automatically is one bad path away from reading
 * something it has no business reading. The rules below are therefore
 * enforced in code, not just described:
 *
 *  1. **Opt-in, never implicit.** Automatic filesystem discovery requires
 *     `credentialSource: "auto"` (or the `SMART_ROUTER_ALLOW_KEY_DISCOVERY`
 *     environment variable). The default is `"explicit"`, which reads only
 *     credentials the user named in configuration or the environment.
 *
 *  2. **No cross-application credential theft.** Only paths that belong to
 *     this router's own configuration directory or to the named provider are
 *     read. Another application's unified credential store (for example
 *     OpenCode's own `auth.json`, which holds OAuth refresh tokens for every
 *     provider the user has connected) is explicitly excluded. Reading it
 *     would mean handling tokens that are not ours, for providers we were
 *     never asked about.
 *
 *  3. **No symlinks, no TOCTOU.** Each file is opened once, with
 *     `O_NOFOLLOW`, and the permission and size checks are applied to the
 *     resulting file descriptor. The previous implementation checked
 *     `statSync(path)` and then read `path`, which allows the path to be
 *     swapped for a symlink between the two calls.
 *
 *  4. **Owner-only permissions.** A file readable by group or world is
 *     refused, because a shared machine could otherwise influence which
 *     credential the router uses.
 *
 *  5. **Bounded reads.** Files are size-capped before a read is attempted and
 *     the descriptor is always closed.
 *
 *  6. **Secrets never leave this module.** A discovered key is returned to the
 *     caller and placed in an `Authorization` header for the provider it
 *     belongs to. It is never logged, never written to the ledger, never
 *     embedded in a decision, a session title, a diagnostic bundle or an
 *     error message. `redact()` is applied to every error string.
 */

export interface CredentialCandidate {
  readonly source: string
  readonly key: string
  readonly path?: string
}

export interface CredentialDiscovery {
  readonly candidates: CredentialCandidate[]
  readonly warnings: string[]
}

/**
 * Whether the router may look for credentials on disk without being told
 * exactly where.
 *
 * - `explicit` (default) reads only configured paths and the environment.
 * - `auto` also reads the provider's own well-known files.
 * - `off` reads nothing from disk at all; the environment and configuration
 *   are the only sources.
 */
export type CredentialSourcePolicy = "explicit" | "auto" | "off"

export const CREDENTIAL_DISCOVERY_ENV = "SMART_ROUTER_ALLOW_KEY_DISCOVERY"

/** Resolve the effective policy, allowing an explicit environment override. */
export const resolveCredentialSourcePolicy = (
  configured: CredentialSourcePolicy | undefined,
  env: Record<string, string | undefined> = process.env,
): CredentialSourcePolicy => {
  if (configured) return configured
  const flag = env[CREDENTIAL_DISCOVERY_ENV]?.trim().toLowerCase()
  if (flag === "1" || flag === "true" || flag === "yes") return "auto"
  return "explicit"
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

/**
 * Read a credential file safely.
 *
 * The file is opened once with `O_NOFOLLOW` and every check runs against the
 * open descriptor, so a path cannot be swapped for a symlink between the
 * permission check and the read. The descriptor is closed on every path out.
 */
export const readCredentialFileWith = (
  path: string,
  warnings: string[],
  options: CredentialFileOptions,
): CredentialCandidate | undefined => {
  let fd: number | undefined
  try {
    // `O_NOFOLLOW` makes a symlink fail with ELOOP rather than being followed.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)

    if (!stat.isFile()) {
      warnings.push(`${options.label} credential path is not a regular file: ${path}`)
      return undefined
    }
    if (stat.size > MAX_CREDENTIAL_FILE_BYTES) {
      warnings.push(`${options.label} credential file is unexpectedly large: ${path}`)
      return undefined
    }
    // The key is a bearer credential. Refuse group/world-readable files, and
    // refuse a file owned by a different user: on a shared machine another
    // account's file must not be able to influence which credential we use.
    if ((stat.mode & 0o077) !== 0) {
      warnings.push(`Ignoring ${options.label} credential file with group/world permissions: ${path}`)
      return undefined
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      warnings.push(`Ignoring ${options.label} credential file owned by another user: ${path}`)
      return undefined
    }
    if (stat.size === 0) return undefined

    // Bounded read from the descriptor that was actually checked.
    const text = readFileSync(fd, "utf8").trim()
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
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === "ENOENT") return undefined
    if (code === "ELOOP") {
      warnings.push(`Ignoring ${options.label} credential path because it is a symlink: ${path}`)
      return undefined
    }
    warnings.push(`Could not read ${path}: ${redact(error instanceof Error ? error.message : String(error))}`)
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Closing a descriptor we already failed to read is not actionable.
      }
    }
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
  /**
   * Whether unwritten-on-disk discovery is permitted. Defaults to reading
   * `SMART_ROUTER_ALLOW_KEY_DISCOVERY`; without it, only the environment and
   * explicitly configured paths are used.
   */
  readonly credentialSource?: CredentialSourcePolicy
}

/**
 * Command Code credential search order.
 *
 * The provider API key configured in OpenCode is deliberately last: it can
 * serve inference but may not be authorized for the `/alpha` endpoints.
 *
 * Note what is *absent*: OpenCode's own `auth.json` is never read. That file is
 * another application's unified credential store and contains OAuth material
 * for every provider the user has connected, not just this one.
 */
export const discoverCommandCodeCredentials = (input: DiscoverCommandCodeInput = {}): CredentialDiscovery => {
  const warnings: string[] = []
  const candidates: CredentialCandidate[] = []
  const seen = new Set<string>()
  const home = input.home ?? homedir()
  const env = input.env ?? process.env
  const policy = resolveCredentialSourcePolicy(input.credentialSource, env)

  const add = (candidate: CredentialCandidate | undefined) => {
    if (!candidate || seen.has(candidate.key)) return
    seen.add(candidate.key)
    candidates.push(candidate)
  }

  const envKey = env.COMMAND_CODE_API_KEY?.trim() || env.COMMANDCODE_API_KEY?.trim()
  if (envKey && plausibleKey(envKey)) add({ source: "environment", key: envKey })

  if (input.explicitPath) add(readCredentialFile(input.explicitPath, warnings))

  if (policy === "off") {
    if (candidates.length === 0) {
      warnings.push(
        "Credential discovery is disabled, so no Command Code key was found. Set COMMAND_CODE_API_KEY or configure an explicit path.",
      )
    }
  } else if (policy === "auto") {
    const defaultFiles = [
      join(home, ".commandcode", "auth.json"),
      join(home, ".config", "opencode", "commandcode.key"),
      join(home, ".config", "opencode", "commandcode.env"),
      join(home, ".config", "opencode", "commandcode.json"),
    ]
    for (const path of defaultFiles) add(readCredentialFile(path, warnings))
  } else if (candidates.length === 0) {
    warnings.push(
      `No Command Code key was supplied. Automatic discovery is off by default; set ${CREDENTIAL_DISCOVERY_ENV}=1 to let the router read ${join(home, ".config", "opencode", "commandcode.key")}, or set COMMAND_CODE_API_KEY.`,
    )
  }

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

export interface DiscoverOpenDesignInput {
  readonly home?: string
  readonly env?: Record<string, string | undefined>
  readonly explicitPath?: string
  readonly providerSettingsKey?: string
  readonly credentialSource?: CredentialSourcePolicy
}

/**
 * Discover the OpenDesign inference key.
 *
 * Only the OpenDesign hosts ever receive this value. The key is never written
 * into a decision, a log, a session title, or a diagnostic bundle.
 */
export const discoverOpenDesignCredentials = (input: DiscoverOpenDesignInput = {}): CredentialDiscovery => {
  const warnings: string[] = []
  const candidates: CredentialCandidate[] = []
  const seen = new Set<string>()
  const home = input.home ?? homedir()
  const env = input.env ?? process.env
  const policy = resolveCredentialSourcePolicy(input.credentialSource, env)

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

  if (policy === "off") {
    if (candidates.length === 0) {
      warnings.push(
        "Credential discovery is disabled, so no OpenDesign key was found. Set OPENDESIGN_API_KEY or configure an explicit path.",
      )
    }
  } else if (policy === "auto") {
    const defaultFiles = [
      join(home, ".config", "opencode", "opendesign.key"),
      join(home, ".config", "opencode", "opendesign.env"),
      join(home, ".config", "opencode", "opendesign.json"),
    ]
    for (const path of defaultFiles) add(readCredentialFileWith(path, warnings, OPENDESIGN_FILE_OPTIONS))
  } else if (candidates.length === 0) {
    warnings.push(
      `No OpenDesign key was supplied. Automatic discovery is off by default; set ${CREDENTIAL_DISCOVERY_ENV}=1 to let the router read ${join(home, ".config", "opencode", "opendesign.key")}, or set OPENDESIGN_API_KEY.`,
    )
  }

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

/**
 * Describe where a resolved credential came from, without revealing it.
 *
 * Diagnostic output needs to answer "did the router find a key, and where from"
 * without ever carrying the secret itself, and without leaking a path beyond
 * the final segment. `source` is caller-supplied for the non-file cases, so it
 * is reduced to a fixed vocabulary rather than echoed: an arbitrary string here
 * would be an unbounded channel into a persisted snapshot note.
 */
export const describeCredentialSource = (candidate: CredentialCandidate | undefined): string => {
  if (!candidate) return "not found"
  if (candidate.path) {
    // Only the final path segment is useful for support and leaks no prefix.
    const base = candidate.path.split("/").pop() ?? "file"
    return `file (${base})`
  }
  switch (candidate.source) {
    case "environment":
      return "environment variable"
    case "OpenCode integration":
      return "OpenCode integration"
    case "OpenCode provider settings":
      return "OpenCode provider settings"
    default:
      // Never echo an unrecognised source string.
      return "configured"
  }
}
