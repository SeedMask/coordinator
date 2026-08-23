#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "Missing '$1'. Install it and retry."
}

echo "[preflight] checking build tools…"
need bash
need node
need npm
need curl
need tar

# rsync is only needed when copying tools from a sibling firmware tree.
# Windows CI / standalone clones already ship coordinator/tools — cp is enough.
if ! command -v rsync >/dev/null 2>&1; then
  echo "[preflight] note: rsync not found (ok if coordinator/tools is already present)"
fi

# Host Python is only a convenience check; release bundles standalone CPython.
PY=""
for C in python3.13 python3.12 python3.11 python3.10 python3 py; do
  if command -v "$C" >/dev/null 2>&1; then
    if [[ "$C" == "py" ]]; then
      if py -3 -c 'import sys; exit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)' 2>/dev/null; then
        PY="py -3"
        break
      fi
    elif "$C" -c 'import sys; exit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)' 2>/dev/null; then
      PY="$C"
      break
    fi
  fi
done
if [[ -z "$PY" ]]; then
  echo "[preflight] warn: no host Python 3.10–3.13 (bundled standalone Python will still be used)"
else
  echo "[preflight] host python: $($PY --version 2>&1)"
fi

echo "[preflight] ok (node $(node -v))"
echo "[preflight] full release takes several minutes on first run (pip + trimmed runtime; ~200–220MB macOS installer typical)"
echo ""
