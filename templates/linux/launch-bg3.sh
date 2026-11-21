#!/usr/bin/env bash
set -uo pipefail

ROOT="{{ROOT}}"
MOD="{{MOD}}"
GAME="{{GAME}}"
PREFIX="{{PREFIX}}"
DATA_DIR="{{DATA_DIR}}"
STEAM_APP_ID="{{STEAM_APP_ID}}"
GAME_PROCESS="{{GAME_PROCESS}}"

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/launch-$MOD-$(date +%Y%m%d-%H%M%S).log"

if command -v pgrep >/dev/null 2>&1 && pgrep -x "$GAME_PROCESS" >/dev/null 2>&1; then
  echo "$GAME_PROCESS is already running." >>"$LOG"
  exit 0
fi

# The pack apply step has already placed the mods, modsettings, and BG3SE files
# in the Proton prefix. Start the game through Steam so it uses that prefix.
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
