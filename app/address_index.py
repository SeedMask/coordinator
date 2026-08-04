"""Durable per-wallet address index for hot mainnet balance sync."""

from __future__ import annotations

import json
from pathlib import Path

from .address_usage import first_unused_receive_index, load_receive_usage
from .wallet_store import DATA_DIR, WalletConfig

_INDEX_DIR = DATA_DIR / "address_index"
_HOT_RECEIVE_AHEAD = 6
_HOT_CHANGE_CAP = 12
_HOT_MAX_ADDRESSES = 28


def _path(wallet_id: str) -> Path:
    return _INDEX_DIR / f"{wallet_id}.json"


def load_address_index(wallet_id: str) -> dict:
    p = _path(wallet_id)
    if not p.is_file():
        return {"addresses": [], "change_indices": [], "receive_indices": []}
    try:
        with p.open(encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"addresses": [], "change_indices": [], "receive_indices": []}
        addresses = [str(a).strip() for a in (data.get("addresses") or []) if str(a).strip()]
        change_indices = sorted(
            int(i) for i in (data.get("change_indices") or []) if str(i).lstrip("-").isdigit()
        )
        receive_indices = sorted(
            int(i) for i in (data.get("receive_indices") or []) if str(i).lstrip("-").isdigit()
        )
        return {
            "addresses": addresses,
            "change_indices": change_indices,
            "receive_indices": receive_indices,
        }
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        return {"addresses": [], "change_indices": [], "receive_indices": []}


def save_address_index(
    wallet_id: str,
    *,
    addresses: set[str] | list[str],
    change_indices: set[int] | list[int] | None = None,
    receive_indices: set[int] | list[int] | None = None,
) -> None:
    prior = load_address_index(wallet_id)
    addr_set = set(prior["addresses"])
    for a in addresses:
        s = str(a or "").strip()
        if s:
            addr_set.add(s)
    chg_set = set(prior["change_indices"])
    if change_indices is not None:
        chg_set.update(int(i) for i in change_indices if int(i) >= 0)
    recv_set = set(prior["receive_indices"])
    if receive_indices is not None:
        recv_set.update(int(i) for i in receive_indices if int(i) >= 0)
    _INDEX_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "wallet_id": wallet_id,
        "addresses": sorted(addr_set),
        "change_indices": sorted(chg_set),
        "receive_indices": sorted(recv_set),
    }
    with _path(wallet_id).open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


def record_utxo_items(wallet_id: str, utxo_items: list) -> None:
    addresses: set[str] = set()
    change_indices: set[int] = set()
    receive_indices: set[int] = set()
    for u in utxo_items:
        if isinstance(u, dict):
            addr = str(u.get("address") or "").strip()
            from .address_index_parse import as_address_index

            idx = as_address_index(u.get("address_index"), -1)
            is_change = bool(u.get("is_change"))
        else:
            addr = str(getattr(u, "address", "") or "").strip()
            from .address_index_parse import as_address_index

            idx = as_address_index(getattr(u, "address_index", None), -1)
            is_change = bool(getattr(u, "is_change", False))
        if addr:
            addresses.add(addr)
        if idx >= 0:
            if is_change:
                change_indices.add(idx)
            else:
                receive_indices.add(idx)
    if addresses or change_indices or receive_indices:
        save_address_index(
            wallet_id,
            addresses=addresses,
            change_indices=change_indices,
            receive_indices=receive_indices,
        )


def seed_index_from_utxo_cache(wallet_id: str) -> None:
    from .utxo_cache import load_utxo_cache

    cached = load_utxo_cache(wallet_id)
    if not cached:
        return
    record_utxo_items(wallet_id, list(cached.get("utxos") or []))


def needs_deep_scan(wallet_id: str, cfg: WalletConfig) -> bool:
    """True when we have no durable address footprint and must gap-scan."""
    index = load_address_index(wallet_id)
    if index["addresses"]:
        return False
    usage = load_receive_usage(wallet_id)
    if usage:
        return False
    from .utxo_cache import load_utxo_cache

    cached = load_utxo_cache(wallet_id)
    if cached and cached.get("utxos"):
        return False
    return True


def hot_addresses_for_wallet(
    wallet_id: str,
    cfg: WalletConfig,
    utxo_dicts: list[dict] | None = None,
) -> list[str]:
    """Addresses to query for a fast live balance check."""
    coin = (cfg.coin or "kaspa").strip().lower()
    addrs: set[str] = set()
    index = load_address_index(wallet_id)
    addrs.update(index["addresses"])

    for raw in utxo_dicts or []:
        addr = str(raw.get("address") or "").strip()
        if addr:
            addrs.add(addr)

    if not index["addresses"] and not addrs:
        seed_index_from_utxo_cache(wallet_id)
        index = load_address_index(wallet_id)
        addrs.update(index["addresses"])

    usage = load_receive_usage(wallet_id)
    next_idx = first_unused_receive_index(set(usage.keys()) | set(index["receive_indices"]), cfg.scan_limit)
    recv_tail = min(cfg.scan_limit, next_idx + _HOT_RECEIVE_AHEAD)

    if coin == "bitcoin":
        from .bitcoin_service import get_bitcoin_service

        btc = get_bitcoin_service()
        for i, addr in btc.receive_addresses(cfg):
            if i <= recv_tail:
                addrs.add(addr)
        chg_hi = max(index["change_indices"], default=-1)
        chg_tail = min(cfg.scan_limit, max(chg_hi + 3, _HOT_CHANGE_CAP // 2))
        for i in range(chg_tail + 1):
            addrs.add(btc._address_at(cfg, 1, i))
    elif coin == "kaspa":
        from .kaspa_service import get_service

        svc = get_service()
        # Probe past Scan depth so payments to higher receive indices still refresh.
        kaspa_tail = min(100, max(cfg.scan_limit, next_idx + _HOT_RECEIVE_AHEAD, 20))
        for i, addr in svc.receive_addresses(cfg, count=kaspa_tail):
            addrs.add(addr)
        for i, addr in svc.change_addresses(cfg, count=min(max(cfg.scan_limit, 12), _HOT_CHANGE_CAP)):
            addrs.add(addr)

    ordered = sorted(addrs)
    if len(ordered) > _HOT_MAX_ADDRESSES:
        indexed = set(index.get("addresses") or [])
        priority = [a for a in ordered if a in indexed]
        tail = [a for a in ordered if a not in indexed]
        ordered = (priority + tail)[:_HOT_MAX_ADDRESSES]
    return ordered
