# OpenDesign Go provider integration

OpenDesign Go is a third subscription provider alongside OpenCode Go Plus and
Command Code GOAT. This document records what the integration does, where its
numbers come from, and what it cannot promise.

It extends the existing Option C router. It is not a second router, and it does
not change the behavior of the two existing providers.

---

## 1. What was implemented

| Area | Change |
|---|---|
| Provider adapter | `src/core/providers/opendesign.ts` : base URL handling, protocol selection, read-only model discovery, error and size normalisation |
| Model catalog | `src/core/providers/opendesign-models.ts` : the 39 models the gateway serves, with credit multipliers and curated quality scores |
| Credit semantics | `src/core/providers/opendesign-credits.ts` : published multipliers, promotion handling, credit conversion |
| Quota integration | `src/core/quota/opendesign.ts` : verified / estimated / unknown / exhausted states |
| Credential discovery | `src/core/quota/credentials.ts` : inference key and explicitly supplied control key, kept separate |
| Routing | `src/core/routing/engine.ts` : credit multiplier in the cost ranking, cooldown exclusion, reliability weighting |
| Policy | `src/core/policy/eligibility.ts` : subscription-only guard and unknown-quota policy |
| Quota coordinator | `src/core/quota/service.ts` : OpenDesign probes run through the same single-flight service as the other two providers |
| Model registry | `src/core/models/seed.ts`, `src/core/models/registry.ts`: OpenDesign seeds, gateway metadata merged over them |
| Shared core | `src/server/shared-core.ts` : one single-flight discovery per process, merged into the one model catalog |
| Commands | `/router-opendesign` added; `/router-status`, `/router-report`, `/router-explain` updated |

The provider is **optional and disabled by default**. A user with no OpenDesign
credentials sees no behavior change at all.

---

## 2. Source revisions examined

Recorded 2026-10-28.

| Source | Revision | Used for |
|---|---|---|
| `nexu-io/open-design` | `c6bb5a8b8190` | Billing preflight, model probing, error taxonomy |
| `nexu-io/open-design` PR #8339 | merge `eb27acd32250`, merged 2026-09-24 | Advisory preflight vs gateway funding vs wallet display |
| `nexu-io/open-design` #8674 | open | No API-key-readable quota endpoint |
| `nexu-io/open-design` #8870 | open | Control-key lifecycle and revocation gaps |
| `nexu-io/open-design` #8687 | open | Anthropic-messages drops reasoning for DeepSeek V4.1 Flash |
| `KouzakiUmi/dsh-opendesign-corouter` | `afb390a6bd66` | Gateway shape, protocol endpoints, empty-turn behavior |
| `KouzakiUmi/dsh-subusage` | `d6d997ddce7a` | Control-plane paths, window classification, credential handling |
| `open-design.ai/help/cloud-api/`, `/help/billing/`, `/model-credits/` | retrieved 2026-10-28 | Plan shape, credit multipliers, window rules |

---

## 3. What the gateway actually reports

`GET {base}/v1/models` with the inference key returns the account's entitled
models with authoritative metadata. Captured 2026-10-28.

| Model | Usable input | Output | Image input | Credits |
|---|---|---|---|---|
| DeepSeek V4.1 Flash | 328,000 | 128,000 | yes | 0.5× |
| Claude Haiku 5.5 | 228,000 | 128,000 | yes | 2× |
| GLM-5.3 Flash | 232,000 | 32,000 | yes | 1× |
| GLM-5.3 Flash-X | 232,000 | 32,000 | yes | 2× |
| GPT-6 Luna | 400,000 | 128,000 | yes | 4× |
| MiMo V2.6 Flash | 232,000 | 32,000 | yes | 1× |
| MiMo V2.6 Pro | 232,000 | 32,000 | yes | 1× |
| MiniMax M3.1 Flash | unknown | unknown | yes | not published |
| DeepSeek V4 Flash | 232,000 | 32,000 | no | 1× |
| DeepSeek V4 Flash Vision Exp | 232,000 | 32,000 | yes | 1× |
| DeepSeek V4 Pro | 328,000 | 128,000 | no | 1× |
| Hunyuan H4 Preview | 232,000 | 32,000 | no | 1× |
| Kimi K2.7 Code | 262,000 | 32,000 | yes | 1× |

Three findings that change how the router treats OpenDesign:

1. **`context_budget`, not `context_limit`, is the usable window.** The vendor
   limit is up to 1.05M tokens, but the gateway's usable input budget is
   228k to 400k. Routing against the vendor limit would send requests the gateway
   rejects. The router uses `context_budget`.
2. **Image support is verified from the gateway**, not inferred from a model
   card. `hy4-preview`, `deepseek-v4-flash` and `deepseek-v4-pro` are text only
   on this gateway.
3. **MiniMax M3.1 Flash reports no context or output budget.** The router uses
   a conservative 232k window and flags the multiplier as unverified.

A fourth finding, observed live on 2026-10-28: the gateway resolves a **billing
scope** before answering, even a read-only `/v1/models` request. During this
work it returned `503 workspace_billing_scope_unavailable` with an upstream
`context deadline exceeded` against `amr-api.open-design.ai/api/internal/billing/scope/…`,
then succeeded on retry. Two consequences:

- Every OpenDesign request, including model discovery, depends on a billing
  service that can time out. Transient 503s are expected and must be retried
  with backoff, which the router's quota backoff and failure classification
  already handle.
- This is a plausible upstream contributor to dropped streams: the billing
  scope resolution sits in front of the response stream.

Models without a curated quality score are seeded unapproved. Approve them
explicitly in `models.approved` if you want them routed.

---

## 4. How quota is obtained

OpenDesign publishes no quota API for an inference key. Verified empirically on
2026-10-28:

| Path | Result |
|---|---|
| `GET amr-link.open-design.ai/v1/usage` | 404 |
| `GET amr-link.open-design.ai/v1/me` | 404 |
| `GET amr-api.open-design.ai/api/v1/workspaces/current` with the inference key | 401 `unauthenticated` |
| `GET amr-api.open-design.ai/api/v1/billing/summary` with the inference key | 401 `unauthenticated` |
| `GET amr-api.open-design.ai/api/v1/wallet/balance` with the inference key | 401 `unauthenticated` |

Issues #8674 and #8870, which ask for exactly this, are both still open.

The integration therefore has three states:

- **`verified`**: a control key was supplied explicitly. The router reads
  `workspaces/current`, `workspaces/{id}/billing/coding-plan-usage` and
  `billing/summary`, and reports provider numbers. This is the only state in
  which the wallet balance is reported.
- **`estimated`**: only the inference key is available. The router models its
  own credit consumption against the published plan caps, applies a
  configurable safety margin (default 20%), and reports it as a lower bound.
- **`unavailable`**: nothing could be established. OpenDesign is then not
  routed to.

`stale` marks verified or estimated data older than twice the probe interval.
`exhausted` marks a confirmed or modelled window that has been used up.

The router never obtains a control key, never asks for a browser session, and
never scrapes cookies. A control key is used only when you point
`providers.opendesign.controlKeyPath` at a file you created yourself.

---

## 5. Billing accuracy and limits

The Go plan shape is:

- $10 per month
- Design Plan monthly maximum **$120**
- 7-day window maximum **$30**
- 5-hour window maximum **$10**
- Plan-model credits **$0**

The 5-hour and 7-day values are nested limits inside the monthly maximum. They
are never added together.

What is exact, estimated, and unknown:

- **Exact.** Window limits and reset times when a control key is configured;
  the plan tier; which models the gateway serves; each model's usable context,
  output budget and image support.
- **Estimated.** Credit consumption. The router converts token counts into a
  dollar value of model usage using the curated vendor list price, then applies
  the published Design Plan multiplier. OpenDesign does not publish per-token
  prices for plan models, so the underlying price is a proxy, not a quote.
- **Unknown.** Usage from outside OpenCode. The OpenDesign desktop app and any
  other client share the same allowance, and the router cannot see them. The
  estimated state is therefore a lower bound, which is why a margin is applied.
- **Unknown.** The multiplier for MiniMax M3.1 Flash. It is not published, so
  the neutral 1× rate is used and flagged.

The DeepSeek V4.1 Flash off-peak promotion of 2026-10-20 to 2026-10-27 is
recorded but never applied: it has expired, and OpenDesign states that
app-only offers do not automatically apply through APIs.

---

## 6. Spending policy

Default configuration:

- `subscriptionOnly: true`
- `allowExtraUsage: false`

With those set, the router will not send a request to OpenDesign when the
subscription allowance is exhausted, even though the gateway could fund the
request from purchased balance. It also refuses a request whose projected cost
does not fit inside what is left of the applicable window.

**This is a client-side guard, and it is not a guarantee.** OpenDesign's
gateway chooses the funding source per request. The upstream client removed
client-side wallet-zero blocking for exactly this reason, recording that the
gateway decides. The router cannot prevent a server-side charge; it can only
avoid sending a request it can already see does not fit.

You must confirm in the OpenDesign account console that automatic recharge is
disabled. The router cannot check that on your behalf.

---

## 7. Credential setup

The inference key is the only credential the provider needs.

```bash
# 1. Create a key in the OpenDesign Cloud console, API keys page.
# 2. Store it with owner-only permissions.
umask 077
printf '%s' 'sk-amr-your-key' > ~/.config/opencode/opendesign.key
chmod 600 ~/.config/opencode/opendesign.key
```

The router discovers it from, in order: `$OPENDESIGN_API_KEY`, an explicit
`providers.opendesign.credentialPath`, `~/.config/opencode/opendesign.key`,
`opendesign.env`, `opendesign.json`, and finally the OpenCode provider
settings. Credential files must not be group- or world-readable.

Then point OpenCode at the gateway in `opencode.json`:

```json
{
  "providers": {
    "opendesign": {
      "name": "OpenDesign Go",
      "package": "@opencode/ai/providers/openai-compatible",
      "options": {
        "baseURL": "https://amr-link.open-design.ai/v1",
        "apiKey": "{env:OPENDESIGN_API_KEY}"
      }
    }
  }
}
```

