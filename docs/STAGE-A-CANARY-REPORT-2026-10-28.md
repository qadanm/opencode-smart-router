# Stage A isolated canary — report

> **Superseded (2026-10-28):** both blockers below are fixed in `e65326c9…` (commit `6099a3d`) and the targeted re-canary passes. See [STAGE-A-RECANARY-2026-10-28.md](STAGE-A-RECANARY-2026-10-28.md). This report remains the historical failure record.

**Date:** 2026-10-28
**Artifact:** `dist-release/index.js`
**SHA-256 verified before start:** `f2e76af0fc6c889e5693308309128067d99f551b272538492836049a5e4dbe74`
**Code commit:** `9577da3`
**Canary:** isolated `opencode serve` on `127.0.0.1:4220`, separate HOME/config/data/cache, disposable project copy, mock provider only.

## Verdict

**Stage A does not pass.** Two defects were found on the exact release artifact:

1. **Command execution triggers a model request.** `/router-status` executed through `POST /api/session/:id/command` returned 204 but caused one mock inference request and an assistant reply. The command notification calls `ctx.session.synthetic` without `resume:false` (`src/server/controller.ts:1298`).
2. **`BLOCKED` title never clears.** After a blocked prompt, a subsequent successful prompt (and even a full process restart) still shows `BLOCKED` while the session outcome is `succeeded`. The title state is derived from `indicatorTitle` (`controller.ts:370`) and is never cleared on a successful route.

Both are release blockers because they affect token spend and user-visible correctness. **No Stage B or live installation was attempted.**

## Isolation and constraints

