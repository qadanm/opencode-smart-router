# Stage A final report — build `6099a3d`

**Date:** 2026-10-28
**Artifact:** `dist-release/index.js`
**SHA-256:** `e65326c9bc7b36a4470bab2d631253d233e918fc76b4b93d5cf1bab8020a5fa4`
**Code commit:** `6099a3dae7807a31058ae3396ba8cd1f128f13aa`
**Tests:** 98 passed; typecheck clean
**Verdict:** **PASS** for Stage A. No Stage B or live installation performed.

## Isolation

- Isolated `opencode serve` on `127.0.0.1:4220`; mock provider on `127.0.0.1:4200`.
- Separate HOME/config/data/cache and a disposable project copy.
- `env -i` scrubbed environment; no live credentials, paid inference, or billing endpoints.
- Live config hash before/after: `83872b2d7dafd907ff620bdef0117ba80edb931504d888e5c0547628f9e820d7` — unchanged.
- Live plugin list remained Vercel + Superpowers; no router entry.
- All canary roots removed; ports free; no test processes remain.

## 30-minute soak (exact artifact)

- 30 minutes, 29 samples, **1,478 mock requests** (~49/min)
- **One PID**, one core, no restarts; **21 bridges**, **one event stream**
- **63 setups / 42 disposes** across two 10-minute reloads
- **16,840 events handled / 3,308 ignored**
- **Zero plugin errors, zero thrash warnings**
- One expected `ECONNREFUSED` during the intentional outage; recovery succeeded
- Large-context prompt succeeded
- 16 commands in sampled p1/p10/p20
- RSS min **333 MB**, peak **731 MB**, last **377 MB**
- Peak occurred after the first reload at 511 requests; memory fell to 333 MB later, not monotonic

Three cold starts: 3/3 fresh PID/core, one bridge, 16 commands, restored title, zero errors.

## Stage A matrix

| Check | Result |
|---|---|
| Startup | one core, one bridge, one stream, 16 commands |
| Baseline routing | HTTP 200, `AUTO`, feature tier 2 |
| Manual override → AUTO | `MANUAL · DeepSeek` → `AUTO · DeepSeek` immediately |
| Premium before approval | stayed non-premium; `needsPremiumApproval`; **zero GLM requests**, zero spend |
| Premium after approval | switched to GLM, succeeded; one-shot consumed |
| Premium after restart | stayed non-premium; `needsPremiumApproval`; zero GLM requests |
| Unapproved model | absent from `approvedModels` |
| Large context | 1.32 MB prompt, **340,574 input tokens**; follow-up context **340,611**; kept for affinity |
| Concurrent sessions | **10/10 succeeded**; one core/bridge/stream |
| Provider outage | prompt outcome failed gracefully; server stayed 200; recovery succeeded |
| Fail-closed | HTTP 500, `BLOCKED`, **zero mock requests** |
| Recovery | HTTP 200, title `AUTO`, no `BLOCKED` |
| Three reloads | same core, one bridge/stream, 16 commands, title `AUTO` |
| Process restart | new PID/core, one bridge/stream, 16 commands, title `AUTO`, no errors |
| Rollback | plugin removed: commands **16 → 0**; ordinary prompt 200; context **16 → 19** preserved |
| Memory at rollback | 210 MB footprint, 289 MB peak |

## Command matrix — every command, success and failure

All 16 router commands were executed via `POST /api/session/:id/command`; success paths and invalid-argument/not-found paths were tested. **Every single command had `mock_before == mock_after` (delta 0).**

- Informational: `router-status`, `router-report`, `router-explain`, `router-diagnostics` — 0 tokens.
- Controls: `router-auto`, `router-mode`, `router-approve`, `router-pause`, `router-resume`, `router-dry-run` (on/off), `router-title` (off/on), `router-pin`, `router-exclude`, `router-premium-budget`, `router-reserve`, `router-reset-metrics` — 0 tokens.
- Failures: nonexistent `router-nope` (404), invalid `router-pin`, `router-mode`, `router-dry-run`, `router-title`, `router-exclude`, `router-premium-budget`, `router-reserve`, `router-reset-metrics` (no `--confirm`) — 0 tokens.
- Commands remained 16 after the matrix; runtime overrides reset.

Evidence: `docs/evidence/stage-a-final/commands.txt`.

## Immediate command feedback — SDK limitation

The SDK accepts `session.synthetic({ resume:false })`, but the message is admitted to the inbox and delivered only when the session next runs. There is no supported API to deliver a full synthetic command result immediately without resuming execution; resuming causes an inference turn. The router therefore keeps **zero-token correctness** and accepts that command output is visible on the next turn.

The existing session title remains the only immediate, supported, token-free UI surface and is already used for `AUTO`/`MANUAL`/`PAUSED`/`DRY RUN`/`BLOCKED`. No title hack or extra listener was added. This is an accepted SDK limitation, not a silent failure.

## Memory and lifecycle

- 20-project soak: peak 731 MB, last 377 MB; host baseline with 20 projects and no plugin was ~398 MB in the earlier control; single-project canary footprint ~210 MB.
- Single-project canary monitor: RSS 67–407 MB, CPU max 10.7%, latency max 0.113 s, one core/bridge/stream, one expected outage error.
- No duplicate core, duplicate stream, duplicate quota owner, or duplicate command registration observed.
- No server restart during the soak; three cold starts separate.
- The 731 MB peak is a reload/concurrency workload spike, not monotonic growth. Twenty open projects remains the high-memory configuration; the single-project canary is much smaller.

## Deployment references

- `docs/CANARY-PLAN.md` now uses **`e65326c9…` / `6099a3d`**.
- `f2e76af…` is explicitly marked **defective / do not install** in the canary plan and release readiness report.
- No deployment instruction references the old build as usable.

## Remaining risks

- Stage B with real providers, real quota windows, purchased credits, and real spend has not run and requires separate approval.
- Live provider quota exhaustion remains unit-tested only.
- Full command output is not immediately visible; it appears next turn (SDK limitation).
- Titles may remain prefixed after emergency plugin removal; cosmetic.
- 20-project memory is high (731 MB peak) though bounded; monitor during any future canary.
- Undocumented provider endpoints and v2 SDK drift remain external risks.

## Decision

Stage A for `e65326c9…` is complete and passes. **Do not proceed to Stage B or live installation without separate explicit approval.**
