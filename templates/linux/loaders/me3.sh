#!/usr/bin/env bash
set -uo pipefail

ROOT="{{ROOT}}"
MOD="{{MOD}}"
GAME="{{GAME}}"
EXE="{{EXE}}"
GAME_PROCESSES="{{GAME_PROCESSES}}"
STEAM_APP_ID="{{STEAM_APP_ID}}"
SAVE_FILE="{{SAVE_FILE}}"
ME3="{{LOADER}}"
WIN64="{{LOADER_SUPPORT}}"
LOADER_REL="{{LOADER_REL}}"
LOADER_SUPPORT_REL="{{LOADER_SUPPORT_REL}}"
PROFILE_PATTERN="{{PROFILE_PATTERN}}"

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
VER="$(cat "$ROOT/mods/$MOD/current.txt" 2>/dev/null || true)"
if [ -n "$PROFILE_PATTERN" ]; then
  PROFILE_REL="${PROFILE_PATTERN//\{mod\}/$MOD}"
  PROFILE_REL="${PROFILE_REL//\{version\}/$VER}"
  PROFILE="$ROOT/$PROFILE_REL"
else
  PROFILE="$ROOT/profiles/$MOD-$VER.me3"
fi

# Prefer the loader snapshot that belongs to the selected version. Packs
# installed before snapshots existed fall back to the shared root runtime.
if [ -n "$LOADER_REL" ] && [ -x "$ROOT/mods/$MOD/versions/$VER/$LOADER_REL" ]; then
  ME3="$ROOT/mods/$MOD/versions/$VER/$LOADER_REL"
fi
if [ -n "$LOADER_SUPPORT_REL" ] && [ -d "$ROOT/mods/$MOD/versions/$VER/$LOADER_SUPPORT_REL" ]; then
  WIN64="$ROOT/mods/$MOD/versions/$VER/$LOADER_SUPPORT_REL"
fi
# Steam starts a non-Steam shortcut with SteamAppId set to the shortcut's own
# app id. Keep it before replacing the values for the game: Game Mode's
# gamescope focuses a window by matching STEAM_GAME against the ids Steam
# registered for the shortcut, and me3 starts Proton outside Steam's launch,
# so nothing else stamps the game window.
SHORTCUT_APP_ID="${SteamAppId:-}"
if [ -z "$SHORTCUT_APP_ID" ] || [ "$SHORTCUT_APP_ID" = "0" ]; then
  SHORTCUT_APP_ID=""
  case "${SteamGameId:-}" in
    ''|*[!0-9]*) ;;
    *)
      # SteamGameId may be the 64-bit game id with the app id in the high
      # bits; a plain app id has at most ten digits.
      if [ "${#SteamGameId}" -gt 10 ]; then
        SHORTCUT_APP_ID=$(( (SteamGameId >> 32) & 4294967295 ))
      else
        SHORTCUT_APP_ID="$SteamGameId"
      fi
      ;;
  esac
fi
case "$SHORTCUT_APP_ID" in
  ''|*[!0-9]*|0) SHORTCUT_APP_ID="" ;;
esac

LOG="$LOG_DIR/launch-$MOD-$(date +%Y%m%d-%H%M%S).log"

echo "Steam launch env: LD_PRELOAD=${LD_PRELOAD:-<unset>} SteamAppId=${SteamAppId:-<unset>} SteamGameId=${SteamGameId:-<unset>} DISPLAY=${DISPLAY:-<unset>} STEAM_GAME_DISPLAY_0=${STEAM_GAME_DISPLAY_0:-<unset>} STEAM_GAME_DISPLAY_1=${STEAM_GAME_DISPLAY_1:-<unset>} desktop=${XDG_CURRENT_DESKTOP:-<unset>}" >>"$LOG"

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
  for process in $GAME_PROCESSES; do
    if command -v pgrep >/dev/null 2>&1; then
      pgrep -x "$process" >/dev/null 2>&1 && return 0
    else
      ps -eo comm= 2>/dev/null | grep -qx "$process" && return 0
    fi
  done
  return 1
}

game_pids() {
  for process in $GAME_PROCESSES; do
    if command -v pgrep >/dev/null 2>&1; then
      pgrep -x "$process" 2>/dev/null || true
    else
      ps -eo pid=,comm= 2>/dev/null | awk -v name="$process" '$2 == name { print $1 }'
    fi
  done
}

