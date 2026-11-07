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
INSTALL_ROOT="$CONFIG_DIR/plugins/opencode-smart-router"
INSTALL="$INSTALL_ROOT"   # resolved to a versioned directory at install time
STAMP="$(date +%Y%m%d-%H%M%S)"

DRY_RUN=false
ASSUME_YES=false
VERIFY=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    --no-verify) VERIFY=false; shift ;;
    --config-dir) CONFIG_DIR="${2:?--config-dir needs a path}"; CONFIG="$CONFIG_DIR/opencode.json"; INSTALL_ROOT="$CONFIG_DIR/plugins/opencode-smart-router"; INSTALL="$INSTALL_ROOT"; shift 2 ;;
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

# The desktop GUI is a separate CommonJS bundle. It is optional: a terminal-only
# machine has no use for it, and vite is a devDependency that a `--omit=dev`
# install will not have. Build it only when the tool is present, and never fail
# the install because the GUI could not be built.
GUI_BUNDLE=""
if ! $DRY_RUN; then
  if [[ -x "$ROOT/node_modules/.bin/vite" ]]; then
    if run npm --prefix "$ROOT" run build:gui >/dev/null 2>&1; then
      GUI_BUNDLE="$ROOT/dist/gui-experimental.cjs"
      say "  dist/gui-experimental.cjs  $(wc -c < "$GUI_BUNDLE" | tr -d ' ') bytes"
    else
      warn "the desktop GUI failed to build; the router still works without it"
    fi
  else
    warn "vite not installed — skipping the desktop GUI (npm install to include it)"
  fi
fi

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

# INSTALL TO A FRESH PATH, THEN REPOINT THE CONFIG.
#
# Earlier versions replaced files INSIDE the plugin directory. First with `rm -rf`,
# then with an atomic `mv` over the old file. Both were wrong, and the log proves it:
# an atomic rename still fires the directory watcher, because the watcher sees a
# change in the directory it is watching. On 2026-11-03 a rename-based install
# produced a ModelUnavailableError 0.4s later, exactly like the `rm -rf` version.
#
# The only way not to disturb a running server is to not touch the directory it is
# watching. So each install lands in its own versioned directory, and the config
# pointer is what changes. A running server keeps its already-loaded module; the new
# path takes effect on the next start.
#
# The pointer is written to a temp file and renamed, which is atomic for the config
# file. OpenCode watches the plugins DIRECTORY, not the config, so that rename does
# not invalidate a loaded plugin module.
STAMP_DIR="$(date +%Y%m%d-%H%M%S)"
TARGET="$INSTALL_ROOT/$STAMP_DIR"

run mkdir -p "$TARGET"
run cp "$ROOT/dist/index.js" "$TARGET/index.js"
run cp "$ROOT/config.example.json" "$TARGET/config.example.json"

# The desktop app loads a GUI entry from the plugin directory. Without a
# package.json it looks for exactly `gui-experimental.cjs` at the root, so the
# filename here is part of the contract, not a convention.
if [[ -n "$GUI_BUNDLE" && -f "$GUI_BUNDLE" ]]; then
  run cp "$GUI_BUNDLE" "$TARGET/gui-experimental.cjs"
  say "  desktop GUI: installed"
fi

# The terminal part. Optional for the same reason as the GUI: a headless server
# has no terminal to draw in, and a failed TUI build must not fail the install.
if ! $DRY_RUN; then
  if [[ -x "$ROOT/node_modules/.bin/esbuild" ]] && npm --prefix "$ROOT" run build:tui >/dev/null 2>&1; then
    run cp "$ROOT/dist/tui.js" "$TARGET/tui.js"
    say "  terminal UI: installed"
  else
    warn "terminal UI not built; the desktop panel and slash commands still work"
  fi
fi

# The router resolves @opencode/plugin at runtime, so the host's copy must be reachable
# from the plugin directory. A symlink to the repo's node_modules keeps the install
# small and lets OpenCode resolve it the same way it resolves any other plugin dep.
if ! $DRY_RUN; then
  ln -s "$ROOT/node_modules" "$TARGET/node_modules"
fi

# Point the config at the new version. `INSTALL` is what gets written into
# cfg.plugins, so the running server is never asked to reload the old path.
INSTALL="$TARGET"
say "  installed: $INSTALL/index.js"

