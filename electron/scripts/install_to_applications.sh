#!/usr/bin/env bash
# Install the packaged .app into /Applications so launch is outside ~/Desktop
# (avoids macOS Desktop Folder TCC prompts on every open).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$ELECTRON_DIR/release/mac-arm64/SeedMask Coordinator.app"
DEST="/Applications/SeedMask Coordinator.app"
DESKTOP_BUILD="$SRC"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: install_to_applications.sh is macOS-only" >&2
  exit 1
fi

if [[ ! -d "$SRC" ]]; then
  echo "error: packaged app not found at:" >&2
  echo "  $SRC" >&2
  echo "Run: npm run release   (or package:mac) first." >&2
  exit 1
fi

echo "Stopping SeedMask Coordinator…"
osascript -e 'quit app "SeedMask Coordinator"' 2>/dev/null || true
sleep 1
pkill -f "SeedMask Coordinator" 2>/dev/null || true
pkill -f "run_backend.py" 2>/dev/null || true
lsof -ti :18765 | xargs kill -9 2>/dev/null || true
sleep 1

echo "Installing SeedMask Coordinator → $DEST"
rm -rf "$DEST"
# ditto preserves resources better than cp -R for .app bundles
ditto "$SRC" "$DEST"
# Safe here: /Applications is not a TCC-protected folder.
xattr -cr "$DEST" 2>/dev/null || true

# Prefer /Applications in Launch Services; forget the Desktop build path so Dock
# / Spotlight do not keep reopening the TCC-triggering copy.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -u "$DESKTOP_BUILD" 2>/dev/null || true
  "$LSREGISTER" -f "$DEST" 2>/dev/null || true
fi

echo "Installed. Open with: open \"$DEST\""
echo "If the Dock icon still prompts for Desktop access: Cmd+Q, remove the Dock icon, then open from Applications."
