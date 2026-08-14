#!/usr/bin/env bash
# PSKT rusty-kaspa shape ↔ SeedMask JSON v2 self-test.
# Run from anywhere:  bash SeedMask_Coordinator/run_kaspa_pskt_roundtrip.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ ! -d .venv ]]; then
  echo "Creating coordinator venv in $ROOT/.venv …"
  python3 -m venv .venv
fi

echo "Ensuring rusty-kaspa WASM SDK (PSKT/PSKB validation) …"
if [[ -f "$ROOT/tools/kaspa_wasm_node/setup_kaspa_wasm.sh" ]]; then
  bash "$ROOT/tools/kaspa_wasm_node/setup_kaspa_wasm.sh"
elif [[ -f "$ROOT/../SeedMask_Firmware/tools/kaspa_wasm_node/setup_kaspa_wasm.sh" ]]; then
  bash "$ROOT/../SeedMask_Firmware/tools/kaspa_wasm_node/setup_kaspa_wasm.sh"
elif [[ -f "$ROOT/../SeedMask Firmware/tools/kaspa_wasm_node/setup_kaspa_wasm.sh" ]]; then
  bash "$ROOT/../SeedMask Firmware/tools/kaspa_wasm_node/setup_kaspa_wasm.sh"
else
  echo "error: missing tools/kaspa_wasm_node/setup_kaspa_wasm.sh (expected in this repo under tools/)" >&2
  exit 1
fi

echo "Running PSKT/PSKB round-trip …"
exec .venv/bin/python scripts/kaspa_pskt_roundtrip.py
