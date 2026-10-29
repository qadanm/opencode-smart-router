# Balance & Usage Report — All Three Subscriptions

Generated: 2026-10-29 02:35 local
Router: `1dbbb39a232743aa386bb7867265996f5960935f68a64fd93ae8d119df907fd8` (commit `c963eb5`)
Evidence: live `/api/rpc/smart-router/status` probe + local message store + provider billing APIs

Every figure below is marked with how it was obtained:

| Mark | Meaning |
|---|---|
| **PROVIDER** | Read from the provider's own API. Authoritative. |
| **ESTIMATE** | Computed by the router from locally observed usage. A *lower bound* — it cannot see usage from other clients. |
| **LOCAL** | Read from the local OpenCode message store. Complete for this machine, invisible to the provider. |

---

## 1. At a glance

| Provider | Plan | Binding window | Remaining | Resets |
|---|---|---|---|---|
| **OpenCode Go Plus** | go-plus | Monthly | **11%** | Fri 2026-11-20 03:37 |
| | | Weekly | **22%** | Sun 2026-11-01 16:00 |
| | | 5-hour | **99%** | rolling |
| **Command Code GOAT** | GOAT (active) | Weekly | **14.2%** (~$4.97 of $35) | Fri 2026-10-30 23:41 |
| | | Monthly | **57.1%** (~$39.97 of $70) | Mon 2026-11-23 22:25 |
| | | 5-hour | **100%** ($0 of $14) | rolling |
| **OpenDesign Go** | go | Monthly | **97.5%** (~$117 of $120) | monthly |
| | | Weekly | **90.1%** (~$27 of $30) | weekly |
| | | 5-hour | **85.6%** (~$8.56 of $10) | rolling |

**Go Plus is the constraint**, not OpenDesign. Its monthly pool is 89% spent with
22 days still to run.

---

## 2. OpenCode Go Plus — PROVIDER

Meters are percentages only; the endpoint publishes no dollar figures and no history.

| Window | Used | Remaining | Reset |
|---|---|---|---|
| 5-hour | 1% | 99% | rolling |
| Weekly | 78% | 22% | Sun 2026-11-01 16:00 (+3.6 d) |
| Monthly | 89% | 11% | Fri 2026-11-20 03:37 (+22.1 d) |

At 11% monthly remaining, the pool is nearly gone. Assuming the remaining 11% is
spread evenly across the 22 days left, the affordable pace is roughly **0.5% of
the monthly pool per day**. Recent observed pace has been far higher — see §6.

The weekly meter at 22% is the nearer-term ceiling: if usage resumes at the rate
of the last week, the weekly window runs out before its Sunday reset.

---

## 3. Command Code GOAT — PROVIDER

Plan status **active**. Real dollars, not percentages.

| Window | Used | Cap | Remaining | Reset |
|---|---|---|---|---|
| 5-hour | $0.00 | $14 | 100% | rolling |
| Weekly | $30.03 | $35 | **$4.97 (14.2%)** | Fri 2026-10-30 23:41 (+1.9 d) |
| Monthly | $30.03 | $70 | **$39.97 (57.1%)** | Mon 2026-11-23 22:25 (+25.9 d) |

- Billing period started **2026-10-23 23:25**.
- Extra credits: **$0 purchased, $0 free** — this is a pure subscription, no top-ups.
- Weekly and monthly used are identical ($30.03) because all spend so far fell
  inside the current week.

**Projection:** the account burned $30.03 in 5.13 days, an average of
**$5.85/day**. At that pace the remaining $4.97 of weekly headroom lasts
**~0.85 days** — i.e. it would exhaust roughly a day before the Friday reset.
The monthly pool would also run dry early: $70 at $5.85/day is **~12 days** of
subscription in total, so ~6.8 days of monthly headroom remain at that pace.

That is the historical pace, not the current one. Command Code has been idle
since its key died on Oct 28 ~11:20 and was only reconnected in this session, so
its actual burn today is zero. The weekly window will hold at 14.2% as long as
the router keeps preferring OpenDesign.

---

## 4. OpenDesign Go — ESTIMATE

