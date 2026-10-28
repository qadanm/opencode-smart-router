# Stage B — limited real-provider verification

**Date:** 2026-10-28
**Artifact:** `e65326c9bc7b36a4470bab2d631253d233e918fc76b4b93d5cf1bab8020a5fa4`
**Code commit:** `6099a3d`
**Isolated server:** `127.0.0.1:4220`, separate HOME/XDG/data/cache, disposable project
**Live environment:** untouched — config hash unchanged, desktop service on 49374 not restarted
**Requests:** 2 Go Plus, 2 Command Code — at the approved per-provider limit

> **Accounting addendum (2026-10-28):** The 38.5× provider/session comparison in this report is **invalid as a pricing-error measure**. The live desktop was using the same Command Code account during the canary window (74 assistant messages in 04:20–04:40 UTC; 11 in the 04:27 minute alone), so the account-level delta is not attributable to the two canary requests. A separate monthly-accounting defect was confirmed and fixed in artifact `8c71c46c…` (commit `e8fa5ac`): monthly usage is now derived from the provider's remaining-credit balance, not the billing-period usage summary. See [ACCOUNTING-INVESTIGATION-2026-10-28.md](ACCOUNTING-INVESTIGATION-2026-10-28.md). No live changes were made.

## Verdict

**Stage B limited verification passes for authentication, quota retrieval, routing, vision, premium protection, purchased-credit safety, and command/safety initialization.**

**One material accounting discrepancy remains:** Command Code’s provider-reported five-hour/weekly consumption for the two requests was **$0.060887**, while the session model-cost accounting was **$0.001580838** (about **38.5×** lower). The provider’s monthly `usedUsd`/grant fields also do not reconcile exactly with the five-hour/weekly delta, though `monthlyRemainingUsd` moved by exactly **−$0.060887**. This is a routing/accounting risk, not a request failure.

## Authentication and quota

- OpenCode Go Plus: **OpenCode Console OAuth** connected; read-only quota reports provider data.
- Command Code GOAT: isolated key file + provider key; read-only billing reports provider data.
- An early quota probe cached “No OpenCode Go access token” before the integration was ready; restarting the isolated server produced correct Go provider data. No request was sent while Go quota was unknown.
- Command Code purchased credits: **$0 before and after**.
- Premium: mode `ask`, budget 0, one-shot approval false, spend **$0**; no premium model was used.

## Bounded requests

| # | Provider | Request | Actual model | Result |
|---|---|---|---|---|
| 1 | OpenCode Go Plus | text: `Reply exactly: STAGE-B-GO-OK` | `opencode-go/claude-haiku-5-5` | `STAGE-B-GO-OK` |
| 2 | OpenCode Go Plus | 163-byte synthetic blue-square PNG: color? | `opencode-go/claude-haiku-5-5` | `Blue` |
| 3 | Command Code | text: `Reply exactly: STAGE-B-CC-OK` | `commandcode/deepseek-v4.1-flash` | `STAGE-B-CC-OK` |
| 4 | Command Code (post-restart) | text: `Reply exactly: STAGE-B-CC-RESTART-OK` | `commandcode/deepseek-v4.1-flash` | `STAGE-B-CC-RESTART-OK` |

All four returned HTTP 200 and `outcome=succeeded`. Router decision/current model matched the actual session model for every request. No tools were used, no external side effects, and no retries were needed.

## Usage before → after

### OpenCode Go Plus

| Window | Before | After | Delta |
|---|---:|---:|---:|
| rolling / 5h | 3% | **4%** | +1 pp |
| weekly | 63% | 63% | 0 |
| monthly | 81% | 81% | 0 |

Session estimates: Go text `$0.001321835`, Go vision `$0.00017506`. Provider reports percentages, not a dollar balance; weekly/monthly resolution is coarse.

### Command Code GOAT

