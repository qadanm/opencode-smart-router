#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
CONFIG="$CONFIG_DIR/opencode.json"
INSTALL="$CONFIG_DIR/plugins/opencode-smart-router"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$CONFIG" ]]; then
  echo "OpenCode config not found at $CONFIG" >&2
  exit 1
fi

echo "Checking the plugin source..."
(cd "$ROOT" && npm run typecheck && npm test)

echo "Backing up $CONFIG"
cp "$CONFIG" "$CONFIG.bak-smart-router-$STAMP"

echo "Installing to $INSTALL"
rm -rf "$INSTALL"
mkdir -p "$INSTALL"
cp -R "$ROOT/src" "$INSTALL/"
printf 'export { default } from "./src/index.ts"\n' > "$INSTALL/index.ts"

echo "Adding the plugin entry to the global config"
cd "$CONFIG_DIR"
jq --arg p "$INSTALL" '.plugins = ((.plugins // []) + [$p] | unique)' \
  "$CONFIG" > "$CONFIG.tmp"
jq empty "$CONFIG.tmp"
mv "$CONFIG.tmp" "$CONFIG"
chmod 600 "$CONFIG"

echo
echo "Installed."
echo "Backup:  $CONFIG.bak-smart-router-$STAMP"
echo "Reload OpenCode or restart the desktop app, then run /router-status."
echo "To remove it, run $ROOT/scripts/uninstall.sh"
