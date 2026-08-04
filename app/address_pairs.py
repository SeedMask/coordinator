"""Bounded receive/change pairs — avoid deriving full scan_limit for reads."""

from __future__ import annotations

from .kaspa_service import WalletUtxo
from .utxo_access import utxo_address, utxo_address_index, utxo_is_change
from .wallet_store import WalletConfig, resolved_wallet_coin


def bounded_address_pairs(
    cfg: WalletConfig,
    utxos: list[WalletUtxo] | list[dict] | None = None,
    *,
    receive_gap: int = 8,
    change_gap: int = 12,
) -> tuple[list[tuple[int, str]], list[tuple[int, str]]]:
    """Minimal address pairs for tx history / visualize (used indices + small gap)."""
    from .coin_service import service_for

    coin = resolved_wallet_coin(cfg)
    svc = service_for(cfg)
    limit = max(1, min(cfg.scan_limit, 100))
    utxos = utxos or []

    recv_by_idx: dict[int, str] = {}
    chg_by_idx: dict[int, str] = {}

    if coin == "bitcoin":
        from .address_usage import load_receive_usage
        from .bitcoin_service import get_bitcoin_service

        btc = get_bitcoin_service()
        usage = load_receive_usage(cfg.id)
        recv_hi = min(limit - 1, (max(usage.keys()) if usage else -1) + receive_gap)
        recv_hi = max(recv_hi, 0)
        chg_indices = {
            utxo_address_index(u) for u in utxos if utxo_is_change(u) and utxo_address_index(u) >= 0
        }
        chg_hi = min(limit - 1, (max(chg_indices) if chg_indices else -1) + change_gap)
        chg_hi = max(chg_hi, 0)
        for i in range(recv_hi + 1):
            recv_by_idx[i] = btc.receive_address_at(cfg, i)
        for i in range(chg_hi + 1):
            chg_by_idx[i] = btc._address_at(cfg, 1, i)
    else:
        from .address_index import load_address_index
        from .address_usage import persisted_used_receive_indices

        gap = 20
        used_receive = persisted_used_receive_indices(cfg.id)
        # Also include indices discovered by the durable address index (spent receives).
        used_receive |= set(load_address_index(cfg.id).get("receive_indices") or [])
        for u in utxos:
            idx = utxo_address_index(u)
            if idx >= 0 and not utxo_is_change(u):
                used_receive.add(idx)
        used_change = {
            utxo_address_index(u) for u in utxos if utxo_is_change(u) and utxo_address_index(u) >= 0
        }
        recv_hi = max(limit - 1, (max(used_receive) if used_receive else 0) + gap)
        recv_hi = min(99, recv_hi)
        chg_hi = max(limit - 1, max((max(used_change) if used_change else 0) + 8, 5))
        chg_hi = min(99, chg_hi)
        for i in range(recv_hi + 1):
            recv_by_idx[i] = svc.receive_address_at(cfg, i)
        for i in range(chg_hi + 1):
            chg_by_idx[i] = svc.change_address_at(cfg, i)

    for u in utxos:
        addr = utxo_address(u)
        idx = utxo_address_index(u)
        if not addr or idx < 0:
            continue
        if utxo_is_change(u):
            chg_by_idx[idx] = addr
        else:
            recv_by_idx[idx] = addr

    receive = sorted(recv_by_idx.items())
    change = sorted(chg_by_idx.items())
    return receive, change
