"""Persist receive-address usage (stays used after spend; last-used timestamps)."""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from pathlib import Path

from .wallet_store import DATA_DIR

_USAGE_DIR = DATA_DIR / "address_usage"
_MS_THRESHOLD = 10_000_000_000


def _block_time_seconds(raw: int) -> int:
    if raw <= 0:
        return 0
    if raw > _MS_THRESHOLD:
        return raw // 1000
    return raw


def _coerce_sompi(raw: object) -> int:
    if raw is None:
        return 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


def _path(wallet_id: str) -> Path:
    return _USAGE_DIR / f"{wallet_id}.json"


def load_receive_usage(wallet_id: str) -> dict[int, int]:
    """index -> last-used Unix seconds (0 = used, timestamp unknown)."""
    return _load_path_usage(wallet_id, "receive")


def load_change_usage(wallet_id: str) -> dict[int, int]:
    return _load_path_usage(wallet_id, "change")


def _load_path_usage(wallet_id: str, path_key: str) -> dict[int, int]:
    p = _path(wallet_id)
    if not p.is_file():
        return {}
    try:
        with p.open(encoding="utf-8") as f:
            data = json.load(f)
        raw = data.get(path_key) if isinstance(data, dict) else None
        if not isinstance(raw, dict):
            return {}
        out: dict[int, int] = {}
        for k, v in raw.items():
            try:
                idx = int(k)
                ts = int(v or 0)
                out[idx] = max(out.get(idx, 0), ts)
            except (TypeError, ValueError):
                continue
        return out
    except (json.JSONDecodeError, OSError, ValueError):
        return {}


def save_receive_usage(wallet_id: str, usage: dict[int, int]) -> None:
    _save_path_usage(wallet_id, "receive", usage)


def save_change_usage(wallet_id: str, usage: dict[int, int]) -> None:
    _save_path_usage(wallet_id, "change", usage)


