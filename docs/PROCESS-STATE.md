# Process and deployment state

Recorded 2026-10-30. This file exists because the live plugin is deployed into a
process this project does not own, and a reader should know exactly what is
running, who started it, and what happens if it stops.

## The backend on port 49374

| | |
|---|---|
| PID | `75266` |
| Command | `opencode-cli serve --service` (2.2.2-arm64) |
| Parent | `1720` / `OpenCode.app`, the desktop application |
| Managed by | the desktop app, registered as `application.ai.opencode.desktop.98388890.98388896` |
| Resident memory | about 0.95 GB |
| Uptime | restarted several times during this work to load new builds |

**This process was not started by an agent session.** It is a child of the
desktop application, which owns its lifecycle. Restarting it is how a new plugin
build is loaded: the app relaunches `opencode-cli serve` after the listener
exits.

Consequences worth stating plainly:

- Killing it does not free the port; the app starts a replacement.
- Stopping it would interrupt whatever the desktop is doing, so it is not
  something an agent should do to tidy up.
- The two MCP servers under it (`agent-browser mcp`, 4 MB each) are also children
  of the app, not of any agent session.

## What is deployed

`~/.config/opencode/plugins/opencode-smart-router/index.js` is a built bundle,
not a symlink into this repository. Its SHA-256 is recorded in `artifact.sha256`
next to it, and `DEPLOYMENT.json` records the commit it came from.

At the time of writing the deployed artifact and the current `HEAD` build are
identical (`87d3ed23...`), because the commits after that build were tests and
documentation only.

## How to reload after a source change

```bash
npm run build:server
cp dist/index.js ~/.config/opencode/plugins/opencode-smart-router/index.js
shasum -a 256 dist/index.js | awk '{print $1}' > ~/.config/opencode/plugins/opencode-smart-router/artifact.sha256
kill "$(lsof -nP -iTCP:49374 -sTCP:LISTEN -t | head -1)"
```

The desktop app relaunches the backend within a few seconds.

## Rollback

`~/Documents/opencode-smart-router-backups/20261029-pro-migration/` holds the
pre-migration `smart-router.json`, the previous bundle
(`index.js.previous`, sha `ed5a6493...`), and `rollback.sh`.

## Scratch artifacts

Nothing from this work is left running. The mutation harness and clean-room
verification both create temporary trees under `$TMPDIR` and remove them, and no
mock server, dev server, or test runner outlives its command.
