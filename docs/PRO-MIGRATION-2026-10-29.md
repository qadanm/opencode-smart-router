# OpenDesign Pro migration, native context restoration, and productization refactor

Date: 2026-10-29
Branch: `feature/pro-plan-migration`
Commits: `b00a6a5` (migration), `efdeee5` (hydrate-fold fix)
Deployed artifact: `12baa038e2f184308e21109dd49371f63fbd20dd26a97d8de91e81e925404f74`
Status: live, verified. Nothing pushed, nothing published.

---

## 1. Changes made

### New modules

| File | Purpose |
|---|---|
| `src/core/plans/catalog.ts` | Every subscription described as data: pools, monthly ceilings, nested windows, per-model allowance tables, draw order, alias resolution. The single source of truth for "what does this plan give me". |
| `src/core/context/strategy.ts` | `decideCompaction()` — the three context modes. Replaces the single eager rule that lived in the controller. |
| `src/core/quota/report.ts` | Durable window aggregation and forecasting. `forecast()`, `buildProviderUsageReport()`. |

### Substantially rewritten

| File | Change |
|---|---|
| `src/core/quota/ledger.ts` | `foldUsage()` replaces the truncating `prune()`. Adds hourly `UsageBucket` aggregates, `periodIDFor()`, `aggregate()`, `usageByModel()`, speed recording, and a hydrate path that folds an over-cap legacy ledger instead of discarding it. |
| `src/core/quota/opendesign.ts` | Two-pool snapshot building, `capsFor()` that respects plan shape and window suppression, per-pool local usage attribution, `planNotes()`. |
| `src/core/providers/opendesign-models.ts` | 13 → 44 models, split into Design Plan models and plan models, each with gateway-reported context and output budget. |
| `src/core/routing/engine.ts` | `speedPenalty()`, two-pass escalation-pool guard, `speedFactor` on candidates. |
| `src/core/models/seed.ts` | OpenCode Go allowances corrected to the Go tier; catalog-driven allowances; `escalationOnly`; DeepSeek peak pricing shared between OpenCode Go and Command Code. |
| `src/core/models/registry.ts` | Plan catalog is authoritative for plan-metered allowances, so a plan change is config, not code. |
| `src/core/policy/eligibility.ts` | Hard eligibility gate for escalation-pool models. |
| `src/core/ui.ts` | `formatQuotaLines()` prints one line per pool and never sums them. |
| `src/server/controller.ts` | `maybeCompactForCost()` consults the strategy; `speedSnapshot()`; `usageReport()`; new `usage` RPC. |
| `src/core/config.ts` | `DEFAULT_SETTINGS` moved to Pro + OpenCode Go + native context; validators for the new settings. |
| `src/core/types.ts` | `ContextManagementMode`, `CreditPoolSnapshot`, `ContextManagementSettings`, `SpeedSettings`, `UsageBucket`, `UsageRollup`, speed fields on `ModelMetrics`, `escalationOnly`. |

### Tests added

`test/plans.test.ts` (22), `test/context-management.test.ts` (16), `test/pro-routing.test.ts` (12), `test/usage-history.test.ts` (19). `test/idle-compaction.test.ts` rewritten as an explicit budget-optimized suite.

---

## 2. Old restrictions removed or disabled

I traced every optimization to what it actually did, rather than assuming the list in the brief was accurate. Three of the listed items did not exist as separate mechanisms.

### Removed from the default path

**A single eager idle-compaction rule.** `maybeCompactForCost()` in the controller compacted any idle session whose context crossed 95% of *the cheapest variant's* window for that model id, with a 10-minute cooldown. The justification was explicit in the code comment: on OpenDesign Go, a long session pushed work off the cheap provider, and compaction was the only lever that fixed it. This was correct for a $10 allowance and is wrong for Pro. It now only runs when `contextManagement.mode` is `budget-optimized`.

**The `slice(-2000)` truncation.** `prune()` kept at most 2,000 raw events and dropped the oldest. This is the defect behind the 6.8-hour history: it was not a retention window doing its job, it was silent data loss. Replaced with folding.

