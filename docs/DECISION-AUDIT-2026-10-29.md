# Decision Audit — 2026-10-29

Scope: every routing decision the router retained across the last 3 days
(120 decisions, 2026-10-28 11:44 → 2026-10-29 12:56), checked against the
routing rules in source and against ground truth reconstructed from the
OpenCode message store.

Reproduce with `python3 scripts/audit-decisions.py`.

## Verdict

**One real defect, in two forms.** Every other exclusion had a legitimate
cause. The defect is that the router's context size went stale after a
compaction, which made sessions look far larger than they were and pushed
them off the cheapest provider.

## Finding 1 (high) — stale context after a compaction

**9 of 120 decisions** used a context size that the session no longer had.

| Time | Session | Used | True | Drift |
|---|---|---|---|---|
| 10-28 17:50:36 | Adaptive polish | 450,602 | 94,865 | +355,737 |
| 10-28 19:24:43 | Adaptive polish | 286,910 | 189,314 | +97,596 |
| 10-28 19:48:12 | OpenCode smart route | 400,000 | 123,731 | +276,269 |
| 10-29 00:12:09 | PermitPath | 233,216 | 110,374 | +122,842 |
| 10-29 02:24:48 | OpenCode smart route | 514,318 | 42,015 | +472,303 |
| 10-29 10:27:06 | PermitPath | 257,465 | 82,450 | +175,015 |
| 10-29 12:30:10 | PermitPath | 363,905 | 126,107 | +237,798 |
| 10-29 12:47:23 | Adaptive polish | 364,548 | 168,293 | +196,255 |
| 10-29 12:49:54 | Qadan Travels | 520,315 | 50,651 | +469,664 |

Every one follows a completed compaction. The router kept the pre-compaction
value.

### Mechanism

1. The context gate is `contextTokens + 20,000 ≤ model.context × 0.95`.
   OpenDesign's 328k window admits up to **291,600** tokens.
2. The router's context size came from `session.get().tokens`, which is the
   session's **cumulative** usage over its whole life — 43M input and 2.9B
   cache-read on the Adaptive polish session — clamped to 400,000.
3. The host emits `session.compaction.ended` when a compaction completes. The
   router subscribes to the whole event bus but had no handler for it, so the
   pre-compaction number survived.
4. A compaction's own token counts describe the transcript it *replaced*
   (338,756 + 25,984 = 364,740 for the PermitPath compaction), so they cannot
   be used as the new size. The authoritative value is the next assistant
   step, whose cache-read count reflects the rebuilt transcript.

### Consequence

A session compacted from 450k to 95k still looked like 450k. It was excluded
from OpenDesign, and the work continued on OpenCode Go Plus — which at 89%
monthly used and 21% weekly remaining is the most expensive pool. That is
exactly backwards from the intent.

## Finding 2 (low) — cumulative total used as context size

`session.get().tokens` is cumulative and was used directly as the context
size, clamped at 400,000. Three decisions show the clamp firing:

- 10-28 19:48:12 — used 400,000, real 658,574
- 10-29 10:29:42 — used 213,891, real 349,465
- 10-29 12:37:13 — used 400,000, real 477,373

The 400,000 clamp is above OpenDesign's 291,600 admission line, so it always
excludes OpenDesign.

## Findings that are NOT defects

**OpenDesign absent from the candidate list (5 decisions).** All legitimate:
OpenDesign's `deepseek-v4.1-flash` was in a cooldown following an HTTP 524 at
10:25:23 (a `provider_outage` fault, 10-minute hold). The decisions at 10:27:06,
10:29:19, 10:29:32 and 10:29:42 all fall inside that window.

**Command Code absent from candidates.** Two legitimate causes across the
period: unknown quota for 94 decisions (the dead key, until it was re-minted
this session), and 85% weekly used for the remaining 26.

**Manual overrides (3).** Correctly respected — no override, no switch.

**Hysteresis.** No decision kept a costlier model when the savings exceeded
the threshold. Every retention was explained by either the hysteresis rule or
cache affinity.

**Premium.** No premium model was selected while premium mode is off.

**Switch realization.** Every decision marked `switched` has a matching
`model-switched` event in the store.

## The fix

Two changes, both in `src/server/controller.ts`:

1. **Handle `session.compaction.ended`.** On completion, drop the cached
   context and re-read the transcript's real size immediately, so the cheap
   provider is eligible again on the very next turn.
2. **Read the real transcript size at admission.** The cumulative
   `session.get().tokens` is no longer used as a context size. The transcript
   read takes 20–120 ms even on the largest sessions, so the router waits for
   it rather than guessing. A failed read falls back to a modest estimate
   rather than an invented large one.

Tests: `test/compaction-context.test.ts`, 4 cases, all verified to fail
against the previous code. Full suite 214 passing, typecheck clean.
