<div align="center">

<img alt="smart router" src="assets/logo.svg" width="300">

<h3>A model router for OpenCode that bills against your subscription, not a price list</h3>

<p>Every other router asks what a token costs. This one asks what your plan allows, what is about to expire, and what you already paid for. MIT licensed.</p>

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/OpenCode-2.x-000000.svg" alt="OpenCode 2.x">
  <img src="https://img.shields.io/badge/tests-759%20passing-2ea44f.svg" alt="759 tests">
  <img src="https://img.shields.io/badge/runtime-Node%2020.12%2B-339933.svg" alt="Node 20.12+">
</p>

<p>
  <a href="#install"><b>Install</b></a> &nbsp;·&nbsp;
  <a href="#how-it-decides">How it decides</a> &nbsp;·&nbsp;
  <a href="#commands">Commands</a> &nbsp;·&nbsp;
  <a href="docs/ARCHITECTURE.md">Architecture</a> &nbsp;·&nbsp;
  <a href="docs/LIMITATIONS.md">Limitations</a>
</p>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.svg">
  <img alt="Your prompt goes to the smart router, which classifies and prices it against your real quota before OpenCode sends the step to one provider" src="assets/architecture-light.svg" width="880">
</picture>

<br>

<p>
  <a href="assets/screenshots/router-panel.png"><img alt="The router panel beside a live OpenCode session: the model it chose and why, the allowance windows it is spending against, and every provider it can route to" src="assets/screenshots/router-panel.png" width="720"></a>
</p>

<table>
  <tr>
    <td align="center" width="50%">
      <a href="assets/screenshots/router-decision.png"><img alt="The decision inspector: the winning model with its estimated cost, and the runner-ups it beat" src="assets/screenshots/router-decision.png" width="376"></a>
      <br><sub>The choice, laid out with its runner-ups</sub>
    </td>
    <td align="center" width="50%">
      <a href="assets/screenshots/router-allowances.png"><img alt="Allowance meters for each provider: five-hour, seven-day and monthly windows, the credit pools behind them, and an honest lower-bound marker where the figure is an estimate" src="assets/screenshots/router-allowances.png" width="376"></a>
      <br><sub>What is left, per window and per pool</sub>
    </td>
  </tr>
</table>

<p>
  <a href="assets/screenshots/router-onboarding.png"><img alt="First-run onboarding: what the router found on this machine, what it learned from your history, and the one thing it cannot see, with the exact page to paste" src="assets/screenshots/router-onboarding.png" width="720"></a>
</p>

</div>

---

If you pay for a coding plan, you are not buying tokens. You are buying a set of
windows that expire. A five-hour window sits inside a seven-day window inside a
monthly ceiling, some windows are metered per model and do not pool, and a few
plans run two credit pools that draw at different rates.

Token-based routers cannot see any of that. They price every request the same way
and happily spend the last dollar of an allowance that was about to reset anyway.
This router models the plan you actually bought.

## The problem, concretely

You have three subscriptions. One has 90% of its five-hour window free but resets
in forty minutes. Another has a huge untouched monthly pool. A third is nearly
exhausted and expires tonight.

A price-per-token router picks the same model every time. Whichever is cheapest on
paper. It ignores that the first allowance is about to evaporate, that the second
is your real safety margin, and that the third will be wasted if nobody spends it.

The smart router ranks by what a request actually costs *you*: the modelled
allowance it consumes, adjusted for how much of that allowance would otherwise be
lost. When a pool is about to expire and mostly unspent, spending it is close to
free. When a pool is nearly gone, it stops being attractive.

<p align="center">
  <img alt="Comparison: a fixed price-per-token router keeps choosing the same model, while the smart router shifts its choice as allowances fill and expire" src="assets/demo.svg" width="760">
</p>

## Install

Requires Node 20.12+, npm and git. No `jq`, no global CLI, nothing to configure.

### From npm

Add the plugin to your `opencode.json`; OpenCode installs it from npm at startup:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@qadanm/opencode-smart-router"]
}
```

That is the routing core in one self-contained file. The full experience (desktop
panel, terminal commands, history import, first-run onboarding) comes from the
installer below.

### Full experience (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/qadanm/opencode-smart-router/main/install | bash
```

Or from a clone:

```bash
git clone https://github.com/qadanm/opencode-smart-router.git
cd opencode-smart-router && ./install
```

