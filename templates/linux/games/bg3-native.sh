#!/usr/bin/env bash
set -uo pipefail

ROOT="{{ROOT}}"
GAME="{{GAME}}"
BG3LE="{{DATA_HOME}}/bg3le"
STEAM_APP_ID="{{STEAM_APP_ID}}"
GAME_PROCESS="{{GAME_PROCESS}}"

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/launch-bg3-native-$(date +%Y%m%d-%H%M%S).log"

if pgrep -x "$GAME_PROCESS" >/dev/null 2>&1 || pgrep -x bg3 >/dev/null 2>&1; then
  echo "Baldur's Gate 3 is already running." >>"$LOG"
  exit 0
fi

# Steam updates replace bin/bg3. Repair the wrapper before every launch from
# the modded entry so the next launch still preloads BG3LE.
if [ ! -f "$BG3LE/build/libbg3le.so" ] && [ -d "$ROOT/tools/bg3le" ]; then
  mkdir -p "$BG3LE"
  cp -a "$ROOT/tools/bg3le/." "$BG3LE/"
fi

BG3="$GAME/bin/bg3"
REAL="$GAME/bin/bg3.bg3le-real"
MARKER="# ModSync BG3LE wrapper"

if [ ! -f "$BG3" ]; then
  echo "Game binary missing: $BG3" >>"$LOG"
  exit 1
fi

if ! grep -qF "$MARKER" "$BG3" 2>/dev/null; then
  if [ -f "$REAL" ]; then
    mv -f "$BG3" "$REAL"
  else
    mv "$BG3" "$REAL"
  fi
  {
    echo '#!/bin/sh'
    echo "$MARKER"
    echo 'here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)'
    echo "so='$BG3LE/build/libbg3le.so'"
    echo 'if [ -f "$so" ]; then'
    echo '  case ":${LD_PRELOAD:-}:" in'
    echo '    *":$so:"*) ;;'
    echo '    *) LD_PRELOAD="${LD_PRELOAD:+$LD_PRELOAD:}$so"; export LD_PRELOAD ;;'
    echo '  esac'
    echo 'fi'
    echo 'exec "$here/bg3.bg3le-real" "$@"'
  } >"$BG3"
  chmod 755 "$BG3"
  echo "Repaired BG3LE wrapper at $BG3" >>"$LOG"
fi

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
