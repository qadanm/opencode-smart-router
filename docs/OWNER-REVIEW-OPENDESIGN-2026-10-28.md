# Owner review — OpenDesign Go provider integration

Consolidated review of the third-provider integration. One document; technical
evidence lives separately in `docs/OPENDESIGN-INTEGRATION.md` and
`docs/evidence/opendesign-2026-10-28/`.

---

## What is implemented

OpenDesign Go is now a third provider in the existing Option C router, alongside
OpenCode Go Plus and Command Code GOAT. It is **optional and disabled by
default**. With no OpenDesign credentials configured, nothing changes.

Implemented and working:

- Provider adapter with base URL normalisation, protocol selection, read-only
  model discovery, and error and request-size handling.
- Model catalog for the 13 models the gateway serves, with credit multipliers.
- Quota integration with verified, estimated, stale, unknown, exhausted and
  unavailable states.
- Routing integration with the credit multiplier, subscription-only guard,
  cache affinity and premium controls preserved.
- `/router-opendesign` diagnostics command, plus status, report and explain
  updates.
- Credential discovery for the inference key, with a control key used only if
  you supply one explicitly.

Independently of OpenDesign, the integration fixes a real reliability gap: a
model that repeatedly dropped streams was never blamed for it and kept being
selected. That was the cause of the MiniMax M3.1 Flash drops you hit.

---

## Which models are actually supported

The gateway's own `GET /v1/models` response was read with your key on
2026-10-28. It returns 13 models, and this list is confirmed at runtime.

Approved for automatic routing:

| Model | Usable input | Image | Credits |
|---|---|---|---|
| DeepSeek V4.1 Flash | 328,000 | yes | 0.5× |
| Claude Haiku 5.5 | 228,000 | yes | 2× |
| GLM-5.3 Flash | 232,000 | yes | 1× |
| MiniMax M3.1 Flash | 232,000 (assumed) | yes | 1× (unverified) |
| MiMo V2.6 Pro | 232,000 | yes | 1× |
| MiMo V2.6 Flash | 232,000 | yes | 1× |
| GPT-6 Luna | 400,000 | yes | 4× |

Seeded but not approved, because the router has no quality score for them:

DeepSeek V4 Pro, DeepSeek V4 Flash, DeepSeek V4 Flash Vision Exp,
GLM-5.3 Flash-X, Hunyuan H4 Preview, Kimi K2.7 Code.

MiniMax M3.1 Flash is the one model with no published multiplier. The router
uses the neutral 1× rate and flags it as an estimate rather than pretending it
is exact.

Three gateway findings worth knowing:

- The usable input window is 228k–400k tokens, **not** the 1M+ vendor limit the
  marketing pages quote. The router uses the gateway's `context_budget`.
- Three models are text only on this gateway, which was verified from the
  gateway rather than assumed from a model card.
- A 600,000-token session will not fit on most OpenDesign models. The router
  keeps those sessions on Go Plus or GOAT, which is what you want.

---

## How the provider is authenticated

With your OpenDesign inference key (`sk-amr-…`) as a bearer credential, stored
at `~/.config/opencode/opendesign.key` with owner-only permissions.

The router discovers it from `$OPENDESIGN_API_KEY`, an explicit
`credentialPath`, the `opendesign.key` / `.env` / `.json` files in
`~/.config/opencode/`, or the OpenCode provider settings — in that order. A
credential file with group or world permissions is refused.

The key was validated against the live gateway during this work. That
validation was a read-only `GET /v1/models`, which performs no inference and
consumes no credits.

A separate account-control key can be supplied for verified quota. The router
never obtains one, never requests device authorisation, and never reads a
browser session. It is used only if you point `controlKeyPath` at a file you
created.

---

## How quota information is obtained

OpenDesign has **no quota API for an inference key**. This was verified
directly: `/v1/usage` and `/v1/me` on the inference gateway return 404, and the
account-control host rejects the inference key with 401. The upstream requests
for one, issues #8674 and #8870, are both still open.

The router therefore has three modes:

1. **Verified** — only when you supply a control key. Reads the workspace, the
   coding-plan usage windows and the billing summary. Reports provider numbers
   and the wallet balance. This is the only mode that reports a wallet balance.
