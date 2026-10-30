#!/usr/bin/env bash
# Verify the repository builds and tests with no access to the developer's
# config, credentials, or installed plugin.
#
# Every "all green" claim about this project was historically the author's own
# run on a machine that has a real `~/.config/opencode/smart-router.json`, live
# provider credentials, and an installed plugin. A suite can pass on such a
# machine while failing or silently skipping everywhere else. This script
# removes that doubt by testing a pristine export of HEAD with an empty HOME.
#
# Usage:  scripts/cleanroom-verify.sh
# Exit:   0 when typecheck, tests, and both builds succeed in the clean room.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLEAN="$(mktemp -d "${TMPDIR:-/tmp}/router-cleanroom-XXXXXX")"
FAKE_HOME="$CLEAN/home"

cleanup() {
  # The clean room is scratch copy that this script created in full.
  rm -rf "$CLEAN"
}
trap cleanup EXIT

echo "source:     $ROOT"
echo "clean room: $CLEAN"

# Export exactly what is committed. Nothing untracked or ignored can leak in,
# so a passing run cannot depend on a local build artifact.
git -C "$ROOT" archive HEAD | tar -x -C "$CLEAN"

if [ -e "$CLEAN/node_modules" ] || [ -e "$CLEAN/dist" ]; then
  echo "FAIL: clean room contains build artifacts; the export is not pristine" >&2
  exit 1
fi

mkdir -p "$FAKE_HOME"
export HOME="$FAKE_HOME"
unset COMMAND_CODE_API_KEY COMMANDCODE_API_KEY OPENDESIGN_API_KEY OPEN_DESIGN_API_KEY 2>/dev/null || true
unset SMART_ROUTER_ALLOW_KEY_DISCOVERY 2>/dev/null || true

emit_secret_files() {
  # Report whether any credential file exists for this HOME. An empty HOME is
  # the point, so this should always be zero.
  find "$FAKE_HOME" -maxdepth 4 -name '*.key' -o -maxdepth 4 -name 'auth.json' 2>/dev/null | wc -l | tr -d ' '
}

echo "credential files visible in clean HOME: $(emit_secret_files)"

cd "$CLEAN"

echo
echo "== npm ci =="
npm ci --silent

echo
echo "== tsc --noEmit =="
npx tsc --noEmit

echo
echo "== vitest run =="
npx vitest run

echo
echo "== build:server =="
npm run build:server >/dev/null

echo
echo "== build:allowance =="
npm run build:allowance >/dev/null

# The portable core must not gain a dependency on anything outside itself.
if grep -qE 'from "[^.]' dist/allowance.js; then
  echo "FAIL: the allowance bundle imports an external module" >&2
  grep -nE 'from "[^.]' dist/allowance.js >&2
  exit 1
fi

echo
echo "clean-room verification passed: typecheck, tests, and both builds."
