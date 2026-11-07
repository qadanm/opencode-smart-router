import { describe, expect, it, vi } from "vitest"

import { containHook, withDeadline } from "../src/server/containment.js"

/**
 * OpenCode does not defend itself against a plugin hook.
 *
 * Verified against a real OpenCode 2.2.5 process (scripts/isolated-e2e.sh):
 * a hook that throws fails the prompt with a 500, and a hook that never settles
 * leaves the editor waiting with no way out. Neither is acceptable, and neither
 * can be fixed by the host on our behalf, so the boundary has to be here.
 *
 * These tests hold the two properties the boundary must have: it returns, and
 * it does not throw, whatever happens downstream.
 */
describe("containHook", () => {
  it("absorbs a thrown defect so the host still serves the prompt", async () => {
    const onContained = vi.fn()
    const hook = containHook(
      () => {
        throw new TypeError("this.ledger.planPoolSpent is not a function")
      },
      { label: "prompt", onContained },
    )

    await expect(hook({ sessionID: "ses_1" })).resolves.toBeUndefined()
    expect(onContained).toHaveBeenCalledOnce()
    expect(String(onContained.mock.calls[0]?.[0])).toContain("planPoolSpent")
  })

  it("absorbs a rejected promise, not only a synchronous throw", async () => {
    const onContained = vi.fn()
    const hook = containHook(async () => Promise.reject(new Error("async defect")), {
      label: "prompt",
      onContained,
    })

    await expect(hook({})).resolves.toBeUndefined()
    expect(onContained).toHaveBeenCalledOnce()
  })

  it("lets a deliberate refusal through when blocking is allowed", async () => {
    class RouterBlockedError extends Error {
      name = "RouterBlockedError"
    }
    const hook = containHook(
      () => {
        throw new RouterBlockedError("Smart Router blocked this prompt")
      },
      { label: "prompt", allowBlocked: true },
    )

    await expect(hook({})).rejects.toThrow("blocked this prompt")
  })

  it("absorbs a deliberate refusal when blocking is not allowed", async () => {
    class RouterBlockedError extends Error {
      name = "RouterBlockedError"
    }
    const hook = containHook(
      () => {
        throw new RouterBlockedError("Smart Router blocked this prompt")
      },
      { label: "prompt", allowBlocked: false },
    )

    await expect(hook({})).resolves.toBeUndefined()
  })

  it("survives a diagnostic sink that itself throws", async () => {
    const hook = containHook(
      () => {
        throw new Error("primary defect")
      },
      {
        label: "prompt",
        onContained: () => {
          throw new Error("the reporter is also broken")
        },
      },
    )

    await expect(hook({})).resolves.toBeUndefined()
  })
})

describe("withDeadline", () => {
  it("returns the work when it finishes in time", async () => {
    const result = await withDeadline({
      work: async () => "routed",
      ms: 1000,
      onTimeout: () => undefined,
    })
    expect(result).toBe("routed")
  })

  it("gives up on work that never settles, so the prompt is not held", async () => {
    const onTimeout = vi.fn()
    const result = await withDeadline({
      work: () => new Promise(() => {}),
      ms: 30,
      onTimeout,
    })
    expect(result).toBeUndefined()
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it("reports a timeout when the work is merely slow", async () => {
    const onTimeout = vi.fn()
    const result = await withDeadline({
      work: () => new Promise((resolve) => setTimeout(() => resolve("late"), 200)),
      ms: 30,
      onTimeout,
    })
    expect(result).toBeUndefined()
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it("does not leave a rejection unhandled when the deadline already won", async () => {
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown) => rejections.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      const result = await withDeadline({
        work: () => new Promise((_, reject) => setTimeout(() => reject(new Error("late failure")), 60)),
        ms: 20,
        onTimeout: () => undefined,
      })
      expect(result).toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(rejections).toHaveLength(0)
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("survives a timeout reporter that throws", async () => {
    const result = await withDeadline({
      work: () => new Promise(() => {}),
      ms: 20,
      onTimeout: () => {
        throw new Error("reporter broken")
      },
    })
    expect(result).toBeUndefined()
  })
})
