# [Bug] Gateway intermittently fails pre-request billing-scope resolution with 503 workspace_billing_scope_unavailable

## What happened

Requests to the OpenDesign coding gateway (`https://amr-link.open-design.ai/v1`) intermittently fail before any model is selected:

```
[code=workspace_billing_scope_unavailable] resolve Billing Scope: Get "https://amr-api.open-design.ai/api/internal/billing/scope/ax396gf0dt9047rp8w26if5r": context deadline exceeded (Client.Timeout exceeded while awaiting headers)
```

A second pre-request failure also appears during the same period:

```
[code=internal_error] failed to evaluate membership entitlement
```

## Frequency and duration

Observed continuously for ~2.5 hours on 2026-10-28 (UTC), roughly 8–9 failures every 30 minutes:

```
10:00–10:30   ######## 8
10:30–11:00   ######### 9
11:00–11:30   ######### 9
11:30–12:00   ###### 6
```

That is ~5.5% of requests. Every failure recovered on a retry within the same turn, and **no credits were consumed** by a failed request (it is rejected before model selection).

## Evidence the gateway is degraded rather than down

Six consecutive `POST /v1/chat/completions` requests with `"max_tokens": 1` all succeeded, each in **~7 seconds**:

```
probe 1: 200 in 7.48s
probe 2: 200 in 7.14s
probe 3: 200 in 6.97s
probe 4: 200 in 7.68s
probe 5: 200 in 6.94s
probe 6: 200 in 6.92s
```

One token of generation should be milliseconds; the remainder is gateway overhead. The pre-request billing-scope resolution appears to have a client timeout that the current latency occasionally exceeds, which would produce exactly this failure pattern: a steady trickle of timeouts while most requests still succeed.

## Request

Either:

1. Fix the latency of the internal billing-scope resolution (`amr-api.open-design.ai/api/internal/billing/scope/<workspace>`), or
2. Make the resolved scope cacheable per inference key so it is not re-resolved on every request — the scope id is stable for an account, and re-resolving it per request turns a slow dependency into a per-request failure mode, or
3. Return a `Retry-After` header (or a distinguishable 429) instead of a bare 503, so clients can back off cleanly instead of retrying immediately into the same timeout.

## Environment

- Client: OpenCode 2.2.0 desktop, custom OpenAI-compatible provider pointed at `https://amr-link.open-design.ai/v1`
- Auth: OpenDesign inference key (Design Plan)
- Model: deepseek-v4.1-flash, glm-5.3-flash (chat-completions protocol)
- Time: 2026-10-28, ~10:00–12:00 UTC
