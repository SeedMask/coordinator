"""In-memory cache of raw on-chain txs from wallet history scans (Tx details fast path)."""

from __future__ import annotations

from .transaction_history import _btc_tx_id_aliases, _norm_txid

_wallet_raw: dict[str, dict[str, dict]] = {}


def kaspa_tx_outpoints_resolved(tx: dict | None) -> bool:
    """True when Kaspa inputs include resolved previous-outpoint address/amount."""
    if not isinstance(tx, dict):
        return False
    inputs = tx.get("inputs")
    if not isinstance(inputs, list) or not inputs:
        return False
    for inp in inputs:
        if not isinstance(inp, dict):
            return False
        # History page feeds often omit these; Tx details need them.
        if inp.get("previous_outpoint_amount") is None and inp.get("previous_outpoint_address") in (
            None,
            "",
        ):
            return False
    outputs = tx.get("outputs")
    return isinstance(outputs, list) and len(outputs) > 0


def _btc_tx_has_io(tx: dict) -> bool:
    vin = tx.get("vin") if isinstance(tx.get("vin"), list) else []
    vout = tx.get("vout") if isinstance(tx.get("vout"), list) else []
    return bool(vin and vout)


def _tx_is_richer(candidate: dict, existing: dict | None) -> bool:
    if existing is None:
        return not candidate.get("_history_stub")
    if candidate.get("_history_stub"):
        return False
    # Bitcoin: prefer full vin/vout payloads over history stubs.
    if _btc_tx_has_io(candidate) or _btc_tx_has_io(existing or {}):
        c_vin = candidate.get("vin") if isinstance(candidate.get("vin"), list) else []
        e_vin = existing.get("vin") if isinstance(existing.get("vin"), list) else []
        if c_vin and not e_vin:
            return True
        if e_vin and not c_vin:
            return False
        return len(c_vin) >= len(e_vin)
    cand_ok = kaspa_tx_outpoints_resolved(candidate)
    exist_ok = kaspa_tx_outpoints_resolved(existing)
    if cand_ok and not exist_ok:
        return True
    if exist_ok and not cand_ok:
        return False
    # Prefer more complete input payloads.
    c_in = candidate.get("inputs") if isinstance(candidate.get("inputs"), list) else []
    e_in = existing.get("inputs") if isinstance(existing.get("inputs"), list) else []
    return len(c_in) >= len(e_in)


def remember_wallet_txs(wallet_id: str, txs: dict[str, dict]) -> None:
    if not wallet_id or not txs:
        return
    from . import wallet_state

    bucket = _wallet_raw.setdefault(wallet_id, {})
    for txid, tx in txs.items():
        key = _norm_txid(txid)
        if not key or not isinstance(tx, dict):
            continue
        prior = bucket.get(key)
        if not _tx_is_richer(tx, prior):
            continue
        bucket[key] = tx
        for alias in _btc_tx_id_aliases(key):
            bucket[alias] = tx
        # Persist so Tx details stay instant after app restart.
        try:
            if tx.get("vin") or tx.get("vout") or tx.get("inputs") or tx.get("outputs"):
                wallet_state.save_raw_tx(wallet_id, key, tx)
                for alias in _btc_tx_id_aliases(key):
                    if alias != key:
                        wallet_state.save_raw_tx(wallet_id, alias, tx)
        except Exception:
            pass


def remember_wallet_tx_list(wallet_id: str, rows: list[dict]) -> None:
    by_id: dict[str, dict] = {}
    for tx in rows:
        from .transaction_history import _btc_tx_id_from_record

        tid = _btc_tx_id_from_record(tx) or _norm_txid(
            str(tx.get("transaction_id") or tx.get("txid") or "")
        )
        if tid:
            by_id[tid] = tx
    remember_wallet_txs(wallet_id, by_id)


def cached_wallet_tx(wallet_id: str, txid: str) -> dict | None:
    from . import wallet_state

    wallet_state.init_db()
    norm = _norm_txid(txid)
    if not norm:
        return None
    for alias in _btc_tx_id_aliases(norm):
        raw = wallet_state.get_raw_tx(wallet_id, alias)
        if raw:
            return raw
    bucket = _wallet_raw.get(wallet_id)
    if not bucket:
        return None
    if norm in bucket:
        return bucket[norm]
    for alias in _btc_tx_id_aliases(norm):
        if alias in bucket:
            return bucket[alias]
    return None


def list_wallet_tx_dicts(wallet_id: str) -> list[dict]:
    bucket = _wallet_raw.get(wallet_id)
    if not bucket:
        return []
    seen: set[str] = set()
    out: list[dict] = []
    for tx in bucket.values():
        from .transaction_history import _btc_tx_id_from_record, _norm_txid

        tid = _btc_tx_id_from_record(tx) or _norm_txid(str(tx.get("txid") or tx.get("transaction_id") or ""))
        if not tid or tid in seen:
            continue
        seen.add(tid)
        out.append(tx)
    return out


def clear_wallet_tx_cache(wallet_id: str) -> None:
    _wallet_raw.pop(wallet_id, None)
