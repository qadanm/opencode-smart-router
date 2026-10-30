# Incident — OpenDesign context window, session blocked

Date: 2026-10-29
Artifact: `ed5a64937a42438effde216bbe8ac21a1cd11c41f94e8199fbe2a3ef0e0bed55`
Commit: `b8c6eef`

## Symptom

A live session could not send a prompt. Its title read:

```
BLOCKED · OD · minimax-m3.1-flash — We need title only. Main topic build clean slate studio.Building Qadan Travels Freeform Studio fr...
```

56 consecutive blocked admissions in one minute, all with the same reason:

```
Context requirement 329,321 exceeds this model's safe window
```

## Root cause

A wrong context window, not a genuinely oversized session.

OpenDesign's gateway reports two context numbers per model:

| Field | Meaning |
|---|---|
| `context_limit` | the vendor's total context window |
| `context_budget` | the usable **input** budget, after reserved output is subtracted |

`minimax-m3.1-flash` reports `context_limit: 1000000` and **no**
`context_budget` — the only one of 13 enabled models missing that field.

`toLiveModels` handled the missing budget by falling back to a hand-written
232,000. That number is not a property of the model; it was a guess made
when the gateway's metadata was first inspected.

The session's real context was 309,321 tokens, so the router judged it
against a ceiling of `232,000 × 0.95 = 220,400` that the model never had.

### Why it became a hard block

Three things had to line up:

1. **OpenDesign's minimax was excluded** by the wrong window.
2. **Go Plus was excluded** by its own quota reserve — monthly at 90% used
   against a 10% reserve.
3. **Command Code was excluded** by its own quota reserve — weekly at 85.8%
   used against a 15% reserve.

With no eligible candidate left and `failClosed` on, the router failed
closed on every prompt. The reserves are the owner's policy working
correctly; the defect was that a provider which *could* serve the session
had been removed from consideration by a wrong number.

## Evidence the 232k figure was wrong

| Source | Value |
|---|---|
| OpenDesign gateway, live | `context_limit: 1000000`, `context_budget` absent |
| models.dev, independent | `limit.context: 1000000` for `minimax-m3.1-flash` |
| The owner's own `opencode.json` | `limit.context: 1000000` |
| Recorded calls | 475 calls reached 309,321 tokens; 132 exceeded 232,000; **0** context-length errors |
| `deepseek-v4.1-flash`, whose budget *is* reported as 328,000 | 4,238 calls, 0 above 328,000, 0 errors |

The last row matters: where the gateway *does* report a budget, the budget
is meaningful and binding. Its absence for minimax means *unknown*, not
*small* — so the router must not treat unknown as 232k.

## The fix

`toLiveModels` now uses the gateway's vendor `context_limit` when a model
reports no `context_budget`, and treats it as an upper bound so a reported
budget can never exceed the vendor limit it lives inside.

The curated seed spec in `src/core/providers/opendesign-models.ts` carried
the same wrong 232k assumption and is corrected to 1,000,000.

The user's own `opencode.json` was already correct and was not the problem.

## Why the safe-window fraction still applies

The fix does not weaken the eligibility gate. The gate is
`contextTokens + 20,000 ≤ model.context × 0.95`:

| Window | Safe ceiling | 329,321 required | Result |
|---|---|---|---|
| 232,000 (old) | 220,400 | 329,321 | fails |
| 1,000,000 (new) | 950,000 | 329,321 | passes |

A 20k margin and a 5% headroom are still withheld on the real window, and
the router still refuses a session that does not fit.

## Verification

**Tests** — `test/opendesign-context-limit.test.ts`, 4 cases. 3 of the 4 were
verified to fail against the previous code:

- the vendor limit is used when the budget is absent
- the reported budget still wins when the gateway supplies one
- a reported budget can never exceed the vendor limit
- a model with no seed spec still gets the vendor limit

Full suite **218 passing**, typecheck clean.

**Live, after restart** — artifact sha256 matches, one core, 7 bridges,
0 errors. The live registry now reports `minimax-m3.1-flash` at 1,000,000.

| Session | Context | Now routes to | Warnings |
|---|---|---|---|
| `ses_e9d15568` | 309,321 | `opendesign/minimax-m3.1-flash` | 0 |
| `ses_e85a4fff` | 275,710 | `opendesign/deepseek-v4.1-flash` | 0 |
| `ses_e9b57e9e` | 189,530 | `opendesign/deepseek-v4.1-flash` | 0 |

All 13 live sessions checked: **0 blocked**. The single session with no
chosen candidate is a manual override — its title reads `MANUAL`, and
"Manual override respected" is the correct behavior, not a block.

## Remaining constraint (not a bug)

Go Plus (1M window) and Command Code (1M window) are still excluded from
*this* session by their quota reserves, and OpenDesign's 328k models are
too small for a 309k context. Only OpenDesign's minimax qualifies. That is
correct: the session is on the one provider whose real window holds it, and
at 1× credits it is far cheaper than Go Plus at 89% monthly used.

If the owner wants a wider safety net, the lever is the reserve percentages
in `~/.config/opencode/smart-router.json` (`reserveMonthlyPct`,
`reserveWeeklyPct`), not the router's logic.

## Rollback

```bash
~/Documents/opencode-smart-router-backups/20261029-152224-od-context-limit-fix/rollback.sh
```
