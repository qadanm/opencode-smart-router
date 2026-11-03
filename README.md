# OpenCode Smart Router

A model router for coding agents that bills against subscriptions instead of
token prices.

Most LLM routers (`litellm`, `claude-code-router`, `Portkey`, `RouteLLM`) treat
a request as `tokens × $/M`. That works for pay-as-you-go and breaks as soon as
you pay for a plan. A subscription puts a five-hour window inside a seven-day
window inside a monthly ceiling. Allowances are often metered per model and do
not pool, and some plans have two credit pools that draw differently and apply
different multipliers.

This router models the plan you actually bought, and it does not spend money you
did not authorize.

## Install in one command

**Any machine with Node 20.12+ and git.** From a checkout:

```bash
./install
```

It verifies the source, backs up your config, installs, wires the plugin in, and
confirms it loads. Add `--dry-run` to see every step without changing anything,
or `--yes` for a non-interactive run.

If this repo lives on a remote you can reach, bootstrap from it without cloning
first. `SMART_ROUTER_REPO` is the clone URL the bootstrap fetches:

```bash
SMART_ROUTER_REPO=https://github.com/you/opencode-smart-router.git \
  bash <(curl -fsSL https://raw.githubusercontent.com/you/opencode-smart-router/main/install)
```

There is no published one-liner yet: this repository has no public remote, so any
hard-coded `raw.githubusercontent.com/qadanm/...` address would 404. Point both
the URL and `SMART_ROUTER_REPO` at wherever you actually host it.

Then restart OpenCode and run `/router-status`.

That is the whole setup. It refuses to install if the source does not typecheck and pass
tests, backs up your config first, and leaves exactly one plugin entry however many times
you run it. To update, run the same command again. To remove it:

```bash
./scripts/uninstall.sh
```

Nothing else on your machine is touched: not your conversations, credentials, provider
connections, or project files.

### If you are an LLM setting this up for someone

Run the same command with `--yes`; it never prompts and every failure message is
actionable:

```bash
curl -fsSL https://raw.githubusercontent.com/qadanm/opencode-smart-router/main/install | bash -s -- --yes
```

- Exit code is non-zero on any failure, and **every check runs before anything is
  modified**, so a failed install leaves the machine exactly as it was.
- `./install --dry-run` prints every step without changing anything; use it to confirm
  what would happen.
- Requirements: `node >= 20.12`, `npm`, `git`. No `jq`, no other tooling.
- After installing, **OpenCode must be restarted** before the plugin loads.
- Verify success with `./scripts/install.sh --dry-run` (reports state) or by starting
  OpenCode and running `/router-status`.

## Two ways to use it

As an OpenCode plugin, it selects a model per prompt, respects the allowances
above, leaves your context intact, and refuses to buy credits.

As a library, `@qadanm/opencode-smart-router/allowance` is a 17 kB,
host-independent module with no external imports. It answers the allowance
question for any coding agent:

```ts
import { resolvePlan, modelWindowCaps, forecast } from "@qadanm/opencode-smart-router/allowance"

const caps = modelWindowCaps(resolvePlan("opencode-go", "go")!, "deepseek-v4.1-flash")
// { monthlyUsd: 80, weeklyUsd: 40, fiveHourUsd: 16 }
// Windows nest. They do not add up to $136.

const weekly = forecast({
  windowMs: 7 * 24 * 60 * 60 * 1000,
  now: Date.now(),
  spendInWindowUsd: 12.4,
  activityStart,
  remainingUsd: caps.weeklyUsd,
  label: "weekly",
})
// { willExhaust: true, exhaustsAt, explanation: "...runs out about 6.2 hours from now." }
```

The module reads no filesystem, opens no socket, inspects no environment
variable, and imports nothing from the host. A test enforces that, so it cannot
drift.

## Status

Development snapshot. Routing runs on the maintainer's machine by explicit
approval, and premium escalation plus purchased-credit spending are disabled.
[docs/PRO-MIGRATION-2026-10-29.md](docs/PRO-MIGRATION-2026-10-29.md) describes
current behavior and what is still uncertain.

This is not published to npm. See
[docs/PUBLICATION-READINESS.md](docs/PUBLICATION-READINESS.md) for what blocks a
release. In particular, the unscoped npm name `opencode-smart-router` belongs to
an unrelated GPL project, so this package uses a scope.

