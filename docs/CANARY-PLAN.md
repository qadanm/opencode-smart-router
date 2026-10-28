# Controlled canary plan — DO NOT EXECUTE YET

> **Accounting follow-up (2026-10-28):** Stage B's 38.5× comparison was invalidated by concurrent live-desktop usage. A separate monthly-accounting defect was fixed, documented peak pricing was added, and design fallback is now explicit. The exact new artifact is `8c71c46c…` (commit `e8fa5ac`, 106 tests) and passed a fresh 30-minute mock-only soak with zero plugin errors. See [ACCOUNTING-INVESTIGATION-2026-10-28.md](ACCOUNTING-INVESTIGATION-2026-10-28.md) and [RELEASE-READINESS-2026-10-28.md](RELEASE-READINESS-2026-10-28.md).
>
> **Stage A result (2026-10-28): PASS on the prior artifact `e65326c9…` (commit `6099a3d`).** The full 30-minute soak and Stage A matrix passed. **Stage B limited verification is also complete** with 2 Go and 2 Command Code requests. No broader deployment is authorized.

**Status:** prepared only; nothing in this document has been run against the live environment.
**Artifact:** `dist-release/index.js`
**SHA-256:** `8c71c46c5f7616f950c6a3fcf5c42be2198407848cf9ffac15d01504496f8920`
**Code commit:** `e8fa5ac`

> **Do not install `f2e76af0fc6c889e5693308309128067d99f551b272538492836049a5e4dbe74`.** That build failed Stage A (command inference and sticky `BLOCKED` title). It is retained only as the historical failure artifact.

## Why a separate server, not the desktop app

The installed host does not support a full single-project canary inside the desktop app:

- A **project-scoped** plugin entry loads only for that project and leaves other projects unrouted, but the plugin’s **commands and RPC are unavailable**. `/router-status` was sent to the model in the lab.
- A **global** entry loads the plugin for every active location. That is not a single-project canary.

The safe canary is a **separate OpenCode server process** with isolated state and a disposable project copy. It cannot touch the desktop server, its sessions, its credentials, or the live project.

## Scope

| Item | Value |
|---|---|
| Canary process | One `opencode serve` process on port 4220 |
| State | Isolated `HOME`, config, data, cache under `~/Documents/opencode-router-canary` |
| Project | A disposable copy at `~/Documents/opencode-router-canary-project` |
| Plugin | One instance, one bridge |
| Providers | Stage A: local mock (no credits). Stage B: real providers only with separate approval |
| Duration | 24–48 hours |
| Desktop impact | None: no config edit, no restart, no shared sessions/data |

## Stage A — no-credit lifecycle canary (recommended first)

This validates the plugin lifecycle, commands, title, fail-closed, and rollback. It does **not** validate real provider quotas or real spend.

### A1. Create the disposable project copy

```bash
CANARY_ROOT="$HOME/Documents/opencode-router-canary"
CANARY_PROJECT="$HOME/Documents/opencode-router-canary-project"

# Choose a small project. Never point this at the live working copy.
SOURCE_PROJECT="/path/to/a/small/project"

rm -rf "$CANARY_ROOT" "$CANARY_PROJECT"
mkdir -p "$CANARY_ROOT/home/.config/opencode" "$CANARY_ROOT/data" "$CANARY_ROOT/cache" "$CANARY_ROOT/plugin"
rsync -a --exclude '.git' --exclude 'node_modules' --exclude '.next' "$SOURCE_PROJECT/" "$CANARY_PROJECT/"
```

### A2. Install the exact artifact into the isolated root

```bash
cp ~/Documents/opencode-smart-router/dist-release/index.js "$CANARY_ROOT/plugin/index.js"
shasum -a 256 "$CANARY_ROOT/plugin/index.js"
# Must equal 8c71c46c5f7616f950c6a3fcf5c42be2198407848cf9ffac15d01504496f8920
```

### A3. Isolated config

`$CANARY_ROOT/home/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/Users/REPLACE_ME/Documents/opencode-router-canary/plugin"],
  "model": "lab-cc/claude-haiku-5-5",
  "providers": {
    "lab-cc": {
      "name": "Canary Mock",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:4200/cc/v1", "apiKey": "canary" },
      "models": {
        "claude-haiku-5-5": {
          "name": "Canary Haiku",
          "limit": { "context": 1000000, "output": 128000 },
          "capabilities": { "tools": true, "input": ["text", "image"], "output": ["text"] },
          "cost": [{ "input": 0.1, "output": 0.5, "cache": { "read": 0.01, "write": 0.125 } }]
        },
        "deepseek-v4.1-flash": {
          "name": "Canary DeepSeek",
          "limit": { "context": 1000000, "output": 384000 },
          "capabilities": { "tools": true, "input": ["text", "image"], "output": ["text"] },
          "cost": [{ "input": 0.15, "output": 0.6, "cache": { "read": 0.003, "write": 0 } }]
        }
      }
    }
  }
}
```

`$CANARY_ROOT/home/.config/opencode/smart-router.json`:

```json
{
  "providers": {
    "opencode-go": { "enabled": false, "probeUsage": false },
    "commandcode": { "enabled": false, "probeUsage": false },
    "lab-cc": {
      "enabled": true,
      "probeUsage": false,
      "reserveMonthlyPct": 0,
      "reserveWeeklyPct": 0,
      "reserveFiveHourPct": 0
    }
  },
  "quota": {
    "probeOpenCodeGo": false,
    "probeCommandCode": false,
    "bootstrapSessions": 20,
    "bootstrapDays": 31
  },
  "routing": { "failClosed": true },
  "ui": { "notifications": false, "titleIndicator": true },
  "premium": { "mode": "ask", "monthlyBudgetUsd": 0, "oneShotApproval": true },
  "models": {
    "definitions": [
      {
        "key": "lab-cc/claude-haiku-5-5",
        "providerID": "lab-cc",
        "modelID": "claude-haiku-5-5",
        "name": "Canary Haiku",
        "context": 1000000,
        "maxOutput": 128000,
        "input": ["text", "image"],
        "cost": [{ "input": 0.1, "output": 0.5, "cache": { "read": 0.01, "write": 0.125 } }],
        "intelligence": 43.4,
        "design": 70,
        "tier": 2,
        "approved": true,
        "monthlyAllowanceUsd": 1000
      },
      {
        "key": "lab-cc/deepseek-v4.1-flash",
        "providerID": "lab-cc",
        "modelID": "deepseek-v4.1-flash",
        "name": "Canary DeepSeek",
        "context": 1000000,
        "maxOutput": 384000,
        "input": ["text", "image"],
        "cost": [{ "input": 0.15, "output": 0.6, "cache": { "read": 0.003, "write": 0 } }],
        "intelligence": 39.5,
        "design": 65,
        "tier": 2,
        "approved": true,
        "monthlyAllowanceUsd": 1000
      }
    ]
  }
}
```

### A4. Start the mock and the isolated server

```bash
# Terminal 1: local mock only, no real provider traffic
node /path/to/mock-provider.mjs

# Terminal 2: isolated server, one project
cd "$CANARY_PROJECT"
HOME="$CANARY_ROOT/home" \
XDG_CONFIG_HOME="$CANARY_ROOT/home/.config" \
XDG_DATA_HOME="$CANARY_ROOT/data" \
XDG_CACHE_HOME="$CANARY_ROOT/cache" \
opencode serve --port 4220 --print-logs > "$CANARY_ROOT/server.log" 2>&1 &
```

Capture the password from `$CANARY_ROOT/server.log` (`server password ...`). Do not use the desktop server’s password.

### A5. Verification

```bash
CANARY_ROOT="$HOME/Documents/opencode-router-canary"
CANARY_PROJECT="$HOME/Documents/opencode-router-canary-project"
PASS=$(grep -o 'server password .*' "$CANARY_ROOT/server.log" | head -1 | awk '{print $3}')
AUTH="opencode:$PASS"

curl -s -o /dev/null -w '%{http_code}\n' -u "$AUTH" http://127.0.0.1:4220/api/info
curl -s -u "$AUTH" http://127.0.0.1:4220/api/plugin | jq -c '[.data[]? | select(.id=="opencode-smart-router") | .state.status]'
curl -s -u "$AUTH" -X POST http://127.0.0.1:4220/api/rpc/smart-router/diagnostics \
  -H 'content-type: application/json' -d '{"input":{}}' |
  jq -c '.output | {coreID,pid,bridgeCount,eventStreams,errors}'
curl -s -u "$AUTH" "http://127.0.0.1:4220/api/command?location.directory=$CANARY_PROJECT" |
  jq -r '[.data[].name | select(startswith("router-"))] | length'
```

Expected: HTTP 200; plugin active; **one core, one bridge, one event stream, zero errors**; **16 router commands**.

Create one session and prompt:

```bash
SID=$(curl -s -u "$AUTH" -X POST http://127.0.0.1:4220/api/session \
  -H 'content-type: application/json' \
  -d "{\"title\":\"canary smoke\",\"location\":{\"directory\":\"$CANARY_PROJECT\"},\"model\":{\"providerID\":\"lab-cc\",\"id\":\"claude-haiku-5-5\"}}" |
  jq -r '.data.id')

curl -s -u "$AUTH" -X POST "http://127.0.0.1:4220/api/session/$SID/prompt" \
  -H 'content-type: application/json' \
  -d '{"text":"Implement a small feature in src/app.ts. Do not use any tools. Reply with exactly: ok."}'

curl -s -u "$AUTH" "http://127.0.0.1:4220/api/session/$SID" |
  jq -c '{title:.data.title,model:.data.model,outcome:.data.outcome}'
```

Expected: `AUTO · ...` title, `lab-cc` model, `succeeded`.

## Stage B — real providers (requires separate approval)

Only after Stage A is stable. This stage can spend real credits and requires real credentials.

