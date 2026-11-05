import type { RoutingDecision, TaskClass } from "../core/types.js"

/**
 * What the router chose for the current prompt of a session, kept so the
 * retry hook can re-route the same task when a provider deterministically
 * rejects the request. The retry event carries no prompt linkage of its own,
 * so the prompt hook records the pairing here.
 *
 * Sized like the other per-session caches (the `expectedSwitch` pattern):
 * bounded, oldest entries evicted, never persisted to disk.
 */
export interface PromptRouteEntry {
  /** The user prompt the routing belongs to (when the host reports one). */
  readonly messageID?: string
  readonly task: TaskClass
  readonly decision: RoutingDecision
  readonly at: number
  /** Set once a prompt-rejection failover for this prompt has run. */
  healedAt?: number
}

const LIMIT = 500

export class PromptRouteTracker {
  private readonly entries = new Map<string, PromptRouteEntry>()

  set(sessionID: string, entry: PromptRouteEntry): void {
    if (this.entries.size >= LIMIT && !this.entries.has(sessionID)) {
      this.evict()
    }
    this.entries.set(sessionID, entry)
  }

  get(sessionID: string): PromptRouteEntry | undefined {
    return this.entries.get(sessionID)
  }

  clear(sessionID: string): void {
    this.entries.delete(sessionID)
  }

  clearAll(): void {
    this.entries.clear()
  }

  size(): number {
    return this.entries.size
  }

  private evict(): void {
    const cutoff = Date.now() - 60_000
    for (const [sessionID, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(sessionID)
    }
    if (this.entries.size >= LIMIT) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) this.entries.delete(oldest[0])
    }
  }
}
