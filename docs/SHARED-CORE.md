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

## Fail-closed policy

`routing.failClosed` defaults to `true`. When no eligible route exists and the current model is unqualified, the router:

1. writes a `BLOCKED` session title;
2. sends a nonintrusive notification where supported;
3. records a blocked decision with the reason;
4. throws `RouterBlockedError` from the prompt hook.

The installed server was probed with a throwing prompt hook: the prompt returned HTTP 500 and was not admitted; the session had no model and no request was sent. OpenCode does not expose a typed rejection API. The HTTP error is generic, so the title and notification are the user-facing explanation. This is a documented limitation, not a silent execution path. Manual selections and paused routing are outside the strict block.

## Quota and persistence

- One `QuotaService` uses the first bridge's global integration credentials; quota snapshots are shared.
- One ledger is shared by all projects. Provider-reported Go and Command Code observations remain distinct from local per-model estimates.
- Persistence is debounced; a write takes a snapshot, marks clean, then re-schedules if a mutation arrived during the write.
- No extra credits, billing changes, or unapproved provider routes are introduced.

## Limits

- The first loaded location's settings provide the shared quota/bootstrap configuration. Per-project routing thresholds and model approvals still come from each bridge.
- The core is process-wide only because the installed server is one process with shared `globalThis`. If a future host isolates locations in separate processes, the core must use an external coordinator or accept one core per process with process-scoped storage keys.
- Prompt-hook rejection is a 500 at the HTTP boundary; it is safe but not a polished typed error.
