"""Read UTXO fields from either WalletUtxo objects or wallet_state dict rows."""

from __future__ import annotations

from typing import Any


def utxo_get(u: Any, name: str, default: Any = None) -> Any:
    if isinstance(u, dict):
        return u.get(name, default)
    return getattr(u, name, default)


def utxo_address(u: Any) -> str:
    return str(utxo_get(u, "address", "") or "").strip()


def utxo_address_index(u: Any) -> int:
    from .address_index_parse import as_address_index

    return as_address_index(utxo_get(u, "address_index", None), -1)

def utxo_is_change(u: Any) -> bool:
    return bool(utxo_get(u, "is_change", False))


def utxo_amount(u: Any) -> int:
    try:
        return int(utxo_get(u, "amount", 0) or 0)
    except (TypeError, ValueError):
        return 0


def utxo_transaction_id(u: Any) -> str:
    return str(utxo_get(u, "transaction_id", "") or "")
