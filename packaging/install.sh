#!/usr/bin/env bash
# Install ModSync on SteamOS / Linux, add it to Steam and apply library art.
set -euo pipefail

REPO="Winde/mod-sync-steamos"
APP_NAME="ModSync"
INSTALL_DIR="${HOME}/Applications"
APPIMAGE="${INSTALL_DIR}/ModSync.AppImage"
ICON_DIR="${HOME}/.local/share/icons/hicolor/512x512/apps"
ICON="${ICON_DIR}/modsync.png"
DESKTOP_DIR="${HOME}/.local/share/applications"
DESKTOP="${DESKTOP_DIR}/modsync.desktop"
DATA_DIR="${HOME}/ModSync"

VERSION=""
ADD_TO_STEAM=1
UNINSTALL=0
PURGE=0
FORCE_ART=0
PC_URL=""
TOKEN=""

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
say() { printf '==> %s\n' "$*"; }

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --version vX.Y.Z   Install a specific release (default: latest)
  --pc <url>         PC pack server URL, e.g. http://192.168.1.20:8787
  --token <token>    PC pack server token
  --no-steam         Install the app but do not add a Steam shortcut
  --force-art        Replace library artwork changed in Steam with the packaged set
  --uninstall        Remove the AppImage, desktop entry and icon (keeps packs)
  --purge            With --uninstall, also remove ~/ModSync and installed packs
  -h, --help         Show this help

Run this in Desktop Mode with Steam running. It installs to
~/Applications/ModSync.AppImage and keeps packs in ~/ModSync.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --pc) [ $# -ge 2 ] || die "--pc needs a value"; PC_URL="$2"; shift 2 ;;
    --pc=*) PC_URL="${1#*=}"; shift ;;
    --token) [ $# -ge 2 ] || die "--token needs a value"; TOKEN="$2"; shift 2 ;;
    --token=*) TOKEN="${1#*=}"; shift ;;
    --no-steam) ADD_TO_STEAM=0; shift ;;
    --force-art) FORCE_ART=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] && die "do not run this as root"

if [ "$UNINSTALL" -eq 1 ]; then
  rm -f "$APPIMAGE" "$ICON" "$DESKTOP"
  if [ "$PURGE" -eq 1 ]; then
    rm -rf "$DATA_DIR"
    say "Removed ~/ModSync and installed packs"
  else
    say "Removed the AppImage, desktop entry and icon; packs in ~/ModSync are kept"
  fi
  say "Remove the ModSync shortcut from Steam if it is still listed."
  exit 0
fi

for cmd in curl sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing required command: $cmd"
done

if [ -z "$VERSION" ]; then
  say "Resolving the latest release"
  VERSION="$(curl -fsSIL -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO}/releases/latest" | sed 's#.*/tag/##')" \
    || die "could not reach GitHub"
fi
VERSION="${VERSION#v}"
[ -n "$VERSION" ] || die "could not determine the release version"
TAG="v${VERSION}"
APPIMAGE_NAME="ModSync-Client-${VERSION}-x86_64.AppImage"
BASE="https://github.com/${REPO}/releases/download/${TAG}"

say "Installing ModSync ${VERSION}"
mkdir -p "$INSTALL_DIR" "$ICON_DIR" "$DESKTOP_DIR" "$DATA_DIR" "$DATA_DIR/logs"

PART="${APPIMAGE}.part"
cleanup() { rm -f "$PART"; }
trap cleanup EXIT

say "Downloading ${APPIMAGE_NAME}"
curl -fL --retry 3 --progress-bar -o "$PART" "${BASE}/${APPIMAGE_NAME}" || die "download failed"

say "Verifying the checksum"
SUMS="$(mktemp)"
curl -fsSL --retry 3 -o "$SUMS" "${BASE}/SHA256SUMS.txt" || die "could not download SHA256SUMS.txt"
expected="$(grep -F "  ${APPIMAGE_NAME}" "$SUMS" | awk '{print $1}' | head -n1)"
[ -n "$expected" ] || die "SHA256SUMS.txt does not list ${APPIMAGE_NAME}"
actual="$(sha256sum "$PART" | awk '{print $1}')"
[ "$expected" = "$actual" ] || die "checksum mismatch for ${APPIMAGE_NAME}"
rm -f "$SUMS"

chmod 755 "$PART"
mv -f "$PART" "$APPIMAGE"
trap - EXIT
say "Installed ${APPIMAGE}"

if ( cd "$INSTALL_DIR" \
  && "$APPIMAGE" --appimage-extract 'usr/share/icons/hicolor/512x512/apps/modsync.png' \
       >/dev/null 2>&1 ); then
  cp "$INSTALL_DIR/squashfs-root/usr/share/icons/hicolor/512x512/apps/modsync.png" "$ICON"
  rm -rf "$INSTALL_DIR/squashfs-root"
  say "Installed the icon"
else
  say "Could not extract the icon; the desktop entry will use a generic icon"
fi

if [ ! -f "$DESKTOP" ]; then
  exec_path="${APPIMAGE//\\/\\\\}"
  exec_path="${exec_path//\"/\\\"}"
  {
    printf '[Desktop Entry]\n'
    printf 'Type=Application\n'
    printf 'Name=%s\n' "$APP_NAME"
    printf 'Comment=Mod pack sync for SteamOS\n'
    printf 'Exec="%s"\n' "$exec_path"
    if [ -f "$ICON" ]; then printf 'Icon=%s\n' "$ICON"; fi
    printf 'Terminal=false\n'
    printf 'Categories=Utility;Game;\n'
    printf 'StartupWMClass=modsync\n'
  } > "$DESKTOP"
  chmod 644 "$DESKTOP"
  say "Wrote ${DESKTOP}"
