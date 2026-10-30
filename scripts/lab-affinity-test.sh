#!/usr/bin/env bash
# Cache-affinity and failure-handling checks against the isolated lab.
# Usage: lab-affinity-test.sh <lab-dir> <port>
set -uo pipefail

LAB="$1"; PORT="$2"
PASS=$(cat "$LAB/password"); AUTH="opencode:$PASS"; BASE="http://127.0.0.1:$PORT"
OUT="$LAB/affinity.txt"; : > "$OUT"
say() { echo "$*" | tee -a "$OUT"; }
report() { curl -s --max-time 20 -u "$AUTH" -X POST "$BASE/api/rpc/smart-router/report" -H 'content-type: application/json' -d '{"input":{}}'; }
decisions_for() {
  report | jq -c --arg s "$1" '[.output.decisions[] | select(.sessionID==$s)][0] // null'
}

say "== A. a large-context session must keep its cache and stay on its provider =="
BIG=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'content-type: application/json' \
  -d "{\"title\":\"canary affinity\",\"location\":{\"directory\":\"$LAB/projects/p2\"},\"model\":{\"providerID\":\"opencode-go\",\"id\":\"deepseek-v4.1-flash\"}}" | jq -r '.data.id')
say "  session=$BIG on opencode-go/deepseek-v4.1-flash"

# Establish a real cached context first.
python3 - "$LAB/big-prompt.json" <<'PY'
import json, sys
text = "Context token stress for cache affinity. " * 90000
json.dump({"text": text + "\nDo not use any tools. Reply with exactly: ok"}, open(sys.argv[1], "w"))
PY
curl -s --max-time 180 -u "$AUTH" -X POST "$BASE/api/session/$BIG/prompt" -H 'content-type: application/json' \
  --data-binary @"$LAB/big-prompt.json" >/dev/null
say "  after the large prompt:"
decisions_for "$BIG" | jq -c '{chosen, switched, switchReason, contextTokens, cachedTokens}' | tee -a "$OUT"

say "== B. a mid-stream provider fault cools the model down and moves the session =="
MOCK_PID=$(cat "$LAB/mock.pid" 2>/dev/null | awk '{print $1}')
kill "$MOCK_PID" 2>/dev/null || true
sleep 1
cd "$(dirname "$0")/.."
(MOCK_PORT=4200 MOCK_LOG="$LAB/mock.log" MOCK_STREAM_FAILURE=1 nohup node scripts/lab-mock-3p.mjs > "$LAB/mock.out" 2>&1 & echo "pid=$!" > "$LAB/mock.pid")
sleep 2
FAULT_SID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'content-type: application/json' \
  -d "{\"title\":\"canary stream fault\",\"location\":{\"directory\":\"$LAB/projects/p3\"},\"model\":{\"providerID\":\"opendesign\",\"id\":\"minimax-m3.1-flash\"}}" | jq -r '.data.id')
curl -s --max-time 60 -u "$AUTH" -X POST "$BASE/api/session/$FAULT_SID/prompt" -H 'content-type: application/json' \
  -d '{"text":"Implement a small feature in src/app.ts. Do not use any tools. Reply with exactly: ok."}' >/dev/null
sleep 2
say "  decision after the fault:"
decisions_for "$FAULT_SID" | jq -c '{chosen, switched, switchReason, warnings}' | tee -a "$OUT"
report | jq -c '.output.metrics | {failures, byModel: (.byModel | to_entries | map(select(.key=="opendesign/minimax-m3.1-flash")) | from_entries)}' | tee -a "$OUT"

say "== C. quota exhaustion moves routing off OpenDesign =="
kill "$(cat "$LAB/mock.pid" | awk '{print $1}')" 2>/dev/null || true
sleep 1
(MOCK_PORT=4200 MOCK_LOG="$LAB/mock.log" MOCK_OD_EXHAUSTED=1 MOCK_OD_WALLET_CREDITS=500000 nohup node scripts/lab-mock-3p.mjs > "$LAB/mock.out" 2>&1 & echo "pid=$!" > "$LAB/mock.pid")
sleep 2
EX_SID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'content-type: application/json' \
  -d "{\"title\":\"canary exhaustion\",\"location\":{\"directory\":\"$LAB/projects/p1\"},\"model\":{\"providerID\":\"opendesign\",\"id\":\"deepseek-v4.1-flash\"}}" | jq -r '.data.id')
curl -s --max-time 60 -u "$AUTH" -X POST "$BASE/api/session/$EX_SID/prompt" -H 'content-type: application/json' \
  -d '{"text":"Implement a small feature in src/app.ts. Do not use any tools. Reply with exactly: ok."}' >/dev/null
sleep 2
say "  decision while the five-hour window is exhausted and a wallet balance exists:"
decisions_for "$EX_SID" | jq -c '{chosen, switched, switchReason}' | tee -a "$OUT"

say "== D. no wallet spend without explicit approval =="
report | jq -c '.output.quota[] | select(.providerID=="opendesign") | {providerID, quotaState, rolling:.rolling.usedPct, weekly:.weekly.usedPct, monthly:.monthly.usedPct, extraCredits, notes:(.notes|length)}' | tee -a "$OUT"

say "affinity canary complete $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$OUT"
