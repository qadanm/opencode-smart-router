#!/usr/bin/env bash
# Isolated three-provider canary for the OpenCode smart router.
#
# Nothing here touches the live OpenCode installation, the live plugin
# directory, or the live router config. It builds a disposable HOME, config,
# data and cache, and runs a local mock gateway instead of any paid provider.
#
# Usage: lab-canary-3p.sh <lab-dir> <port> <mock-port>
set -euo pipefail

LAB="$1"; PORT="$2"; MOCK_PORT="$3"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$LAB"/{home/.config/opencode,home/.local/share/opencode,data,cache,projects/p1,projects/p2,projects/p3}
PLUGIN_DIR="$LAB/plugin"
mkdir -p "$PLUGIN_DIR"

echo "== building the release artifact =="
(cd "$ROOT" && npm run build:server >/dev/null)
cp "$ROOT/dist/index.js" "$PLUGIN_DIR/index.js"
sha256 "$PLUGIN_DIR/index.js" 2>/dev/null || shasum -a 256 "$PLUGIN_DIR/index.js"

echo "== writing the isolated OpenCode config =="
cat > "$LAB/home/.config/opencode/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": ["$PLUGIN_DIR"],
  "model": "lab-cc/deepseek-v4.1-flash",
  "providers": {
    "lab-cc": {
      "name": "Lab GOAT",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:$MOCK_PORT/cc/v1", "apiKey": "lab" },
      "models": {
        "deepseek-v4.1-flash": { "name": "Lab DeepSeek", "limit": { "context": 1000000, "output": 384000 }, "capabilities": { "tools": true, "input": ["text","image"], "output": ["text"] }, "cost": [{ "input": 0.15, "output": 0.6, "cache": { "read": 0.003, "write": 0 } }] },
        "claude-haiku-5-5": { "name": "Lab Haiku", "limit": { "context": 1000000, "output": 128000 }, "capabilities": { "tools": true, "input": ["text","image","pdf"], "output": ["text"] }, "cost": [{ "input": 0.1, "output": 0.5, "cache": { "read": 0.01, "write": 0.125 } }] },
        "claude-sonnet-5-5": { "name": "Lab Sonnet", "limit": { "context": 1000000, "output": 128000 }, "capabilities": { "tools": true, "input": ["text","image","pdf"], "output": ["text"] }, "cost": [{ "input": 2, "output": 10, "cache": { "read": 0.1, "write": 2.5 } }] }
      }
    },
    "lab-go": {
      "name": "Lab Go Plus",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:$MOCK_PORT/go/v1", "apiKey": "lab" },
      "models": {
        "deepseek-v4.1-flash": { "name": "Lab Go DeepSeek", "limit": { "context": 1000000, "output": 384000 }, "capabilities": { "tools": true, "input": ["text","image"], "output": ["text"] }, "cost": [{ "input": 0.15, "output": 0.6, "cache": { "read": 0.003, "write": 0 } }] },
        "glm-5.3-flash": { "name": "Lab Go GLM", "limit": { "context": 1000000, "output": 131072 }, "capabilities": { "tools": true, "input": ["text","image","video"], "output": ["text"] }, "cost": [{ "input": 0.15, "output": 0.5, "cache": { "read": 0.03, "write": 0 } }] },
        "minimax-m3.1-flash": { "name": "Lab Go MiniMax", "limit": { "context": 1000000, "output": 512000 }, "capabilities": { "tools": true, "input": ["text","image","video"], "output": ["text"] }, "cost": [{ "input": 0.15, "output": 0.6, "cache": { "read": 0.015, "write": 0 } }] }
      }
    },
    "opendesign": {
      "name": "Lab OpenDesign Go",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:$MOCK_PORT/od/v1", "apiKey": "lab-od" },
      "models": {
        "deepseek-v4.1-flash": { "name": "Lab OD DeepSeek", "limit": { "context": 328000, "output": 128000 }, "capabilities": { "tools": true, "input": ["text","image"], "output": ["text"] }, "cost": [{ "input": 0.15, "output": 0.6, "cache": { "read": 0.003, "write": 0 } }] },
        "claude-haiku-5.5": { "name": "Lab OD Haiku", "limit": { "context": 228000, "output": 128000 }, "capabilities": { "tools": true, "input": ["text","image","pdf"], "output": ["text"] }, "cost": [{ "input": 0.1, "output": 0.5, "cache": { "read": 0.01, "write": 0.125 } }] },
        "mimo-v2.6-pro": { "name": "Lab OD MiMo Pro", "limit": { "context": 232000, "output": 32000 }, "capabilities": { "tools": true, "input": ["text","image","audio","video"], "output": ["text"] }, "cost": [{ "input": 0.435, "output": 0.87, "cache": { "read": 0.003625, "write": 0 } }] }
      }
    }
  }
}
JSON
jq empty "$LAB/home/.config/opencode/opencode.json"

echo "== writing the isolated router config =="
cat > "$LAB/home/.config/opencode/smart-router.json" <<'JSON'
{
  "enabled": true,
  "dryRun": false,
  "mode": "balanced",
  "providers": {
    "opencode-go": { "enabled": true, "probeUsage": true, "allowExtraUsage": false },
    "commandcode": { "enabled": true, "probeUsage": true, "allowExtraUsage": false },
    "opendesign": {
      "enabled": true,
      "probeUsage": true,
      "allowExtraUsage": false,
      "subscriptionOnly": true,
      "providerScopedQuota": true,
      "monthlyCreditsUsd": 120,
      "fiveHourCapUsd": 10,
      "weeklyCapUsd": 30,
      "baseURL": "http://127.0.0.1:__MOCK_PORT__/od/v1"
    }
  },
  "premium": { "mode": "off", "monthlyBudgetUsd": 0, "oneShotApproval": false },
  "routing": { "failClosed": true },
  "quota": { "probeOpenCodeGo": false, "probeCommandCode": false, "probeOpenDesign": true, "probeIntervalMinutes": 5 },
  "ui": { "titleIndicator": true, "notifications": false },
  "logging": { "storePromptText": false, "diagnostics": true }
}
JSON
sed -i '' "s|__MOCK_PORT__|$MOCK_PORT|g" "$LAB/home/.config/opencode/smart-router.json"
jq empty "$LAB/home/.config/opencode/smart-router.json"

# The OpenDesign inference key the router will discover.
printf 'sk-amr-lab-canary-key' > "$LAB/home/.config/opencode/opendesign.key"
chmod 600 "$LAB/home/.config/opencode/opendesign.key"

echo "lab ready at $LAB"
