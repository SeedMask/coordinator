"""On-chain transaction history for watch-only wallets (Kaspa + Bitcoin)."""

from __future__ import annotations

import asyncio
import urllib.parse
from collections import defaultdict
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

from .kaspa_service import SOMPI_PER_KAS, WalletUtxo, _normalize_kaspa_addr
from .network_settings import KaspaNetworkSettings, load_network_settings
from .wallet_store import WalletConfig

TX_LIMIT_PER_ADDRESS = 500
MAX_WALLET_TXS = 5000
_MAX_BTC_ENRICH_TXS = 500
_MAX_BTC_HYDRATE_TXS = 5000
_BTC_MULTIADDR_BATCH = 12
_BTC_HISTORY_CONCURRENCY = 3
_BC_INFO_RETRY_ATTEMPTS = 5
# Values above this are treated as millisecond timestamps (Kaspa API).
_MS_THRESHOLD = 10_000_000_000
_ESPLORA_PRIMARY_TIMEOUT = 1.5
_ESPLORA_FALLBACK_TIMEOUT = 1.5
_HTTP_TIMEOUT = 8.0


def _norm_txid(txid: str) -> str:
    return str(txid or "").strip().lower().replace("0x", "")


def _btc_tx_id_aliases(txid: str) -> set[str]:
    """Treat display txid and its byte-reversed form as one tx.

    Kept for deduping older SeedMask rows that accidentally stored the reversed
    form after a blockchain.info import bug.
    """
    norm = _norm_txid(txid)
    if not norm:
        return set()
    aliases = {norm}
    if len(norm) == 64:
        try:
            aliases.add(bytes.fromhex(norm)[::-1].hex())
        except ValueError:
            pass
    return aliases


def _btc_tx_dict_key(by_id: dict[str, dict], tx: dict) -> str | None:
    txid = _btc_tx_id_from_record(tx)
    if not txid:
        return None
    for alias in _btc_tx_id_aliases(txid):
        if alias in by_id:
            return alias
    return txid


def _store_btc_tx_dict(by_id: dict[str, dict], tx: dict) -> None:
    key = _btc_tx_dict_key(by_id, tx)
    if key:
        by_id[key] = tx


def _dedupe_wallet_txs(rows: list[WalletTx]) -> list[WalletTx]:
    by_id: dict[str, WalletTx] = {}
    alias_to_key: dict[str, str] = {}
    for row in rows:
        tid = _norm_txid(row.transaction_id)
        if not tid:
            continue
        key = tid
        for alias in _btc_tx_id_aliases(tid):
            existing = alias_to_key.get(alias)
            if existing:
                key = existing
                break
        normed = WalletTx(
            transaction_id=key,
            direction=row.direction,
            amount_kas=row.amount_kas,
            block_time=row.block_time,
            counterparty=row.counterparty,
            confirmations=int(getattr(row, "confirmations", 0) or 0),
            rbf=bool(getattr(row, "rbf", False)),
            fee_sompi=getattr(row, "fee_sompi", None),
            accepting_block_blue_score=getattr(row, "accepting_block_blue_score", None),
        )
        prev = by_id.get(key)
        if prev is None or normed.block_time >= prev.block_time:
            # Keep higher confirmation count when merging aliases.
            if prev is not None:
                normed = WalletTx(
                    transaction_id=key,
                    direction=normed.direction,
                    amount_kas=normed.amount_kas,
                    block_time=max(normed.block_time, prev.block_time),
                    counterparty=normed.counterparty or prev.counterparty,
                    confirmations=max(
                        int(getattr(normed, "confirmations", 0) or 0),
                        int(getattr(prev, "confirmations", 0) or 0),
                    ),
                    rbf=bool(getattr(normed, "rbf", False) or getattr(prev, "rbf", False)),
                    fee_sompi=getattr(normed, "fee_sompi", None)
                    if getattr(normed, "fee_sompi", None) is not None
                    else getattr(prev, "fee_sompi", None),
                    accepting_block_blue_score=getattr(normed, "accepting_block_blue_score", None)
                    or getattr(prev, "accepting_block_blue_score", None),
                )
            by_id[key] = normed
        for alias in _btc_tx_id_aliases(tid):
            alias_to_key[alias] = key
    return sorted(by_id.values(), key=lambda t: t.block_time, reverse=True)


def _dedupe_tx_dicts(rows: list[dict]) -> list[dict]:
    """Dedupe transaction dicts by txid aliases; prefer the latest observed id as key."""
    by_id: dict[str, dict] = {}
    alias_to_key: dict[str, str] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        tid = _norm_txid(str(row.get("transaction_id") or row.get("txid") or row.get("hash") or ""))
        if not tid:
            continue
        existing_key = None
        for alias in _btc_tx_id_aliases(tid):
            existing_key = alias_to_key.get(alias)
            if existing_key:
                break
        # Prefer the current observation so healed explorer txids replace reversed ones.
        key = tid
        prev = None
        if existing_key and existing_key in by_id:
            prev = by_id.pop(existing_key)
            if existing_key != key:
                for alias, mapped in list(alias_to_key.items()):
                    if mapped == existing_key:
                        alias_to_key[alias] = key
        elif key in by_id:
            prev = by_id.get(key)
        item = dict(row)
        item["transaction_id"] = key
        if prev is None:
            by_id[key] = item
        else:
            try:
                prev_bt = int(prev.get("block_time") or 0)
            except (TypeError, ValueError):
                prev_bt = 0
            try:
                next_bt = int(item.get("block_time") or 0)
            except (TypeError, ValueError):
                next_bt = 0
            prefer = item if next_bt >= prev_bt else prev
            other = prev if prefer is item else item
            try:
                prefer_conf = int(prefer.get("confirmations") or 0)
            except (TypeError, ValueError):
                prefer_conf = 0
            try:
                other_conf = int(other.get("confirmations") or 0)
            except (TypeError, ValueError):
                other_conf = 0
            merged = dict(prefer)
            merged["transaction_id"] = key
            merged["confirmations"] = max(prefer_conf, other_conf)
            if not merged.get("counterparty") and other.get("counterparty"):
                merged["counterparty"] = other.get("counterparty")
            by_id[key] = merged
        for alias in _btc_tx_id_aliases(tid):
            alias_to_key[alias] = key

    def sort_key(d: dict) -> tuple[int, str]:
        try:
            bt = int(d.get("block_time") or 0)
        except (TypeError, ValueError):
            bt = 0
        return (-bt, str(d.get("transaction_id") or ""))

    return sorted(by_id.values(), key=sort_key)


# One-shot public history for a single import/discover (does not change Connections).
_kaspa_history_once_public: ContextVar[bool] = ContextVar("kaspa_history_once_public", default=False)


def _kaspa_history_base() -> str:
    if _kaspa_history_once_public.get():
        return KaspaNetworkSettings.history_api_base.rstrip("/")
    return load_network_settings().kaspa.history_api_base


def _kaspa_history_enabled() -> bool:
    if _kaspa_history_once_public.get():
        return True
    settings = load_network_settings().kaspa
    return settings.history_mode in {"public", "custom"} and bool(settings.history_api_base)


def _kaspa_uses_own_node() -> bool:
    """True when Connections → Kaspa is Your own node (custom RPC)."""
    settings = load_network_settings().kaspa
    return (settings.rpc_mode or "").strip().lower() == "custom" and bool((settings.rpc_url or "").strip())


_Kaspa_Tip_CACHE: tuple[int, float] | None = None
# Kaspa mainnet ~10 BPS.
_Kaspa_Tip_TTL_SEC = 0.05
_KASPA_BPS = 10
_kaspa_http: httpx.AsyncClient | None = None
_kaspa_tip_pump_task: asyncio.Task | None = None


def clear_kaspa_tip_cache() -> None:
    """Drop cached tip when network settings change (Automatic ↔ own node)."""
    global _Kaspa_Tip_CACHE
    _Kaspa_Tip_CACHE = None


def _store_kaspa_tip(tip: int, now: float, *, allow_lower: bool = False) -> int:
    """Update tip cache. Own-node tips may replace a higher stale explorer sample."""
    global _Kaspa_Tip_CACHE
    if tip <= 0:
        return _Kaspa_Tip_CACHE[0] if _Kaspa_Tip_CACHE is not None else 0
    prev = _Kaspa_Tip_CACHE[0] if _Kaspa_Tip_CACHE is not None else 0
    if tip >= prev or allow_lower:
        _Kaspa_Tip_CACHE = (tip, now)
        return tip
    return prev


async def _kaspa_rpc_sink_blue_score() -> int:
    from .kaspa_service import get_service

    return int(await get_service().get_sink_blue_score() or 0)


def _kaspa_http_client() -> httpx.AsyncClient:
    """Reuse one client so tip polls stay fast (no new TLS handshake each time)."""
    global _kaspa_http
    if _kaspa_http is None:
        _kaspa_http = httpx.AsyncClient(
            timeout=httpx.Timeout(2.5, connect=1.0),
            headers={"Accept": "application/json", "User-Agent": "SeedMask-Coordinator/1.0"},
            follow_redirects=True,
        )
    return _kaspa_http


async def _kaspa_virtual_blue_score(*, force: bool = False) -> int:
    """Current VSPC blue score (tip) for confirmation depth.

    Own node → kaspad getSinkBlueScore (works with History off).
    Automatic → public history API (unchanged).
    """
    global _Kaspa_Tip_CACHE
    import time

    if _kaspa_uses_own_node():
        now = time.monotonic()
        if (
            not force
            and _Kaspa_Tip_CACHE is not None
            and now - _Kaspa_Tip_CACHE[1] < _Kaspa_Tip_TTL_SEC
        ):
            return _Kaspa_Tip_CACHE[0]
        try:
            tip = await _kaspa_rpc_sink_blue_score()
            return _store_kaspa_tip(tip, now, allow_lower=True)
        except Exception:
            if _Kaspa_Tip_CACHE is not None:
                return _Kaspa_Tip_CACHE[0]
            return 0

    if not _kaspa_history_enabled():
        return 0
    now = time.monotonic()
    if (
        not force
        and _Kaspa_Tip_CACHE is not None
        and now - _Kaspa_Tip_CACHE[1] < _Kaspa_Tip_TTL_SEC
    ):
        return _Kaspa_Tip_CACHE[0]
    base = _kaspa_history_base().rstrip("/")
    url = f"{base}/info/virtual-chain-blue-score"
    try:
        resp = await _kaspa_http_client().get(url)
        resp.raise_for_status()
        data = resp.json()
        tip = int(data.get("blueScore") or data.get("blue_score") or 0)
        if tip > 0:
            return _store_kaspa_tip(tip, now, allow_lower=False)
    except Exception:
        pass
    if _Kaspa_Tip_CACHE is not None:
        return _Kaspa_Tip_CACHE[0]
    return 0