- Use a separate isolated config/HOME. **Do not copy** `~/.local/share/opencode/auth.json`, API keys, or the desktop config.
- Authenticate inside the isolated HOME with `opencode auth login --standalone` (not the normal background-service flow), or provide dedicated canary credentials. `--standalone` avoids the live service port. Do not paste credentials into this document or the repository.
- Use the reviewed production `smart-router.json` settings (providers, approved models, floors, premium policy). If unavailable, start from `config.example.json` and `docs/MODELS.md`.
- Keep `routing.failClosed: true`, premium `ask`, and `allowExtraUsage: false`.
- Use one canary project copy. Do not point at the live project.
- Approve a spend ceiling and observation window before starting.

This stage is **not** authorized by the release report alone.

## Monitoring

Run from a separate terminal; do not modify the live server.

```bash
CANARY_ROOT="$HOME/Documents/opencode-router-canary"
PASS=$(grep -o 'server password .*' "$CANARY_ROOT/server.log" | head -1 | awk '{print $3}')
AUTH="opencode:$PASS"
PID=$(lsof -ti tcp:4220 -sTCP:LISTEN | head -1)

# Every 60 seconds for the observation window:
curl -s --max-time 5 -o /dev/null -w 'http=%{http_code}\n' -u "$AUTH" http://127.0.0.1:4220/api/info
curl -s --max-time 10 -u "$AUTH" -X POST http://127.0.0.1:4220/api/rpc/smart-router/diagnostics \
  -H 'content-type: application/json' -d '{"input":{}}' |
  jq -c '.output | {coreID,pid,bridgeCount,setups,disposes,eventStreams,errors}'
ps -o pid,rss,etime -p "$PID"
grep -c 'thrashing' "$CANARY_ROOT/server.log"
grep -c 'level=ERROR' "$CANARY_ROOT/server.log"
curl -s --max-time 10 -u "$AUTH" "http://127.0.0.1:4220/api/command?location.directory=$CANARY_PROJECT" |
  jq -r '[.data[].name | select(startswith("router-"))] | length'
```

Health thresholds:

- HTTP 200 on every check.
- One core id and one PID for the process lifetime.
- One bridge and one event stream for the one project.
- 16 router commands remain present.
- No `thrashing` warnings.
- No unexpected `level=ERROR`.
- RSS/footprint stays in the single-project range (measured: ~190 MB footprint, 278 MB peak in the lab), with no monotonic climb.
- Prompt success and title updates continue.

## Rollback

### Isolated server (proposed canary)

```bash
# Stop only the canary server and mock.
kill $(lsof -ti tcp:4220 -sTCP:LISTEN) 2>/dev/null || true
kill $(lsof -ti tcp:4200 -sTCP:LISTEN) 2>/dev/null || true

# Preserve logs if desired, then remove the disposable copy.
# rm -rf "$HOME/Documents/opencode-router-canary" "$HOME/Documents/opencode-router-canary-project"
```

No desktop process, config, session, credential, or project file is touched. This is the primary rollback.

### If a desktop project-scoped trial was ever run (not proposed here)

1. Remove the plugin entry from that project’s config.
2. Reload the location with `POST /api/location/reload`, or restart the desktop server with approval.
3. Verify 0 router commands and a successful ordinary prompt.
4. Titles may retain `AUTO`/`BLOCKED` prefixes; this is cosmetic. Rename manually if desired.

### If a desktop global entry was ever used (not proposed here)

1. Remove `opencode-smart-router` from `~/.config/opencode/opencode.json`.
2. Restart the desktop server with approval.
3. Verify ordinary prompts; conversations remain in the normal data store.
4. Titles may remain prefixed; cosmetic only.

The lab proved the config-removal path: core bridges went to 0, streams 0, ordinary prompt HTTP 200, and the conversation context grew from 12 to 15, then 18 messages after restoration. No plugin command was required.

## Isolation verification before starting

```bash
jq -c '.plugins' ~/.config/opencode/opencode.json
# Must not include opencode-smart-router.

shasum -a 256 ~/.config/opencode/opencode.json
# Record for comparison; the canary must not change it.

pgrep -fl 'OpenCode' | head
# Record the desktop PIDs; the canary must not restart or signal them.
```

After the canary, repeat the config hash and PID check. The desktop server must be untouched.

## Command output limitation (SDK-level)

The v2 SDK accepts `session.synthetic({ resume:false })`, but such a synthetic message is admitted to the session inbox and delivered only when the session next runs. There is no supported API to deliver a full command result immediately without resuming execution, and resuming would cause a model turn. The router therefore chooses **zero-token correctness** over immediate rendering: command output appears on the next turn. The existing session title is the only immediate, supported, token-free UI surface; it is already used for AUTO/MANUAL/PAUSED/DRY RUN/BLOCKED. Do not add a title hack or another listener as a substitute.

## Approval gates

1. **Approve Stage A** (isolated mock canary): no real credits, no desktop impact.
2. **Approve Stage B** separately (real providers/credentials/spend): only after Stage A passes.
3. **Desktop installation** is a separate decision. The current evidence says a desktop canary is either global (all active projects) or project-scoped (no commands/RPC); neither is a full single-project canary.

**Do not execute this plan until the relevant gate is approved.**
