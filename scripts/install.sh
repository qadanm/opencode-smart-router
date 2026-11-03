#!/usr/bin/env bash
#
# OpenCode Smart Router — one-command installer.
#
# WHAT THIS IS FOR. A person (or an LLM) who has just cloned this repo should be able to
# run ONE command and end up with a working router, without reading docs first, without
# jq, and without knowing how OpenCode loads plugins.
#
#     ./scripts/install.sh
#
# It is idempotent: running it again replaces the installed copy and leaves exactly one
# config entry. It never touches conversations, credentials or project files.
#
# WHY IT BUILDS. The live install is a BUNDLED dist/index.js, not a src/ tree. An earlier
# version of this script copied `src/` plus a TypeScript shim, which produced an install
# that could not load — `@opencode/plugin` is external to the bundle and resolved by
# OpenCode at runtime, and the .ts shim needed a transpiler OpenCode does not provide.
# So this script builds, and installs the build.
#
# REQUIREMENTS: node >= 20.12, npm, git. Nothing else. No jq.
#
# OPTIONS
#   --dry-run        Print every step, change nothing.
#   --yes            Do not prompt (for automation / LLMs).
#   --no-verify      Skip the post-install load check (not recommended).
#   --config-dir X   Override the OpenCode config directory.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
CONFIG="$CONFIG_DIR/opencode.json"
INSTALL="$CONFIG_DIR/plugins/opencode-smart-router"
STAMP="$(date +%Y%m%d-%H%M%S)"

