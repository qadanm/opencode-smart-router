# OpenCode Smart Router

> **Status 2026-10-28: automatic routing active by explicit user approval.**
> The verified artifact is installed in the live desktop. Premium escalation and
> purchased-credit use remain disabled. See
> [docs/DESKTOP-PROMOTION-2026-10-28.md](docs/DESKTOP-PROMOTION-2026-10-28.md) for the
> promotion, rollback, and monitoring record. The earlier dry-run verification is in
> [docs/DESKTOP-DRY-RUN-2026-10-28.md](docs/DESKTOP-DRY-RUN-2026-10-28.md). The
> 2026-10-27 incident remains historical in
> [docs/STATUS-2026-10-27.md](docs/STATUS-2026-10-27.md).

A local, deterministic model router for the OpenCode macOS desktop app. It chooses the least quota-expensive model that can complete the current task to the required standard, then switches the session before the request is dispatched.

The current install path for **OpenCode 2.1.4** is:

```text
~/.config/opencode/plugins/opencode-smart-router
```

Automatic routing is active by explicit approval; premium and purchased-credit spending remain disabled. The routing engine and UX code remain in this source tree. It does not require a separate daemon or dashboard.

## What it does

- Classifies each admitted prompt locally using prompt structure, attachments, agent, context size, recent failures, and session history.
- Enforces a **DeepSeek V4.1 Flash intelligence floor** for substantive work.
- Requires native image input for screenshots, UI mockups, visual QA, and design critique.
- Uses an economy tier only for narrow, mechanically verifiable work.
- Treats design quality as a separate capability from general intelligence.
- Reads **provider-reported** quota from OpenCode Go and Command Code when available.
- Keeps estimated per-model usage where the provider has no per-model endpoint.
- Uses cache-aware affinity so large conversations are not switched for tiny savings.
- Keeps premium models locked unless a one-shot approval or an explicit premium budget allows them.
- Never buys credits, changes billing, enables top-ups, or routes to an unapproved provider.
- Fails closed: if no qualified route exists, the current model is left unchanged and a warning is recorded.

## Verified automatic switching

The prompt admission hook runs before the model request. A real desktop-session test changed a session from `opencode-go/beam-free` to `opencode-go/claude-haiku-5-5` before the request ran. A cross-provider test changed a session to `commandcode/deepseek/deepseek-v4.1-flash`. The model that produced the response was the newly selected model, not the previous one.

The router does not switch in the middle of an active model response. If a prompt is admitted while the session is busy, routing is skipped and the active loop continues.

## Controls

The installed OpenCode version does not expose the experimental GUI plugin SDK (`./gui-experimental`) that arrived in later builds. The supported desktop controls are native OpenCode slash commands; they appear in the command menu and return a short status message:

| Command | Purpose |
|---|---|
| `/router-status` | Current runtime mode, selected model, task tier, quota, and warnings |
| `/router-explain` | Last decision, signals, candidate costs, and reasons |
| `/router-report` | Local usage, switches, premium prevention, retries, latency |
| `/router-mode efficiency\|balanced\|premium` | Change the routing mode |
| `/router-dry-run on\|off` | Explain decisions without changing the model |
| `/router-auto` | Clear a manual override and resume automatic routing for this session |
| `/router-pin provider/model` | Pin a model for this session |
| `/router-exclude provider/model` | Exclude a model from automatic routing |
| `/router-approve` | Approve one premium request for this session |
| `/router-pause` / `/router-resume` | Pause or resume routing globally |
| `/router-premium-budget <usd>` | Set the premium budget |
| `/router-reserve provider monthly weekly fiveHour` | Adjust provider reserves |
| `/router-reset-metrics --confirm` | Reset local metrics and routing state, not conversations |

The same controls are available over RPC at `rpc.smart-router.*` for a future GUI or an external client. The router works with the command panel closed.

A manual model selection in the desktop model picker is detected and respected. The session reports `manual` until `/router-auto` or the panel's resume action is used.

## Configuration

Defaults are safe and require no file. To override them, copy `config.example.json` to:

```text
~/.config/opencode/smart-router.json
```

A project may add `.opencode/smart-router.json`. Project files can tighten privacy and spending policy but cannot enable training models, extra credits, or automatic premium routing that the global file disallows.

Important defaults:

- Mode: `balanced`
- Premium: `ask`, with a $0 budget and one-shot approval available
- Training-enabled and free promotional models: blocked
- Extra purchased credits: blocked
- Automatic model discovery: used, but discovered models are unapproved until qualified
- Context-health monitoring: enabled, non-destructive
- Prompt text storage: disabled
- Quota polling: every 5 minutes with backoff
- Provider reserves: 10% monthly, 15% weekly, 10% five-hour

