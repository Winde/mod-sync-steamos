#!/usr/bin/env bash
set -uo pipefail

ROOT="{{ROOT}}"
MOD="{{MOD}}"
GAME="{{GAME}}"
PREFIX="{{PREFIX}}"
DATA_DIR="{{DATA_DIR}}"
STEAM_APP_ID="{{STEAM_APP_ID}}"
GAME_PROCESSES="{{GAME_PROCESSES}}"

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/launch-$MOD-$(date +%Y%m%d-%H%M%S).log"

game_running() {
  for process in $GAME_PROCESSES; do
    if command -v pgrep >/dev/null 2>&1; then
      pgrep -x "$process" >/dev/null 2>&1 && return 0
    else
      ps -eo comm= 2>/dev/null | grep -qx "$process" && return 0
    fi
  done
  return 1
}

if game_running; then
  echo "The game is already running." >>"$LOG"
  exit 0
fi

# The pack apply step has already placed the pack's files. Start the game
# through Steam so it uses the correct runtime and prefix.
if command -v steam >/dev/null 2>&1; then
  steam -applaunch "$STEAM_APP_ID" >>"$LOG" 2>&1 &
  exit 0
fi
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "steam://rungameid/$STEAM_APP_ID" >>"$LOG" 2>&1 &
  exit 0
fi

echo "Steam was not found; launch $GAME from your library." >>"$LOG"
exit 1
