# Install, verify, and remove

## Current installation

```text
Plugin source:  ~/Documents/opencode-smart-router
Installed at:   ~/.config/opencode/plugins/opencode-smart-router
Config entry:   ~/.config/opencode/opencode.json → plugins[]
Config backup:  ~/.config/opencode/opencode.json.bak-smart-router-20261027-150549
```

The plugin is loaded by the running desktop server and is reported as active in `/api/plugin`.

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

The plugin fails closed. If it is paused, disabled, or has no qualified route, it leaves the current model unchanged.

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
