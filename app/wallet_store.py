"""Persist watch-only wallets (kpub) locally — no seed, no private keys."""

from __future__ import annotations

import copy
import json
import re
import shutil
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .wallet_crypto import apply_secrets, decrypt_secrets, seal_wallet_dict

_ACCOUNT_FROM_DERIV_RE = re.compile(r"m/(?:44'/111111'|84'/0'|48'/0')/(\d+)'")
_KASPA_RECEIVE_INDEX_FROM_DERIV_RE = re.compile(r"m/44'/111111'/0'/0/(\d+)\s*$")

OLD_DATA_DIR = Path.home() / ".seedpass-coordinator"
DATA_DIR = Path.home() / ".seedmask-coordinator"
# Brief visible-folder experiment — migrate back if present.
VISIBLE_DATA_DIR = Path.home() / "SeedMask Coordinator"
WALLETS_DIR = DATA_DIR / "wallets"
INDEX_FILE = DATA_DIR / "wallets-index.json"
# Legacy monolithic store (migrated to WALLETS_DIR on first load).
WALLETS_FILE = DATA_DIR / "wallets.json"
LEGACY_WALLET_FILE = DATA_DIR / "wallet.json"
OLD_LEGACY_WALLET_FILE = OLD_DATA_DIR / "wallet.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


VALID_COINS = frozenset({"kaspa", "bitcoin"})
BITCOIN_KEY_PREFIXES = ("xpub", "tpub", "ypub", "zpub", "vpub", "upub")


def resolved_wallet_coin(cfg: WalletConfig) -> str:
    """Canonical chain for a stored wallet (handles legacy/missing coin fields)."""
    coin = (cfg.coin or "kaspa").strip().lower()
    if coin in VALID_COINS:
        return coin
    key = (cfg.kpub or "").strip().lower()
    if any(key.startswith(prefix) for prefix in BITCOIN_KEY_PREFIXES):
        return "bitcoin"
    if (cfg.descriptor or "").strip() or (cfg.script_type or "").strip():
        return "bitcoin"
    return "kaspa"


def _normalize_multisig_cosigners(raw: object) -> list[dict]:
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        xpub = str(item.get("xpub") or "").strip()
        if not xpub:
            continue
        out.append(
            {
                "xpub": xpub,
                "fingerprint": str(item.get("fingerprint") or "").strip(),
                "derivation": str(item.get("derivation") or "").strip(),
                "label": str(item.get("label") or "").strip(),
            }
        )
    return out


def _multisig_wallet_key(cosigners: list[dict]) -> str:
    xpubs = sorted(str(c.get("xpub") or "").strip() for c in cosigners if c.get("xpub"))
    return "|".join(xpubs)


_PASSWORD_HINT_MAX = 80


def normalize_password_hint(raw: object) -> str:
    """Public reminder stored in plaintext next to ciphertext — keep short."""
    text = str(raw or "").strip()
    if not text:
        return ""
    if len(text) > _PASSWORD_HINT_MAX:
        return text[:_PASSWORD_HINT_MAX].rstrip()
    return text


