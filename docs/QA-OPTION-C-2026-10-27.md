# QA — Option C implementation

**Date:** 2026-10-27/28
**Branch:** `option-c` (baseline `af28882`)
**Status:** implementation and isolated verification complete; **live installation not performed**
**Artifact:** `dist/index.js`, SHA-256 `6e793e1fbc9a28fe484a3ac4a30afb479a5281d2320aab1ef7c863ca162139aa`, 213 KB

## 1. Scope

Implemented the approved Option C (repair and simplify) plan:

1. Removed the module-level controller from `src/index.ts`. The shared core's bridge registry is the only lifecycle owner.
2. Made bridge disposal non-blocking for storage. The core flushes on debounce or at the end of the 10-second grace period.
3. Moved the live model catalog fetch into the core: one single-flight fetch per process, 5-minute cache. Bridges rebuild their own registries from the shared list.
4. Added a bounded negative-ownership cache so unowned session events do not trigger a storage read on every event.
5. Made fail-closed exception-safe: every unexpected routing failure records a failed decision, marks the session `BLOCKED`, and throws `RouterBlockedError` unless `routing.failClosed` is explicitly false.
6. Hardened model definitions: missing `cache` prices normalize to zero; non-finite/negative prices are rejected with warnings; definitions without a usable cost tier are ignored.
7. Made `estimateTaskCost` defensive for live catalog entries that omit cache pricing.
8. Carried provider `retry-after` into quota snapshots and made the quota service honor it.
9. Removed the per-bridge quota-service fallback. A bridge refuses to initialize without the core quota service.

## 2. Automated checks

```text
npm run typecheck  → clean
npm test           → 9 files, 92 tests passed
```

New tests cover:

- two independent entry setups create two bridges without disposing the first;
- dispose does not wait for a stalled storage write;
- one catalog fetch across two bridges;
- an unowned event does not re-read the same session;
- a bridge setup failure is isolated and recorded;
- routing-engine exceptions block when fail-closed is on and are recorded when off;
- cost tiers without cache are normalized; unusable cost tiers are rejected;
- `estimateTaskCost` does not throw on a cache-less tier;
- quota probes honor `retry-after`; concurrent refreshes share one request; disabled providers are not probed;
- a bridge refuses to create a second quota service.

## 3. Isolated lab

- OpenCode 2.1.4, separate `HOME`/data/cache, ports 4212 and 4213.
- Mock OpenAI-compatible provider at `127.0.0.1:4200` with fake `lab` keys.
- 20 project locations; routing target `lab-cc`.
- No real provider credentials, no real credits.

### Initial 20-project gate

- 20/20 prompts succeeded.
- One core id, 21 bridges, one event stream.
- 16 router commands in sampled p1 and p20.
- Zero thrash warnings, zero server errors.

### Fail-closed gate (final artifact)

```text
prompt_http=500
title=BLOCKED · Go · GPT-6 Luna — blocked final
decision={"indicator":"BLOCKED","error":"Provider is disabled in router settings","switched":false}
server_errors=0
response_bytes=0
```

No provider request was made. Evidence: `docs/evidence/option-c/fail-closed.txt`.

### Cold starts (final artifact, 3 rounds)

```text
round=1 oldPid=96191 newPid=96347 core=mjx830ef bridges=1 commandsP1=16 title=AUTO · lab-cc · Lab DeepSeek V4.1 Flash — final10 p1
round=2 oldPid=96347 newPid=96423 core=g3511p56 bridges=1 commandsP1=16 title=AUTO · lab-cc · Lab DeepSeek V4.1 Flash — final10 p1
round=3 oldPid=96423 newPid=96486 core=wqfvzrl9 bridges=1 commandsP1=16 title=AUTO · lab-cc · Lab DeepSeek V4.1 Flash — final10 p1
```

Each round produced a fresh PID and core, one default-location bridge, 16 commands, the correct restored title, zero thrash and zero errors. A post-restart prompt succeeded on `lab-cc/deepseek-v4.1-flash` with title `AUTO`. Evidence: `docs/evidence/option-c/cold-start.txt`.

