"""Address and transaction labels per wallet (local JSON, no secrets)."""

from __future__ import annotations

import json
from pathlib import Path

from .wallet_store import DATA_DIR

LABELS_FILE = DATA_DIR / "labels.json"


def _load_raw() -> dict:
    if not LABELS_FILE.is_file():
        return {"wallets": {}}
    try:
        data = json.loads(LABELS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return {"wallets": {}}
    if not isinstance(data, dict):
        return {"wallets": {}}
    data.setdefault("wallets", {})
    return data


def _save_raw(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    LABELS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _wallet_bucket(data: dict, wallet_id: str) -> dict:
    wallets = data.setdefault("wallets", {})
    bucket = wallets.setdefault(wallet_id, {})
    bucket.setdefault("addresses", {})
    bucket.setdefault("transactions", {})
    return bucket


def list_labels(wallet_id: str) -> dict:
    bucket = _wallet_bucket(_load_raw(), wallet_id)
    return {
        "addresses": dict(bucket.get("addresses") or {}),
        "transactions": dict(bucket.get("transactions") or {}),
    }


def set_address_label(wallet_id: str, address: str, label: str) -> dict:
    addr = (address or "").strip()
    text = (label or "").strip()
    if not addr:
        raise ValueError("address required")
    data = _load_raw()
    bucket = _wallet_bucket(data, wallet_id)
    addresses = bucket.setdefault("addresses", {})
    if text:
        addresses[addr] = text
    else:
        addresses.pop(addr, None)
    _save_raw(data)
    return list_labels(wallet_id)


def set_tx_label(wallet_id: str, txid: str, label: str) -> dict:
    tx = (txid or "").strip().lower().replace("0x", "")
    text = (label or "").strip()
    if not tx:
        raise ValueError("transaction_id required")
    data = _load_raw()
    bucket = _wallet_bucket(data, wallet_id)
    txs = bucket.setdefault("transactions", {})
    if text:
        txs[tx] = text
    else:
        txs.pop(tx, None)
    _save_raw(data)
    return list_labels(wallet_id)


def apply_labels_to_transactions(wallet_id: str, rows: list[dict]) -> list[dict]:
    labels = list_labels(wallet_id).get("transactions") or {}
    if not labels:
        return rows
    out = []
    for row in rows:
        item = dict(row)
        txid = str(item.get("transaction_id") or "").lower()
        # Always overwrite cached label data so clearing a label is reflected
        # immediately instead of preserving the stale value from tx_index.
        item["label"] = labels.get(txid) if txid else None
        out.append(item)
    return out


def search_transactions(rows: list[dict], query: str) -> list[dict]:
    q = (query or "").strip().lower()
    if not q:
        return rows
    out = []
    for row in rows:
        hay = " ".join(
            str(row.get(k) or "")
            for k in ("transaction_id", "counterparty", "direction", "label")
        ).lower()
        if q in hay:
            out.append(row)
    return out


def export_labels(wallet_id: str) -> dict:
    return list_labels(wallet_id)


def import_labels(wallet_id: str, payload: dict) -> dict:
    data = _load_raw()
    bucket = _wallet_bucket(data, wallet_id)
    if isinstance(payload.get("addresses"), dict):
        bucket["addresses"] = {
            str(k): str(v) for k, v in payload["addresses"].items() if str(k).strip() and str(v).strip()
        }
    if isinstance(payload.get("transactions"), dict):
        bucket["transactions"] = {
            str(k).lower().replace("0x", ""): str(v)
            for k, v in payload["transactions"].items()
            if str(k).strip() and str(v).strip()
        }
    _save_raw(data)
    return list_labels(wallet_id)
