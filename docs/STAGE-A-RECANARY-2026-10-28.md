# Stage A re-canary — blocker fixes verified

> **Superseded by [STAGE-A-FINAL-REPORT-2026-10-28.md](STAGE-A-FINAL-REPORT-2026-10-28.md):** the full 30-minute soak and Stage A matrix on `e65326c9…` passed. This report remains the targeted-fix record.

**Date:** 2026-10-28
**Artifact:** `dist-release/index.js`
**SHA-256:** `e65326c9bc7b36a4470bab2d631253d233e918fc76b4b93d5cf1bab8020a5fa4`
**Code commit:** `6099a3dae7807a31058ae3396ba8cd1f128f13aa`
**Tests:** 98 passed; typecheck clean
**Scope:** targeted re-canary of the two Stage A blockers, isolated server, mock provider only

## Fixes

1. **Command notifications no longer resume the model.**
   `ctx.session.synthetic` now receives `resume: false` at `src/server/controller.ts:1298`.
   Regression test: `does not resume the model for command output`.
2. **`BLOCKED` clears after a successful prompt.**
   `routePrompt` clears a prior blocked indicator before routing a new prompt. If the new prompt blocks again, `markBlocked` restores it.
   Regression test: `clears BLOCKED after a successful routed prompt`.
3. **`/router-auto` reports the actual current model immediately.**
   `resumeAuto` reloads session info and awaits the title refresh.
   Regression test: `refreshes the title from the actual current model on resumeAuto`.

## Re-canary results

| Check | Result |
|---|---|
| Exact new artifact hash before start | **PASS** — `e65326c9…` |
| Isolated server, localhost, mock only | **PASS** — 127.0.0.1:4220; separate HOME/data/cache |
| Startup | **PASS** — one core, one bridge, one stream, 16 commands |
| Command output (`/router-status`) | **PASS** — HTTP 204, **mock requests 0 → 0**, no assistant reply |
| Command output visibility | Synthetic appears at the next turn; no inference at command time |
| Fail-closed block | **PASS** — HTTP 500, `BLOCKED`, no mock request |
| Recovery | **PASS** — HTTP 200, title `AUTO`, no `BLOCKED` |
| Manual → AUTO title | **PASS** — `MANUAL · DeepSeek` → `AUTO · DeepSeek` immediately |
| Process restart | **PASS** — new PID/core, one bridge/stream, 16 commands, no errors |
| Rollback | **PASS** — remove plugin + reload: commands 0; ordinary prompt 200; context 4 → 7 preserved |
| Memory at rollback | 213 MB footprint, 294 MB peak |
| Cleanup | Roots removed; ports 4200/4220 free; no processes |
| Live environment | Config hash unchanged; no desktop restart |

Evidence: `docs/evidence/canary-stage-a-recanary/`.

## Remaining release work

This re-canary verifies the two blockers and the minor title fix. It is **not** a full release gate for the new artifact:

- The full 30-minute soak and Stage A matrix on `e65326c9…` have now passed; see [STAGE-A-FINAL-REPORT-2026-10-28.md](STAGE-A-FINAL-REPORT-2026-10-28.md).
- Large context, concurrency, premium approval, outage, fail-closed, reload, restart, and rollback were repeated on the fix build.
- Live quota exhaustion remains a Stage B/live-provider check; the unit test passes.
- Stage B, real credentials, and live installation remain unauthorized.

**Verdict:** blockers fixed and verified; **do not proceed to Stage B** until the new artifact completes a full 30-minute soak and the full Stage A matrix.
