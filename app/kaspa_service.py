"""Kaspa mainnet RPC + watch-only kpub derivation (SeedMask m/44'/111111'/account')."""

from __future__ import annotations

import asyncio
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from kaspa import NetworkType, PublicKeyGenerator, Resolver, RpcClient

from .wallet_store import WalletConfig

SOMPI_PER_KAS = 100_000_000
NETWORK = NetworkType.Mainnet
RPC_TIMEOUT_SEC = 45.0
RPC_CONNECT_TIMEOUT_SEC = 45.0
_KASPA_BATCH_SIZE = 80
_KASPA_BATCH_CONCURRENCY = 12
_BIP44_GAP_LIMIT = 20
# Hard ceiling for discovery (matches API scan_limit max). Balance sync may look
# past the user's Scan depth so funds on higher indices are not invisible.
_KASPA_DISCOVERY_CAP = 100


def normalize_extended_key(key: str) -> str:
    """Strip whitespace/newlines from pasted QR or export text."""
    return "".join(key.strip().split())


def _normalize_kaspa_addr(addr: str) -> str:
    """Canonical kaspa:… form so RPC and derivation strings match."""
    if not addr:
        return addr
    import sys
    from pathlib import Path

    tools = Path(__file__).resolve().parent.parent / "tools"
    if not tools.is_dir():
        # Dev-only fallback; skip when coordinator/tools is present (packaged).
        # Never probe TCC-protected folders.
        alt = Path(__file__).resolve().parent.parent.parent / "tools"
        home = Path.home()
        protected = (home / "Desktop", home / "Documents", home / "Downloads")
        if alt.is_dir() and not any(str(alt).startswith(str(p) + "/") or alt == p for p in protected):
            tools = alt
    if str(tools) not in sys.path:
        sys.path.insert(0, str(tools))
    from kaspa_coordinator_qr import normalize_kaspa_address

    return normalize_kaspa_address(addr)


def _tools_dir() -> Path:
    coord_tools = Path(__file__).resolve().parent.parent / "tools"
    if coord_tools.is_dir():
        tools = coord_tools
    else:
        # Never fall back into ~/Desktop|Documents|Downloads (macOS TCC prompts).
        alt = Path(__file__).resolve().parent.parent.parent / "tools"
        home = Path.home()
        protected = (home / "Desktop", home / "Documents", home / "Downloads")
        if any(str(alt).startswith(str(p) + "/") or alt == p for p in protected):
            raise RuntimeError(f"Cannot find tools/ next to coordinator at {coord_tools}")
        tools = alt
    if str(tools) not in sys.path:
        sys.path.insert(0, str(tools))
    return tools


def _kaspa_multisig_enabled(cfg: WalletConfig) -> bool:
    return (
        (cfg.coin or "kaspa").strip().lower() == "kaspa"
        and (cfg.policy_type or "").strip().lower() == "multisig"
        and bool(cfg.multisig_cosigners)
    )


def _kaspa_multisig_cache_token(cfg: WalletConfig) -> str:
    cosigners = cfg.multisig_cosigners or []
    keys = "|".join(sorted(str(c.get("xpub") or "").strip() for c in cosigners))
    return f"ms:{cfg.multisig_m}:{cfg.multisig_n}:{keys}"


@dataclass
class WalletUtxo:
    address: str
    address_index: int
    transaction_id: str
    output_index: int
    amount: int
    is_change: bool = False
    block_daa_score: int = 0
    is_coinbase: bool = False
    covenant_id: str | None = None

    @property
    def key(self) -> str:
        return f"{self.transaction_id}:{self.output_index}"

    def to_dict(self) -> dict:
        return {
            "address": self.address,
            "address_index": self.address_index,
            "transaction_id": self.transaction_id,
            "output_index": self.output_index,
            "amount": self.amount,
            "amount_kas": self.amount / SOMPI_PER_KAS,
            "key": self.key,
            "is_change": self.is_change,
            "block_daa_score": int(self.block_daa_score or 0),
            "is_coinbase": bool(self.is_coinbase),
            "covenant_id": self.covenant_id,
        }


