#!/usr/bin/env bash
# Copy electron-builder artifacts into website/downloads/ and refresh manifest.js
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WEBSITE_DL="$(cd "$ELECTRON_DIR/../website/downloads" && pwd)"
RELEASE="$ELECTRON_DIR/release"
VERSION="$(node -p "require('$ELECTRON_DIR/package.json').version")"
STAMP="$(date '+%Y-%m-%d')"

mkdir -p "$WEBSITE_DL"

pick() {
  find "$RELEASE" -maxdepth 1 -name "$1" -type f 2>/dev/null | head -1
}

copy_as() {
  local src="$1"
  local dest="$2"
  if [[ -f "$src" ]]; then
    cp "$src" "$WEBSITE_DL/$dest"
    echo "  copied $dest" >&2
    printf '%s' "$dest"
  fi
}

echo "Syncing release artifacts → website/downloads/"

MAC_DMG=""
MAC_ZIP=""
WIN_EXE=""
WIN_ZIP=""
LIN_AI=""
LIN_DEB=""

src="$(pick '*arm64.dmg')"; [[ -z "$src" ]] && src="$(pick '*.dmg')"
[[ -n "$src" ]] && MAC_DMG=$(copy_as "$src" "SeedMask-Coordinator-${VERSION}-mac.dmg")

src="$(pick '*mac*.zip')"; [[ -z "$src" ]] && src="$(pick '*arm64.zip')"
[[ -n "$src" ]] && MAC_ZIP=$(copy_as "$src" "SeedMask-Coordinator-${VERSION}-mac.zip")

src="$(pick '*win*.exe')"; [[ -n "$src" ]] && WIN_EXE=$(copy_as "$src" "SeedMask-Coordinator-${VERSION}-win.exe")
src="$(pick '*win*.zip')"; [[ -n "$src" ]] && WIN_ZIP=$(copy_as "$src" "SeedMask-Coordinator-${VERSION}-win.zip")
src="$(pick '*linux*.AppImage')"; [[ -n "$src" ]] && LIN_AI=$(copy_as "$src" "SeedMask-Coordinator-${VERSION}-linux.AppImage")
src="$(pick '*linux*.deb')"; [[ -n "$src" ]] && LIN_DEB=$(copy_as "$src" "SeedMask-Coordinator-${VERSION}-linux.deb")

js_str() {
  if [[ -n "$1" ]]; then printf '"%s"' "$1"; else printf 'null'; fi
}

cat > "$WEBSITE_DL/manifest.js" <<EOF
window.SEEDMASK_DOWNLOADS = {
  version: '${VERSION}',
  stamp: '${STAMP}',
  macDmg: $(js_str "$MAC_DMG"),
  macZip: $(js_str "$MAC_ZIP"),
  winExe: $(js_str "$WIN_EXE"),
  winZip: $(js_str "$WIN_ZIP"),
  linuxAppImage: $(js_str "$LIN_AI"),
  linuxDeb: $(js_str "$LIN_DEB"),
}
EOF

echo "manifest.js updated"
