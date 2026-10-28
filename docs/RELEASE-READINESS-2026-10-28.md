# Release readiness — Option C

> **Desktop dry-run (2026-10-28): DEPLOYED; automatic routing NOT enabled.** The verified `8c71c46c…` artifact is installed in the live desktop in dry-run mode, with premium off and purchased credits blocked. Backup and independent rollback are at `~/Documents/opencode-smart-router-backups/20261027-223912`. See [DESKTOP-DRY-RUN-2026-10-28.md](DESKTOP-DRY-RUN-2026-10-28.md).
>
> **Accounting follow-up (2026-10-28): COMPLETE.** New artifact `8c71c46c…` (commit `e8fa5ac`, 106 tests) passed a fresh 30-minute mock-only soak on the exact artifact. The Stage B 38.5× comparison was invalidated by concurrent live-desktop usage; a separate monthly-accounting defect was fixed, documented peak pricing was added, and the sophisticated-design fallback is now explicit. See [ACCOUNTING-INVESTIGATION-2026-10-28.md](ACCOUNTING-INVESTIGATION-2026-10-28.md). A desktop dry-run deployment followed; automatic routing remains off.
>
> **Stage B limited (2026-10-28): COMPLETE.** Real Go/Command Code auth, quota, 2+2 bounded requests, vision, premium, and post-restart safety passed. See [STAGE-B-REPORT-2026-10-28.md](STAGE-B-REPORT-2026-10-28.md). No broader deployment is authorized.
>
> **Stage A final (2026-10-28): PASS on `e65326c9…` (commit `6099a3d`).** A fresh 30-minute soak and the complete Stage A matrix passed: 98 tests, all 16 commands zero-token, premium protection, large context, concurrency, outage, fail-closed recovery, reloads, restart, rollback. See [STAGE-A-FINAL-REPORT-2026-10-28.md](STAGE-A-FINAL-REPORT-2026-10-28.md). The earlier `f2e76af…` report is historical and must not be deployed.

**Date:** 2026-10-28
**Branch:** `option-c`
**Current accounting build:** `e8fa5ac`
**Final artifact:** `dist-release/index.js`
**SHA-256:** `8c71c46c5f7616f950c6a3fcf5c42be2198407848cf9ffac15d01504496f8920`

> `f2e76af0…` (commit `9577da3`) is the historical pre-fix build and **must not be installed**. It failed Stage A. The Stage A gate results below were measured on `e65326c9…`; the accounting follow-up build `8c71c46c…` is validated separately in section 7. Use `8c71c46c…` for any canary.
**Size:** 223,075 bytes
**Live installation:** **dry-run only** (installed 2026-10-28; automatic routing off)

## Verdict

The accounting follow-up artifact `8c71c46c…` passes the release gates for an **isolated-server canary** and is suitable for a **controlled, reversible desktop canary** subject to explicit authorization. The full Stage A lifecycle matrix remains measured on `e65326c9…`; the new artifact passed 106 tests and a fresh 30-minute mock-only soak on the exact bundle. Global or unattended deployment remains unauthorized.

The one unresolved scope issue is that a **full single-project canary inside the desktop app is not supported by the installed host**:

- Project-scoped plugin configuration isolates routing to that project (verified: only project A was routed; project B was untouched), **but commands and RPC are not exposed** for the project-scoped plugin. A slash command such as `/router-status` was sent to the model instead of executing.
- A global desktop entry loads the plugin for every active location. That is not a single-project canary.

Therefore the proposed canary is a **separate isolated OpenCode server process** with its own HOME/data/config, a disposable copy of one project, and the plugin installed only in that isolated configuration. This is fully isolated from the live desktop server and gives full commands/RPC.

## Gate results

