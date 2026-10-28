#!/usr/bin/env bash
# Isolated OpenCode smart-router soak test.
# Usage: lab-soak.sh <lab-dir> <port> <password> <sids-file> <plugin-dest> <plugin-src> <mock-log> <mock-script>
set -u

LAB="$1"; PORT="$2"; PASS="$3"; SIDS="$4"; PLUGIN_DEST="$5"; PLUGIN_SRC="$6"; MOCK_LOG="$7"; MOCK_SCRIPT="$8"
BASE="http://127.0.0.1:$PORT"; AUTH="opencode:$PASS"; MET="$LAB/soak-metrics.jsonl"; : > "$MET"
START=$(date +%s); END=$((START + 1800)); N=0; LAST_RELOAD=0; LAST_OUTAGE=0; LAST_LARGE=0

rss() { ps -o rss= -p "$(lsof -ti tcp:$PORT | head -1)" 2>/dev/null | tr -d ' '; }
diag() { curl -s -u "$AUTH" -X POST "$BASE/api/rpc/smart-router/diagnostics" -H 'content-type: application/json' -d '{"input":{}}' | jq -c '.output // {}'; }
diag_file() { curl -s -u "$AUTH" -X POST "$BASE/api/rpc/smart-router/diagnostics" -H 'content-type: application/json' -d '{"input":{}}' | jq '.output // {}' > "$LAB/soak-diag.json"; }
mock_count() { awk '/chat\/completions/ { n++ } END { print n + 0 }' "$MOCK_LOG" 2>/dev/null || echo 0; }
record() {
  local now=$(date +%s) r=$(rss) m=$(mock_count)
  diag_file
  jq -c --argjson ts "$now" --argjson rss "${r:-0}" --argjson mock "$m" \
    '{ts:$ts,rssKb:$rss,mockRequests:$mock,core:.coreID,pid:.pid,bridges:.bridgeCount,setups:.setups,disposes:.disposes,decisions:.decisions,ledgerEvents:.ledgerEvents,handled:.eventsHandled,ignored:.eventsIgnored,ledgerWrites:.ledgerWrites,quotaWrites:.quotaWrites,eventStreams:.eventStreams,errors:(.errors|length)}' "$LAB/soak-diag.json" >> "$MET"
}
prompt() {
  local sid="$1" text="$2"
  curl -s -u "$AUTH" -X POST "$BASE/api/session/$sid/prompt" -H 'content-type: application/json' \
    -d "$(jq -c -n --arg t "$text" '{text:$t}')" >/dev/null
}
commands_all() {
  local total=0 locations=0
  while read -r d; do
    local n
    n=$(curl -s -u "$AUTH" "$BASE/api/command?location.directory=$d" | jq -r '[.data[].name | select(startswith("router-"))] | length')
    total=$((total+n)); locations=$((locations+1))
  done < <(diag | jq -r '.bridges[].directory')
  echo "$locations $total"
}

record
while [ "$(date +%s)" -lt "$END" ]; do
  N=$((N+1))
  A=$(shuf -n1 "$SIDS" | awk '{print $2}'); B=$(shuf -n1 "$SIDS" | awk '{print $2}')
  prompt "$A" "Implement a feature in src/app.ts. Do not use any tools. Reply with exactly: ok." &
  prompt "$B" "Change the button background color to #111111 in src/styles.css. Do not run tests. Reply with exactly: ok." &
  wait
  if [ $((N % 6)) -eq 0 ]; then
    C=$(shuf -n1 "$SIDS" | awk '{print $2}')
    curl -s -u "$AUTH" -X POST "$BASE/api/session/$C/model" -H 'content-type: application/json' -d '{"model":{"providerID":"lab-cc","id":"deepseek-v4.1-flash"}}' >/dev/null
    sleep 1
    curl -s -u "$AUTH" -X POST "$BASE/api/rpc/smart-router/resumeAuto" -H 'content-type: application/json' -d "$(jq -c -n --arg s "$C" '{input:{sessionID:$s}}')" >/dev/null
  fi
  if [ $((N % 30)) -eq 0 ]; then
    record
    echo "commands $(commands_all)" >> "$LAB/soak-commands.txt"
  fi
  ELAPSED=$(( $(date +%s) - START ))
  if [ $((ELAPSED - LAST_RELOAD)) -ge 600 ]; then
    cp "$PLUGIN_SRC" "$PLUGIN_DEST.tmp" && mv "$PLUGIN_DEST.tmp" "$PLUGIN_DEST"
    LAST_RELOAD=$ELAPSED
    sleep 12
    record
  fi
  if [ $((ELAPSED - LAST_OUTAGE)) -ge 900 ] && [ "$LAST_OUTAGE" -eq 0 ]; then
    LAST_OUTAGE=$ELAPSED
    lsof -ti tcp:4200 | xargs kill 2>/dev/null || true
    sleep 2
    outage_sid=$(shuf -n1 "$SIDS" | awk '{print $2}')
    prompt "$outage_sid" "Implement a feature in src/outage.ts. Do not use any tools. Reply with exactly: ok."
    sleep 5
    (nohup node "$MOCK_SCRIPT" > "$LAB/mock-restart.out" 2>&1 &)
    sleep 3
    prompt "$outage_sid" "Implement a feature in src/recovered.ts. Do not use any tools. Reply with exactly: ok."
    echo "outage-recovery $outage_sid" >> "$LAB/soak-events.txt"
  fi
  if [ $((ELAPSED - LAST_LARGE)) -ge 1500 ] && [ "$LAST_LARGE" -eq 0 ]; then
    LAST_LARGE=$ELAPSED
    LARGE_SID=$(shuf -n1 "$SIDS" | awk '{print $2}')
    python3 - "$LAB/large-prompt.json" <<'PY'
import json, sys
text = "Context token stress. " * 100000
json.dump({"text": text + "\nDo not use tools. Reply with exactly: large-ok"}, open(sys.argv[1], "w"))
PY
    curl -s -u "$AUTH" -X POST "$BASE/api/session/$LARGE_SID/prompt" -H 'content-type: application/json' --data-binary @"$LAB/large-prompt.json" >/dev/null
    echo "large-context $LARGE_SID" >> "$LAB/soak-events.txt"
  fi
  sleep 2
done
record
echo "soak complete $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$MET"
