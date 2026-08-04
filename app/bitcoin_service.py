"""Bitcoin mainnet watch-only xpub derivation + on-chain UTXO scan (BIP44 gap limit)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import certifi
import httpx

from embit import script
from embit.bip32 import HDKey
from embit.networks import NETWORKS

from .btc_multisig import multisig_address_at, multisig_cache_token
from .btc_script import script_type_from_derivation, script_type_from_xpub_prefix
from .kaspa_service import WalletUtxo, normalize_extended_key
from .wallet_store import WalletConfig

SATS_PER_BTC = 100_000_000
_NETWORK = NETWORKS["main"]
_REQUEST_TIMEOUT = 8.0
_ESPLORA_PRIMARY_TIMEOUT = 2.5
_ESPLORA_FALLBACK_TIMEOUT = 2.0
_UTXO_CONCURRENCY = 16
_DISCOVER_CONCURRENCY = 6
_DEEP_SCAN_CONCURRENCY = 6
_DISCOVER_RECEIVE_PROBE = 20
_DISCOVER_CHANGE_PROBE = 6
# Public Electrum/Fulcrum hosts that work when Esplora REST is rate-limited.
# Note: ssl.electrum.blockstream.info does NOT resolve — use electrum.blockstream.info.
_PUBLIC_ELECTRUM_HOSTS: tuple[tuple[str, int], ...] = (
    ("electrum.blockstream.info", 50002),
    ("blockstream.info", 700),
    ("electrum1.bluewallet.io", 443),
    ("fulcrum.grey.pw", 50002),
)
_BIP44_GAP_LIMIT = 20
_QUICK_PROBE_CHANGE = 8
_QUICK_PROBE_RECEIVE = 6

_SCRIPT_TYPES = frozenset({"native_segwit", "nested_segwit", "legacy", "taproot"})

_client: httpx.AsyncClient | None = None
_client_lock = asyncio.Lock()


def reset_http_client() -> None:
    global _client
    _client = None
    from . import bitcoin_http

    bitcoin_http.reset_bitcoin_http_client()


def _bitcoin_settings():
    from .network_settings import load_bitcoin_settings

    return load_bitcoin_settings()


@dataclass
class BitcoinScanResult:
    utxos: list[WalletUtxo]
    api_failures: int = 0


async def _http_client() -> httpx.AsyncClient:
    global _client
    if _client is not None and not _client.is_closed:
        return _client
    async with _client_lock:
        if _client is None or _client.is_closed:
            _client = httpx.AsyncClient(
                timeout=httpx.Timeout(_REQUEST_TIMEOUT, connect=5.0),
                limits=httpx.Limits(max_connections=48, max_keepalive_connections=32),
                headers={"User-Agent": "SeedMask-Coordinator/1.0", "Accept": "application/json"},
                follow_redirects=True,
                verify=certifi.where(),
            )
    return _client


def _resolve_script_type(cfg: WalletConfig) -> str:
    st = (cfg.script_type or "").strip().lower()
    if st in _SCRIPT_TYPES:
        return st
    st = script_type_from_derivation(cfg.derivation)
    if st:
        return st
    st = script_type_from_xpub_prefix(normalize_extended_key(cfg.kpub))
    return st or "native_segwit"


def _hdkey_for(cfg: WalletConfig) -> HDKey:
    key = normalize_extended_key(cfg.kpub)
    prefix = key[:4].lower()
    if prefix not in {"xpub", "ypub", "zpub", "tpub", "upub", "vpub"}:
        raise ValueError("Bitcoin watch-only key must start with xpub, ypub, or zpub")
    try:
        return HDKey.from_string(key)
    except Exception as e:
        raise ValueError(f"Invalid Bitcoin extended public key: {e}") from e


def _utxo_dict(u: WalletUtxo) -> dict:
    btc = u.amount / SATS_PER_BTC
    return {
        "address": u.address,
        "address_index": u.address_index,
        "transaction_id": u.transaction_id,
        "output_index": u.output_index,
        "amount": u.amount,
        "amount_btc": btc,
        "amount_kas": btc,
        "key": u.key,
        "is_change": u.is_change,
    }


async def _fetch_address_utxos_once(base: str, address: str) -> list[dict]:
    client = await _http_client()
    resp = await client.get(f"{base}/address/{address}/utxo")
    if resp.status_code == 404:
        return []
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, list) else []


async def _fetch_blockchain_info_utxos_once(address: str) -> list[dict]:
    client = await _http_client()
    resp = await client.get(
        "https://blockchain.info/unspent",
        params={"active": address},
        timeout=httpx.Timeout(_REQUEST_TIMEOUT, connect=4.0),
    )
    if resp.status_code == 404:
        return []
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict):
        return []
    out: list[dict] = []
    for ref in data.get("unspent_outputs") or []:
        txid = str(ref.get("tx_hash") or "").lower()
        vout = int(ref.get("tx_output_n", -1))
        value = int(ref.get("value") or 0)
        if txid and value > 0 and vout >= 0:
            out.append({"txid": txid, "vout": vout, "value": value})
    return out


async def _fetch_blockcypher_utxos_once(address: str) -> list[dict]:
    client = await _http_client()
    resp = await client.get(
        f"https://api.blockcypher.com/v1/btc/main/addrs/{address}",
        params={"unspentOnly": "true"},
    )
    if resp.status_code == 404:
        return []
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict):
        return []
    out: list[dict] = []
    for ref in data.get("txrefs") or []:
        if ref.get("spent"):
            continue
        txid = str(ref.get("tx_hash") or "").lower()
        vout = int(ref.get("tx_output_n", -1))
        value = int(ref.get("value") or 0)
        if txid and value > 0 and vout >= 0:
            out.append({"txid": txid, "vout": vout, "value": value})
    return out


async def _fetch_esplora_utxos(
    base: str,
    address: str,
    *,
    timeout: float,
    retries: int = 1,
) -> list[dict]:
    last_err: Exception | None = None
    for _ in range(max(1, retries)):
        try:
            client = await _http_client()
            resp = await client.get(
                f"{base}/address/{address}/utxo",
                timeout=httpx.Timeout(timeout, connect=min(4.0, timeout)),
            )
            if resp.status_code == 404:
                return []
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, list) else []
        except (httpx.HTTPError, ValueError) as e:
            last_err = e
    if last_err:
        raise last_err
    return []


async def _fetch_address_utxos_esplora(address: str, *, quick: bool = False) -> tuple[list[dict] | None, bool]:
    """Return (utxos, failed). failed=True means all explorers errored.

    Important: never treat timeouts/errors as an empty wallet — that zeroes balances
    when public APIs are slow (especially in quick/hot refresh mode).
    """
    from .network_settings import allows_cross_provider_fallbacks

    settings = _bitcoin_settings()
    allow_cross = allows_cross_provider_fallbacks(settings)
    primary_timeout = 2.5 if quick else _ESPLORA_PRIMARY_TIMEOUT
    fallback_timeout = 2.2 if quick else _ESPLORA_FALLBACK_TIMEOUT
    primary_retries = 1 if quick else 2

    bases: list[str] = []
    for base in [settings.esplora_primary, *(settings.esplora_fallbacks or [])]:
        b = (base or "").rstrip("/")
        if b and b not in bases:
            bases.append(b)
    # Exclusive presets keep user order. Recommended may defer flaky mempool.space.
    if allow_cross:
        preferred = [b for b in bases if "mempool.space" not in b.lower()]
        deferred = [b for b in bases if "mempool.space" in b.lower()]
        ordered = preferred + deferred
    else:
        ordered = bases

    for i, base in enumerate(ordered):
        timeout = primary_timeout if i == 0 else fallback_timeout
        retries = primary_retries if i == 0 else 1
        if "mempool.space" in base.lower():
            timeout = min(timeout, 2.0) if allow_cross else max(timeout, 4.0)
            retries = 1 if allow_cross else max(retries, 2)
        try:
            return (
                await _fetch_esplora_utxos(
                    base,
                    address,
                    timeout=timeout,
                    retries=retries,
                ),
                False,
            )
        except (httpx.HTTPError, ValueError):
            continue

    if not allow_cross:
        return None, True

    # Recommended / legacy only — never for exclusive mempool/Blockstream presets.
    try:
        return await _fetch_blockchain_info_utxos_once(address), False
    except (httpx.HTTPError, ValueError):
        pass

    if quick:
        return None, True

    if not settings.enable_legacy_fallbacks:
        return None, True

    async def attempt_blockchain_info() -> list[dict]:
        try:
            return await _fetch_blockchain_info_utxos_once(address)
        except (httpx.HTTPError, ValueError) as e:
            raise e

    async def attempt_blockcypher() -> list[dict]:
        try:
            return await _fetch_blockcypher_utxos_once(address)
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                raise e
            raise e

    tasks = [
        asyncio.create_task(attempt_blockchain_info()),
        asyncio.create_task(attempt_blockcypher()),
    ]
    try:
        for finished in asyncio.as_completed(tasks):
            try:
                result = await finished
            except (httpx.HTTPError, ValueError):
                continue
            for t in tasks:
                if not t.done():
                    t.cancel()
            return result, False
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()
    return None, True


async def _fetch_address_utxos(
    address: str, cfg: WalletConfig | None = None, *, quick: bool = False
) -> tuple[list[dict] | None, bool]:
    from . import bitcoin_backend
    from .network_settings import allows_cross_provider_fallbacks

    if not bitcoin_backend.uses_public_endpoints():
        try:
            rows = await bitcoin_backend.fetch_address_utxos(address, cfg)
            return rows, False
        except Exception:
            return None, True
    if allows_cross_provider_fallbacks():
        rows, failed = await _fetch_address_utxos_tiered_public(address, quick=quick)
        if rows is not None:
            return rows, failed
    return await _fetch_address_utxos_esplora(address, quick=quick)


async def _fetch_address_utxos_tiered_public(
    address: str, *, quick: bool = False
) -> tuple[list[dict] | None, bool]:
    """Try public Electrum/Fulcrum SSL before Esplora REST (survives 429s)."""
    import asyncio
    import json
    import hashlib
    import ssl

    from embit import script

    timeout = 2.5 if quick else 5.0
    try:
        spk = script.address_to_scriptpubkey(address)
        sh = hashlib.sha256(spk.data).digest()[::-1].hex()
    except Exception:
        return None, True

    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE
    payload = (
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "blockchain.scripthash.listunspent",
                "params": [sh],
            }
        )
        + "\n"
    ).encode()

    for host, port in _PUBLIC_ELECTRUM_HOSTS:
        reader = writer = None
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port, ssl=ssl_ctx),
                timeout=timeout,
            )
            writer.write(payload)
            await writer.drain()
            line = await asyncio.wait_for(reader.readline(), timeout=timeout)
            if not line:
                continue
            data = json.loads(line.decode())
            if data.get("error"):
                continue
            rows = data.get("result")
            if not isinstance(rows, list):
                return [], False
            out: list[dict] = []
            for row in rows:
                txid = str(row.get("tx_hash") or "").lower()
                vout = int(row.get("tx_pos") or 0)
                value = int(row.get("value") or 0)
                if not txid or value <= 0:
                    continue
                out.append(
                    {
                        "txid": txid,
                        "vout": vout,
                        "value": value,
                        "status": {"confirmed": bool(row.get("height", 0) > 0)},
                    }
                )
            return out, False
        except Exception:
            continue
        finally:
            if writer is not None:
                try:
                    writer.close()
                    await writer.wait_closed()
                except Exception:
                    pass
    return None, True


def _address_for_pubkey(pubkey, script_type: str) -> str:
    if script_type == "legacy":
        return script.p2pkh(pubkey).address(network=_NETWORK)
    if script_type == "nested_segwit":
        return script.p2sh(script.p2wpkh(pubkey)).address(network=_NETWORK)
    if script_type == "taproot":
        return script.p2tr(pubkey).address(network=_NETWORK)
    return script.p2wpkh(pubkey).address(network=_NETWORK)


def _parse_utxo_entries(
    entries: list[dict] | None, *, addr: str, index: int, is_change: bool
) -> list[WalletUtxo]:
    if not entries:
        return []
    out: list[WalletUtxo] = []
    for entry in entries:
        txid = str(entry.get("txid") or "").lower()
        vout = int(entry.get("vout", 0))
        value = int(entry.get("value") or 0)
        if not txid or value <= 0:
            continue
        out.append(
            WalletUtxo(
                address=addr,
                address_index=index,
                transaction_id=txid,
                output_index=vout,
                amount=value,
                is_change=is_change,
            )
        )
    return out


class BitcoinService:
    def __init__(self) -> None:
        self._account_cache: dict[str, tuple[HDKey, str]] = {}
        self._chain_cache: dict[tuple[str, str, int], HDKey] = {}
        self._receive_cache_key: tuple[str, int, str] | None = None
        self._receive_cache: list[tuple[int, str]] | None = None
        self._change_cache_key: tuple[str, int, str] | None = None
        self._change_cache: list[tuple[int, str]] | None = None

    def _is_multisig(self, cfg: WalletConfig) -> bool:
        return (cfg.policy_type or "").strip() == "multisig" and bool(cfg.multisig_cosigners)

    def _cache_key(self, cfg: WalletConfig) -> tuple:
        script_type = _resolve_script_type(cfg)
        if self._is_multisig(cfg):
            return (
                multisig_cache_token(cfg),
                int(cfg.multisig_m or 0),
                int(cfg.multisig_n or 0),
                cfg.scan_limit,
                script_type,
            )
        return (normalize_extended_key(cfg.kpub), cfg.scan_limit, script_type)

    def _account(self, cfg: WalletConfig) -> tuple[HDKey, str]:
        kpub = normalize_extended_key(cfg.kpub)
        script_type = _resolve_script_type(cfg)
        cache_id = f"{kpub}|{script_type}"
        cached = self._account_cache.get(cache_id)
        if cached is not None:
            return cached
        parsed = (_hdkey_for(cfg), script_type)
        self._account_cache[cache_id] = parsed
        return parsed

    def _chain_node(self, cfg: WalletConfig, chain: int) -> HDKey:
        kpub = normalize_extended_key(cfg.kpub)
        script_type = _resolve_script_type(cfg)
        cache_id = (kpub, script_type, chain)
        cached = self._chain_cache.get(cache_id)
        if cached is not None:
            return cached
        account, _ = self._account(cfg)
        node = account.derive(str(chain))
        self._chain_cache[cache_id] = node
        return node

    def probe_wallet(self, cfg: WalletConfig) -> None:
        if self._is_multisig(cfg):
            multisig_address_at(cfg, 0, 0)
            return
        self._address_at(cfg, chain=0, index=0)

    def _address_at(self, cfg: WalletConfig, chain: int, index: int) -> str:
        if self._is_multisig(cfg):
            return multisig_address_at(cfg, chain, index)
        _, script_type = self._account(cfg)
        child = self._chain_node(cfg, chain).derive(str(index))
        return _address_for_pubkey(child.key, script_type)

    def receive_addresses(self, cfg: WalletConfig) -> list[tuple[int, str]]:
        key = self._cache_key(cfg)
        if self._receive_cache_key == key and self._receive_cache is not None:
            return self._receive_cache
        limit = max(1, cfg.scan_limit)
        if self._is_multisig(cfg):
            out = [(i, multisig_address_at(cfg, 0, i)) for i in range(limit)]
        else:
            chain = self._chain_node(cfg, 0)
            _, script_type = self._account(cfg)
            out = [
                (i, _address_for_pubkey(chain.derive(str(i)).key, script_type))
                for i in range(limit)
            ]
        self._receive_cache_key = key
        self._receive_cache = out
        return out

    def change_addresses(self, cfg: WalletConfig) -> list[tuple[int, str]]:
        key = self._cache_key(cfg)
        if self._change_cache_key == key and self._change_cache is not None:
            return self._change_cache
        limit = max(1, cfg.scan_limit)
        if self._is_multisig(cfg):
            out = [(i, multisig_address_at(cfg, 1, i)) for i in range(limit)]
        else:
            chain = self._chain_node(cfg, 1)
            _, script_type = self._account(cfg)
            out = [
                (i, _address_for_pubkey(chain.derive(str(i)).key, script_type))
                for i in range(limit)
            ]
        self._change_cache_key = key
        self._change_cache = out
        return out

    def receive_address_at(self, cfg: WalletConfig, index: int) -> str:
        return self._address_at(cfg, 0, index)

    def _receive_scan_max(self, cfg: WalletConfig) -> int:
        from .address_usage import load_receive_usage

        limit = max(1, min(cfg.scan_limit, 100))
        usage = load_receive_usage(cfg.id)
        if usage:
            return min(limit, max(usage.keys()) + _BIP44_GAP_LIMIT + 1)
        return min(limit, _QUICK_PROBE_RECEIVE + 8)

    def _change_scan_max(self, cfg: WalletConfig) -> int:
        limit = max(1, min(cfg.scan_limit, 100))
        return min(limit, max(_QUICK_PROBE_CHANGE, 12))

    def _scan_index_bounds(self, cfg: WalletConfig, gap_limit: int) -> tuple[int, int]:
        from .address_index import load_address_index
        from .address_usage import load_receive_usage

        recv_max = max(1, cfg.scan_limit)
        chg_max = max(1, min(cfg.scan_limit, max(_QUICK_PROBE_CHANGE, gap_limit)))

        usage = load_receive_usage(cfg.id)
        if usage:
            recv_max = max(recv_max, max(usage.keys()) + gap_limit + 1)

        index = load_address_index(cfg.id)
        if index["receive_indices"]:
            recv_max = max(recv_max, max(index["receive_indices"]) + gap_limit + 1)
        if index["change_indices"]:
            chg_max = max(chg_max, max(index["change_indices"]) + gap_limit + 1)

        return recv_max, chg_max

    async def _scan_chain_utxos(
        self,
        cfg: WalletConfig,
        *,
        chain: int,
        gap_limit: int,
        max_index: int,
        on_progress=None,
        start_index: int = 0,
    ) -> tuple[list[WalletUtxo], int, int]:
        """Direct /utxo gap scan. API errors do not count toward the gap limit."""
        gap = 0
        index = max(0, start_index)
        api_failures = 0
        utxos: list[WalletUtxo] = []
        last_used = -1
        is_change = chain == 1
        batch = 48
        sem = asyncio.Semaphore(_DEEP_SCAN_CONCURRENCY)

        async def check(i: int, addr: str) -> tuple[int, str, list[dict] | None, bool]:
            async with sem:
                entries, failed = await _fetch_address_utxos(addr, cfg, quick=False)
            return i, addr, entries, failed

        while index < max_index and gap < gap_limit:
            end = min(index + batch, max_index)
            pairs = [(i, self._address_at(cfg, chain, i)) for i in range(index, end)]
            if on_progress:
                label = "change" if is_change else "receive"
                on_progress(f"Scanning Bitcoin {label} #{index}…")

            results = await asyncio.gather(*(check(i, addr) for i, addr in pairs))
            results.sort(key=lambda row: row[0])

            for i, addr, entries, failed in results:
                if failed or entries is None:
                    api_failures += 1
                    continue
                if entries:
                    gap = 0
                    last_used = max(last_used, i)
                    utxos.extend(
                        _parse_utxo_entries(entries, addr=addr, index=i, is_change=is_change)
                    )
                else:
                    gap += 1
                    if gap >= gap_limit:
                        break

            index = end

        return utxos, last_used, api_failures

    def address_book(self, cfg: WalletConfig, utxos: list[WalletUtxo], *, wallet_id: str | None = None) -> dict:
        from .address_usage import (
            apply_receive_usage_to_rows,
            first_unused_receive_index,
            merge_usage_from_btc_tx_dicts,
            prune_unproven_receive_usage,
            update_change_usage,
            update_receive_usage,
        )
        from .tx_raw_cache import list_wallet_tx_dicts

        bal_by_addr: dict[str, int] = {}
        for u in utxos:
            bal_by_addr[u.address] = bal_by_addr.get(u.address, 0) + u.amount

        def rows(pairs: list[tuple[int, str]], is_change: bool) -> list[dict]:
            out = []
            for i, addr in pairs:
                sats = bal_by_addr.get(addr, 0)
                out.append(
                    {
                        "index": i,
                        "address": addr,
                        "is_change": is_change,
                        "balance_sats": sats,
                        "balance_btc": sats / SATS_PER_BTC,
                        "balance_sompi": sats,
                        "balance_kas": sats / SATS_PER_BTC,
                    }
                )
            return out

        receive_pairs = self.receive_addresses(cfg)
        change_pairs = self.change_addresses(cfg)
        receive = rows(receive_pairs, False)
        change = rows(change_pairs, True)
        wid = wallet_id or cfg.id
        usage = update_receive_usage(
            wid,
            receive_pairs,
            utxos,
            bal_by_addr,
            normalize_addr=lambda a: a,
        )
        change_usage = update_change_usage(
            wid,
            change_pairs,
            utxos,
            bal_by_addr,
            normalize_addr=lambda a: a,
        )
        cached_txs: list[dict] = []
        if (cfg.coin or "bitcoin").strip().lower() == "bitcoin":
            cached_txs = list_wallet_tx_dicts(wid)
            if cached_txs:
                usage = merge_usage_from_btc_tx_dicts(wid, receive_pairs, cached_txs)
            usage = prune_unproven_receive_usage(
                wid, receive_pairs, utxos, bal_by_addr, cached_txs or None
            )
        apply_receive_usage_to_rows(receive, usage)
        apply_receive_usage_to_rows(change, change_usage)
        next_idx = first_unused_receive_index(set(usage.keys()), cfg.scan_limit)
        next_addr = self.receive_address_at(cfg, next_idx)
        return {
            "receive": receive,
            "change": change,
            "next_receive_index": next_idx,
            "next_receive_address": next_addr,
        }

    async def fetch_utxos(self, cfg: WalletConfig, on_progress=None) -> BitcoinScanResult:
        from . import bitcoin_backend

        if on_progress:
            on_progress("Step 1 of 4 · Deriving Bitcoin receive & change addresses…")

        if not bitcoin_backend.uses_public_endpoints():
            from . import bitcoin_backend as bb

            if bb._mode() == "bitcoin_core":
                from . import bitcoin_core_rpc

                if on_progress:
                    on_progress("Step 2 of 4 · Loading UTXOs from your Bitcoin node…")
                rows = await bitcoin_core_rpc.fetch_wallet_utxos(cfg)
                addr_to_meta: dict[str, tuple[int, bool]] = {}
                for i, addr in self.receive_addresses(cfg):
                    addr_to_meta[addr] = (i, False)
                for i, addr in self.change_addresses(cfg):
                    addr_to_meta[addr] = (i, True)
                utxos: list[WalletUtxo] = []
                for row in rows:
                    addr = str(row.get("address") or "")
                    txid = str(row.get("txid") or "").lower()
                    vout = int(row.get("vout") or 0)
                    amount_btc = float(row.get("amount") or 0.0)
                    amount_sats = int(round(amount_btc * 100_000_000))
                    if not addr or not txid or amount_sats <= 0:
                        continue
                    idx, is_change = addr_to_meta.get(addr, (-1, False))
                    utxos.append(
                        WalletUtxo(
                            address=addr,
                            address_index=idx,
                            transaction_id=txid,
                            output_index=vout,
                            amount=amount_sats,
                            is_change=is_change,
                        )
                    )
                utxos.sort(key=lambda u: (-u.amount, u.is_change, u.address_index))
                if on_progress:
                    on_progress("Step 3 of 4 · Updating wallet balance…")
                return BitcoinScanResult(utxos=utxos, api_failures=0)
            # Electrum: gap scan via scripthash per address (below)

        gap_limit = _BIP44_GAP_LIMIT
        recv_max, chg_max = self._scan_index_bounds(cfg, gap_limit)
        api_failures = 0
        if on_progress:
            on_progress("Step 2 of 4 · Scanning Bitcoin addresses…")
        recv_task = asyncio.create_task(
            self._scan_chain_utxos(
                cfg,
                chain=0,
                gap_limit=gap_limit,
                max_index=recv_max,
                on_progress=on_progress,
                start_index=0,
            )
        )
        chg_task = asyncio.create_task(
            self._scan_chain_utxos(
                cfg,
                chain=1,
                gap_limit=gap_limit,
                max_index=chg_max,
                on_progress=None,
                start_index=0,
            )
        )
        (recv_utxos, _, recv_fail), (chg_utxos, _, chg_fail) = await asyncio.gather(recv_task, chg_task)
        api_failures += recv_fail + chg_fail

        seen: set[str] = set()
        merged: list[WalletUtxo] = []
        for u in recv_utxos + chg_utxos:
            if u.key in seen:
                continue
            seen.add(u.key)
            merged.append(u)
        merged.sort(key=lambda u: (-u.amount, u.is_change, u.address_index))

        if not merged and api_failures > 0:
            raise RuntimeError(
                "Bitcoin explorer APIs unreachable. Check internet and try again."
            )

        if on_progress:
            on_progress("Step 3 of 4 · Updating wallet balance…")
        from .address_index import record_utxo_items

        record_utxo_items(cfg.id, merged)
        return BitcoinScanResult(utxos=merged, api_failures=api_failures)

    async def fetch_utxos_discover(self, cfg: WalletConfig, on_progress=None) -> BitcoinScanResult:
        """Fast parallel probe of early receive/change addresses (~2–3s for typical wallets)."""
        from . import bitcoin_backend
        from .address_index import record_utxo_items

        if on_progress:
            on_progress("Checking mainnet for your first addresses…")

        if not bitcoin_backend.uses_public_endpoints():
            return await self.fetch_utxos(cfg, on_progress=on_progress)

        recv_n = min(max(1, cfg.scan_limit), _DISCOVER_RECEIVE_PROBE)
        chg_n = min(max(1, cfg.scan_limit), _DISCOVER_CHANGE_PROBE)
        pairs: list[tuple[int, str, bool]] = []
        for i in range(recv_n):
            pairs.append((i, self._address_at(cfg, 0, i), False))
        for i in range(chg_n):
            pairs.append((i, self._address_at(cfg, 1, i), True))

        sem = asyncio.Semaphore(_DISCOVER_CONCURRENCY)
        api_failures = 0

        async def check(i: int, addr: str, is_change: bool) -> tuple[list[WalletUtxo], bool]:
            async with sem:
                entries, failed = await _fetch_address_utxos(addr, cfg, quick=True)
                if failed or entries is None:
                    entries, failed = await _fetch_address_utxos(addr, cfg, quick=False)
            if failed or entries is None:
                return [], True
            return _parse_utxo_entries(entries, addr=addr, index=i, is_change=is_change), False

        results = await asyncio.gather(*(check(i, addr, is_chg) for i, addr, is_chg in pairs))
        utxos: list[WalletUtxo] = []
        seen: set[str] = set()
        last_recv = -1
        for group, failed in results:
            if failed:
                api_failures += 1
            for u in group:
                if u.key in seen:
                    continue
                seen.add(u.key)
                utxos.append(u)
                if not u.is_change:
                    last_recv = max(last_recv, u.address_index)

        if last_recv >= recv_n - 5 and recv_n < cfg.scan_limit:
            if on_progress:
                on_progress("Expanding address search…")
            extra_end = min(cfg.scan_limit, last_recv + _BIP44_GAP_LIMIT + 1)
            extra_pairs = [(i, self._address_at(cfg, 0, i), False) for i in range(recv_n, extra_end)]
            extra_results = await asyncio.gather(*(check(i, addr, False) for i, addr, _ in extra_pairs))
            for group, failed in extra_results:
                if failed:
                    api_failures += 1
                for u in group:
                    if u.key in seen:
                        continue
                    seen.add(u.key)
                    utxos.append(u)

        utxos.sort(key=lambda u: (-u.amount, u.is_change, u.address_index))
        if not utxos and api_failures > 0:
            raise RuntimeError("Bitcoin explorer APIs unreachable. Check internet and try again.")
        record_utxo_items(cfg.id, utxos)
        if on_progress:
            on_progress("Updating wallet balance…")
        return BitcoinScanResult(utxos=utxos, api_failures=api_failures)

    async def fetch_utxos_hot(
        self, cfg: WalletConfig, *, utxo_dicts: list[dict] | None = None
    ) -> BitcoinScanResult:
        """Fast live balance: query only indexed / watched addresses."""
        from .address_index import hot_addresses_for_wallet, record_utxo_items

        addresses = hot_addresses_for_wallet(cfg.id, cfg, utxo_dicts)
        if not addresses:
            return BitcoinScanResult(utxos=[], api_failures=0)
        try:
            utxos = await self.fetch_utxos_for_addresses(cfg, addresses)
        except RuntimeError:
            raise
        record_utxo_items(cfg.id, utxos)
        return BitcoinScanResult(utxos=utxos, api_failures=0)

    async def fetch_utxos_for_addresses(
        self, cfg: WalletConfig, addresses: list[str]
    ) -> list[WalletUtxo]:
        """Fetch UTXOs for explicit addresses (watch / push refresh)."""
        if not addresses:
            return []
        sem = asyncio.Semaphore(_UTXO_CONCURRENCY)
        addr_set = set(addresses)
        addr_to_meta: dict[str, tuple[int, bool]] = {}
        watch_recv_cap = min(cfg.scan_limit, 32)
        watch_chg_cap = min(cfg.scan_limit, 16)
        for i in range(watch_recv_cap):
            addr = self._address_at(cfg, 0, i)
            if addr in addr_set:
                addr_to_meta[addr] = (i, False)
        for i in range(watch_chg_cap):
            addr = self._address_at(cfg, 1, i)
            if addr in addr_set:
                addr_to_meta[addr] = (i, True)
        for addr in addresses:
            if addr in addr_to_meta:
                continue
            addr_to_meta[addr] = (-1, False)

        async def check(addr: str) -> tuple[list[WalletUtxo], bool]:
            async with sem:
                entries, failed = await _fetch_address_utxos(addr, cfg, quick=True)
                if failed or entries is None:
                    # Hot path timed out / erred — retry once without the aggressive quick cutoffs.
                    entries, failed = await _fetch_address_utxos(addr, cfg, quick=False)
            if failed or entries is None:
                return [], True
            idx, is_change = addr_to_meta.get(addr, (-1, False))
            return _parse_utxo_entries(entries, addr=addr, index=idx, is_change=is_change), False

        batches = await asyncio.gather(*(check(addr) for addr in addresses))
        merged: list[WalletUtxo] = []
        seen: set[str] = set()
        api_failures = 0
        for group, failed in batches:
            if failed:
                api_failures += 1
            for u in group:
                if u.key in seen:
                    continue
                seen.add(u.key)
                merged.append(u)
        merged.sort(key=lambda u: (-u.amount, u.is_change, u.address_index))
        if not merged and api_failures > 0:
            raise RuntimeError("Bitcoin explorer APIs unreachable. Check internet and try again.")
        return merged


_service: BitcoinService | None = None


async def fee_estimate_bitcoin(
    utxo_amount_sats: int | None = None,
    *,
    input_count: int = 1,
    output_count: int = 2,
    feerate_sat_vb: int | None = None,
    multisig: bool = False,
) -> dict:
    """Estimate fee for a native segwit send (vsize-aware)."""
    from .bitcoin_fees import fee_estimate_bitcoin_detailed

    return await fee_estimate_bitcoin_detailed(
        utxo_amount_sats=utxo_amount_sats,
        input_count=input_count,
        output_count=output_count,
        feerate_sat_vb=feerate_sat_vb,
        multisig=multisig,
    )


def get_bitcoin_service() -> BitcoinService:
    global _service
    if _service is None:
        _service = BitcoinService()
    return _service