### 30-minute soak (final artifact)

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
| Outage recovery | second prompt succeeded after mock restart |

Evidence: `docs/evidence/option-c/soak-summary.json`, `soak-metrics.jsonl`, `soak-events.txt`, `expected-outage-error.txt`.

## 4. Comparison with the prior 30-minute soak

The prior soak used the pre-Option-C build and a more aggressive reload harness.

| Metric | Prior build | Option C | Reading |
|---|---:|---:|---|
| Mock requests / 30 min | 1,352 | 1,528 | Comparable, slightly higher workload |
| Events handled | 293,330 | 17,255 | **~17× lower per minute** |
| Events ignored | 305,199 | 3,321 | **~92× lower per minute** |
| Core / stream | 1 / 1 | 1 / 1 | Same |
| Bridges | 21 | 21 | Same |
| Setups / disposes | 483 / 462 | 63 / 42 | Different reload frequency; current counts are two clean reloads |
| RSS min / max / last | 153 / 647 / 240 MB | 321 / 710 / 557 MB | Peak ~10% higher; settled to 177 MB after the run |
| Plugin errors / thrash | 0 / 0 | 0 / 0 | Same |

**Conclusion:** the refactor clearly improves event-processing load and keeps the lifecycle stable across two plugin reloads. Throughput is comparable. Memory is not proven better: the peak is slightly higher and the last sample is higher, but the process settled to 177 MB after the run and showed no monotonic growth. A longer memory-focused run would be needed to make a stronger claim.

## 5. Harness defects found and fixed

These were test-harness problems, not plugin crashes:

1. **Soak outage step killed the server under test.** `lsof -ti tcp:4200` matched both the mock listener and the OpenCode server's outbound connection to the mock. The first run's server stopped gracefully at the 15-minute mark with no error. The harness now uses `-sTCP:LISTEN` and aborts if the server becomes unreachable.
2. **Cold-start harness hung on a command-substitution pipe.** `PASS=$(start_server ...)` waited because the background server inherited the substitution pipe. The harness now detaches the server with `nohup ... < /dev/null`, sets `PASS` directly, waits for `/api/info`, and bounds every curl.
3. **Cold-start queried diagnostics too early.** Fixed with a readiness loop and `--max-time`.

The invalidated 15-minute run is not counted in the results above.

## 6. Remaining risks / deferred items

| Item | Severity | Note |
|---|---|---|
| Live canary not run | Release gate | Requires explicit approval; no live config touched |
| Stale ownership entries after bridge disposal | Minor | Self-heals on the next event; bounded at 2,000 |
| Last-bridge final-flush vs new-bridge race | Minor | Narrow window; not observed in the lab |
| Catalog cache does not rebuild bridge registries on a later provider connection | Minor | Restart or a future refresh hook needed |
| Quota polling remains 5 minutes, prompt-triggered | Intentional | Undocumented endpoints; one request per provider per interval |
| License undecided | Housekeeping | No `LICENSE` added without the owner's choice |
| Cold-start first command query can transiently return 0 before the location command cache warms | Minor | Observed once; retry returned 16; not reproduced after the readiness fix |

## 7. Deployment plan — not executed

1. Snapshot `~/.config/opencode/opencode.json`.
2. Enable the plugin for **one canary project only**, not globally.
3. Restart the desktop server with explicit approval.
4. Verify: plugin active, one core id, one event stream, one bridge for the canary, 16 commands, no thrash warnings.
5. Run one prompt; verify the title and model selection.
6. Observe for 24–48 hours: memory, command availability, server stability, prompt interruptions.
7. Only then consider global enablement, with a second approval.

**Rollback:** remove the project-scoped plugin entry, restart the server (approval required), restore the config snapshot if needed. The plugin makes no billing or credential changes.

## 8. Stop condition

The implementation is complete through the isolated gates. **Nothing has been installed into the live environment.** The next action is the canary in §7, which requires explicit approval.