async def _kaspa_tip_pump_loop() -> None:
    """Keep tip cache warm so UI tip polls are local/instant (~no explorer RTT)."""
    while True:
        try:
            if _kaspa_uses_own_node():
                try:
                    await _kaspa_virtual_blue_score_fast()
                except Exception:
                    pass
                await asyncio.sleep(0.25)
                continue
            if not _kaspa_history_enabled():
                await asyncio.sleep(1.0)
                continue
            try:
                await _kaspa_virtual_blue_score_fast()
            except Exception:
                pass
            await asyncio.sleep(0.08)
        except Exception:
            return


def ensure_kaspa_tip_pump() -> None:
    """Start background tip refresher once (safe to call from any request)."""
    global _kaspa_tip_pump_task
    if not _kaspa_uses_own_node() and not _kaspa_history_enabled():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if _kaspa_tip_pump_task is not None and not _kaspa_tip_pump_task.done():
        return
    _kaspa_tip_pump_task = loop.create_task(_kaspa_tip_pump_loop())


async def stop_kaspa_tip_pump() -> None:
    global _kaspa_tip_pump_task
    task = _kaspa_tip_pump_task
    _kaspa_tip_pump_task = None
    if task is None:
        return
    task.cancel()
    try:
        await task
    except Exception:
        pass


def _kaspa_confirmations_from_tx(tx: dict, tip_blue: int) -> int:
    """Confirmations ≈ tip blue score − accepting block blue score (~10 BPS)."""
    try:
        block_time_raw = int(tx.get("block_time") or tx.get("accepting_block_time") or 0)
    except (TypeError, ValueError):
        block_time_raw = 0
    accepting = bool(
        tx.get("is_accepted")
        or tx.get("accepted")
        or tx.get("accepting_block_hash")
        or tx.get("acceptingBlockHash")
        or block_time_raw > 0
    )
    if not accepting:
        return 0
    accepting_blue = _accepting_blue_from_tx(tx)
    if tip_blue > 0 and accepting_blue > 0 and tip_blue >= accepting_blue:
        return max(1, tip_blue - accepting_blue)
    # Fallback when accepting blue score is unknown: Kaspa ~10 BPS.
    bt = _block_time_seconds(block_time_raw)
    if bt > 0:
        import time

        age_sec = max(0, int(time.time()) - bt)
        return max(1, age_sec * _KASPA_BPS)
    return 1


def _btc_esplora_primary() -> str:
    return load_network_settings().bitcoin.esplora_primary


def _btc_esplora_fallbacks() -> tuple[str, ...]:
    return tuple(load_network_settings().bitcoin.esplora_fallbacks)


@dataclass
class WalletTx:
    transaction_id: str
    direction: str  # received | sent
    amount_kas: float
    block_time: int
    counterparty: str
    confirmations: int = 0
    rbf: bool = False
    fee_sompi: int | None = None
    accepting_block_blue_score: int | None = None
    block_height: int | None = None

    def to_dict(self) -> dict:
        amount_kas = float(self.amount_kas or 0)
        out = {
            "transaction_id": self.transaction_id,
            "direction": self.direction,
            "amount_kas": amount_kas,
            "amount_sompi": int(round(amount_kas * SOMPI_PER_KAS)),
            "block_time": _block_time_seconds(self.block_time),
            "counterparty": self.counterparty,
            "confirmations": max(0, int(self.confirmations or 0)),
            "rbf": bool(self.rbf),
        }
        if self.fee_sompi is not None and int(self.fee_sompi) >= 0:
            out["fee_sompi"] = int(self.fee_sompi)
            out["fee_sats"] = int(self.fee_sompi)
        if self.accepting_block_blue_score is not None and int(self.accepting_block_blue_score) > 0:
            out["accepting_block_blue_score"] = int(self.accepting_block_blue_score)
        if self.block_height is not None and int(self.block_height) > 0:
            out["block_height"] = int(self.block_height)
        return out


def _accepting_blue_from_tx(tx: dict) -> int:
    try:
        return int(
            tx.get("accepting_block_blue_score")
            or tx.get("acceptingBlockBlueScore")
            or tx.get("accepting_blue_score")
            or 0
        )
    except (TypeError, ValueError):
        return 0


async def _fetch_kaspa_tx_acceptance(txid: str) -> dict | None:
    """Lookup acceptance / blue score for a single tx (None if unknown / not indexed yet)."""
    tid = _norm_txid(txid)
    if not tid:
        return None
    base = _kaspa_history_base().rstrip("/")
    url = f"{base}/transactions/{tid}?resolve_previous_outpoints=light"
    headers = {"Accept": "application/json", "User-Agent": "SeedMask-Coordinator/1.0"}
    try:
        resp = await _kaspa_http_client().get(url, headers=headers)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        data = resp.json()
        return data if isinstance(data, dict) else None
    except Exception:
        return None


async def refresh_kaspa_confirmation_counts(
    dicts: list[dict],
    *,
    hydrate: bool = True,
    force_tip: bool = True,
) -> list[dict]:
    """Recompute confirmation depth from live tip − accepting blue score (~10 BPS).

    Once an accepting blue score is known, it is frozen so counts only rise with the tip
    (no age-estimate thrash / backwards jumps).
    """
    if not dicts:
        return dicts
    import time as _time

    tip_blue = int(await _kaspa_virtual_blue_score(force=force_tip) or 0)
    now = _time.time()

    # Hydrate stub / just-broadcast rows so Unconfirmed → live confirmation counts.
    if hydrate:
        need_hydrate: list[dict] = []
        for d in dicts:
            if not isinstance(d, dict):
                continue
            try:
                conf = int(d.get("confirmations") or 0)
            except (TypeError, ValueError):
                conf = 0
            if conf >= 200:
                continue
            if _accepting_blue_from_tx(d) > 0:
                continue
            if not _norm_txid(str(d.get("transaction_id") or "")):
                continue
            need_hydrate.append(d)
        need_hydrate.sort(key=lambda row: int(row.get("block_time") or 0), reverse=True)
        if need_hydrate:
            fetched = await asyncio.gather(
                *[
                    _fetch_kaspa_tx_acceptance(str(d.get("transaction_id") or ""))
                    for d in need_hydrate[:8]
                ]
            )
            for d, info in zip(need_hydrate[:8], fetched):
                if not info:
                    continue
                accepting_blue = _accepting_blue_from_tx(info)
                if accepting_blue > 0:
                    d["accepting_block_blue_score"] = accepting_blue
                if info.get("accepting_block_hash") or info.get("acceptingBlockHash"):
                    d["accepting_block_hash"] = (
                        info.get("accepting_block_hash") or info.get("acceptingBlockHash")
                    )
                if info.get("is_accepted") or info.get("accepted"):
                    d["is_accepted"] = True
                try:
                    api_bt = int(info.get("block_time") or info.get("accepting_block_time") or 0)
                except (TypeError, ValueError):
                    api_bt = 0
                if api_bt > 0:
                    d["block_time"] = _block_time_seconds(api_bt)

    for d in dicts:
        if not isinstance(d, dict):
            continue
        try:
            prev_conf = int(d.get("confirmations") or 0)
        except (TypeError, ValueError):
            prev_conf = 0
        if prev_conf >= 200:
            d["confirmations"] = prev_conf
            continue

        accepting_blue = _accepting_blue_from_tx(d)
        try:
            bt = int(d.get("block_time") or 0)
        except (TypeError, ValueError):
            bt = 0
        bt_sec = _block_time_seconds(bt) if bt else 0
        # Sub-second age so we don't stair-step +10 only on whole seconds.
        age_sec = max(0.0, now - float(bt_sec)) if bt_sec > 0 else 0.0
        accepted = bool(
            d.get("is_accepted")
            or d.get("accepted")
            or d.get("accepting_block_hash")
            or d.get("acceptingBlockHash")
            or accepting_blue > 0
        )

        # Freeze accepting blue once known — never rewrite from wall-clock age.
        if accepting_blue <= 0:
            if not accepted:
                if bt_sec <= 0 or age_sec < 1.0:
                    d["confirmations"] = 0
                    continue
            if tip_blue > 0 and bt_sec > 0:
                # Temporary conf only — do NOT persist estimated accepting blue.
                # A wrong locked estimate causes permanent confirmation glitches.
                conf = max(1, int(age_sec * _KASPA_BPS))
                d["confirmations"] = max(prev_conf, conf)
                continue
            elif bt_sec > 0:
                conf = max(prev_conf, max(1, int(age_sec * _KASPA_BPS)))
                d["confirmations"] = conf
                continue
            else:
                d["confirmations"] = 0
                continue

        if tip_blue > 0 and accepting_blue > 0 and tip_blue >= accepting_blue:
            conf = max(1, tip_blue - accepting_blue)
        else:
            conf = max(1, int(age_sec * _KASPA_BPS)) if age_sec > 0 else 1
        # Monotonic: never flash backwards when tip/age polls race.
        d["confirmations"] = max(prev_conf, conf)
    return dicts


async def get_kaspa_tip_blue(*, force: bool = True) -> dict:
    """Ultra-light tip read for smooth confirmation UI.

    Prefer the warm cache from the background tip pump so the Electron UI never
    waits on explorer RTT for each tick.
    """
    import time as _time

    ensure_kaspa_tip_pump()
    tip = 0
    if _Kaspa_Tip_CACHE is not None:
        tip = int(_Kaspa_Tip_CACHE[0] or 0)
    if tip <= 0 or (force and _Kaspa_Tip_CACHE is None):
        tip = int(await _kaspa_virtual_blue_score_fast() or 0)
    elif not force:
        tip = int(await _kaspa_virtual_blue_score(force=False) or 0)
    age_ms = 0
    if _Kaspa_Tip_CACHE is not None:
        age_ms = int(max(0.0, (_time.monotonic() - _Kaspa_Tip_CACHE[1]) * 1000))
    return {
        "tip_blue": tip,
        "bps": _KASPA_BPS,
        "server_time_ms": int(_time.time() * 1000),
        "cache_age_ms": age_ms,
    }


