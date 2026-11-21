#!/usr/bin/env bash
set -uo pipefail

ROOT="{{ROOT}}"
PORT="{{PORT}}"
URL="http://127.0.0.1:$PORT"
NODE="$ROOT/tools/node/bin/node"
AGENT="$ROOT/agent/bin/modsync.js"
CONFIG="$ROOT/agent.json"
LOG="$ROOT/logs/agent.log"

mkdir -p "$ROOT/logs"
if ! curl -fsS "$URL/api/health" >/dev/null 2>&1; then
  nohup "$NODE" "$AGENT" agent --config "$CONFIG" >>"$LOG" 2>&1 &
  for _ in $(seq 1 40); do
    curl -fsS "$URL/api/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

# TV-first: kiosk/app mode when available, otherwise the default browser.
if command -v firefox >/dev/null 2>&1; then
  exec firefox --kiosk "$URL"
fi
if command -v chromium >/dev/null 2>&1; then
  exec chromium --kiosk --app="$URL"
fi
if command -v google-chrome >/dev/null 2>&1; then
  exec google-chrome --kiosk --app="$URL"
fi
exec xdg-open "$URL"