@dataclass
class WalletConfig:
    id: str
    label: str
    kpub: str
    account: int = 0
    scan_limit: int = 50
    coin: str = "kaspa"
    derivation: str = ""
    fingerprint: str = ""
    script_type: str = ""
    policy_type: str = ""
    multisig_m: int = 0
    multisig_n: int = 0
    multisig_cosigners: list[dict] = field(default_factory=list)
    descriptor: str = ""
    hardware: str = ""
    keystore_label: str = ""
    created_at: str = ""
    last_synced_at: str | None = None
    encrypted: bool = False
    encrypted_blob: dict[str, Any] | None = None
    # Public reminder only — never a substitute for the password; stored in plaintext.
    password_hint: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        if not self.encrypted:
            d.pop("encrypted_blob", None)
            d["password_hint"] = ""
        return d

    @classmethod
    def from_dict(cls, d: dict) -> WalletConfig:
        wid = str(d.get("id") or "").strip() or str(uuid.uuid4())
        coin = str(d.get("coin") or "kaspa").strip().lower()
        if coin not in VALID_COINS:
            coin = "kaspa"
        blob = d.get("encrypted_blob")
        encrypted_blob = blob if isinstance(blob, dict) else None
        encrypted = bool(d.get("encrypted")) or encrypted_blob is not None
        hint = normalize_password_hint(d.get("password_hint")) if encrypted else ""
        return cls(
            id=wid,
            label=str(d.get("label") or "SeedMask"),
            kpub=str(d.get("kpub") or "").strip(),
            account=int(d.get("account", 0)),
            scan_limit=int(d.get("scan_limit", 30)),
            coin=coin,
            derivation=str(d.get("derivation") or "").strip(),
            fingerprint=str(d.get("fingerprint") or "").strip(),
            script_type=str(d.get("script_type") or "").strip(),
            policy_type=str(d.get("policy_type") or "").strip(),
            multisig_m=int(d.get("multisig_m") or 0),
            multisig_n=int(d.get("multisig_n") or 0),
            multisig_cosigners=_normalize_multisig_cosigners(d.get("multisig_cosigners")),
            descriptor=str(d.get("descriptor") or "").strip(),
            hardware=str(d.get("hardware") or "").strip().lower(),
            keystore_label=str(d.get("keystore_label") or "").strip(),
            created_at=str(d.get("created_at") or _now_iso()),
            last_synced_at=d.get("last_synced_at"),
            encrypted=encrypted,
            encrypted_blob=encrypted_blob,
            password_hint=hint,
        )


# In-memory unlock session (process lifetime). Password kept only for re-seal on save.
_unlocked: dict[str, WalletConfig] = {}
_unlock_passwords: dict[str, str] = {}


def is_wallet_unlocked(wallet_id: str) -> bool:
    return wallet_id in _unlocked


def wallet_needs_unlock(cfg: WalletConfig | None) -> bool:
    return bool(cfg and cfg.encrypted and cfg.id not in _unlocked)


def clear_unlock_session(wallet_id: str | None = None) -> None:
    if wallet_id is None:
        _unlocked.clear()
        _unlock_passwords.clear()
        return
    _unlocked.pop(wallet_id, None)
    _unlock_passwords.pop(wallet_id, None)


def _disk_dict_for_wallet(cfg: WalletConfig) -> dict:
    """Serialize one wallet for on-disk storage (seal if encrypted + unlocked)."""
    if not cfg.encrypted:
        d = cfg.to_dict()
        d["encrypted"] = False
        d.pop("encrypted_blob", None)
        d["password_hint"] = ""
        return d
    full = _unlocked.get(cfg.id)
    password = _unlock_passwords.get(cfg.id)
    if full is not None and password:
        # Keep public metadata from the store entry in sync with unlocked copy.
        full.label = cfg.label
        full.account = cfg.account
        full.scan_limit = cfg.scan_limit
        full.hardware = cfg.hardware
        full.keystore_label = cfg.keystore_label
        full.created_at = cfg.created_at
        full.last_synced_at = cfg.last_synced_at
        full.coin = cfg.coin
        full.password_hint = normalize_password_hint(cfg.password_hint or full.password_hint)
        sealed = seal_wallet_dict(full.to_dict(), password)
        return sealed
    # Locked shell — persist existing blob.
    d = cfg.to_dict()
    d["encrypted"] = True
    if not d.get("encrypted_blob") and cfg.encrypted_blob:
        d["encrypted_blob"] = cfg.encrypted_blob
    d["password_hint"] = normalize_password_hint(cfg.password_hint)
    return d


def _sanitize_wallet_filename(label: str) -> str:
    """Filesystem-safe name matching the Coordinator wallet label."""
    text = (label or "").strip() or "wallet"
    cleaned: list[str] = []
    for c in text:
        if c.isalnum() or c in " -_.'":
            cleaned.append(c)
        else:
            cleaned.append("_")
    name = re.sub(r"\s+", " ", "".join(cleaned)).strip(" .")
    name = name.replace("/", "_").replace("\\", "_").replace(":", "_")
    if not name or name in (".", ".."):
        name = "wallet"
    return name[:120]