async def _kaspa_virtual_blue_score_fast() -> int:
    """Tip fetch with a short timeout for the UI poller / tip pump."""
    import time

    if _kaspa_uses_own_node():
        now = time.monotonic()
        if _Kaspa_Tip_CACHE is not None and now - _Kaspa_Tip_CACHE[1] < 0.05:
            return _Kaspa_Tip_CACHE[0]
        try:
            tip = await _kaspa_rpc_sink_blue_score()
            return _store_kaspa_tip(tip, now, allow_lower=True)
        except Exception:
            if _Kaspa_Tip_CACHE is not None:
                return _Kaspa_Tip_CACHE[0]
            return 0

    if not _kaspa_history_enabled():
        return 0
    now = time.monotonic()
    if _Kaspa_Tip_CACHE is not None and now - _Kaspa_Tip_CACHE[1] < 0.05:
        return _Kaspa_Tip_CACHE[0]
    base = _kaspa_history_base().rstrip("/")
    url = f"{base}/info/virtual-chain-blue-score"
    try:
        resp = await _kaspa_http_client().get(url, timeout=httpx.Timeout(0.8, connect=0.4))
        resp.raise_for_status()
        data = resp.json()
        tip = int(data.get("blueScore") or data.get("blue_score") or 0)
        if tip > 0:
            return _store_kaspa_tip(tip, now, allow_lower=False)
    except Exception:
        pass
    if _Kaspa_Tip_CACHE is not None:
        return _Kaspa_Tip_CACHE[0]
    return 0


async def tick_kaspa_confirmations(wallet_id: str) -> dict:
    """Fast tip-only confirmation update for the dashboard (no full history scrape)."""
    import time as _time

    from . import wallet_state

    dicts = wallet_state.get_transactions(wallet_id)
    # Only hydrate rows that still lack accepting blue (cheap after the first tick).
    need_hydrate = any(
        isinstance(d, dict)
        and int(d.get("confirmations") or 0) < 200
        and _accepting_blue_from_tx(d) <= 0
        for d in dicts
    )
    updated = await refresh_kaspa_confirmation_counts(
        dicts,
        hydrate=need_hydrate,
        force_tip=True,
    )
    try:
        wallet_state.upsert_transactions(wallet_id, updated)
    except Exception:
        pass
    tip_blue = int(await _kaspa_virtual_blue_score(force=False) or 0)
    out_updates = []
    for d in updated:
        if not isinstance(d, dict):
            continue
        tid = _norm_txid(str(d.get("transaction_id") or ""))
        if not tid:
            continue
        try:
            conf = int(d.get("confirmations") or 0)
        except (TypeError, ValueError):
            conf = 0
        accepting = _accepting_blue_from_tx(d)
        # Stream climbing rows + pending stubs the UI still shows.
        if conf >= 200 and accepting <= 0:
            continue
        if conf >= 200:
            # Include once so UI can flip to Confirmed; client will stop polling them.
            out_updates.append(
                {
                    "transaction_id": tid,
                    "confirmations": conf,
                    "accepting_block_blue_score": accepting or None,
                    "block_time": int(d.get("block_time") or 0) or None,
                }
            )
            continue
        out_updates.append(
            {
                "transaction_id": tid,
                "confirmations": conf,
                "accepting_block_blue_score": accepting or None,
                "block_time": int(d.get("block_time") or 0) or None,
            }
        )
    return {
        "tip_blue": tip_blue,
        "bps": _KASPA_BPS,
        "server_time_ms": int(_time.time() * 1000),
        "updates": out_updates,
    }


def _block_time_seconds(raw: int) -> int:
    """Normalize chain timestamps to Unix seconds for the UI."""
    if raw <= 0:
        return 0
    if raw > _MS_THRESHOLD:
        return raw // 1000
    return raw


def _history_addresses(
    cfg: WalletConfig,
    receive_pairs: list[tuple[int, str]],
    change_pairs: list[tuple[int, str]],
    utxos: list | None = None,
) -> list[str]:
    """Derivation paths to scan for tx history (includes used indices + gap, not only live UTXOs)."""
    from .utxo_access import utxo_address, utxo_address_index, utxo_is_change

    limit = max(1, cfg.scan_limit)
    from .wallet_store import resolved_wallet_coin

    coin = resolved_wallet_coin(cfg)

    if coin == "bitcoin":
        # Watch-only history must scan every derived address up to scan_limit.
        # Gap-limited windows miss fully-spent receive/change addresses (common for old wallets).
        receive = [addr for i, addr in receive_pairs if i < limit]
        change = [addr for i, addr in change_pairs if i < limit]
        addrs = list(dict.fromkeys(receive + change))
        if utxos:
            for u in utxos:
                addr = utxo_address(u)
                if addr:
                    addrs.append(addr)
            addrs = list(dict.fromkeys(addrs))
        return addrs

    # Kaspa: scan the full Scan depth (like Bitcoin), plus any live UTXO addresses
    # so history is not missing when funds land past a tight gap window.
    receive = [addr for i, addr in receive_pairs if i < limit]
    change = [addr for i, addr in change_pairs if i < limit]
    addrs = list(dict.fromkeys(receive + change))
    gap = 20
    used_receive: set[int] = set()
    used_change: set[int] = set()
    from .address_usage import persisted_used_receive_indices
    from .address_index import load_address_index

    used_receive |= persisted_used_receive_indices(cfg.id)
    used_receive |= set(load_address_index(cfg.id).get("receive_indices") or [])
    for u in utxos or []:
        idx = utxo_address_index(u)
        addr = utxo_address(u)
        if addr:
            addrs.append(addr)
        if idx < 0:
            continue
        if utxo_is_change(u):
            used_change.add(idx)
        else:
            used_receive.add(idx)

    # Also include gap ahead of last used (may exceed scan_limit via receive_pairs if provided longer).
    recv_hi = (max(used_receive) if used_receive else 0) + gap
    receive_extra = [addr for i, addr in receive_pairs if i <= recv_hi]
    chg_pad = 8
    chg_hi = max((max(used_change) if used_change else 0) + chg_pad, 5)
    change_extra = [addr for i, addr in change_pairs if i <= chg_hi]
    addrs = list(dict.fromkeys(addrs + receive_extra + change_extra))
    return addrs


def _kaspa_addr_key(addr: str) -> str:
    if not addr:
        return ""
    try:
        return _normalize_kaspa_addr(addr)
    except ValueError:
        return addr.strip().lower()


def _kaspa_wallet_addrs(receive_pairs: list[tuple[int, str]], change_pairs: list[tuple[int, str]]) -> set[str]:
    keys: set[str] = set()
    for _, addr in receive_pairs:
        keys.add(_kaspa_addr_key(addr))
    for _, addr in change_pairs:
        keys.add(_kaspa_addr_key(addr))
    return keys


def _coerce_sompi(raw: object) -> int:
    if raw is None:
        return 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


async def _fetch_address_txs(address: str, limit: int = TX_LIMIT_PER_ADDRESS) -> list[dict]:
    """Kaspa REST history via httpx (uses system CA bundle; urllib fails SSL on macOS Python)."""
    if not _kaspa_history_enabled():
        return []
    q = urllib.parse.urlencode(
        {
            "limit": limit,
            "resolve_previous_outpoints": "light",
            "acceptance": "accepted",
        }
    )
    url = f"{_kaspa_history_base()}/addresses/{urllib.parse.quote(address, safe='')}/full-transactions-page?{q}"
    headers = {"Accept": "application/json", "User-Agent": "SeedMask-Coordinator/1.0"}
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(_HTTP_TIMEOUT, connect=4.0),
                headers=headers,
                follow_redirects=True,
            ) as client:
                resp = await client.get(url)
                if resp.status_code == 404:
                    return []
                resp.raise_for_status()
                data = resp.json()
                return data if isinstance(data, list) else []
        except (httpx.HTTPError, ValueError) as e:
            last_err = e
            if attempt < 2:
                await asyncio.sleep(0.25 * (attempt + 1))
    _ = last_err
    return []


def _classify_kaspa_tx(
    tx: dict,
    wallet_addrs: set[str],
    change_addrs: set[str],
    *,
    tip_blue: int = 0,
) -> WalletTx | None:
    txid = str(tx.get("transaction_id") or "").lower().replace("0x", "")
    if not txid:
        return None

    received = 0
    sent = 0
    external_out: list[tuple[int, str]] = []
    internal_receive_out: list[tuple[int, str]] = []
    external_in: list[tuple[int, str]] = []
    wallet_input_count = 0

    for out in tx.get("outputs") or []:
        raw_addr = str(out.get("script_public_key_address") or "")
        addr = _kaspa_addr_key(raw_addr)
        amount = _coerce_sompi(out.get("amount"))
        if not addr:
            continue
        if addr in wallet_addrs:
            received += amount
            if addr not in change_addrs:
                internal_receive_out.append((amount, raw_addr or addr))
        else:
            external_out.append((amount, raw_addr or addr))

    for inp in tx.get("inputs") or []:
        raw_addr = str(inp.get("previous_outpoint_address") or "")
        addr = _kaspa_addr_key(raw_addr)
        amount = _coerce_sompi(inp.get("previous_outpoint_amount"))
        if addr in wallet_addrs:
            sent += amount
            wallet_input_count += 1
        elif addr:
            external_in.append((amount, raw_addr or addr))

    external_send = sum(amt for amt, _ in external_out)
    net = received - sent

    if wallet_input_count > 0 and external_send == 0 and not internal_receive_out:
        # Pure change-only / consolidation — not a user-facing transfer.
        return None

    if wallet_input_count > 0:
        direction = "sent"
        if external_send > 0:
            amount = external_send
            counterparty = max(external_out, key=lambda x: x[0])[1]
        elif internal_receive_out:
            # Self-send to another receive address in this wallet.
            amount = sum(amt for amt, _ in internal_receive_out)
            counterparty = max(internal_receive_out, key=lambda x: x[0])[1]
        elif sent > received:
            # Spend with only change back — show gross sent minus change, not the fee.
            amount = sent - received
            counterparty = external_out[0][1] if external_out else ""
        else:
            amount = max(0, sent - received)
            counterparty = external_out[0][1] if external_out else ""
    elif received > 0:
        direction = "received"
        amount = received
        counterparty = external_in[0][1] if external_in else ""
    elif net > 0:
        direction = "received"
        amount = net
        counterparty = external_in[0][1] if external_in else ""
    elif net < 0:
        direction = "sent"
        amount = -net
        counterparty = external_out[0][1] if external_out else ""
    else:
        return None

    if amount <= 0:
        return None

    fee_sompi: int | None = None
    if direction == "sent" and wallet_input_count > 0:
        # Prefer Σinputs − Σoutputs when every input amount is known.
        input_amounts = [
            _coerce_sompi(inp.get("previous_outpoint_amount"))
            for inp in (tx.get("inputs") or [])
        ]
        output_amounts = [
            _coerce_sompi(out.get("amount")) for out in (tx.get("outputs") or [])
        ]
        fee_candidate = 0
        if input_amounts and all(a > 0 for a in input_amounts):
            fee_candidate = max(0, sum(input_amounts) - sum(output_amounts))
        else:
            # Wallet inputs − wallet outputs = external payment + fee (or fee alone on self-sends).
            left_wallet = max(0, sent - received)
            if external_send > 0:
                fee_candidate = max(0, left_wallet - external_send)
            else:
                fee_candidate = left_wallet
        if fee_candidate > 0:
            fee_sompi = fee_candidate

    block_time = _block_time_seconds(
        int(tx.get("block_time") or tx.get("accepting_block_time") or 0)
    )
    confirmations = _kaspa_confirmations_from_tx(tx, tip_blue)
    accepting_blue = _accepting_blue_from_tx(tx)
    return WalletTx(
        transaction_id=txid,
        direction=direction,
        amount_kas=amount / SOMPI_PER_KAS,
        block_time=block_time,
        counterparty=counterparty,
        confirmations=confirmations,
        accepting_block_blue_score=accepting_blue if accepting_blue > 0 else None,
        fee_sompi=fee_sompi,
    )


