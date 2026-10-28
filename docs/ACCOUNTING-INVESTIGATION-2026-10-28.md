# Command Code accounting investigation

**Date:** 2026-10-28
**Artifact:** `8c71c46c5f7616f950c6a3fcf5c42be2198407848cf9ffac15d01504496f8920`
**Code commit:** `e8fa5ac`
**Scope:** no new paid inference. Read-only provider records, existing logs, the live OpenCode session database (metadata only), published pricing, and deterministic tests.

> **Deployment addendum (2026-10-28):** after this investigation, the verified artifact was installed in the live desktop in **dry-run mode** (automatic routing off). See [DESKTOP-DRY-RUN-2026-10-28.md](DESKTOP-DRY-RUN-2026-10-28.md). The accounting conclusions below are unchanged.

## Verdict

The **38.5× figure is not a 38.5× pricing error**. It compared the two canary request estimates (`$0.0015808`) with an account-wide provider delta (`$0.0608870`) that included concurrent live-desktop usage. The canary requests cannot be isolated from that aggregate.

A **separate monthly-accounting defect was confirmed and fixed**: the adapter used Command Code's billing-period usage-summary endpoint to derive monthly usage and the monthly grant, even though that endpoint and the remaining-credit balance are different accounting pools. The remaining-credit balance is authoritative. The adapter now derives monthly usage from a stable provider-reported grant minus that balance and keeps the summary only as a diagnostic cross-check.

No live desktop configuration was modified **during this investigation**, no application restart was performed, and no plugin was installed globally. A separate, reversible dry-run deployment followed; see the addendum above.

## 1. Request-level facts

| Item | Value |
|---|---:|
| Command Code canary requests | 2 |
| Local session cost, request 1 | `$0.001523118` |
| Local session cost, request 2 | `$0.000057720` |
| Local canary total | `$0.001580838` |
| Provider 5h window delta | `+$0.060886991` |
| Provider weekly window delta | `+$0.060886991` |
| Provider monthly remaining delta | `−$0.060886991` |
| Naive provider/session ratio | `38.516×` |

The local arithmetic matches the published Command Code off-peak rates exactly:

- `10,117 × $0.15/M + 8 × $0.60/M + 256 × $0.003/M = $0.001523118`
- `136 × $0.15/M + 11 × $0.60/M + 10,240 × $0.003/M = $0.000057720`

The Stage B requests ran at **04:27–04:36 UTC**, outside the documented peak bands (`01:00–04:00` and `06:00–10:00` UTC, Monday–Friday). Published peak rates are exactly 2× the off-peak input, output, and cache-read rates.

The GOAT plan's “up to 10× credits” is an **allowance multiplier** (for example, a $70 included-usage grant), not a multiplier applied to every request's published token price. No per-request credit multiplier appears in the records; the canary's local token arithmetic matches the published rates exactly.

The canary response metadata reported `reasoning: 0` and `output: 8` / `11`; there was no cache write. The live desktop sessions in the same window did report reasoning tokens (63,692 and 7,562), so the model can reason, but the two canary responses reported none. If the provider bills hidden reasoning that the host does not report, that would be a provider/host accounting gap rather than a router price-table error; the aggregate windows cannot quantify it. There is no evidence of hidden reasoning in the canary records.

There is no confirmed error in the per-request token arithmetic.

## 2. Concurrent account activity

The live OpenCode database (read-only metadata; no prompt text read or stored) shows the same Command Code account in active use during the canary window:

| Window | Command Code assistant messages | Local estimated cost |
|---|---:|---:|
| 04:20–04:40 UTC | 74 | `$0.284917` |
| 04:27 UTC only | 11 | `$0.082297` |

The 04:27 activity aligns with the `+$0.0731` jump that occurred **before the first canary request**. The live desktop was therefore using the shared account at the same time as the isolated canary. Its local estimate is not a provider bill, but it establishes that the account-level delta is composed of multiple sessions, not just the two canary requests.

**Verified:** the account delta cannot be attributed to the canary alone; concurrent live-desktop usage is present.
**Unresolved:** exact per-request provider attribution. The provider exposes aggregate rolling windows and a billing-period summary, not request-level billing history. No request IDs or per-request provider charges were available after the isolated credentials were removed.

## 3. Monthly accounting defect

Command Code reports several monthly figures:

- `credits.monthlyCredits` — remaining included credits.
- `windowLimits.fiveHour` and `windowLimits.weekly` — rolling dollar windows.
- `/alpha/usage/summary` — billing-period usage (`totalMonthlyCredits`), a separate aggregate.

The account's plan grant is **$70**: the provider reports a $14 five-hour cap (20% of $70) and a $35 weekly cap (50% of $70). At both Stage B snapshots, `$70 − monthlyRemaining` equals the weekly used amount exactly:

| Snapshot | Remaining | Derived used (`70 − remaining`) | Weekly used | Summary `usedUsd` |
|---|---:|---:|---:|---:|
| Before requests | `42.394248873` | `27.605751127` | `27.605751127` | `27.924756069` |
| After requests | `42.333361882` | `27.666638118` | `27.666638118` | `28.080547352` |
| Delta | `−0.060886991` | `+0.060886991` | `+0.060886991` | `+0.155791283` |

The summary is higher than the balance-derived usage by `$0.3190` before and `$0.4139` after. The difference is not stable, and using `remaining + summaryUsed` produced a fluctuating “grant” of `$70.3190` then `$70.4139` instead of the stable `$70`. The summary therefore cannot be used to derive the monthly grant or the monthly consumption for this account.

