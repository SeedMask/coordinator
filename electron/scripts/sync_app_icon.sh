#!/usr/bin/env bash
# Verify Electron app icons exist for dev + electron-builder.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD="$ELECTRON_DIR/build"

mkdir -p "$BUILD"

if [[ ! -f "$BUILD/icon.png" ]]; then
  echo "warn: no app icon in $BUILD - expected electron/build/icon.png" >&2
  exit 0
fi
if [[ ! -f "$BUILD/icon.icns" ]]; then
  echo "warn: no macOS app icon in $BUILD - expected electron/build/icon.icns" >&2
  exit 0
fi

if [[ ! -d "$BUILD/runtime/python" ]]; then
  echo "note: dev will use system Python until bundled runtime exists."
  echo "      For release packaging run: npm run bundle:runtime"
fi

echo "Electron app icons ready -> $BUILD"