# Record what was installed, so a later `--rollback` or audit can tell versions apart.
if ! $DRY_RUN; then
  node -e '
    const fs=require("fs"),cp=require("child_process"),crypto=require("crypto");
    const dir=process.argv[1], root=process.argv[2], sha=process.argv[3];
    const git=(args)=>cp.execSync("git "+args,{cwd:root}).toString().trim();
    const commit=git("rev-parse HEAD");
    // A clean hash is not enough to reproduce a build. Three installs were
    // attributed to the wrong commit because the tree had uncommitted changes
    // when the artifact was built. Record that, and hash the diff itself, so a
    // "which code is running" question has an answer that cannot be stale.
    let dirty=false, treeDigest=null, changedFiles=0;
    try {
      const status=git("status --porcelain --untracked-files=no");
      changedFiles=status?status.split("\n").filter(Boolean).length:0;
      dirty=changedFiles>0;
      if (dirty) {
        const diff=cp.execSync("git diff HEAD",{cwd:root,maxBuffer:64*1024*1024});
        treeDigest=crypto.createHash("sha256").update(diff).digest("hex");
      }
    } catch(e) { dirty=null; }
    const guiPath=dir+"/gui-experimental.cjs";
    const guiSha=fs.existsSync(guiPath)
      ? crypto.createHash("sha256").update(fs.readFileSync(guiPath)).digest("hex") : null;
    let version=null;
    try { version=JSON.parse(fs.readFileSync(root+"/package.json","utf8")).version; } catch(e) {}
    fs.writeFileSync(dir+"/DEPLOYMENT.json", JSON.stringify({
      deployedAt:new Date().toISOString(),
      artifactSha256:sha,
      codeCommit:commit,
      // null means the tree state could not be determined (not a git checkout).
      dirty,
      dirtyDiffSha256:treeDigest,
      changedFiles,
      packageVersion:version,
      guiSha256:guiSha,
      installedBy:"scripts/install.sh"
    },null,2)+"\n");
    if (dirty) console.log("  ! built from a DIRTY tree ("+changedFiles+" modified file(s)) — recorded in DEPLOYMENT.json");
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
    // Drop EVERY entry under the install root, not just an exact match on the
    // new path. A versioned install leaves the previous path (and any legacy
    // non-versioned path) behind, and two entries would load the plugin twice.
    const root=process.argv[3];
    const under=(p)=>typeof p==="string" && (p===root || p.startsWith(root+"/"));
    cfg.plugins=[...list.filter(p=>!under(p)),entry];
    fs.writeFileSync(file,JSON.stringify(cfg,null,2)+"\n");
    fs.chmodSync(file,0o600);
    console.log("  config now lists "+cfg.plugins.length+" plugin(s)");
  ' "$CONFIG" "$INSTALL" "$INSTALL_ROOT"
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

  # Prune old version directories, keeping the one just installed and the one
  # before it.
  #
  # Each install lands in its own stamped directory so a running server keeps the
  # module it already loaded. That is the right design, but nothing ever removed
  # the old ones: a fresh install per update left 540K behind every time, forever.
  # Verified on a clean HOME, where two consecutive installs left both directories
  # and only one was referenced by the config.
  #
  # Keeping the previous version matters because it is the manual rollback path:
  # the config is a list of paths, so pointing it back at the prior directory is
  # how a bad update is undone without a rebuild. Anything older has no reader.
  #
  # Failures here are warnings, never errors. A stale directory is litter; it is
  # not a reason to report a working install as failed.
  if ! $DRY_RUN && [ -d "$INSTALL_ROOT" ]; then
    current="$(basename "$INSTALL")"
    # Newest first. The names are YYYYMMDD-HHMMSS, so a plain sort is
    # chronological. The grep drops anything this script did not create, so an
    # unexpected entry is left alone rather than removed.
    #
    # Parsed with a while-read loop instead of `mapfile`, because macOS ships
    # bash 3.2 and `mapfile` does not exist there. The installer has to run on a
    # stock machine, which is the whole point of it.
    versions="$(ls -1 "$INSTALL_ROOT" 2>/dev/null | grep -E '^[0-9]{8}-[0-9]{6}$' | sort -r)"
    pruned=0
    index=0
    while IFS= read -r name; do
      [ -z "$name" ] && continue
      index=$((index + 1))
      # Keep the first two: the current install and the rollback target.
      [ "$index" -le 2 ] && continue
      [ "$name" = "$current" ] && continue
      rm -rf "${INSTALL_ROOT:?}/$name" 2>/dev/null && pruned=$((pruned + 1))
    done <<< "$versions"
    if [ "$pruned" -gt 0 ]; then
      say "  pruned $pruned older install(s); kept the current and previous version"
    fi
  fi
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