- Server bound to `127.0.0.1:4220`; mock provider bound to `127.0.0.1:4200`.
- Separate `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, and disposable project copy.
- Server started with `env -i` (scrubbed environment); no live provider credentials inherited.
- Mock providers only; no production billing endpoints contacted; no paid inference.
- Live config hash before and after: `83872b2d7dafd907ff620bdef0117ba80edb931504d888e5c0547628f9e820d7` — unchanged.
- Live plugin list remained `vercel-plugin` and `superpowers`; no router entry.
- Canary roots were removed after evidence capture; ports 4200/4220 free; no canary processes remain.

## Pass/fail

| Check | Result | Evidence |
|---|---|---|
| Exact artifact hash before start | **PASS** | `artifact-verify.txt` |
| Isolated process/config/data/project | **PASS** | separate HOME/XDG; localhost-only; mock |
| Live desktop untouched | **PASS** | config hash unchanged; no desktop restart |
| Startup / one core / one bridge / one stream | **PASS** | 1 core, 1 bridge, 1 stream, 16 commands |
| Routing decisions | **PASS** | AUTO title, model/decision changes |
| Manual override / resume AUTO | **PASS** | MANUAL → AUTO; model switched |
| Premium protection before/after approval | **PASS** | no GLM request/spend before approval; GLM after |
| Unapproved model exclusion | **PASS** | `mimo-v2.6-flash` absent from approved list |
| Large context | **PASS** | 1.32 MB prompt; 340,574 input tokens; follow-up context 340,611; kept for affinity |
| Concurrent requests | **PASS** | 10/10 succeeded; one core/bridge/stream |
| Fail-closed block | **PASS (functional)** | HTTP 500, BLOCKED, no mock request |
| Fail-closed UI recovery | **FAIL** | title remained BLOCKED after successful prompt and restart |
| RPC status/diagnostics/approve/pause/dry-run | **PASS** | endpoints responded correctly |
| Command execution | **FAIL** | 204 but +1 model request; synthetic resumed session |
| Quota exhaustion | **NOT TESTED** | mock-only constraint; no production billing allowed; unit test only |
| Location reloads | **PASS** | 3 reloads, same core, 1 bridge/stream, 16 commands |
| Process restart | **PASS** | new PID/core, 1 bridge/stream, 16 commands, premium title restored |
| Rollback / plugin removal | **PASS** | commands 16 → 0; ordinary prompt 200; context 13 → 16 |
| Cleanup | **PASS** | roots removed; ports free; no processes |
| Monitoring | **PASS with duration caveat** | 65 samples; no errors/thrash; peak 530 MB; CPU 27.7%; latency 0.197 s |

## Detailed findings

### Blocker 1 — command output spends tokens

Fresh session, no prior prompt:

- `mock_before=4`
- `POST /api/session/{id}/command {"name":"router-status","text":""}` → **204**
- `mock_after=5`
- Context: `synthetic` message followed by an assistant `"ok"` and idle.

The command callback calls:

```ts
await this.ctx.session.synthetic({ sessionID, text, description: "Smart Router" })
```

It does not pass `resume:false`. The SDK synthetic input supports `resume?: boolean`; default resume behavior caused a model turn. This affects every command that uses `notice` for output.

**Required fix:** pass `resume: false` for command/status notifications; add a unit test that asserts the synthetic call carries `resume:false`; re-run the live command check and confirm zero mock requests. Rebuild and re-canary with a new hash.

### Blocker 2 — BLOCKED title is sticky

- Provider disabled + fail-closed: HTTP 500, title `BLOCKED · lab-cc · Canary Haiku — canary blocked`, decision error `Provider is disabled in router settings`, no mock request.
- Re-enable provider + reload: HTTP 200, outcome `succeeded`, model `claude-haiku-5-5` — **title still `BLOCKED`**.
- After a full process restart: same session still `BLOCKED`, outcome `succeeded`.

The state check at `src/server/controller.ts:370` treats any `indicatorTitle` beginning `BLOCKED ·` as BLOCKED. A successful decision never clears it.

**Required fix:** clear the blocked indicator when a successful automatic/manual decision is recorded, or derive BLOCKED from the latest decision rather than the title prefix. Add tests for recovery and restart; re-canary.

### Minor — stale AUTO title after `/router-auto`

After manual override:
- model is DeepSeek, title initially `MANUAL`.
- Resume AUTO leaves title `AUTO · Canary Haiku` while the current model remains DeepSeek.
- The next prompt corrects the title to `AUTO · Canary DeepSeek`.

Cosmetic but misleading. Should be fixed with the title-clearing work or tracked as a minor.

### Not tested — quota exhaustion

The canary used mock providers only and was forbidden from contacting production billing. Provider quota exhaustion could not be exercised live without a real billing endpoint. The unit suite includes the exhausted-provider-with-extra-credits case and passed. This remains a Stage B/live-provider check.

## Monitoring

65 successful samples from the first server over ~5.5 minutes; the restart was verified separately but not continuously sampled.

- RSS min 64 MB, max **530 MB**, last 299 MB before restart
- CPU max **27.7%**
- HTTP response latency max **0.197 s**
- One core, one bridge, one stream
- Server starts: 1 (first process); 1 (restart)
- Thrash: 0; server errors: 0
- Footprint at rollback: 284 MB current, 345 MB peak

The 530 MB peak occurred during the large-context/concurrent phase; it is a bounded workload response, not a restart/leak. A longer single-project observation is still desirable after the fixes.

## Rollback proof

- Commands before: 16
- Remove plugin from isolated config + location reload: commands **0**
- Ordinary prompt: HTTP 200, outcome succeeded, model DeepSeek
- Conversation context: 13 → 16 messages (preserved)
- Plugin list: empty
- No destructive changes; no plugin command required

## Next step

Do **not** proceed to Stage B or install. The exact artifact is not release-ready.

Proposed patch scope (requires a new approval because it changes the verified hash):

1. `resume: false` on command notifications; test and live re-check.
2. Clear/reset BLOCKED indicator on successful routing; test recovery and restart.
3. Optional: refresh title immediately on `resumeAuto` using the current model.
4. Rebuild, record a new SHA-256, rerun the full unit suite, the 30-minute soak, and Stage A against the new artifact.

Evidence: `docs/evidence/canary-stage-a/`.