def _iso_to_block_time(iso: str) -> int:
    if not iso:
        return 0
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except ValueError:
        return 0


def merge_synthetic_transactions(
    wallet_id: str,
    utxos: list[WalletUtxo],
    rows: list[WalletTx],
    *,
    coin: str = "kaspa",
) -> list[WalletTx]:
    """Fill gaps while indexers lag behind live UTXO / broadcast metadata."""
    from .transaction_store import list_for_wallet

    coin_key = (coin or "kaspa").strip().lower()
    if coin_key == "bitcoin":
        from .bitcoin_service import SATS_PER_BTC

        unit = SATS_PER_BTC
    else:
        unit = SOMPI_PER_KAS

    by_id = {_norm_txid(r.transaction_id): r for r in rows if _norm_txid(r.transaction_id)}

    for out in list_for_wallet(wallet_id):
        txid = _norm_txid(out.transaction_id or "")
        if not txid or txid in by_id:
            continue
        # Use broadcast time so the row sorts to the top; conf=0 → UI shows Unconfirmed.
        by_id[txid] = WalletTx(
            transaction_id=txid,
            direction="sent",
            amount_kas=out.send_kas,
            block_time=_iso_to_block_time(out.created_at) or int(__import__("time").time()),
            counterparty=out.to_address or "",
            confirmations=0,
            fee_sompi=int(out.fee_sompi or 0) if int(out.fee_sompi or 0) > 0 else None,
        )

    # Bitcoin indexers already return history; UTXO fill-in duplicates rows (esp. change).
    if coin_key != "bitcoin":
        from .utxo_access import utxo_amount, utxo_is_change, utxo_transaction_id

        receive_sompi: dict[str, int] = defaultdict(int)
        for u in utxos or []:
            if utxo_is_change(u):
                continue
            txid = _norm_txid(utxo_transaction_id(u))
            if not txid or txid in by_id:
                continue
            receive_sompi[txid] += utxo_amount(u)

        for txid, sompi in receive_sompi.items():
            if txid in by_id or sompi <= 0:
                continue
            # Counterparty must stay empty/unknown here — using the deposit address
            # caused _filter_visible_* to drop these as fake "self-receives".
            by_id[txid] = WalletTx(
                transaction_id=txid,
                direction="received",
                amount_kas=sompi / unit,
                block_time=0,
                counterparty="",
            )

    merged = list(by_id.values())
    merged.sort(key=lambda t: (t.block_time, t.transaction_id), reverse=True)
    return merged[:MAX_WALLET_TXS]


def merge_receive_utxos_into_tx_dicts(
    dicts: list[dict],
    utxos: list,
    *,
    coin: str = "kaspa",
) -> list[dict]:
    """Ensure live receive UTXOs appear even when history cache / indexer lag."""
    coin_key = (coin or "kaspa").strip().lower()
    if coin_key == "bitcoin":
        return list(dicts or [])

    by_id: dict[str, dict] = {}
    for d in dicts or []:
        if not isinstance(d, dict):
            continue
        tid = _norm_txid(str(d.get("transaction_id") or ""))
        if tid:
            by_id[tid] = d

    unit = SOMPI_PER_KAS
    receive_sompi: dict[str, int] = defaultdict(int)
    for u in utxos or []:
        is_change = bool(getattr(u, "is_change", False) if not isinstance(u, dict) else u.get("is_change"))
        if is_change:
            continue
        txid = _norm_txid(
            str(
                getattr(u, "transaction_id", "")
                if not isinstance(u, dict)
                else (u.get("transaction_id") or "")
            )
        )
        if not txid or txid in by_id:
            continue
        amount = int(getattr(u, "amount", 0) if not isinstance(u, dict) else (u.get("amount") or 0))
        if amount > 0:
            receive_sompi[txid] += amount

    if not receive_sompi:
        return list(dicts or [])

    for txid, sompi in receive_sompi.items():
        by_id[txid] = WalletTx(
            transaction_id=txid,
            direction="received",
            amount_kas=sompi / unit,
            block_time=0,
            counterparty="",
        ).to_dict()

    merged = list(by_id.values())
    merged.sort(
        key=lambda t: (int(t.get("block_time") or 0), str(t.get("transaction_id") or "")),
        reverse=True,
    )
    return merged[:MAX_WALLET_TXS]


def enrich_counterparties_from_raw_cache(
    wallet_id: str,
    rows: list[dict],
    *,
    receive_pairs: list[tuple[int, str]],
    change_pairs: list[tuple[int, str]],
    coin: str,
) -> list[dict]:
    """Fill missing From/To addresses from raw transactions already cached for Tx details."""
    from .tx_raw_cache import cached_wallet_tx

    coin_key = (coin or "kaspa").strip().lower()
    if coin_key == "bitcoin":
        wallet_addrs = {addr for _, addr in receive_pairs} | {addr for _, addr in change_pairs}
        change_addrs = {addr for _, addr in change_pairs}
    else:
        wallet_addrs = {
            _kaspa_addr_key(addr)
            for _, addr in [*receive_pairs, *change_pairs]
            if _kaspa_addr_key(addr)
        }
        change_addrs = {
            _kaspa_addr_key(addr)
            for _, addr in change_pairs
            if _kaspa_addr_key(addr)
        }

    enriched: list[dict] = []
    for row in rows:
        item = dict(row)
        direction = str(item.get("direction") or "").strip().lower()
        is_send = direction in ("sent", "send", "out", "outgoing")
        try:
            existing_fee = int(item.get("fee_sompi") or item.get("fee_sats") or 0)
        except (TypeError, ValueError):
            existing_fee = 0
        try:
            existing_amount = float(item.get("amount_kas") or 0)
        except (TypeError, ValueError):
            existing_amount = 0.0
        needs_counterparty = not str(item.get("counterparty") or "").strip()
        # Always reconcile sends from raw cache when present — older outgoing metadata
        # sometimes stored input totals as fee_sompi (e.g. 2.12 KAS) and blocked backfill.
        needs_fee = is_send
        needs_amount = is_send and existing_amount <= 0
        if not needs_counterparty and not needs_fee and not needs_amount:
            enriched.append(item)
            continue
        txid = _norm_txid(str(item.get("transaction_id") or item.get("txid") or ""))
        raw = cached_wallet_tx(wallet_id, txid) if txid else None
        classified = None
        if raw:
            if coin_key == "bitcoin":
                classified = _classify_btc_tx(raw, wallet_addrs, change_addrs)
            else:
                classified = _classify_kaspa_tx(raw, wallet_addrs, change_addrs)
        if classified:
            if needs_counterparty and str(classified.counterparty or "").strip():
                item["counterparty"] = classified.counterparty
            if needs_amount and float(classified.amount_kas or 0) > 0:
                item["amount_kas"] = float(classified.amount_kas)
            if needs_fee and classified.fee_sompi is not None and int(classified.fee_sompi) >= 0:
                fee = int(classified.fee_sompi)
                # Prefer on-chain fee whenever raw classification succeeded.
                if fee > 0 or existing_fee > 0:
                    if fee > 0:
                        item["fee_sompi"] = fee
                        item["fee_sats"] = fee
                    elif existing_fee > 0 and fee == 0:
                        # Classified fee is zero — drop bogus stored fees.
                        item.pop("fee_sompi", None)
                        item.pop("fee_sats", None)
        enriched.append(item)
    return enriched


def merge_outgoing_into_tx_dicts(wallet_id: str, dicts: list[dict]) -> list[dict]:
    """Ensure just-broadcast outs appear even when serving the SQLite cache (no full sync)."""
    import time as _time

    from .transaction_store import list_for_wallet

    by_id: dict[str, dict] = {}
    for d in dicts or []:
        if not isinstance(d, dict):
            continue
        tid = _norm_txid(str(d.get("transaction_id") or ""))
        if tid:
            by_id[tid] = d

    changed = False
    for out in list_for_wallet(wallet_id):
        txid = _norm_txid(out.transaction_id or "")
        if not txid:
            continue
        bt = _iso_to_block_time(out.created_at) or int(_time.time())
        existing = by_id.get(txid)
        if existing is not None:
            # Older inject used block_time=0 → sorted to bottom; lift pending rows to top.
            try:
                conf = int(existing.get("confirmations") or 0)
            except (TypeError, ValueError):
                conf = 0
            try:
                cur_bt = int(existing.get("block_time") or 0)
            except (TypeError, ValueError):
                cur_bt = 0
            if conf <= 0 and cur_bt <= 0 and bt > 0:
                existing["block_time"] = bt
                changed = True
            continue
        row = WalletTx(
            transaction_id=txid,
            direction="sent",
            amount_kas=float(out.send_kas or 0),
            block_time=bt,
            counterparty=out.to_address or "",
            confirmations=0,
            fee_sompi=int(out.fee_sompi or 0) if int(out.fee_sompi or 0) > 0 else None,
        ).to_dict()
        by_id[txid] = row
        changed = True

    if not changed:
        return list(dicts or [])

    merged = list(by_id.values())
    merged.sort(key=lambda t: (int(t.get("block_time") or 0), str(t.get("transaction_id") or "")), reverse=True)
    return merged[:MAX_WALLET_TXS]