**Hardcoded Go Plus allowances.** `opencode-go` was seeded with Go Plus per-model figures (`deepseek-v4.1-flash` at $160/mo). Now `$80`, and the figures come from the plan catalog rather than a second copy in the seed.

**Hardcoded OpenDesign Go caps.** `fiveHourCapUsd: 10`, `weeklyCapUsd: 30`, `monthlyCreditsUsd: 120` were in the live config and the code. Pro has no five-hour window at all; a stale `fiveHourCapUsd` would have invented a ceiling the plan does not have. `capsFor()` now consults plan shape first and treats an explicit override as subordinate to it.

### Explicitly preserved

**Provider-side prompt caching.** Untouched. The router never controlled it; the only thing that damaged it was unnecessary model switching, which the hysteresis and `preferSameProvider` already handled. Nothing in this change disables cache reads, prefix reuse, or cache-friendly behavior. Live cache share is 98.7%, matching the ~99% you observed.

**Real overflow protection.** Every mode still refuses to knowingly send an over-window request. `native` performs an emergency compaction when the transcript would exceed the *verified* window; setting `allowEmergencyCompaction: false` makes it fail loudly instead.

**Artificially low thresholds in context health.** None existed. `computeContextHealth()` only ever *advised* a new session at 400k/700k; it never compacted. I left it as advice and added a test asserting that advice does not trigger compaction.

---

## 3. New context behavior

Three modes, selected by `contextManagement.mode`. Default is `native`.

| Mode | When it compacts | Target window |
|---|---|---|
| `native` (default) | Only when `contextTokens + 20k margin > 0.95 × accepted window` | Current model's accepted window |
| `conservative` | Identical trigger; differs only in that nothing else can ever add to it | Current model's accepted window |
| `budget-optimized` (legacy) | When the transcript would cross `compactAtTokens` **or** the cheapest variant's window | Cheapest variant's window (or the explicit threshold) |

Key properties:

- **The margin and 95% factor are unchanged** from the old eligibility arithmetic. They were correct; only *when* they were consulted changed.
- **`native` uses the current model's window, not the cheapest variant's.** A session parked on OpenCode Go's 1M route is left alone at 325k, even though OpenDesign's variant of the same model only takes 328k. This is the specific regression the old code caused.
- **A plan with no five-hour window reports that row as not applicable**, not as 0% used — otherwise a dashboard implies a ceiling that cannot be hit.
- **Compaction sends a visible status** (`Protected context limit: …`) with the token counts, so it is never silent.

Verified live on the deployed build:

```
200k tokens on a 328k window  → 0 compactions, "fits the verified window"
290k tokens                   → 0 compactions
325k tokens                   → 1 emergency compaction
325k tokens on a 1M window    → 0 compactions
```

---

## 4. New routing behavior

Default remains balanced mode, and the ordinary coding default is **`opendesign/deepseek-v4.1-flash`**.

### Provider priority

1. **OpenDesign Design Plan pool** — DeepSeek V4.1 Flash at 0.5× credits is the cheapest adequately-capable route and wins nearly every ordinary task.
2. **OpenCode Go** — per-model allowances, 1M window on DeepSeek. Takes over when Design Plan is under pressure, when a longer window is needed, or when speed favors it.
3. **Command Code GOAT** — independent fallback, one shared $70 pool with nested 5h/7d ceilings.
4. **OpenDesign plan-model pool** — escalation only.

### Escalation-pool protection

`routing.protectEscalationPool: true`. A model funded from the plan-model pool is ineligible while an ordinary-allowance route can serve the task. This is a hard gate in `evaluateEligibility`, not a cost preference, so it cannot be outvoted by a cheap estimate.

Critically, it is applied in **two passes**: the engine first evaluates without the guard. If no ordinary-allowance route is eligible, the guard is not applied at all — so a task that genuinely needs escalation still escalates rather than failing closed.

### Speed as a routing factor

Measured as **output tokens per second**, which is the only figure that separates a slow provider from a model that reasons for longer. A model emitting 3,000 reasoning tokens before answering is not "slow" in the same sense as one taking four times as long to emit the same answer.

