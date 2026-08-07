#!/usr/bin/env bash
# Download rusty-kaspa WASM v2 Node SDK for PSKT/PSKB validation.
# Run: bash SeedPass_UI_Shell/tools/kaspa_wasm_node/setup_kaspa_wasm.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
SDK_VER="${KASPA_WASM_SDK_VERSION:-v2.0.1}"
SDK_ZIP="kaspa-wasm32-sdk-${SDK_VER}.zip"
SDK_URL="https://github.com/kaspanet/rusty-kaspa/releases/download/${SDK_VER}/${SDK_ZIP}"

if [[ -f sdk_v2/kaspa.js && -f sdk_v2/kaspa_bg.wasm ]]; then
  echo "kaspa WASM SDK already present in $ROOT/sdk_v2"
  exit 0
fi

echo "Downloading $SDK_URL …"
curl -fsSL "$SDK_URL" -o "$SDK_ZIP"
unzip -qo "$SDK_ZIP" "kaspa-wasm32-sdk/nodejs/kaspa/*" -d .
rm -rf sdk_v2
mkdir -p sdk_v2
mv kaspa-wasm32-sdk/nodejs/kaspa/* sdk_v2/
rm -rf kaspa-wasm32-sdk "$SDK_ZIP"
echo "Installed rusty-kaspa WASM SDK $SDK_VER → $ROOT/sdk_v2"
