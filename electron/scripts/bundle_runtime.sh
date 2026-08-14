#!/usr/bin/env bash
# Bundle Python venv + Node + Kaspa WASM into a self-contained runtime directory.
# Run on the target OS before packaging (Mac builds Mac runtime, etc.).
#
# Usage: bundle_runtime.sh [output_dir]
# Default output: electron/build/runtime

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COORD="$(cd "$ELECTRON_DIR/.." && pwd)"
REPO="$(cd "$COORD/.." && pwd)"
RUNTIME="${1:-$ELECTRON_DIR/build/runtime}"
if [[ -d "$REPO/SeedMask_Firmware/tools/kaspa_wasm_node" ]]; then
  TOOLS_WASM="$REPO/SeedMask_Firmware/tools/kaspa_wasm_node"
elif [[ -d "$REPO/SeedMask Firmware/tools/kaspa_wasm_node" ]]; then
  TOOLS_WASM="$REPO/SeedMask Firmware/tools/kaspa_wasm_node"
else
  TOOLS_WASM="$COORD/tools/kaspa_wasm_node"
fi
NODE_VER="22.16.0"
CACHE_DIR="$ELECTRON_DIR/.cache"
# Portable CPython (no dependency on python.org install on the user's machine).
PYTHON_STANDALONE_TAG="${PYTHON_STANDALONE_TAG:-20260623}"
PYTHON_STANDALONE_VERSION="${PYTHON_STANDALONE_VERSION:-3.13.14}"

mkdir -p "$RUNTIME" "$CACHE_DIR"

detect_os_arch() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    darwin)
      case "$arch" in
        arm64) echo "darwin arm64" ;;
        x86_64) echo "darwin x64" ;;
        *) echo "unsupported darwin $arch" >&2; exit 1 ;;
      esac
      ;;
    linux)
      case "$arch" in
        x86_64|amd64) echo "linux x64" ;;
        aarch64|arm64) echo "linux arm64" ;;
        *) echo "unsupported linux $arch" >&2; exit 1 ;;
      esac
      ;;
    mingw*|msys*|cygwin*|windows*)
      echo "win32 x64"
      ;;
    *)
      if [[ "${OS:-}" == "Windows_NT" ]]; then
        echo "win32 x64"
      else
        echo "unsupported OS: $os" >&2
        exit 1
      fi
      ;;
  esac
}

read -r PLATFORM ARCH <<< "$(detect_os_arch)"

echo "==> Platform: $PLATFORM $ARCH"
echo "==> Output:   $RUNTIME"

echo "==> Python runtime (standalone CPython + pip deps)…"
PYDIR="$RUNTIME/python"
rm -rf "$PYDIR"

resolve_python_standalone_triple() {
  case "$PLATFORM:$ARCH" in
    darwin:arm64) echo "aarch64-apple-darwin" ;;
    darwin:x64) echo "x86_64-apple-darwin" ;;
    linux:arm64) echo "aarch64-unknown-linux-gnu" ;;
    linux:x64) echo "x86_64-unknown-linux-gnu" ;;
    win32:x64) echo "x86_64-pc-windows-msvc" ;;
    *)
      echo "error: no standalone Python build for $PLATFORM $ARCH" >&2
      return 1
      ;;
  esac
}

bundle_standalone_python() {
  local triple tarball url cache extract_root
  triple="$(resolve_python_standalone_triple)"
  tarball="cpython-${PYTHON_STANDALONE_VERSION}+${PYTHON_STANDALONE_TAG}-${triple}-install_only_stripped.tar.gz"
  url="https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_STANDALONE_TAG}/${tarball}"
  cache="$CACHE_DIR/$tarball"
  extract_root="$RUNTIME/.python_extract"
  rm -rf "$extract_root"
  mkdir -p "$extract_root"

  if [[ ! -f "$cache" ]]; then
    echo "    Downloading $url"
    curl -fsSL "$url" -o "$cache"
  fi

  tar -xzf "$cache" -C "$extract_root"
  if [[ ! -d "$extract_root/python" ]]; then
    echo "error: expected python/ directory in $tarball" >&2
    exit 1
  fi
  mv "$extract_root/python" "$PYDIR"
  rm -rf "$extract_root"

  if [[ "$PLATFORM" == "darwin" ]]; then
    if otool -L "$PYDIR/bin/python3" | grep -q '/Library/Frameworks/Python.framework/'; then
      echo "error: bundled python still links to system Python.framework — aborting" >&2
      exit 1
    fi
  fi

  if [[ "$PLATFORM" == "win32" ]]; then
    "$PYDIR/python.exe" -m pip install --upgrade pip wheel
    "$PYDIR/python.exe" -m pip install -r "$COORD/requirements.txt"
    echo "    Python: $("$PYDIR/python.exe" --version)"
  else
    "$PYDIR/bin/python3" -m pip install --upgrade pip wheel
    "$PYDIR/bin/pip" install -r "$COORD/requirements.txt"
    echo "    Python: $("$PYDIR/bin/python3" --version)"
  fi
}

bundle_standalone_python

echo "==> Node runtime (PSKT validation)…"
NODE_DIR="$RUNTIME/node"
rm -rf "$NODE_DIR"
mkdir -p "$NODE_DIR"

case "$PLATFORM:$ARCH" in
  darwin:arm64) NODE_PKG="node-v${NODE_VER}-darwin-arm64" ;;
  darwin:x64) NODE_PKG="node-v${NODE_VER}-darwin-x64" ;;
  linux:x64) NODE_PKG="node-v${NODE_VER}-linux-x64" ;;
  linux:arm64) NODE_PKG="node-v${NODE_VER}-linux-arm64" ;;
  win32:x64) NODE_PKG="node-v${NODE_VER}-win-x64" ;;
  *) echo "error: no Node package for $PLATFORM $ARCH" >&2; exit 1 ;;
esac

NODE_CACHE="$CACHE_DIR/${NODE_PKG}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VER}/${NODE_PKG}.tar.gz"
if [[ ! -f "$NODE_CACHE" ]]; then
  echo "    Downloading $NODE_URL"
  curl -fsSL "$NODE_URL" -o "$NODE_CACHE"
fi
tar -xzf "$NODE_CACHE" -C "$NODE_DIR" --strip-components=1
if [[ "$PLATFORM" == "win32" ]]; then
  chmod +x "$NODE_DIR/node.exe" 2>/dev/null || true
  echo "    Node: $("$NODE_DIR/node.exe" --version)"
else
  chmod +x "$NODE_DIR/bin/node"
  echo "    Node: $("$NODE_DIR/bin/node" --version)"
fi

echo "==> Kaspa WASM SDK v2…"
WASM_DST="$RUNTIME/kaspa_wasm"
rm -rf "$WASM_DST"
mkdir -p "$WASM_DST"
if [[ ! -f "$TOOLS_WASM/sdk_v2/kaspa_bg.wasm" ]]; then
  bash "$TOOLS_WASM/setup_kaspa_wasm.sh"
fi
cp "$TOOLS_WASM/validate_pskt.mjs" "$WASM_DST/"
cp -R "$TOOLS_WASM/sdk_v2" "$WASM_DST/sdk_v2"
test -f "$WASM_DST/sdk_v2/kaspa_bg.wasm"

echo "==> Runtime OK → $RUNTIME"
