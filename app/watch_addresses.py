"""Addresses to monitor for near-real-time balance updates."""

from __future__ import annotations

from .address_index import hot_addresses_for_wallet
from .wallet_store import WalletConfig


def watch_addresses_for_wallet(
    wallet_id: str,
    cfg: WalletConfig,
    utxo_dicts: list[dict],
) -> list[str]:
    """Return indexed + watched addresses for hot balance sync and live websocket tracking."""
    return hot_addresses_for_wallet(wallet_id, cfg, utxo_dicts)