class KaspaService:
    """Kaspa RPC on the FastAPI asyncio loop (never mixed with Bitcoin refresh)."""

    def __init__(self) -> None:
        self._client: RpcClient | None = None
        self._client_lock = asyncio.Lock()
        self._connection_key: tuple[str, str] | None = None
        self._settings_generation = 0
        self._addr_cache_key: tuple[str, int] | None = None
        self._addr_cache: list[tuple[int, str]] | None = None
        self._change_cache_key: tuple[str, int] | None = None
        self._change_cache: list[tuple[int, str]] | None = None

    @staticmethod
    def _receive_address(gen: PublicKeyGenerator, index: int) -> str:
        return _normalize_kaspa_addr(str(gen.receive_pubkey(index).to_address(NETWORK)))

    @staticmethod
    def _change_address(gen: PublicKeyGenerator, index: int) -> str:
        # SDK change_address_as_string() wrongly returns receive addresses (chain 0).
        return _normalize_kaspa_addr(str(gen.change_pubkey(index).to_address(NETWORK)))

    @staticmethod
    def _multisig_address_at(cfg: WalletConfig, chain: int, index: int) -> str:
        _tools_dir()
        from kaspa_multisig import multisig_p2sh_address, normalize_multisig_policy

        cosigners = list(cfg.multisig_cosigners or [])
        threshold = int(cfg.multisig_m or 0)
        total = int(cfg.multisig_n or len(cosigners))
        if threshold < 1 or threshold > total or len(cosigners) != total:
            raise ValueError("Invalid Kaspa multisig quorum")

        policy_cosigners: list[dict] = []
        for i, cosigner in enumerate(cosigners, start=1):
            kpub = normalize_extended_key(str(cosigner.get("xpub") or ""))
            if not kpub.startswith("kpub"):
                raise ValueError(f"Cosigner {i}: Kaspa multisig requires kpub keys")
            gen = PublicKeyGenerator.from_xpub(kpub)
            pub = gen.change_pubkey(index) if int(chain) else gen.receive_pubkey(index)
            policy_cosigners.append(
                {
                    "pubkey": pub.to_string().strip().lower(),
                    "fingerprint": str(cosigner.get("fingerprint") or "00000000"),
                    "derivation_path": str(cosigner.get("derivation") or cfg.derivation or ""),
                    "label": str(cosigner.get("label") or ""),
                }
            )

        policy = normalize_multisig_policy(
            threshold=threshold,
            cosigners=policy_cosigners,
            account=int(cfg.account or 0),
        )
        return _normalize_kaspa_addr(multisig_p2sh_address(policy))

    @staticmethod
    def _transient_rpc_error(exc: BaseException) -> bool:
        msg = str(exc).lower()
        return any(
            token in msg
            for token in (
                "websocket",
                "not connected",
                "connection refused",
                "connection reset",
                "connection closed",
                "broken pipe",
                "disconnect",
                "remote error",
            )
        )

    async def open_fresh_client(self) -> RpcClient:
        """Dedicated RPC connection for one-shot operations (e.g. broadcast)."""
        mode, url = self._connection_settings()
        if mode == "custom" and url:
            client = RpcClient(url=url)
        else:
            client = RpcClient(resolver=Resolver())
        await asyncio.wait_for(client.connect(), timeout=RPC_CONNECT_TIMEOUT_SEC)
        return client

    async def close_client(self, client: RpcClient | None) -> None:
        if client is None:
            return
        try:
            await client.disconnect()
        except Exception:
            pass

    def mark_settings_changed(self) -> None:
        self._settings_generation += 1

    async def _reset_client(self) -> None:
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:
                pass
            self._client = None
            self._connection_key = None

    def _connection_settings(self) -> tuple[str, str]:
        from .network_settings import load_kaspa_settings

        kaspa = load_kaspa_settings()
        return kaspa.rpc_mode, kaspa.rpc_url

    async def _get_client(self) -> RpcClient:
        async with self._client_lock:
            mode, url = self._connection_settings()
            key = (mode, url)
            if self._client is not None and self._connection_key == key:
                return self._client
            if self._client is not None:
                try:
                    await self._client.disconnect()
                except Exception:
                    pass
                self._client = None
            if mode == "custom" and url:
                client = RpcClient(url=url)
            else:
                client = RpcClient(resolver=Resolver())
            await asyncio.wait_for(client.connect(), timeout=RPC_CONNECT_TIMEOUT_SEC)
            self._client = client
            self._connection_key = key
            return self._client

    async def shutdown(self) -> None:
        await self._reset_client()

    def close(self) -> None:
        try:
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(self.shutdown())
            finally:
                loop.close()
        except Exception:
            pass

    def generator_for(self, cfg: WalletConfig) -> PublicKeyGenerator:
        kpub = normalize_extended_key(cfg.kpub)
        if not kpub.startswith("kpub"):
            raise ValueError("Kaspa watch-only key must start with kpub")
        try:
            return PublicKeyGenerator.from_xpub(kpub)
        except Exception as e:
            err = str(e)
            if "malformed" in err.lower() or "public key" in err.lower():
                raise ValueError(
                    "Invalid or outdated kpub from SeedMask. Update device firmware, "
                    "then export kpub again (Crypto → Kaspa → Export kpub)."
                ) from e
            raise

    def receive_addresses(self, cfg: WalletConfig, *, count: int | None = None) -> list[tuple[int, str]]:
        limit = max(1, min(int(count if count is not None else cfg.scan_limit), _KASPA_DISCOVERY_CAP))
        key = (
            _kaspa_multisig_cache_token(cfg) if _kaspa_multisig_enabled(cfg) else normalize_extended_key(cfg.kpub),
            limit,
            "recv",
        )
        if self._addr_cache_key == key and self._addr_cache is not None:
            return self._addr_cache
        if _kaspa_multisig_enabled(cfg):
            out = [(i, self._multisig_address_at(cfg, 0, i)) for i in range(limit)]
        else:
            gen = self.generator_for(cfg)
            out = [(i, self._receive_address(gen, i)) for i in range(limit)]
        self._addr_cache_key = key
        self._addr_cache = out
        return out

    def change_addresses(self, cfg: WalletConfig, *, count: int | None = None) -> list[tuple[int, str]]:
        limit = max(1, min(int(count if count is not None else cfg.scan_limit), _KASPA_DISCOVERY_CAP))
        key = (
            _kaspa_multisig_cache_token(cfg) if _kaspa_multisig_enabled(cfg) else normalize_extended_key(cfg.kpub),
            limit,
            "chg",
        )
        if self._change_cache_key == key and self._change_cache is not None:
            return self._change_cache
        if _kaspa_multisig_enabled(cfg):
            out = [(i, self._multisig_address_at(cfg, 1, i)) for i in range(limit)]
        else:
            gen = self.generator_for(cfg)
            out = [(i, self._change_address(gen, i)) for i in range(limit)]
        self._change_cache_key = key
        self._change_cache = out
        return out

    def receive_address_at(self, cfg: WalletConfig, index: int) -> str:
        if _kaspa_multisig_enabled(cfg):
            return self._multisig_address_at(cfg, 0, index)
        gen = self.generator_for(cfg)
        return self._receive_address(gen, index)

    def change_address_at(self, cfg: WalletConfig, index: int) -> str:
        if _kaspa_multisig_enabled(cfg):
            return self._multisig_address_at(cfg, 1, index)
        gen = self.generator_for(cfg)
        return self._change_address(gen, index)

    def _resolve_unknown_address(self, cfg: WalletConfig, addr: str) -> tuple[int, bool] | None:
        """Map an RPC address to receive/change index, probing past scan_limit if needed."""
        try:
            norm = _normalize_kaspa_addr(addr)
        except ValueError:
            norm = addr
        user_limit = max(1, min(int(cfg.scan_limit), _KASPA_DISCOVERY_CAP))
        for i, a in self.receive_addresses(cfg, count=user_limit):
            if _normalize_kaspa_addr(a) == norm:
                return i, False
        for i, a in self.change_addresses(cfg, count=user_limit):
            if _normalize_kaspa_addr(a) == norm:
                return i, True
        # Funds may sit past Scan depth — probe ahead so Coins does not show Receive #-1.
        for i in range(user_limit, _KASPA_DISCOVERY_CAP):
            try:
                if _normalize_kaspa_addr(self.receive_address_at(cfg, i)) == norm:
                    return i, False
            except Exception:
                break
        for i in range(user_limit, min(_KASPA_DISCOVERY_CAP, max(user_limit + 32, 24))):
            try:
                if _normalize_kaspa_addr(self.change_address_at(cfg, i)) == norm:
                    return i, True
            except Exception:
                break
        return None

    def reclassify_utxos(self, cfg: WalletConfig, utxos: list[WalletUtxo]) -> list[WalletUtxo]:
        """Re-tag UTXOs against derived receive/change paths (fixes stale cache + RPC format drift)."""
        from .address_index_parse import as_address_index

        # Classify against a discovery window so indices past Scan depth still resolve.
        disc_n = _KASPA_DISCOVERY_CAP
        recv_map = {_normalize_kaspa_addr(a): i for i, a in self.receive_addresses(cfg, count=disc_n)}
        chg_map = {_normalize_kaspa_addr(a): i for i, a in self.change_addresses(cfg, count=disc_n)}
        out: list[WalletUtxo] = []
        for u in utxos:
            try:
                addr = _normalize_kaspa_addr(u.address)
            except ValueError:
                addr = u.address
            if addr in chg_map:
                out.append(
                    WalletUtxo(
                        address=addr,
                        address_index=chg_map[addr],
                        transaction_id=u.transaction_id,
                        output_index=u.output_index,
                        amount=u.amount,
                        is_change=True,
                        block_daa_score=u.block_daa_score,
                        is_coinbase=u.is_coinbase,
                        covenant_id=getattr(u, "covenant_id", None),
                    )
                )
            elif addr in recv_map:
                out.append(
                    WalletUtxo(
                        address=addr,
                        address_index=recv_map[addr],
                        transaction_id=u.transaction_id,
                        output_index=u.output_index,
                        amount=u.amount,
                        is_change=False,
                        block_daa_score=u.block_daa_score,
                        is_coinbase=u.is_coinbase,
                        covenant_id=getattr(u, "covenant_id", None),
                    )
                )
            else:
                resolved = self._resolve_unknown_address(cfg, addr)
                if resolved is not None:
                    idx, is_chg = resolved
                    out.append(
                        WalletUtxo(
                            address=addr,
                            address_index=idx,
                            transaction_id=u.transaction_id,
                            output_index=u.output_index,
                            amount=u.amount,
                            is_change=is_chg,
                            block_daa_score=u.block_daa_score,
                            is_coinbase=u.is_coinbase,
                            covenant_id=getattr(u, "covenant_id", None),
                        )
                    )
                else:
                    out.append(
                        WalletUtxo(
                            address=addr,
                            address_index=as_address_index(u.address_index, -1),
                            transaction_id=u.transaction_id,
                            output_index=u.output_index,
                            amount=u.amount,
                            is_change=u.is_change,
                            block_daa_score=u.block_daa_score,
                            is_coinbase=u.is_coinbase,
                            covenant_id=getattr(u, "covenant_id", None),
                        )
                    )
        return out

    def address_book(self, cfg: WalletConfig, utxos: list[WalletUtxo], *, wallet_id: str | None = None) -> dict:
        """Receive + change rows with optional per-address balance."""
        from .address_usage import (
            apply_receive_usage_to_rows,
            first_unused_receive_index,
            update_change_usage,
            update_receive_usage,
        )

        bal_by_addr: dict[str, int] = {}
        for u in utxos:
            addr = _normalize_kaspa_addr(u.address)
            bal_by_addr[addr] = bal_by_addr.get(addr, 0) + u.amount

        def rows(pairs: list[tuple[int, str]], is_change: bool) -> list[dict]:
            out = []
            for i, addr in pairs:
                sompi = bal_by_addr.get(addr, 0)
                out.append(
                    {
                        "index": i,
                        "address": addr,
                        "is_change": is_change,
                        "balance_sompi": sompi,
                        "balance_kas": sompi / SOMPI_PER_KAS,
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
            normalize_addr=_normalize_kaspa_addr,
        )
        change_usage = update_change_usage(
            wid,
            change_pairs,
            utxos,
            bal_by_addr,
            normalize_addr=_normalize_kaspa_addr,
        )
        apply_receive_usage_to_rows(receive, usage)
        apply_receive_usage_to_rows(change, change_usage)
        next_idx = first_unused_receive_index(set(usage.keys()), cfg.scan_limit)
        next_addr = self.receive_address_at(cfg, next_idx)
        from .address_usage import first_unused_change_index

        next_chg_idx = first_unused_change_index(set(change_usage.keys()), cfg.scan_limit)
        next_chg_addr = self.change_address_at(cfg, next_chg_idx)
        return {
            "receive": receive,
            "change": change,
            "next_receive_index": next_idx,
            "next_receive_address": next_addr,
            "next_change_index": next_chg_idx,
            "next_change_address": next_chg_addr,
        }

    async def _query_utxo_batch(self, batch: list[str]) -> dict:
        last_err: Exception | None = None
        for attempt in range(2):
            try:
                client = await self._get_client()
                return await asyncio.wait_for(
                    client.get_utxos_by_addresses({"addresses": batch}),
                    timeout=RPC_TIMEOUT_SEC,
                )
            except asyncio.TimeoutError as e:
                raise TimeoutError(
                    f"Kaspa mainnet query timed out after {RPC_TIMEOUT_SEC:.0f}s. "
                    "Check internet and try again."
                ) from e
            except Exception as e:
                last_err = e
                if attempt == 0 and self._transient_rpc_error(e):
                    await self._reset_client()
                    continue
                break
        assert last_err is not None
        raise RuntimeError(f"Kaspa network unavailable: {last_err}") from last_err

    async def get_sink_blue_score(self) -> int:
        """Current VSPC tip blue score from the connected kaspad (own node or resolver)."""
        last_err: Exception | None = None
        tip_timeout = min(5.0, RPC_TIMEOUT_SEC)
        for attempt in range(2):
            try:
                client = await self._get_client()
                res = await asyncio.wait_for(client.get_sink_blue_score(), timeout=tip_timeout)
                tip = getattr(res, "blue_score", None)
                if tip is None:
                    tip = getattr(res, "blueScore", None)
                if tip is None and isinstance(res, dict):
                    tip = res.get("blue_score") or res.get("blueScore")
                return int(tip or 0)
            except Exception as e:
                last_err = e
                if attempt == 0 and self._transient_rpc_error(e):
                    await self._reset_client()
                    continue
                break
        if last_err is not None:
            raise RuntimeError(f"Kaspa tip unavailable: {last_err}") from last_err
        return 0

    def _scan_address_ranges(self, cfg: WalletConfig) -> tuple[list[tuple[int, str]], list[tuple[int, str]]]:
        """Addresses to query for balance.

        Always covers the user's Scan depth in full, and also looks ahead with a
        BIP44 gap past last known activity — even beyond Scan depth — so funds on
        higher receive indices still appear in Coins / balance.
        """
        from .address_usage import load_receive_usage

        gap = _BIP44_GAP_LIMIT
        user_limit = max(1, min(int(cfg.scan_limit), _KASPA_DISCOVERY_CAP))
        usage = load_receive_usage(cfg.id)
        used_receive = sorted(usage.keys())
        recv_hi = user_limit - 1
        if used_receive:
            recv_hi = max(recv_hi, max(used_receive) + gap)
        else:
            # Low Scan depth must still probe a gap window on first sync.
            recv_hi = max(recv_hi, gap)
        recv_hi = min(recv_hi, _KASPA_DISCOVERY_CAP - 1)
        receive = self.receive_addresses(cfg, count=recv_hi + 1)

        used_chg_hi = max(used_receive) if used_receive else 0
        change_hi = max(user_limit - 1, min(_KASPA_DISCOVERY_CAP - 1, max(11, used_chg_hi + 5)))
        change = self.change_addresses(cfg, count=change_hi + 1)
        return receive, change

    def _parse_utxo_entries(
        self,
        resp: dict,
        by_addr: dict[str, tuple[int, bool]],
        change_set: set[str],
        change: list[tuple[int, str]],
    ) -> list[WalletUtxo]:
        utxos: list[WalletUtxo] = []
        for entry in resp.get("entries", []):
            raw_addr = entry.get("address", "")
            try:
                addr = _normalize_kaspa_addr(raw_addr)
            except ValueError:
                addr = raw_addr
            idx, is_chg = by_addr.get(addr, (-1, False))
            if idx < 0 and addr in change_set:
                for ci, ca in change:
                    if ca == addr:
                        idx, is_chg = ci, True
                        break
            op = entry["outpoint"]
            ue = entry["utxoEntry"]
            import sys
            from pathlib import Path

            tools = Path(__file__).resolve().parent.parent / "tools"
            if str(tools) not in sys.path:
                sys.path.insert(0, str(tools))
            from kaspa_toccata import normalize_covenant_id

            covenant_raw = ue.get("covenantId") or ue.get("covenant_id")
            utxos.append(
                WalletUtxo(
                    address=addr,
                    address_index=idx,
                    transaction_id=str(op["transactionId"]).lower().replace("0x", ""),
                    output_index=int(op.get("index", op.get("outputIndex", 0))),
                    amount=int(ue["amount"]),
                    is_change=is_chg,
                    block_daa_score=int(ue.get("blockDaaScore") or 0),
                    is_coinbase=bool(ue.get("isCoinbase") or False),
                    covenant_id=normalize_covenant_id(covenant_raw),
                )
            )
        return utxos

    async def fetch_utxos(self, cfg: WalletConfig, on_progress=None) -> list[WalletUtxo]:
        if on_progress:
            on_progress("Step 1 of 4 · Deriving Kaspa watch-only addresses…")
        receive, change = self._scan_address_ranges(cfg)
        change_set = {a for _, a in change}
        by_addr: dict[str, tuple[int, bool]] = {}
        for i, a in receive:
            by_addr[a] = (i, False)
        for i, a in change:
            by_addr[a] = (i, True)

        ordered: list[tuple[str, int, bool]] = [(a, i, False) for i, a in receive]
        ordered += [(a, i, True) for i, a in change]
        if on_progress:
            on_progress(f"Step 2 of 4 · Querying Kaspa mainnet ({len(ordered)} addresses)…")

        chunk = _KASPA_BATCH_SIZE
        sem = asyncio.Semaphore(_KASPA_BATCH_CONCURRENCY)

        async def query_chunk(batch_addrs: list[str]) -> list[WalletUtxo]:
            async with sem:
                resp = await self._query_utxo_batch(batch_addrs)
            return self._parse_utxo_entries(resp, by_addr, change_set, change)

        batches = [
            [addr for addr, _, _ in ordered[off : off + chunk]]
            for off in range(0, len(ordered), chunk)
        ]
        groups = await asyncio.gather(*(query_chunk(batch) for batch in batches))
        utxos = [u for group in groups for u in group]
        utxos.sort(key=lambda u: (-u.amount, u.is_change, u.address_index))
        if on_progress:
            on_progress("Step 3 of 4 · Collecting spendable coins (UTXOs)…")
        return self.reclassify_utxos(cfg, utxos)

    async def fetch_utxos_discover(self, cfg: WalletConfig, on_progress=None) -> list[WalletUtxo]:
        """Single-batch RPC query of early receive/change addresses (~1–2s)."""
        from .address_index import record_utxo_items

        if on_progress:
            on_progress("Checking mainnet for your first addresses…")
        recv_n = min(100, max(int(cfg.scan_limit), 21))
        chg_n = min(max(1, cfg.scan_limit), 12)
        receive = self.receive_addresses(cfg, count=recv_n)
        change = self.change_addresses(cfg, count=chg_n)
        change_set = {a for _, a in change}
        by_addr: dict[str, tuple[int, bool]] = {}
        for i, a in receive:
            by_addr[a] = (i, False)
        for i, a in change:
            by_addr[a] = (i, True)
        ordered = [(a, i, False) for i, a in receive] + [(a, i, True) for i, a in change]
        addrs = [addr for addr, _, _ in ordered]
        if not addrs:
            return []
        resp = await self._query_utxo_batch(addrs)
        utxos = self._parse_utxo_entries(resp, by_addr, change_set, change)
        utxos = self.reclassify_utxos(cfg, utxos)
        record_utxo_items(cfg.id, utxos)
        if on_progress:
            on_progress("Updating wallet balance…")
        return utxos

    async def fetch_utxos_for_addresses(
        self, cfg: WalletConfig, addresses: list[str]
    ) -> list[WalletUtxo]:
        """Query UTXOs for an explicit address list (watch / push refresh)."""
        if not addresses:
            return []
        receive = self.receive_addresses(cfg, count=100)
        change = self.change_addresses(cfg, count=100)
        change_set = {a for _, a in change}
        by_addr: dict[str, tuple[int, bool]] = {}
        for i, a in receive:
            by_addr[a] = (i, False)
        for i, a in change:
            by_addr[a] = (i, True)

        normalized = [_normalize_kaspa_addr(a) for a in addresses]
        chunk = _KASPA_BATCH_SIZE
        sem = asyncio.Semaphore(_KASPA_BATCH_CONCURRENCY)

        async def query_chunk(batch_addrs: list[str]) -> list[WalletUtxo]:
            async with sem:
                resp = await self._query_utxo_batch(batch_addrs)
            return self._parse_utxo_entries(resp, by_addr, change_set, change)

        batches = [normalized[off : off + chunk] for off in range(0, len(normalized), chunk)]
        groups = await asyncio.gather(*(query_chunk(batch) for batch in batches))
        utxos = [u for group in groups for u in group]
        utxos.sort(key=lambda u: (-u.amount, u.is_change, u.address_index))
        return self.reclassify_utxos(cfg, utxos)

    async def balance_sompi(self, cfg: WalletConfig) -> int:
        utxos = await self.fetch_utxos(cfg)
        return sum(u.amount for u in utxos)

    async def fee_estimate(
        self, utxo_amount_sompi: int | None = None, *, input_count: int = 1
    ) -> dict:
        """Estimate Toccata minimum relay fee via rusty-kaspa SDK."""
        import sys
        from pathlib import Path

        tools = Path(__file__).resolve().parent.parent / "tools"
        if str(tools) not in sys.path:
            sys.path.insert(0, str(tools))
        from kaspa_mass import minimum_relay_fee_for_transaction
        from kaspa_toccata import estimate_relay_grams

        inputs = max(1, int(input_count or 1))
        amount = int(utxo_amount_sompi or 1_000_000)
        fee_sompi = minimum_relay_fee_for_transaction(
            input_count=inputs,
            output_count=2,
            input_amount=amount,
        )
        compute_mass = estimate_relay_grams(input_count=inputs, output_count=2)
        return {
            "fee_sompi": fee_sompi,
            "fee_kas": fee_sompi / SOMPI_PER_KAS,
            "feerate": float(fee_sompi / compute_mass) if compute_mass > 0 else 100.0,
            "mass_grams": compute_mass,
            "mass": compute_mass,
            "input_count": inputs,
            "coin": "kaspa",
        }

    @staticmethod
    def validate_address(addr: str) -> str:
        import sys
        from pathlib import Path

        tools = Path(__file__).resolve().parent.parent / "tools"
        if not tools.is_dir():
            tools = Path(__file__).resolve().parent.parent.parent / "tools"
        if str(tools) not in sys.path:
            sys.path.insert(0, str(tools))
        from kaspa_coordinator_qr import kaspa_address_to_script_hex, normalize_kaspa_address

        addr = normalize_kaspa_address(addr)
        try:
            kaspa_address_to_script_hex(addr)
        except SystemExit as e:
            raise ValueError(str(e) or "Invalid Kaspa address") from e
        return addr


_service: KaspaService | None = None


def _info_flag(info: Any, *names: str) -> bool | None:
    if info is None:
        return None
    for name in names:
        if isinstance(info, dict) and name in info:
            return bool(info.get(name))
        if hasattr(info, name):
            try:
                return bool(getattr(info, name))
            except Exception:
                continue
    return None


def _describe_kaspa_connect_error(exc: BaseException, *, url: str) -> str:
    msg = str(exc).strip()
    low = msg.lower()
    if isinstance(exc, asyncio.TimeoutError) or "timed out" in low or "timeout" in low:
        return (
            "Timed out waiting for the node — is kaspad running? First sync can take a while; "
            "try again once the node has started."
        )
    if "refused" in low:
        hint = ""
        if ":16111" in url:
            hint = " Port 16111 is usually P2P; Coordinator needs Borsh WebSocket on 17110."
        elif url and "17110" not in url:
            hint = " Own nodes usually listen on ws://127.0.0.1:17110."
        return f"Connection refused — nothing is accepting WebSocket RPC at {url or 'the node'}.{hint}"
    if "invalid" in low and ("url" in low or "scheme" in low):
        return "Invalid node address — use ws:// or wss:// (example: ws://127.0.0.1:17110)."
    if "websocket" in low or "not connected" in low:
        return f"Could not open WebSocket to {url or 'the node'} — {msg or 'connection failed'}."
    return msg or type(exc).__name__


async def test_kaspa_connection(settings_dict: dict | None = None) -> dict[str, Any]:
    """Probe Kaspa RPC using draft or saved settings (does not mutate the shared service client)."""
    from .network_settings import KaspaNetworkSettings, kaspa_settings_override

    if settings_dict is not None:
        trial = KaspaNetworkSettings.from_dict(settings_dict)
        trial.validate()
        with kaspa_settings_override(trial):
            return await _test_kaspa_connection_impl()
    return await _test_kaspa_connection_impl()


async def _test_kaspa_connection_impl() -> dict[str, Any]:
    from .network_settings import load_kaspa_settings

    kaspa = load_kaspa_settings()
    mode = kaspa.rpc_mode
    url = (kaspa.rpc_url or "").strip()
    steps: list[str] = []
    client: RpcClient | None = None
    test_timeout = min(20.0, RPC_CONNECT_TIMEOUT_SEC)

    if mode == "custom":
        steps.append(f"Connecting to {url}")
        if ":16111" in url:
            steps.append(
                "Warning: port 16111 is usually Kaspa P2P — Borsh WebSocket RPC is typically 17110."
            )
        client = RpcClient(url=url)
    else:
        steps.append("Connecting via public Kaspa resolver")
        client = RpcClient(resolver=Resolver())

    try:
        try:
            await asyncio.wait_for(client.connect(), timeout=test_timeout)
        except Exception as exc:
            target = url if mode == "custom" else "public resolver"
            summary = _describe_kaspa_connect_error(exc, url=target)
            return {
                "ok": False,
                "mode": mode,
                "summary": summary,
                "steps": [*steps, summary],
            }

        steps.append("WebSocket connected")

        try:
            info = await asyncio.wait_for(client.get_info(), timeout=test_timeout)
        except Exception as exc:
            summary = f"Connected, but getInfo failed — {exc}"
            return {
                "ok": False,
                "mode": mode,
                "summary": summary,
                "steps": [*steps, summary],
            }

        is_synced = _info_flag(info, "is_synced", "isSynced")
        is_utxo_indexed = _info_flag(info, "is_utxo_indexed", "isUtxoIndexed", "has_utxo_index", "hasUtxoIndex")

        if is_synced is False:
            steps.append(
                "Warning: node is still syncing — balances may look empty or incomplete until it finishes."
            )
        elif is_synced is True:
            steps.append("Node reports synced")
        else:
            steps.append("Could not read sync status from getInfo")

        if is_utxo_indexed is False:
            steps.append(
                "UTXO index is off — restart kaspad with --utxoindex (Coordinator needs it for balances)."
            )
            return {
                "ok": False,
                "mode": mode,
                "summary": "Node reachable, but UTXO index is disabled",
                "steps": steps,
            }
        if is_utxo_indexed is True:
            steps.append("UTXO index is enabled")
        else:
            # Older nodes may omit the flag — probe with an empty UTXO query.
            try:
                await asyncio.wait_for(
                    client.get_utxos_by_addresses({"addresses": []}),
                    timeout=test_timeout,
                )
                steps.append("UTXO query OK")
            except Exception as exc:
                low = str(exc).lower()
                if "utxo" in low and "index" in low:
                    steps.append(
                        "UTXO index appears missing — restart kaspad with --utxoindex."
                    )
                    return {
                        "ok": False,
                        "mode": mode,
                        "summary": "Node reachable, but UTXO index is unavailable",
                        "steps": steps,
                    }
                steps.append(f"UTXO probe skipped: {exc}")

        summary = "Connected to Kaspa node"
        if is_synced is False:
            summary = "Connected, but the node is still syncing"
        return {
            "ok": True,
            "mode": mode,
            "summary": summary,
            "steps": steps,
        }
    finally:
        if client is not None:
            try:
                await client.disconnect()
            except Exception:
                pass


def get_service() -> KaspaService:
    global _service
    if _service is None:
        _service = KaspaService()
    return _service
