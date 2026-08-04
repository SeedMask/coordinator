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
need rsync
need tar

# Python 3.10–3.13 for bundled runtime
PY=""
for C in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$C" >/dev/null 2>&1; then
    if "$C" -c 'import sys; exit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)' 2>/dev/null; then
      PY="$C"
      break
    fi
  fi
done
[[ -n "$PY" ]] || die "Need Python 3.10–3.13 on PATH (brew install python@3.13)"

echo "[preflight] ok ($("$PY" --version), node $(node -v))"
echo "[preflight] full release takes several minutes on first run (pip + ~300MB installer)"
echo ""
