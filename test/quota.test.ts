import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { probeCommandCodeQuota } from "../src/core/quota/commandcode.js"
import { probeOpenCodeGoQuota } from "../src/core/quota/opencode-go.js"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { discoverCommandCodeCredentials } from "../src/core/quota/credentials.js"

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const providerSettings = DEFAULT_SETTINGS.providers.commandcode!

describe("Command Code quota adapter", () => {
  it("reads provider-reported credits, rolling windows, plan and billing-period usage", async () => {
    const home = mkdtempSync(join(tmpdir(), "router-cc-"))
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("/alpha/whoami")) return json(fixture("commandcode-whoami.json"))
      if (url.includes("/alpha/billing/credits")) return json(fixture("commandcode-credits.json"))
      if (url.includes("/alpha/billing/subscriptions")) return json(fixture("commandcode-subscription.json"))
      if (url.includes("/alpha/usage/summary")) return json(fixture("commandcode-summary.json"))
      return json({ error: "not found" }, 404)
    }
    const result = await probeCommandCodeQuota({
      settings: providerSettings,
      home,
      env: {},
      openCodeIntegrationKey: "user_test_key_that_is_long_enough",
      fetchImpl,
      now: () => Date.UTC(2026, 9, 27, 12, 0, 0),
    })
    const snapshot = result.snapshot
    expect(snapshot.source).toBe("provider")
    expect(snapshot.plan).toBe("GOAT")
    expect(snapshot.planStatus).toBe("active")
    expect(snapshot.monthlyRemainingUsd).toBeCloseTo(44.7413639595, 4)
    expect(snapshot.monthlyGrantUsd).toBeCloseTo(70.4139092338, 4)
    expect(snapshot.monthly.usedPct).toBeCloseTo(36.45, 1)
    expect(snapshot.rolling.usedPct).toBeCloseTo(8.89, 1)
    expect(snapshot.weekly.usedPct).toBeCloseTo(72.17, 1)
    expect(snapshot.rolling.capUsd).toBe(14)
    expect(snapshot.weekly.capUsd).toBe(35)
    expect(snapshot.rolling.resetsAt).toBe(1793138393590)
    expect(snapshot.weekly.resetsAt).toBe(1793428863795)
    expect(snapshot.periodStart).toBe(Date.parse("2026-10-24T06:25:44.000Z"))
    expect(snapshot.extraCredits?.totalUsd).toBe(0)
    expect(snapshot.notes.join(" ")).toContain("Credential source: OpenCode integration")
  })

  it("falls back from an unauthorized environment key to an authorized CLI key", async () => {
    const calls: string[] = []
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.includes("/alpha/whoami")) {
        if (calls.filter((call) => call.includes("/alpha/whoami")).length === 1) return json({ success: false }, 401)
        return json(fixture("commandcode-whoami.json"))
      }
      if (url.includes("/alpha/billing/credits")) return json(fixture("commandcode-credits.json"))
      if (url.includes("/alpha/billing/subscriptions")) return json(fixture("commandcode-subscription.json"))
      if (url.includes("/alpha/usage/summary")) return json(fixture("commandcode-summary.json"))
      return json({}, 404)
    }
    const result = await probeCommandCodeQuota({
      settings: providerSettings,
      home: mkdtempSync(join(tmpdir(), "router-cc-")),
      env: { COMMAND_CODE_API_KEY: "user_bad_environment_key_value" },
      openCodeIntegrationKey: "user_good_integration_key_value",
      fetchImpl,
    })
    expect(result.snapshot.source).toBe("provider")
    expect(result.triedSources).toContain("environment")
    expect(result.triedSources).toContain("OpenCode integration")
  })

  it("fails conservatively when no authorized credential exists", async () => {
    const result = await probeCommandCodeQuota({
      settings: providerSettings,
      home: mkdtempSync(join(tmpdir(), "router-cc-")),
      env: {},
      fetchImpl: async () => json({}, 401),
    })
    expect(result.snapshot.source).toBe("unknown")
    expect(result.snapshot.error).toMatch(/credential/i)
  })

  it("reports rate limiting instead of inventing unlimited quota", async () => {
    const result = await probeCommandCodeQuota({
      settings: providerSettings,
      home: mkdtempSync(join(tmpdir(), "router-cc-")),
      env: {},
      openCodeIntegrationKey: "user_test_key_that_is_long_enough",
      fetchImpl: async () => json({ error: "rate limited" }, 429),
    })
    expect(result.snapshot.source).toBe("unknown")
    expect(result.snapshot.error).toMatch(/rate limited/i)
  })

  it("does not read group/world-readable credential files", () => {
    const home = mkdtempSync(join(tmpdir(), "router-cred-"))
    mkdirSync(join(home, ".config", "opencode"), { recursive: true })
    const path = join(home, ".config", "opencode", "commandcode.key")
    writeFileSync(path, "user_permission_test_key_value", { mode: 0o644 })
    chmodSync(path, 0o644)
    const discovery = discoverCommandCodeCredentials({ home, env: {} })
    expect(discovery.candidates).toHaveLength(0)
    expect(discovery.warnings.join(" ")).toMatch(/permissions/i)
  })

  it("reads an owner-only plain key file", () => {
    const home = mkdtempSync(join(tmpdir(), "router-cred-"))
    mkdirSync(join(home, ".config", "opencode"), { recursive: true })
    const path = join(home, ".config", "opencode", "commandcode.key")
    writeFileSync(path, "user_owner_only_key_value", { mode: 0o600 })
    chmodSync(path, 0o600)
    const discovery = discoverCommandCodeCredentials({ home, env: {} })
    expect(discovery.candidates[0]?.source).toBe(path)
  })

  it("reads the CLI-compatible JSON auth shape", () => {
    const home = mkdtempSync(join(tmpdir(), "router-cred-"))
    const dir = join(home, ".commandcode")
    mkdirSync(dir, { recursive: true })
    const path = join(dir, "auth.json")
    writeFileSync(path, JSON.stringify({ commandcode: { type: "oauth", access: "user_json_auth_key_value" } }), { mode: 0o600 })
    chmodSync(path, 0o600)
    const discovery = discoverCommandCodeCredentials({ home, env: {} })
    expect(discovery.candidates[0]?.key).toBe("user_json_auth_key_value")
  })
})

