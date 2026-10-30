# Limitations and precise blockers

This file records what is proven, what is estimated, and what the installed OpenCode version cannot support.

## 1. Desktop GUI

Installed OpenCode Desktop is **2.1.4**. Its `app.asar` does not contain the experimental GUI plugin loader or the `./gui-experimental` export. The GUI plugin SDK is present in `@opencode/plugin` 2.2.0 and later.

Therefore the deployed interface is:

- native slash commands registered by the server plugin (`/router-status`, `/router-explain`, `/router-report`, `/router-mode`, `/router-approve`, `/router-auto`, `/router-pin`, `/router-exclude`, `/router-pause`, `/router-resume`, `/router-dry-run`, `/router-premium-budget`, `/router-reserve`, `/router-reset-metrics`);
- a typed RPC surface at `rpc.smart-router.*`, suitable for a future official GUI part.

The router engine does not depend on any panel being open. A side panel was not claimed or faked. On OpenCode 2.2.0 or later, the same RPC surface can back a native settings page or side panel without changing routing core.

## 2. Command Code billing endpoints

Command Code exposes no stable public usage API in its documented Provider API. The plugin reads the same read-only alpha routes the official CLI uses:

```text
/alpha/whoami?limits=1
/alpha/billing/credits
/alpha/billing/subscriptions
/alpha/usage/summary
```

These are **undocumented and unstable**. They can change without notice. The adapter:

- uses only `GET`;
- never discovers or calls mutation endpoints;
- validates numeric and timestamp shapes;
- preserves `orgId` when the account belongs to an organization;
- limits polling to a conservative interval with exponential backoff;
- keeps the last good snapshot marked `stale` on failure;
- falls back to a clearly labeled local ledger estimate;
- never reports missing data as unlimited usage.

The provider API key that OpenCode uses for inference is **not authorized** for these billing routes. The adapter discovers the CLI-compatible key instead. In this installation the working source is:

```text
~/.config/opencode/commandcode.key
```

The key is read only from owner-only files, is never logged or persisted by the plugin, and is sent only to `https://api.commandcode.ai`.

Provider-reported values are account-level: remaining included credits, purchased/free extras, five-hour and weekly used/cap/reset, plan, and billing-period spend. There is no per-model provider breakdown. Per-model usage and remaining model allowance are local estimates from observed step costs.

The billing-period usage summary and the remaining-credit balance are **separate accounting pools** and do not reconcile exactly. The adapter treats the remaining-credit balance as authoritative for monthly usage and allowance protection; the summary is kept only as a diagnostic cross-check. The exact reason for the difference is not documented by the provider.

## 3. OpenCode Go usage endpoint

The Go meter endpoint is a read-only, best-effort integration:

```text
GET https://opencode.ai/zen/go/v1/usage
```

It is queried with OpenCode's existing OAuth access token from the `opencode` connection. It returns percentages and reset times, not dollar balances. It is not part of the public inference schema and may change. On failure, the router uses the local ledger and labels the source `estimate` or `unknown`.

## 4. Prompt rejection is untyped

The V2 prompt admission hook can mutate a prompt but exposes no typed rejection operation. The router blocks admission by throwing `RouterBlockedError` from the prompt hook. On the installed 2.1.4 server this was verified to reject the prompt with HTTP 500 and no provider request; the session title changes to `BLOCKED` and the reason is recorded in the decision.

This is safe but not polished: the HTTP error is generic, so the title and notification are the user-facing explanation. `routing.failClosed` defaults to true. Manual selections and paused routing are outside the strict block.

A routing exception must also block. The earlier catch-and-continue path was a fail-open defect and is being removed.

## 5. Manual CLI selection at session creation

Manual model changes made while the plugin is active are detected through `session.model.selected` and respected. A model passed only at CLI session creation, before the plugin has seen a prompt, is indistinguishable from the session default. The first prompt may therefore be routed normally. Selecting a model in the desktop picker after the session exists is detected.

## 6. Subagents

Child sessions are routed independently. Premium is never propagated from a parent task into a child session; premium mode is capped at balanced for child sessions and one-shot approvals are not inherited. This prevents a premium task from multiplying premium usage through subagent calls. A child can still use a standard model appropriate to its own prompt.