| Metric | Before | After | Delta |
|---|---:|---:|---:|
| 5h used % | 6.917547% | 7.352454% | +0.434907 pp |
| 5h used USD | 0.968456634 | 1.029343625 | **+0.060886991** |
| weekly used % | 78.873575% | 79.047537% | +0.173963 pp |
| weekly used USD | 27.605751127 | 27.666638118 | **+0.060886991** |
| monthly used % | 39.711535% | 39.879262% | +0.167727 pp |
| monthly used USD | 27.924756069 | 28.080547352 | +0.155791283 |
| monthly remaining USD | 42.394248873 | 42.333361882 | **−0.060886991** |
| purchased credits | 0 | 0 | 0 |

Session estimates for the two Command Code requests: `$0.001523118` and `$0.00005772` (total **$0.001580838**). Provider-reported five-hour/weekly consumption for the same two requests: **$0.060887** — a **38.5×** difference.

`monthlyRemainingUsd` is consistent with the five-hour/weekly delta; the monthly `usedUsd` field is not, likely due billing-period grant/usage reconciliation. The account is shared with the live desktop, so some account-level movement may not be attributable to this canary; no live requests were made by this test.

## Commands and safety initialization

- Before every prompt, commands were verified at **16**, plugin active, one core, one bridge, one event stream, zero errors.
- After the isolated process restart, commands were verified at 16 before the post-restart Command Code prompt; the prompt succeeded.
- The first command query immediately after restart can transiently return 0 while the location command cache warms; a retry returned 16. No prompt is admitted by this test until the 16-command state is confirmed.
- No thrash warnings, server errors, or duplicate registrations observed.

## Premium and vision

- Premium preview selected a non-premium model and reported `needsPremiumApproval:true`; no premium request was made.
- The synthetic 163-byte blue-square image was accepted as a native image attachment; Go’s vision model answered `Blue`.
- Unapproved models were not selected.

## Isolation and cleanup

- Artifact hash verified before start.
- Isolated HOME/config/data/cache and disposable project only.
- Live config hash remained `83872b2d7dafd907ff620bdef0117ba80edb931504d888e5c0547628f9e820d7`.
- Live background service on 49374 stayed running (PID 90727); no desktop restart.
- Isolated server stopped; isolated root and project removed, including the temporary auth and key; no credentials or test processes remain.
- Evidence manifests are self-excluding (`SHA256SUMS.txt` does not include itself); `shasum -a 256 -c SHA256SUMS.txt` passes in the Downloads report folders.

## Remaining risks

1. **Command Code cost accounting is not trustworthy at the session level.** The router’s catalog estimate was 38.5× below provider-billed usage for two small calls. Provider-reported windows remain authoritative; per-model cost ranking and premium protection based on local estimates can understate real spend.
2. **Shared account.** The live desktop and the isolated canary use the same provider accounts. Account-level deltas cannot be exclusively attributed to the canary if the desktop is used concurrently.
3. **Monthly provider fields do not reconcile** with five-hour/weekly usage, although remaining credits do.
4. **Go weekly/monthly percentages are coarse** and did not move; no dollar balance is exposed.
5. **No real quota exhaustion or fallback** was attempted. That remains simulated locally, as required.
6. **OpenCode Go quota requires the Console OAuth integration**, not the OpenCode Go API key; a fresh-start probe can briefly cache the unauthenticated state.
7. **Broader deployment is not authorized.** Stage B was limited to four requests and one disposable project.

## Decision

Stage B is complete and stopped. Do not install globally or modify the desktop. Any broader deployment requires a separate decision, and should address the Command Code accounting discrepancy before relying on local cost estimates.

## Follow-up

The accounting investigation is complete. The 38.5× comparison was invalidated by concurrent live-desktop usage; the local token arithmetic matches published off-peak rates. A separate monthly-summary accounting defect was fixed, documented peak pricing was added, and the sophisticated-design fallback is now explicit. The exact new artifact is `8c71c46c5f7616f950c6a3fcf5c42be2198407848cf9ffac15d01504496f8920` (commit `e8fa5ac`, 106 tests) and passed a fresh 30-minute mock-only soak on the exact bundle. See [ACCOUNTING-INVESTIGATION-2026-10-28.md](ACCOUNTING-INVESTIGATION-2026-10-28.md) and [RELEASE-READINESS-2026-10-28.md](RELEASE-READINESS-2026-10-28.md). No global installation or live desktop modification was performed.
