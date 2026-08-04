"""Route wallet operations to the correct chain service."""

from __future__ import annotations

from .bitcoin_service import BitcoinService, get_bitcoin_service
from .kaspa_service import KaspaService, get_service as get_kaspa_service
from .wallet_store import WalletConfig, resolved_wallet_coin

CoinService = KaspaService | BitcoinService


def service_for(cfg: WalletConfig) -> CoinService:
    if resolved_wallet_coin(cfg) == "bitcoin":
        return get_bitcoin_service()
    return get_kaspa_service()
