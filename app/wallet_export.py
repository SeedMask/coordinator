"""Watch-only wallet export/import (no seeds, no private keys).

SeedMask wallet files keep password-protected wallets sealed (encrypted_blob).
Plain wallets export as plaintext JSON SeedMask can re-import.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from .labels_store import export_labels, import_labels
from .wallet_store import (
    WalletConfig,
    _disk_dict_for_wallet,
    _unlocked,
    add_wallet,
    find_duplicate_watch_wallet,
    find_wallet_by_kpub,
    get_wallet,
    load_store,
    remove_wallet,
    save_store,
    unlock_wallet,
)

EXPORT_VERSION = 1
EXPORT_FORMAT = "seedmask_wallet_export"


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def export_wallet_bundle(wallet_id: str) -> dict:
    """Portable SeedMask wallet file.

    Password-protected wallets stay sealed — only SeedMask opens them with the password.
    Unencrypted wallets are exported in plaintext.
    """
    store = load_store()
    disk = next((w for w in store.wallets if w.id == wallet_id), None)
    if not disk:
        raise ValueError("Wallet not found")
    wallet = _disk_dict_for_wallet(disk)
    labels: dict = {}
    if not disk.encrypted or wallet_id in _unlocked:
        labels = export_labels(wallet_id)
    return {
        "format": EXPORT_FORMAT,
        "version": EXPORT_VERSION,
        "exported_at": _now_iso(),
        "wallet": wallet,
        "labels": labels,
    }


def export_all_wallets_bundle() -> dict:
    store = load_store()
    return {
        "format": EXPORT_FORMAT,
        "version": EXPORT_VERSION,
        "exported_at": _now_iso(),
        "active_wallet_id": store.active_wallet_id,
        "wallets": [_disk_dict_for_wallet(w) for w in store.wallets],
        "labels_by_wallet": {
            w.id: (export_labels(w.id) if (not w.encrypted or w.id in _unlocked) else {})
            for w in store.wallets
        },
    }


def _normalize_import_payload(payload: dict) -> tuple[dict, dict | None]:
    """Return (wallet_raw, labels_or_none) from a bundle or raw wallet file."""
    if not isinstance(payload, dict):
        raise ValueError("Import payload must be a JSON object")

    fmt = str(payload.get("format") or "")
    if fmt and fmt not in (EXPORT_FORMAT, ""):
        raise ValueError(f"Unsupported export format: {fmt}")

    wallet_raw = payload.get("wallet")
    labels = payload.get("labels") if isinstance(payload.get("labels"), dict) else None

    if isinstance(wallet_raw, dict):
        return wallet_raw, labels

    if isinstance(payload.get("wallets"), list) and payload["wallets"]:
        first = payload["wallets"][0]
        if not isinstance(first, dict):
            raise ValueError("Export missing wallet object")
        labels_map = payload.get("labels_by_wallet")
        if isinstance(labels_map, dict):
            src_id = str(first.get("id") or "")
            if src_id and isinstance(labels_map.get(src_id), dict):
                labels = labels_map[src_id]
        return first, labels

    # Raw per-wallet disk file / sealed shell.
    if payload.get("encrypted_blob") or payload.get("kpub") or payload.get("id"):
        return payload, labels

    raise ValueError("Export missing wallet object")


def _import_sealed_wallet(
    wallet_raw: dict,
    *,
    activate: bool,
    password: str | None,
) -> WalletConfig:
    from .wallet_crypto import decrypt_secrets

    store = load_store()
    shell = WalletConfig.from_dict(wallet_raw)
    if not shell.encrypted or not shell.encrypted_blob:
        raise ValueError("Not a sealed SeedMask wallet")

    pw = (password or "").strip()
    incoming_kpub = ""
    if pw:
        # Verify before committing so a wrong password does not leave a half-imported wallet.
        secrets = decrypt_secrets(shell.encrypted_blob, pw)
        incoming_kpub = str(secrets.get("kpub") or "").strip()
        if incoming_kpub and find_wallet_by_kpub(incoming_kpub, coin=shell.coin):
            raise ValueError("This watch-only key is already imported for this coin")

    if find_duplicate_watch_wallet(shell):
        raise ValueError("This watch-only key is already imported for this coin")

    shell.id = str(uuid.uuid4())
    # Secrets stay in the blob only.
    shell.kpub = ""
    shell.descriptor = ""
    shell.derivation = ""
    shell.fingerprint = ""
    shell.script_type = ""
    shell.multisig_cosigners = []
    shell.created_at = shell.created_at or _now_iso()

    store.wallets.append(shell)
    coin_key = shell.coin or "kaspa"
    if activate or not store.active_wallet_by_coin.get(coin_key):
        store.active_wallet_by_coin[coin_key] = shell.id
        if coin_key == "kaspa":
            store.active_wallet_id = shell.id
    save_store(store)

    if pw:
        unlocked = unlock_wallet(shell.id, pw)
        if find_duplicate_watch_wallet(unlocked, skip_id=unlocked.id):
            remove_wallet(shell.id)
            raise ValueError("This watch-only key is already imported for this coin")
        return unlocked
    return get_wallet(shell.id) or shell


def import_wallet_bundle(
    payload: dict,
    *,
    activate: bool = True,
    password: str | None = None,
) -> WalletConfig:
    wallet_raw, labels = _normalize_import_payload(payload)
    cfg_preview = WalletConfig.from_dict(wallet_raw)

    if cfg_preview.encrypted and cfg_preview.encrypted_blob:
        dup = find_duplicate_watch_wallet(cfg_preview)
        if dup:
            raise ValueError("This watch-only key is already imported for this coin")
        saved = _import_sealed_wallet(wallet_raw, activate=activate, password=password)
    else:
        saved = add_wallet(
            cfg_preview.kpub,
            cfg_preview.label,
            cfg_preview.scan_limit,
            account=cfg_preview.account,
            coin=cfg_preview.coin,
            derivation=cfg_preview.derivation or None,
            fingerprint=cfg_preview.fingerprint or None,
            script_type=cfg_preview.script_type or None,
            policy_type=cfg_preview.policy_type or None,
            multisig_m=cfg_preview.multisig_m or None,
            multisig_n=cfg_preview.multisig_n or None,
            multisig_cosigners=cfg_preview.multisig_cosigners or None,
            descriptor=cfg_preview.descriptor or None,
            hardware=cfg_preview.hardware or None,
            keystore_label=cfg_preview.keystore_label or None,
            activate=activate,
            password=(password or "").strip() or None,
            password_hint=cfg_preview.password_hint or None,
        )

    if isinstance(labels, dict) and (labels.get("addresses") or labels.get("transactions")):
        import_labels(saved.id, labels)

    labels_map = payload.get("labels_by_wallet") if isinstance(payload, dict) else None
    if isinstance(labels_map, dict):
        src_id = str(wallet_raw.get("id") or "")
        src_labels = labels_map.get(src_id)
        if src_id and isinstance(src_labels, dict) and (
            src_labels.get("addresses") or src_labels.get("transactions")
        ):
            import_labels(saved.id, src_labels)

    return saved


def parse_import_text(text: str) -> dict:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError("Invalid JSON export file") from e
    if not isinstance(data, dict):
        raise ValueError("Export must be a JSON object")
    return data
