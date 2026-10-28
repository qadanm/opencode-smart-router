# 07 — Implementation roadmap

**Precondition:** explicit approval of `06-RECOMMENDED-DESIGN.md`. No live installation until Phase 6 and a separate approval.

Each phase is independently testable and reversible. The repository is not a git repository at the time of the audit; initialise or snapshot it before Phase 1 so every phase has a rollback point.

## Phase 0 — Freeze and baseline (0.5 day)

**Goal:** make the starting point reproducible.

- Record the current bundle hash, test count, and typecheck result.
- Commit or archive the current working tree.
- Add a `LICENSE` decision (even if the decision is “proprietary, no reuse”).
- Update `docs/STATUS-2026-10-27.md` with the audit outcome and the fact that the live plugin remains disabled.
- Correct the two stale documents (`ARCHITECTURE.md`, `LIMITATIONS.md`) so they describe the current code, not the pre-bridge design.

**Acceptance**

- `npm test` and `npm run typecheck` pass.
- A snapshot exists that can be restored.
- No live configuration touched.

**Rollback:** delete the snapshot; nothing else changes.

## Phase 1 — Lifecycle hardening (1–2 days)

**Goal:** remove every remaining assumption that caused the incident.

Changes:

1. Delete the module-level `active` controller and `lifecycle` chain in `src/index.ts`. Let the core own the bridge registry exclusively.
2. Keep `SharedCore.init` single-flight (already implemented at `shared-core.ts:114-129`); add a test that two concurrent bridges receive the *same* ledger and quota objects (already added during the rebuild; keep it).
3. Ensure `dispose` never awaits persistence. Flush asynchronously; the core’s grace timer performs the final flush.
4. Add a startup self-check: if a second core is created in one process under the same key, log a diagnostic error and reuse the existing core.
5. Move `ctx.model.list()` out of the bridge into the core, cached with a TTL; bridges read the cached registry.
6. Add a bounded negative ownership cache for events.

**Acceptance**

- 20 locations: one core id, one PID, one event stream, 21 bridges, 16 commands per location.
- Reload churn (100 dispose/setup cycles) leaves zero leaked bridges and one core.
- No module-level mutable controller remains in `src/index.ts`.
- Diagnostics show one catalog refresh, not one per location.

**Rollback:** restore `src/index.ts` and `controller.ts` from the Phase 0 snapshot; the core changes are additive.

## Phase 2 — Fail-closed and validation (1–2 days)

**Goal:** close the verified fail-open path.

Changes:

1. Wrap the entire routing call in `routePromptSafely`. Any non-`RouterBlockedError` exception becomes a blocked decision, a `BLOCKED` title, a notification, and a thrown `RouterBlockedError` when `routing.failClosed` is true.
2. Normalize model definitions at config load: default `cache` to `{read:0, write:0}`, require finite non-negative numbers, require positive context/output, reject duplicates.
3. Make `estimateTaskCost` defensive even after validation (optional chaining/defaults).
4. Remove the catch-and-continue behaviour for routing errors; keep it only for non-routing UI/title errors.
5. Add tests:
   - cost tier without `cache` does **not** throw and routes;
   - an injected `routeTask` throw produces a blocked decision and a rejected prompt;
   - `failClosed: false` preserves the old opt-out;
   - invalid definitions produce warnings, not crashes.

**Acceptance**

- The deterministic reproduction in `evidence/engine-cost-repro.txt` no longer throws at `engine.ts:113`.
- A forced routing exception yields HTTP 500 / no provider request in the isolated server, with a `BLOCKED` title.
- Unit suite covers both fail-closed and opt-out.

**Rollback:** revert the controller/config/engine changes; the old behaviour is known but unsafe. Do not deploy without this phase.

## Phase 3 — Quota coordinator consolidation (2–3 days)

**Goal:** make quota state one owner, stale-aware, and boring.

Changes:

1. Extract the quota scheduler from the core into `quota-coordinator.ts` (or keep it in the core with a clear section). One timer per process, per-provider due times.
2. Adopt the usage-limits semantics:
   - 60 s base interval, ±10% jitter, 30 s minimum;
   - per-provider exponential backoff (2× up to 15 min);
   - retain last success; mark stale after two intervals;
   - typed failures: missing credentials, timeout, transport, rate limit, decode;
   - respect `retry-after`;
   - one in-flight request per provider;
   - no scheduling when the provider is disabled or has no credentials.
3. Cap response bodies (256 KB is enough for these payloads) and use `redirect: "error"`.
4. Port the Go and Command Code edge-case tests from `opencode-usage-limits` (auth fallback, malformed payload, missing fields, monthly derivation) into our Vitest suite using fake `fetch`.
5. Persist snapshots with a schema version; hydrate and mark stale on start.

**Acceptance**

