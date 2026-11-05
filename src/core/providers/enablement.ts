import type { RouterSettings } from "../types.js"

/**
 * Credential-aware provider defaults.
 *
 * The old behaviour enabled every provider the project shipped, whether or not
 * the user had an account. A stranger installing the router got "Command Code:
 * authentication is failing" on first run, for an account they never claimed,
 * and a producer of warnings they could not act on.
 *
 * The rule now: a provider is enabled when this machine has a credential for it,
 * and disabled when it does not — unless the user said otherwise. Explicit
 * configuration always wins, in both directions, because detection is a
 * convenience and a config file is an instruction.
 *
 * Everything here is pure. The caller gathers evidence (filesystem, credentials,
 * network probes) and this decides. That split is what lets a user see the list
 * before anything changes, and what makes the rule testable without a machine.
 */

export interface ProviderEvidence {
  readonly providerID: string
  readonly hasCredential: boolean
  /**
   * Where the credential was found, for display. Never the value itself — the
   * router reports provenance, not secrets.
   */
  readonly source?: string
}

export interface EnablementChange {
  readonly providerID: string
  readonly from: boolean
  readonly to: boolean
  readonly reason: string
}

export interface EnablementResult {
  readonly settings: RouterSettings
  readonly changes: ReadonlyArray<EnablementChange>
  /** Providers that stayed on despite no credential, because the user asked. */
  readonly keptOnByChoice: ReadonlyArray<string>
  /** Providers that stayed off despite a credential, because the user asked. */
  readonly keptOffByChoice: ReadonlyArray<string>
}

export const applyCredentialDefaults = (
  settings: RouterSettings,
  explicit: ReadonlySet<string>,
  evidence: ReadonlyArray<ProviderEvidence>,
): EnablementResult => {
  const byProvider = new Map(evidence.map((entry) => [entry.providerID, entry]))
  const changes: EnablementChange[] = []
  const keptOnByChoice: string[] = []
  const keptOffByChoice: string[] = []
  const providers: Record<string, (typeof settings.providers)[string]> = { ...settings.providers }

  for (const [providerID, provider] of Object.entries(settings.providers)) {
    const found = byProvider.get(providerID)
    // No evidence gathered for this provider: leave it exactly as configured.
    // Silence is not evidence of absence, and guessing here is how a working
    // install gets broken by an upgrade.
    if (!found) continue

    const wanted = found.hasCredential
    const is = provider.enabled

    if (explicit.has(providerID)) {
      // The user set this. Record the disagreement for the panel, change nothing.
      if (wanted && !is) keptOffByChoice.push(providerID)
      if (!wanted && is) keptOnByChoice.push(providerID)
      continue
    }

    if (wanted === is) continue

    providers[providerID] = { ...provider, enabled: wanted }
    changes.push({
      providerID,
      from: is,
      to: wanted,
      reason: wanted
        ? `credential found${found.source ? ` (${found.source})` : ""}`
        : "no credential found on this machine",
    })
  }

  return {
    settings: changes.length > 0 ? { ...settings, providers } : settings,
    changes,
    keptOnByChoice,
    keptOffByChoice,
  }
}

/**
 * One sentence per change, for the settings warnings the panel and
 * `/router-status` both read. Written so a user can tell what happened and what
 * to do about it, and so nothing changes silently.
 */
export const describeEnablement = (result: EnablementResult): ReadonlyArray<string> =>
  result.changes.map((change) =>
    change.to
      ? `providers.${change.providerID} enabled: ${change.reason}`
      : `providers.${change.providerID} disabled: ${change.reason}. Set providers.${change.providerID}.enabled to true to force it on.`,
  )

/**
 * Where a credential for this provider may live, without reading it.
 *
 * Existence is enough to answer "does this machine have an account?", and
 * checking existence is deliberately weaker than reading the value: detection
 * must never need to see a secret to decide whether a provider is usable.
 */
export const credentialFileCandidates = (providerID: string, home: string): ReadonlyArray<string> => {
  const at = (path: string) => `${home}/${path}`
  switch (providerID) {
    case "commandcode":
      return [
        at(".commandcode/auth.json"),
        at(".config/opencode/commandcode.key"),
        at(".config/opencode/commandcode.env"),
        at(".config/opencode/commandcode.json"),
      ]
    case "opendesign":
      return [at(".config/opencode/opendesign.key"), at(".config/opencode/opendesign.json")]
    default:
      return []
  }
}

export const credentialEnvVars = (providerID: string): ReadonlyArray<string> => {
  switch (providerID) {
    case "commandcode":
      return ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"]
    case "opendesign":
      return ["OPENDESIGN_API_KEY", "OPEN_DESIGN_API_KEY"]
    case "opencode-go":
      return ["OPENCODE_API_KEY"]
    default:
      return []
  }
}