def _wallet_file_path(cfg: WalletConfig, wallets: list[WalletConfig] | None = None) -> Path:
    """On-disk path: wallets/<Label>.json (disambiguate duplicate labels)."""
    peers = wallets if wallets is not None else [cfg]
    base = _sanitize_wallet_filename(cfg.label)
    same = sorted(
        (w for w in peers if _sanitize_wallet_filename(w.label) == base),
        key=lambda w: w.id,
    )
    if len(same) > 1:
        n = next(i for i, w in enumerate(same) if w.id == cfg.id) + 1
        if n > 1:
            base = f"{base} {n}"
    return WALLETS_DIR / f"{base}.json"


def _legacy_id_wallet_path(wallet_id: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in (wallet_id or ""))
    if not safe:
        safe = "wallet"
    return WALLETS_DIR / f"{safe}.json"


def _find_wallet_file(wallet_id: str) -> Path | None:
    """Locate a wallet JSON by id (label-named or legacy id-named)."""
    if not wallet_id or not WALLETS_DIR.is_dir():
        return None
    legacy = _legacy_id_wallet_path(wallet_id)
    if legacy.is_file():
        return legacy
    for path in WALLETS_DIR.glob("*.json"):
        try:
            with path.open(encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict) and str(raw.get("id") or "") == wallet_id:
                return path
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            continue
    return None