## Quota sources

### OpenCode Go

The router reads the provider-reported rolling, weekly, and monthly meters from the Go usage endpoint using OpenCode's existing OAuth connection. It never sends that token to another host. This is a best-effort read-only probe, not part of the public inference schema.

### Command Code

The router reads the same read-only alpha billing endpoints the official `cmd` CLI uses:

```text
GET https://api.commandcode.ai/alpha/whoami?limits=1
GET https://api.commandcode.ai/alpha/billing/credits
GET https://api.commandcode.ai/alpha/billing/subscriptions
GET https://api.commandcode.ai/alpha/usage/summary
```

It discovers an authorized key from `COMMAND_CODE_API_KEY`, `~/.commandcode/auth.json`, OpenCode's connected provider, or the user's owner-only OpenCode key file. Files with group or world permissions are ignored. The key is never logged, stored by the router, or sent to any host other than `api.commandcode.ai`.

The billing routes return monthly included credits remaining, purchased and free extra credits, five-hour and weekly used/cap values, reset times, plan, and billing-period usage. The provider's remaining-credit balance is authoritative for monthly usage and allowance protection; the billing-period usage summary is a separate accounting pool and is kept only as a diagnostic. The routes are treated as unstable: on failure the plugin keeps the last good snapshot as stale and falls back to a clearly labeled local estimate. It never assumes unlimited usage.

## Model policy

The approved seed is documented in [docs/MODELS.md](docs/MODELS.md). The short version:

- **Economy:** GPT-6 Luna, MiMo-V2.6-Flash, Hy3, LongCat-2.0. These are below the standard floor and are used only for narrow mechanical work.
- **Standard:** DeepSeek V4.1 Flash (floor), GLM-5.3-Flash, MiniMax M3.1 Flash, Claude Haiku 5.5, MiMo-V2.6-Pro.
- **Premium:** GLM-5.3, Kimi K3, Grok 4.7, Qwen3.8 Max, Step 5 Preview, Claude Sonnet 5.5, Muse Spark 1.3, and other frontier models. Never selected for trivial work, and never selected automatically without approval or a configured premium budget.
- **Unapproved:** new or unscored models, training-enabled contributor models, free promotional models, and text-only models for vision tasks.

## How it decides

1. Classify the task and its hard requirements.
2. Remove disabled, unapproved, privacy-blocked, unqualified, context-incompatible, and quota-blocked models.
3. Estimate total task cost across the expected agent-loop steps, not one call.
4. Estimate success probability and expected retry cost.
5. Apply provider and per-model quota pressure, using the tightest short window.
6. Add the cache-loss penalty of switching.
7. Keep the current model when the savings are below the hysteresis threshold.
8. Record a short explanation without storing the prompt.

No model is called to make the routing decision.

## Installation and verification

See [docs/INSTALL.md](docs/INSTALL.md). The plugin is installed in the live desktop with **automatic routing active** as of 2026-10-28; premium and purchased-credit spending remain disabled. Backups and independent rollback:

```text
Pre-deployment + full rollback:
~/Documents/opencode-smart-router-backups/20261027-223912

Promotion dry-run snapshot + immediate rollback:
~/Documents/opencode-smart-router-backups/20261027-225615-promotion
```

To install, verify, or remove the plugin, see [docs/INSTALL.md](docs/INSTALL.md).

## Known limitations

See [docs/LIMITATIONS.md](docs/LIMITATIONS.md). The most important ones:

- The installed desktop 2.1.4 has no GUI plugin SDK, so the interface is slash commands plus RPC, not a side panel.
- Command Code's billing routes are alpha and undocumented; they can change without notice.
- Per-model Command Code usage is estimated locally; the provider reports account-level balances and windows only.
- If no qualified route exists, the router fails closed by rejecting the prompt through the admission hook (HTTP 500 in the installed 2.1.4 host) and records a visible reason. Manual selections and paused routing are outside the strict block.
- A CLI `--model` selection at session creation is indistinguishable from the session default. Manual selections made after the session exists are detected.

## Tests

```bash
cd ~/Documents/opencode-smart-router
npm run typecheck
npm test
```

106 tests cover classification, eligibility, quota parsing, provider credential discovery, ledger accounting, monthly pool reconciliation, documented peak pricing, cache-aware routing, premium protection, purchased-credit blocking, manual overrides, failure classification, configuration guardrails, and controller integration. See [docs/QA.md](docs/QA.md) for live evidence.
