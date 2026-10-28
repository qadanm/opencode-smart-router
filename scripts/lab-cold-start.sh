#!/usr/bin/env bash
# Isolated cold-start / restart validation. Never targets the live desktop server.
# Usage: lab-cold-start.sh <lab-dir> <port> <plugin-dir> <rounds>
set -u
LAB="$1"; PORT="$2"; PLUGIN_DIR="$3"; ROUNDS="${4:-3}"
OUT="$LAB/cold-start.txt"; : > "$OUT"
BASE="http://127.0.0.1:$PORT"

stop_server() {
  local pids
  pids=$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    lsof -ti tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || return 0
    sleep 1
  done
}
start_server() {
  local n="$1" pass=""
  (cd "$LAB" && HOME="$LAB/home" XDG_CONFIG_HOME="$LAB/home/.config" XDG_DATA_HOME="$LAB/data" XDG_CACHE_HOME="$LAB/cache" \
    nohup opencode serve --port "$PORT" --print-logs > "$LAB/cold-serve-$n.log" 2>&1 < /dev/null &)
  for _ in $(seq 1 30); do
    pass=$(grep -o 'server password .*' "$LAB/cold-serve-$n.log" 2>/dev/null | head -1 | awk '{print $3}')
    [ -n "$pass" ] && break
    sleep 1
  done
  for _ in $(seq 1 30); do
    if curl -s --max-time 2 -o /dev/null -u "opencode:$pass" "$BASE/api/info"; then
      break
    fi
    sleep 1
  done
  PASS="$pass"
}

echo "cold-start $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT"
for n in $(seq 1 "$ROUNDS"); do
  before_pid=$(lsof -ti tcp:"$PORT" 2>/dev/null | head -1)
  stop_server
  start_server "$n"
  AUTH="opencode:$PASS"
  CORE=$(curl -s --max-time 15 -u "$AUTH" -X POST "$BASE/api/rpc/smart-router/diagnostics" -H 'content-type: application/json' -d '{"input":{}}' | jq -c '.output // {}')
  SID=$(head -1 "$LAB/sids2.txt" | awk '{print $2}')
  TITLE=$(curl -s --max-time 10 -u "$AUTH" "$BASE/api/session/$SID" | jq -r '.data.title // "missing"')
  CMD=$(curl -s --max-time 10 -u "$AUTH" "$BASE/api/command?location.directory=$LAB/projects/p1" | jq -r '[.data[].name | select(startswith("router-"))] | length')
  printf 'round=%s oldPid=%s newPid=%s core=%s bridges=%s setups=%s disposes=%s commandsP1=%s title=%s\n' \
    "$n" "${before_pid:-none}" "$(lsof -ti tcp:$PORT | head -1)" "$(echo "$CORE" | jq -r '.coreID')" \
    "$(echo "$CORE" | jq -r '.bridgeCount')" "$(echo "$CORE" | jq -r '.setups')" "$(echo "$CORE" | jq -r '.disposes')" \
    "$CMD" "$TITLE" >> "$OUT"
  echo "round $n core=$(echo "$CORE" | jq -r '.coreID') commands=$CMD title=$TITLE" >&2
done
echo "cold-start complete $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT"
