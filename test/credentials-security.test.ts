import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CREDENTIAL_DISCOVERY_ENV,
  describeCredentialSource,
  discoverCommandCodeCredentials,
  discoverOpenDesignControlKey,
  discoverOpenDesignCredentials,
  readCredentialFileWith,
  resolveCredentialSourcePolicy,
  type CredentialFileOptions,
} from "../src/core/quota/credentials.js"

/**
 * Security properties of local credential discovery.
 *
 * This module reads bearer credentials that the user already stores on their
 * own machine. It cannot grant access to anything the user could not reach
 * themselves, but silently harvesting secrets from predictable paths is a
 * dangerous default, so each rule below is enforced in code and asserted here.
 */

const HOUR = 60 * 60 * 1000

const makeHome = () => mkdtempSync(join(tmpdir(), "router-sec-"))

const writeKey = (home: string, relative: string, content: string, mode = 0o600) => {
  const path = join(home, relative)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content, { mode })
  chmodSync(path, mode)
  return path
}

const OPTIONS: CredentialFileOptions = {
  envNames: ["TEST_API_KEY"],
  jsonKeys: ["test"],
  label: "Test",
}

describe("credential discovery is opt-in", () => {
  it("does not touch the filesystem by default", () => {
    const home = makeHome()
    writeKey(home, ".config/opencode/commandcode.key", "user_default_policy_key_val")
    // A caller that says nothing must not get a disk read.
    const discovery = discoverCommandCodeCredentials({ home, env: {} })
    expect(discovery.candidates).toHaveLength(0)
    expect(discovery.warnings.join(" ")).toMatch(new RegExp(CREDENTIAL_DISCOVERY_ENV))
  })

  it("enables discovery when the environment flag is set", () => {
    const home = makeHome()
    const path = writeKey(home, ".config/opencode/commandcode.key", "user_env_flag_key_value")
    const discovery = discoverCommandCodeCredentials({
      home,
      env: { [CREDENTIAL_DISCOVERY_ENV]: "1" },
    })
    expect(discovery.candidates[0]?.path).toBe(path)
  })

  it("accepts an explicit source policy", () => {
    expect(resolveCredentialSourcePolicy("auto", {})).toBe("auto")
    expect(resolveCredentialSourcePolicy("off", {})).toBe("off")
    expect(resolveCredentialSourcePolicy(undefined, {})).toBe("explicit")
    expect(resolveCredentialSourcePolicy(undefined, { [CREDENTIAL_DISCOVERY_ENV]: "true" })).toBe("auto")
  })

  it("reads nothing from disk when discovery is off", () => {
    const home = makeHome()
    writeKey(home, ".config/opencode/commandcode.key", "user_disabled_policy_key_val")
    const discovery = discoverCommandCodeCredentials({
      home,
      env: {},
      credentialSource: "off",
    })
    expect(discovery.candidates).toHaveLength(0)
    expect(discovery.warnings.join(" ")).toMatch(/disabled/i)
  })

  it("still honours the environment and an explicit path when discovery is off", () => {
    const home = makeHome()
    const path = writeKey(home, "keys/cc.key", "user_explicit_path_key_value")
    const fromEnv = discoverCommandCodeCredentials({
      home,
      env: { COMMAND_CODE_API_KEY: "user_environment_key_value" },
      credentialSource: "off",
    })
    expect(fromEnv.candidates[0]?.source).toBe("environment")

    const fromPath = discoverCommandCodeCredentials({
      home,
      env: {},
      credentialSource: "off",
      explicitPath: path,
    })
    expect(fromPath.candidates[0]?.path).toBe(path)
  })
})

describe("no cross-application credential access", () => {
  it("never reads OpenCode's unified auth store", () => {
    // That file holds OAuth material for every provider the user connected,
    // not just the one being probed. Reading it would be credential theft.
    const home = makeHome()
    writeKey(
      home,
      ".local/share/opencode/auth.json",
      JSON.stringify({ commandcode: { type: "oauth", access: "user_other_app_token_value" } }),
    )
    const discovery = discoverCommandCodeCredentials({ home, env: {}, credentialSource: "auto" })
    expect(discovery.candidates).toHaveLength(0)
  })

  it("never reads a foreign provider's token out of a shared store", () => {
    const home = makeHome()
    writeKey(
      home,
      ".local/share/opencode/auth.json",
      JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat-foreign-provider-secret" } }),
    )
    const discovery = discoverOpenDesignCredentials({ home, env: {}, credentialSource: "auto" })
    expect(discovery.candidates).toHaveLength(0)
  })
})