| # | Gate | Result | Evidence |
|---|---|---|---|
| 1 | Fresh 30-minute soak on exact final artifact | **PASS** | `docs/evidence/option-c/release/soak-summary.json` |
| 2 | Last-bridge teardown/revival and concurrent lifecycle | **PASS** | `lastbridge-rollback.txt`, `lifecycle-concurrent.txt`, `core-probe-excerpt.txt` |
| 3 | Setup-failure fail-closed and recovery | **PASS** | `setup-failure.txt`, `fault-rollback.txt` |
| 4 | Emergency rollback without losing conversations | **PASS** | `lastbridge-rollback.txt`, `fault-rollback.txt` |
| 5 | Recovery independent of plugin commands | **PASS** | `fault-rollback.txt` |
| 6 | Premium / unapproved model protection | **PASS** | `premium-gate.txt`, `premium-restart.txt` |
| 7 | Purchased-credit protection | **PASS (unit)** | `test/engine.test.ts` exhausted-provider case |
| 8 | Final tests and byte-identical artifact | **PASS** | 98 tests on `e65326c9…`; 106 tests on `8c71c46c…`; deterministic rebuild; `cmp` against lab plugin |
| 9 | Memory peak audit | **PASS with monitoring caveat** | `memory-reload.txt`, `control-memory.txt` |
| 10 | Canary instructions prepared, not executed | **PASS** | `docs/CANARY-PLAN.md` |
| 11 | Accounting follow-up exact-artifact soak | **PASS** | `docs/evidence/stage-b/soak-summary-8c71c46c.json` |

## 1. Final-build soak (historical `e65326c9…` artifact)

> This section is the Stage A soak on `e65326c9…`. The accounting-follow-up artifact `8c71c46c…` has its own fresh soak result in section 7.

- 30 minutes, 29 samples, **1,502 mock inference requests** (~50/min)
- **One PID**, one core id, **no server restarts**
- **21 bridges**, **one event stream**, **63 setups / 42 disposes** across two 10-minute reloads
- **17,018 events handled / 3,343 ignored** (prior soak: 293,330 / 305,199)
- **2,000 ledger events** (configured cap), 120 decisions (configured cap)
- **Zero plugin errors, zero thrash warnings**
- **One expected server error**: `ECONNREFUSED` during the intentional 15-minute mock outage; recovery followed
- Large-context prompt succeeded on `lab-cc/deepseek-v4.1-flash`
- 16 commands in sampled p1, p10, p20 after the soak; no duplicate command registration observed
- One quota owner and one event stream (unit + diagnostics); no duplicate core
- Three cold starts on the same artifact: 3/3 fresh PID/core, one bridge, 16 commands, restored title, zero errors
- RSS: min 352 MB, peak **603 MB**, last 356 MB, post-run **153 MB**
- Physical footprint: 520 MB current, 713 MB peak

The 603 MB peak occurred at **02:17:56**, only 60 requests into the run, before any reload; it is a startup/concurrency spike, not a slow leak.

## 2. Lifecycle stress

### Concurrent creation and eviction (20-project server)

- 10 sessions created and prompted concurrently: **10/10 succeeded**
- Core/stream stayed one; bridge count 21
- Five concurrent location evictions returned 204; prompts succeeded; one core/stream
- No thrash or plugin errors

### Last-bridge teardown and revival

A test-only probe read the shared core directly. With only project A carrying the plugin:

- Before removal: core `5acibtsl`, bridges `[A]`, one stream
- Remove plugin from A config + location reload: bridges `[]`, streams `0`, disposes `1`
- After the 10-second grace window: still zero bridges/streams; the core object survives
- Ordinary prompt: HTTP 200, conversation context 12 → 15 messages (preserved)
- Re-add plugin + reload: **same core** `5acibtsl`, bridges `[A]`, streams `1`, setups 2 / disposes 1
- Routed prompt: HTTP 200, `AUTO` title, context 15 → 18

This is the live proof for the teardown barrier and core revival. The deterministic unit test also covers a new setup arriving during an in-flight teardown.

## 3. Setup failure and fail-closed recovery

Fault-injection build (same code with one injected `throw` before core init):

- Prompt: **HTTP 500**, title `BLOCKED · router setup failed — scope A`
- No model request
- Replacing the plugin with the release build and reloading: HTTP 200, `AUTO` title, routed success
- Removing the plugin from config and reloading: HTTP 200, ordinary prompt, context 18 → 21 (preserved)
- Restoring the plugin: HTTP 200, `AUTO` title, routing resumed

Recovery requires only an external config edit and a location reload/restart. It does **not** depend on the plugin’s commands.

