#!/usr/bin/env bash
#
# OpenCode Smart Router — uninstaller.
#
# Removes the router from OpenCode and leaves everything else alone. Conversations,
# credentials, provider connections and project files are never touched.
#
#   ./scripts/uninstall.sh                  remove the plugin and its config entry
#   ./scripts/uninstall.sh --keep-files     drop the config entry, keep the plugin files
#   ./scripts/uninstall.sh --restore-backup <path>   also restore a config backup
#   ./scripts/uninstall.sh --dry-run        show what would happen
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
CONFIG="$CONFIG_DIR/opencode.json"
# Uninstall removes the whole plugin directory, versioned installs included.
# A newer installer puts each version underneath this path, so removing the
# parent is what actually clears it.
INSTALL="$CONFIG_DIR/plugins/opencode-smart-router"
STAMP="$(date +%Y%m%d-%H%M%S)"

KEEP_FILES=false
RESTORE=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-files) KEEP_FILES=true; shift ;;
    --restore-backup) RESTORE="${2:?--restore-backup needs a path}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --config-dir) CONFIG_DIR="${2:?}"; CONFIG="$CONFIG_DIR/opencode.json"; INSTALL="$CONFIG_DIR/plugins/opencode-smart-router"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

run() { if $DRY_RUN; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

[[ -f "$CONFIG" ]] || { echo "OpenCode config not found at $CONFIG" >&2; exit 1; }

run cp "$CONFIG" "$CONFIG.bak-smart-router-uninstall-$STAMP"
echo "  config backup: $CONFIG.bak-smart-router-uninstall-$STAMP"

# Drop every entry that points at this install, without jq.
if ! $DRY_RUN; then
  node -e '
    const fs=require("fs");
    const [file,entry]=process.argv.slice(1);
    let cfg={};
    try{ cfg=JSON.parse(fs.readFileSync(file,"utf8")); }catch(e){
      console.error("  x config is not valid JSON: "+e.message); process.exit(1);
    }
    const before=(cfg.plugins||[]).length;
    cfg.plugins=(cfg.plugins||[]).filter(p=>p!==entry);
    fs.writeFileSync(file,JSON.stringify(cfg,null,2)+"\n");
    fs.chmodSync(file,0o600);
    console.log("  removed "+(before-cfg.plugins.length)+" entry/entries; "+cfg.plugins.length+" plugin(s) remain");
  ' "$CONFIG" "$INSTALL"
fi

if ! $KEEP_FILES; then
  run rm -rf "$INSTALL"
  echo "  removed $INSTALL"
else
  echo "  kept $INSTALL (--keep-files)"
fi

if [[ -n "$RESTORE" ]]; then
  [[ -f "$RESTORE" ]] || { echo "Backup not found: $RESTORE" >&2; exit 1; }
  run cp "$RESTORE" "$CONFIG"
  run chmod 600 "$CONFIG"
  echo "  restored config from $RESTORE"
fi

if $DRY_RUN; then
  echo "  [dry-run] nothing changed"
  exit 0
fi

echo
echo "Uninstalled. Restart OpenCode to unload it."
if [[ -z "$RESTORE" ]]; then
  echo "To restore the exact pre-removal config:"
  echo "  $0 --restore-backup $CONFIG.bak-smart-router-uninstall-$STAMP"
fi
