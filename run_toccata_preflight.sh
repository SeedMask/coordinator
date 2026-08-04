#!/usr/bin/env bash
# Toccata preflight: sighash vector + Kaspa SDK mass/fee checks.
# Run from anywhere:  bash SeedMask_Coordinator/run_toccata_preflight.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ ! -d .venv ]]; then
  echo "Creating coordinator venv in $ROOT/.venv …"
  python3 -m venv .venv
fi

echo "Installing / updating Python deps …"
.venv/bin/python -m pip install -q -r requirements.txt

echo "Running Toccata preflight …"
exec .venv/bin/python scripts/kaspa_toccata_preflight.py
