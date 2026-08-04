"""Safe parsing for UTXO / address indices (index 0 must not become -1)."""

from __future__ import annotations

from typing import Any


def as_address_index(value: Any, default: int = -1) -> int:
    """Parse an address index. Unlike ``int(x or -1)``, preserves legitimate 0."""
    if value is None or value is False:
        return default
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if value != value:  # NaN
            return default
        return int(value)
    text = str(value).strip()
    if not text:
        return default
    try:
        return int(text, 10)
    except (TypeError, ValueError):
        try:
            return int(float(text))
        except (TypeError, ValueError):
            return default
