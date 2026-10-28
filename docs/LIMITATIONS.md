# Limitations and precise blockers

This file records what is proven, what is estimated, and what the installed OpenCode version cannot support.

## 1. Desktop GUI

Installed OpenCode Desktop is **2.1.4**. Its `app.asar` does not contain the experimental GUI plugin loader or the `./gui-experimental` export. The GUI plugin SDK is present in `@opencode/plugin` 2.2.0 and later.

Therefore the deployed interface is:

- native slash commands registered by the server plugin (`/router-status`, `/router-explain`, `/router-report`, `/router-mode`, `/router-approve`, `/router-auto`, `/router-pin`, `/router-exclude`, `/router-pause`, `/router-resume`, `/router-dry-run`, `/router-premium-budget`, `/router-reserve`, `/router-reset-metrics`);
- a typed RPC surface at `rpc.smart-router.*`, suitable for a future official GUI part.

The router engine does not depend on any panel being open. A side panel was not claimed or faked. On OpenCode 2.2.0 or later, the same RPC surface can back a native settings page or side panel without changing routing core.

## 2. Command Code billing endpoints

Command Code exposes no stable public usage API in its documented Provider API. The plugin reads the same read-only alpha routes the official CLI uses:

```text
/alpha/whoami?limits=1
/alpha/billing/credits
/alpha/billing/subscriptions
/alpha/usage/summary
```

These are **undocumented and unstable**. They can change without notice. The adapter:

- uses only `GET`;
- never discovers or calls mutation endpoints;
- validates numeric and timestamp shapes;
- preserves `orgId` when the account belongs to an organization;
- limits polling to a conservative interval with exponential backoff;
- keeps the last good snapshot marked `stale` on failure;
- falls back to a clearly labeled local ledger estimate;
- never reports missing data as unlimited usage.

The provider API key that OpenCode uses for inference is **not authorized** for these billing routes. The adapter discovers the CLI-compatible key instead. In this installation the working source is:

```text
~/.config/opencode/commandcode.key
```

The key is read only from owner-only files, is never logged or persisted by the plugin, and is sent only to `https://api.commandcode.ai`.

Provider-reported values are account-level: remaining included credits, purchased/free extras, five-hour and weekly used/cap/reset, plan, and billing-period spend. There is no per-model provider breakdown. Per-model usage and remaining model allowance are local estimates from observed step costs.

## 3. OpenCode Go usage endpoint

The Go meter endpoint is a read-only, best-effort integration:

```text
GET https://opencode.ai/zen/go/v1/usage
```

It is queried with OpenCode's existing OAuth access token from the `opencode` connection. It returns percentages and reset times, not dollar balances. It is not part of the public inference schema and may change. On failure, the router uses the local ledger and labels the source `estimate` or `unknown`.

## 4. Prompt rejection is untyped

The V2 prompt admission hook can mutate a prompt but exposes no typed rejection operation. The router blocks admission by throwing `RouterBlockedError` from the prompt hook. On the installed 2.1.4 server this was verified to reject the prompt with HTTP 500 and no provider request; the session title changes to `BLOCKED` and the reason is recorded in the decision.

This is safe but not polished: the HTTP error is generic, so the title and notification are the user-facing explanation. `routing.failClosed` defaults to true. Manual selections and paused routing are outside the strict block.

A routing exception must also block. The earlier catch-and-continue path was a fail-open defect and is being removed.

## 5. Manual CLI selection at session creation

Manual model changes made while the plugin is active are detected through `session.model.selected` and respected. A model passed only at CLI session creation, before the plugin has seen a prompt, is indistinguishable from the session default. The first prompt may therefore be routed normally. Selecting a model in the desktop picker after the session exists is detected.

## 6. Subagents

Child sessions are routed independently. Premium is never propagated from a parent task into a child session; premium mode is capped at balanced for child sessions and one-shot approvals are not inherited. This prevents a premium task from multiplying premium usage through subagent calls. A child can still use a standard model appropriate to its own prompt.

## 7. Billing caps

Client-side quota estimates are not a mathematically guaranteed billing cap. Provider-side enforcement remains authoritative. The router:

- never purchases credits;
- never enables top-ups;
- never changes billing settings;
- blocks automatic routing when provider-reported windows are at the configured reserve;
- blocks when purchased credits would be consumed unless `allowExtraUsage` is explicitly enabled;
- cannot guarantee that an undocumented provider endpoint or a provider-side fallback will never charge an extra balance.

If Command Code's billing routes fail and the local ledger is incomplete, the router labels the data estimated and fails conservatively rather than assuming capacity.

## 8. Cache and context accounting

Prompt caches are provider- and model-specific. A model switch is priced as a cache loss in the router's estimate. The router keeps the current model when the estimated savings are below the hysteresis threshold, and uses a wider threshold above 300K context tokens. It never truncates, summarizes, or deletes conversation history to make a model eligible.

Context-health recommendations are non-destructive. The router never compacts or replaces a conversation automatically.

## 9. Precision of scores

The intelligence floor and design thresholds are planning inputs, not guarantees. Intelligence values come from published model cards where available; design scores are curated and explicitly separate. Models without credible scores are not approved for automatic substantive work. The router does not invent benchmark results.

## 10. What was not done

- No separate dashboard or daemon was installed.
- No third-party classification service receives prompts, code, or screenshots.
- No provider billing settings, credentials, or model connections were changed.
- No project configuration outside the router's optional project override was modified.
