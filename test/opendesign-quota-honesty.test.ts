import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { probeOpenDesignQuota } from "../src/core/quota/opendesign.js"

/**
 * OpenDesign cannot report a verified balance to an inference key.
 *
 * Re-probed on 2026-10-30 against the live gateway: `GET /v1/models` returns 200
 * with the same key, while `/v1/usage`, `/v1/me`, `/v1/credits`, `/v1/billing`,
 * `/v1/account`, `/v1/subscription`, `/v1/limits` and `/v1/quota` all return 404.
 * The inference key is valid and authorized for inference; there is simply no
 * usage surface for it.
 *
 * That makes "estimated" a correctness property, not a cosmetic label: if the
 * router ever reported a confident balance it cannot observe, a user would trust
 * a number that excludes usage from the OpenDesign app and every other client on
 * the same subscription. These tests pin the honest behaviour.
 */

const NOW = Date.UTC(2026, 9, 30, 12)

const openDesignSettings = (overrides: Record<string, unknown> = {}) => ({
  ...structuredClone(DEFAULT_SETTINGS.providers.opendesign)!,
  enabled: true,
  plan: "pro",
  ...overrides,
}) as never

describe("OpenDesign quota honesty", () => {
  it("reports estimated, never verified, with only an inference key", async () => {
    const result = await probeOpenDesignQuota({
      settings: openDesignSettings(),
      apiKey: "sk-a-test-inference-key-value",
      usage: [],
      now: () => NOW,
    })
    expect(result.state).toBe("estimated")
    // `source: "provider"` would claim the provider told us. It did not. Every
    // window is checked, because a single window claiming provider authority is
    // enough to make the estimate look observed.
    expect(result.snapshot.source).toBe("estimate")
    expect(result.snapshot.monthly.source).toBe("estimate")
    expect(result.snapshot.weekly.source).toBe("estimate")
    // The Pro plan has no five-hour window at all, so that slot must be
    // `unknown` rather than an estimate of 0%: reporting 0% of a limit the plan
    // does not have implies a ceiling that cannot be hit.
    expect(result.snapshot.rolling.source).toBe("unknown")
  })

  it("says so in the notes rather than hiding the limitation", async () => {
    const result = await probeOpenDesignQuota({
      settings: openDesignSettings(),
      apiKey: "sk-a-test-inference-key-value",
      usage: [],
      now: () => NOW,
    })
    const notes = result.snapshot.notes.join(" ")
    expect(notes).toMatch(/no quota API/i)
    // The exclusion of other clients is the part users get wrong.
    expect(notes).toMatch(/not visible|lower bound/i)
    expect(notes).toMatch(/margin/i)
  })

  it("never presents the estimate as a full trusted balance", async () => {
    const result = await probeOpenDesignQuota({
      settings: openDesignSettings(),
      apiKey: "sk-a-test-inference-key-value",
      usage: [],
      now: () => NOW,
    })
    // With no local usage the router must still not claim a pristine
    // 100%-available window sourced from the provider.
    expect(result.snapshot.monthly.source).not.toBe("provider")
    expect(result.snapshot.quotaState).not.toBe("verified")
  })

  it("reports unavailable, not estimated, when there is no credential", async () => {
    // An absent key is not a zero balance and must not render as one.
    const result = await probeOpenDesignQuota({
      settings: openDesignSettings(),
      usage: [],
      now: () => NOW,
    })
    expect(result.state).toBe("unavailable")
    expect(result.snapshot.monthly.source).toBe("unknown")
    // And it must not borrow the estimate note, which would imply a computed
    // balance exists.
    expect(result.snapshot.notes.join(" ")).not.toMatch(/Estimated from this router/i)
    // It must tell the user how to proceed instead of implying a zero balance.
    expect(result.snapshot.notes.join(" ")).toMatch(/API key|control key/i)
  })

  it("treats an unresolved plan as unknown capacity rather than a balance", async () => {
    const result = await probeOpenDesignQuota({
      settings: openDesignSettings({ plan: "professional", monthlyCreditsUsd: undefined }),
      apiKey: "sk-a-test-inference-key-value",
      usage: [],
      now: () => NOW,
    })
    expect(result.state).toBe("unknown")
    expect(result.snapshot.plan).toMatch(/^unresolved/)
  })
})