## What it does

- Classifies each prompt locally, using structure, attachments, agent, context
  size, recent failures, and session history.
- Holds substantive work to a DeepSeek V4.1 Flash intelligence floor.
- Requires native image input for screenshots, UI mockups, visual QA, and design
  critique.
- Uses the economy tier only for narrow work that can be checked mechanically.
- Scores design ability separately from general intelligence.
- Reads provider-reported quota from OpenCode Go and Command Code where an
  endpoint exists.
- Keeps a labeled local estimate for per-model usage the provider does not
  report.
- Prefers the current model when the savings from switching are small, because
  switching discards a warm prompt cache.
- Keeps premium models locked unless you approve one request or set a premium
  budget.
- Never buys credits, changes billing, enables top-ups, or routes to a provider
  you did not approve.
- Fails closed. When no qualified route exists, the current model stays in place
  and the reason is recorded.

## Verified switching

The admission hook runs before the model request, so a switch takes effect
before dispatch. In a desktop session test, a session moved from
`opencode-go/beam-free` to `opencode-go/claude-haiku-5-5` before the request ran,
and the response came from the new model. A cross-provider test moved a session
to `commandcode/deepseek/deepseek-v4.1-flash` with the same result.

The router does not switch mid-response. If a prompt arrives while the session is
busy, routing is skipped and the active loop continues.

## Commands

The installed OpenCode 2.1.4 does not expose the experimental GUI plugin SDK
(`./gui-experimental`) that later builds ship. The controls are native slash
commands, which appear in the command menu and return a short status message:

| Command | Purpose |
|---|---|
| `/router-status` | Runtime mode, selected model, task tier, quota, warnings |
| `/router-explain` | Last decision, signals, candidate costs, reasons |
| `/router-report` | Local usage, switches, premium prevention, retries, latency |
| `/router-floor` | The intelligence floor in force, where it came from, and what it admits |
| `/router-mode efficiency\|balanced\|premium` | Change the routing mode |
| `/router-dry-run on\|off` | Explain decisions without changing the model |
| `/router-auto` | Clear a manual override and resume automatic routing |
| `/router-pin provider/model` | Pin a model for this session |
| `/router-exclude provider/model` | Exclude a model from automatic routing |
| `/router-approve` | Approve one premium request for this session |
| `/router-pause` / `/router-resume` | Pause or resume routing globally |
| `/router-premium-budget <usd>` | Set the premium budget |
| `/router-reserve provider monthly weekly fiveHour` | Adjust provider reserves |
| `/router-reset-metrics --confirm` | Reset local metrics and routing state, not conversations |

The same controls are available over RPC as `rpc.smart-router.*`, for a GUI or an
external client. Routing works with the command panel closed.

Selecting a model in the desktop model picker is detected and respected. The
session reports `manual` until you run `/router-auto` or use the panel's resume
action.

## Configuration

The defaults are safe and need no file. To change them, copy
`config.example.json` to:

```text
~/.config/opencode/smart-router.json
```

A project may add `.opencode/smart-router.json`. A project file can tighten
privacy and spending policy. It cannot enable training models, extra credits, or
automatic premium routing that the global file disallows.

Defaults worth knowing:

- Mode: `balanced`
- Premium: `ask`, with a $0 budget and one-shot approval available
- Training-enabled and free promotional models: blocked
- Purchased extra credits: blocked
- Model discovery: enabled, but discovered models stay unapproved until qualified
- Context-health monitoring: enabled and non-destructive
- Prompt text storage: disabled
- Quota polling: every 5 minutes, with backoff
- Provider reserves: 10% monthly, 15% weekly, 10% five-hour
- Credential discovery: `explicit` (reads only configured paths and environment)

### Credential discovery

Reading well-known credential files is opt-in. Set `credentialSource: "auto"` on
a provider, or set `SMART_ROUTER_ALLOW_KEY_DISCOVERY=1`. `"off"` disables
filesystem reads entirely.

This is deliberately not the default. A router that silently looks for secrets
in predictable places is one path away from reading something it has no business
reading.

## Quota sources

### OpenCode Go

The router reads the provider-reported rolling, weekly, and monthly meters from
the Go usage endpoint, using OpenCode's existing OAuth connection. That token is
never sent to another host. This is a best-effort read-only probe against an
undocumented route, not part of the public inference schema.