def _read_index() -> dict:
    if not INDEX_FILE.is_file():
        return {}
    try:
        with INDEX_FILE.open(encoding="utf-8") as f:
            raw = json.load(f)
        return raw if isinstance(raw, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_index(store: WalletStore) -> None:
    payload = {
        "active_wallet_id": store.active_wallet_id,
        "active_wallet_by_coin": dict(store.active_wallet_by_coin),
        "wallet_ids": [w.id for w in store.wallets],
    }
    with INDEX_FILE.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")


@dataclass
class WalletStore:
    active_wallet_id: str | None = None
    active_wallet_by_coin: dict[str, str] = field(default_factory=dict)
    wallets: list[WalletConfig] = field(default_factory=list)

    def to_dict(self) -> dict:
        """Legacy monolithic shape (tests / migration helpers)."""
        return {
            "active_wallet_id": self.active_wallet_id,
            "active_wallet_by_coin": dict(self.active_wallet_by_coin),
            "wallets": [_disk_dict_for_wallet(w) for w in self.wallets],
        }

    @classmethod
    def from_dict(cls, d: dict) -> WalletStore:
        wallets = [WalletConfig.from_dict(w) for w in d.get("wallets") or []]
        active_by_coin = {
            str(k): str(v)
            for k, v in (d.get("active_wallet_by_coin") or {}).items()
            if v
        }
        active = d.get("active_wallet_id")
        if not active_by_coin and active:
            active_by_coin["kaspa"] = str(active)
        for coin, wid in list(active_by_coin.items()):
            if not any(w.id == wid and resolved_wallet_coin(w) == coin for w in wallets):
                del active_by_coin[coin]
        if not active and active_by_coin.get("kaspa"):
            active = active_by_coin["kaspa"]
        elif not active and wallets:
            active = wallets[0].id
        if active and "kaspa" not in active_by_coin:
            w = next((x for x in wallets if x.id == active), None)
            if w:
                active_by_coin[w.coin] = w.id
        return cls(
            active_wallet_id=active,
            active_wallet_by_coin=active_by_coin,
            wallets=wallets,
        )


_migrated = False


def _migrate_visible_data_dir_back() -> None:
    """If ~/SeedMask Coordinator exists and the hidden dir does not, move it back."""
    if DATA_DIR.exists():
        return
    if not VISIBLE_DATA_DIR.exists():
        return
    try:
        VISIBLE_DATA_DIR.rename(DATA_DIR)
    except OSError:
        shutil.copytree(VISIBLE_DATA_DIR, DATA_DIR, dirs_exist_ok=True)


def _ensure_data_dir() -> None:
    _migrate_visible_data_dir_back()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    WALLETS_DIR.mkdir(parents=True, exist_ok=True)


def _has_wallet_data() -> bool:
    if INDEX_FILE.is_file() or WALLETS_FILE.is_file():
        return True
    return WALLETS_DIR.is_dir() and any(WALLETS_DIR.glob("*.json"))


def _migrate_legacy_files() -> None:
    """Bring old ~/.seedpass / single wallet.json into the current data dir."""
    global _migrated
    if _migrated:
        return
    _migrated = True
    _ensure_data_dir()
    if _has_wallet_data():
        return
    legacy_src = None
    for path in (LEGACY_WALLET_FILE, OLD_LEGACY_WALLET_FILE):
        if path.is_file():
            legacy_src = path
            break
    if legacy_src is None and OLD_DATA_DIR.is_dir():
        shutil.copytree(OLD_DATA_DIR, DATA_DIR, dirs_exist_ok=True)
        if _has_wallet_data():
            return
        legacy_src = LEGACY_WALLET_FILE if LEGACY_WALLET_FILE.is_file() else None
    if legacy_src is None:
        return
    with legacy_src.open(encoding="utf-8") as f:
        raw = json.load(f)
    if "wallets" in raw:
        store = WalletStore.from_dict(raw)
        save_store(store)
        return
    cfg = WalletConfig.from_dict({**raw, "id": str(uuid.uuid4())})
    store = WalletStore(active_wallet_id=cfg.id, wallets=[cfg])
    save_store(store)


def _migrate_monolith_to_per_file() -> None:
    """Split legacy wallets.json into wallets/<id>.json + wallets-index.json."""
    if INDEX_FILE.is_file():
        return
    if not WALLETS_FILE.is_file():
        return
    with WALLETS_FILE.open(encoding="utf-8") as f:
        store = WalletStore.from_dict(json.load(f))
    save_store(store)
    bak = WALLETS_FILE.with_suffix(".json.bak")
    try:
        if bak.exists():
            bak.unlink()
        WALLETS_FILE.rename(bak)
    except OSError:
        pass


def effective_wallet_account(cfg: WalletConfig) -> int:
    """Account index for PSKT/JSON v2 — decode from kpub, else derivation path, else stored field."""
    from .kpub_parse import extended_key_wallet_info

    try:
        meta = extended_key_wallet_info(cfg.kpub, coin=cfg.coin)
        if "account" in meta:
            return int(meta["account"])
    except (ValueError, TypeError, KeyError):
        pass
    deriv = (cfg.derivation or "").strip()
    if deriv:
        m = _KASPA_RECEIVE_INDEX_FROM_DERIV_RE.search(deriv)
        if m:
            return int(m.group(1))
        m = _ACCOUNT_FROM_DERIV_RE.search(deriv)
        if m:
            return int(m.group(1))
    return int(cfg.account or 0)


def resolve_kaspa_fingerprint(cfg: WalletConfig, kpub: str | None = None) -> str:
    """Master fingerprint for PSKT bip32Derivations (derive from kpub when wallet omits it)."""
    from .kpub_parse import extended_key_wallet_info, is_placeholder_fingerprint

    fp = (cfg.fingerprint or "").strip()
    if fp and not is_placeholder_fingerprint(fp):
        return fp
    key = (kpub or cfg.kpub or "").strip()
    if not key:
        return fp
    try:
        meta = extended_key_wallet_info(key, coin="kaspa")
        derived = str(meta.get("fingerprint") or "").strip()
        if derived and not is_placeholder_fingerprint(derived):
            return derived
    except (ValueError, TypeError, KeyError):
        pass
    return fp


def _reconcile_wallet_accounts(store: WalletStore) -> bool:
    changed = False
    for w in store.wallets:
        acct = effective_wallet_account(w)
        if w.account != acct:
            w.account = acct
            changed = True
    return changed


def load_store() -> WalletStore:
    _migrate_legacy_files()
    _migrate_monolith_to_per_file()
    if not INDEX_FILE.is_file():
        return WalletStore()
    index = _read_index()
    wallets: list[WalletConfig] = []
    seen: set[str] = set()
    for wid in index.get("wallet_ids") or []:
        wid_s = str(wid)
        if not wid_s or wid_s in seen:
            continue
        path = _find_wallet_file(wid_s)
        if path is None:
            continue
        try:
            with path.open(encoding="utf-8") as f:
                raw = json.load(f)
            if not isinstance(raw, dict):
                continue
            wallets.append(WalletConfig.from_dict(raw))
            seen.add(wid_s)
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            continue
    recovered = False
    # Recover wallet files present on disk but missing from the index.
    if WALLETS_DIR.is_dir():
        for path in sorted(WALLETS_DIR.glob("*.json")):
            try:
                with path.open(encoding="utf-8") as f:
                    raw = json.load(f)
                if not isinstance(raw, dict):
                    continue
                wid = str(raw.get("id") or "")
                if not wid or wid in seen:
                    continue
                wallets.append(WalletConfig.from_dict(raw))
                seen.add(wid)
                recovered = True
            except (OSError, json.JSONDecodeError, TypeError, ValueError):
                continue
    store = WalletStore.from_dict(
        {
            "active_wallet_id": index.get("active_wallet_id"),
            "active_wallet_by_coin": index.get("active_wallet_by_coin") or {},
            "wallets": [w.to_dict() for w in wallets],
        }
    )
    needs_rename = any(
        (found := _find_wallet_file(w.id)) is not None
        and found.resolve() != _wallet_file_path(w, store.wallets).resolve()
        for w in store.wallets
    )
    if recovered or needs_rename or _reconcile_wallet_accounts(store):
        save_store(store)
    return store


def save_store(store: WalletStore) -> None:
    _ensure_data_dir()
    keep_paths: set[Path] = set()
    for w in store.wallets:
        path = _wallet_file_path(w, store.wallets)
        keep_paths.add(path.resolve())
        payload = _disk_dict_for_wallet(w)
        with path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
            f.write("\n")
    _write_index(store)
    if WALLETS_DIR.is_dir():
        for path in WALLETS_DIR.glob("*.json"):
            try:
                if path.resolve() not in keep_paths:
                    path.unlink()
            except OSError:
                pass


def list_wallets() -> list[WalletConfig]:
    return [get_wallet(w.id) or w for w in load_store().wallets]


def get_wallet(wallet_id: str) -> WalletConfig | None:
    unlocked = _unlocked.get(wallet_id)
    if unlocked is not None:
        return unlocked
    return next((w for w in load_store().wallets if w.id == wallet_id), None)


def unlock_wallet(wallet_id: str, password: str) -> WalletConfig:
    store = load_store()
    disk = next((w for w in store.wallets if w.id == wallet_id), None)
    if not disk:
        raise ValueError(f"Wallet not found: {wallet_id}")
    if not disk.encrypted:
        return disk
    if not disk.encrypted_blob:
        raise ValueError("Encrypted wallet is missing ciphertext")
    secrets = decrypt_secrets(disk.encrypted_blob, password)
    merged = apply_secrets(disk.to_dict(), secrets)
    full = WalletConfig.from_dict(merged)
    full.encrypted = True
    full.encrypted_blob = disk.encrypted_blob
    full.password_hint = normalize_password_hint(disk.password_hint)
    _unlocked[wallet_id] = full
    _unlock_passwords[wallet_id] = (password or "").strip()
    # Refresh public policy/m/n on the shell, then re-seal so future locked loads keep icons.
    disk.policy_type = full.policy_type
    disk.multisig_m = full.multisig_m
    disk.multisig_n = full.multisig_n
    disk.label = full.label
    save_store(store)
    return full


def lock_wallet(wallet_id: str) -> WalletConfig | None:
    clear_unlock_session(wallet_id)
    return get_wallet(wallet_id)


def change_wallet_password(
    wallet_id: str,
    current_password: str,
    new_password: str | None,
    password_hint: str | None = None,
) -> WalletConfig:
    """Re-seal with a new password, or store plaintext if new_password is blank."""
    store = load_store()
    disk = next((w for w in store.wallets if w.id == wallet_id), None)
    if not disk:
        raise ValueError(f"Wallet not found: {wallet_id}")
    if not disk.encrypted or not disk.encrypted_blob:
        raise ValueError("Wallet is not encrypted")
    secrets = decrypt_secrets(disk.encrypted_blob, current_password)
    merged = apply_secrets(disk.to_dict(), secrets)
    full = WalletConfig.from_dict(merged)
    full.encrypted = True
    full.policy_type = full.policy_type or disk.policy_type
    full.multisig_m = full.multisig_m or disk.multisig_m
    full.multisig_n = full.multisig_n or disk.multisig_n

    new_pw = (new_password or "").strip()
    if not new_pw:
        # Remove encryption — store secrets in plaintext.
        full.encrypted = False
        full.encrypted_blob = None
        full.password_hint = ""
        clear_unlock_session(wallet_id)
        for i, w in enumerate(store.wallets):
            if w.id == wallet_id:
                store.wallets[i] = full
                break
        save_store(store)
        return full

    hint = (
        normalize_password_hint(password_hint)
        if password_hint is not None
        else normalize_password_hint(disk.password_hint)
    )
    full.password_hint = hint
    sealed = seal_wallet_dict(full.to_dict(), new_pw)
    shell = WalletConfig.from_dict(sealed)
    for i, w in enumerate(store.wallets):
        if w.id == wallet_id:
            store.wallets[i] = shell
            break
    # Keep unlocked in this session with the new password.
    session_full = WalletConfig.from_dict({**full.to_dict(), "encrypted": True})
    session_full.encrypted_blob = shell.encrypted_blob
    session_full.password_hint = hint
    _unlocked[wallet_id] = session_full
    _unlock_passwords[wallet_id] = new_pw
    save_store(store)
    return get_wallet(wallet_id) or session_full


def encrypt_wallet(
    wallet_id: str,
    password: str,
    password_hint: str | None = None,
) -> WalletConfig:
    """Seal an unencrypted wallet on disk; keep unlocked for this session."""
    pw = (password or "").strip()
    if not pw:
        raise ValueError("Password required to encrypt wallet")
    store = load_store()
    disk = next((w for w in store.wallets if w.id == wallet_id), None)
    if not disk:
        raise ValueError(f"Wallet not found: {wallet_id}")
    if disk.encrypted:
        raise ValueError("Wallet is already encrypted")
    full = WalletConfig.from_dict(disk.to_dict())
    if not (full.kpub or "").strip() and not (full.descriptor or "").strip():
        raise ValueError("Wallet has no secrets to encrypt")
    hint = normalize_password_hint(password_hint)
    full.password_hint = hint
    sealed = seal_wallet_dict(full.to_dict(), pw)
    shell = WalletConfig.from_dict(sealed)
    for i, w in enumerate(store.wallets):
        if w.id == wallet_id:
            store.wallets[i] = shell
            break
    session_full = WalletConfig.from_dict({**full.to_dict(), "encrypted": True})
    session_full.encrypted_blob = shell.encrypted_blob
    session_full.password_hint = hint
    _unlocked[wallet_id] = session_full
    _unlock_passwords[wallet_id] = pw
    save_store(store)
    return get_wallet(wallet_id) or session_full


def get_active_wallet(coin: str | None = None) -> WalletConfig | None:
    store = load_store()
    key = (coin or "kaspa").strip().lower()
    wid = store.active_wallet_by_coin.get(key) or (
        store.active_wallet_id if key == "kaspa" else None
    )
    if not wid:
        return None
    cfg = get_wallet(wid)
    if cfg and resolved_wallet_coin(cfg) != key:
        return None
    return cfg


def set_active_wallet(wallet_id: str) -> WalletConfig:
    store = load_store()
    cfg = next((w for w in store.wallets if w.id == wallet_id), None)
    if not cfg:
        raise ValueError(f"Wallet not found: {wallet_id}")
    if wallet_needs_unlock(cfg):
        raise PermissionError("Wallet is locked — unlock with password first")
    store.active_wallet_by_coin[cfg.coin] = wallet_id
    store.active_wallet_id = wallet_id
    save_store(store)
    return get_wallet(wallet_id) or cfg


def find_wallet_by_multisig_cosigners(cosigners: list[dict], coin: str | None = None) -> WalletConfig | None:
    key = _multisig_wallet_key(cosigners)
    if not key:
        return None
    coin_key = (coin or "").strip().lower()
    for w in list_wallets():
        if w.policy_type != "multisig":
            continue
        if _multisig_wallet_key(w.multisig_cosigners) != key:
            continue
        if coin_key and w.coin != coin_key:
            continue
        return w
    return None


def find_wallet_by_kpub(kpub: str, coin: str | None = None) -> WalletConfig | None:
    key = kpub.strip()
    coin_key = (coin or "").strip().lower()
    for w in list_wallets():
        if not (w.kpub or "").strip():
            continue
        if w.kpub.strip() != key:
            continue
        if coin_key and w.coin != coin_key:
            continue
        return w
    return None


def add_wallet(
    kpub: str,
    label: str,
    scan_limit: int,
    account: int = 0,
    *,
    coin: str = "kaspa",
    derivation: str = "",
    fingerprint: str = "",
    script_type: str = "",
    policy_type: str = "",
    multisig_m: int = 0,
    multisig_n: int = 0,
    multisig_cosigners: list[dict] | None = None,
    descriptor: str = "",
    hardware: str = "",
    keystore_label: str = "",
    activate: bool = True,
    password: str | None = None,
    password_hint: str | None = None,
) -> WalletConfig:
    store = load_store()
    key = kpub.strip()
    coin_key = (coin or "kaspa").strip().lower()
    if coin_key not in VALID_COINS:
        raise ValueError(f"Unsupported coin: {coin}")
    cosigners = _normalize_multisig_cosigners(multisig_cosigners or [])
    if (policy_type or "").strip() == "multisig" and cosigners:
        existing = find_wallet_by_multisig_cosigners(cosigners, coin=coin_key)
        if existing:
            raise ValueError("This multisig policy is already imported for this coin")
    else:
        existing = find_wallet_by_kpub(key, coin=coin_key)
        if existing:
            raise ValueError("This watch-only key is already imported for this coin")
    pw = (password or "").strip()
    encrypt = bool(pw)
    hint = normalize_password_hint(password_hint) if encrypt else ""
    cfg = WalletConfig(
        id=str(uuid.uuid4()),
        label=label.strip() or "SeedMask",
        kpub=key,
        account=account,
        scan_limit=scan_limit,
        coin=coin_key,
        derivation=(derivation or "").strip(),
        fingerprint=(fingerprint or "").strip(),
        script_type=(script_type or "").strip(),
        policy_type=(policy_type or "").strip(),
        multisig_m=int(multisig_m or 0),
        multisig_n=int(multisig_n or 0),
        multisig_cosigners=cosigners,
        descriptor=(descriptor or "").strip(),
        hardware=(hardware or "").strip().lower(),
        keystore_label=(keystore_label or "").strip(),
        created_at=_now_iso(),
        encrypted=encrypt,
        password_hint=hint,
    )
    if encrypt:
        _unlocked[cfg.id] = copy.deepcopy(cfg)
        _unlock_passwords[cfg.id] = pw
        # Store list keeps a shell placeholder; save seals from session.
        shell = WalletConfig.from_dict(seal_wallet_dict(cfg.to_dict(), pw))
        store.wallets.append(shell)
    else:
        store.wallets.append(cfg)
    if activate or not store.active_wallet_by_coin.get(coin_key):
        if encrypt and wallet_needs_unlock(cfg):
            pass  # should not happen — we just unlocked into session
        store.active_wallet_by_coin[coin_key] = cfg.id
        if coin_key == "kaspa":
            store.active_wallet_id = cfg.id
    save_store(store)
    return get_wallet(cfg.id) or cfg


def update_wallet(
    wallet_id: str,
    *,
    label: str | None = None,
    scan_limit: int | None = None,
    fingerprint: str | None = None,
    hardware: str | None = None,
    keystore_label: str | None = None,
    multisig_cosigners: list[dict] | None = None,
    last_synced_at: str | None = None,
) -> WalletConfig:
    store = load_store()
    disk_cfg = next((w for w in store.wallets if w.id == wallet_id), None)
    if not disk_cfg:
        raise ValueError(f"Wallet not found: {wallet_id}")
    secret_touch = fingerprint is not None or multisig_cosigners is not None
    if disk_cfg.encrypted and secret_touch and wallet_id not in _unlocked:
        raise PermissionError("Wallet is locked — unlock with password first")
    cfg = _unlocked.get(wallet_id) or disk_cfg
    if label is not None:
        cfg.label = label.strip() or cfg.label
        disk_cfg.label = cfg.label
    if scan_limit is not None:
        cfg.scan_limit = scan_limit
        disk_cfg.scan_limit = scan_limit
    if fingerprint is not None:
        cfg.fingerprint = fingerprint.strip()
    if hardware is not None:
        cfg.hardware = hardware.strip().lower()
        disk_cfg.hardware = cfg.hardware
    if keystore_label is not None:
        cfg.keystore_label = keystore_label.strip()
        disk_cfg.keystore_label = cfg.keystore_label
    if multisig_cosigners is not None:
        merged: list[dict] = []
        existing = cfg.multisig_cosigners or []
        for idx, incoming in enumerate(multisig_cosigners):
            base = existing[idx] if idx < len(existing) else {}
            merged.append(
                {
                    "xpub": str(incoming.get("xpub") or base.get("xpub") or "").strip(),
                    "fingerprint": str(
                        incoming.get("fingerprint")
                        if incoming.get("fingerprint") is not None
                        else base.get("fingerprint") or ""
                    ).strip(),
                    "derivation": str(incoming.get("derivation") or base.get("derivation") or "").strip(),
                    "label": str(
                        incoming.get("label")
                        if incoming.get("label") is not None
                        else base.get("label") or ""
                    ).strip(),
                }
            )
        cfg.multisig_cosigners = _normalize_multisig_cosigners(merged)
        if cfg.multisig_cosigners and fingerprint is None:
            first_fp = str(cfg.multisig_cosigners[0].get("fingerprint") or "").strip()
            if first_fp:
                cfg.fingerprint = first_fp
    if last_synced_at is not None:
        cfg.last_synced_at = last_synced_at
        disk_cfg.last_synced_at = last_synced_at
    if wallet_id in _unlocked:
        _unlocked[wallet_id] = cfg
    elif not disk_cfg.encrypted:
        # Replace plaintext entry in store.
        for i, w in enumerate(store.wallets):
            if w.id == wallet_id:
                store.wallets[i] = cfg
                break
    save_store(store)
    return get_wallet(wallet_id) or cfg


def remove_wallet(wallet_id: str) -> None:
    clear_unlock_session(wallet_id)
    store = load_store()
    removed = next((w for w in store.wallets if w.id == wallet_id), None)
    store.wallets = [w for w in store.wallets if w.id != wallet_id]
    if store.active_wallet_id == wallet_id:
        store.active_wallet_id = None
    if removed:
        store.active_wallet_by_coin.pop(removed.coin, None)
        fallback = next((w for w in store.wallets if w.coin == removed.coin), None)
        if fallback:
            store.active_wallet_by_coin[removed.coin] = fallback.id
            if removed.coin == "kaspa":
                store.active_wallet_id = fallback.id
    if store.active_wallet_id is None:
        kaspa_active = store.active_wallet_by_coin.get("kaspa")
        if kaspa_active and get_wallet(kaspa_active):
            store.active_wallet_id = kaspa_active
    save_store(store)


def clear_all_wallets() -> None:
    clear_unlock_session()
    save_store(WalletStore())


# Legacy single-wallet helpers (active wallet).
def load_wallet() -> WalletConfig | None:
    return get_active_wallet()


def save_wallet(cfg: WalletConfig) -> None:
    store = load_store()
    for i, w in enumerate(store.wallets):
        if w.id == cfg.id:
            store.wallets[i] = cfg
            save_store(store)
            return
    store.wallets.append(cfg)
    if store.active_wallet_id is None:
        store.active_wallet_id = cfg.id
    save_store(store)


def clear_wallet() -> None:
    active = get_active_wallet()
    if active:
        remove_wallet(active.id)