It validates the source, runs the full suite, backs up your config, builds, installs,
and confirms the bundle loads. Every check runs before anything is written, so a
failed install leaves your machine exactly as it was.

Non-interactive, for CI or an agent:

```bash
./install --yes
```

See what it would do without touching anything:

```bash
./install --dry-run
```

Restart OpenCode, then run `/router-status` in any session.

Already using it? Run `./install` again to update. Installs are versioned, so a
running session keeps the module it loaded and picks up the new one on next start.

**[Full install, verify and rollback guide →](docs/INSTALL.md)**

## How it decides

<p align="center">
  <img alt="Pipeline: classify the task, evaluate each approved model for eligibility, price it against quota, then pick the lowest effective cost with a cache-affinity margin" src="assets/pipeline-light.svg" width="820">
</p>

Every prompt is classified locally, in about a millisecond, from its structure
rather than its wording. The router reads scope, attachments, agent type, context
size and recent failures, then holds substantive engineering work to an
intelligence floor and requires native image input for anything visual.

Then it does the part that matters:

1. **Eligibility first.** A model is discarded if a plan cannot fund it, if a
   provider allowance is exhausted, if the task needs vision the model lacks, or
   if the intelligence floor excludes it. Refusals are recorded with the reason.
2. **Price against the plan.** Cost is the modelled allowance a request consumes
   in the windows that will actually be charged, not a per-token rate.
3. **Discount what is expiring.** Prepaid allowance about to reset is priced near
   its probability of being wasted. It is a bounded discount, never free, because
   a pool with no headroom cannot carry the work.
4. **Prefer staying put.** Switching discards a warm prompt cache, which costs real
   money. The router only moves when the saving clears a margin.

When a genuinely near-expiry window and a cheap provider disagree, the router picks
the option that spends money you have already committed to losing.

## Self-healing routing

Other routers stop when the wire misbehaves. This one recovers, in three steps,
and every step is visible in the panel:

1. **Repairs the prompt in flight.** Some models reject a rebuilt session: the
   Anthropic protocol accepts only user and assistant message roles, and a
   mid-session notice otherwise kills the whole turn with a 400 error. The
   router folds those notices into user messages before the request leaves, so
   the turn continues on the chosen model. You see nothing, because nothing
   went wrong. OpenAI-compatible gateways are untouched.

2. **Never retries a doomed request.** A deterministic rejection (the provider
   refused the request shape before generating anything) would produce the
   identical 400 on every retry. The router classifies it as its own failure
   class, declines the host's retry, and instead of burning turns records that
   the model is healthy while the request shape was not.

3. **Fails over and continues.** With the rejecting model held back, the router
   re-routes the same task to the next best eligible choice, switches the
   session, and continues the turn with a single `[router]` notice. One
   failover per prompt, never a loop. The hold is five minutes and sits on the
   model for every session, because a gateway that rejects one rebuilt session
   will reject others like it. The panel's last decision shows what was
   rejected and what took over.

## What it will not do

- Never buys credits, changes billing, or enables top-ups.
- Never routes to a provider you did not approve.
- Never spends premium quota without an explicit one-shot approval or a budget you set.
- Never switches a session to a model OpenCode cannot currently resolve.
- Never fails open on missing quota data when other providers already reported.
- Never blocks your other work when one provider is at its limit.

## Status

Development snapshot. Routing is running on the maintainer's machine by explicit
approval; premium escalation and purchased-credit spending are disabled. Current
behavior and open questions are in
[docs/PRO-MIGRATION-2026-10-29.md](docs/PRO-MIGRATION-2026-10-29.md).

Not yet on npm. The unscoped name `opencode-smart-router` belongs to an unrelated
GPL project, so this package publishes under a scope. See
[docs/PUBLICATION-READINESS.md](docs/PUBLICATION-READINESS.md).

## Commands

Everything is a native slash command. No GUI needed, and routing works with the
command panel closed.

