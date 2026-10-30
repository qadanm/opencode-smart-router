# Install, verify, and remove

## Current installation

```text
Plugin source:  ~/Documents/opencode-smart-router
Artifact:      ~/Documents/opencode-smart-router/dist-release/index.js
SHA-256:       8c71c46c5f7616f950c6a3fcf5c42be2198407848cf9ffac15d01504496f8920
               Do not install f2e76af0… (failed Stage A).
Live status:    automatic routing active (promoted 2026-10-28 by explicit approval)
Live config:    d6cab84f1cd1899057486da35b1da09b63bcf7bf7983c440bb7f4ea888b7268b
Router config:  ca7476d3caa71b27948d20e91e96ce70ff6709df1e9b9c0968622009be488263
Install path:   ~/.config/opencode/plugins/opencode-smart-router
Rollback-to-dry-run: ~/Documents/opencode-smart-router-backups/20261027-225615-promotion/rollback-to-dryrun.sh
Full rollback:  ~/Documents/opencode-smart-router-backups/20261027-223912/rollback.sh
```

The live desktop has loaded the plugin with automatic routing active. Premium is off and purchased-credit use is blocked. See [DESKTOP-PROMOTION-2026-10-28.md](DESKTOP-PROMOTION-2026-10-28.md) for the promotion record and monitoring guidance; the earlier verification is in [DESKTOP-DRY-RUN-2026-10-28.md](DESKTOP-DRY-RUN-2026-10-28.md). The promotion and full rollback were tested against disposable copies of the deployed state.

## Install from this source tree

```bash
cd ~/Documents/opencode-smart-router
npm install
npm run typecheck
npm test

INSTALL="$HOME/.config/opencode/plugins/opencode-smart-router"
rm -rf "$INSTALL"
mkdir -p "$INSTALL"
cp -R src "$INSTALL/"
printf 'export { default } from "./src/index.ts"\n' > "$INSTALL/index.ts"
```

Back up the global config before changing it:

```bash
cp ~/.config/opencode/opencode.json \
   ~/.config/opencode/opencode.json.bak-smart-router-$(date +%Y%m%d-%H%M%S)
```

Add the install path to the global `plugins` array, preserving every other entry:

```bash
cd ~/.config/opencode
jq --arg p "$HOME/.config/opencode/plugins/opencode-smart-router" \
  '.plugins = ((.plugins // []) + [$p] | unique)' \
  opencode.json > opencode.json.tmp
jq empty opencode.json.tmp
mv opencode.json.tmp opencode.json
chmod 600 opencode.json
```

Reload or restart OpenCode. Verify the server sees the plugin:

```bash
opencode api GET /api/plugin | jq '[.data[] | select(.id=="opencode-smart-router")]'
```

Or use the native command `/router-status` in a session.

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
5. Send a redesign with a screenshot; it should require a vision model and record a premium approval suggestion.
6. Run `/router-approve` and repeat the redesign; a premium model may be selected once.
7. Select a model manually in the desktop picker; the next prompt must not be overridden, and `/router-status` should show `manual`.
8. Run `/router-auto` to resume.

## Configuration

No config file is required. To customize:

```bash
cp ~/Documents/opencode-smart-router/config.example.json \
   ~/.config/opencode/smart-router.json
chmod 600 ~/.config/opencode/smart-router.json
```

A project may add `.opencode/smart-router.json`. It can tighten privacy and spending policy but cannot loosen global restrictions.

## Disable without uninstalling

- `/router-pause` pauses routing globally.
- `/router-dry-run on` records decisions without switching.
- `"enabled": false` in `~/.config/opencode/smart-router.json` disables the router on the next load.
- `/router-auto` clears a per-session manual override.

The plugin fails closed. If no qualified route exists, it writes a BLOCKED title and **throws `RouterBlockedError` from the prompt hook**, so admission is rejected rather than running on an unqualified model. The installed 2.1.4 server returns a generic HTTP 500 and does not execute the prompt. If setup itself fails, a minimal fallback hook blocks prompts for that location; remove the plugin entry and restart/reload to recover. The next successful prompt clears the BLOCKED title back to AUTO.

## Uninstall

1. Remove only the router entry from the global `plugins` array:

```bash
cd ~/.config/opencode
jq --arg p "$HOME/.config/opencode/plugins/opencode-smart-router" \
  '.plugins = ((.plugins // []) - [$p])' \
  opencode.json > opencode.json.tmp
jq empty opencode.json.tmp
mv opencode.json.tmp opencode.json
chmod 600 opencode.json
```

2. Remove the installed plugin directory:

```bash
rm -rf ~/.config/opencode/plugins/opencode-smart-router
```

3. Reload or restart OpenCode.

4. Optional: restore the pre-install configuration exactly:

```bash
cp ~/.config/opencode/opencode.json.bak-smart-router-20261027-150549 \
   ~/.config/opencode/opencode.json
chmod 600 ~/.config/opencode/opencode.json
```

This does not touch conversations, provider credentials, model connections, or the Command Code key file. Router metrics remain in OpenCode's plugin storage but are inert without the plugin. `/router-reset-metrics --confirm` clears them before removal if desired.

## Update

Replace the installed `src` directory with the new build, then reload:

```bash
rm -rf ~/.config/opencode/plugins/opencode-smart-router/src
cp -R ~/Documents/opencode-smart-router/src \
      ~/.config/opencode/plugins/opencode-smart-router/
```

The server watches the local plugin files and reloads them. A full OpenCode restart is the fallback.

## Rollback

Use the config backup and remove the install directory:

```bash
cp ~/.config/opencode/opencode.json.bak-smart-router-20261027-150549 \
   ~/.config/opencode/opencode.json
rm -rf ~/.config/opencode/plugins/opencode-smart-router
```

Then reload OpenCode.
