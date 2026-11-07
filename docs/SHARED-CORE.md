# Shared-core architecture

## Verified SDK process model

The installed OpenCode 2.1.4 server was probed in an isolated HOME with 20 project locations. A probe plugin recorded `process.pid`, a `globalThis` core id, and a per-location setup counter. Results:

- 20 locations produced one PID and one `globalThis` core.
- `setups` increased per location while `core` and `pid` stayed constant.
- A second probe wrote a plugin-storage value in location 1 and read it in location 2. Location 2 read the value written by location 1, confirming OpenCode's plugin storage is process-global across locations.

This is the basis for one shared core. The probe is reproducible in the lab and does not rely on an unverified assumption for this installed version.

## Ownership

| Layer | Owns | Instances |
|---|---|---|
| `SharedCore` | ledger, runtime overrides, quota cache, quota probes, session bootstrap, persistence timers, session ownership, diagnostics | exactly one per process |
| `RouterController` bridge | project registry, project settings, prompt/retry/header hooks, commands, RPC registration, event stream, title queue | one per loaded project location |

The shared core is stored under a process-global symbol. Each bridge calls `sharedCore.init`; the core loads storage once, creates one `QuotaService`, schedules one bootstrap, and schedules one quota initialization. Bridges never start their own timers or pollers.

## Load path

On plugin load the bridge:

1. awaits only shared storage hydration (no network, no session enumeration);
2. builds a seed registry immediately;
3. registers commands, RPC, hooks, and the event stream;
4. adds itself to the core;
5. refreshes the live model catalog in the background.

Session bootstrap is delayed one second; quota probing is delayed 1.5 seconds and runs once for the process. There is no provider request on the critical load path.

## Lifecycle

- `addBridge` registers a project and cancels any pending shutdown grace.
- `removeBridge` removes it; when the last bridge closes, the core waits 10 seconds before persisting and shutting down.
- The core object stays bound to the process after shutdown. A later setup revives it through `init` instead of creating a second core that would race on the same storage.
- Bridge cleanup disposes only that bridge's commands, RPC, hooks, and event stream.
- Shared state has bounded session ownership, ledger events, decisions, errors, and per-bridge session maps.

## Project isolation

Session and step events are process-global in this SDK. A session is claimed by the bridge that admitted its prompt. Event handlers ignore events for sessions owned by another bridge. `retry`, `model.request`, and model-selection handling are guarded the same way, so one project cannot suppress another project's retries, set its privacy headers, or mark it manual.

The prompt hook checks `projectID` before claiming a session. Title writes are filtered by project. Commands and RPC remain location-scoped, so each project exposes its own 16 router commands.

## Failure policy

`routing.failClosed` defaults to **`false`**.

A defect in this plugin degrades to "do not route", never to "do not work". When
the router cannot produce a decision because something inside it failed, the
prompt is served with the model already selected, which is what would have
happened had the plugin not been installed. The reason is recorded in warnings
and in the decision record.

Blocking is available as an explicit opt-in. With `routing.failClosed: true`,
an unexpected routing failure:

1. writes a `BLOCKED` session title;
2. sends a nonintrusive notification where supported;
3. records a blocked decision with the reason;
4. throws `RouterBlockedError` from the prompt hook.

OpenCode exposes no typed rejection API, so the block travels as an exception.
The installed server was probed with a throwing prompt hook: the prompt returned
HTTP 500 and was not admitted. The HTTP error is generic, so the title and
notification are the user-facing explanation.

Version 0.6.0 defaulted this to `true` and treated every internal exception as a
blocking condition. That turned a missing ledger method into a total refusal to
send any prompt, including in manual mode, and the owner had to remove the
plugin by hand. The reasoning is in
[INCIDENT-2026-11-06-prompt-lockout.md](INCIDENT-2026-11-06-prompt-lockout.md).

`failClosed` does not govern quota safety. The rule "a provider configured for
probing but with no reading is refused" is unconditional, because it is a
spending decision about a provider the router cannot see.

## Containment at the host boundary

OpenCode does not catch a plugin hook that throws and does not time out a hook
that never settles. Both were verified against a real OpenCode 2.2.5 process on
2026-11-06 and are asserted by `scripts/isolated-e2e.sh`. The guarantee has to
come from this side of the boundary, so `src/server/containment.ts` provides:

- `containHook()`, which makes a hook's failure a recorded warning rather than a
  failed request. A deliberate `RouterBlockedError` passes through only when the
  caller opts in.
- `withDeadline()`, which bounds routing. If routing has not finished within the
  budget (10 seconds by default), the prompt proceeds unrouted and the timeout is
  reported.

## Shared core versioning

The process-wide core is stamped with `SHARED_CORE_API`. A bundle adopts a core
from `globalThis` only when the stamp matches. A core left by a different
version is a different class with a different method set, and adopting it is how
0.6.0 produced `this.ledger.planPoolSpent is not a function` on every prompt.
`init()` additionally replaces a ledger that is not a `LedgerStore` instance.

## Quota and persistence

- One `QuotaService` uses the first bridge's global integration credentials; quota snapshots are shared.
- One ledger is shared by all projects. Provider-reported Go and Command Code observations remain distinct from local per-model estimates.
- Persistence is debounced; a write takes a snapshot, marks clean, then re-schedules if a mutation arrived during the write.
- No extra credits, billing changes, or unapproved provider routes are introduced.

## Limits

- The first loaded location's settings provide the shared quota/bootstrap configuration. Per-project routing thresholds and model approvals still come from each bridge.
- The core is process-wide only because the installed server is one process with shared `globalThis`. If a future host isolates locations in separate processes, the core must use an external coordinator or accept one core per process with process-scoped storage keys.
- Prompt-hook rejection is a 500 at the HTTP boundary; it is safe but not a polished typed error.
