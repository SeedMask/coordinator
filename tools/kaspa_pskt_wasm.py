"""Official rusty-kaspa PSKT/PSKB validation via WASM v2 SDK (Node.js bridge)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

_TOOLS = Path(__file__).resolve().parent
_WASM_DIR = _TOOLS / "kaspa_wasm_node"
_SDK_DIR = _WASM_DIR / "sdk_v2"
_VALIDATE_JS = _WASM_DIR / "validate_pskt.mjs"
_SETUP_SH = _WASM_DIR / "setup_kaspa_wasm.sh"


def _bundled_wasm_dir() -> Path | None:
    """SeedMask Coordinator.app ships WASM under Resources/runtime/kaspa_wasm."""
    env = os.environ.get("SEEDMASK_WASM_DIR", "").strip()
    if env:
        p = Path(env)
        if (p / "sdk_v2" / "kaspa_bg.wasm").is_file():
            return p
    # Relative to coordinator root when launched from .app
    root = os.environ.get("SEEDMASK_COORDINATOR_ROOT", "").strip()
    if root:
        p = Path(root).parent / "runtime" / "kaspa_wasm"
        if (p / "sdk_v2" / "kaspa_bg.wasm").is_file():
            return p
    return None


def _wasm_workdir() -> Path:
    bundled = _bundled_wasm_dir()
    return bundled if bundled else _WASM_DIR


def _node_bin() -> str | None:
    """Prefer bundled Node (app), then SEEDMASK_NODE, then Homebrew — not Cursor."""
    for candidate in (
        os.environ.get("SEEDMASK_NODE"),
        os.environ.get("NODE_BIN"),
    ):
        if candidate and Path(candidate).is_file():
            if "Cursor.app" not in str(candidate):
                return str(candidate)
    # Bundled inside .app when coordinator runs from Resources
    root = os.environ.get("SEEDMASK_COORDINATOR_ROOT", "").strip()
    if root:
        bundled = Path(root).parent / "runtime" / "node" / "bin" / "node"
        if bundled.is_file():
            return str(bundled)
    for candidate in (
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        shutil.which("node"),
    ):
        if not candidate:
            continue
        path = Path(candidate)
        if not path.is_file():
            continue
        if "Cursor.app" in str(path):
            continue
        return str(path)
    return None


def wasm_sdk_ready() -> bool:
    work = _wasm_workdir()
    sdk = work / "sdk_v2" if work != _WASM_DIR else _SDK_DIR
    validate = work / "validate_pskt.mjs" if work != _WASM_DIR else _VALIDATE_JS
    return sdk.is_dir() and (sdk / "kaspa.js").is_file() and (sdk / "kaspa_bg.wasm").is_file() and validate.is_file()


def wasm_validate_ready() -> bool:
    return wasm_sdk_ready() and _node_bin() is not None


def ensure_wasm_sdk() -> None:
    """Run setup script if SDK not present (dev/build only)."""
    if wasm_sdk_ready():
        return
    if not _SETUP_SH.is_file():
        raise RuntimeError(f"Missing WASM setup script: {_SETUP_SH}")
    subprocess.run(["bash", str(_SETUP_SH)], check=True, cwd=str(_WASM_DIR))


def _run_validate(mode: str, value: str) -> dict[str, Any]:
    node = _node_bin()
    if not node:
        return {"ok": False, "error": "node not found"}
    if not wasm_validate_ready():
        return {"ok": False, "error": "kaspa WASM SDK not available"}
    work = _wasm_workdir()
    validate_js = work / "validate_pskt.mjs"
    proc = subprocess.run(
        [node, str(validate_js), mode, value],
        capture_output=True,
        text=True,
        cwd=str(work),
    )
    line = (proc.stdout or proc.stderr or "").strip().splitlines()
    out = line[-1] if line else ""
    try:
        result = json.loads(out)
    except json.JSONDecodeError:
        return {"ok": False, "error": out or f"validate exited {proc.returncode}"}
    if proc.returncode != 0 and result.get("ok"):
        result["ok"] = False
    return result


def validate_pskt_dict(pskt: dict[str, Any]) -> dict[str, Any]:
    """Parse-check PSKT inner JSON with rusty-kaspa WASM."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
        json.dump(pskt, tmp, separators=(",", ":"))
        path = tmp.name
    try:
        return _run_validate("--pskt-json", path)
    finally:
        Path(path).unlink(missing_ok=True)


def validate_pskt_hex(pskt_hex: str) -> dict[str, Any]:
    """Parse-check PSKT hex (PSKT + hex(json)) with rusty-kaspa WASM."""
    return _run_validate("--pskt-hex", pskt_hex.strip())


def validate_pskb_hex(pskb_hex: str) -> dict[str, Any]:
    """Parse-check PSKB bundle hex with rusty-kaspa WASM."""
    return _run_validate("--pskb-hex", pskb_hex.strip())


def require_valid_pskt(pskt: dict[str, Any]) -> None:
    """Raise ValueError if WASM rejects the PSKT."""
    res = validate_pskt_dict(pskt)
    if not res.get("ok"):
        raise ValueError(f"PSKT rejected by rusty-kaspa WASM: {res.get('error', res)}")