else
  say "Kept the existing desktop entry ${DESKTOP}"
fi

if [ -n "$PC_URL" ]; then
  printf '{"pcUrl":"%s","token":"%s","root":"%s","port":8788}\n' "$PC_URL" "$TOKEN" "$DATA_DIR" > "$DATA_DIR/agent.json"
  chmod 600 "$DATA_DIR/agent.json"
  say "Wrote ${DATA_DIR}/agent.json"
fi

if [ "$ADD_TO_STEAM" -eq 0 ]; then
  say "Skipped the Steam shortcut (--no-steam)"
  exit 0
fi

shortcut_files() {
  find \
    "$HOME/.local/share/Steam/userdata" \
    "$HOME/.steam/steam/userdata" \
    "$HOME/.var/app/com.valvesoftware.Steam/.local/share/Steam/userdata" \
    -path '*/config/shortcuts.vdf' -type f -print0 2>/dev/null || true
}

has_shortcut() {
  grep -a -q -F "$DESKTOP" "$1" 2>/dev/null || grep -a -q -F "$APPIMAGE" "$1" 2>/dev/null
}

shortcut_path=""
shortcut_existed=0
while IFS= read -r -d '' file; do
  if has_shortcut "$file"; then
    shortcut_path="$file"
    shortcut_existed=1
    break
  fi
done < <(shortcut_files)

if [ -z "$shortcut_path" ]; then
  if command -v steamos-add-to-steam >/dev/null 2>&1; then
    say "Adding the Steam shortcut"
    steamos-add-to-steam "$DESKTOP" >/dev/null 2>&1 || say "steamos-add-to-steam failed; add it from Steam's Games menu"
  else
    say "Adding the Steam shortcut through steam://addnonsteamgame"
    touch /tmp/addnonsteamgamefile
    encoded=""
    if command -v python3 >/dev/null 2>&1; then
      encoded="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$DESKTOP")"
    fi
    if [ -n "$encoded" ]; then
      if command -v steam >/dev/null 2>&1; then
        steam "steam://addnonsteamgame/${encoded}" >/dev/null 2>&1 || true
      else
        xdg-open "steam://addnonsteamgame/${encoded}" >/dev/null 2>&1 || true
      fi
    else
      say "python3 is missing; add the shortcut from Steam's Games menu"
    fi
  fi

  say "Waiting for Steam to write the shortcut"
  for _ in $(seq 1 30); do
    while IFS= read -r -d '' file; do
      if has_shortcut "$file"; then
        shortcut_path="$file"
        break 2
      fi
    done < <(shortcut_files)
    sleep 1
  done
fi

if [ -z "$shortcut_path" ]; then
  say "The shortcut was not found."
  say "Add it in Steam (Games -> Add a Non-Steam Game), then run this script again to apply artwork."
  exit 0
fi
[ "$shortcut_existed" -eq 1 ] && say "Reusing the existing Steam shortcut" || say "Found the Steam shortcut"

appid=""
if command -v python3 >/dev/null 2>&1; then
  appid="$(python3 - "$shortcut_path" "$DESKTOP" "$APPIMAGE" <<'PY'
import struct
import sys

path, *targets = sys.argv[1:]
data = open(path, 'rb').read()
for target in targets:
    needle = target.encode()
    start = 0
    while True:
        idx = data.find(needle, start)
        if idx < 0:
            break
        marker = data.rfind(b'\x02appid\x00', 0, idx)
        if marker >= 0:
            entry_start = data.rfind(b'\x08\x08', 0, marker)
            if marker > entry_start:
                print(struct.unpack_from('<I', data, marker + 7)[0])
                raise SystemExit(0)
        start = idx + 1
raise SystemExit(1)
PY
)" || true
fi

if [ -z "$appid" ]; then
  say "Could not read the shortcut appid; artwork was skipped"
  exit 0
fi

if ! command -v unzip >/dev/null 2>&1; then
  say "unzip is not installed; artwork was skipped"
  exit 0
fi

say "Applying Steam artwork"
ART="$(mktemp -d)"
if curl -fsSL --retry 3 -o "$ART/steam-art.zip" "${BASE}/steam-art.zip"; then
  unzip -q "$ART/steam-art.zip" -d "$ART"
  GRID="$(dirname "$shortcut_path")/grid"
  mkdir -p "$GRID"
  for pair in \
    "hero.png:${appid}_hero.png" \
    "portrait.png:${appid}p.png" \
    "header.png:${appid}.png" \
    "logo.png:${appid}_logo.png" \
    "icon.png:${appid}_icon.png"; do
    src="${pair%%:*}"
    dst="${pair#*:}"
    if [ -f "$GRID/$dst" ] && [ "$FORCE_ART" -eq 0 ]; then
      continue
    fi
    [ -f "$ART/$src" ] && cp -f "$ART/$src" "$GRID/$dst"
  done
  say "Artwork applied"
else
  say "Could not download steam-art.zip; artwork was skipped"
fi
rm -rf "$ART"

say "Done. Switch to Game Mode and launch ModSync from Non-Steam."