2. **Estimated** — with only the inference key. Models the router's own credit
   consumption against the published Go caps ($10 per 5 hours, $30 per 7 days,
   $120 per month), applies a 20% safety margin, and reports it as a **lower
   bound**.
3. **Unavailable** — nothing could be established. OpenDesign is not routed to.

The estimated mode makes **zero network requests**. It is a local model of your
own usage.

The central limitation: the OpenDesign desktop app and any other client share
your allowance, and the router cannot see them. An estimate can only understate
real usage. It is never presented as a balance.

---

## Whether billing can be restricted to subscription credits

**Not from the client, and you should not rely on it.**

There is no documented request field, header or plan setting that disables
wallet fallback. The upstream client explicitly removed client-side
wallet-zero blocking, on the grounds that the gateway decides the funding
source per request. My research found no way to restrict it.

What the router does instead is the strongest safe client-side guard available:

- With `subscriptionOnly: true` and `allowExtraUsage: false`, OpenDesign is
  excluded as soon as the subscription allowance is exhausted, even though the
  gateway could fund the request from your wallet.
- A request is also refused if its projected cost does not fit inside what is
  left of the applicable window.
- A wallet balance is reported separately and never treated as permission to
  spend it. Verified: a simulated exhausted five-hour window with a $50 wallet
  present moved the session off OpenDesign.

But this only prevents the router from *sending* a request it can see does not
fit. It cannot prevent a server-side charge.

**You must confirm in the OpenDesign account console that automatic recharge is
disabled.** The router cannot check that for you.

---

## What was tested versus assumed

Tested against the real gateway (read-only, no credits spent):

- The key authenticates.
- The entitled model list, including each model's usable context, output budget
  and image support.
- That no quota endpoint accepts the inference key.

Tested in an isolated lab with mocks, no real inference:

- Three providers registered and approved.
- Sessions routed to each of the three providers.
- The 0.5× credit multiplier visible in decision records.
- Cache affinity: a large-context session stayed on its provider.
- A simulated mid-stream fault was classified `provider_outage`, attributed to
  the model, and the session moved off it on the next prompt.
- A verified exhausted window with a wallet balance moved the session off
  OpenDesign.
- Informational commands made zero inference requests.
- One shared core, one event stream, correct bridge counts across three
  concurrent projects.
- 183 automated tests passing; typecheck clean.
- A 30-minute multi-project soak on the exact final artifact.

Assumed, and flagged as such:

- **Token prices.** OpenDesign publishes a credit multiplier, not per-token
  prices. The router uses the vendor list prices already curated for the same
  underlying models on your other providers, then applies the multiplier. That
  is a proxy for the "dollar value of model usage", not a quote from
  OpenDesign.
- **MiniMax M3.1 Flash multiplier** — not published; neutral 1× used.
- **Quality scores.** Reused from the same underlying models on your other
  providers. Six OpenDesign models have no score and are seeded unapproved.
- **MiniMax context window** — the gateway reports no budget; a conservative
  232k is used.
- **Verified quota** was exercised against a mock control plane only, because
  no real control key was supplied.

---

## How much additional capacity to expect

Go adds a **$120 monthly** Design Plan allowance, with **$30 per 7 days** and
**$10 per 5 hours** as nested limits.

The practical constraint is the 5-hour window. $10 of Design Plan credits per
5 hours, at 0.5× for DeepSeek V4.1 Flash, is roughly $20 of underlying model
usage per 5 hours — but only if you spend it all on DeepSeek. On Claude Haiku
at 2× it is $5 of usage; on GPT-6 Luna at 4× it is $2.50.

So:

- **Best case**, staying on DeepSeek V4.1 Flash and GLM-5.3 Flash: roughly a
  doubling of the DeepSeek capacity you get from Go Plus, because the 0.5×
  multiplier halves the credit cost.
- **Worst case**, heavy design work on Haiku: the 5-hour window will be the
  binding limit and the router will move you back to Go Plus or GOAT.

The monthly $120 is unlikely to bind before the windows do.

The router already handles this correctly: it ranks by expected credit cost,
keeps large-context sessions on whichever provider holds their cache, and moves
off OpenDesign when a window runs out.

