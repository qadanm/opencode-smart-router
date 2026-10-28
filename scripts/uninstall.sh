#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
CONFIG="$CONFIG_DIR/opencode.json"
INSTALL="$CONFIG_DIR/plugins/opencode-smart-router"
STAMP="$(date +%Y%m%d-%H%M%S)"
KEEP_FILES=false
RESTORE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-files)
      KEEP_FILES=true
      shift
      ;;
    --restore-backup)
      RESTORE="${2:-}"
      if [[ -z "$RESTORE" ]]; then
        echo "--restore-backup requires a path" >&2
        exit 2
      fi
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--keep-files] [--restore-backup <path>]" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$CONFIG" ]]; then
  echo "OpenCode config not found at $CONFIG" >&2
  exit 1
fi

echo "Backing up $CONFIG"
cp "$CONFIG" "$CONFIG.bak-smart-router-uninstall-$STAMP"

echo "Removing the router entry from the global config"
cd "$CONFIG_DIR"
jq --arg p "$INSTALL" '.plugins = ((.plugins // []) - [$p])' \
  "$CONFIG" > "$CONFIG.tmp"
jq empty "$CONFIG.tmp"
mv "$CONFIG.tmp" "$CONFIG"
chmod 600 "$CONFIG"

if [[ "$KEEP_FILES" == false ]]; then
  echo "Removing $INSTALL"
  rm -rf "$INSTALL"
fi

if [[ -n "$RESTORE" ]]; then
  if [[ ! -f "$RESTORE" ]]; then
    echo "Backup not found: $RESTORE" >&2
    exit 1
  fi
  echo "Restoring $RESTORE"
  cp "$RESTORE" "$CONFIG"
  chmod 600 "$CONFIG"
fi

echo
echo "Uninstalled. Conversations, credentials, provider connections, and project files were not changed."
echo "Reload OpenCode or restart the desktop app."
if [[ "$KEEP_FILES" == true ]]; then
  echo "Plugin files kept at $INSTALL (--keep-files)."
fi
if [[ -z "$RESTORE" ]]; then
  echo "To restore the exact pre-install config, use:"
  echo "  $0 --restore-backup $CONFIG.bak-smart-router-20261027-150549"
fi