def ensure_broadcast_in_tx_index(
    wallet_id: str,
    transaction_id: str,
    *,
    send_kas: float,
    to_address: str = "",
    fee_sompi: int = 0,
) -> None:
    """Persist a just-broadcast send into the wallet tx index so the dashboard sees it immediately."""
    import time as _time

    from . import wallet_state

    txid = _norm_txid(transaction_id)
    if not txid:
        return
    row = WalletTx(
        transaction_id=txid,
        direction="sent",
        amount_kas=float(send_kas or 0),
        block_time=int(_time.time()),
        counterparty=to_address or "",
        confirmations=0,
        fee_sompi=int(fee_sompi or 0) if int(fee_sompi or 0) > 0 else None,
    ).to_dict()
    wallet_state.upsert_transactions(wallet_id, [row])


def _patch_kaspa_outgoing(wallet_id: str, rows: list[WalletTx]) -> list[WalletTx]:
    """Prefer coordinator broadcast metadata when on-chain parsing only surfaced the fee."""
    from .transaction_store import list_for_wallet

    outgoing = {
        _norm_txid(o.transaction_id): o
        for o in list_for_wallet(wallet_id)
        if _norm_txid(o.transaction_id)
    }
    if not outgoing:
        return rows

    patched: list[WalletTx] = []
    for row in rows:
        out = outgoing.get(_norm_txid(row.transaction_id))
        if not out or row.direction != "sent":
            patched.append(row)
            continue
        fee_sompi = row.fee_sompi
        # Only fill missing fees from broadcast metadata — never overwrite on-chain fees
        # (legacy outgoing rows sometimes stored input totals as fee_sompi).
        out_fee = int(getattr(out, "fee_sompi", 0) or 0)
        if fee_sompi is None and out_fee > 0 and float(out.send_kas or 0) > 0:
            fee_sompi = out_fee
        if out.send_kas > 0 and row.amount_kas + 1e-6 < out.send_kas:
            patched.append(
                WalletTx(
                    transaction_id=row.transaction_id,
                    direction=row.direction,
                    amount_kas=out.send_kas,
                    block_time=row.block_time,
                    counterparty=out.to_address or row.counterparty,
                    confirmations=row.confirmations,
                    accepting_block_blue_score=row.accepting_block_blue_score,
                    fee_sompi=fee_sompi,
                )
            )
        elif row.amount_kas < 0.001 and out.to_address and out.send_kas > 0:
            patched.append(
                WalletTx(
                    transaction_id=row.transaction_id,
                    direction=row.direction,
                    amount_kas=out.send_kas,
                    block_time=row.block_time,
                    counterparty=out.to_address or row.counterparty,
                    confirmations=row.confirmations,
                    accepting_block_blue_score=row.accepting_block_blue_score,
                    fee_sompi=fee_sompi,
                )
            )
        elif row.amount_kas < 0.001 and out.to_address:
            patched.append(
                WalletTx(
                    transaction_id=row.transaction_id,
                    direction=row.direction,
                    amount_kas=row.amount_kas,
                    block_time=row.block_time,
                    counterparty=out.to_address or row.counterparty,
                    confirmations=row.confirmations,
                    accepting_block_blue_score=row.accepting_block_blue_score,
                    fee_sompi=fee_sompi,
                )
            )
        else:
            patched.append(row)
    return patched


def _filter_visible_kaspa_txs(
    rows: list[WalletTx],
    wallet_addrs: set[str],
    change_addrs: set[str],
) -> list[WalletTx]:
    """Hide change-only credits and the receive-side of self-transfers.

    Keep all real external receives. Self-sends still appear as ``sent`` in the
    Transactions list; asset history hides them separately on the client.
    """
    _ = wallet_addrs
    visible: list[WalletTx] = []
    for row in rows:
        cp = (row.counterparty or "").strip()
        cp_key = _kaspa_addr_key(cp) if cp else ""
        if row.direction == "received":
            # Only drop when the *sender* is our change path (internal churn).
            # Do not drop when counterparty is empty (unknown sender) or a
            # normal receive address we happen to also own as destination.
            if cp_key and cp_key in change_addrs:
                continue
        if row.direction == "sent" and cp_key and cp_key in change_addrs:
            continue
        visible.append(row)
    return visible


async def fetch_kaspa_wallet_transactions(
    cfg: WalletConfig,
    receive_pairs: list[tuple[int, str]],
    change_pairs: list[tuple[int, str]],
    utxos: list[WalletUtxo],
) -> list[WalletTx]:
    if not _kaspa_history_enabled():
        wallet_addrs = _kaspa_wallet_addrs(receive_pairs, change_pairs)
        change_addrs = _kaspa_wallet_addrs(change_pairs, [])
        local_rows = merge_synthetic_transactions(cfg.id, utxos, [], coin="kaspa")
        return _filter_visible_kaspa_txs(local_rows, wallet_addrs, change_addrs)[:MAX_WALLET_TXS]

    query_addrs = _history_addresses(cfg, receive_pairs, change_pairs, utxos)
    if not query_addrs:
        return []

    wallet_addrs = _kaspa_wallet_addrs(receive_pairs, change_pairs)
    change_addrs = _kaspa_wallet_addrs(change_pairs, [])
    sem = asyncio.Semaphore(3)

    async def one(addr: str) -> list[dict]:
        async with sem:
            return await _fetch_address_txs(addr)

    batches = await asyncio.gather(*(one(a) for a in query_addrs))
    from .address_usage import record_receive_usage_from_scans

    record_receive_usage_from_scans(
        cfg.id,
        receive_pairs,
        list(zip(query_addrs, batches)),
        coin="kaspa",
        normalize_addr=_normalize_kaspa_addr,
    )
    by_id: dict[str, dict] = {}
    for rows in batches:
        for tx in rows:
            txid = str(tx.get("transaction_id") or "").lower().replace("0x", "")
            if txid:
                by_id[txid] = tx

    from .tx_raw_cache import remember_wallet_txs

    remember_wallet_txs(cfg.id, by_id)

    tip_blue = 0
    try:
        tip_blue = int(await _kaspa_virtual_blue_score() or 0)
    except Exception:
        tip_blue = 0

    classified: list[WalletTx] = []
    for tx in by_id.values():
        row = _classify_kaspa_tx(tx, wallet_addrs, change_addrs, tip_blue=tip_blue)
        if row:
            classified.append(row)

    classified.sort(key=lambda t: t.block_time, reverse=True)
    patched = _patch_kaspa_outgoing(cfg.id, classified[:MAX_WALLET_TXS])
    merged = merge_synthetic_transactions(cfg.id, utxos, patched, coin="kaspa")
    merged = _filter_visible_kaspa_txs(merged, wallet_addrs, change_addrs)
    return _dedupe_wallet_txs(merged)[:MAX_WALLET_TXS]


async def _fetch_btc_address_txs_once(client: httpx.AsyncClient, base: str, address: str) -> list[dict]:
    resp = await client.get(f"{base}/address/{address}/txs")
    if resp.status_code == 404:
        return []
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, list) else []


async def _fetch_btc_address_txs_page(
    client: httpx.AsyncClient,
    base: str,
    address: str,
    last_txid: str | None = None,
) -> list[dict]:
    path = f"{base}/address/{address}/txs"
    if last_txid:
        path = f"{base}/address/{address}/txs/chain/{last_txid}"
    resp = await client.get(path)
    if resp.status_code == 404:
        return []
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, list) else []


async def _fetch_btc_address_mempool_txs(
    client: httpx.AsyncClient, base: str, address: str
) -> list[dict]:
    resp = await client.get(f"{base}/address/{address}/txs/mempool")
    if resp.status_code == 404:
        return []
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, list) else []


async def _fetch_btc_tx_detail(client: httpx.AsyncClient, base: str, txid: str) -> dict | None:
    resp = await client.get(f"{base}/tx/{txid}")
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, dict) else None


def _btc_tx_needs_enrichment(tx: dict) -> bool:
    status = tx.get("status") or {}
    block_time = int(status.get("block_time") or tx.get("blocktime") or tx.get("time") or 0)
    if block_time <= 0:
        return True
    for vin in tx.get("vin") or tx.get("inputs") or []:
        if vin.get("is_coinbase"):
            continue
        prev = vin.get("prevout") or vin.get("prev_out") or {}
        if not prev.get("scriptpubkey_address") and not prev.get("addr"):
            return True
    return False


async def _enrich_btc_transactions(txs: dict[str, dict]) -> None:
    import certifi

    headers = {"User-Agent": "SeedMask-Coordinator/1.0", "Accept": "application/json"}
    sem = asyncio.Semaphore(8)

    async def one(client: httpx.AsyncClient, base: str, txid: str) -> tuple[str, dict | None]:
        async with sem:
            try:
                return txid, await _fetch_btc_tx_detail(client, base, txid)
            except httpx.HTTPError:
                return txid, None

    for base in _btc_esplora_bases():
        need = [txid for txid, tx in txs.items() if _btc_tx_needs_enrichment(tx)][:_MAX_BTC_ENRICH_TXS]
        if not need:
            return
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(_HTTP_TIMEOUT, connect=3.0),
            headers=headers,
            follow_redirects=True,
            verify=certifi.where(),
        ) as client:
            results = await asyncio.gather(*(one(client, base, txid) for txid in need))
        for txid, detail in results:
            if detail:
                txs[txid] = detail


async def _bc_info_get_json(
    client: httpx.AsyncClient,
    url: str,
    *,
    params: dict | None = None,
) -> dict | list | None:
    for attempt in range(_BC_INFO_RETRY_ATTEMPTS):
        resp = await client.get(
            url,
            params=params,
            timeout=httpx.Timeout(_HTTP_TIMEOUT, connect=5.0),
        )
        if resp.status_code == 429:
            await asyncio.sleep(min(2.0, 0.35 * (2**attempt)))
            continue
        if resp.status_code in {404, 429}:
            return None
        resp.raise_for_status()
        data = resp.json()
        return data if isinstance(data, (dict, list)) else None
    return None


def _btc_txid_lookup_variants(txid: str) -> list[str]:
    cleaned = (txid or "").lower().strip()
    if not cleaned:
        return []
    variants = [cleaned]
    if len(cleaned) == 64:
        try:
            reversed_hex = bytes.fromhex(cleaned)[::-1].hex()
            if reversed_hex not in variants:
                variants.append(reversed_hex)
        except ValueError:
            pass
    return variants


_BTC_TXID_CANON_CACHE: dict[str, str] = {}