---

## Remaining risks

- **Wallet spend cannot be guaranteed against.** The gateway decides funding.
  Client-side guarding is best-effort. Confirm auto-recharge is off.
- **Token prices are a proxy.** Credit estimates could be off in either
  direction. Provider-reported usage is only available in verified mode.
- **The estimated quota is a lower bound** and cannot account for usage from
  the OpenDesign app or other clients.
- **No real-provider canary was run.** Every test used mocks. The first real
  request is where the gateway's actual behaviour, latency and error shapes
  get confirmed.
- **The verified quota path depends on undocumented endpoints.** They may
  change without notice. If they break, the router degrades to estimated.
- **The control key is a privileged credential** with reported revocation
  limitations upstream. Do not supply one unless you want verified quota badly
  enough to accept that.
- **The Anthropic-messages protocol is lossy for DeepSeek V4.1 Flash.** Use
  chat-completions. The router warns when it sees the combination.
- **The gateway resolves a billing scope in front of every request**, including
  read-only model discovery. It returned a transient `503
  workspace_billing_scope_unavailable` during this work and succeeded on
  retry. This is a plausible contributor to dropped streams, and it means
  OpenDesign availability depends on more than the model service.

---

## What requires your approval

1. **Deploying** this build to your live OpenCode installation. Nothing live has
   been touched. The artifact is built, tested and soaked, but not installed.
2. **Enabling** the provider in `smart-router.json`.
3. **Supplying a control key**, if you want verified quota.
4. **Approving** the six unscored OpenDesign models, if you want them routed.
5. **Any real-provider test.** None was run, and none will be without your
   explicit go-ahead.

---

## A correction I owe you

Earlier I told you the router's price table had GLM's cache-read price about
5× too high, and said I should correct it. **I checked properly and that claim
was premature. I have not changed the price table.**

What I actually found:

| | |
|---|---|
| The router's seed for GLM-5.3 Flash cache-read | $0.03 / Mtok |
| The models.dev catalog, which OpenCode uses | **$0.03 / Mtok** — identical |
| What OpenCode's own cost figure for your GLM session implies | ~$0.0058 / Mtok |

Your GLM session reported **$6.05** for 715M cache-read tokens. The catalog
prices predict **$23.37** for the same tokens — OpenCode's figure is 3.86×
lower. For contrast, your DeepSeek sessions report 1.22× the catalog figure,
which is expected because peak pricing is 2×.

So the router matches the authoritative catalog, and the discrepancy is
between OpenCode's own session cost and that catalog. I cannot tell which is
correct, because the provider-reported dollar figure I would need to settle it
is currently `null` in the router's OpenCode Go quota snapshot.

Changing the price would alter routing decisions on ambiguous evidence, so I
have left it alone and recorded the discrepancy instead. If you want it
settled, the clean test is one isolated request on GLM-5.3 Flash with the
account's usage delta measured before and after — which needs your approval
because it is a real, paid request.

---

## The billing-scope errors you saw (investigated 2026-10-28, ~10:05–10:18)

You reported a temporary error on an auto-switch to OpenDesign that had to
retry twice, and a billing error. This is what it was.

**The error came from OpenDesign, not from the router:**

```
[code=workspace_billing_scope_unavailable] resolve Billing Scope:
Get "https://amr-api.open-design.ai/api/internal/billing/scope/<id>":
context deadline exceeded (Client.Timeout exceeded while awaiting headers)
```

OpenDesign's gateway resolves which billing workspace your key belongs to
*before* it serves any request, and that internal call was timing out. It is
a transient fault on their side, and it hit whichever model happened to be
serving — so it appeared on DeepSeek V4.1 Flash in one session and on MiniMax
M3.1 Flash in another.

The router's behaviour was correct: classify it as a provider outage, retry,
cap the retries at 3 attempts, and carry on. It recovered every time.

**Two genuine router bugs did make it look worse than it was.**