| Command | Purpose |
|---|---|
| `/router-status` | Runtime mode, selected model, task tier, quota, warnings |
| `/router-explain` | Last decision, signals, candidate costs, reasons |
| `/router-why` | Why this model, for the prompt you just sent |
| `/router-report` | Local usage, switches, premium prevention, retries, latency |
| `/router-floor` | The intelligence floor in force and what it admits |
| `/router-mode efficiency\|balanced\|premium` | Change routing mode |
| `/router-dry-run on\|off` | Explain decisions without changing the model |
| `/router-auto` | Clear a manual override, resume automatic routing |
| `/router-pin provider/model` | Pin a model for this session |
| `/router-exclude provider/model` | Exclude a model from automatic routing |
| `/router-approve` | Approve one premium request for this session |
| `/router-pause` / `/router-resume` | Pause or resume routing globally |
| `/router-premium-budget <usd>` | Set the premium budget |
| `/router-reserve provider monthly weekly fiveHour` | Adjust provider reserves |
| `/router-reset-metrics --confirm` | Reset metrics and routing state, not conversations |

Selecting a model in the desktop picker is detected and respected. The session
reports `manual` until you run `/router-auto`.

## Configuration

The defaults are safe and need no file. To change them:

```bash
cp config.example.json ~/.config/opencode/smart-router.json
chmod 600 ~/.config/opencode/smart-router.json
```

A project may add `.opencode/smart-router.json`. A project file can tighten policy.
It cannot loosen global restrictions.

Worth knowing:

- Mode: `balanced`
- Premium: `ask`, $0 budget, one-shot approval available
- Training-enabled and free promotional models: blocked
- Purchased extra credits: blocked
- Prompt text storage: disabled
- Quota polling: every 5 minutes, with backoff
- Provider reserves: 10% monthly, 15% weekly, 10% five-hour

### Credential discovery

Credentials are read from explicit paths, never guessed from arbitrary files.
Nothing is logged. `safeError()` and `redact()` exist so a failure message cannot
leak a key. The full model is in [docs/INSTALL.md](docs/INSTALL.md#credentials).

## The portable core

`dist/allowance.js` is a standalone module with no host dependency. You can use it
without OpenCode, to answer "when does this plan run out":

```js
import { projectExhaustion } from "./dist/allowance.js"

projectExhaustion({
  usedUsd: 12.4,
  capUsd: 30,
  windowMs: 7 * 24 * 60 * 60 * 1000,
  elapsedMs: 3.1 * 24 * 60 * 60 * 1000,
  label: "weekly",
})
// { willExhaust: true, exhaustsAt, explanation: "...runs out about 6.2 hours from now." }
```

It reads no files, opens no socket, inspects no environment variable, and imports
nothing from the host. A test enforces that, so it cannot drift.

## Tests

```bash
npm test          # the suite
npm run verify    # clean room: empty HOME, fresh install, typecheck, tests, builds
npm run mutate    # prove each safety test fails when its property breaks
```

759 tests across 63 files cover classification, eligibility, quota parsing,
credential discovery and its security properties, ledger accounting, pool
reconciliation, documented peak pricing, cache-aware routing, premium protection,
purchased-credit blocking, manual overrides, failure classification, configuration
guardrails, context policy, quota honesty, the portable allowance API, and
controller integration.

Two commands exist because passing tests prove less than they appear to. `verify`
repeats everything in a clean room with an empty `HOME`, so a pass cannot depend on
this machine. `mutate` reverts each of 62 safety properties in turn and fails if the
suite still passes, which is the only way to know a test is guarding anything.

Live evidence is in [docs/QA.md](docs/QA.md).

## Design notes

A few decisions that are easy to get wrong, and why they are the way they are:

- **Offline enforcement is an allow-list of one provider**, not a deny-list of
  known hosted ones. A deny-list fails open the moment someone adds a provider.
- **A saturated gateway is not a broken model.** Capacity refusals hold the
  endpoint back without charging the failure to the single model behind it.
- **Quota that expires unused is a sunk cost**, so the router prices it near its
  probability of being wasted instead of at sticker price.
- **A refusal outlives the reading that produced it.** An exhausted allowance stays
  excluded until a fresh probe clears it.

More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

Bug reports and pull requests are welcome. Before opening a PR:

```bash
npm run check     # typecheck + full suite
npm run verify    # the same, in a clean room with an empty HOME
npm run mutate    # prove the safety tests still catch their properties
```

A change that alters routing behavior needs a test that fails without it. See
[CONTRIBUTING.md](CONTRIBUTING.md) for conventions, and [SECURITY.md](SECURITY.md)
for reporting a vulnerability.

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2026 Moe Qadan.

Use it, modify it, ship it, sell it. Keep the copyright notice and permission text
with any substantial copy, and understand that it comes with no warranty. The
routing decisions it makes are estimates from modelled quota data, not guarantees
from your providers.