async def _btc_txid_exists_on_explorers(txid: str) -> bool:
    """True if a configured public explorer knows this display txid."""
    tid = _norm_txid(txid)
    if not tid:
        return False
    import certifi

    from .network_settings import allows_cross_provider_fallbacks

    headers = {"User-Agent": "SeedMask-Coordinator/1.0", "Accept": "application/json"}
    bases = _btc_esplora_bases()
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(2.5, connect=1.5),
        headers=headers,
        follow_redirects=True,
        verify=certifi.where(),
    ) as client:
        for base in bases:
            try:
                resp = await client.get(f"{base.rstrip('/')}/tx/{tid}")
                if resp.status_code == 200:
                    return True
            except Exception:
                continue
        if allows_cross_provider_fallbacks():
            data = await _bc_info_get_json(client, f"https://blockchain.info/rawtx/{tid}")
            return isinstance(data, dict) and bool(data.get("hash") or data.get("txid"))
    return False


async def canonical_btc_txid(txid: str) -> str:
    """Return the explorer display txid (heal older byte-reversed cache rows)."""
    norm = _norm_txid(txid)
    if not norm:
        return ""
    if len(norm) != 64:
        return norm
    cached = _BTC_TXID_CANON_CACHE.get(norm)
    if cached:
        return cached
    variants = _btc_txid_lookup_variants(norm)
    for alias in variants:
        hit = _BTC_TXID_CANON_CACHE.get(alias)
        if hit:
            for v in variants:
                _BTC_TXID_CANON_CACHE[v] = hit
            return hit
    for candidate in variants:
        try:
            if await _btc_txid_exists_on_explorers(candidate):
                for v in variants:
                    _BTC_TXID_CANON_CACHE[v] = candidate
                return candidate
        except Exception:
            continue
    for v in variants:
        _BTC_TXID_CANON_CACHE[v] = norm
    return norm


async def canonicalize_bitcoin_tx_dicts(dicts: list[dict]) -> list[dict]:
    """Rewrite transaction_id to the explorer-canonical form and dedupe aliases."""
    if not dicts:
        return []
    sem = asyncio.Semaphore(8)

    async def one(raw: str) -> tuple[str, str]:
        async with sem:
            return raw, await canonical_btc_txid(raw)

    norms = sorted(
        {
            _norm_txid(str(d.get("transaction_id") or d.get("txid") or ""))
            for d in dicts
            if isinstance(d, dict)
        }
        - {""}
    )
    resolved = dict(await asyncio.gather(*(one(t) for t in norms)))
    out: list[dict] = []
    for d in dicts:
        if not isinstance(d, dict):
            continue
        item = dict(d)
        tid = _norm_txid(str(item.get("transaction_id") or item.get("txid") or ""))
        if tid:
            item["transaction_id"] = resolved.get(tid, tid)
        out.append(item)
    return _dedupe_tx_dicts(out)


async def _fetch_blockchain_info_tx_time(client: httpx.AsyncClient, txid: str) -> int:
    for candidate in _btc_txid_lookup_variants(txid):
        data = await _bc_info_get_json(client, f"https://blockchain.info/rawtx/{candidate}")
        if not isinstance(data, dict):
            continue
        bt = _block_time_seconds(int(data.get("time") or 0))
        if bt > 0:
            return bt
    return 0


def _bc_info_tx_to_standard(tx: dict) -> dict:
    """Normalize blockchain.info / multiaddr tx records for visualization."""
    out: dict = dict(tx)
    canonical = _btc_tx_id_from_record(tx)
    if canonical:
        out["txid"] = canonical

    src_inputs = tx.get("inputs") if isinstance(tx.get("inputs"), list) else None
    existing_vin = out.get("vin") if isinstance(out.get("vin"), list) else None
    vin_missing_sequence = False
    if existing_vin:
        for v in existing_vin:
            if isinstance(v, dict) and not v.get("is_coinbase") and v.get("sequence") is None:
                vin_missing_sequence = True
                break
    if (not existing_vin or vin_missing_sequence) and src_inputs:
        vins: list[dict] = []
        for inp in src_inputs:
            if not isinstance(inp, dict):
                continue
            prev = inp.get("prev_out") or inp.get("prevout") or {}
            if inp.get("is_coinbase"):
                vins.append({"is_coinbase": True, "prevout": {"value": 0, "scriptpubkey_address": ""}})
                continue
            vin_row: dict = {
                "prevout": {
                    "scriptpubkey_address": str(
                        prev.get("addr") or prev.get("scriptpubkey_address") or ""
                    ),
                    "value": int(prev.get("value") or 0),
                }
            }
            # Preserve nSequence — required for real BIP125 / RBF status.
            if inp.get("sequence") is not None:
                try:
                    vin_row["sequence"] = int(inp.get("sequence"))
                except (TypeError, ValueError):
                    pass
            vins.append(vin_row)
        if vins:
            out["vin"] = vins

    if not out.get("vout"):
        vouts: list[dict] = []
        for o in tx.get("out") or tx.get("vout") or []:
            vouts.append(
                {
                    "scriptpubkey_address": str(o.get("addr") or o.get("scriptpubkey_address") or ""),
                    "value": int(o.get("value") or 0),
                }
            )
        if vouts:
            out["vout"] = vouts

    bt = _block_time_seconds(int(tx.get("time") or tx.get("blocktime") or 0))
    try:
        bh = int(tx.get("block_height") or tx.get("block_index") or 0)
    except (TypeError, ValueError):
        bh = 0
    if bt > 0 or bh > 0:
        status: dict = {"confirmed": True}
        if bt > 0:
            status["block_time"] = bt
        if bh > 0:
            status["block_height"] = bh
        out["status"] = status
        if bh > 0:
            out["block_height"] = bh
    return out


async def _fetch_blockchain_info_rawtx(txid: str) -> dict | None:
    import certifi

    headers = {"User-Agent": "SeedMask-Coordinator/1.0", "Accept": "application/json"}
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(_HTTP_TIMEOUT, connect=5.0),
        headers=headers,
        follow_redirects=True,
        verify=certifi.where(),
    ) as client:
        for candidate in _btc_txid_lookup_variants(txid):
            data = await _bc_info_get_json(client, f"https://blockchain.info/rawtx/{candidate}")
            if not isinstance(data, dict):
                continue
            if data.get("inputs") or data.get("vin") or data.get("out") or data.get("vout"):
                return _bc_info_tx_to_standard(data)
    return None


async def fetch_btc_tx_by_id(txid: str) -> dict | None:
    """Load a confirmed Bitcoin tx from Esplora, with blockchain.info fallback."""
    import certifi

    norm = _norm_txid(txid)
    if not norm:
        return None

    headers = {"User-Agent": "SeedMask-Coordinator/1.0", "Accept": "application/json"}
    for candidate in _btc_txid_lookup_variants(norm):
        for base in _btc_esplora_bases():
            try:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(_HTTP_TIMEOUT, connect=4.0),
                    headers=headers,
                    follow_redirects=True,
                    verify=certifi.where(),
                ) as client:
                    detail = await _fetch_btc_tx_detail(client, base, candidate)
                if detail:
                    return detail
            except httpx.HTTPError:
                continue

    bc = await _fetch_blockchain_info_rawtx(norm)
    if bc:
        return bc
    return None


def _btc_txid_alias_set(txid: str) -> set[str]:
    aliases: set[str] = set()
    for variant in _btc_txid_lookup_variants(txid):
        aliases.update(_btc_tx_id_aliases(variant))
    return aliases


def _btc_quick_lookup_addresses(
    receive_pairs: list[tuple[int, str]],
    change_pairs: list[tuple[int, str]],
    utxos: list | None,
    *,
    max_addrs: int = 48,
) -> list[str]:
    """Small address set for single-tx lookup — never scan full scan_limit."""
    from .utxo_access import utxo_address

    addrs: list[str] = []
    for u in utxos or []:
        addr = utxo_address(u)
        if addr:
            addrs.append(addr)
    for _, addr in receive_pairs[:32]:
        addrs.append(addr)
    for _, addr in change_pairs[:16]:
        addrs.append(addr)
    return list(dict.fromkeys(addrs))[:max_addrs]


async def fetch_btc_tx_for_wallet(
    txid: str,
    cfg: WalletConfig,
    receive_pairs: list[tuple[int, str]],
    change_pairs: list[tuple[int, str]],
    utxos: list[WalletUtxo] | None,
) -> dict | None:
    """Resolve a tx for Tx details — cache first, then public indexers."""
    from .tx_raw_cache import cached_wallet_tx

    cached = cached_wallet_tx(cfg.id, txid)
    if cached:
        if cached.get("vin") or cached.get("vout"):
            return cached
        return _bc_info_tx_to_standard(cached)

    try:
        direct = await asyncio.wait_for(fetch_btc_tx_by_id(txid), timeout=12.0)
    except asyncio.TimeoutError:
        direct = None
    if direct:
        return direct

    targets = _btc_txid_alias_set(txid)
    if not targets:
        return None

    query_addrs = _btc_quick_lookup_addresses(receive_pairs, change_pairs, utxos)
    if not query_addrs:
        return None

    sem = asyncio.Semaphore(4)

    async def scan_addr(addr: str) -> dict | None:
        async with sem:
            try:
                rows = await asyncio.wait_for(_fetch_btc_address_txs(addr, cfg), timeout=10.0)
            except asyncio.TimeoutError:
                return None
        for row in rows:
            if _btc_tx_id_from_record(row) in targets:
                if row.get("vin") or row.get("vout"):
                    return row
                return _bc_info_tx_to_standard(row)
        return None

    for batch_start in range(0, len(query_addrs), 8):
        batch = query_addrs[batch_start : batch_start + 8]
        found = await asyncio.gather(*(scan_addr(a) for a in batch))
        for row in found:
            if row:
                return row
    return None


async def _hydrate_btc_wallet_tx_times(rows: list[WalletTx]) -> list[WalletTx]:
    missing = [row for row in rows if row.block_time <= 0][:_MAX_BTC_HYDRATE_TXS]
    if not missing:
        return rows
    import certifi

    headers = {"User-Agent": "SeedMask-Coordinator/1.0", "Accept": "application/json"}
    sem = asyncio.Semaphore(10)
    time_by_txid: dict[str, int] = {}

    async def one(row: WalletTx) -> None:
        txid = row.transaction_id
        if not txid or txid in time_by_txid:
            return
        async with sem:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(8.0, connect=3.0),
                headers=headers,
                follow_redirects=True,
                verify=certifi.where(),
            ) as client:
                try:
                    bt = await _fetch_blockchain_info_tx_time(client, txid)
                except httpx.HTTPError:
                    bt = 0
                if bt > 0:
                    time_by_txid[txid] = bt
                    return
                for base in _btc_esplora_bases():
                    try:
                        detail = await _fetch_btc_tx_detail(client, base, txid)
                    except httpx.HTTPError:
                        continue
                    if not detail:
                        continue
                    status = detail.get("status") or {}
                    bt = _block_time_seconds(
                        int(
                            status.get("block_time")
                            or detail.get("blocktime")
                            or detail.get("time")
                            or 0
                        )
                    )
                    if bt > 0:
                        time_by_txid[txid] = bt
                        return

    await asyncio.gather(*(one(row) for row in missing))
    if not time_by_txid:
        return rows
    hydrated: list[WalletTx] = []
    for row in rows:
        bt = time_by_txid.get(row.transaction_id)
        if bt and bt > 0:
            hydrated.append(
                WalletTx(
                    transaction_id=row.transaction_id,
                    direction=row.direction,
                    amount_kas=row.amount_kas,
                    block_time=bt,
                    counterparty=row.counterparty,
                )
            )
        else:
            hydrated.append(row)
    return hydrated