describe("OpenCode Go quota adapter", () => {
  it("reads provider-reported rolling, weekly and monthly meters", async () => {
    const result = await probeOpenCodeGoQuota({
      accessToken: "oauth_access_token",
      settings: DEFAULT_SETTINGS.providers["opencode-go"]!,
      fetchImpl: async () => json(fixture("opencode-go-usage.json")),
      now: () => Date.UTC(2026, 9, 27, 12, 0, 0),
    })
    expect(result.snapshot.source).toBe("provider")
    expect(result.snapshot.rolling.usedPct).toBe(8)
    expect(result.snapshot.weekly.usedPct).toBe(39)
    expect(result.snapshot.monthly.usedPct).toBe(69)
    expect(result.snapshot.monthly.resetsAt).toBe(Date.parse("2026-11-20T11:37:14.000Z"))
  })

  it("fails conservatively on an expired token", async () => {
    const result = await probeOpenCodeGoQuota({
      accessToken: "expired",
      settings: DEFAULT_SETTINGS.providers["opencode-go"]!,
      fetchImpl: async () => json({ error: "unauthorized" }, 401),
    })
    expect(result.snapshot.source).toBe("unknown")
    expect(result.snapshot.error).toMatch(/401/)
  })

  it("carries retry-after from a rate-limited response", async () => {
    const result = await probeOpenCodeGoQuota({
      accessToken: "token",
      settings: DEFAULT_SETTINGS.providers["opencode-go"]!,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "120" },
        }),
    })
    expect(result.snapshot.source).toBe("unknown")
    expect(result.snapshot.retryAfterMs).toBe(120_000)
  })

  it("rejects an unrecognized usage shape", async () => {
    const result = await probeOpenCodeGoQuota({
      accessToken: "token",
      settings: DEFAULT_SETTINGS.providers["opencode-go"]!,
      fetchImpl: async () => json({ ok: true }),
    })
    expect(result.snapshot.source).toBe("unknown")
    expect(result.snapshot.error).toMatch(/unrecognized/i)
  })
})
