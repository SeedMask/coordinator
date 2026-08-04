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
bash ../SeedPass_UI_Shell/tools/kaspa_wasm_node/setup_kaspa_wasm.sh

echo "Running PSKT/PSKB round-trip …"
exec .venv/bin/python scripts/kaspa_pskt_roundtrip.py