async def _fetch_btc_address_txs_paginated(
    client: httpx.AsyncClient, base: str, address: str, limit: int
) -> list[dict]:
    merged: list[dict] = []
    seen: set[str] = set()
    last_txid: str | None = None

    while len(merged) < limit:
        batch = await _fetch_btc_address_txs_page(client, base, address, last_txid)
        if not batch:
            break
        for tx in batch:
            txid = _btc_tx_id_from_record(tx)
            if not txid or txid in seen:
                continue
            seen.add(txid)
            merged.append(tx)
            if len(merged) >= limit:
                break
        if len(batch) < 25 or len(merged) >= limit:
            break
        last_txid = _btc_tx_id_from_record(batch[-1])
        if not last_txid:
            break

    try:
        mempool = await _fetch_btc_address_mempool_txs(client, base, address)
    except httpx.HTTPError:
        mempool = []
    for tx in mempool:
        txid = _btc_tx_id_from_record(tx)
        if not txid or txid in seen:
            continue
        seen.add(txid)
        merged.insert(0, tx)

    return merged[:limit]


async def _fetch_blockchain_info_address_txs_once(
    client: httpx.AsyncClient, address: str, *, limit: int = TX_LIMIT_PER_ADDRESS, offset: int = 0
) -> list[dict]:
    page_limit = min(100, max(1, limit))
    data = await _bc_info_get_json(
        client,
        f"https://blockchain.info/rawaddr/{address}",
        params={"limit": page_limit, "offset": max(0, offset)},
    )
    if not isinstance(data, dict):
        return []
    return data.get("txs") if isinstance(data.get("txs"), list) else []


async def _fetch_blockchain_info_address_txs_paginated(address: str, limit: int) -> list[dict]:
    import certifi

    headers = {"User-Agent": "SeedMask-Coordinator/1.0", "Accept": "application/json"}
    merged: list[dict] = []
    seen: set[str] = set()
    offset = 0
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(_HTTP_TIMEOUT, connect=4.0),
        headers=headers,
        follow_redirects=True,
        verify=certifi.where(),
    ) as client:
        while len(merged) < limit:
            page_limit = min(100, limit - len(merged))
            batch = await _fetch_blockchain_info_address_txs_once(
                client, address, limit=page_limit, offset=offset
            )
            if not batch:
                break
            for tx in batch:
                txid = _btc_tx_id_from_record(tx)
                if not txid or txid in seen:
                    continue
                seen.add(txid)
                merged.append(tx)
                if len(merged) >= limit:
                    break
            if len(batch) < page_limit:
                break
            offset += len(batch)
            await asyncio.sleep(0.08)
    return merged[:limit]


async def _fetch_blockchain_info_multiaddr_page(
    client: httpx.AsyncClient,
    addresses: list[str],
    *,
    limit: int,
    offset: int = 0,
) -> list[dict]:
    if not addresses:
        return []
    active = "|".join(addresses)
    page_limit = min(100, max(1, limit))
    data = await _bc_info_get_json(
        client,
        "https://blockchain.info/multiaddr",
        params={"active": active, "n": page_limit, "offset": max(0, offset)},
    )
    if not isinstance(data, dict):
        return []
    return data.get("txs") if isinstance(data.get("txs"), list) else []


async def _fetch_blockchain_info_multiaddr_paginated(
    addresses: list[str], limit: int
) -> list[dict]:
    import certifi

    if not addresses:
        return []
    headers = {"User-Agent": "SeedMask-Coordinator/1.0", "Accept": "application/json"}
    merged: list[dict] = []
    seen: set[str] = set()
    offset = 0
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(_HTTP_TIMEOUT, connect=5.0),
        headers=headers,
        follow_redirects=True,
        verify=certifi.where(),
    ) as client:
        while len(merged) < limit:
            page_limit = min(100, limit - len(merged))
            batch = await _fetch_blockchain_info_multiaddr_page(
                client, addresses, limit=page_limit, offset=offset
            )
            if not batch:
                break
            for tx in batch:
                txid = _btc_tx_id_from_record(tx)
                if not txid or txid in seen:
                    continue
                seen.add(txid)
                merged.append(tx)
                if len(merged) >= limit:
                    break
            if len(batch) < page_limit:
                break
            offset += len(batch)
            await asyncio.sleep(0.08)
    return merged[:limit]


async def _fetch_btc_txs_multiaddr_batched(addresses: list[str]) -> dict[str, dict]:
    """Batch-fetch txs via blockchain.info multiaddr (fewer HTTP calls than per-address)."""
    by_id: dict[str, dict] = {}
    if not addresses:
        return by_id
    remaining = MAX_WALLET_TXS
    for i in range(0, len(addresses), _BTC_MULTIADDR_BATCH):
        if remaining <= 0:
            break
        batch = addresses[i : i + _BTC_MULTIADDR_BATCH]
        try:
            rows = await _fetch_blockchain_info_multiaddr_paginated(
                batch, min(TX_LIMIT_PER_ADDRESS, remaining)
            )
        except httpx.HTTPError:
            continue
        for tx in rows:
            if not _btc_tx_id_from_record(tx):
                continue
            before = len(by_id)
            _store_btc_tx_dict(by_id, tx)
            if len(by_id) > before:
                remaining -= 1
        if i + _BTC_MULTIADDR_BATCH < len(addresses):
            await asyncio.sleep(0.25)
    return by_id


def _btc_tx_touching_addresses(tx: dict) -> set[str]:
    addrs: set[str] = set()
    for out in tx.get("vout") or tx.get("out") or []:
        addr = str(out.get("scriptpubkey_address") or out.get("addr") or "")
        if addr:
            addrs.add(addr)
    for inp in tx.get("vin") or tx.get("inputs") or []:
        prev = inp.get("prevout") or inp.get("prev_out") or {}
        addr = str(prev.get("scriptpubkey_address") or prev.get("addr") or "")
        if addr:
            addrs.add(addr)
    return addrs


def _btc_scans_from_tx_index(
    addresses: list[str], txs: dict[str, dict]
) -> list[tuple[str, list[dict]]]:
    addr_set = set(addresses)
    by_addr: dict[str, list[dict]] = {a: [] for a in addresses}
    for tx in txs.values():
        touched = _btc_tx_touching_addresses(tx) & addr_set
        for addr in touched:
            by_addr[addr].append(tx)
    return [(a, by_addr[a]) for a in addresses]


def _btc_esplora_bases() -> list[str]:
    """Configured Esplora API bases in user order (exclusive presets stay exclusive)."""
    from .network_settings import allows_cross_provider_fallbacks

    bases: list[str] = []
    for url in [_btc_esplora_primary(), *_btc_esplora_fallbacks()]:
        stripped = (url or "").strip().rstrip("/")
        if stripped and stripped not in bases:
            bases.append(stripped)
    if not allows_cross_provider_fallbacks():
        return bases
    # Recommended: defer flaky mempool.space so backups are tried first.
    preferred = [b for b in bases if "mempool.space" not in b.lower()]
    deferred = [b for b in bases if "mempool.space" in b.lower()]
    return preferred + deferred


async def _fetch_btc_address_txs_esplora(address: str) -> list[dict]:
    from .network_settings import allows_cross_provider_fallbacks

    headers = {"User-Agent": "SeedMask-Coordinator/1.0", "Accept": "application/json"}
    allow_cross = allows_cross_provider_fallbacks()

    async def fetch_esplora() -> list[dict]:
        rows: list[dict] = []

        async def fetch_from(base: str, timeout: float) -> list[dict]:
            connect_s = 1.2 if ("mempool.space" in base.lower() and allow_cross) else min(2.0, timeout)
            read_s = 2.0 if ("mempool.space" in base.lower() and allow_cross) else _HTTP_TIMEOUT
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(read_s, connect=connect_s),
                headers=headers,
                follow_redirects=True,
                verify=__import__("certifi").where(),
            ) as client:
                return await _fetch_btc_address_txs_paginated(
                    client, base, address, TX_LIMIT_PER_ADDRESS
                )

        bases = _btc_esplora_bases()
        for i, base in enumerate(bases):
            timeout = _ESPLORA_PRIMARY_TIMEOUT if i == 0 else _ESPLORA_FALLBACK_TIMEOUT
            try:
                extra = await fetch_from(base, timeout)
            except httpx.HTTPError:
                continue
            if not extra:
                continue
            if not rows:
                rows = extra
            else:
                by_id = {
                    _btc_tx_id_from_record(tx): tx
                    for tx in rows
                    if _btc_tx_id_from_record(tx)
                }
                for tx in extra:
                    txid = _btc_tx_id_from_record(tx)
                    if txid:
                        _store_btc_tx_dict(by_id, tx)
                rows = list(by_id.values())
            if len(rows) >= TX_LIMIT_PER_ADDRESS:
                break
        return rows[:TX_LIMIT_PER_ADDRESS]

    esplora_task = asyncio.create_task(fetch_esplora())
    bc_task = None
    if allow_cross:
        bc_task = asyncio.create_task(
            _fetch_blockchain_info_address_txs_paginated(address, TX_LIMIT_PER_ADDRESS)
        )
    esplora_rows: list[dict] = []
    bc_rows: list[dict] = []
    try:
        esplora_rows = await esplora_task
    except httpx.HTTPError:
        esplora_rows = []
    if bc_task is not None:
        try:
            bc_rows = await bc_task
        except httpx.HTTPError:
            bc_rows = []

    by_id: dict[str, dict] = {}
    for tx in esplora_rows:
        _store_btc_tx_dict(by_id, tx)
    for tx in bc_rows:
        _store_btc_tx_dict(by_id, tx)
    return list(by_id.values())[:TX_LIMIT_PER_ADDRESS]


