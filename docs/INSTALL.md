# Install, verify, and remove

## Install

One command, from a checkout. Requires Node 20.12+, npm and git. No `jq`.

```bash
./install              # interactive
./install --yes        # non-interactive, for CI or an LLM
./install --dry-run    # print every step, change nothing
```

It validates the source (typecheck and the full suite), backs up your config,
builds the bundle, installs it, adds exactly one entry to `plugins`, and confirms
the bundle loads. Any failure exits non-zero and leaves the machine untouched,
because every check runs before anything is written.

The install is **versioned and additive**. Each run writes to its own directory:

```text
~/.config/opencode/plugins/opencode-smart-router/<timestamp>/index.js
```

and only the config pointer changes. A running OpenCode server keeps the module it
already loaded; the new version takes effect on the next start. This matters more
than it sounds: replacing files inside the watched plugin directory invalidates the
plugin module mid-session and makes the provider's model list go empty, which shows
up as `Model unavailable: <provider>/<model>` for a model that is perfectly fine.

## Verify

```bash
./install --dry-run        # reports the current state without changing it
```

Then restart OpenCode and run `/router-status` in a session. It prints the active
plan, the allowance windows, and the model the router would pick.

## Disable without uninstalling

Set `"enabled": false` in `~/.config/opencode/smart-router.json` and restart. The
plugin stays installed and inert; your config, credentials and providers are
untouched either way.

## Uninstall

```bash
./scripts/uninstall.sh
```

Removes the plugin directory and every `plugins` entry under it, then offers the
exact pre-removal config as a restore point. Restart OpenCode afterwards.

## Update

Run `./install` again. It installs a new versioned directory and repoints the
config, so old versions can be deleted safely once the new one is confirmed:

```bash
ls ~/.config/opencode/plugins/opencode-smart-router/
```

## Rollback

Every install prints the backup it made. Two options:

```bash
./scripts/uninstall.sh                             # clean removal
./scripts/uninstall.sh --restore-backup <file>     # restore an exact prior config
```

## Verify quota and routing

The router exposes an RPC status method:

```bash
opencode api POST /api/rpc/smart-router/status -d '{"input":{}}'
```

Use `opencode api` so authentication is handled by OpenCode. The output labels each provider quota source as `provider`, `estimate`, or `unknown`.

For durable usage history, per-model totals and rolling-window forecasts:

```bash
opencode api POST /api/rpc/smart-router/usage -d '{"input":{}}'
```

This reports each provider's five-hour, seven-day and monthly consumption with input, output, cache-read and cache-write tokens, the cache share, per-model totals, and a forecast per window. A plan with no five-hour window reports that row as not applicable rather than as 0% used. It makes no inference request.

For a safe dry-run of a routing decision without changing the model:

```bash
opencode api POST /api/rpc/smart-router/preview \
  -d '{"input":{"sessionID":"ses_…","text":"Implement a small feature in src/app.ts"}}'
```

A safe smoke test:

1. Create a new session with a cheap or free model.
2. Send a narrow CSS change with an explicit file path.
3. The session should switch to an economy model before the request, and the file should change.
4. Send an ordinary feature request; it should use a standard model at or above the intelligence floor.
5. Send a tier-3 request (architecture, sophisticated redesign); with the 0.6.0 default
   `premium.mode: "auto"` it escalates to a plan model (Sonnet 5.5 or GPT-6.1 Sol)
   automatically — no approval step, paid from the plan-model pool.
6. Run `/router-why` on the escalated prompt; the reason should name auto escalation
   and the candidate trace should show the flagship row.
7. Select a model manually in the desktop picker; the next prompt must not be overridden, and `/router-status` should show `manual`.
8. Run `/router-auto` to resume.

## Automatic flagship escalation (0.6.0)

The default premium mode is `auto`. How it behaves:

- **Tier-1/2 work never touches the plan-model pool.** Routine tasks stay on the
  ordinary Design Plan models exactly as before.
- **Tier-3 work escalates by itself.** Architecture, sophisticated redesigns, and
  other tier-3 classifications route to Claude Sonnet 5.5 or GPT-6.1 Sol without an
  approval prompt, while the pool has budget.
- **The pool is the budget.** Auto escalation is funded from the OpenDesign
  plan-model pool ($120/month on Pro), read from the plan catalog and tracked in a
  ledger that survives restarts. When the pool is spent, escalation degrades to an
  approval gate (`/router-approve`) and the router serves the task with the strongest
  ordinary model — a routing refusal never fails a serviceable task.
- **Auto requires a resolvable pool.** If `providers.opendesign.plan` does not
  resolve to a known plan, auto refuses rather than falling back to the legacy
  premium budget, so spend is always attributable to a pool.

To change the behavior:

```json
{
  "premium": { "mode": "auto", "monthlyBudgetUsd": 120 }
}
```

`mode` may be `off` (never premium), `ask` (one-shot approval per request),
`allowed` (session approval unlocks the legacy premium budget), or `auto`.
A project-level `.opencode/smart-router.json` can tighten this but not loosen it.

## Configuration

No config file is required. To customize:

```bash
cp ~/Documents/opencode-smart-router/config.example.json \
   ~/.config/opencode/smart-router.json
chmod 600 ~/.config/opencode/smart-router.json
```

A project may add `.opencode/smart-router.json`. It can tighten privacy and spending policy but cannot loosen global restrictions.