1. **One fault was counted three times.** The host reports a single failed
   attempt through four channels — the `retry` hook, `session.step.failed`,
   `session.execution.failed`, and `session.idle`. Each recorded its own
   strike independently. The live ledger shows the signature plainly: three
   identical `provider_outage` entries in the same second.

   The effect was that `opendesign/deepseek-v4.1-flash` accumulated **15
   faults** and, through the strike multiplier, picked up a **20-minute
   cooldown** — for a fault that was never the model's fault.

2. **The provider's outage was charged to a model.** A billing-scope failure
   happens before a model is even selected, so it would hit every OpenDesign
   model equally. It was still counted against whichever model was serving,
   so a healthy model was penalised for the provider's problem.

There was also a third, quieter defect: the `retry` hook dropped `cooldownMs`,
so the hold-out it recorded never actually engaged. The counter rose while
the protection did not.

**The fix** (`365f07a`, on `feature/opendesign-provider`, not deployed):

- Failures are now keyed on the identity of the attempt, which the host
  provides as `assistantMessageID`. One attempt counts once however many
  channels describe it; a genuinely separate later failure still counts
  separately.
- Billing-scope failures are classified as provider-scoped, so they no longer
  count against a model or arm a model cooldown.
- The retry hook now carries `cooldownMs` through, so a model that really is
  failing does get held back.

**Evidence that the fix works** — the live incident replays as one fault with
no model penalty, and a genuine model-specific stream fault still counts and
still arms a cooldown:

```
live replay: provider_outage=1 modelFaults=0
live replay: model cooldown set = false
```

Tests: 191 passing (185 before, 6 new), typecheck clean.

**Still not deployed.** This needs your approval, exactly like the OpenDesign
deployment did.

---

## Provider outage backoff (added after you saw the errors continue)

You reported the billing-scope error happening again after the first fix.
Inspecting the live ledger showed the fix had worked for the errors it knew
about — nine billing-scope faults, zero charged to a model — and that
OpenDesign's gateway had produced a *second* pre-request failure:

```
[code=internal_error] failed to evaluate membership entitlement
```

Pre-request checks failing is now the recurring pattern: billing scope, then
plan entitlement, roughly every few minutes for about an hour. Each failure is
a fault of the gateway's account path, not of the model serving the request.

Your instruction: it works fine when it retries or when you say continue, and
Go Plus and GOAT are exhausted — so only back off when OpenDesign is *truly*
down, not for transient blips.

**What was wired in:**

- A provider-scoped fault now counts toward a per-provider **run of
  consecutive failures with nothing succeeding in between** — not against any
  model.
- **Any successful request proves the gateway is serving again** and resets
  the run to zero. Blips that ride over on a retry never arm anything.
- At **five** consecutive failures the whole provider is held back for
  **three minutes**, so routing picks another provider instead of hammering a
  dead gateway.
- If no other provider has allowance, the routing engine finds no eligible
  route and **fails closed keeping the current model** — the backoff can
  never block a prompt outright. That is the property that mattered given
  your Go and GOAT exhaustion.

The membership-entitlement failure is classified provider-scoped alongside
the billing-scope failure, so no pre-request gateway fault charges a model
any more.

Tests: 199 passing (192 before, 7 new), typecheck clean. Deployed at
`67f3e9a7` (`4386c45`); the previous artifact `aba0a077` is backed up.

**Separate environmental finding:** Command Code's billing probe now returns
HTTP 401, so GOAT quota is reported as unknown instead of provider-verified.
It was provider-sourced at every earlier check — including 10:44, with no
deployments between that and this restart — so it flipped while the previous
artifact was running. There is no Command Code entry in the credential store,
so the probe has nothing authorized to present. Unrelated to these router
changes; flagged here because it affects the visibility you rely on for GOAT.

---

| | |
|---|---|
| Branch | `feature/opendesign-provider` |
| Code commit | `4386c45` |
| Baseline | `e8fa5ac` (preserved) |
| Tests | 199 passing (185 before, 14 new) |
| Typecheck | clean |
| Live deployment | running `67f3e9a7` — billing-scope classification + provider outage backoff |

Exact artifact SHA-256:

```
33401a1f5af2ca85f210fd5d8c0b30088bd9ddf5abfa76df05b450e130047246
```

Rollback instructions are in `docs/OPENDESIGN-INTEGRATION.md` §11.
