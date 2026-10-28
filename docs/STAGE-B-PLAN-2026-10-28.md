# Stage B plan — limited real-provider verification

> **Completed 2026-10-28.** Limited verification passed; accounting discrepancy found. See [STAGE-B-REPORT-2026-10-28.md](STAGE-B-REPORT-2026-10-28.md). No broader deployment.

**Status:** awaiting isolated authentication; no real provider request has been made.
**Artifact:** `dist-release/index.js`
**SHA-256:** `e65326c9bc7b36a4470bab2d631253d233e918fc76b4b93d5cf1bab8020a5fa4`
**Code commit:** `6099a3d`

## Credential gate

You chose to authenticate the isolated environment yourself. Nothing will be sent to a real provider until you confirm:

1. `opencode auth login --standalone` was completed with the isolated HOME/XDG variables for **OpenCode Console / Go Plus**. `--standalone` avoids attaching to the live background service on port 49374.
2. The Command Code key is available only inside the isolated root, either as `home/.config/opencode/commandcode.key` or as the isolated provider's `settings.apiKey`.

I will not read, copy, export, or print the credentials. Exact commands: `~/Documents/opencode-router-stage-b/AUTH-INSTRUCTIONS.md`.

## Preflight — read-only only

1. Verify artifact hash `e65326c9…`.
2. Start the isolated server on `127.0.0.1:4220` with the isolated HOME/data/cache.
3. Confirm plugin active, **16 commands**, one core, one bridge, one event stream before any prompt.
4. Read provider quota only:
   - Go Plus rolling / weekly / monthly percentages and reset times.
   - Command Code five-hour / weekly / monthly usage, included credits, purchased credits, free credits.
5. Record before values.
6. Verify policy:
   - `allowExtraUsage:false` for both providers.
   - `premium.mode:"ask"`, budget 0, one-shot approval false.
   - `routing.failClosed:true`.
   - Purchased credits must not be reachable by automatic routing. If Command Code reports purchased credits and the policy cannot guarantee they will not be charged, **stop before any Command Code request**.
7. Use `preview` (no model call) for a design-heavy task to confirm a premium model is not selected without approval.

## Request budget

Maximum **2 small requests per provider**, only after preflight passes.

| # | Provider | Type | Prompt | Bound |
|---|---|---|---|---|
| 1 | Go Plus | text | `Reply exactly: STAGE-B-GO-OK. Do not use tools.` | minimal |
| 2 | Go Plus | vision | 32×32 red-square PNG; `What color is the square? Reply one word. Do not use tools.` | one image |
| 3 | Command Code | text | `Reply exactly: STAGE-B-CC-OK. Do not use tools.` | minimal |

If Go vision cannot select a native-vision model, skip it and report; do not add a fallback request. No request may be retried automatically; a provider failure is recorded and the stage stops if budget would be exceeded.

To make provider selection deterministic:
- Seed/refresh both quota snapshots with both providers enabled.
- For Go requests, disable Command Code in the isolated settings and reload the location.
- For Command Code requests, disable Go Plus and enable Command Code.
- Never change the live desktop config.

## Verification per request

- Session model must equal `lastDecision.chosen` (provider + model).
- Session outcome must be `succeeded`; record response tokens/cost.
- Title must show the actual provider/model.
- Record provider-reported quota before and after; calculate actual window consumption.
- Confirm no premium model was selected and no one-shot approval was granted.
- Confirm no purchased credits were consumed; if that cannot be established, stop and report.

## Safety initialization

After each server start/restart, before the first prompt:
- `/api/plugin` active.
- 16 router commands present.
- Diagnostics: one core, one bridge, one event stream, zero errors.
- No duplicate command registration.

## Simulated fallback

Do not exhaust real quotas. Quota-exhaustion, outage, and fail-closed behavior remain covered by the local mock Stage A matrix and unit tests; no real-quota exhaustion will be attempted.

## Evidence

- Before/after quota JSON with timestamps.
- Session model/outcome/title and decision for each request.
- Provider request counts (exactly the bounded set).
- Artifact verify, server logs, no-thrash/no-error checks.
- A manifest generated **without self-reference** and verified with `shasum -a 256 -c`.

Stop after Stage B. No global install or live desktop change.
