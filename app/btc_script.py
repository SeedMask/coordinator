"""Bitcoin script type labels matching SeedMask export UI."""

from __future__ import annotations

import re

SCRIPT_TYPES = frozenset({"native_segwit", "nested_segwit", "legacy", "taproot"})
DEFAULT_MULTISIG_COSIGNER_DERIVATION = "m/48'/0'/0'/2'"

_DISPLAY = {
    "native_segwit": "Native SegWit",
    "nested_segwit": "Nested SegWit",
    "legacy": "Legacy",
    "taproot": "Taproot",
}

_PURPOSE = {
    "native_segwit": "84",
    "nested_segwit": "49",
    "legacy": "44",
    "taproot": "86",
}


def script_type_display(script_type: str | None) -> str:
    key = (script_type or "").strip().lower()
    return _DISPLAY.get(key, "")


def script_type_from_derivation(derivation: str | None) -> str:
    path = (derivation or "").strip().lower()
    if not path.startswith("m/"):
        return ""
    if "/86'" in path or path.startswith("m/86'"):
        return "taproot"
    if "/48'" in path or path.startswith("m/48'"):
        if "/2'" in path:
            return "native_segwit"
        if "/1'" in path:
            return "nested_segwit"
    if "/45'" in path or path.startswith("m/45'"):
        return "legacy"
    if "/49'" in path or path.startswith("m/49'"):
        return "nested_segwit"
    if "/44'" in path or path.startswith("m/44'"):
        return "legacy"
    if "/84'" in path or path.startswith("m/84'"):
        return "native_segwit"
    return ""


def policy_type_from_derivation(derivation: str | None) -> str:
    path = (derivation or "").strip().lower()
    if "/48'" in path or "/45'" in path:
        return "multisig"
    return "singlesig"


def multisig_derivation_prefix(script_type: str, account: int = 0) -> str:
    st = (script_type or "").strip().lower()
    if st == "native_segwit":
        return f"m/48'/0'/{account}'/2'"
    if st == "nested_segwit":
        return f"m/48'/0'/{account}'/1'"
    if st == "legacy":
        return f"m/45'/{account}"
    return f"m/48'/0'/{account}'/2'"


def script_type_from_xpub_prefix(prefix: str) -> str:
    """Infer script type from SLIP-132 prefix only when unambiguous.

    Bare xpub/tpub is used for Legacy, Taproot, and many Native SegWit exports —
    do not force Legacy.
    """
    p = (prefix or "").strip().lower()[:4]
    if p in {"zpub", "vpub"}:
        return "native_segwit"
    if p in {"ypub", "upub"}:
        return "nested_segwit"
    return ""


def derivation_prefix(script_type: str) -> str:
    purpose = _PURPOSE.get((script_type or "").strip().lower())
    if not purpose:
        return "m/84'/0'"
    return f"m/{purpose}'/0'"


def parse_multisig_quorum(policy: str | None) -> tuple[int, int] | None:
    """Parse SeedMask / Sparrow policy text (e.g. '2 of 3', '2of3', sortedmulti(2,...))."""
    if not policy:
        return None
    norm = "".join(ch for ch in policy if ch not in " \t\r\n")
    if not norm:
        return None
    m = re.match(r"^(\d+)of(\d+)$", norm, re.IGNORECASE)
    if m:
        required, total = int(m.group(1)), int(m.group(2))
        if validate_multisig_quorum(required, total):
            return required, total
    sm = re.search(r"sortedmulti\((\d+)", norm, re.IGNORECASE)
    if sm:
        required = int(sm.group(1))
        keys = norm.count("xpub") + norm.count("ypub") + norm.count("zpub")
        if keys >= required and validate_multisig_quorum(required, keys):
            return required, keys
    return None


def validate_multisig_quorum(required: int, total: int) -> bool:
    return 1 <= required <= 15 and required <= total <= 15


def format_multisig_policy(required: int, total: int) -> str:
    if not validate_multisig_quorum(required, total):
        raise ValueError("Invalid multisig quorum — use 1–15 signatures, total ≥ required")
    return f"{required}of{total}"
