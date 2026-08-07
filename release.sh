#!/usr/bin/env bash
# Run from anywhere inside the repo — builds a self-contained SeedMask Coordinator installer.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ELECTRON="$ROOT/electron"

if [[ ! -f "$ELECTRON/package.json" ]]; then
  echo "error: expected $ELECTRON/package.json" >&2
  echo "Usage: bash SeedMask_Coordinator/release.sh" >&2
  exit 1
fi

echo "→ SeedMask Coordinator release"
echo "→ Electron app: $ELECTRON"
echo ""

cd "$ELECTRON"

if [[ ! -d node_modules ]]; then
  echo "→ npm install (first time)…"
  npm install
fi

exec npm run release "$@"
