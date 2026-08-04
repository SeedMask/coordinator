"""Persist watch-only wallets (kpub) locally — no seed, no private keys."""

from __future__ import annotations

import json
import re
import shutil
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

_ACCOUNT_FROM_DERIV_RE = re.compile(r"m/(?:44'/111111'|84'/0'|48'/0')/(\d+)'")
_KASPA_RECEIVE_INDEX_FROM_DERIV_RE = re.compile(r"m/44'/111111'/0'/0/(\d+)\s*$")

OLD_DATA_DIR = Path.home() / ".seedpass-coordinator"
DATA_DIR = Path.home() / ".seedmask-coordinator"
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

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> WalletConfig:
        wid = str(d.get("id") or "").strip() or str(uuid.uuid4())
        coin = str(d.get("coin") or "kaspa").strip().lower()
        if coin not in VALID_COINS:
            coin = "kaspa"
        return cls(
            id=wid,
            label=str(d.get("label") or "SeedMask"),
            kpub=str(d["kpub"]).strip(),
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
        )


@dataclass
class WalletStore:
    active_wallet_id: str | None = None
    active_wallet_by_coin: dict[str, str] = field(default_factory=dict)
    wallets: list[WalletConfig] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "active_wallet_id": self.active_wallet_id,
            "active_wallet_by_coin": dict(self.active_wallet_by_coin),
            "wallets": [w.to_dict() for w in self.wallets],
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


def _ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _migrate_legacy_files() -> None:
    global _migrated
    if _migrated:
        return
    _migrated = True
    _ensure_data_dir()
    if WALLETS_FILE.is_file():
        return
    legacy_src = None
    for path in (LEGACY_WALLET_FILE, OLD_LEGACY_WALLET_FILE):
        if path.is_file():
            legacy_src = path
            break
    if legacy_src is None and OLD_DATA_DIR.is_dir():
        shutil.copytree(OLD_DATA_DIR, DATA_DIR, dirs_exist_ok=True)
        if WALLETS_FILE.is_file():
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
    if not WALLETS_FILE.is_file():
        return WalletStore()
    with WALLETS_FILE.open(encoding="utf-8") as f:
        store = WalletStore.from_dict(json.load(f))
    if _reconcile_wallet_accounts(store):
        save_store(store)
    return store


def save_store(store: WalletStore) -> None:
    _ensure_data_dir()
    with WALLETS_FILE.open("w", encoding="utf-8") as f:
        json.dump(store.to_dict(), f, indent=2)
        f.write("\n")


def list_wallets() -> list[WalletConfig]:
    return list(load_store().wallets)


def get_wallet(wallet_id: str) -> WalletConfig | None:
    return next((w for w in load_store().wallets if w.id == wallet_id), None)


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
    store.active_wallet_by_coin[cfg.coin] = wallet_id
    store.active_wallet_id = wallet_id
    save_store(store)
    return cfg


def find_wallet_by_multisig_cosigners(cosigners: list[dict], coin: str | None = None) -> WalletConfig | None:
    key = _multisig_wallet_key(cosigners)
    if not key:
        return None
    coin_key = (coin or "").strip().lower()
    for w in load_store().wallets:
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
    for w in load_store().wallets:
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
    )
    store.wallets.append(cfg)
    if activate or not store.active_wallet_by_coin.get(coin_key):
        store.active_wallet_by_coin[coin_key] = cfg.id
        if coin_key == "kaspa":
            store.active_wallet_id = cfg.id
    save_store(store)
    return cfg


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
    cfg = next((w for w in store.wallets if w.id == wallet_id), None)
    if not cfg:
        raise ValueError(f"Wallet not found: {wallet_id}")
    if label is not None:
        cfg.label = label.strip() or cfg.label
    if scan_limit is not None:
        cfg.scan_limit = scan_limit
    if fingerprint is not None:
        cfg.fingerprint = fingerprint.strip()
    if hardware is not None:
        cfg.hardware = hardware.strip().lower()
    if keystore_label is not None:
        cfg.keystore_label = keystore_label.strip()
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
    save_store(store)
    return cfg


def remove_wallet(wallet_id: str) -> None:
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