### Command Code

The router reads the same read-only alpha billing endpoints the official `cmd`
CLI uses:

```text
GET https://api.commandcode.ai/alpha/whoami?limits=1
GET https://api.commandcode.ai/alpha/billing/credits
GET https://api.commandcode.ai/alpha/billing/subscriptions
GET https://api.commandcode.ai/alpha/usage/summary
```

It finds a key in `COMMAND_CODE_API_KEY`, `~/.commandcode/auth.json`, the
provider settings OpenCode holds, or a credential file you name and own. Files
readable by group or world are refused. The key is never logged, never stored by
the router, and never sent anywhere except `api.commandcode.ai`.

Those routes return monthly included credits, purchased and free extras, five-hour
and weekly used/cap values, reset times, plan, and billing-period usage. The
remaining-credit balance is authoritative for monthly protection. Billing-period
usage is a separate accounting pool and is kept only as a diagnostic. The routes
are treated as unstable: on failure the last good snapshot is kept and marked
stale, and the router falls back to a clearly labeled local estimate. It never
assumes unlimited usage.

### OpenDesign

OpenDesign publishes no quota endpoint for an inference key, so its allowance is
reported as an estimate derived from this router's own usage, with a safety
margin. An inference key cannot read the account; a separate control key can, and
the router only uses one if you point it at a file. It never requests or acquires
one. See [docs/OPENDESIGN-INTEGRATION.md](docs/OPENDESIGN-INTEGRATION.md).

## Model policy

The approved seed is in [docs/MODELS.md](docs/MODELS.md). In short:

- **Economy:** GPT-6 Luna, MiMo-V2.6-Flash, Hy3, LongCat-2.0. Below the standard
  floor, used only for narrow mechanical work.
- **Standard:** DeepSeek V4.1 Flash (the floor), GLM-5.3-Flash, MiniMax M3.1
  Flash, Claude Haiku 5.5, MiMo-V2.6-Pro.
- **Premium:** GLM-5.3, Kimi K3, Grok 4.7, Qwen3.8 Max, Step 5 Preview, Claude
  Sonnet 5.5, Muse Spark 1.3, and other frontier models. Never selected for
  trivial work, and never selected automatically without approval or a budget.
- **Unapproved:** new or unscored models, training-enabled contributor models,
  free promotional models, and text-only models for vision tasks.

## How it decides

1. Classify the task and its hard requirements.
2. Remove disabled, unapproved, privacy-blocked, unqualified, context-incompatible,
   and quota-blocked models.
3. Estimate the cost of the whole task across the expected agent-loop steps, not
   one call.
4. Estimate success probability and the expected cost of retries.
5. Apply provider and per-model quota pressure, using the tightest short window.
6. Add the cost of losing a warm prompt cache if it switches.
7. Keep the current model when the savings fall below the hysteresis threshold.
8. Record a short explanation, without storing the prompt.

### The floor, when you would rather not maintain it by hand

`routing.intelligenceFloor` defaults to 39.5 and is a hand-picked number. You can
find it does not do much: `claude-haiku-5-5` scores 43.4 at $0.10/$0.50, so it is
simultaneously the cheapest eligible model and above the floor. Deleting the
floor changes nothing, because cost ranking was already choosing it.

Set `routing.calibrateFloor: true` to derive the floor from your own recorded
spend instead. It works like this:

1. Take the total recorded spend for the last 14 days and divide by the number of
   requests. That average is the budget: it is what you already spend, so
   honoring it is consistency rather than a compromise.
2. Among approved, non-escalation models that actually served traffic, find the
   most capable one whose cost per request is within 5% of that average.
3. That model's intelligence score becomes the floor.

Constraints, all of them deliberate:

- **It never raises the floor.** The configured value is the ceiling. Raising it
  would exclude models you already approved and make the router stricter than its
  own settings claim.
- **It may drop at most 12 points.** A run of cheap traffic must not be able to
  send substantive work to a model that cannot do it.
- **It needs at least 5 recorded requests.** Below that you get your configured
  floor and a message saying so, because a calibration built on four requests
  would be a fabrication.
- **It ignores models with no recorded traffic.** Their list price describes the
  vendor's assumptions, not your workload.
- **It is off by default and does nothing in offline mode.** Offline has its own
  allow-list and its own relationship with the floor.