- Compared against the fastest eligible route, not an absolute number, so it adapts.
- Neutral below `minSamples` (3), so one fast request cannot promote a model on noise.
- Raises effective cost; never makes a route ineligible.
- Routes at or beyond `slowRouteMultiple` (2.5×) of the fastest are penalised harder.
- `weightPct` (15) sets the strength; `enabled: false` removes it entirely.

Live sample: `opendesign/deepseek-v4.1-flash` at 36.6 tok/s over 3 samples, so the penalty is currently computed but not yet discriminating (only one model has samples).

### Unchanged and deliberately so

Vision gating, the intelligence floor, design floors, long-context handling, fail-closed admission, and the hysteresis that prevents flapping.

---

## 5. Subscription accounting

### OpenDesign Pro — two pools, never summed

| Pool | Monthly | 7-day | 5-hour | Reset |
|---|---|---|---|---|
| Design Plan credits | $360 | $90 (nested) | **none** | rolling-7-day |
| Plan model credits | $120 | none | none | billing-cycle |

The advertised $480 is **two allowances with different rules**. Summing them would tell a user they can spend it in one go, which is false: the seven-day ceiling applies only to the first pool, and the second is the escalation budget.

`fundingPoolFor()` and `poolDrawSequence()` encode the rule that a Design Plan multiplier applies only inside the Design Plan pool. `deepseek-v4.1-flash` costs 0.5× there and full value once it spills into plan-model credits. A test asserts exactly this.

Live status at verification:

```
design-plan    $359.35 of $360 remaining, 7d 5.98% of $90, no 5h window
plan-models    $116.11 of $120 remaining, no windows
source         estimated (OpenDesign publishes no quota API for an inference key)
```

### OpenCode Go — Go, not Go Plus

Per-model monthly allowances, with 5-hour = 20% and weekly = 50% of each model's own figure. Allowances do not pool across models. `deepseek-v4.1-flash` = $80/mo → $16 per 5h, $40 per week.

Live: `OpenCode Go`, plan `go`, monthly 90% reported by the provider.

### Command Code GOAT — unchanged

$70/month, $14 per 5-hour, $35 per week, provider-reported as authoritative. Live: 0.01% / 85.8% / 42.9%.

### Spending rules — unchanged and enforced

`allowExtraUsage: false`, `subscriptionOnly: true`, `premium.mode: "off"`, wallet never used for automatic routing, no control key acquired automatically, no paid API calls made for verification.

### Usage tracking

The 2,000-event ceiling is gone. Events older than 48 hours fold into hourly buckets keyed by provider, model, and billing-period. Retention is 400 days, and a heavy week now costs a few hundred rows instead of losing its own beginning.

**Live proof of the fix:** the store now holds 1,600 raw events plus 432 folded requests = **2,032 accounted**. Before the fix it held exactly 2,000 and the 83 OpenCode Go events from earlier in the week were gone. The hydrate path was fixed separately (`efdeee5`) because the first load after upgrade still ran the truncating path once.

Forecasts use a representative basis floored at one hour and capped at the window, so a five-minute burst is not extrapolated into a month.

---

## 6. Tests

```
npx tsc --noEmit      → clean, exit 0
npx vitest run        → 23 files, 288 tests passed
npm run build:server  → dist/index.js, 334.2 kb
```

Baseline before any change was 218 tests across 19 files. Net +70 tests.

New coverage by requirement:

| Requirement | Test file | Count |
|---|---|---|
| Pro recognized, two pools, no 5h window | `plans.test.ts` | 22 |
| Go vs Go Plus, per-model windows, GOAT unchanged | `plans.test.ts` | (incl.) |
| Ordinary conversations do not compact | `context-management.test.ts` | 16 |
| Current model's window, not cheapest variant | `context-management.test.ts` | (incl.) |
| Mode switching does not corrupt state | `context-management.test.ts` | 1 |
| Legacy mode still works when enabled | `idle-compaction.test.ts` | 6 |
| Default selection, vision, long context, exhaustion | `pro-routing.test.ts` | 12 |
| Speed penalty, sample floor, disable | `pro-routing.test.ts` | (incl.) |
| Durable history, folding, periods, restart | `usage-history.test.ts` | 19 |
| Forecasts, cache share, not-applicable windows | `usage-history.test.ts` | (incl.) |

