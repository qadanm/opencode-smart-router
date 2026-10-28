# Architecture

## Runtime path

```text
OpenCode prompt admission
  → session.hook("prompt")
    → load session model and context tokens
    → local classifier
    → hard-requirement eligibility
    → provider and per-model quota snapshots
    → expected-cost ranking with cache-loss and hysteresis
    → session.switchModel(...) when a switch is justified
  → admission completes
  → request dispatch
```

The plugin does not modify the prompt text, attachments, tools, or agent. It never injects a classification prompt and never calls a model to decide routing.

## Modules

| Module | Responsibility |
|---|---|
| `src/core/models/seed.ts` | Curated model intelligence, design, tier, privacy, and allowance metadata |
| `src/core/models/registry.ts` | Merges live OpenCode metadata, approval state, exclusions, and tier overrides |
| `src/core/classify/classifier.ts` | Deterministic task tier, kind, vision, design, scope, and constraints |
| `src/core/policy/eligibility.ts` | Hard requirements, privacy, premium policy, context fit, quota blocks |
| `src/core/quota/ledger.ts` | Bounded local usage ledger, rolling windows, per-model estimates, premium spend |
| `src/core/quota/commandcode.ts` | Read-only Command Code alpha billing adapter |
| `src/core/quota/opencode-go.ts` | Read-only Go usage adapter |
| `src/core/quota/credentials.ts` | Owner-only credential discovery; never logs or persists keys |
| `src/core/quota/service.ts` | Caching, polling, stale detection, per-provider backoff |
| `src/core/routing/engine.ts` | Cost estimation, success probability, quota pressure, affinity, decision record |
| `src/core/failures.ts` | Failure classification and bounded escalation |
| `src/core/config.ts` | Defaults, validation, global/project precedence, project guardrails |
| `src/server/shared-core.ts` | One process-wide core: ledger, quota service, persistence, event stream, session ownership, catalog cache |
| `src/server/controller.ts` | Per-location bridge: hooks, RPC, commands, title queue, session-local state |
| `src/index.ts` | Plugin definition; creates one bridge per loaded location |

## Prompt timing

The V2 prompt hook runs once during admission, before attachment and skill resolution and before the durable inbox admission. The plugin awaits `ctx.session.switchModel` inside that hook. Integration tests and live desktop tests confirmed that the request-context hook observes the new model for the same prompt.

The router skips switching when:

- routing is paused or disabled;
- the session is manually overridden or pinned;
- another routing decision is already in flight for the same session;
- the session is busy in an active model loop;
- no eligible route exists.

It never switches in the middle of a response.

## Session state and affinity

Each session tracks the last model, last routed model, context size, cache-read share, step count, failures, retry count, manual override, premium one-shot, and pause state.

The engine prices a model switch as a cache loss. It keeps the current model when the expected savings are below the configured hysteresis. Above 300K context tokens the hysteresis is wider. The router never truncates or rewrites the conversation to make a route cheaper.

## Quota model

Two layers are kept separate:

1. **Provider-reported plan state**: Go percentages, Command Code remaining credits, windows, resets, plan, and billing period.
2. **Local per-model ledger**: observed step costs and tokens, used where the provider has no per-model breakdown.

Provider values override the ledger for plan-level pressure. Local values supply per-model estimates. Every displayed value carries its source (`provider`, `estimate`, or `unknown`). Polling is read-only and spends no inference allowance.

The ledger is bounded: 2,000 usage events, 120 decisions, 250 sessions, and 40 days of retention. Writes are debounced and JSON-sanitized.

## Concurrency

- One shared core is active per server process; each loaded location registers a lightweight bridge.
- A reload disposes only that location’s bridge. The core persists across reloads, stops its timers after a grace period, and revives on the next setup.
- Prompt routing is serialized per session. Concurrent submissions for the same session do not double-switch.
- Different sessions can route concurrently.
- The ledger is updated in one event loop; persistence is debounced. There is no cross-process writer.
- Provider probes are single-flight per provider and back off independently.

## Failure handling

- Context overflow → no escalation; recommend compaction or a handoff session.
- Network, rate limit, provider outage → retry/failover, never premium escalation.
- Auth → terminal retry decision, cooldown, no model escalation.
- Tool or command failure → no model escalation.
- Invalid image → no text-only fallback; require a verified vision route.
- Capability failure → one bounded escalation opportunity, then stop.
- Partial generation or side effects → never automatically replayed; the next prompt is routed with the failure history.

## Security

- No API keys or tokens are logged, persisted in router state, or included in RPC output.
- Command Code keys are read only from owner-only files or the connected integration and sent only to `https://api.commandcode.ai`.
- Go OAuth tokens are used only for `https://opencode.ai/zen/go/v1/usage`.
- Training-enabled and free promotional models are blocked by default.
- Project config files cannot loosen global privacy, extra-credit, or premium policy.
- The router does not read repository files to classify a prompt; it uses prompt structure and attachments only.
- Prompt text is not stored by default. Decision records contain signals and reasons, not the prompt.
