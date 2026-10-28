# QA — Option C implementation

> **Release gate:** the final 30-minute soak and release-readiness results are in [RELEASE-READINESS-2026-10-28.md](RELEASE-READINESS-2026-10-28.md). The proposed canary is in [CANARY-PLAN.md](CANARY-PLAN.md).

**Date:** 2026-10-27/28
**Branch:** `option-c` (baseline `af28882`, HEAD `9577da3`)
**Status:** implementation and isolated verification complete; **live installation not performed**

## Artifacts

| Build | SHA-256 | Size | What it covers |
|---|---|---:|---|
| 30-minute soak build | `6e793e1fbc9a28fe484a3ac4a30afb479a5281d2320aab1ef7c863ca162139aa` | 213 KB | Full 30-minute soak, outage/recovery, large context, reloads |
| Final review build | `f2e76af0fc6c889e5693308309128067d99f551b272538492836049a5e4dbe74` | 220 KB | 95 tests, 20-project gate, 3 cold starts, fail-closed |

The final build adds five review fixes after the soak: teardown barrier, setup-failure fallback hook, retry-after clamp, accurate failed-decision runtime, and immediate fire-and-forget persistence on dispose. Those changes are unit-tested; a fresh 30-minute soak of the final build remains a canary gate.

## 1. Scope

Implemented the approved Option C (repair and simplify) plan:

1. Removed the module-level controller from `src/index.ts`. The shared core's bridge registry is the only lifecycle owner.
2. Made bridge disposal non-blocking for storage; the core flushes on the grace timer.
3. Moved the live model catalog fetch into the core: one single-flight fetch per process, 5-minute cache.
4. Added a bounded negative-ownership cache for unowned session events.
5. Made fail-closed exception-safe: every unexpected routing failure records a failed decision, marks the session `BLOCKED`, and throws `RouterBlockedError` unless `routing.failClosed` is explicitly false.
6. Hardened model definitions: missing `cache` prices normalize to zero; non-finite/negative prices are rejected; definitions without a usable cost tier are ignored.
7. Made `estimateTaskCost` defensive for catalog entries that omit cache pricing.
8. Carried provider `retry-after` through quota snapshots, clamped it to 15 minutes, and honored it in the scheduler.
9. Removed the per-bridge quota-service fallback; a bridge refuses to initialize without the core quota service.

### Review fixes (after the soak)

- **Teardown barrier:** `init()` waits for an in-flight `dispose()`; the event stream is aborted during teardown. This closes the last-bridge/new-setup zombie race.
- **Setup failure is fail-closed:** if bridge initialization throws, a minimal prompt hook blocks prompts for that location instead of silently running with no router. The error is recorded in diagnostics.
- **Retry-after bound:** provider delays are clamped to 15 minutes, matching the backoff ceiling.
- **Accurate runtime:** a failed decision records paused/manual/automatic correctly.
- **Persistence:** dispose starts the ledger write immediately (fire-and-forget) instead of deferring it 750 ms.

## 2. Automated checks

```text
npm run typecheck  → clean
npm test           → 9 files, 98 tests passed (after Stage A fixes)
```

New tests cover:

- two entry setups create two bridges without disposing the first;
- dispose does not wait for a stalled storage write and starts the write;
- an in-flight core teardown blocks revival until it finishes;
- one catalog fetch across two bridges;
- unowned events do not re-read the same session;
- a setup failure is isolated, recorded, and leaves a fail-closed prompt hook;
- routing-engine exceptions block when fail-closed is on and are recorded when off;
- failed decisions report paused runtime;
- cost tiers without cache are normalized; unusable tiers are rejected;
- `estimateTaskCost` does not throw on a cache-less tier;
- quota probes honor and clamp `retry-after`; concurrent refreshes share one request; disabled providers are not probed;
- a bridge refuses to create a second quota service.

## 3. Isolated lab

- OpenCode 2.1.4, separate `HOME`/data/cache, ports 4212/4213.
- Mock OpenAI-compatible provider at `127.0.0.1:4200` with fake `lab` keys.
- 20 project locations; routing target `lab-cc`.
- No real provider credentials, no real credits.

### Final-build 20-project gate

- 20/20 prompts succeeded.
- One core id, 21 bridges, one event stream.
- 16 router commands in sampled p1, p10, p20.
- Zero thrash warnings, zero server errors.

### Final-build fail-closed gate

```text
prompt_http=500
title=BLOCKED · Go · GPT-6 Luna — blocked final artifact
decision={"indicator":"BLOCKED","error":"Provider is disabled in router settings","switched":false}
server_errors=0
response_bytes=0
```

### Final-build cold starts (3 rounds)

