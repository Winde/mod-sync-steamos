#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${1:?PC URL required}"
TOKEN="${2:-}"

mkdir -p "$ROOT/logs" "$ROOT/state" "$ROOT/packs" "$ROOT/launchers"
chmod +x "$ROOT/tools/node/bin/node" 2>/dev/null || true

cat > "$ROOT/agent.json" <<EOF
{"pcUrl":"$BASE","token":"$TOKEN","root":"$ROOT","port":8788}
EOF

sed -e "s|{{ROOT}}|$ROOT|g" -e "s|{{PORT}}|8788|g" \
  "$ROOT/agent/templates/linux/modsync-dashboard.sh" > "$ROOT/launchers/modsync-dashboard.sh"
chmod +x "$ROOT/launchers/modsync-dashboard.sh"

mkdir -p "$HOME/.local/share/applications" "$HOME/Desktop"
cat > "$HOME/.local/share/applications/ModSync.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=ModSync
Comment=Mod pack deployment
Exec=$ROOT/launchers/modsync-dashboard.sh
Path=$ROOT
Icon=$ROOT/web/icon.png
Terminal=false
Categories=Game;Utility;
EOF
cp "$HOME/.local/share/applications/ModSync.desktop" "$HOME/Desktop/ModSync.desktop"

if ! curl -fsS http://127.0.0.1:8788/api/health >/dev/null 2>&1; then
  nohup "$ROOT/tools/node/bin/node" "$ROOT/agent/bin/modsync.js" agent --config "$ROOT/agent.json" \
    >>"$ROOT/logs/agent.log" 2>&1 &
  for _ in $(seq 1 40); do
    curl -fsS http://127.0.0.1:8788/api/health >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

# TV-first: add the dashboard to Steam automatically when possible.
"$ROOT/tools/node/bin/node" "$ROOT/agent/bin/modsync.js" register \
  --exe "$ROOT/launchers/modsync-dashboard.sh" \
  --name "ModSync" \
  --icon "$ROOT/web/icon.png" \
  --grid "$ROOT/web/modsync-grid.png" \
  --hero "$ROOT/web/modsync-hero.png" \
  --logo "$ROOT/web/modsync-logo.png" >/dev/null 2>&1 || true

echo ""
echo "ModSync installed at $ROOT"
echo "Dashboard: http://127.0.0.1:8788"
echo "Add ~/Desktop/ModSync.desktop to Steam if it does not appear."
echo "Restart Steam if the shortcut is not visible."
echo ""