## 7. Billing caps

Client-side quota estimates are not a mathematically guaranteed billing cap. Provider-side enforcement remains authoritative. The router:

- never purchases credits;
- never enables top-ups;
- never changes billing settings;
- blocks automatic routing when provider-reported windows are at the configured reserve;
- treats a reported zero remaining balance as exhausted even if the provider has not set its `exceeded` flag, so it blocks before knowingly entering purchased credits;
- blocks when purchased credits would be consumed unless `allowExtraUsage` is explicitly enabled;
- cannot guarantee that an undocumented provider endpoint or a provider-side fallback will never charge an extra balance.

If Command Code's billing routes fail and the local ledger is incomplete, the router labels the data estimated and fails conservatively rather than assuming capacity.

The purchased-credit guard is unit-tested, including the explicitly-allowed case. It is a client-side policy guarantee, not a provider-side billing lock.

## 8. Cache and context accounting

Prompt caches are provider- and model-specific. A model switch is priced as a cache loss in the router's estimate. The router keeps the current model when the estimated savings are below the hysteresis threshold, and uses a wider threshold above 300K context tokens. It never truncates, summarizes, or deletes conversation history to make a model eligible.

Command Code DeepSeek V4.1 Flash has documented time-of-day pricing: off-peak rates for 17 hours per day and 2x rates from 01:00 to 04:00 and 06:00 to 10:00 UTC, Monday through Friday. The router applies that multiplier to input, output, cache-read, and cache-loss estimates. Models without documented peak metadata use flat catalog rates; their time-of-day pricing is not assumed.

Context-health recommendations are non-destructive: they advise a new session and never compact anything on their own.

Router-driven compaction is governed by `contextManagement.mode`:

- `native` (default) and `conservative` never compact except when the transcript would genuinely exceed the model's verified accepted window. The provider's native handling is preferred; the router steps in only for that case, and announces it.
- `budget-optimized` preserves the legacy behavior: it compacts early to keep a session on the cheapest qualified route. It exists for small plans and small-window models.

In every mode the window used is the one the provider actually accepts, never a theoretical maximum, and the current model's window is used rather than another provider's variant of the same model. Provider-side prompt caching is never disabled by any mode.

## 8a. OpenDesign plan accounting

OpenDesign Pro exposes two independent credit pools: Design Plan credits ($360/month, $90 per rolling seven days, no five-hour window) and plan model credits ($120/month, no usage windows). They are reported side by side and **never summed**. The advertised $480 total is not a single spendable balance, and Design Plan credit multipliers apply only inside the Design Plan pool.

These figures are **estimated**, not provider-confirmed. An OpenDesign inference key cannot read quota: `GET /v1/usage` and `/v1/me` return 404 and the account-control host rejects an inference key. A control key would enable verified reads; none is configured, and the router never acquires one automatically. Because usage from the OpenDesign app is invisible to the router, the estimate is a lower bound.

`minimax-m3.1-flash`'s Design Plan multiplier is unpublished, so a neutral 1x is applied and the uncertainty is reported rather than hidden. The same applies to the GLM cache-read price.

OpenDesign quota cannot be verified without an account control key. Re-probed on
2026-10-30 against the live gateway: `/v1/models` returns 200 with the inference
key, while `/v1/usage`, `/v1/me`, `/v1/credits`, `/v1/billing`, `/v1/account`,
`/v1/subscription`, `/v1/limits` and `/v1/quota` all return 404. The key is valid
and authorized for inference; no usage surface exists for it. Quota therefore
reports `estimated`, derived from this router's own consumption against the
published plan caps with a configurable safety margin.

That estimate is a lower bound, because usage from the OpenDesign desktop app and
any other client on the same subscription is invisible to the router. The state
label is the honest part: `estimated` never becomes `verified` without a control
key, and `test/opendesign-quota-honesty.test.ts` pins that so it cannot drift.

## 8b. Measured speed

