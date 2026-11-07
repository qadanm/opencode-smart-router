# Incident 2026-11-06, every prompt refused

Date: 2026-11-06
Affected release: 0.6.0
Severity: total. The owner could not send a message in any mode, including
manual mode with routing paused, and had to remove the plugin by hand.

## Symptom

OpenCode refused every prompt with:

```
RouterBlockedError: Smart Router blocked this prompt:
this.ledger.planPoolSpent is not a function
```

The status panel returned HTTP 400 with the same defect:

```
rpc handler failed rpc=smart-router method=status
defect="TypeError: this.ledger.planPoolSpent is not a function.
(In 'this.ledger.planPoolSpent()', 'this.ledger.planPoolSpent' is undefined)"
```

The log recorded this repeating every three seconds for as long as the app was
open. Removing the plugin was the only way back to a working editor.

## Root cause, part one: a stale object was inherited

`src/server/shared-core.ts` keeps one core per OpenCode process in
`globalThis[Symbol.for("opencode-smart-router.shared-core.v1")]`. That is
deliberate: several project locations share one process, and they must share
one ledger and one quota service.

The lookup was:

```ts
export const sharedCore: SharedCore =
  ((globalThis as any)[KEY] as SharedCore | undefined) ??
  (((globalThis as any)[KEY] = new SharedCore()) as SharedCore)
```

It adopted whatever object it found, with no check that the object came from
the same code. `planPoolSpent()` was added to `LedgerStore` in `821d340`, after
v0.4.0. A process that had already loaded v0.4.0 or an early 0.5.x build held a
core whose ledger answered `premiumSpent()` but not `planPoolSpent()`.

The install layout makes this reachable rather than theoretical. Each install
lands in its own stamped directory and moves the config pointer; a running
server keeps the module it loaded. The next start imports the new bundle into a
process that still has the old core object on `globalThis`, and the new bundle
inherited it.

`premiumState()` then called a method that was not there, and threw.

`dispose()` resets the core, which is why a naive reproduction passed. The
production process was never disposed; it was replaced.

## Root cause, part two: the throw was escalated into a refusal

`routing.failClosed` defaulted to `true`. In the prompt hook, an unexpected
exception called `handleRoutingFailure()`, which did:

```ts
if (!this.settings.routing.failClosed) return
await this.markBlocked(sessionID, reason)
throw new RouterBlockedError(`Smart Router blocked this prompt: ${reason}`)
```

So an internal `TypeError` became a refusal to serve the prompt. That is a
category error. `failClosed` was written for a routing decision that cannot be
made: no eligible model, exhausted quota. It was never meant to describe what
happens when the plugin itself is broken, and it must not be, because those are
opposite situations. When the router cannot decide, the honest options are "do
not route" and "ask the owner". "Refuse to work" is not one of them.

The two defects compounded. Neither alone was fatal. A stale core with a
fail-open policy would have logged a warning and served the prompt unrouted. A
correct core with a fail-closed policy would have been annoying but functional.
Together they disabled the editor.

## Why the suite did not catch it

801 tests passed while the product was unusable, and that is the more important
finding. Every test called functions directly, in one process, with one module
graph. Nothing loaded the plugin into a real OpenCode process. Nothing modeled a
process that had already loaded an older version. The suite tested the router's
decisions, not the plugin's survival.

## Corrections

1. **The shared core is stamped and version-checked.** `SHARED_CORE_API`
   (currently 2) is a readonly field. A core whose stamp does not match is
   refused and replaced, never adopted. `init()` also replaces a ledger that is
   not a `LedgerStore` instance, which covers the narrower case of a correct
   core holding a wrong ledger.

2. **`failClosed` defaults to `false` and means one thing.** It governs what
   happens when this plugin cannot produce a decision. When off, the prompt is
   served with the model already selected, exactly as if the plugin were not
   installed, and the reason is recorded in warnings.

3. **Quota safety is a separate, unconditional check.** The rule "a provider
   configured for probing but with no reading is refused" no longer depends on
   `failClosed`. It is a spending decision about a provider the router cannot
   see, not a response to the router's own failure. Conflating the two would
   have made the fail-open fix unsafe.

4. **The host boundary is contained in the plugin.** Verified against a real
   OpenCode 2.2.5 process: a hook that throws fails the request with HTTP 500,
   and a hook that never settles blocks until the caller gives up. OpenCode does
   not protect itself, so protection has to be ours.
   `src/server/containment.ts` provides `containHook()` and `withDeadline()`,
   and every hook is wrapped in them. A hook can no longer throw, and can no
   longer hold a prompt indefinitely. Routing runs against a 10 second budget,
   after which the prompt proceeds unrouted.

5. **A failed setup installs no hook.** The entry point used to install a
   "minimal fail-closed hook" when `initialize()` threw, which turned a failed
   setup into a disabled editor. A location whose setup failed now has no
   router, and the host behaves as if the plugin were not installed.

6. **A separate defect found by the same investigation.** The router offered
   every seed catalog model as a candidate, including models this machine has
   no provider for. On a fresh install it switched a session onto
   `opencode-go/claude-haiku-5-5`, and the next step died with "Model
   unavailable". Candidates are now filtered to models the host actually
   lists. If that leaves nothing, the answer is no route, not an unfiltered
   fallback, because the fallback is how the unservable model got chosen in the
   first place.

## Evidence

| Claim | How it was checked |
|---|---|
| The defect is a missing method on an inherited ledger | Production log, exact strings quoted above |
| `planPoolSpent` is absent before `821d340` | `git show v0.4.0:src/core/quota/ledger.ts` |
| The production sequence reproduces in a test | `test/shared-core-skew.test.ts`, fails before the fix with the production error |
| An internal defect must not block a prompt | `test/fail-open-contract.test.ts` |
| OpenCode does not contain a throwing hook | `scripts/isolated-e2e.sh`, `hook-throws` |
| OpenCode does not contain a hanging hook | `scripts/isolated-e2e.sh`, `hook-hangs` |
| The fixed bundle survives a stale core in a real process | `scripts/isolated-e2e.sh`, `stale-shared-core` |
| The same scenario fails on the 0.6.0 bundle | Run against `git archive a7ef6d8`: HTTP 500, no answer |

The last row matters most. The scenario is not just green on the new code, it
is red on the old code, so it is measuring the thing that broke.

## What this incident changed about how the project works

The plugin is now tested where it runs. `scripts/isolated-e2e.sh` builds a
disposable OpenCode in a temporary HOME with its own config, data, and cache,
refuses to run if any path escapes that sandbox, and asserts only one thing:
OpenCode answered the prompt. It does not assert that routing was good, because
a router that routes badly is a poor router, but a router that stops the editor
is not a router at all.

The suite uses a loopback model stub that it starts and stops itself, so it
needs no credentials and cannot be blocked by a provider's quota. That detail
earned its place: the first version called a real hosted model, and when the
free tier ran out mid-run every scenario reported "blocked" and proved nothing.
A guarantee that can be prevented from running is not a guarantee.

Two scenarios in that suite are classified as host limitations rather than
plugin failures. They install a deliberately throwing or hanging hook to show
that OpenCode has no defense of its own. Their expected result is that the host
breaks. If they ever start passing, OpenCode grew a defense, and the note will
say so.