DRY_RUN=false
ASSUME_YES=false
VERIFY=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    --no-verify) VERIFY=false; shift ;;
    --config-dir) CONFIG_DIR="${2:?--config-dir needs a path}"; CONFIG="$CONFIG_DIR/opencode.json"; INSTALL="$CONFIG_DIR/plugins/opencode-smart-router"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m  x %s\033[0m\n' "$*" >&2; exit 1; }

run() {
  if $DRY_RUN; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# ── 1. Preflight ─────────────────────────────────────────────────────────────
# Everything is checked BEFORE anything is modified, so a failed check cannot leave a
# half-installed machine.
step "1/6  Checking prerequisites"

command -v node >/dev/null || die "node not found. Install Node 20.12 or newer: https://nodejs.org"
command -v npm  >/dev/null || die "npm not found (it ships with Node)."
command -v git  >/dev/null || die "git not found."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if (( NODE_MAJOR < 20 || (NODE_MAJOR == 20 && NODE_MINOR < 12) )); then
  die "Node $(node -v) is too old. The router needs >= 20.12."
fi
say "  node $(node -v)  npm $(npm -v)"

[[ -f "$ROOT/package.json" ]] || die "package.json not found — run this from the repo."

if [[ -f "$CONFIG" ]]; then
  say "  OpenCode config: $CONFIG"
else
  # A first-time OpenCode user has no config yet. Creating one is friendlier than
  # failing, and OpenCode accepts a minimal object.
  warn "no OpenCode config at $CONFIG — one will be created"
  if ! $DRY_RUN; then
    mkdir -p "$CONFIG_DIR"
    printf '{}\n' > "$CONFIG"
  fi
fi

# ── 2. Dependencies ──────────────────────────────────────────────────────────
# A fresh clone has no node_modules, and the build needs esbuild from devDependencies.
step "2/6  Installing dependencies"
# The dependency check keys on the BUILD TOOL that is actually needed, not on the
# presence of a directory. A fresh clone has no node_modules at all; a half-installed one
# can have the directory but be missing esbuild. Checking the tool is honest about both.
if [[ -x "$ROOT/node_modules/.bin/esbuild" ]] && [[ -x "$ROOT/node_modules/.bin/tsc" ]]; then
  say "  dependencies present — skipping (delete node_modules to force a clean install)"
else
  # `npm ci` is exact and fast, but it REFUSES a lockfile that does not match
  # package.json. Fall back to `npm install` so a drift in the lockfile is repaired
  # rather than dead-ending the user.
  if ! run npm --prefix "$ROOT" ci --no-audit --no-fund; then
    warn "npm ci rejected the lockfile — falling back to npm install (it will repair it)"
    run npm --prefix "$ROOT" install --no-audit --no-fund
  fi
fi
if ! $DRY_RUN; then
  [[ -x "$ROOT/node_modules/.bin/esbuild" ]] || die "esbuild missing after install — the build cannot run"
  [[ -x "$ROOT/node_modules/.bin/tsc" ]] || die "typescript missing after install — the check cannot run"
fi

# ── 3. Verify the source ─────────────────────────────────────────────────────
# Typecheck + tests, because installing a router that cannot route is worse than
# not installing it. `--no-verify` is for emergencies only.
if $VERIFY; then
  step "3/6  Verifying the source (typecheck + tests)"
  run npm --prefix "$ROOT" run check
else
  step "3/6  Verification SKIPPED (--no-verify)"
  warn "the build may be broken; you asked to skip the check"
fi

# ── 4. Build the plugin ──────────────────────────────────────────────────────
step "4/6  Building the plugin bundle"
run npm --prefix "$ROOT" run build:server
if ! $DRY_RUN; then
  [[ -f "$ROOT/dist/index.js" ]] || die "build produced no dist/index.js"
  SHA="$(sha256sum "$ROOT/dist/index.js" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$ROOT/dist/index.js" | cut -d' ' -f1)"
  say "  dist/index.js  $(wc -c < "$ROOT/dist/index.js" | tr -d ' ') bytes  sha256 ${SHA:0:12}…"
fi

# ── 5. Install ───────────────────────────────────────────────────────────────
step "5/6  Installing into OpenCode"

# If OpenCode is RUNNING, replacing the plugin under it can break the live session.
# The files are replaced atomically (rename), which the watcher reads as a content
# change rather than a disappearance -- but a running session can still be mid-step,
# so say so plainly instead of letting it surprise the user.
if pgrep -qi "opencode" 2>/dev/null; then
  warn "OpenCode appears to be running. The plugin files are replaced atomically, but"
  warn "a session that is MID-STEP when this finishes may still fail once."
  warn "Restart OpenCode when convenient."
fi
run cp "$CONFIG" "$CONFIG.bak-smart-router-$STAMP"
say "  config backup: $CONFIG.bak-smart-router-$STAMP"

# REPLACE FILES IN PLACE. Never `rm -rf` the plugin directory while OpenCode is
# running: the server watches that directory, and deleting it out from under a live
# session invalidates the plugin module and empties the provider model list. The next
# step then dies with "Model unavailable: <provider>/<model>" even though the model is
# perfectly valid and the gateway is healthy. This was observed on 2026-11-03 during
# a live session: the plugin was replaced under a running server and four sessions
# failed that way.
#
# So: write to a temp file and move it over the old one (atomic rename), which the
# watcher sees as a content change rather than a disappearance.
run mkdir -p "$INSTALL"
run cp "$ROOT/dist/index.js" "$INSTALL/index.js.next"
run mv "$INSTALL/index.js.next" "$INSTALL/index.js"
run cp "$ROOT/config.example.json" "$INSTALL/config.example.json.next"
run mv "$INSTALL/config.example.json.next" "$INSTALL/config.example.json"

# The router resolves @opencode/plugin at runtime, so the host's copy must be reachable
# from the plugin directory. A symlink to the repo's node_modules keeps the install
# small and lets OpenCode resolve it the same way it resolves any other plugin dep.
if ! $DRY_RUN; then
  # Replace the link atomically too. `ln -sfn` on an existing symlink to a DIRECTORY
  # follows it and creates the link INSIDE the target, so the old one is never
  # replaced. Point the link at a temp name and rename it over the top.
  rm -f "$INSTALL/node_modules.next"
  ln -s "$ROOT/node_modules" "$INSTALL/node_modules.next"
  mv -f "$INSTALL/node_modules.next" "$INSTALL/node_modules"
fi
say "  installed: $INSTALL/index.js"

# Record what was installed, so a later `--rollback` or audit can tell versions apart.
if ! $DRY_RUN; then
  node -e '
    const fs=require("fs"),cp=require("child_process");
    const dir=process.argv[1], root=process.argv[2], sha=process.argv[3];
    const commit=cp.execSync("git rev-parse HEAD",{cwd:root}).toString().trim();
    fs.writeFileSync(dir+"/DEPLOYMENT.json", JSON.stringify({
      deployedAt:new Date().toISOString(), artifactSha256:sha, codeCommit:commit,
      installedBy:"scripts/install.sh"
    },null,2)+"\n");
  ' "$INSTALL" "$ROOT" "${SHA:-unknown}"
fi

# Config edit WITHOUT jq: parse and rewrite with node so this works on a machine that
# has never installed a JSON tool. Always leaves exactly one entry, never duplicates.
if ! $DRY_RUN; then
  node -e '
    const fs=require("fs");
    const [file,entry]=process.argv.slice(1);
    let cfg={};
    try{ cfg=JSON.parse(fs.readFileSync(file,"utf8")); }catch(e){
      console.error("  x existing config is not valid JSON: "+e.message); process.exit(1);
    }
    const list=Array.isArray(cfg.plugins)?cfg.plugins:[];
    cfg.plugins=[...list.filter(p=>p!==entry),entry];
    fs.writeFileSync(file,JSON.stringify(cfg,null,2)+"\n");
    fs.chmodSync(file,0o600);
    console.log("  config now lists "+cfg.plugins.length+" plugin(s)");
  ' "$CONFIG" "$INSTALL"
fi

# ── 6. Verify it loads ───────────────────────────────────────────────────────
step "6/6  Verifying the install"
if $DRY_RUN; then
  say "  [dry-run] would verify the bundle loads"
elif $VERIFY; then
  node --input-type=module -e "
    const mod = await import('$INSTALL/index.js');
    if (!mod || !mod.default) { console.error('  x the bundle did not export a plugin'); process.exit(1); }
    console.log('  bundle loads and exports a plugin');
  " || die "the installed bundle failed to load — run ./scripts/uninstall.sh to roll back"
else
  warn "load check skipped"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
if $DRY_RUN; then
  step "Dry run complete — nothing was changed"
  exit 0
fi

step "Installed"
cat <<EOF

  Next steps:
    1. Restart OpenCode (or reload the desktop app) so it picks up the plugin.
    2. Run  /router-status   to see the active plan and remaining allowance.
    3. Run  /router-why      on any prompt to see which model it chose and why.

  Remove it any time:
    $ROOT/scripts/uninstall.sh

  Config:   $CONFIG
  Plugin:   $INSTALL
  Backup:   $CONFIG.bak-smart-router-$STAMP
EOF
