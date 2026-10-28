#!/usr/bin/env bash
# Three-provider canary checks against the isolated lab.
# Usage: lab-canary-3p-test.sh <lab-dir> <port>
set -uo pipefail

LAB="$1"; PORT="$2"
PASS=$(cat "$LAB/password"); AUTH="opencode:$PASS"; BASE="http://127.0.0.1:$PORT"
OUT="$LAB/canary-3p.txt"; : > "$OUT"
say() { echo "$*" | tee -a "$OUT"; }

rpc() { curl -s --max-time 20 -u "$AUTH" -X POST "$BASE/api/rpc/smart-router/$1" -H 'content-type: application/json' -d "${2:-{\"input\":{}}}"; }
new_session() {
  local dir="$1" model="$2" title="$3"
  curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'content-type: application/json' \
    -d "{\"title\":\"$title\",\"location\":{\"directory\":\"$dir\"},\"model\":$model}" | jq -r '.data.id'
}
prompt() {
  curl -s --max-time 90 -u "$AUTH" -X POST "$BASE/api/session/$1/prompt" -H 'content-type: application/json' \
    -d "$(jq -c -n --arg t "$2" '{text:$t}')"
}
status() { rpc status "{\"input\":{\"sessionID\":\"$1\"}}"; }
# The status RPC reports the most recent decision globally. For per-session
# evidence, take that session's own decision out of the retained list.
session_decision() {
  rpc status "{\"input\":{\"sessionID\":\"$1\"}}" | \
    jq -c --arg s "$1" '[.output.lastDecisions[] | select(.sessionID==$s)][0] | {chosen,switched,switchReason,estimatedUsd,creditMultiplier:(.candidates[0].creditMultiplier//null)}'
}

say "== 1. three-provider registration =="
rpc status | jq -c '.output | {providers:([.quota[].providerID]|sort), approved:([.approvedModels[].key|split("/")[0]]|unique), opendesignState:(.quota[]|select(.providerID=="opendesign")|.quotaState)}' | tee -a "$OUT"

say "== 2. OpenDesign entitlement discovery =="
rpc status | jq -r '.output.approvedModels[] | select(.key|startswith("opendesign/")) | "  \(.key) tier=\(.tier) int=\(.intelligence) design=\(.design) vision=\(.vision)"' | tee -a "$OUT"

say "== 3. a session routed to OpenDesign =="
OD_SID=$(new_session "$LAB/projects/p1" '{"providerID":"opendesign","id":"deepseek-v4.1-flash"}' "canary opendesign")
say "  session=$OD_SID"
prompt "$OD_SID" "Implement a small feature in src/app.ts. Do not use any tools. Reply with exactly: ok." >/dev/null
session_decision "$OD_SID" | tee -a "$OUT"
curl -s -u "$AUTH" "$BASE/api/session/$OD_SID" | jq -c '{title:.data.title, model:.data.model}' | tee -a "$OUT"

say "== 4. a session routed to GOAT =="
CC_SID=$(new_session "$LAB/projects/p2" '{"providerID":"commandcode","id":"claude-haiku-5-5"}' "canary goat")
prompt "$CC_SID" "Implement a small feature in src/app.ts. Do not use any tools. Reply with exactly: ok." >/dev/null
session_decision "$CC_SID" | tee -a "$OUT"

say "== 5. a session routed to Go Plus =="
GO_SID=$(new_session "$LAB/projects/p3" '{"providerID":"opencode-go","id":"glm-5.3-flash"}' "canary goplus")
prompt "$GO_SID" "Implement a small feature in src/app.ts. Do not use any tools. Reply with exactly: ok." >/dev/null
session_decision "$GO_SID" | tee -a "$OUT"

say "== 6. manual override still wins over automatic routing =="
curl -s -o /dev/null -w "  switch_http=%{http_code}\n" -u "$AUTH" -X POST "$BASE/api/session/$OD_SID/model" \
  -H 'content-type: application/json' -d '{"model":{"providerID":"opendesign","id":"claude-haiku-5.5"}}'
prompt "$OD_SID" "Another change in src/app.ts. Do not use any tools. Reply with exactly: ok." >/dev/null
status "$OD_SID" | jq -c '.output | {runtime, manualOverride, current:.current}' | tee -a "$OUT"
curl -s -o /dev/null -u "$AUTH" -X POST "$BASE/api/rpc/smart-router/resumeAuto" -H 'content-type: application/json' \
  -d "$(jq -c -n --arg s "$OD_SID" '{input:{sessionID:$s}}')"

say "== 7. OpenDesign diagnostics command makes no inference request =="
BEFORE=$(grep -c 'chat/completions' "$LAB/mock.log" 2>/dev/null || echo 0)
CMD=$(curl -s -u "$AUTH" "http://127.0.0.1:$PORT/api/command?location.directory=$LAB/projects/p1" | jq -r '[.data[].name | select(startswith("router-"))] | sort | join(",")')
say "  commands: $CMD"
case "$CMD" in *router-opendesign*) say "  router-opendesign is registered";; *) say "  router-opendesign is MISSING";; esac
AFTER=$(grep -c 'chat/completions' "$LAB/mock.log" 2>/dev/null || echo 0)
say "  inference requests before=$BEFORE after=$AFTER (informational commands must be zero)"

say "== 8. core lifecycle =="
rpc diagnostics | jq -c '.output | {coreID, bridgeCount, setups, disposes, eventStreams, errors:(.errors|length)}' | tee -a "$OUT"

say "== 9. provider-scoped quota has no per-model snapshots =="
rpc status | jq -c '.output.quota[] | select(.providerID=="opendesign") | {providerID, source, quotaState, modelSnapshotCount:(.models|length)}' | tee -a "$OUT"

say "== 10. decision records =="
rpc report | jq -c '.output | {decisions:(.decisions|length), quotaProviders:([.quota[].providerID]|sort)}' | tee -a "$OUT"

say "canary complete $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$OUT"