## 4. Premium and model protection

- Before approval: design-heavy prompt stayed on `claude-haiku-5-5`; `needsPremiumApproval: true`; **zero GLM requests**; premium spend unchanged.
- After explicit one-shot approval: switched to `glm-5.3-flash`, succeeded; one-shot consumed; fake spend 0.0000025.
- After a full process restart: prior premium title restored; a new design-heavy prompt stayed non-premium, reported `needsPremiumApproval`, made **no GLM request**, and spend stayed unchanged.
- The unapproved `mimo-v2.6-flash` was absent from `approvedModels`.
- Purchased-credit policy is covered by the unit test that fails closed when only an exhausted provider with extra credits is available. No live purchased-credit balance was injected.

## 5. Memory audit

| Scenario | Physical footprint | Peak |
|---|---:|---:|
| Final soak, 20 projects, plugin | 520 MB | 713 MB |
| Control, 20 projects, plugin disabled | 398 MB | 511 MB |
| Single project, plugin | 190 MB | 278 MB |
| Controlled 21-bridge reload | 688 MB RSS transient | — |

- The host itself uses about 398 MB with 20 locations and no plugin.
- The plugin adds roughly 120 MB steady for 20 bridges, and up to ~200 MB transiently during startup/reload/concurrent prompts.
- Memory is oscillatory, not monotonic: the soak peak was 603 MB at the start, and the process settled to 153 MB after the run.
- A single-project canary is about 190 MB.
- **Conclusion:** the 710 MB earlier peak is a bounded host + plugin + workload spike, not evidence of an unbounded leak. Twenty open projects is a high-memory configuration; monitor during the canary.

## 6. Single-project canary investigation

### Project-scoped plugin (tested)

- Only project A was routed (`AUTO` title); project B stayed `scope B`.
- Core bridge list contained A only.
- A and B both reported **0 router commands**.
- `/router-status` in A was sent to the model (mock chat count increased), not executed.
- Removing/re-adding A’s plugin proved core teardown/revival, but the control surface is missing.

**Result:** routing isolation works, but a project-scoped canary is **not functionally equivalent** to the release. It cannot use `/router-approve`, `/router-status`, or the RPC surface.

### Separate isolated server (validated in the lab)

The `smart-router-single` lab is exactly this shape: isolated HOME/data/config, one project, plugin in the isolated global config. It had full commands/RPC, premium policy, fault recovery, and rollback. This is the proposed canary.

## 7. Final tests and artifact

### Accounting follow-up build — `8c71c46c…` / `e8fa5ac`

```text
npm run typecheck  → clean
npm test           → 9 files, 106 tests passed
sha256(dist-release/index.js) = 8c71c46c5f7616f950c6a3fcf5c42be2198407848cf9ffac15d01504496f8920
size               = 223,075 bytes
node --check       = syntax ok
```

- Exact artifact loaded in the isolated mock lab: **16 router commands**, **2 mock inference requests**, **0 plugin errors**.
- The design-fallback decision reported: `Standard design route: design 70 is below the sophisticated 75 threshold`.
- Fresh 30-minute mock-only soak on the exact artifact: **PASS**.
  - 29 samples, **1,491 mock inference requests**, one PID/core, one event stream, 21 bridges, **63 setups / 42 disposes**.
  - **0 plugin errors**, **0 thrash warnings**; one expected `ECONNREFUSED` at the intentional 15-minute mock outage.
  - Outage and recovery prompts succeeded; the large-context session succeeded.
  - **16 router commands per active location** (21 locations, 336 total); RSS min ~180 MB, peak ~620 MB, last ~394 MB.
  - Evidence: `docs/evidence/stage-b/soak-summary-8c71c46c.json`.
- Live config hash remained `83872b2d7dafd907ff620bdef0117ba80edb931504d888e5c0547628f9e820d7`; live service PID `90727` on port `49374` was not restarted. Isolated lab processes were stopped.

### Historical Stage A build — `e65326c9…` / `6099a3d`