- Exactly one quota request per provider per interval in the 20-location lab.
- Provider outage: last good snapshot retained and labelled stale; routing does not treat stale data as authoritative.
- Auth failure: typed warning; no retry storm.
- No request when credentials are absent.
- Unit tests for every failure class.

**Rollback:** keep the old `QuotaService` behind a flag for one release; the adapters are unchanged.

## Phase 4 — Bridge slimming and surface audit (2 days)

**Goal:** make the per-location bridge small and predictable.

Changes:

1. Remove the fallback `new QuotaService` in `controller.ts:220-227`; the core always owns it.
2. Collapse duplicate `compact`/`compactMode` flags.
3. Audit the 16 commands and RPC methods; remove or merge anything not used in daily work. Keep `/router-status`, `/router-explain`, `/router-mode`, `/router-auto`, `/router-pin`, `/router-pause`, `/router-resume`, `/router-dry-run`, `/router-approve`, `/router-reset-metrics`, `/router-title`.
4. Ensure title writes are coalesced per session and filtered by project/directory ownership.
5. Keep diagnostics id/directory/count only.

**Acceptance**

- Bridge LOC reduced by at least 15%.
- Command count per location remains stable and documented.
- No per-bridge timers, network calls, or persistence writes (static check + diagnostics).
- Title churn does not produce duplicate writes during a 20-location run.

**Rollback:** restore the controller from Phase 3.

## Phase 5 — Isolated verification (3–4 days)

**Goal:** prove the architecture, not just the units.

Test matrix:

| Test | Pass criterion |
|---|---|
| 20 locations, concurrent prompts | one core, one stream, 21 bridges, all prompts succeed |
| 100 reload cycles under load | no leaked bridges, no duplicate cores, no command loss |
| Provider outage / recovery | stale data, no crash, recovery |
| Auth failure | typed error, no crash, later prompts work |
| Rate limit / capacity (`ttft_admission_refused`) | retry without escalation or premium spend |
| Manual override / pause / dry run | titles and routing states correct |
| Large context (300K+ estimate) | affinity respected; no truncation |
| Final artifact 30-minute soak | zero thrash, zero unexpected restarts, bounded RSS |
| Three cold starts | one core each, titles/manual state restored, commands present |
| Fail-closed | HTTP 500, no provider request, `BLOCKED` title |

**Acceptance**

- All unit tests pass.
- The 30-minute soak runs on the exact artifact proposed for installation.
- Evidence is saved under `docs/evidence/final/` with timestamps, core ids, PID, bridge counts, request counts, RSS samples, and error counts.

**Rollback:** no production change yet.

## Phase 6 — Canary and limited enablement (approval-gated)

**Goal:** prove the artifact in the real desktop environment without risking all projects.

Preconditions:

- Phase 5 evidence reviewed.
- A backup of `~/.config/opencode/opencode.json`.
- A single canary project selected.
- A written rollback command.

Steps:

1. Install the plugin for **one** project only (project-scoped config), not globally.
2. Restart the desktop server once, with the user’s approval.
3. Verify: plugin active, 16 commands, one core id, one event stream, one bridge, no thrash warnings.
4. Run a normal prompt and verify the title and model selection.
5. Monitor for 24–48 hours: server stability, memory, command availability, prompt interruptions.
6. Only then consider global enablement, with a second approval.

**Rollback**

- Remove the plugin entry from the project config.
- Restart the server (approval required).
- Restore the config backup if needed.
- The plugin has no billing or credential side effects; disabling it stops all routing.

**Do not**

- Enable globally on the first attempt.
- Restart the user’s active server without explicit approval.
- Run the canary while other high-risk changes are being deployed.

## Dependencies

```text
Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6
                     \→ fail-closed tests can start after Phase 1
Phase 3 can run in parallel with Phase 2 if the files do not overlap
```

## Effort estimate

| Phase | Relative effort |
|---|---|
| 0 | 0.5 day |
| 1 | 1–2 days |
| 2 | 1–2 days |
| 3 | 2–3 days |
| 4 | 2 days |
| 5 | 3–4 days |
| 6 | 1 day + 24–48 h observation |

Total: roughly **2–3 weeks** of focused engineering, plus observation. This is less than a marco fork and more than adopting sberdia, but it is the only path that preserves the requirement set.

## Stop conditions

Stop and reassess if:

- the 20-location lab cannot maintain one core/one stream after Phase 1;
- fail-closed cannot be made exception-safe without breaking normal prompts;
- the host changes prompt-hook or `switchModel` behaviour;
- quota endpoints become unstable or require credentials we cannot obtain safely;
- the canary shows any server thrash, restart, or command loss.

In those cases, fall back to the config-only option (Option E) and document the lost per-prompt guarantees rather than shipping an unstable hook-based router.