### Live verification on artifact `12baa038…`

- Service healthy: PID 34943, 8 bridges, 0 errors.
- Status: `OpenCode Go` / `OpenDesign Pro` plan `pro` with both pools / `Command Code GOAT`.
- Usage RPC: native mode, 2,032 requests, 98.7% cache share, per-model rows, forecasts.
- Routing: feature, debug, architecture, docs and design all resolve to `opendesign/deepseek-v4.1-flash` with zero warnings.
- Vision: a real image file sets `requiresVision: true` and the router picks a native-vision model.

### Not verified

- I did not run a near-1M-token request (explicitly out of bounds without approval).
- OpenDesign quota stays `estimated`; no control key exists, so provider-confirmed OpenDesign numbers are unavailable.
- Speed-based routing is not yet discriminating in production because only one model has enough samples.

---

## 7. Productization readiness

### Separated cleanly

- **Plan definitions** — `plans/catalog.ts`. A different user's tier is a data entry, not a code branch. No plan string appears in `routing/`, `policy/` or `models/`.
- **Provider adapters** — `providers/`, `quota/`. Each adapter normalizes into shared types.
- **Context strategies** — `context/strategy.ts`. Provider-agnostic; would serve a hosted API user unchanged.
- **Usage accounting** — `quota/ledger.ts` + `quota/report.ts`.
- **Routing** — `routing/engine.ts`, `policy/eligibility.ts`. Reads `ModelRecord`, never a vendor id.
- **UI** — `ui.ts`, `rpc.ts`.
- **User settings** — `~/.config/opencode/smart-router.json`, outside the source tree.

### Secrets and identifiers

Audited `src/` for `/Users/…`, personal identifiers, workspace ids and emails: **none present**. All three path sites derive from `homedir()` (`credentials.ts` ×2, `config.ts`). Credentials are read at runtime from the user's own stores and never logged; `redact()` is applied to error strings.

### What still needs work before any release

The old optimization subsystem is reusable but is not yet a separately publishable package: it is imported directly rather than through an interface, and `budget-optimized` has no cost model of its own beyond the cheapest-variant window. That is a packaging task, not an architectural one.

---

## 8. Remaining limitations

1. **OpenDesign quota is estimated, not verified.** The inference key cannot read quota; `/v1/usage`, `/v1/me`, `/logs`, `/requests`, `/history`, `/credits` all 404; upstream issues `#8674` and `#8870` are open. A control key would fix this but none is configured and none was acquired automatically. The estimate is a lower bound because usage from the OpenDesign app is invisible to the router.
2. **`minimax-m3.1-flash`'s multiplier is unpublished.** Neutral 1× is applied and the uncertainty is surfaced in the model notes. Requires a provider-reported dollar figure or one paid request to resolve.
3. **GLM cache-read price discrepancy** is unresolved for the same reason.
4. **~5% OpenDesign gateway failure rate** (`workspace_billing_scope_unavailable`) is upstream. Drafted at `docs/UPSTREAM-ISSUE-billing-scope.md`, not filed.
5. **DeepSeek peak pricing** (2× at 01–04 and 06–10 UTC, Mon–Fri) is modelled for OpenCode Go and Command Code but is not a factor in routing cost ranking yet.
6. **Speed telemetry has three samples for one model.** The machinery is live and tested; it needs production traffic before it changes decisions.
7. **`periodID` is a calendar month**, exact for billing-cycle resets and an approximation for anniversary-based ones. It exists to keep two *different* periods from being summed, which it does correctly.
8. **1M-context routing is verified structurally, not empirically.** The engine correctly prefers ≥1M windows and refuses routes whose window cannot hold the context; no actual 700k-token request was sent.

---

## 9. Rollback

```
~/Documents/opencode-smart-router-backups/20261029-pro-migration/
├── smart-router.json.original     previous live config (Go, $120/$10/$30)
├── index.js.previous              artifact ed5a6493…, hash-verified
└── rollback.sh
```

`rollback.sh` restores the config and the previous artifact and prints the restart command. It does not touch subscriptions, credentials, sessions, or the ledger — none of which the migration modified incompatibly.

To revert the code: `git checkout 0f0b9b6 && npm run build:server`.