def _save_path_usage(wallet_id: str, path_key: str, usage: dict[int, int]) -> None:
    _USAGE_DIR.mkdir(parents=True, exist_ok=True)
    p = _path(wallet_id)
    data: dict = {}
    if p.is_file():
        try:
            with p.open(encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                data = raw
        except (json.JSONDecodeError, OSError, ValueError):
            data = {}
    data["wallet_id"] = wallet_id
    data[path_key] = {str(k): int(v) for k, v in sorted(usage.items())}
    with p.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def first_unused_receive_index(used: set[int], scan_limit: int) -> int:
    for i in range(max(1, scan_limit)):
        if i not in used:
            return i
    return (max(used) + 1) if used else 0


def first_unused_change_index(used: set[int], scan_limit: int) -> int:
    """Same gap-scan as receive: prefer the lowest unused change index."""
    return first_unused_receive_index(used, scan_limit)


def used_change_indices(
    wallet_id: str,
    utxo_items: list | None = None,
) -> set[int]:
    """Indices that must not receive fresh change (prior usage, index, or live UTXOs)."""
    used = set(load_change_usage(wallet_id).keys())
    try:
        from .address_index import load_address_index

        used.update(int(i) for i in (load_address_index(wallet_id).get("change_indices") or []) if int(i) >= 0)
    except Exception:
        pass
    for u in utxo_items or []:
        if isinstance(u, dict):
            is_change = bool(u.get("is_change"))
            idx = int(u.get("address_index", -1))
        else:
            is_change = bool(getattr(u, "is_change", False))
            idx = int(getattr(u, "address_index", -1))
        if is_change and idx >= 0:
            used.add(idx)
    return used


def next_change_index_for_wallet(
    wallet_id: str,
    *,
    scan_limit: int,
    utxo_items: list | None = None,
) -> int:
    return first_unused_change_index(used_change_indices(wallet_id, utxo_items), scan_limit)


def mark_change_index_used(wallet_id: str, index: int, *, address: str | None = None) -> None:
    """Reserve a change index after it is assigned to a draft/tx."""
    idx = int(index)
    if idx < 0 or not wallet_id:
        return
    usage = load_change_usage(wallet_id)
    _merge_index(usage, idx, int(time.time()))
    save_change_usage(wallet_id, usage)
    try:
        from .address_index import save_address_index

        addrs = [address] if address else []
        save_address_index(wallet_id, addresses=addrs, change_indices={idx})
    except Exception:
        pass


def _merge_index(usage: dict[int, int], index: int, timestamp: int) -> None:
    if index < 0:
        return
    ts = max(int(timestamp or 0), 0)
    if ts > 0:
        usage[index] = max(usage.get(index, 0), ts)
    elif index not in usage:
        usage[index] = 0


def merge_usage_from_utxo_items(
    usage: dict[int, int],
    path_pairs: list[tuple[int, str]],
    utxo_items: list,
    *,
    normalize_addr: Callable[[str], str],
    for_change: bool = False,
) -> dict[int, int]:
    out = dict(usage)
    path_map = {normalize_addr(addr): i for i, addr in path_pairs}
    now = int(time.time())
    for u in utxo_items:
        if isinstance(u, dict):
            is_change = bool(u.get("is_change"))
            idx = int(u.get("address_index", -1))
            addr = str(u.get("address") or "")
        else:
            is_change = bool(getattr(u, "is_change", False))
            idx = int(getattr(u, "address_index", -1))
            addr = str(getattr(u, "address", "") or "")
        if is_change != for_change:
            continue
        if idx < 0 and addr:
            try:
                idx = path_map.get(normalize_addr(addr), -1)
            except (TypeError, ValueError):
                idx = path_map.get(addr, -1)
        _merge_index(out, idx, now)
    return out


def merge_usage_from_balances(
    usage: dict[int, int],
    path_pairs: list[tuple[int, str]],
    bal_by_addr: dict[str, int],
) -> dict[int, int]:
    out = dict(usage)
    now = int(time.time())
    for i, addr in path_pairs:
        if bal_by_addr.get(addr, 0) > 0:
            _merge_index(out, i, now)
    return out


def update_receive_usage(
    wallet_id: str,
    receive_pairs: list[tuple[int, str]],
    utxo_items: list,
    bal_by_addr: dict[str, int],
    *,
    normalize_addr: Callable[[str], str],
) -> dict[int, int]:
    usage = load_receive_usage(wallet_id)
    usage = merge_usage_from_utxo_items(
        usage, receive_pairs, utxo_items, normalize_addr=normalize_addr, for_change=False
    )
    usage = merge_usage_from_balances(usage, receive_pairs, bal_by_addr)
    # Preserve indices already discovered by the durable address index (incl. fully spent).
    try:
        from .address_index import load_address_index

        for idx in load_address_index(wallet_id).get("receive_indices") or []:
            _merge_index(usage, int(idx), usage.get(int(idx), 0))
    except Exception:
        pass
    save_receive_usage(wallet_id, usage)
    return usage


def update_change_usage(
    wallet_id: str,
    change_pairs: list[tuple[int, str]],
    utxo_items: list,
    bal_by_addr: dict[str, int],
    *,
    normalize_addr: Callable[[str], str],
) -> dict[int, int]:
    usage = load_change_usage(wallet_id)
    usage = merge_usage_from_utxo_items(
        usage, change_pairs, utxo_items, normalize_addr=normalize_addr, for_change=True
    )
    usage = merge_usage_from_balances(usage, change_pairs, bal_by_addr)
    # Keep indices discovered by the durable address index (incl. fully spent change).
    try:
        from .address_index import load_address_index

        for idx in load_address_index(wallet_id).get("change_indices") or []:
            _merge_index(usage, int(idx), usage.get(int(idx), 0))
    except Exception:
        pass
    save_change_usage(wallet_id, usage)
    return usage


def apply_receive_usage_to_rows(rows: list[dict], usage: dict[int, int]) -> None:
    for row in rows:
        idx = int(row.get("index", -1))
        row["is_used"] = idx in usage
        row["last_used_at"] = int(usage.get(idx, 0) or 0)


def _kaspa_addr_key(addr: str, normalize_addr: Callable[[str], str]) -> str:
    if not addr:
        return ""
    try:
        return normalize_addr(addr)
    except (TypeError, ValueError):
        return addr.strip().lower()


def _kaspa_address_last_used(
    addr: str,
    txs: list[dict],
    *,
    normalize_addr: Callable[[str], str],
) -> int:
    key = _kaspa_addr_key(addr, normalize_addr)
    recv_ts = 0
    any_ts = 0
    for tx in txs:
        bt = _block_time_seconds(
            int(tx.get("block_time") or tx.get("accepting_block_time") or 0)
        )
        if bt > 0:
            any_ts = max(any_ts, bt)
        for out in tx.get("outputs") or []:
            raw = str(out.get("script_public_key_address") or out.get("address") or "")
            if _kaspa_addr_key(raw, normalize_addr) != key:
                continue
            if _coerce_sompi(out.get("amount")) > 0:
                recv_ts = max(recv_ts, bt)
    if recv_ts > 0:
        return recv_ts
    return any_ts if txs else 0


def _btc_address_last_received(addr: str, txs: list[dict]) -> int:
    """Timestamp when addr received coins in a vout (0 if never received)."""
    recv_ts = 0
    for tx in txs:
        status = tx.get("status") if isinstance(tx.get("status"), dict) else {}
        bt = _block_time_seconds(int(status.get("block_time") or tx.get("time") or tx.get("blocktime") or 0))
        vouts = tx.get("vout")
        if vouts is None:
            vouts = tx.get("out") or []
        for vout in vouts:
            out_addr = str(vout.get("scriptpubkey_address") or vout.get("addr") or "")
            if out_addr != addr:
                continue
            val = vout.get("value")
            try:
                sats = int(val) if val is not None else 0
            except (TypeError, ValueError):
                sats = 0
            if sats > 0:
                recv_ts = max(recv_ts, bt)
    return recv_ts


def _btc_address_last_used(addr: str, txs: list[dict]) -> int:
    """Last-used time for per-address tx scans (non-empty list implies activity)."""
    recv_ts = _btc_address_last_received(addr, txs)
    if recv_ts > 0:
        return recv_ts
    if not txs:
        return 0
    any_ts = 0
    for tx in txs:
        status = tx.get("status") if isinstance(tx.get("status"), dict) else {}
        bt = _block_time_seconds(int(status.get("block_time") or tx.get("time") or tx.get("blocktime") or 0))
        if bt > 0:
            any_ts = max(any_ts, bt)
    return any_ts


def record_receive_usage_from_scans(
    wallet_id: str,
    receive_pairs: list[tuple[int, str]],
    scans: list[tuple[str, list[dict]]],
    *,
    coin: str,
    normalize_addr: Callable[[str], str] | None = None,
) -> None:
    """Mark receive indices used from per-address tx scans (updates last-used timestamps)."""
    recv_map = {addr: i for i, addr in receive_pairs}
    norm_map = {}
    if normalize_addr is not None:
        for addr, idx in recv_map.items():
            try:
                norm_map[normalize_addr(addr)] = idx
            except (TypeError, ValueError):
                norm_map[addr] = idx
    usage = load_receive_usage(wallet_id)
    coin_l = (coin or "kaspa").strip().lower()
    for addr, txs in scans:
        idx = recv_map.get(addr)
        if idx is None and normalize_addr is not None:
            try:
                idx = norm_map.get(normalize_addr(addr))
            except (TypeError, ValueError):
                idx = None
        if idx is None:
            continue
        if not txs:
            continue
        if coin_l == "bitcoin":
            ts = _btc_address_last_used(addr, txs)
        else:
            norm = normalize_addr or (lambda a: a)
            ts = _kaspa_address_last_used(addr, txs, normalize_addr=norm)
        if ts <= 0:
            ts = int(time.time())
        _merge_index(usage, idx, ts)
    if usage:
        save_receive_usage(wallet_id, usage)


def merge_usage_from_btc_tx_dicts(
    wallet_id: str,
    receive_pairs: list[tuple[int, str]],
    txs: list[dict],
) -> dict[int, int]:
    """Mark receive indices used only when a vout paid to that address (incl. fully spent)."""
    if not txs:
        return load_receive_usage(wallet_id)
    usage = load_receive_usage(wallet_id)
    recv_map = {addr: i for i, addr in receive_pairs}
    for tx in txs:
        status = tx.get("status") if isinstance(tx.get("status"), dict) else {}
        bt = _block_time_seconds(int(status.get("block_time") or tx.get("time") or tx.get("blocktime") or 0))
        vouts = tx.get("vout")
        if vouts is None:
            vouts = tx.get("out") or []
        for vout in vouts:
            out_addr = str(vout.get("scriptpubkey_address") or vout.get("addr") or "")
            idx = recv_map.get(out_addr)
            if idx is None:
                continue
            val = vout.get("value")
            try:
                sats = int(val) if val is not None else 0
            except (TypeError, ValueError):
                sats = 0
            if sats > 0:
                _merge_index(usage, idx, bt)
    if usage:
        save_receive_usage(wallet_id, usage)
    return usage


def prune_unproven_receive_usage(
    wallet_id: str,
    receive_pairs: list[tuple[int, str]],
    utxo_items: list,
    bal_by_addr: dict[str, int],
    txs: list[dict] | None = None,
) -> dict[int, int]:
    """Drop falsely-marked receive indices (e.g. from prior all-wallet tx scans)."""
    proven: set[int] = set()
    recv_map = {addr: i for i, addr in receive_pairs}
    for u in utxo_items:
        if isinstance(u, dict):
            if u.get("is_change"):
                continue
            idx = int(u.get("address_index", -1))
            addr = str(u.get("address") or "")
        else:
            if getattr(u, "is_change", False):
                continue
            idx = int(getattr(u, "address_index", -1))
            addr = str(getattr(u, "address", "") or "")
        if idx >= 0:
            proven.add(idx)
        elif addr and addr in recv_map:
            proven.add(recv_map[addr])
    for addr, sompi in bal_by_addr.items():
        if sompi > 0 and addr in recv_map:
            proven.add(recv_map[addr])
    if txs:
        for tx in txs:
            vouts = tx.get("vout") or tx.get("out") or []
            for vout in vouts:
                out_addr = str(vout.get("scriptpubkey_address") or vout.get("addr") or "")
                if out_addr in recv_map:
                    val = vout.get("value")
                    try:
                        sats = int(val) if val is not None else 0
                    except (TypeError, ValueError):
                        sats = 0
                    if sats > 0:
                        proven.add(recv_map[out_addr])
    usage = load_receive_usage(wallet_id)
    if not usage:
        return usage
    pruned = {k: v for k, v in usage.items() if k in proven}
    if len(pruned) != len(usage):
        save_receive_usage(wallet_id, pruned)
    return pruned


def persisted_used_receive_indices(wallet_id: str) -> set[int]:
    return set(load_receive_usage(wallet_id).keys())