### Correction

`src/core/quota/commandcode.ts` now:

1. Derives the monthly grant from the provider's own 5-hour cap ÷ 20% (or weekly cap ÷ 50%), then the plan registry, then the configured allowance.
2. Derives monthly used as `max(0, grant − monthlyRemaining)`.
3. Uses the billing-period summary only as a diagnostic; if it differs by at least half a cent, the snapshot includes a note that remaining credits are authoritative.
4. Preserves `monthlyRemainingUsd` and marks the monthly window exceeded when the remaining balance reaches zero.

The exact reason the summary and balance differ remains unresolved. It is now contained: the router does not use the summary for routing pressure, model prices, or allowance protection.

## 4. Peak pricing

Command Code publishes a 2× peak rate for DeepSeek V4.1 Flash during `01:00–04:00` and `06:00–10:00` UTC, Monday–Friday. The seed previously carried only the off-peak rates, so peak estimates were understated by 2×.

The model registry now carries documented peak metadata, and the cost estimator applies the multiplier to input, output, cache-read, and cache-loss costs using the request time. Models without documented peak metadata keep their flat catalog rates. A regression test covers a weekday peak, a weekday off-peak, a weekend peak hour, and live-catalog cost merging.

## 5. Quality eligibility: DeepSeek V4.1 Flash and Claude Haiku 5.5

- DeepSeek V4.1 Flash intelligence: **39.5**, the standard floor.
- Claude Haiku 5.5 intelligence: **43.4**, above the standard floor.
- Claude Haiku 5.5 design: **70**, below the sophisticated-design floor of **75** and above the standard design floor of **60**.

Haiku is therefore a valid standard model and a standard-design model, but it is **not** sophisticated-design qualified. The router already refused it at the strict 75 floor and relaxed to the standard 60 floor with a decision warning. The candidate reason now states this explicitly:

> `Standard design route: design 70 is below the sophisticated 75 threshold`

The premium route remains separated: the Stage B preview selected a non-premium model, reported `needsPremiumApproval: true`, and spent nothing. No premium model was selected or billed.

## 6. Purchased-credit safety

- Purchased credits were **$0 before and after** Stage B.
- `allowExtraUsage` defaults to **false** for both providers.
- A new guard treats `monthlyRemainingUsd <= 0` as authoritative even if the provider has not yet set an `exceeded` flag. With extra credits available and automatic extra usage disabled, the route is blocked before it can knowingly enter purchased-credit spending.
- The guard is unit-tested in both directions: blocked with `allowExtraUsage: false`, allowed only when explicitly enabled.
- This is a client-side policy guarantee. It does not replace provider-side enforcement; the provider remains the final authority on whether a request is charged to purchased credits.

## 7. Corrections and verification

| Correction | Test coverage |
|---|---|
| Monthly usage from remaining credits, not the usage summary | Command Code adapter tests: corrected grant, divergent summary, summary unavailable |
| Stable grant from provider window caps | Fixture: `$14 / 20% = $70`, `$35 / 50% = $70` |
| Documented 2× peak pricing | Weekday peak/off-peak, weekend, live-catalog merge |
| Design fallback is explicit | Strict 75 rejection, relaxed fallback reason, routing candidate reason |
| Zero remaining balance blocks purchased credits | Blocked and explicitly-allowed cases |
| No account-delta attribution to model ledgers | Provider 50% used / $35 remaining does not move a $0.0015 model ledger |

- `npm run typecheck`: clean
- `npm test`: **9 files, 106 tests passed**
- Artifact: `8c71c46c5f7616f950c6a3fcf5c42be2198407848cf9ffac15d01504496f8920`
- Isolated lab validation of the exact artifact: **16 router commands**, **2 mock inference requests**, **0 plugin errors**, design fallback labeled correctly.
- Fresh 30-minute mock-only soak on the exact artifact: **29 samples**, **1,491 mock requests**, one PID/core, one event stream, 21 bridges, 63 setups / 42 disposes, **0 plugin errors**, one expected `ECONNREFUSED` at the intentional outage; the outage and large-context sessions succeeded. See `docs/evidence/stage-b/soak-summary-8c71c46c.json`.
- Live config hash remained `83872b2d7dafd907ff620bdef0117ba80edb931504d888e5c0547628f9e820d7`; live service PID `90727` on port `49374` was not restarted. Isolated lab processes were stopped.

## 8. Remaining uncertainty

1. Exact provider charge per canary request cannot be reconstructed from aggregate windows. The 38.5× figure must not be used as a price ratio.
2. The summary-versus-balance difference is not explained by any public field. It is now diagnostic only.
3. Peak pricing is modeled only where documented. Other providers/models may have time-of-day rules not represented in the seed; their estimates remain ordinary catalog estimates.
4. The client can block automatic extra-credit use, but only the provider can guarantee that a request never falls through to purchased credits.
5. The original Stage A lifecycle soak was run on the previous artifact. The exact new artifact passed a fresh 30-minute mock-only soak (one PID/core, one event stream, 0 plugin errors); the full Stage A matrix on `e65326c9…` remains the lifecycle reference. See [RELEASE-READINESS-2026-10-28.md](RELEASE-READINESS-2026-10-28.md).

## 9. Deployment recommendation

The accounting and quality defects found in Stage B are corrected and covered by deterministic tests. The router is suitable for a **controlled, reversible desktop canary** with this exact artifact, subject to explicit authorization and monitoring of provider-reported remaining balances. It is **not** authorized for unattended or global rollout, and local per-request estimates must not be treated as provider bills.
