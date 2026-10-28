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
})
