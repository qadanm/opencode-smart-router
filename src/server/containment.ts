/**
 * Containment for the host boundary.
 *
 * WHAT THIS IS FOR. OpenCode does not protect itself from a plugin: a hook that
 * throws fails the request, and a hook that never settles leaves the editor
 * waiting forever. Verified against a real OpenCode process on 2026-11-06, in
 * `scripts/isolated-e2e.sh` -- see the `hook-throws` and `hook-hangs`
 * scenarios.
 *
 * That makes "the host is robust" an assumption this plugin cannot rely on.
 * The only place the guarantee can come from is here: whatever the router does
 * internally, the function OpenCode calls must return, and must not throw.
 *
 * TWO RULES.
 *
 * 1. A hook never propagates an exception. The prompt is served unrouted, which
 *    is exactly what would have happened if the plugin were not installed.
 *
 * 2. A hook never waits forever. Routing runs against a deadline; if the router
 *    is still working when it expires, the prompt proceeds without it. The
 *    router is an optimization, and an optimization that cannot finish is
 *    worth nothing -- but only if it gets out of the way.
 *
 * This module has no dependencies and no state, so it cannot be part of the
 * thing that fails.
 */

/** The narrow shape a contained hook needs from the plugin's own error type. */
interface BlockedLike {
  readonly name?: string
}

const isBlocked = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  ((error as BlockedLike).name === "RouterBlockedError" || (error as any).routerBlocked === true)

export interface ContainOptions {
  /** What to call this hook in a diagnostic. Never user-facing. */
  readonly label: string
  /** Called with the reason a hook was contained. Must not throw. */
  readonly onContained?: (message: string) => void
  /**
   * Whether an exception is a deliberate refusal that must reach the host.
   * Deliberate refusals are the one thing that may still stop a prompt,
   * because they are a decision rather than a defect.
   */
  readonly allowBlocked?: boolean
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Wrap a hook so it can never throw and never hang.
 *
 * The returned function always resolves. A `RouterBlockedError` is re-thrown
 * when `allowBlocked` is set, because that is the router saying "I refuse",
 * which is a supported outcome. Everything else is a defect, and a defect
 * leaves the prompt alone.
 */
export const containHook = <TEvent>(
  handler: (event: TEvent) => Promise<unknown> | unknown,
  options: ContainOptions,
): ((event: TEvent) => Promise<void>) => {
  const report = (message: string) => {
    try {
      options.onContained?.(message)
    } catch {
      // A diagnostic sink that throws must not resurrect the failure.
    }
  }

  return async (event: TEvent): Promise<void> => {
    try {
      await handler(event)
    } catch (error) {
      if (options.allowBlocked && isBlocked(error)) throw error
      report(`${options.label}: ${describe(error)}`)
    }
  }
}

/**
 * Run work against a deadline, resolving to `undefined` when it is exceeded.
 *
 * `Promise.race` would leave the slow work running and unobserved, which can
 * produce an unhandled rejection later and, worse, keep doing work whose result
 * nobody will read. This variant attaches handlers to the original promise so a
 * late rejection is swallowed deliberately, and reports the timeout so the
 * owner can see that routing was skipped.
 *
 * The timer is cleared on the normal path: a deadline that has already been met
 * must not keep the process alive or fire against a later request.
 */
export const withDeadline = async <T>(input: {
  readonly work: () => Promise<T> | T
  readonly ms: number
  readonly onTimeout: () => void
}): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false

  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      settled = true
      try {
        input.onTimeout()
      } catch {
        // Reporting the timeout must not replace it with another failure.
      }
      resolve(undefined)
    }, input.ms)
    // Never hold the event loop open on a deadline alone.
    ;(timer as any)?.unref?.()
  })

  const work = Promise.resolve()
    .then(input.work)
    .catch((error) => {
      // The caller's handler is responsible for the failure; this only stops a
      // rejection from escaping after the deadline has already won the race.
      if (settled) return undefined
      throw error
    })

  try {
    return (await Promise.race([work, deadline])) as T | undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}
