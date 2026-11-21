#!/usr/bin/env bash
set -uo pipefail

ROOT="{{ROOT}}"
MOD="{{MOD}}"
GAME="{{GAME}}"
STEAM_APP_ID="{{STEAM_APP_ID}}"
GAME_PROCESSES="{{GAME_PROCESSES}}"
LOADER_SUPPORT="{{LOADER_SUPPORT}}"
GAME_EXE="{{EXE}}"

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

if [ -z "$GAME" ] || [ ! -d "$GAME" ]; then
  echo "Game folder not found: $GAME" >>"$LOG"
  exit 1
fi

# Repair the loader swap after a Steam verify/update. InfinityLoader.ini names
# the real executable; the loader itself must be the executable Steam launches.
REAL_EXE="$GAME_EXE"
if [ -f "$LOADER_SUPPORT/InfinityLoader.ini" ]; then
  parsed=$(sed -n 's/^[[:space:]]*ExeNames[[:space:]]*=[[:space:]]*//p' "$LOADER_SUPPORT/InfinityLoader.ini" | head -n 1 | cut -d, -f1 | tr -d '\r' | sed 's/[[:space:]]*$//')
  if [ -n "$parsed" ]; then
    REAL_EXE=$(basename "$parsed")
  fi
fi

if [ -d "$LOADER_SUPPORT" ]; then
  for file in "$LOADER_SUPPORT"/*; do
    [ -f "$file" ] || continue
    name=$(basename "$file")
    [ -f "$GAME/$name" ] || cp -f "$file" "$GAME/$name"
  done
fi

if [ "$REAL_EXE" != "$GAME_EXE" ] && [ ! -f "$GAME/$REAL_EXE" ] && [ -f "$GAME/$GAME_EXE" ]; then
  mv "$GAME/$GAME_EXE" "$GAME/$REAL_EXE"
fi

if [ -f "$GAME/$REAL_EXE" ] && [ -f "$LOADER_SUPPORT/InfinityLoader.exe" ]; then
  cp -f "$LOADER_SUPPORT/InfinityLoader.exe" "$GAME/$GAME_EXE"
  chmod 755 "$GAME/$GAME_EXE" 2>/dev/null || true
else
  echo "Loader or real executable is missing; verify the game files or reinstall the pack." >>"$LOG"
fi

if [ ! -d "$GAME/override" ]; then
  echo "The mod overlay is missing; reinstall the pack from ModSync." >>"$LOG"
fi

if command -v steam >/dev/null 2>&1; then
  steam -applaunch "$STEAM_APP_ID" >>"$LOG" 2>&1 &
  exit 0
fi
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "steam://rungameid/$STEAM_APP_ID" >>"$LOG" 2>&1 &
  exit 0
fi

echo "Steam was not found; launch the game from your library." >>"$LOG"
exit 1