No provider API exists for an inference key, so these are the router's own
estimates. Treated as a lower bound: usage from the OpenDesign desktop app or any
other client is invisible.

| Window | Used | Cap | Remaining |
|---|---|---|---|
| 5-hour | $1.44 | $10 | 85.6% |
| Weekly | $2.96 | $30 | 90.1% |
| Monthly | $2.96 | $120 | 97.5% |

Method: token counts × curated list prices × the **0.5× credit multiplier** that
applies to `deepseek-v4.1-flash`, summed over retained usage events.

**Important limitation.** The router's usage ledger caps at **2,000 events**
(`MAX_USAGE_EVENTS`), which at current volume covers only ~6.8 hours — 1,934 of
the 4,303 OpenDesign steps in the last 24 hours. The weekly and monthly figures
therefore describe the *retained window*, not the whole period. Extrapolating by
message share, true 24-hour OpenDesign spend is roughly **$5–7**, which is still
only **4–6% of the $120 monthly pool**. The direction of the error is known: the
estimate is too low, never too high.

For reference, the credit multipliers on this plan:

| Multiplier | Models |
|---|---|
| 0.5× | deepseek-v4.1-flash |
| 1× | deepseek-v4-flash, glm-5.3-flash, mimo, hy4-preview, deepseek-v4-pro, kimi-k2.7-code |
| 2× | claude-haiku-5.5, glm-5.3-flashx |
| 4× | gpt-6-luna |

---

## 5. Rate of usage — LOCAL

Requests are counted as assistant messages (one per model step). Measured from
the message store, which is complete for this machine.

| Window | Total | OpenDesign | Go Plus | Command Code |
|---|---|---|---|---|
| Last hour | 491 | 468 (95%) | 23 (5%) | 0 |
| Last 6 h | 1,702 | 1,635 (96%) | 67 (4%) | 0 |
| Last 24 h | 5,122 | 4,303 (84%) | 819 (16%) | 0 |
| Last 72 h | 18,824 | 4,303 (23%) | 12,751 (68%) | 1,769 (9%) |
| Last 7 d | 40,638 | 4,303 (11%) | 21,171 (52%) | 14,770 (36%) |

Rows total slightly more than the provider split accounts for in the two longest
windows (18,824 vs 18,823; 40,638 vs 40,244) because a handful of steps carry no
provider attribution in the store. The shares are unaffected.

- **Mean pace, last 7 days:** 290 requests/hour across 140 active hourly buckets.
- **Peak hour:** 1,307 requests (Oct 24, 00:00).
- **Routing has shifted decisively to OpenDesign** since Oct 28 10:03: from 11%
  of the week's traffic to 84–96% of the last 24 h / 6 h.

The 72-hour column is the clearest picture of the migration: Go Plus carried 68%,
Command Code 9%, OpenDesign 23%. Within the last 24 hours OpenDesign carries 84%,
and within the last hour 95%.

### Burn rate implied by the windows

| Provider | Window | Used per day | Headroom | Time to exhaust |
|---|---|---|---|---|
| Command Code | weekly $ | $5.85 | $4.97 | ~0.85 d (historical pace) |
| Command Code | monthly $ | $5.85 | $39.97 | ~6.8 d at this pace |
| Go Plus | monthly % | ~3.0 pts* | 11 pts | ~3.7 d at recent pace |

\* derived from 89% used over the ~30-day period. The weekly view shows the
recent pace much higher than that average: 6.1 pts/day would be affordable
against the 22 pts left, and the last week burned 78 pts.

**Reading:** at present routing, OpenDesign is not under pressure at all; Go Plus
is the one that cannot absorb another week like the last one.

---

## 6. Usage history — what each account actually exposes

This was verified by calling each endpoint, not assumed.