```text
npm run typecheck  → clean
npm test           → 9 files, 98 tests passed (fix build e65326c9)
sha256(dist-release/index.js) = e65326c9bc7b36a4470bab2d631253d233e918fc76b4b93d5cf1bab8020a5fa4
npm test                     = 9 files, 98 tests passed
cmp with the lab plugin       = byte-identical
```

## 7a. Desktop dry-run deployment (2026-10-28)

- Installed the exact `8c71c46c…` artifact in the live desktop; no application restart (PID `90727` unchanged).
- Live config hash `d6cab84f…`; router config hash `d7bebb59…`; pre-deployment config hash `83872b2d…`.
- Dry-run, premium off, `allowExtraUsage:false`, Go Plus and Command Code GOAT only.
- Plugin active in four queried projects; one core/PID, one event stream, 16 commands per location, 10 bridges, 0 plugin errors. One car-spotter duplicate bridge is retained from a pre-reload active session; it does not duplicate commands, the core, the event stream, or quota polling.
- Quota service: one owner; `quotaRefreshes` 2 → 4 after one 5-minute interval for two providers; provider source for allowances; local model quotas `estimate`.
- Dry-run proof: 3 live previews with no model change and zero session cost/tokens; 5 actual isolated prompts → 5 mock requests, models unchanged.
- Backup/rollback tested on the actual deployed state: restore to `83872b2d…` and removal of router config/plugin verified.
- Promotion criteria and current gaps (24h window, ≥20 decisions, car-spotter duplicate bridge, Command Code weekly 81.05% > 80% target) are in [DESKTOP-DRY-RUN-2026-10-28.md](DESKTOP-DRY-RUN-2026-10-28.md). Automatic routing remains off.

## 8. Remaining risks

| Risk | Severity | Note |
|---|---|---|
| Desktop single-project canary unsupported with full controls | **Scope** | Project-scoped plugin has no commands/RPC; global entry loads everywhere |
| Real providers not exercised in the soak | Medium | All soak traffic was to a local mock; real latency/quota/auth behavior is not covered |
| Purchased-credit protection is unit-tested only | Medium | No live purchased-credit balance was injected; the client blocks automatic extra-credit use, but provider-side enforcement is the final guarantee |
| Monthly summary vs credit balance unexplained | Low | The adapter now treats remaining credits as authoritative and keeps the summary diagnostic only |
| Peak pricing only where documented | Low | Command Code DeepSeek V4.1 Flash is covered; other providers may have undocumented time-of-day rules |
| Host-retained duplicate bridge (car-spotter) | Low | One extra bridge record from a pre-reload active session; commands/core/event stream/quota polling remain singular. Monitor; reload after the session advances. |
| Command Code weekly headroom | Medium | Live weekly is 81.05% against an 80% promotion target and an 85% reserve; wait for reset/decay before automatic routing. |
| Dry-run has not been promoted | — | Automatic routing is intentionally off; promotion criteria are explicit in the dry-run report. |
| Titles remain prefixed after emergency removal | Low | Cosmetic; conversations are intact; manual rename possible |
| 20-project memory footprint | Medium | Host baseline 398 MB; plugin adds ~120 MB steady, transient reload spikes |
| Quota endpoints are undocumented | Medium | Read-only, bounded, stale-aware, but provider changes possible |
| SDK v2 behavior may change | Medium | Pin the host version; keep the bridge thin |
| Licence undecided | Low | No `LICENSE` file added without the owner’s decision |

## 9. Proposed canary scope

- One disposable **copy** of a project, never the live project.
- One **separate OpenCode server process** with isolated `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, and port.
- One plugin instance / one bridge; no desktop config entry; no live sessions; no live credentials copied.
- Start with the mock provider to validate lifecycle/commands/fail-closed, then a real-provider stage only with explicit approval and separately entered credentials.
- 24–48 hours of observation before any desktop decision.
- Exact instructions: `docs/CANARY-PLAN.md`. **Do not execute them yet.**

## 10. Decision requested

Approve or reject the isolated-server canary described in `docs/CANARY-PLAN.md`.

No desktop installation is proposed in this gate. A desktop rollout would require either:

- a global entry, which loads for every active project, or
- a project-scoped entry, which isolates routing but loses commands/RPC.

Both are materially different from the validated canary and require a separate decision.
