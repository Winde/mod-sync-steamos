#!/usr/bin/env bash
set -uo pipefail

ROOT="{{ROOT}}"
MOD="{{MOD}}"
GAME="{{GAME}}"
DATA_HOME="{{DATA_HOME}}"
STEAM_APP_ID="{{STEAM_APP_ID}}"
GAME_PROCESSES="{{GAME_PROCESSES}}"
BG3LE="$DATA_HOME/bg3le"

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/launch-bg3-native-$(date +%Y%m%d-%H%M%S).log"
VER="$(cat "$ROOT/mods/$MOD/current.txt" 2>/dev/null || true)"
BG3LE_SRC="$ROOT/mods/$MOD/versions/$VER/tools/bg3le"
[ -d "$BG3LE_SRC" ] || BG3LE_SRC="$ROOT/tools/bg3le"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"
}

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
  echo "Baldur's Gate 3 is already running." >>"$LOG"
  exit 0
fi

BG3="$GAME/bin/bg3"

# Install BG3LE in the layout its own installer uses. The game entry stays
# Steam's own; launching through Steam keeps the runtime, overlay and Game
# Mode integration intact. The game binary is never renamed: BG3LE only
# attaches when /proc/self/exe is named `bg3`. This launcher starts the game
# without preloading BG3LE, so only data mods are active for now.
if [ ! -f "$BG3LE/lib/libbg3le.so" ] && [ -d "$BG3LE_SRC" ]; then
  mkdir -p "$BG3LE/lib" "$BG3LE/bin" "$BG3LE/client"
  if [ -f "$BG3LE_SRC/lib/libbg3le.so" ]; then
    cp -f "$BG3LE_SRC/lib/libbg3le.so" "$BG3LE/lib/libbg3le.so"
  else
    cp -f "$BG3LE_SRC/build/libbg3le.so" "$BG3LE/lib/libbg3le.so"
  fi
  if [ -f "$BG3LE_SRC/bin/bg3le-launch" ]; then
    cp -f "$BG3LE_SRC/bin/bg3le-launch" "$BG3LE/bin/bg3le-launch"
  elif [ -f "$BG3LE_SRC/installer/bg3le-launch" ]; then
    cp -f "$BG3LE_SRC/installer/bg3le-launch" "$BG3LE/bin/bg3le-launch"
  fi
  if [ -f "$BG3LE_SRC/client/bg3lua" ]; then
    cp -f "$BG3LE_SRC/client/bg3lua" "$BG3LE/client/bg3lua"
  fi
  if [ -f "$BG3LE_SRC/VERSION" ]; then
    cp -f "$BG3LE_SRC/VERSION" "$BG3LE/version"
  fi
  chmod 755 "$BG3LE/bin/bg3le-launch" "$BG3LE/client/bg3lua" 2>/dev/null || true
  chmod 644 "$BG3LE/lib/libbg3le.so" 2>/dev/null || true
  log "Installed bundled BG3LE files in $BG3LE."
fi

if [ ! -f "$BG3" ]; then
  log "Game binary missing: $BG3"
  exit 1
fi

log "Launching through Steam (game binary unchanged)."
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
