#!/usr/bin/env bash
# Prepare a self-contained SeedMask Coordinator installer for the current OS.
#
# Usage:
#   ./scripts/prepare_release.sh           # bundle runtime + package current OS
#   ./scripts/prepare_release.sh --runtime-only
#   ./scripts/prepare_release.sh --skip-runtime   # dev: system Python OK

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -f "$ELECTRON_DIR/package.json" ]]; then
  echo "error: run from SeedMask_Coordinator/electron" >&2
  echo "  cd SeedMask_Coordinator/electron && npm run release" >&2
  echo "  or: bash SeedMask_Coordinator/release.sh" >&2
  exit 1
fi

bash "$SCRIPT_DIR/preflight.sh"
COORD="$(cd "$ELECTRON_DIR/.." && pwd)"
REPO="$(cd "$COORD/.." && pwd)"
if [[ -d "$REPO/SeedMask_Firmware/tools" ]]; then
  FIRMWARE_TOOLS="$REPO/SeedMask_Firmware/tools"
elif [[ -d "$REPO/SeedMask Firmware/tools" ]]; then
  FIRMWARE_TOOLS="$REPO/SeedMask Firmware/tools"
else
  FIRMWARE_TOOLS=""
fi
APP_VERSION="$(cd "$ELECTRON_DIR" && node -p "require('./package.json').version")"
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"

RUNTIME_ONLY=0
SKIP_RUNTIME=0
for arg in "$@"; do
  case "$arg" in
    --runtime-only) RUNTIME_ONLY=1 ;;
    --skip-runtime) SKIP_RUNTIME=1 ;;
  esac
done

echo "SeedMask Coordinator release prep v$APP_VERSION"
echo "Build stamp: $STAMP"

mkdir -p "$ELECTRON_DIR/build"
bash "$SCRIPT_DIR/sync_app_icon.sh"
echo "$APP_VERSION" > "$COORD/VERSION.txt"
echo "build $STAMP" > "$COORD/BUILD_STAMP.txt"

echo "Syncing SeedMask tools into coordinator/tools…"
mkdir -p "$COORD/tools"
if [[ -n "$FIRMWARE_TOOLS" ]]; then
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$FIRMWARE_TOOLS/" "$COORD/tools/"
  else
    # Windows CI often has no rsync — copy is enough for a clean tools tree.
    rm -rf "$COORD/tools"
    mkdir -p "$COORD/tools"
    cp -a "$FIRMWARE_TOOLS"/. "$COORD/tools/"
  fi
elif [[ -d "$COORD/tools" ]] && compgen -G "$COORD/tools/*" >/dev/null; then
  echo "warn: firmware tools folder not found — using existing coordinator/tools"
else
  echo "error: missing firmware tools (expected SeedMask_Firmware/tools next to SeedMask_Coordinator)" >&2
  exit 1
fi

if [[ "$SKIP_RUNTIME" -eq 0 ]]; then
  bash "$SCRIPT_DIR/bundle_runtime.sh" "$ELECTRON_DIR/build/runtime"
fi

if [[ "$RUNTIME_ONLY" -eq 1 ]]; then
  echo "Runtime bundled (--runtime-only). Skipping electron packaging."
  exit 0
fi

cd "$ELECTRON_DIR"
npm run build

# Rebuild native USB/HID addons against this Electron ABI (required for Ledger in the .app).
# On Windows CI, do not rebuild @abandonware/noble (VS2026 WinRT break). USB/HID only.
if [[ -f "$ELECTRON_DIR/node_modules/.bin/electron-rebuild" ]] || npx --no-install electron-rebuild --version >/dev/null 2>&1; then
  echo "Rebuilding node-hid/usb for Electron…"
  UNAME_S="$(uname -s 2>/dev/null || true)"
  if [[ "${OS:-}" == "Windows_NT" || "$UNAME_S" == MINGW* || "$UNAME_S" == MSYS* || "$UNAME_S" == CYGWIN* ]]; then
    npx electron-rebuild -f --only usb,node-hid
  else
    npx electron-rebuild -f -w node-hid,usb
  fi
else
  echo "warn: @electron/rebuild not available — Ledger USB may fail in the packaged app"
fi

case "$(uname -s)" in
  Darwin) npm run package:mac ;;
  Linux) npm run package:linux ;;
  MINGW*|MSYS*|CYGWIN*) npm run package:win ;;
  *)
    if [[ "${OS:-}" == "Windows_NT" ]]; then
      npm run package:win
    else
      npm run package
    fi
    ;;
esac

if [[ "$(uname -s)" == Darwin ]]; then
  APP="$ELECTRON_DIR/release/mac-arm64/SeedMask Coordinator.app"
  if [[ -d "$APP" ]]; then
    # Do NOT run recursive xattr on the Desktop build tree — that triggers TCC.
    # Quarantine is cleared only after copying into /Applications.
    bash "$SCRIPT_DIR/install_to_applications.sh" || true
  fi
fi

echo ""
echo "Installers written to: $ELECTRON_DIR/release/"
ls -la "$ELECTRON_DIR/release/" 2>/dev/null || true

if [[ "$SKIP_RUNTIME" -eq 0 ]]; then
  bash "$SCRIPT_DIR/smoke_test_backend.sh" "$ELECTRON_DIR/build/runtime" "$COORD"
fi

# Local Mac website sync only — CI ships installer assets via the Release workflow.
if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  bash "$SCRIPT_DIR/sync_website_downloads.sh" 2>/dev/null || true
fi