# In Game Mode, gamescope shows the window whose STEAM_GAME app id Steam
# registered for the running shortcut. me3 starts Proton outside Steam's
# launch, so the game window never gets that property and gamescope keeps the
# Steam UI in front while the game runs behind it
# (https://github.com/garyttierney/me3/discussions/580). Stamp the game's
# windows with the shortcut id; Desktop Mode and other sessions need no help.
FOCUS_HELPER=0
if [ -n "$SHORTCUT_APP_ID" ] && command -v xprop >/dev/null 2>&1 && command -v xwininfo >/dev/null 2>&1; then
  case "${XDG_CURRENT_DESKTOP:-}${XDG_SESSION_DESKTOP:-}" in
    *gamescope*) FOCUS_HELPER=1 ;;
    *) [ "${SteamGamepadUI:-}" = "1" ] && FOCUS_HELPER=1 ;;
  esac
fi
if [ "$FOCUS_HELPER" = 1 ]; then
  echo "Gamescope focus helper enabled: STEAM_GAME=$SHORTCUT_APP_ID" >>"$LOG"
else
  echo "Gamescope focus helper skipped (shortcut=${SHORTCUT_APP_ID:-unset} desktop=${XDG_CURRENT_DESKTOP:-unset})" >>"$LOG"
fi

game_window_matches() {
  local display="$1" window="$2" pid game_pid
  # Proton names the window after the Steam app id it was started with.
  if xprop -display "$display" -id "$window" WM_CLASS 2>/dev/null |
      grep -qi "steam_app_${STEAM_APP_ID}"; then
    return 0
  fi
  # Fall back to the game process when the window class is something else.
  pid="$(xprop -display "$display" -id "$window" _NET_WM_PID 2>/dev/null |
    sed -n 's/.*= *\([0-9][0-9]*\).*/\1/p')"
  [ -n "$pid" ] || return 1
  for game_pid in $(game_pids); do
    [ "$game_pid" = "$pid" ] && return 0
  done
  return 1
}

stamp_game_windows() {
  [ "$FOCUS_HELPER" = 1 ] || return 0

  local displays display window current
  displays="${DISPLAY:-}"
  for display in "${STEAM_GAME_DISPLAY_0:-}" "${STEAM_GAME_DISPLAY_1:-}"; do
    [ -n "$display" ] || continue
    case " $displays " in
      *" $display "*) ;;
      *) displays="$displays $display" ;;
    esac
  done

  for display in $displays; do
    for window in $(xwininfo -display "$display" -root -children 2>/dev/null |
      awk '/^[[:space:]]+0x[0-9a-fA-F]+[[:space:]]/ { print $1 }'); do
      game_window_matches "$display" "$window" || continue
      current="$(xprop -display "$display" -id "$window" STEAM_GAME 2>/dev/null)"
      case "$current" in
        *"= $SHORTCUT_APP_ID"*) continue ;;
      esac
      if xprop -display "$display" -id "$window" -f STEAM_GAME 32c \
          -set STEAM_GAME "$SHORTCUT_APP_ID" 2>/dev/null; then
        echo "Gamescope focus: STEAM_GAME=$SHORTCUT_APP_ID on window $window ($display)" >>"$LOG"
      fi
    done
  done
}

"$ME3" --windows-binaries-dir "$WIN64" launch \
  -p "$PROFILE" \
  --exe "$GAME/$EXE" \
  --steam-id "$STEAM_APP_ID" \
  --online false \
  --savefile "$SAVE_FILE" >>"$LOG" 2>&1 &
ME3_PID=$!

# Wait for the game to appear, then for it to exit. Stamp new game windows on
# the way so gamescope can focus them. Stop me3 afterwards so the dashboard or
# terminal does not keep a stale process around.
for _ in $(seq 1 180); do
  stamp_game_windows
  game_running && break
  kill -0 "$ME3_PID" 2>/dev/null || break
  sleep 1
done
while game_running; do
  stamp_game_windows
  sleep 2
done
sleep 2
pkill -P "$ME3_PID" 2>/dev/null || true
kill "$ME3_PID" 2>/dev/null || true
exit 0