Generation speed is recorded as output tokens per second, which separates a slow provider from a model that reasons for longer. It is compared against the fastest eligible route rather than an absolute figure, is neutral below a configurable sample floor, and raises effective cost without ever making a route ineligible. With few samples it does not change decisions. It is machinery that needs production traffic before it can discriminate.

## 9. Precision of scores

The intelligence floor and design thresholds are planning inputs, not guarantees. Intelligence values come from published model cards where available; design scores are curated and explicitly separate. Models without credible scores are not approved for automatic substantive work. The router does not invent benchmark results.

## 10. What was not done

- No separate dashboard or daemon was installed.
- No third-party classification service receives prompts, code, or screenshots.
- No provider billing settings, credentials, or model connections were changed.
- No project configuration outside the router's optional project override was modified.

## 11. Why a session may stop using your default model

Two independent reasons can move a session off DeepSeek V4.1 Flash, and both are
correct behavior rather than faults.

**The transcript outgrew the window.** DeepSeek V4.1 Flash has a 328k window, and
presence in a request requires about 20k of headroom inside 95% of it, so it
stops being eligible at roughly 291,600 tokens of transcript. Past that point the
router names the model it dropped, both token counts, and the fact that a new
session restores it.

**Another model is genuinely cheaper right now.** A session can sit inside a
model's window and still lose on cost, because credit multipliers and peak
pricing differ per model. On OpenDesign, Minimax M3.1 Flash carries a neutral
multiplier while DeepSeek's is 0.5, and DeepSeek doubles during 01:00 to 04:00
and 06:00 to 10:00 UTC on weekdays. At a 309k transcript on a weekday, MiniMax
can therefore be about 1.3x cheaper, and the router picks it on merit. In that
case the context warning is deliberately silent, because nothing was displaced:
the model never would have won.

Observed live on 2026-10-30, and superseded later the same day. A 309,321-token
session selected `opendesign/minimax-m3.1-flash` because three conditions held at
once:

- OpenCode Go was at 90% of a 10% monthly reserve, so it was blocked.
- Command Code was at 86% of a 15% weekly reserve, so it was blocked.
- On OpenDesign, DeepSeek was judged against a 328,000 window and needed 329,321.

The first two were correct. The third was not: the 328,000 window was an advisory
gateway budget that the gateway does not enforce, and DeepSeek would now be
chosen for that session. The quotas remain real; the context rejection was a
consequence of the wrong window, which is documented in the section below.

### OpenDesign's context budget is advisory, and was measured

DeepSeek V4.1 Flash shows a 1,048,000-token window in the router. It used to show
328,000, because the gateway publishes `context_budget: 328000` alongside
`context_limit: 1048000` and the router treated the budget as the ceiling.

That was wrong. The gateway does not enforce `context_budget`. Measured on
2026-10-30 with six single requests on `deepseek-v4.1-flash`, `max_tokens: 1`,
synthetic unique filler, so nothing could be prefix-cached:

| Prompt tokens | Result |
|---|---|
| 355,588 | 200 |
| 753,476 | 200 |
| 999,593 | 200 |
| 1,043,337 | 200 |
| about 1,060,000 | 400 `context_length_exceeded` |
| about 2.4M | 400 `context_length_exceeded` |

The enforced ceiling is the vendor `context_limit` of 1,048,000, confirmed on both
sides of the boundary. Total cost of the probes was $0.006.

One control mattered: the first probe reported 355,328 of 355,588 tokens as
cached, which is implausible for a payload that had never been sent. Repeating it
with random text produced `cached_tokens: 0`, proving the gateway really did
tokenize and accept the full input. Without that, a 200 on mostly-cached input
would have been weak evidence.

The router now uses the vendor limit for a model whose ceiling has been measured,
and keeps the conservative budget for every other model. That is a per-model
allowlist rather than a blanket rule, because guessing a larger window than a
provider accepts fails mid-session with an opaque rejection, which is the failure
mode this project already hit once.

The router still keeps a 20,000-token margin and a 95% safety fraction, so the
usable transcript is about 975,600 tokens rather than exactly 1,048,000. That
margin is not part of the gateway's limit; it is the router refusing to send a
request that has no room left for the reply.