describe("filesystem race and symlink resistance", () => {
  it("refuses a symlinked credential file", () => {
    // A symlink can be swapped in after the router starts, so following one
    // would let a path be repointed at a file the user never intended.
    const home = makeHome()
    const real = writeKey(home, "real.key", "user_symlink_target_key_val")
    const link = join(home, ".config/opencode/commandcode.key")
    mkdirSync(join(home, ".config/opencode"), { recursive: true })
    symlinkSync(real, link)

    const warnings: string[] = []
    expect(readCredentialFileWith(link, warnings, OPTIONS)).toBeUndefined()
    expect(warnings.join(" ")).toMatch(/symlink/i)
  })

  it("checks permissions on the opened file, not a separate stat call", () => {
    // The previous implementation stat'ed the path and then read the path,
    // which allows the path to be replaced in between. The descriptor-based
    // check makes the two observations refer to the same file.
    const home = makeHome()
    const path = writeKey(home, "loose.key", "user_loose_permission_key_val", 0o644)
    const warnings: string[] = []
    expect(readCredentialFileWith(path, warnings, OPTIONS)).toBeUndefined()
    expect(warnings.join(" ")).toMatch(/permissions/i)
  })

  it("refuses a directory", () => {
    const home = makeHome()
    const dir = join(home, "adir")
    mkdirSync(dir, { recursive: true })
    const warnings: string[] = []
    expect(readCredentialFileWith(dir, warnings, OPTIONS)).toBeUndefined()
  })

  it("returns quietly when the file does not exist", () => {
    const home = makeHome()
    const warnings: string[] = []
    expect(readCredentialFileWith(join(home, "nope.key"), warnings, OPTIONS)).toBeUndefined()
    // A missing optional credential is not a warning worth surfacing.
    expect(warnings).toHaveLength(0)
  })

  it("refuses an oversized file before reading it", () => {
    const home = makeHome()
    const path = join(home, "big.key")
    writeFileSync(path, "x".repeat(70 * 1024), { mode: 0o600 })
    chmodSync(path, 0o600)
    const warnings: string[] = []
    expect(readCredentialFileWith(path, warnings, OPTIONS)).toBeUndefined()
    expect(warnings.join(" ")).toMatch(/large/i)
  })

  it("ignores an empty file", () => {
    const home = makeHome()
    const path = join(home, "empty.key")
    writeFileSync(path, "", { mode: 0o600 })
    chmodSync(path, 0o600)
    const warnings: string[] = []
    expect(readCredentialFileWith(path, warnings, OPTIONS)).toBeUndefined()
  })
})

describe("secrets never appear in output", () => {
  it("reports a source without revealing the key", () => {
    const home = makeHome()
    const path = writeKey(home, ".config/opencode/commandcode.key", "user_secret_must_not_leak_1")
    const discovery = discoverCommandCodeCredentials({ home, env: {}, credentialSource: "auto" })
    const candidate = discovery.candidates[0]!

    const described = describeCredentialSource(candidate)
    expect(described).not.toContain(candidate.key)
    expect(described).toContain("commandcode.key")

    // Neither the source description nor any warning may carry the secret.
    expect(discovery.warnings.join(" ")).not.toContain(candidate.key)
    expect(described).not.toContain(path.replace(home, ""))
  })

  it("never includes the key in a warning about the same file", () => {
    const home = makeHome()
    writeKey(home, ".config/opencode/commandcode.key", "user_loose_key_should_not_leak", 0o644)
    const discovery = discoverCommandCodeCredentials({ home, env: {}, credentialSource: "auto" })
    expect(discovery.candidates).toHaveLength(0)
    expect(discovery.warnings.join(" ")).not.toContain("user_loose_key_should_not_leak")
  })

  it("redacts a parse error without echoing file contents", () => {
    const home = makeHome()
    writeKey(home, "bad.json", '{"test": {"key": "user_broken_secret_value"')
    const warnings: string[] = []
    expect(readCredentialFileWith(join(home, "bad.json"), warnings, OPTIONS)).toBeUndefined()
    expect(warnings.join(" ")).not.toContain("user_broken_secret_value")
  })
})

describe("privileged control keys", () => {
  it("is never discoverable implicitly", () => {
    // The control key can read billing state. It must require an explicit
    // path, and must never be picked up from the environment or a scan.
    const home = makeHome()
    writeKey(home, ".config/opencode/opendesign-control.key", "sk-control-key-should-not-be-found")
    const discovery = discoverOpenDesignControlKey({})
    expect(discovery.candidates).toHaveLength(0)
    expect(discovery.warnings.join(" ")).toMatch(/estimate/i)
  })

  it("reads only when pointed at a file explicitly", () => {
    const home = makeHome()
    const path = writeKey(home, "control.key", "sk-control-explicitly_configured_key")
    const discovery = discoverOpenDesignControlKey({ explicitPath: path })
    expect(discovery.candidates[0]?.path).toBe(path)
  })
})

describe("key shape validation", () => {
  it("rejects an OpenDesign value that is not an inference key", () => {
    const discovery = discoverOpenDesignCredentials({
      home: makeHome(),
      env: { OPENDESIGN_API_KEY: "sk-" },
      credentialSource: "off",
    })
    expect(discovery.candidates).toHaveLength(0)
    expect(discovery.warnings.join(" ")).toMatch(/does not look like/i)
  })

  it("accepts a well-formed OpenDesign inference key from the environment", () => {
    const discovery = discoverOpenDesignCredentials({
      home: makeHome(),
      env: { OPENDESIGN_API_KEY: "sk-abcdefghijklmnop1234" },
      credentialSource: "off",
    })
    expect(discovery.candidates).toHaveLength(1)
    expect(discovery.candidates[0]!.source).toBe("environment")
  })
})
