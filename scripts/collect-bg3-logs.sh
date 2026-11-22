#!/usr/bin/env bash
# Collect the files needed to diagnose a native-Linux BG3 pack failure.
#
#   bash scripts/collect-bg3-logs.sh [output.tgz]
#
# The archive contains no saves and no account credentials: only the ModSync
# install logs, the BG3LE logs, BG3's own player log, the active modsettings,
# and a description of the game install.
set -uo pipefail

OUT="${1:-$HOME/bg3-logs-$(date +%Y%m%d-%H%M%S).tgz}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/modsync" "$TMP/pack" "$TMP/bg3le" "$TMP/game" "$TMP/system"

{
  date
  uname -a
  cat /etc/os-release 2>/dev/null
  echo "XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-}"
  echo "XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-}"
  echo "SteamGamepadUI=${SteamGamepadUI:-}"
  echo "DISPLAY=${DISPLAY:-}"
  echo "WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-}"
  echo "LD_PRELOAD=${LD_PRELOAD:-}"
  command -v steam >/dev/null 2>&1 && steam --version 2>/dev/null | head -n 3
  command -v python3 >/dev/null 2>&1 && python3 --version
  command -v flatpak >/dev/null 2>&1 && flatpak list --app 2>/dev/null | grep -i steam
  lspci -nn 2>/dev/null | grep -Ei 'vga|3d|display'
  glxinfo -B 2>/dev/null | head -n 20
  vulkaninfo --summary 2>/dev/null | head -n 40
} >"$TMP/system/system.txt" 2>&1

# If the whole machine rebooted, the previous boot's kernel log is the only
# place a GPU or driver crash appears.
journalctl -b -1 -p err --no-pager >"$TMP/system/previous-boot-errors.txt" 2>/dev/null || true
journalctl -k -b -1 --no-pager 2>/dev/null | tail -n 500 >"$TMP/system/previous-boot-kernel.txt" 2>/dev/null || true

cp -a "$HOME/ModSync/logs/." "$TMP/modsync/" 2>/dev/null || true

for root in "$HOME/ModSync/packs"/*; do
  [ -d "$root" ] || continue
  name="$(basename "$root")"
  mkdir -p "$TMP/pack/$name/logs"
  cp -a "$root/logs/." "$TMP/pack/$name/logs/" 2>/dev/null || true
  cp -a "$root/applied.json" "$root/pack.json" "$root/files.json" "$TMP/pack/$name/" 2>/dev/null || true
  find "$root/mods" -maxdepth 2 -name current.txt -exec cp -a {} "$TMP/pack/$name/" \; 2>/dev/null || true
done

mkdir -p "$TMP/bg3le/logs"
cp -a "$HOME/.local/share/bg3le/logs/." "$TMP/bg3le/logs/" 2>/dev/null || true
cp -a "$HOME/.local/share/bg3le/launch.log" "$HOME/.local/share/bg3le/version" "$TMP/bg3le/" 2>/dev/null || true
ls -laR "$HOME/.local/share/bg3le" >"$TMP/bg3le/tree.txt" 2>&1

DATA="${XDG_DATA_HOME:-$HOME/.local/share}/Larian Studios/Baldur's Gate 3"
cp -a "$DATA/Player.log" "$DATA/Player-prev.log" "$TMP/game/" 2>/dev/null || true
cp -a "$DATA/PlayerProfiles/Public/modsettings.lsx" "$TMP/game/" 2>/dev/null || true
ls -la "$DATA/Mods" >"$TMP/game/mods.txt" 2>&1
find "$DATA" -maxdepth 4 \( -iname '*crash*' -o -iname '*.dmp' \) >"$TMP/game/crash-files.txt" 2>/dev/null || true

GAME="$(find "$HOME/.steam" "$HOME/.local/share/Steam" -maxdepth 6 -type d -name 'Baldurs Gate 3' 2>/dev/null | head -n 1)"
if [ -n "$GAME" ]; then
  echo "$GAME" >"$TMP/game/install-path.txt"
  ls -la "$GAME/bin" >"$TMP/game/bin.txt" 2>&1
  file "$GAME/bin/bg3" "$GAME/bin/bg3.bg3le-real" >"$TMP/game/bin-file.txt" 2>&1 || true
  cp -a "$GAME/bin/gold.log" "$TMP/game/" 2>/dev/null || true
  find "$GAME/bin" -maxdepth 2 -type f \( -iname '*crash*' -o -iname '*.dmp' -o -iname '*.log' \) >"$TMP/game/game-log-files.txt" 2>/dev/null || true
fi

for vdf in "$HOME/.steam/steam/userdata"/*/config/localconfig.vdf \
           "$HOME/.local/share/Steam/userdata"/*/config/localconfig.vdf; do
  [ -f "$vdf" ] || continue
  echo "== $vdf" >>"$TMP/system/steam-launch-options.txt"
  grep -A 4 -B 1 '"1086940"' "$vdf" >>"$TMP/system/steam-launch-options.txt" 2>/dev/null || true
done

tar -czf "$OUT" -C "$TMP" .
echo "Wrote $OUT"
