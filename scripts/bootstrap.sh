#!/usr/bin/env bash
set -euo pipefail

BASE="__BASE__"
TOKEN="__TOKEN__"
ROOT="${MODSYNC_ROOT:-$HOME/ModSync}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

mkdir -p "$ROOT"
echo "ModSync bootstrap from $BASE"
curl -fsSL "$BASE/bootstrap.tar.gz?token=$TOKEN" -o "$TMP"
tar -xzf "$TMP" -C "$ROOT"
bash "$ROOT/agent/install.sh" "$BASE" "$TOKEN"
