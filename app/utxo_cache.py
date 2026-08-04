"""Persist last-known UTXO scan results per wallet (survives backend restarts / API blips)."""

from __future__ import annotations

import json
from pathlib import Path

from .wallet_store import DATA_DIR

_CACHE_DIR = DATA_DIR / "utxo_cache"


def _path(wallet_id: str) -> Path:
    return _CACHE_DIR / f"{wallet_id}.json"


def save_utxo_cache(wallet_id: str, *, utxos: list[dict], balance_sompi: int, coin: str, sync_status: str | None = None) -> None:
    """Persist UTXO scan results. Empty wallets must clear prior cache (swept funds)."""
    from . import wallet_state

    wallet_state.replace_utxos(wallet_id, utxos, coin=coin, sync_status=sync_status)
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = _path(wallet_id)
    if not utxos and balance_sompi <= 0:
        # Drop the JSON snapshot so a later hydrate cannot revive spent coins.
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        return
    payload = {
        "wallet_id": wallet_id,
        "coin": coin,
        "balance_sompi": balance_sompi,
        "utxos": utxos,
    }
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


def load_utxo_cache(wallet_id: str) -> dict | None:
    from . import wallet_state

    wallet_state.init_db()
    state = wallet_state.get_wallet_state(wallet_id, include_transactions=False)
    if state.get("utxos") or int(state.get("balance_sompi") or 0) > 0:
        coin = state.get("coin") or "kaspa"
        return {
            "wallet_id": wallet_id,
            "coin": coin,
            "balance_sompi": int(state.get("balance_sompi") or 0),
            "utxos": state.get("utxos") or [],
        }
    p = _path(wallet_id)
    if not p.is_file():
        return None
    try:
        with p.open(encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return None
        if not data.get("utxos") and int(data.get("balance_sompi") or 0) <= 0:
            return None
        return data
    except (json.JSONDecodeError, OSError, ValueError):
        return None


def delete_utxo_cache(wallet_id: str) -> None:
    from . import wallet_state

    wallet_state.delete_wallet_state(wallet_id)
    try:
        _path(wallet_id).unlink(missing_ok=True)
    except OSError:
        pass
