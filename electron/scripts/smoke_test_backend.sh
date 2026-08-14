#!/usr/bin/env bash
# Smoke-test bundled Python backend before shipping.
set -euo pipefail

RUNTIME="${1:?usage: smoke_test_backend.sh <runtime_dir> <coordinator_root>}"
COORD="${2:?usage: smoke_test_backend.sh <runtime_dir> <coordinator_root>}"
PORT="${SMOKE_PORT:-18768}"

if [[ -x "$RUNTIME/python/bin/python3" ]]; then
  PY="$RUNTIME/python/bin/python3"
elif [[ -x "$RUNTIME/python/python.exe" ]]; then
  PY="$RUNTIME/python/python.exe"
elif [[ -x "$RUNTIME/python/Scripts/python.exe" ]]; then
  PY="$RUNTIME/python/Scripts/python.exe"
else
  echo "error: bundled python not found in $RUNTIME/python" >&2
  exit 1
fi

export SEEDMASK_COORDINATOR_ROOT="$COORD"
export SEEDMASK_COORDINATOR_PORT="$PORT"
export SEEDMASK_PYTHON="$PY"
export PYTHONPATH="${COORD}/tools:${PYTHONPATH:-}"
[[ -x "$RUNTIME/node/bin/node" ]] && export SEEDMASK_NODE="$RUNTIME/node/bin/node"
[[ -x "$RUNTIME/node/node.exe" ]] && export SEEDMASK_NODE="$RUNTIME/node/node.exe"
[[ -d "$RUNTIME/kaspa_wasm" ]] && export SEEDMASK_WASM_DIR="$RUNTIME/kaspa_wasm"

echo "Smoke-testing backend on port ${PORT}..."
# Keep smoke stderr separate so SIGTERM teardown noise does not pollute the release log.
SMOKE_ERR="$(mktemp -t seedmask-smoke.XXXXXX)"
set +m
"$PY" "$COORD/run_backend.py" >"$SMOKE_ERR" 2>&1 &
PID=$!
disown "$PID" 2>/dev/null || true
cleanup() {
  if kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL "$PID" 2>/dev/null || true
  fi
  wait "$PID" 2>/dev/null || true
  rm -f "$SMOKE_ERR"
}
trap cleanup EXIT

sleep 4
if curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null; then
  echo "  Backend API OK"
else
  echo "  WARNING: backend smoke test failed" >&2
  tail -12 "$SMOKE_ERR" 2>/dev/null || true
  tail -12 "$COORD/backend_stderr.log" 2>/dev/null || true
  exit 1
fi
echo "  Backend smoke test done"
