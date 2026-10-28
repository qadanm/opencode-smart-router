# QA evidence

All checks below were run on this machine against the installed desktop server, not only against isolated functions. **The live plugin was disabled after the stability incident documented in [STATUS-2026-10-27.md](STATUS-2026-10-27.md). The live routing results below were captured before that rollback.**

## Automated checks

```text
npm run typecheck  → exit 0
npm test           → 7 files, 69 tests passed
```

Coverage includes:

- task classification, including narrow CSS, broad scope, screenshots, redesign, architecture, security, stack traces, and self-described simplicity;
- intelligence-floor enforcement and unclassified-model exclusion;
- premium protection, one-shot approval, and premium locking in Maximum Efficiency;
- vision hard requirements and text-only exclusion;
- provider-reported Go and Command Code quota parsing, including reset times and extra credits;
- credential discovery, owner-only permission checks, and unauthorized-key fallback;
- rolling five-hour, weekly, monthly, and per-model ledger accounting;
- cache-loss pricing and large-context affinity;
- manual override, pause, dry-run, and disabled-routing behavior;
- failure classification for context overflow, network, rate limits, auth, provider outage, tool errors, and capability failures;
- subagent premium caps;
- configuration guardrails that prevent project files from loosening privacy or spending policy;
- controller integration that invokes the actual prompt hook and verifies the switch occurs before the request.

## Live provider-reported quota

Captured from the installed desktop plugin after provider probes. Values are redacted and rounded.

### OpenCode Go

```json
{
  "providerID": "opencode-go",
  "label": "OpenCode Go Plus",
  "source": "provider",
  "rolling": { "usedPct": 0, "resetsAt": "2026-10-27T21:53:04.000Z" },
  "weekly": { "usedPct": 40, "resetsAt": "2026-11-02T00:00:00.000Z" },
  "monthly": { "usedPct": 70, "resetsAt": "2026-11-20T11:37:14.000Z" }
}
```

### Command Code

```json
{
  "providerID": "commandcode",
  "label": "Command Code GOAT",
  "source": "provider",
  "plan": "GOAT",
  "planStatus": "active",
  "rolling": { "usedPct": 0.33, "usedUsd": 0.0322, "capUsd": 14, "resetsAt": 1793156518583 },
  "weekly": { "usedPct": 72.30, "usedUsd": 25.29, "capUsd": 35, "resetsAt": 1793428863795 },
  "monthly": { "usedPct": 36.53, "usedUsd": 25.67, "capUsd": 70.38, "resetsAt": 1795501544000 },
  "monthlyRemainingUsd": 44.71,
  "extraCredits": { "purchasedUsd": 0, "freeUsd": 0, "totalUsd": 0 }
}
```

The Command Code monthly grant is the sum of remaining included credits and billing-period usage, both provider-reported. It is not assumed from the plan name. Purchased and free credits remain separate pools.

The plugin uses the Command Code CLI-compatible key because the inference key is rejected by the alpha billing routes. No key, token, email, or account identifier is included here.

## Live routing decisions

Each test used a new desktop session with a deliberately weak starting model. The router changed the session before the request, and the response came from the changed model.

| Prompt | Tier / kind | Selected route | Result |
|---|---|---|---|
| Narrow CSS change with explicit file and "do not run tests" | 1 / mechanical | `opencode-go/mimo-v2.6-flash` | File changed from `white` to `#111111`; tool calls survived the switch |
| Ordinary "reply only" prompt | 2 / unknown | `opencode-go/claude-haiku-5-5` | Completed |
| Redesign with a screenshot, no approval | 3 / design, vision required | `opencode-go/claude-haiku-5-5` standard fallback | Premium approval warning recorded |
| Same redesign, one-shot approval | 3 / design, vision required | `commandcode/meta/muse-spark-1.3` premium | One-shot consumed; premium route used |
| Manual switch to `commandcode/deepseek-v4.1-flash` | manual | Kept | `/router-status` reported `manual`; no override |
| Cross-provider switch from `opencode-go/beam-free` | 2 | `commandcode/deepseek/deepseek-v4.1-flash` | Request ran on Command Code |

A real completed tool task changed a CSS file correctly on the economy route. After the classifier was tightened, the same kind of task selected `opencode-go/mimo-v2.6-flash` (economy) and the file changed from `white` to `#111111`. This verifies that switching before admission preserves tool calls.

A live pause test set the router to paused, sent a prompt with the starting model `opencode-go/beam-free`, and confirmed the session stayed on `beam-free` and completed normally. Routing was then resumed.

## Cross-provider proof

The prompt admission hook was tested with a server that logged the pre-switch model, the post-switch model, and the model observed by the request-context hook:

```json
{"at":"prompt.before","model":{"providerID":"opencode-go","id":"iceman-contributor-free"}}
{"at":"prompt.after","model":{"providerID":"commandcode","id":"deepseek/deepseek-v4.1-flash"}}
{"at":"context","model":{"providerID":"commandcode","id":"deepseek/deepseek-v4.1-flash"}}
```

This proves the switch happened before the intended request, not after it.

## Installed desktop verification

```text
GET /api/plugin
{
  "id": "opencode-smart-router",
  "source": { "type": "local", "path": "~/.config/opencode/plugins/opencode-smart-router/index.ts" },
  "features": { "server": true },
  "state": { "status": "active" }
}
```

The native commands are present in the desktop server's command list, including `router-status`, `router-explain`, `router-report`, `router-approve`, `router-auto`, `router-pin`, and `router-mode`.

## What is provider-reported vs estimated

| Value | Source |
|---|---|
| Go rolling/weekly/monthly percentages and reset times | Provider-reported |
| Command Code included credits remaining, extras, five-hour/weekly windows, resets, plan, billing period, spend | Provider-reported |
| Command Code per-model usage and remaining model allowance | Local estimate from observed step costs |
| Go per-model dollar usage | Local estimate; the provider reports percentages |
| Expected task cost, success probability, retry cost | Local model using catalog prices and task signals |
| Premium budget and spend | Local accounting |

## Cleanup

All test sessions created through the desktop API were deleted after verification. `/router-reset-metrics --confirm` was used to clear test metrics and re-bootstrap the remaining real sessions. No user conversation was deleted.

## Not verified

- GUI panel rendering: the installed desktop 2.1.4 has no GUI plugin SDK. See [LIMITATIONS.md](LIMITATIONS.md).
- A full desktop application process restart was not forced because it would close the user's active windows. The plugin is installed in the global config, the server reports it active, and a clean standalone server loaded it from the same global entry, which is the restart path. The persistent ledger and runtime overrides are written through OpenCode's durable plugin storage; hydration is unit-tested.
- A live 600K-context switch test on a forked session did not execute a prompt because the source session was busy. Large-context affinity is covered by the routing unit tests and by the cache-loss pricing tests. The live plugin now estimates a large context for forks and long-lived sessions before routing, then refines it in the background.
- Provider-side billing enforcement cannot be proven from a client. The router fails conservatively and never claims a guaranteed cap.
