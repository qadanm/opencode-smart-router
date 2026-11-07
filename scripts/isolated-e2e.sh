#!/usr/bin/env bash
#
# Prove that OpenCode keeps working when this plugin does not.
#
# WHAT WENT WRONG. On 2026-11-06 version 0.6.0 shipped a defect that made the
# editor refuse to send any message at all, including in manual mode. The owner
# had to remove the plugin by hand to keep working. Every test in this
# repository passed at the time, because every test called functions directly.
# Nothing ran the plugin inside a real OpenCode process.
#
# WHAT THIS SCRIPT IS. A disposable OpenCode installation in a temporary
# directory: its own HOME, its own config, its own data and cache. It never
# reads or writes the developer's real configuration, credentials, sessions or
# plugin directory, and it refuses to run if it detects that it would.
#
# WHAT IT PROVES. For each scenario, a deliberately broken plugin is installed
# and a real prompt is sent. The assertion is never "the router routed well" --
# it is that OpenCode answered. The router is an optimization; a defect in it
# must degrade to "do not route", never to "do not work".
#
# WHAT IT NEEDS. An `opencode` binary on PATH and nothing else. The model is a
# loopback stub that the script starts and stops itself: an OpenAI-compatible
# SSE endpoint on 127.0.0.1 that answers "OK". No credentials, no network, no
# spend, and no provider that can rate-limit the suite into uselessness.
#
# Usage:
#   scripts/isolated-e2e.sh              # run every scenario
#   scripts/isolated-e2e.sh --keep       # keep the sandbox for inspection
#   scripts/isolated-e2e.sh --scenario broken-load
#   E2E_MODEL=provider/model scripts/isolated-e2e.sh   # use a real model
#
# Exit: 0 when every scenario ended with OpenCode still answering a prompt.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP=0
ONLY=""
# The target defaults to a LOCAL stub provider, not a hosted model.
#
# An earlier version of this suite called a real model. That made the guarantee
# depend on a provider being reachable and in credit, and on 2026-11-06 the free
# tier ran out mid-run and every scenario reported "blocked". A test that cannot
# run is not a test. The stub is an OpenAI-compatible SSE endpoint on loopback:
# it needs no credentials, spends nothing, and cannot rate-limit.
#
# E2E_MODEL overrides it, which is useful for a manual run against a real model.
MODEL="${E2E_MODEL:-stub/stub-model}"
TIMEOUT_S="${E2E_TIMEOUT:-180}"
STUB_PORT="${E2E_STUB_PORT:-8899}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --scenario) ONLY="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --timeout) TIMEOUT_S="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Safety. The whole point of this script is that it is not allowed to touch the
# machine it runs on. A wrong sandbox path would silently test the owner's real
# setup and prove nothing, so the guards are hard failures, not warnings.
# ---------------------------------------------------------------------------
REAL_HOME="${HOME}"
if [[ -z "$REAL_HOME" || "$REAL_HOME" == "/" ]]; then
  echo "FATAL: refusing to run without a real HOME to protect" >&2
  exit 1
fi

# A missing binary must be a loud skip, never a silent pass: every assertion
# below is about OpenCode answering, so with no OpenCode there is nothing to
# assert and a green result would be false.
if ! command -v opencode >/dev/null 2>&1; then
  echo "FATAL: opencode is not on PATH; this suite tests a real OpenCode process" >&2
  echo "       install it first: curl -fsSL https://opencode.ai/install | bash" >&2
  exit 1
fi

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/router-e2e-XXXXXX")"
SANDBOX="$(cd "$SANDBOX" && pwd -P)"