| Provider | History available? | What you get |
|---|---|---|
| **Command Code** | **Yes — real aggregates** | `/alpha/usage/summary` returns request count, cost, success rate and token totals. No daily timeseries (`daily: []` is empty). |
| **OpenCode Go** | **No** | `/zen/go/v1/usage` returns only current `percent` + `resetsAt` for the three windows. No past data, no timeseries, no endpoint for it. |
| **OpenDesign** | **No** | No usage API for an inference key at all. `GET /v1/usage` and `/v1/me` return 404; the account-control host rejects an inference key with 401. Upstream requests open: nexu-io/open-design#8674 (usage endpoint), #8870 (control-key lifecycle). |
| **This machine** | **Yes — 13 months** | 71,331 assistant messages with provider attribution, plus 620 sessions with cost and token aggregates. |

### Command Code, as the provider reports it

```
requests      15,600
total cost    $30.446
success rate  100%      (0 failed)
tokens in     3,354,903,074
tokens out       17,566,444
basis         billing-period, from 2026-09-29
```

**This validates the router's local estimates.** The router recorded 14,770
Command Code messages on this machine and estimated **$0.00204 per request**;
the provider independently reports **$0.00195 per request** ($30.45 / 15,600).
Those agree to within 5%, which is a strong signal that the local pricing model
is sound. The small gap is traffic from before the router was installed plus any
other client.

### OpenDesign: why it is an estimate, not a fact

The provider publishes no key-readable usage surface. Confirmed by the router's
own integration notes and by direct probes. The estimate is deliberately biased
low and reports its uncertainty rather than hiding it.

### 13-month local history, by provider

Assistant messages per calendar month. `opencode` here is the legacy personal
Zen account, predating all three subscriptions.

| Month | opencode | opencode-go | commandcode | opendesign |
|---|---|---|---|---|
| 2025-09 | 49 | — | — | — |
| 2025-10 | 1,029 | — | — | — |
| 2025-11 | 1,706 | — | — | — |
| 2025-12 | 3,218 | — | — | — |
| 2026-01 | 69 | — | — | — |
| 2026-02 | 1,504 | — | — | — |
| 2026-04 | 388 | — | — | — |
| 2026-06 | 1,598 | — | — | — |
| 2026-07 | 8,960 | — | — | — |
| 2026-08 | 1,558 | — | — | — |
| 2026-09 | 639 | — | — | — |
| 2026-10 | 10,325 | 21,219 | 14,770 | 4,268 |

All-time: **31,043** legacy opencode, **21,219** Go Plus, **14,770** Command Code,
**4,268** OpenDesign.

### A caution about per-session dollar figures

`session_v2.cost` is a session's **lifetime total across every provider used in
that session**, not the current provider's spend. The four large sessions that
now run on OpenDesign (Adaptive polish $19.87, PermitPath $9.65, CarSpotter
$8.25, OpenCode smart route $6.61) each contain traffic from several providers —
OpenDesign accounts for only 3–39% of the messages in them. Their combined
$44.38 therefore **cannot** be read as OpenDesign spend. The router's own
per-model accounting (§4) is the correct basis for OpenDesign.

---

## 7. Bottom line

1. **OpenDesign has the most headroom by a wide margin** (~97.5% of a $120 pool)
   and is now carrying 84–96% of traffic because it is also the cheapest at 0.5×.
2. **Go Plus is the real risk.** 11% monthly remaining, 22 days to reset, and it
   carried 68% of the last 72 hours of work.
3. **Command Code is healthy but thinly provisioned on the weekly window** —
   $4.97 left, resetting in under two days. Its provider-reported billing matches
   local estimates within 5%, so its figures are trustworthy.
4. **Only Command Code offers real usage history.** Go Plus and OpenDesign expose
   no historical data through any endpoint available to these keys.
5. **The local 13-month store is the only cross-provider history that exists** —
   but it is this machine's view, not the accounts' full truth.

## 8. To make these numbers authoritative

| Want | Need |
|---|---|
| Verified OpenDesign balance | An OpenDesign **control key** (account-control host). The router will switch from `estimated` to `verified` automatically. |
| OpenDesign daily history | Nothing available today; depends on upstream #8674. |
| Go Plus dollar figures | Nothing available; the endpoint returns percentages only. |
| Command Code daily breakdown | `daily` is empty in the summary payload; would need a second endpoint or a local series. |
