#!/bin/bash
# Detached reload of the smart-router backend.
#
# Written to a file and run with nohup so killing the backend cannot take the
# shell that issued it down with it. Earlier in this session a plain `kill` from
# inside a tool call cancelled the in-flight command, which makes the restart
# look like a failure when it actually succeeded.

set -u

PORT=49374
LOG="${TMPDIR:-/tmp}/opencode/smart-router-reload.log"
mkdir -p "$(dirname "$LOG")"

echo "=== reload started $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >>"$LOG"

PID="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -z "${PID:-}" ]; then
  echo "no backend listening on $PORT; nothing to restart" >>"$LOG"
  exit 0
fi

echo "old backend pid=$PID" >>"$LOG"
kill "$PID" 2>>"$LOG"

# Wait for the port to be released, then for the desktop app to relaunch it.
for _ in $(seq 1 40); do
  sleep 0.5
  if ! lsof -nP -iTCP:$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "port released after $((_ / 2))s" >>"$LOG"
    break
  fi
done

for _ in $(seq 1 60); do
  sleep 0.5
  NEWPID="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "${NEWPID:-}" ]; then
    echo "backend listening again pid=$NEWPID after $((_ / 2))s" >>"$LOG"
    echo "=== reload finished $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >>"$LOG"
    exit 0
  fi
done

echo "backend did not come back within 30s; the desktop app may need a manual relaunch" >>"$LOG"
echo "=== reload finished (timeout) $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >>"$LOG"
exit 1
