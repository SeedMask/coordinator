"""Persist and incrementally refresh wallet transaction index."""

from __future__ import annotations

import logging

from . import wallet_state
from .address_pairs import bounded_address_pairs
from .transaction_history import fetch_wallet_transactions
from .tx_raw_cache import remember_wallet_tx_list
from .wallet_store import WalletConfig, resolved_wallet_coin

log = logging.getLogger(__name__)


async def sync_wallet_transactions(
    wallet_id: str,
    cfg: WalletConfig,
    utxos: list[dict] | None = None,
    *,
    replace: bool = False,
) -> list[dict]:
    """Fetch tx history from indexers and persist to wallet_state."""
    utxo_list = utxos if utxos is not None else wallet_state.get_utxos(wallet_id)
    receive, change = bounded_address_pairs(cfg, utxo_list or [])
    rows = await fetch_wallet_transactions(cfg, receive, change, utxo_list or [])
    dicts = [t.to_dict() for t in rows]
    coin = resolved_wallet_coin(cfg)
    if coin == "bitcoin":
        for d in dicts:
            btc = float(d.get("amount_kas") or 0)
            d["amount_btc"] = btc
            d["amount_sats"] = int(round(btc * 100_000_000))
    if replace or not wallet_state.get_transactions(wallet_id):
        wallet_state.replace_transactions(wallet_id, dicts)
    else:
        wallet_state.upsert_transactions(wallet_id, dicts)
    remember_wallet_tx_list(wallet_id, _raw_rows_from_history(rows))
    return dicts


def _raw_rows_from_history(rows) -> list[dict]:
    """Stubs only — rich vin/vout already stored via remember_wallet_txs during fetch."""
    out: list[dict] = []
    for row in rows:
        tid = getattr(row, "transaction_id", None)
        if not tid:
            continue
        # Mark as stub so remember_wallet_txs won't overwrite richer cached payloads.
        out.append({"transaction_id": tid, "txid": tid, "_history_stub": True})
    return out


def get_cached_transactions(wallet_id: str, query: str | None = None) -> list[dict]:
    return wallet_state.get_transactions(wallet_id, query)
