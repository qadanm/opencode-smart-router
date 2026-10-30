import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/core/config.js"
import { QuotaService } from "../src/core/quota/service.js"

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

describe("quota service", () => {
  it("honours a provider retry-after instead of the default backoff", async () => {
    let now = Date.UTC(2026, 9, 27, 12, 0, 0)
    let calls = 0
    const service = new QuotaService({
      getSettings: () => DEFAULT_SETTINGS.providers as any,
      getCredentials: async () => ({ goAccessToken: "token" }),
      probeIntervalMinutes: 5,
      fetchImpl: async () => {
        calls += 1
        return json({ error: "rate limited" }, 429, { "retry-after": "120" })
      },
      now: () => now,
    })

    await service.refresh("opencode-go")
    expect(calls).toBe(1)
    now += 60_000
    await service.refresh("opencode-go")
    expect(calls).toBe(1)
  })

  it("makes one provider request for concurrent refreshes", async () => {
    let calls = 0
    let release: ((response: Response) => void) | undefined
    const service = new QuotaService({
      getSettings: () => DEFAULT_SETTINGS.providers as any,
      getCredentials: async () => ({ goAccessToken: "token" }),
      probeIntervalMinutes: 5,
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          calls += 1
          release = resolve
        }),
      now: () => Date.UTC(2026, 9, 27, 12, 0, 0),
    })

    const first = service.refresh("opencode-go")
    const second = service.refresh("opencode-go")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toBe(1)
    release?.(
      json({
        usage: {
          rolling: { percent: 8 },
          weekly: { percent: 39 },
          monthly: { percent: 69 },
        },
      }),
    )
    await Promise.all([first, second])
  })

  it("does not probe a disabled provider", async () => {
    let calls = 0
    const service = new QuotaService({
      getSettings: () =>
        ({
          ...DEFAULT_SETTINGS.providers,
          "opencode-go": { ...DEFAULT_SETTINGS.providers["opencode-go"]!, enabled: false },
        }) as any,
      getCredentials: async () => ({ goAccessToken: "token" }),
      probeIntervalMinutes: 5,
      fetchImpl: async () => {
        calls += 1
        return json({})
      },
    })
    await service.refresh("opencode-go")
    expect(calls).toBe(0)
  })

/**
 * The OpenDesign quota estimate is only as honest as the history the probe is
 * given, and that history is not whatever the caller happens to hold in memory.
 *
 * Once the raw event array overflows, older events are folded into hourly
 * buckets. A caller that asks for no window receives the raw array alone, so
 * the estimate shrinks as history ages and the router describes a busy paid
 * subscription as nearly untouched. That is a fail-open measurement: the more
 * you have spent, the more headroom it claims you have.
 *
 * These pin the request, not just the summing, because the summing was already
 * correct and the bug lived entirely in what the caller asked for.
 */
describe("the quota probe requests enough history to be complete", () => {
  it("asks for a window wide enough to cover the longest modelled allowance", async () => {
    let asked: { since: number; until?: number } | undefined
    const now = Date.UTC(2026, 9, 30, 12, 0, 0)
    const service = new QuotaService({
      getSettings: () =>
        ({
          ...DEFAULT_SETTINGS.providers,
          opendesign: { ...(DEFAULT_SETTINGS.providers as any).opendesign, enabled: true },
        }) as any,
      getCredentials: async () => ({}),
      getUsageEvents: (window) => {
        asked = window
        return []
      },
      probeIntervalMinutes: 5,
      fetchImpl: async () => json({}),
      now: () => now,
    })

    await service.refresh("opendesign")
    expect(asked).toBeDefined()
    // Thirty days is the widest window the estimator models. Asking for less
    // silently drops folded history from the monthly total.
    const spanDays = (now - (asked as any).since) / 86_400_000
    expect(spanDays).toBeGreaterThanOrEqual(30)
    expect((asked as any).until).toBe(now)
  })

  it("does not ask for any history when the provider does not model it", async () => {
    let asked = 0
    const service = new QuotaService({
      getSettings: () => DEFAULT_SETTINGS.providers as any,
      getCredentials: async () => ({ goAccessToken: "token" }),
      getUsageEvents: () => {
        asked += 1
        return []
      },
      probeIntervalMinutes: 5,
      fetchImpl: async () =>
        json({ usage: { rolling: { percent: 8 }, weekly: { percent: 39 }, monthly: { percent: 69 } } }),
      now: () => Date.UTC(2026, 9, 30, 12, 0, 0),
    })
    await service.refresh("opencode-go")
    // Provider-reported quotas do not read local history at all.
    expect(asked).toBe(0)
  })
})
})
