"""Watch-only wallet export/import (no seeds, no private keys)."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from .labels_store import export_labels, import_labels
from .wallet_store import (
    WalletConfig,
    add_wallet,
    get_wallet,
    list_wallets,
    load_store,
)

EXPORT_VERSION = 1


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def export_wallet_bundle(wallet_id: str) -> dict:
    cfg = get_wallet(wallet_id)
    if not cfg:
        raise ValueError("Wallet not found")
    return {
        "format": "seedmask_wallet_export",
        "version": EXPORT_VERSION,
        "exported_at": _now_iso(),
        "wallet": cfg.to_dict(),
        "labels": export_labels(wallet_id),
    }


def export_all_wallets_bundle() -> dict:
    store = load_store()
    wallets = list_wallets()
    return {
        "format": "seedmask_wallet_export",
        "version": EXPORT_VERSION,
        "exported_at": _now_iso(),
        "active_wallet_id": store.get("active_wallet_id"),
        "wallets": [w.to_dict() for w in wallets],
        "labels_by_wallet": {w.id: export_labels(w.id) for w in wallets},
    }


def import_wallet_bundle(payload: dict, *, activate: bool = True) -> WalletConfig:
    if not isinstance(payload, dict):
        raise ValueError("Import payload must be a JSON object")
    fmt = str(payload.get("format") or "")
    if fmt not in ("seedmask_wallet_export", ""):
        raise ValueError(f"Unsupported export format: {fmt}")

    wallet_raw = payload.get("wallet")
    if not isinstance(wallet_raw, dict):
        if isinstance(payload.get("wallets"), list) and payload["wallets"]:
            wallet_raw = payload["wallets"][0]
        else:
            raise ValueError("Export missing wallet object")

    cfg = WalletConfig.from_dict(wallet_raw)
    saved = add_wallet(
        cfg.kpub,
        cfg.label,
        cfg.scan_limit,
        account=cfg.account,
        coin=cfg.coin,
        derivation=cfg.derivation or None,
        fingerprint=cfg.fingerprint or None,
        script_type=cfg.script_type or None,
        policy_type=cfg.policy_type or None,
        multisig_m=cfg.multisig_m or None,
        multisig_n=cfg.multisig_n or None,
        multisig_cosigners=cfg.multisig_cosigners or None,
        activate=activate,
    )

    labels = payload.get("labels")
    if isinstance(labels, dict):
        import_labels(saved.id, labels)
    labels_map = payload.get("labels_by_wallet")
    if isinstance(labels_map, dict):
        src_id = str(wallet_raw.get("id") or "")
        if src_id and src_id in labels_map and isinstance(labels_map[src_id], dict):
            import_labels(saved.id, labels_map[src_id])

    return saved


def parse_import_text(text: str) -> dict:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError("Invalid JSON export file") from e
    if not isinstance(data, dict):
        raise ValueError("Export must be a JSON object")
    return data