And enable it for the router in `~/.config/opencode/smart-router.json`:

```json
{
  "providers": {
    "opendesign": {
      "enabled": true,
      "subscriptionOnly": true,
      "allowExtraUsage": false,
      "monthlyCreditsUsd": 120,
      "fiveHourCapUsd": 10,
      "weeklyCapUsd": 30
    }
  }
}
```

The gateway base URL already contains `/v1`. The router never appends it twice.

**Protocol.** Use chat-completions, which is what the OpenAI-compatible
package speaks. Do not configure the Anthropic-messages protocol for DeepSeek
V4.1 Flash: upstream issue #8687 reports that it drops reasoning and stalls
agents that rely on tool calls. The router warns when it sees this combination.

Verify with `/router-opendesign`, which lists the entitled models the gateway
actually returned and makes no inference request.

A control key is optional and only changes quota reporting from estimated to
verified. Supply it only if you accept that it is a privileged credential:

```json
{ "providers": { "opendesign": { "controlKeyPath": "~/.config/opencode/opendesign-control.key" } } }
```

---

## 8. Reliability handling (also fixes MiniMax stream drops)

The router previously recorded `provider_outage` counts but never attributed
them to a model, and a stream that died after the response started was
classified `unknown`, which does not count against a model. A model that
repeatedly dropped streams therefore kept its perfect reliability record and
kept being selected.

Three changes fix this:

1. **Classification.** Mid-stream faults are recognized even when the HTTP
   status is 200. This covers OpenCode's `provider.internal`
   ("Streaming response failed: [500] EngineCore encountered an issue") and
   `provider.invalid-output` ("OpenAI Chat stream ended without
   finish_reason") signatures. User interrupts are classified `interrupted`
   and never count against a model.
2. **Attribution.** `session.execution.failed` and `session.idle` outcomes are
   recorded against the model the host is actually serving, falling back to
   the host's session record when the router has none.
3. **Cooldown and demotion.** A provider fault puts the model into a cooldown
   that lengthens with each repeat, and reliability now weights the success
   estimate more strongly. A model that keeps dropping streams is avoided even
   after the cooldown expires.

Verified against a simulated mid-stream fault: the fault is classified
`provider_outage`, attributed to the model, and the session moves elsewhere on
the next prompt.

---

## 9. Lifecycle guarantees

OpenDesign adds no second core, no extra polling loop, and no duplicate
registration:

- One shared core per server process, one event stream, one quota coordinator.
- Model discovery is single-flight with a five-minute TTL and runs only when
  the provider is enabled.
- Quota probes go through the same per-provider backoff, single-flight and
  retry-after handling as the other two providers.
- The estimated quota path makes **no network request at all**.
- A failed discovery keeps the last good catalog instead of dropping every
  OpenDesign route.
- An unknown OpenDesign state never disables an unrelated provider.
- Teardown and revival follow the existing shared-core lifecycle.

Verified with three concurrent project bridges: one core, one event stream,
correct bridge counts, zero duplicate registrations.

---

## 10. Test and canary evidence

`npx vitest run` reports **330 tests passing**. `tsc --noEmit` is clean.

Three pre-existing test failures were fixed on the way. The suite read the
developer's real `~/.config/opencode/smart-router.json` and merged it over the
settings each test intended to use, so the result depended on the machine the
tests ran on. The suite is now hermetic.

The isolated three-provider canary ran against a local mock that mirrors the
live gateway's response shape byte for byte, with a disposable HOME, config,
data and cache:

- Three providers registered and approved.
- A session routed to OpenDesign, one to GOAT, one to Go Plus.
- Credit multiplier 0.5× visible in the decision record.
- Cache affinity: a large-context session stayed on its provider.
- A simulated mid-stream fault was classified, attributed, and the session
  moved off the model.
- A verified exhausted five-hour window with a $50 wallet present moved the
  session off OpenDesign.
- Informational commands made zero inference requests.
- One core, one event stream, correct bridge counts.

Evidence and the 30-minute soak result are recorded in
`docs/evidence/opendesign-2026-10-28/`.

---

## 11. Rollback

The provider is inert unless `providers.opendesign.enabled` is true. To remove
it entirely:

```bash
jq '.providers.opendesign = {"enabled": false}' \
  ~/.config/opencode/smart-router.json > /tmp/sr.json && \
  mv /tmp/sr.json ~/.config/opencode/smart-router.json
```

Then remove the `opendesign` block from `providers` in `opencode.json` and
reload. The plugin directory can be restored from the pre-deployment backup, or
reverted to the previous release artifact:

```bash
shasum -a 256 dist-release/index.js
# 8c71c46c5f7616f950c6a3fcf5c42be2198407848cf9ffac15d01504496f8920
```

Emergency rollback scripts from the previous release remain valid.

---

## 12. What still needs your decision

- Whether to enable the provider, and whether to supply a control key.
- Whether to approve the unapproved OpenDesign models
  (`deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`,
  `glm-5.3-flashx`, `hy4-preview`, `kimi-k2.7-code`).
- Confirming automatic recharge is disabled in the OpenDesign console.
- Authorising any real-provider test. None was run.