```text
round=1 oldPid=1762 newPid=1952 core=hs9uej25 bridges=1 commandsP1=16 title=AUTO · lab-cc · Lab DeepSeek V4.1 Flash — final10 p1
round=2 oldPid=1952 newPid=2017 core=dg92pd43 bridges=1 commandsP1=16 title=AUTO · lab-cc · Lab DeepSeek V4.1 Flash — final10 p1
round=3 oldPid=2017 newPid=2082 core=x9rhpwv1 bridges=1 commandsP1=16 title=AUTO · lab-cc · Lab DeepSeek V4.1 Flash — final10 p1
```

Each round: fresh PID and core, one default-location bridge, 16 commands, correct restored title, zero thrash, zero errors.

### 30-minute soak (pre-review build `6e793e…`)

| Metric | Result |
|---|---|
| Duration | 30 minutes, 29 samples |
| Mock inference requests | 1,528 (~50/min) |
| Core / PID | one / one |
| Bridges | 21 |
| Event streams | 1 |
| Setups / disposes | 63 / 42 (two 10-minute reloads) |
| Events handled | 17,255 |
| Events ignored | 3,321 |
| Ledger events | 2,000 (configured cap) |
| Plugin errors | 0 |
| Thrash warnings | 0 |
| Server errors | 1 expected `ECONNREFUSED` during the intentional mock outage |
| RSS min / max / last sample | 321 / 710 / 557 MB |
| RSS after run (31 min) | 177 MB |
| Post-run commands | 16 in p1, p10, p20 |
| Large-context prompt | succeeded on `lab-cc/deepseek-v4.1-flash` |
| Outage recovery | succeeded after mock restart |

Evidence: `docs/evidence/option-c/soak-summary.json`, `soak-metrics.jsonl`, `soak-events.txt`, `expected-outage-error.txt`.

## 4. Comparison with the prior 30-minute soak

Prior build = pre-Option-C. The prior harness reloaded more frequently.

| Metric | Prior build | Option C soak build | Reading |
|---|---:|---:|---|
| Mock requests / 30 min | 1,352 | 1,528 | Comparable, slightly higher workload |
| Events handled | 293,330 | 17,255 | **~17× lower per minute** |
| Events ignored | 305,199 | 3,321 | **~92× lower per minute** |
| Core / stream | 1 / 1 | 1 / 1 | Same |
| Bridges | 21 | 21 | Same |
| Setups / disposes | 483 / 462 | 63 / 42 | Different reload frequency; two clean reloads |
| RSS min / max / last | 153 / 647 / 240 MB | 321 / 710 / 557 MB | Peak ~10% higher; settled to 177 MB after the run |
| Plugin errors / thrash | 0 / 0 | 0 / 0 | Same |

**Conclusion:** event-processing load is dramatically lower and the lifecycle stays stable across two reloads. Throughput is comparable. Memory is not proven better: the peak is ~10% higher and the last sample is higher, but the process settled to 177 MB and showed no monotonic growth. A longer memory-focused run is still useful.

## 5. Harness defects found and fixed

These were test-harness problems, not plugin crashes:

1. **Soak outage killed the server under test.** `lsof -ti tcp:4200` matched both the mock listener and the OpenCode server's outbound connection. The server stopped gracefully at the 15-minute mark with no error. Fixed with `-sTCP:LISTEN` and a server-liveness abort.
2. **Cold-start command-substitution hang.** `PASS=$(start_server ...)` waited because the background server inherited the pipe. Fixed with `nohup ... < /dev/null`, direct `PASS`, readiness polling, and bounded curl.
3. **Cold-start queried diagnostics too early.** Fixed with a readiness loop.

The invalidated first 15-minute attempt is not counted.

## 6. Remaining risks / deferred items

| Item | Severity | Note |
|---|---|---|
| Fresh 30-minute soak of final build | Release gate | The 30-minute run predates the five review fixes; final build passed the short gate |
| Live canary not run | Release gate | Requires explicit approval; no live config touched |
| Stale ownership entries after bridge disposal | Minor | Self-heals on next event; bounded at 2,000 |
| Catalog cache does not rebuild bridge registries on a later provider connection | Minor | Restart or future refresh hook |
| Quota polling remains 5 minutes, prompt-triggered | Intentional | Undocumented endpoints; single-flight |
| License undecided | Housekeeping | No `LICENSE` added without the owner's choice |

## 7. Deployment plan — not executed

1. Snapshot `~/.config/opencode/opencode.json`.
2. Enable the plugin for **one canary project only**, not globally.
3. Restart the desktop server with explicit approval.
4. Verify: plugin active, one core id, one event stream, one bridge for the canary, 16 commands, no thrash.
5. Run one prompt; verify title and model selection.
6. Observe 24–48 hours: memory, command availability, server stability, prompt interruptions.
7. Only then consider global enablement, with a second approval.

**Rollback:** remove the project-scoped plugin entry, restart, restore the config snapshot if needed. No billing or credential changes.

## 8. Stop condition

The implementation is complete through the isolated gates. **Nothing has been installed into the live environment.** The next action is the canary in §7, which requires explicit approval.