async def _fetch_btc_address_txs(address: str, cfg: WalletConfig | None = None) -> list[dict]:
    from . import bitcoin_backend

    if not bitcoin_backend.uses_public_endpoints():
        return await bitcoin_backend.fetch_address_transactions(address, cfg)
    return await _fetch_btc_address_txs_esplora(address)


def _btc_tx_id_from_record(tx: dict) -> str:
    """Return the explorer/Esplora txid for a Bitcoin tx record.

    blockchain.info ``hash`` is already the standard display txid (same as Esplora
    ``txid``). Older code byte-reversed it, which made explorer links 404.
    """
    txid = _norm_txid(str(tx.get("txid") or ""))
    if txid:
        return txid
    return _norm_txid(str(tx.get("hash") or ""))


def _filter_visible_btc_txs(
    rows: list[WalletTx],
    wallet_addrs: set[str],
    change_addrs: set[str],
) -> list[WalletTx]:
    """Hide change-only credits; keep external receives and self-sends as sent."""
    _ = wallet_addrs
    visible: list[WalletTx] = []
    for row in rows:
        cp = (row.counterparty or "").strip()
        if row.direction == "received":
            if cp and cp in change_addrs:
                continue
        if row.direction == "sent" and cp and cp in change_addrs:
            continue
        visible.append(row)
    return visible


def _classify_btc_tx(
    tx: dict,
    wallet_addrs: set[str],
    change_addrs: set[str] | None = None,
) -> WalletTx | None:
    txid = _btc_tx_id_from_record(tx)
    if not txid:
        return None

    change_addrs = change_addrs or set()

    received = 0
    sent = 0
    external_out: list[tuple[int, str]] = []
    internal_receive_out: list[tuple[int, str]] = []
    external_in: list[tuple[int, str]] = []
    wallet_input_count = 0

    vouts = tx.get("vout")
    if vouts is None:
        vouts = tx.get("out") or []

    for out in vouts:
        addr = out.get("scriptpubkey_address") or out.get("addr") or ""
        amount = int(out.get("value") or 0)
        if addr in wallet_addrs:
            received += amount
            if addr not in change_addrs:
                internal_receive_out.append((amount, addr))
        elif addr:
            external_out.append((amount, addr))

    vins = tx.get("vin")
    if vins is None:
        vins = tx.get("inputs") or []

    for inp in vins:
        prev = inp.get("prevout") or inp.get("prev_out") or {}
        addr = prev.get("scriptpubkey_address") or prev.get("addr") or ""
        amount = int(prev.get("value") or 0)
        if addr in wallet_addrs:
            sent += amount
            wallet_input_count += 1
        elif addr:
            external_in.append((amount, addr))

    external_send = sum(amt for amt, _ in external_out)
    net = received - sent

    if wallet_input_count > 0 and external_send == 0:
        wallet_out_addrs = {
            str(out.get("scriptpubkey_address") or out.get("addr") or "")
            for out in vouts
            if int(out.get("value") or 0) > 0
            and str(out.get("scriptpubkey_address") or out.get("addr") or "") in wallet_addrs
        }
        if not wallet_out_addrs or wallet_out_addrs <= change_addrs:
            return None

    if wallet_input_count > 0 and external_send > 0:
        direction = "sent"
        amount = external_send
        counterparty = max(external_out, key=lambda x: x[0])[1]
    elif received > 0 and wallet_input_count == 0:
        direction = "received"
        amount = received
        counterparty = external_in[0][1] if external_in else ""
    elif wallet_input_count > 0 and internal_receive_out and external_send == 0:
        direction = "sent"
        amount = sum(amt for amt, _ in internal_receive_out)
        counterparty = max(internal_receive_out, key=lambda x: x[0])[1]
    elif wallet_input_count > 0 and received > 0:
        direction = "sent"
        external_recipient = max(external_out, key=lambda x: x[0])[1] if external_out else ""
        if external_recipient:
            amount = external_send if external_send > 0 else max(amt for amt, _ in external_out)
            counterparty = external_recipient
        else:
            return None
    elif net > 0:
        direction = "received"
        amount = net
        counterparty = external_in[0][1] if external_in else ""
    elif net < 0:
        direction = "sent"
        amount = -net
        counterparty = external_out[0][1] if external_out else ""
    elif wallet_input_count > 0 and sent > 0:
        direction = "sent"
        amount = max(sent - received, sent) if received > 0 else sent
        counterparty = external_out[0][1] if external_out else ""
    elif received > 0 or wallet_input_count > 0:
        direction = "received" if received >= sent else "sent"
        amount = max(received, sent, abs(net))
        counterparty = (
            (external_in[0][1] if external_in else "")
            or (external_out[0][1] if external_out else "")
        )
    else:
        return None

    status = tx.get("status") if isinstance(tx.get("status"), dict) else {}
    block_time = _block_time_seconds(
        int(
            status.get("block_time")
            or tx.get("blocktime")
            or tx.get("time")
            or 0
        )
    )
    try:
        block_height_i = int(
            status.get("block_height")
            or tx.get("block_height")
            or tx.get("block_index")
            or 0
        )
    except (TypeError, ValueError):
        block_height_i = 0
    # Real depth only: tip − height + 1. Never invent 1/3 from age or missing tip.
    confirmations = 0
    tip = tx.get("_tip_height")
    if block_height_i > 0 and isinstance(tip, int) and tip >= block_height_i:
        confirmations = max(1, tip - block_height_i + 1)
    rbf = False
    # Prefer original blockchain.info inputs when vin was normalized without sequence.
    rbf_inputs = list(vins)
    if tx.get("inputs") and isinstance(tx.get("inputs"), list):
        rbf_inputs = list(tx.get("inputs")) + rbf_inputs
    for inp in rbf_inputs:
        if not isinstance(inp, dict) or inp.get("is_coinbase"):
            continue
        seq = inp.get("sequence")
        try:
            if seq is not None and int(seq) <= 0xFFFFFFFD:
                rbf = True
                break
        except (TypeError, ValueError):
            continue
    fee_sats: int | None = None
    try:
        if tx.get("fee") is not None:
            fee_sats = int(tx.get("fee"))
    except (TypeError, ValueError):
        fee_sats = None
    from .bitcoin_service import SATS_PER_BTC

    return WalletTx(
        transaction_id=txid,
        direction=direction,
        amount_kas=amount / SATS_PER_BTC,
        block_time=block_time,
        counterparty=counterparty,
        confirmations=confirmations,
        # Persist BIP125 signal (UI still only offers RBF bump while unconfirmed).
        rbf=rbf,
        fee_sompi=fee_sats,
        block_height=block_height_i if block_height_i > 0 else None,
    )


async def fetch_bitcoin_wallet_transactions(
    cfg: WalletConfig,
    receive_pairs: list[tuple[int, str]],
    change_pairs: list[tuple[int, str]],
    utxos: list[WalletUtxo],
) -> list[WalletTx]:
    query_addrs = _history_addresses(cfg, receive_pairs, change_pairs, utxos)
    if not query_addrs:
        return []

    wallet_addrs = {addr for _, addr in receive_pairs} | {addr for _, addr in change_pairs}
    change_addrs = {addr for _, addr in change_pairs}
    from . import bitcoin_backend

    by_id: dict[str, dict] = {}
    per_addr_batches: list[list[dict]] = []

    if bitcoin_backend.uses_public_endpoints():
        from .network_settings import allows_cross_provider_fallbacks

        if allows_cross_provider_fallbacks():
            by_id = await _fetch_btc_txs_multiaddr_batched(query_addrs)
        # multiaddr covers derived addresses; per-address only for live UTXO addrs (mempool / lag).
        from .utxo_access import utxo_address

        utxo_addrs = list(dict.fromkeys(a for u in (utxos or []) if (a := utxo_address(u))))
        fetch_addrs = utxo_addrs if by_id else query_addrs
    else:
        fetch_addrs = query_addrs

    sem = asyncio.Semaphore(_BTC_HISTORY_CONCURRENCY)

    async def one(addr: str) -> list[dict]:
        async with sem:
            rows = await _fetch_btc_address_txs(addr, cfg)
            if len(fetch_addrs) > 1:
                await asyncio.sleep(0.02)
            return rows

    if fetch_addrs:
        per_addr_batches = list(await asyncio.gather(*(one(a) for a in fetch_addrs)))
    for rows in per_addr_batches:
        for tx in rows:
            _store_btc_tx_dict(by_id, tx)

    from .address_usage import record_receive_usage_from_scans, merge_usage_from_btc_tx_dicts

    scan_pairs = list(zip(fetch_addrs, per_addr_batches)) if fetch_addrs and per_addr_batches else []
    if scan_pairs:
        record_receive_usage_from_scans(
            cfg.id,
            receive_pairs,
            scan_pairs,
            coin="bitcoin",
        )
    if by_id:
        merge_usage_from_btc_tx_dicts(cfg.id, receive_pairs, list(by_id.values()))

    if by_id and bitcoin_backend.uses_public_endpoints():
        await _enrich_btc_transactions(by_id)

    from .tx_raw_cache import remember_wallet_txs

    remember_wallet_txs(cfg.id, by_id)

    tip_height = 0
    try:
        from .tx_visualize import _btc_chain_tip_height

        tip_height = int(await _btc_chain_tip_height() or 0)
    except Exception:
        tip_height = 0

    classified: list[WalletTx] = []
    for tx in by_id.values():
        if tip_height > 0:
            tx = dict(tx)
            tx["_tip_height"] = tip_height
        row = _classify_btc_tx(tx, wallet_addrs, change_addrs)
        if row:
            classified.append(row)

    classified.sort(key=lambda t: t.block_time, reverse=True)
    merged = merge_synthetic_transactions(
        cfg.id, utxos, classified, coin="bitcoin"
    )
    merged = _dedupe_wallet_txs(merged)
    merged = _filter_visible_btc_txs(merged, wallet_addrs, change_addrs)
    if len(merged) > MAX_WALLET_TXS:
        merged.sort(key=lambda t: t.block_time, reverse=True)
        merged = merged[:MAX_WALLET_TXS]
    return await _hydrate_btc_wallet_tx_times(merged)


async def fetch_wallet_transactions(
    cfg: WalletConfig,
    receive_pairs: list[tuple[int, str]],
    change_pairs: list[tuple[int, str]],
    utxos: list[WalletUtxo],
) -> list[WalletTx]:
    from .wallet_store import resolved_wallet_coin

    coin = resolved_wallet_coin(cfg)
    if coin == "bitcoin":
        return await fetch_bitcoin_wallet_transactions(cfg, receive_pairs, change_pairs, utxos)
    return await fetch_kaspa_wallet_transactions(cfg, receive_pairs, change_pairs, utxos)
