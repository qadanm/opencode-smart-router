# Stage B preflight — initial auth blocker (historical)

> **Superseded:** OpenCode Console OAuth was connected and Go quota retrieval succeeded after an isolated restart. See [STAGE-B-REPORT-2026-10-28.md](STAGE-B-REPORT-2026-10-28.md).

**Date:** 2026-10-28
**Artifact:** `e65326c9bc7b36a4470bab2d631253d233e918fc76b4b93d5cf1bab8020a5fa4`
**Isolated server:** `127.0.0.1:4220`, separate HOME/XDG, disposable project
**Inference requests made:** **0**
**Live environment:** untouched

## Passed

- Artifact hash verified.
- Isolated server started; plugin active; **16 commands**; one core, one bridge, one event stream; zero errors.
- Model catalog shows:
  - `commandcode`: 72 models
  - `opencode-go`: 30 models
  - `opencode`: 9 models
- Command Code quota retrieval is live and provider-reported:
  - five-hour: **6.27%** used ($0.8777 / $14)
  - weekly: **78.61%** used ($27.5150 / $35)
  - monthly: **39.66%** used ($27.9248 / $70.4098)
  - remaining monthly: **$42.485**
  - purchased credits: **$0**
  - free credits: **$0**
  - plan: GOAT, status active
- Policy:
  - `allowExtraUsage:false` for both providers
  - premium `ask`, budget 0, one-shot approval false
  - fail-closed true
- Premium spend: 0.

## Blocked

OpenCode Go **inference** authentication is present (30 models), but the router’s Go quota adapter reports:

```text
No OpenCode Go access token is available
```

The adapter reads the `opencode` **integration connection** via `ctx.integration.connection.active("opencode")` and resolves an OAuth/key credential. The isolated login was performed by selecting **OpenCode Go** and entering an API key; `opencode auth list --standalone` shows only:

```text
OpenCode Go  OpenCode Go  stored
```

It does not show the **OpenCode Console** integration that the live environment has (`OpenCode Console Personal stored`). Without that integration, the Go Plus quota endpoint cannot be authenticated through the plugin.

## Required action

In the isolated environment, connect the **OpenCode Console** integration rather than the OpenCode Go API-key provider. Use `--standalone` so the live background service on port 49374 is not touched:

```bash
ROOT="$HOME/Documents/opencode-router-stage-b"

HOME="$ROOT/home" \
XDG_CONFIG_HOME="$ROOT/home/.config" \
XDG_DATA_HOME="$ROOT/data" \
XDG_CACHE_HOME="$ROOT/cache" \
opencode auth login --standalone opencode
```

If the target name is rejected, run the interactive command and choose **OpenCode Console**:

```bash
HOME="$ROOT/home" XDG_CONFIG_HOME="$ROOT/home/.config" \
XDG_DATA_HOME="$ROOT/data" XDG_CACHE_HOME="$ROOT/cache" \
opencode auth login --standalone
```

After completing it, verify only the names:

```bash
HOME="$ROOT/home" XDG_CONFIG_HOME="$ROOT/home/.config" \
XDG_DATA_HOME="$ROOT/data" XDG_CACHE_HOME="$ROOT/cache" \
opencode auth list --standalone
```

Expected: an `OpenCode Console` (Personal) entry. Then reply **“authenticated”**. No inference request will be made until Go quota retrieval succeeds and purchased-credit/premium checks are repeated.

## Why no request was sent

A Go request without quota retrieval would violate Stage B's read-only quota requirement and could spend allowance without a before/after baseline. Command Code is safe on the quota/purchased-credit side, but the stage is held until both providers are observable. Do not exhaust quotas to test fallback; quota-exhaustion behavior remains simulated locally.