When the flag is off, or when there is not enough evidence, behavior is exactly
what it was before calibration existed. That is asserted in
`test/calibration-routing.test.ts`, not assumed.

No model is called to make a routing decision.

A large transcript is one reason a model gets filtered out. DeepSeek V4.1 Flash
has a 328k window, and the router reserves 20k of headroom inside 95% of it, so
it stops being eligible around 291,600 tokens. When that happens the router
names the model it dropped, both token counts, and the fact that a new session
restores it.

## Security

Credential handling is a documented trust boundary. The rules below are
enforced in code and asserted in tests:

- **Discovery is opt-in.** Without `credentialSource: "auto"` or
  `SMART_ROUTER_ALLOW_KEY_DISCOVERY=1`, only configured paths and the
  environment are read.
- **No cross-application access.** The router never reads OpenCode's own
  `auth.json`, which holds OAuth material for every provider you connected.
- **Race and symlink resistant.** Files are opened once with `O_NOFOLLOW`, and
  every check runs against the open descriptor.
- **Secrets cannot leak into output.** No credential reaches the ledger, a
  decision, a session title, or a log line.

[SECURITY.md](SECURITY.md) is the full account, including every host the router
contacts and every field it stores.

## Install and verify

See [docs/INSTALL.md](docs/INSTALL.md). To install, verify, or remove the plugin,
that is the only document you need.

### Rollback

Every install backs up the config it is about to change and prints the path. To
undo:

```bash
./scripts/uninstall.sh                      # removes the plugin and its config entry
./scripts/uninstall.sh --restore-backup <file>   # or restore an exact prior config
```

Installs are additive and versioned: each one lands in its own directory under
`~/.config/opencode/plugins/opencode-smart-router/`, and only the config pointer
changes. Nothing on your machine outside that directory and its `plugins` entry
is touched - not conversations, credentials, provider connections or projects.

## Known limitations

See [docs/LIMITATIONS.md](docs/LIMITATIONS.md). The ones that matter most:

- Desktop 2.1.4 has no GUI plugin SDK, so the interface is slash commands plus
  RPC, not a side panel.
- Command Code's billing routes are alpha and undocumented. They can change
  without notice.
- Per-model Command Code usage is estimated locally, because the provider reports
  account-level balances and windows only.
- When no qualified route exists, the router fails closed by rejecting the prompt
  in the admission hook (HTTP 500 in the installed host) and records a visible
  reason. Manual selections and paused routing are outside that block.
- A CLI `--model` at session creation is indistinguishable from the session
  default. Manual selections made after the session exists are detected.
- OpenDesign quota is an estimate, not a verified balance, because reading it
  requires a control key the router does not have.

## Tests

```bash
npm run verify    # clean room: fresh install, typecheck, tests, both builds
npm test          # the suite only
npm run mutate    # prove the safety tests fail when their properties break
```

491 tests across 41 files cover classification, eligibility, quota parsing,
credential discovery and its security properties, ledger accounting, monthly pool
reconciliation, documented peak pricing, cache-aware routing, premium protection,
purchased-credit blocking, manual overrides, failure classification,
configuration guardrails, context policy, OpenDesign quota honesty, the portable
allowance API, and controller integration.

Two commands exist because passing tests prove less than they appear to.
`npm run verify` repeats the whole thing in a clean room with an empty `HOME`, so
a pass cannot depend on this machine's config or credentials. `npm run mutate`
reverts each of 62 safety properties in turn and fails if the suite still passes,
which is the only way to know a test is guarding anything.

`npx vitest run` for the suite, `npx tsc --noEmit` for types, and
`npm run build:allowance` for the standalone core. Live evidence is in
[docs/QA.md](docs/QA.md).

## Contributing

Bug reports and pull requests are welcome. Before opening a PR:

```bash
npm run check     # typecheck + full suite
npm run verify    # the same, in a clean room with an empty HOME
npm run mutate    # prove the safety tests still catch their properties
```

A change that alters routing behavior needs a test that fails without it.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions this repo follows and
[SECURITY.md](SECURITY.md) for reporting a vulnerability.

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2026 Moe Qadan.

In short: use it, modify it, ship it, sell it. Keep the copyright notice and the
permission text with any substantial copy, and understand that it comes with no
warranty. The routing decisions it makes are estimates from modelled quota data,
not guarantees from your providers.