case "$SANDBOX" in
  "$REAL_HOME"|"$REAL_HOME"/*)
    echo "FATAL: sandbox resolved inside the real HOME ($SANDBOX); refusing" >&2
    exit 1 ;;
esac

export HOME="$SANDBOX/home"
export XDG_CONFIG_HOME="$SANDBOX/home/.config"
export XDG_DATA_HOME="$SANDBOX/home/.local/share"
export XDG_CACHE_HOME="$SANDBOX/home/.cache"
export XDG_STATE_HOME="$SANDBOX/home/.local/state"

CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
PLUGIN_DIR="$CONFIG_DIR/plugins/e2e-router"
WORK_DIR="$SANDBOX/work"
mkdir -p "$CONFIG_DIR" "$PLUGIN_DIR" "$WORK_DIR" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

# Prove the isolation before spending a model call on it. If any of these
# resolve outside the sandbox, the run would be testing the wrong thing.
for probe in "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"; do
  case "$probe" in
    "$SANDBOX"/*) ;;
    *) echo "FATAL: $probe is outside the sandbox" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# The local model. Started only when the target is the stub, and torn down with
# the sandbox. It answers every request with "OK" over an OpenAI-compatible SSE
# stream, which is all this suite needs: the question is whether the host
# completes a turn, not whether the model is clever.
# ---------------------------------------------------------------------------
STUB_PID=""
start_stub() {
  case "$MODEL" in
    stub/*) ;;
    *) return 0 ;;
  esac
  cat > "$SANDBOX/stub.mjs" <<'JS'
import { createServer } from "node:http"
const server = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    if (req.url.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model" }] }))
      return
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    const base = {
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "stub-model",
    }
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })
    send({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    })
    res.write("data: [DONE]\n\n")
    res.end()
  })
})
server.listen(Number(process.env.E2E_STUB_PORT), "127.0.0.1")
JS
  E2E_STUB_PORT="$STUB_PORT" node "$SANDBOX/stub.mjs" > "$SANDBOX/stub.log" 2>&1 &
  STUB_PID=$!
  # Wait for the port to accept, rather than assuming startup speed.
  local waited=0
  while [[ $waited -lt 50 ]]; do
    if curl -sf --max-time 1 "http://127.0.0.1:$STUB_PORT/v1/models" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  echo "FATAL: the local stub did not start on port $STUB_PORT" >&2
  exit 1
}

cleanup() {
  if [[ -n "$STUB_PID" ]]; then
    kill "$STUB_PID" 2>/dev/null || true
    wait "$STUB_PID" 2>/dev/null || true
  fi
  if [[ "$KEEP" == "1" ]]; then
    echo ""
    echo "sandbox kept: $SANDBOX"
    return
  fi
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

PASS=0
FAIL=0
FAILED_NAMES=()
BLOCKED=0
BLOCKED_NAMES=()
LIMITS_OK=0
LIMITS_UNEXPECTED=()

say() { printf '%s\n' "$*"; }
hr() { printf '%s\n' "------------------------------------------------------------"; }

write_config() {
  # A minimal config. No credentials and no network: the model is the loopback
  # stub declared below, so a scenario can never fail because a provider is out
  # of credit or unreachable.
  local plugin_json=""
  if [[ -n "${1:-}" ]]; then
    plugin_json="$(printf '"%s"' "$1")"
  fi
  cat > "$CONFIG_DIR/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": [$plugin_json],
  "provider": {
    "stub": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "E2E Stub",
      "options": { "baseURL": "http://127.0.0.1:$STUB_PORT/v1", "apiKey": "e2e-stub-key" },
      "models": { "stub-model": { "name": "E2E Stub Model", "tool_call": true } }
    }
  }
}
EOF
}

# Run one real prompt and report whether OpenCode answered.
# The plugin is expected to misbehave; the only thing under test is the host.
run_prompt() {
  local label="$1"
  local out
  out="$(cd "$WORK_DIR" && timeout "$TIMEOUT_S" opencode --standalone run --model "$MODEL" \
        "Reply with exactly OK" 2>&1)"
  local code=$?
  local last
  last="$(printf '%s' "$out" | tr -d '\r' | tail -20)"

  if printf '%s' "$out" | grep -q "OK"; then
    say "  PASS  $label (OpenCode answered)"
    PASS=$((PASS+1))
    return 0
  fi

  # A provider that refuses to serve cannot tell us anything about the plugin.
  # Reporting this as a failure would blame the router for the model's quota,
  # which is the mirror image of the false pass this suite exists to prevent.
  # It is a blocked run, not a broken host, and not a pass either.
  if printf '%s' "$out" | grep -qiE "usage limit|quota exceeded|rate limit|insufficient[_ ]quota|connect a provider|credit balance|429"; then
    say "  BLOCKED $label: the model refused to serve (rate limit or quota), so the host was never exercised"
    printf '%s\n' "$last" | sed 's/^/        | /'
    BLOCKED=$((BLOCKED+1))
    BLOCKED_NAMES+=("$label")
    return 0
  fi

  if [[ $code -eq 124 ]]; then
    say "  FAIL  $label: timed out after ${TIMEOUT_S}s -- the host was blocked"
  else
    say "  FAIL  $label: no answer (exit $code)"
  fi
  printf '%s\n' "$last" | sed 's/^/        | /'
  FAIL=$((FAIL+1))
  FAILED_NAMES+=("$label")
  return 1
}

# Run a scenario that is EXPECTED to break the host.
#
# These are not failures of the plugin; they are documented limits of the host.
# OpenCode does not catch a plugin hook that throws and does not time out a hook
# that never settles, so the only place that protection can come from is the
# plugin itself (src/server/containment.ts). Asserting the limitation keeps the
# reason for that module visible, and turning green here would mean the host
# grew a defence and the containment became belt-and-braces.
run_limitation() {
  local label="$1"
  local why="$2"
  local out
  out="$(cd "$WORK_DIR" && timeout "$TIMEOUT_S" opencode --standalone run --model "$MODEL" \
        "Reply with exactly OK" 2>&1)"
  if printf '%s' "$out" | grep -q "OK"; then
    say "  NOTE  $label: the host survived; this limitation may be fixed upstream"
    LIMITS_UNEXPECTED+=("$label")
    return 0
  fi
  say "  KNOWN $label: $why"
  LIMITS_OK=$((LIMITS_OK+1))
  return 0
}

# Install a bundle into the sandbox plugin dir and point the config at it.
install_bundle() {
  local source="$1"
  rm -rf "$PLUGIN_DIR"
  mkdir -p "$PLUGIN_DIR"
  cp "$source" "$PLUGIN_DIR/index.js"
  write_config "$PLUGIN_DIR"
}

scenario_wanted() {
  [[ -z "$ONLY" || "$ONLY" == "$1" ]]
}

start_stub

say "OpenCode Smart Router -- isolated host-survival suite"
say "sandbox: $SANDBOX"
say "model:   $MODEL"
say ""

# ---------------------------------------------------------------------------
# 0. Baseline. If vanilla OpenCode cannot answer here, no other result means
#    anything, and a failure must not be blamed on the plugin.
# ---------------------------------------------------------------------------
if scenario_wanted "baseline"; then
  hr
  say "baseline: vanilla OpenCode, no plugin"
  rm -rf "$PLUGIN_DIR"
  write_config ""
  if ! run_prompt "baseline"; then
    say ""
    say "The control failed. Every later result would be meaningless."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 1. The plugin throws while loading. A module that cannot be imported must not
#    take the host with it.
# ---------------------------------------------------------------------------
if scenario_wanted "broken-load"; then
  hr
  say "broken-load: plugin throws during import"
  BROKEN="$SANDBOX/broken-load.js"
  cat > "$BROKEN" <<'JS'
throw new Error("e2e: deliberate import failure")
JS
  install_bundle "$BROKEN"
  run_prompt "broken-load"
fi

# ---------------------------------------------------------------------------
# 2. The plugin loads but has no default export. This is the shape of a broken
#    build, not a broken idea: the module is valid JavaScript and useless.
# ---------------------------------------------------------------------------
if scenario_wanted "no-export"; then
  hr
  say "no-export: plugin imports but exports nothing usable"
  BAD="$SANDBOX/no-export.js"
  cat > "$BAD" <<'JS'
export const notThePlugin = 1
JS
  install_bundle "$BAD"
  run_prompt "no-export"
fi

# ---------------------------------------------------------------------------
# 3. The exact production failure. A plugin whose setup succeeds but whose
#    prompt hook throws: this is what 0.6.0 did, through a missing ledger method
#    reached from premiumState(). The host must still answer.
# ---------------------------------------------------------------------------
if scenario_wanted "hook-throws"; then
  hr
  say "hook-throws: prompt hook raises on every prompt"
  BAD="$SANDBOX/hook-throws.js"
  cat > "$BAD" <<'JS'
export default {
  id: "e2e-hook-throws",
  async setup(ctx) {
    await ctx.session.hook("prompt", async () => {
      throw new TypeError("this.ledger.planPoolSpent is not a function")
    })
    return () => undefined
  },
}
JS
  install_bundle "$BAD"
  run_limitation "hook-throws" "a throwing hook fails the prompt; containment is the plugin's job"
fi

# ---------------------------------------------------------------------------
# 4. The plugin hangs. A hook that never settles is a different failure from one
#    that throws, and it is the one that looks like "the editor is frozen".
# ---------------------------------------------------------------------------
if scenario_wanted "hook-hangs"; then
  hr
  say "hook-hangs: prompt hook never settles (bounded by ${TIMEOUT_S}s)"
  BAD="$SANDBOX/hook-hangs.js"
  cat > "$BAD" <<'JS'
export default {
  id: "e2e-hook-hangs",
  async setup(ctx) {
    await ctx.session.hook("prompt", async () => new Promise(() => {}))
    return () => undefined
  },
}
JS
  install_bundle "$BAD"
  run_limitation "hook-hangs" "an unsettled hook blocks forever; the routing deadline is the plugin's job"
fi

# ---------------------------------------------------------------------------
# 5. Setup itself throws. The plugin never becomes usable; the host must carry
#    on without it.
# ---------------------------------------------------------------------------
if scenario_wanted "setup-throws"; then
  hr
  say "setup-throws: plugin setup raises"
  BAD="$SANDBOX/setup-throws.js"
  cat > "$BAD" <<'JS'
export default {
  id: "e2e-setup-throws",
  async setup() {
    throw new Error("e2e: deliberate setup failure")
  },
}
JS
  install_bundle "$BAD"
  run_prompt "setup-throws"
fi

# ---------------------------------------------------------------------------
# 6. Missing file. The config points at a plugin path that does not exist. This
#    happens for real when a versioned install directory is cleaned up while the
#    config still points at it.
# ---------------------------------------------------------------------------
if scenario_wanted "missing-file"; then
  hr
  say "missing-file: config points at a plugin that is not there"
  rm -rf "$PLUGIN_DIR"
  write_config "$PLUGIN_DIR"
  run_prompt "missing-file"
fi

# ---------------------------------------------------------------------------
# 7. Real build, deliberately sabotaged dependency. The genuine bundle is
#    installed, and one thing it depends on is removed at runtime. This is the
#    closest analogue to the shipped defect: correct code, wrong environment.
# ---------------------------------------------------------------------------
if scenario_wanted "real-bundle"; then
  hr
  say "real-bundle: the actual built bundle, unmodified"
  if [[ -f "$ROOT/dist/index.js" ]]; then
    install_bundle "$ROOT/dist/index.js"
    run_prompt "real-bundle"
  else
    say "  SKIP  real-bundle: dist/index.js not built (run npm run build:server)"
  fi
fi

# ---------------------------------------------------------------------------
# 8. Stale shared core. THE PRODUCTION FAILURE, AT HOST LEVEL.
#
#    On 2026-11-06 the new bundle was imported into a process where
#    globalThis[Symbol.for("opencode-smart-router.shared-core.v1")] still held a
#    core built by the PREVIOUS version. Its ledger had no planPoolSpent(), so
#    premiumState() threw, and the throw reached the prompt hook. The owner
#    could not send a message at all, in any mode, until the plugin was removed.
#
#    This scenario plants exactly that object before loading the real bundle,
#    so the guard against adopting a foreign core is exercised against a real
#    OpenCode process rather than a simulation.
# ---------------------------------------------------------------------------
if scenario_wanted "stale-shared-core"; then
  hr
  say "stale-shared-core: a previous version's core is already in globalThis"
  if [[ -f "$ROOT/dist/index.js" ]]; then
    rm -rf "$PLUGIN_DIR"
    mkdir -p "$PLUGIN_DIR"
    cp "$ROOT/dist/index.js" "$PLUGIN_DIR/real.js"
    cat > "$PLUGIN_DIR/index.js" <<'JS'
// Stand in for "a plugin version already ran in this process". The object has
// the old API surface and no apiVersion stamp, which is what a release from
// before the stamp looked like.
const KEY = Symbol.for("opencode-smart-router.shared-core.v1")

export default {
  id: "e2e-stale-shared-core",
  async setup(ctx) {
    const staleLedger = {
      premiumSpent: () => 0,
      // planPoolSpent is deliberately absent: this is the 0.6.0 crash.
      patchSession: () => undefined,
      getSession: () => undefined,
      recordDecision: () => undefined,
      usageEvents: () => [],
      export: () => ({}),
      markClean: () => undefined,
    }
    globalThis[KEY] = {
      coreID: "stale-previous-version",
      pid: process.pid,
      createdAt: Date.now(),
      ledger: staleLedger,
      runtime: {},
      addBridge: () => "stale-bridge",
      claimSession: () => undefined,
      ownerOf: () => undefined,
      getLiveModels: async () => [],
      recordError: () => undefined,
      diagnostics: () => ({ errors: [], bridgeCount: 0 }),
      init: async () => undefined,
    }
    // Loaded AFTER the plant, so the bundle's module-level core lookup sees it.
    const real = await import("./real.js")
    return real.default.setup(ctx)
  },
}
JS
    write_config "$PLUGIN_DIR"
    run_prompt "stale-shared-core"
  else
    say "  SKIP  stale-shared-core: dist/index.js not built (run npm run build:server)"
  fi
fi

hr
say ""
say "results: $PASS passed, $FAIL failed, $LIMITS_OK host limitations confirmed, $BLOCKED blocked by provider quota"
if [[ $BLOCKED -gt 0 ]]; then
  say ""
  say "Blocked runs prove nothing about the plugin. Re-run them with a model that can serve:"
  for name in "${BLOCKED_NAMES[@]}"; do say "  - $name"; done
  say "  set E2E_MODEL to a model this machine can serve."
fi
if [[ ${#LIMITS_UNEXPECTED[@]} -gt 0 ]]; then
  say "host limitations that no longer reproduce (news, not a failure):"
  for name in "${LIMITS_UNEXPECTED[@]}"; do say "  - $name"; done
fi
if [[ $FAIL -gt 0 ]]; then
  say "failed scenarios:"
  for name in "${FAILED_NAMES[@]}"; do say "  - $name"; done
  say ""
  say "A failure here means a defect in this plugin can stop the owner from working."
  exit 1
fi

say "Every scenario ended with OpenCode still answering a prompt."
