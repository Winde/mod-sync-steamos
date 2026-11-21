#!/usr/bin/env bash
set -uo pipefail

ROOT="{{ROOT}}"
MOD="{{MOD}}"
GAME="{{GAME}}"
EXE="{{EXE}}"
GAME_PROCESS="{{GAME_PROCESS}}"
STEAM_APP_ID="{{STEAM_APP_ID}}"
SAVE_FILE="{{SAVE_FILE}}"
ME3="{{LOADER}}"
WIN64="{{LOADER_SUPPORT}}"

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
VER="$(cat "$ROOT/mods/$MOD/current.txt" 2>/dev/null || true)"
PROFILE="$ROOT/profiles/$MOD-$VER.me3"
LOG="$LOG_DIR/launch-$MOD-$(date +%Y%m%d-%H%M%S).log"

echo "Steam launch env: LD_PRELOAD=${LD_PRELOAD:-<unset>} SteamAppId=${SteamAppId:-<unset>} SteamGameId=${SteamGameId:-<unset>}" >>"$LOG"

# Steam starts non-Steam shortcuts with gameoverlayrenderer.so in LD_PRELOAD.
# me3 forwards that into the Steam Linux Runtime entry point, which can
# deadlock before the game starts. The terminal launch has no such preload.
unset LD_PRELOAD
export SteamAppId="$STEAM_APP_ID"
export SteamGameId="$STEAM_APP_ID"

if [ ! -x "$ME3" ]; then
  echo "me3 is not executable: $ME3" >>"$LOG"
  exit 1
fi
if [ ! -f "$PROFILE" ]; then
  echo "Profile missing: $PROFILE" >>"$LOG"
  exit 1
fi

game_running() {
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -x "$GAME_PROCESS" >/dev/null 2>&1
  else
    ps -eo comm= 2>/dev/null | grep -qx "$GAME_PROCESS"
  fi
}

"$ME3" --windows-binaries-dir "$WIN64" launch \
  -p "$PROFILE" \
  --exe "$GAME/$EXE" \
  --steam-id "$STEAM_APP_ID" \
  --online false \
  --savefile "$SAVE_FILE" >>"$LOG" 2>&1 &
ME3_PID=$!

# Wait for the game to appear, then for it to exit. Stop me3 afterwards so the
# dashboard/terminal does not keep a stale process around.
for _ in $(seq 1 180); do
  game_running && break
  kill -0 "$ME3_PID" 2>/dev/null || break
  sleep 1
done
while game_running; do sleep 2; done
sleep 2
pkill -P "$ME3_PID" 2>/dev/null || true
kill "$ME3_PID" 2>/dev/null || true
exit 0
