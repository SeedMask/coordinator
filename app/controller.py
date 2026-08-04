"""Shared coordinator logic (desktop + optional web server)."""

from __future__ import annotations

from dataclasses import dataclass, field

from kaspa import NetworkId, calculate_storage_mass

from .bitcoin_service import SATS_PER_BTC, get_bitcoin_service
from .kaspa_service import SOMPI_PER_KAS, WalletUtxo, get_service, normalize_extended_key
from .tx_pipeline import (
    broadcast_ready_sync,
    build_unsigned_for_send,
    load_draft,
    merge_signed,
    save_draft,
    sompi_from_kas,
    validate_address_fast,
)
from .utxo_cache import delete_utxo_cache, load_utxo_cache, save_utxo_cache
from . import wallet_state
from .wallet_store import (
    WalletConfig,
    add_wallet,
    get_active_wallet,
    get_wallet,
    remove_wallet,
    resolved_wallet_coin,
    update_wallet,
)

STORAGE_MASS_LIMIT = 100_000


@dataclass
class WalletRuntimeState:
    utxos: list[dict] = field(default_factory=list)
    balance_sompi: int = 0
    draft_id: str | None = None


class Coordinator:
    def __init__(self) -> None:
        self._wallet_state: dict[str, WalletRuntimeState] = {}

    def _state_for(self, wallet_id: str) -> WalletRuntimeState:
        if wallet_id not in self._wallet_state:
            self._wallet_state[wallet_id] = WalletRuntimeState()
        return self._wallet_state[wallet_id]

    def wallet_configured(self) -> bool:
        return get_active_wallet() is not None

    def get_wallet(self, wallet_id: str | None = None) -> WalletConfig | None:
        if wallet_id:
            return get_wallet(wallet_id)
        return get_active_wallet()

    def create_wallet(
        self,
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
        hardware: str = "",
        keystore_label: str = "",
        activate: bool = True,
    ) -> WalletConfig:
        key = normalize_extended_key(kpub)
        coin_key = (coin or "kaspa").strip().lower()
        if coin_key == "kaspa":
            svc = get_service()
            svc._addr_cache = None
            svc._addr_cache_key = None
            svc._change_cache = None
            svc._change_cache_key = None
            probe = WalletConfig(
                id="probe",
                label=label,
                kpub=key,
                account=account,
                scan_limit=scan_limit,
                coin=coin_key,
            )
            svc.generator_for(probe)
        elif coin_key == "bitcoin":
            btc = get_bitcoin_service()
            btc._receive_cache = None
            btc._receive_cache_key = None
            btc._change_cache = None
            btc._change_cache_key = None
            btc._account_cache.clear()
            btc._chain_cache.clear()
            probe = WalletConfig(
                id="probe",
                label=label,
                kpub=key,
                account=account,
                scan_limit=scan_limit,
                coin=coin_key,
                derivation=derivation,
                script_type=script_type,
                policy_type=policy_type,
                multisig_m=int(multisig_m or 0),
                multisig_n=int(multisig_n or 0),
                multisig_cosigners=list(multisig_cosigners or []),
            )
            btc.probe_wallet(probe)
        cfg = add_wallet(
            key,
            label,
            scan_limit,
            account,
            coin=coin_key,
            derivation=derivation,
            fingerprint=fingerprint,
            script_type=script_type,
            policy_type=policy_type,
            multisig_m=multisig_m,
            multisig_n=multisig_n,
            multisig_cosigners=multisig_cosigners,
            hardware=hardware,
            keystore_label=keystore_label,
            activate=activate,
        )
        self._state_for(cfg.id)
        return cfg

    def delete_wallet(self, wallet_id: str) -> None:
        remove_wallet(wallet_id)
        self._wallet_state.pop(wallet_id, None)
        delete_utxo_cache(wallet_id)
        from .address_index import _path as address_index_path

        try:
            address_index_path(wallet_id).unlink(missing_ok=True)
        except OSError:
            pass

    def _persist_utxos_to_store(
        self,
        wallet_id: str,
        utxos: list[dict],
        *,
        coin: str,
        sync_status: str | None = None,
    ) -> int:
        balance = sum(int(u.get("amount") or 0) for u in utxos)
        save_utxo_cache(
            wallet_id,
            utxos=utxos,
            balance_sompi=balance,
            coin=coin,
            sync_status=sync_status,
        )
        return balance

    def _hydrate_from_disk(self, wallet_id: str) -> WalletRuntimeState | None:
        wallet_state.init_db()
        state = wallet_state.get_wallet_state(wallet_id, include_transactions=False)
        if state.get("utxos") or int(state.get("balance_sompi") or 0) > 0:
            cfg = get_wallet(wallet_id)
            if not cfg:
                return None
            cfg_coin = resolved_wallet_coin(cfg)
            if (state.get("coin") or cfg_coin) != cfg_coin:
                return None
            st = self._state_for(wallet_id)
            utxos = list(state.get("utxos") or [])
            if cfg_coin == "kaspa" and utxos:
                from .kaspa_service import WalletUtxo, get_service

                svc = get_service()
                typed = [
                    WalletUtxo(
                        address=u["address"],
                        address_index=int(u["address_index"]),
                        transaction_id=u["transaction_id"],
                        output_index=int(u["output_index"]),
                        amount=int(u["amount"]),
                        is_change=bool(u.get("is_change")),
                        block_daa_score=int(u.get("block_daa_score") or u.get("blockDaaScore") or 0),
                        is_coinbase=bool(u.get("is_coinbase") or u.get("isCoinbase") or False),
                        covenant_id=u.get("covenant_id") or u.get("covenantId"),
                    )
                    for u in utxos
                ]
                utxos = [u.to_dict() for u in svc.reclassify_utxos(cfg, typed)]
            st.utxos = utxos
            st.balance_sompi = sum(int(u.get("amount") or 0) for u in utxos)
            return st
        cached = load_utxo_cache(wallet_id)
        if not cached:
            return None
        cfg = get_wallet(wallet_id)
        if not cfg:
            return None
        cfg_coin = resolved_wallet_coin(cfg)
        cached_coin = (cached.get("coin") or "").strip().lower()
        if cached_coin and cached_coin != cfg_coin:
            return None
        st = self._state_for(wallet_id)
        utxos = list(cached.get("utxos") or [])
        if cfg_coin == "bitcoin":
            utxos = [
                u
                for u in utxos
                if str(u.get("address") or "").strip().lower().startswith(("bc1", "tb1", "1", "3"))
            ]
        elif cfg_coin == "kaspa":
            utxos = [
                u
                for u in utxos
                if str(u.get("address") or "").strip().lower().startswith("kaspa:")
                or (
                    ":" not in str(u.get("address") or "")
                    and str(u.get("address") or "").strip().lower()[:1] in "qpzry9"
                )
            ]
        if cfg_coin == "kaspa" and utxos:
            from .kaspa_service import WalletUtxo, get_service

            svc = get_service()
            typed = [
                WalletUtxo(
                    address=u["address"],
                    address_index=int(u["address_index"]),
                    transaction_id=u["transaction_id"],
                    output_index=int(u["output_index"]),
                    amount=int(u["amount"]),
                    is_change=bool(u.get("is_change")),
                    block_daa_score=int(u.get("block_daa_score") or u.get("blockDaaScore") or 0),
                    is_coinbase=bool(u.get("is_coinbase") or u.get("isCoinbase") or False),
                    covenant_id=u.get("covenant_id") or u.get("covenantId"),
                )
                for u in utxos
            ]
            utxos = [u.to_dict() for u in svc.reclassify_utxos(cfg, typed)]
        st.utxos = utxos
        st.balance_sompi = sum(int(u.get("amount") or 0) for u in utxos)
        return st

    def _bitcoin_refresh_response(self, cfg: WalletConfig, st: WalletRuntimeState) -> dict:
        bal = st.balance_sompi
        return {
            "wallet_id": cfg.id,
            "balance_sats": bal,
            "balance_btc": bal / SATS_PER_BTC,
            "balance_sompi": bal,
            "balance_kas": bal / SATS_PER_BTC,
            "utxos": st.utxos,
            "coin": "bitcoin",
        }

    def refresh_sync(self, wallet_id: str | None = None, on_progress=None) -> dict:
        import asyncio

        return asyncio.run(self.refresh(wallet_id=wallet_id, on_progress=on_progress))

    async def refresh(self, wallet_id: str | None = None, on_progress=None) -> dict:
        cfg = self.get_wallet(wallet_id)
        if not cfg:
            raise RuntimeError("Add watch-only wallet (kpub) first")
        coin = resolved_wallet_coin(cfg)
        if coin not in ("bitcoin", "kaspa"):
            raise RuntimeError(f"Unsupported coin: {cfg.coin}")
        if coin == "bitcoin":
            from .bitcoin_service import _utxo_dict

            btc = get_bitcoin_service()
            st = self._state_for(cfg.id)
            if not st.utxos:
                self._hydrate_from_disk(cfg.id)
            try:
                scan = await btc.fetch_utxos(cfg, on_progress=on_progress)
                st.utxos = [_utxo_dict(u) for u in scan.utxos]
                st.balance_sompi = sum(u.amount for u in scan.utxos)
                from .address_index import record_utxo_items

                record_utxo_items(cfg.id, st.utxos)
                self._persist_utxos_to_store(
                    cfg.id, st.utxos, coin="bitcoin", sync_status=wallet_state.SYNC_LIVE
                )
                wallet_state.touch_deep_sync(cfg.id, status=wallet_state.SYNC_LIVE)
                from .address_usage import update_receive_usage

                bal_by_addr: dict[str, int] = {}
                for u in st.utxos:
                    if u.get("is_change"):
                        continue
                    addr = str(u.get("address") or "")
                    bal_by_addr[addr] = bal_by_addr.get(addr, 0) + int(u.get("amount") or 0)
                update_receive_usage(
                    cfg.id,
                    btc.receive_addresses(cfg),
                    st.utxos,
                    bal_by_addr,
                    normalize_addr=lambda a: a,
                )
            except Exception:
                raise
            from .wallet_store import _now_iso

            update_wallet(cfg.id, last_synced_at=_now_iso())
            resp = self._bitcoin_refresh_response(cfg, st)
            resp["sync_mode"] = "deep"
            return resp
        if coin != "kaspa":
            raise RuntimeError(f"Wallet {cfg.id} is not a Kaspa wallet")
        svc = get_service()
        utxos = await svc.fetch_utxos(cfg, on_progress=on_progress)
        utxos = svc.reclassify_utxos(cfg, utxos)
        bal = sum(u.amount for u in utxos)
        st = self._state_for(cfg.id)
        st.utxos = [u.to_dict() for u in utxos]
        st.balance_sompi = bal
        from .address_index import record_utxo_items

        record_utxo_items(cfg.id, st.utxos)
        self._persist_utxos_to_store(cfg.id, st.utxos, coin="kaspa", sync_status=wallet_state.SYNC_LIVE)
        wallet_state.touch_deep_sync(cfg.id, status=wallet_state.SYNC_LIVE)
        from .address_usage import update_receive_usage
        from .kaspa_service import _normalize_kaspa_addr

        bal_by_addr: dict[str, int] = {}
        for u in st.utxos:
            if u.get("is_change"):
                continue
            addr = _normalize_kaspa_addr(str(u.get("address") or ""))
            bal_by_addr[addr] = bal_by_addr.get(addr, 0) + int(u.get("amount") or 0)
        update_receive_usage(
            cfg.id,
            svc.receive_addresses(cfg, count=100),
            st.utxos,
            bal_by_addr,
            normalize_addr=_normalize_kaspa_addr,
        )
        from .wallet_store import _now_iso
        from .address_index_parse import as_address_index

        # If coins landed past Scan depth, raise it so Addresses / next-receive stay consistent.
        max_recv = max(
            (
                as_address_index(u.get("address_index"), -1)
                for u in st.utxos
                if not u.get("is_change")
            ),
            default=-1,
        )
        if max_recv >= cfg.scan_limit:
            new_limit = min(100, max(cfg.scan_limit, max_recv + 1 + 20))
            if new_limit > cfg.scan_limit:
                update_wallet(cfg.id, scan_limit=new_limit)
                cfg.scan_limit = new_limit

        update_wallet(cfg.id, last_synced_at=_now_iso())
        return {
            "wallet_id": cfg.id,
            "balance_sompi": bal,
            "balance_kas": bal / SOMPI_PER_KAS,
            "utxos": st.utxos,
            "coin": "kaspa",
            "sync_mode": "deep",
            "scan_limit": cfg.scan_limit,
        }

    @staticmethod
    def _utxo_fingerprint(utxos: list[dict]) -> tuple[int, frozenset[str]]:
        total = sum(int(u.get("amount") or 0) for u in utxos)
        keys = frozenset(
            str(u.get("key") or f"{u.get('transaction_id')}:{u.get('output_index')}")
            for u in utxos
        )
        return total, keys

    async def refresh_watch(self, wallet_id: str | None = None) -> dict:
        """Hot mainnet refresh: re-query indexed / watched addresses only."""
        cfg = self.get_wallet(wallet_id)
        if not cfg:
            raise RuntimeError("Add watch-only wallet (kpub) first")
        coin = resolved_wallet_coin(cfg)
        st = self._state_for(cfg.id)
        if not st.utxos:
            self._hydrate_from_disk(cfg.id)
        prior = list(st.utxos)
        prior_fp = self._utxo_fingerprint(prior)

        from .address_index import record_utxo_items
        from .watch_addresses import watch_addresses_for_wallet

        watch = watch_addresses_for_wallet(cfg.id, cfg, prior)

        if coin == "bitcoin":
            from .bitcoin_service import _utxo_dict, get_bitcoin_service

            btc = get_bitcoin_service()
            scan = await btc.fetch_utxos_hot(cfg, utxo_dicts=prior)
            if scan.api_failures > 0 and not scan.utxos and prior:
                raise RuntimeError("Bitcoin explorer APIs unreachable. Check internet and try again.")
            fresh_dicts = [_utxo_dict(u) for u in scan.utxos]
            watch_set = set(watch)
            kept = [u for u in prior if str(u.get("address") or "") not in watch_set]
            merged = kept + fresh_dicts
            seen: set[str] = set()
            utxos: list[dict] = []
            for u in merged:
                key = str(u.get("key") or f"{u.get('transaction_id')}:{u.get('output_index')}")
                if key in seen:
                    continue
                seen.add(key)
                utxos.append(u)
            st.utxos = utxos
            st.balance_sompi = sum(int(u.get("amount") or 0) for u in utxos)
            record_utxo_items(cfg.id, utxos)
            new_fp = self._utxo_fingerprint(utxos)
            changed = new_fp != prior_fp
            if st.utxos or changed:
                self._persist_utxos_to_store(
                    cfg.id,
                    st.utxos,
                    coin="bitcoin",
                    sync_status=wallet_state.SYNC_LIVE,
                )
            from .wallet_store import _now_iso

            update_wallet(cfg.id, last_synced_at=_now_iso())
            resp = self._bitcoin_refresh_response(cfg, st)
            resp["changed"] = changed
            resp["sync_mode"] = "hot"
            return resp

        svc = get_service()
        fresh = await svc.fetch_utxos_for_addresses(cfg, watch)
        fresh_dicts = [u.to_dict() for u in fresh]
        watch_set = set(watch)
        kept = [u for u in prior if str(u.get("address") or "") not in watch_set]
        merged = kept + fresh_dicts
        seen: set[str] = set()
        merged_unique: list[dict] = []
        for u in merged:
            key = str(u.get("key") or f"{u.get('transaction_id')}:{u.get('output_index')}")
            if key in seen:
                continue
            seen.add(key)
            merged_unique.append(u)
        typed = [
            WalletUtxo(
                address=u["address"],
                address_index=int(u["address_index"]),
                transaction_id=u["transaction_id"],
                output_index=int(u["output_index"]),
                amount=int(u["amount"]),
                is_change=bool(u.get("is_change")),
                block_daa_score=int(u.get("block_daa_score") or 0),
                is_coinbase=bool(u.get("is_coinbase") or False),
                covenant_id=u.get("covenant_id") or u.get("covenantId"),
            )
            for u in merged_unique
        ]
        classified = svc.reclassify_utxos(cfg, typed)
        st.utxos = [u.to_dict() for u in classified]
        bal = sum(u.amount for u in classified)
        st.balance_sompi = bal
        record_utxo_items(cfg.id, st.utxos)
        new_fp = self._utxo_fingerprint(st.utxos)
        changed = new_fp != prior_fp
        self._persist_utxos_to_store(cfg.id, st.utxos, coin="kaspa", sync_status=wallet_state.SYNC_LIVE)
        from .wallet_store import _now_iso

        update_wallet(cfg.id, last_synced_at=_now_iso())
        return {
            "wallet_id": cfg.id,
            "balance_sompi": bal,
            "balance_kas": bal / SOMPI_PER_KAS,
            "utxos": st.utxos,
            "coin": "kaspa",
            "changed": changed,
            "sync_mode": "hot",
            "sync_status": wallet_state.SYNC_LIVE,
        }

    async def refresh_discover(self, wallet_id: str | None = None, on_progress=None) -> dict:
        """Fast discovery scan for new wallets — parallel probe of early addresses."""
        cfg = self.get_wallet(wallet_id)
        if not cfg:
            raise RuntimeError("Add watch-only wallet (kpub) first")
        coin = resolved_wallet_coin(cfg)
        st = self._state_for(cfg.id)
        if not st.utxos:
            self._hydrate_from_disk(cfg.id)

        if coin == "bitcoin":
            from .bitcoin_service import _utxo_dict, get_bitcoin_service

            btc = get_bitcoin_service()
            scan = await btc.fetch_utxos_discover(cfg, on_progress=on_progress)
            st.utxos = [_utxo_dict(u) for u in scan.utxos]
            st.balance_sompi = sum(u.amount for u in scan.utxos)
            self._persist_utxos_to_store(
                cfg.id, st.utxos, coin="bitcoin", sync_status=wallet_state.SYNC_INCOMPLETE
            )
            from .address_usage import update_receive_usage

            bal_by_addr: dict[str, int] = {}
            for u in st.utxos:
                if u.get("is_change"):
                    continue
                addr = str(u.get("address") or "")
                bal_by_addr[addr] = bal_by_addr.get(addr, 0) + int(u.get("amount") or 0)
            update_receive_usage(
                cfg.id,
                btc.receive_addresses(cfg),
                st.utxos,
                bal_by_addr,
                normalize_addr=lambda a: a,
            )
            from .wallet_store import _now_iso

            update_wallet(cfg.id, last_synced_at=_now_iso())
            resp = self._bitcoin_refresh_response(cfg, st)
            resp["changed"] = True
            resp["sync_mode"] = "discover"
            return resp

        svc = get_service()
        utxos = await svc.fetch_utxos_discover(cfg, on_progress=on_progress)
        utxos = svc.reclassify_utxos(cfg, utxos)
        bal = sum(u.amount for u in utxos)
        st.utxos = [u.to_dict() for u in utxos]
        st.balance_sompi = bal
        self._persist_utxos_to_store(cfg.id, st.utxos, coin="kaspa", sync_status=wallet_state.SYNC_LIVE)
        wallet_state.touch_hot_sync(cfg.id)
        from .address_usage import update_receive_usage
        from .kaspa_service import _normalize_kaspa_addr

        bal_by_addr: dict[str, int] = {}
        for u in st.utxos:
            if u.get("is_change"):
                continue
            addr = _normalize_kaspa_addr(str(u.get("address") or ""))
            bal_by_addr[addr] = bal_by_addr.get(addr, 0) + int(u.get("amount") or 0)
        update_receive_usage(
            cfg.id,
            svc.receive_addresses(cfg),
            st.utxos,
            bal_by_addr,
            normalize_addr=_normalize_kaspa_addr,
        )
        from .wallet_store import _now_iso

        update_wallet(cfg.id, last_synced_at=_now_iso())
        return {
            "wallet_id": cfg.id,
            "balance_sompi": bal,
            "balance_kas": bal / SOMPI_PER_KAS,
            "utxos": st.utxos,
            "coin": "kaspa",
            "changed": True,
            "sync_mode": "discover",
            "sync_status": wallet_state.SYNC_LIVE,
        }

    def apply_utxo_snapshots(self, wallet_id: str, utxo_dicts: list[dict], *, coin: str) -> None:
        """Replace wallet UTXO cache from a client snapshot."""
        from .send_fees import wallet_utxo_from_dict

        coin_key = (coin or "kaspa").strip().lower()

        def _addr_matches_coin(address: str) -> bool:
            a = (address or "").strip().lower()
            if not a:
                return False
            if coin_key == "bitcoin":
                return a.startswith(("bc1", "tb1", "1", "3"))
            return a.startswith("kaspa:") or (":" not in a and a[:1] in "qpzry9")

        st = self._state_for(wallet_id)
        by_key: dict[str, dict] = {}
        for raw in utxo_dicts:
            wu = wallet_utxo_from_dict(raw)
            if not _addr_matches_coin(wu.address):
                continue
            by_key[wu.key] = wu.to_dict()
        st.utxos = list(by_key.values())
        st.balance_sompi = sum(int(u.get("amount") or 0) for u in st.utxos)
        if st.utxos:
            self._persist_utxos_to_store(wallet_id, st.utxos, coin=coin_key)

    def get_cached_balance(self, wallet_id: str) -> dict | None:
        wallet_state.init_db()
        state = wallet_state.get_wallet_state(wallet_id, include_transactions=False)
        if state.get("utxos") or int(state.get("balance_sompi") or 0) > 0:
            st = self._state_for(wallet_id)
            st.utxos = list(state.get("utxos") or [])
            st.balance_sompi = int(state.get("balance_sompi") or 0)
        else:
            st = self._wallet_state.get(wallet_id)
            if not st or (st.balance_sompi == 0 and not st.utxos):
                self._hydrate_from_disk(wallet_id)
                st = self._wallet_state.get(wallet_id)
        if not st:
            return None
        if st.balance_sompi == 0 and not st.utxos:
            return None
        bal = st.balance_sompi
        cfg = get_wallet(wallet_id)
        if cfg and (cfg.coin or "").strip().lower() == "bitcoin":
            return {
                "wallet_id": wallet_id,
                "balance_sats": bal,
                "balance_btc": bal / SATS_PER_BTC,
                "balance_sompi": bal,
                "balance_kas": bal / SATS_PER_BTC,
                "utxos": st.utxos,
                "coin": "bitcoin",
            }
        return {
            "wallet_id": wallet_id,
            "balance_sompi": bal,
            "balance_kas": bal / SOMPI_PER_KAS,
            "utxos": st.utxos,
            "coin": "kaspa",
        }

    def build_send(
        self,
        utxo_key: str,
        to_address: str,
        send_kas: float,
        wallet_id: str | None = None,
        on_progress=None,
    ) -> dict:
        def step(msg: str) -> None:
            if on_progress:
                on_progress(msg)

        cfg = self.get_wallet(wallet_id)
        if not cfg:
            raise RuntimeError("Configure watch-only wallet first")
        st = self._state_for(cfg.id)
        if not st.utxos:
            raise RuntimeError("Refresh balance first")

        utxo = next((u for u in st.utxos if u["key"] == utxo_key), None)
        if not utxo:
            raise RuntimeError("UTXO not found — refresh wallet")

        step("Validating recipient address…")
        to_addr = validate_address_fast(to_address.strip())
        send = sompi_from_kas(send_kas)
        amount = int(utxo["amount"])
        fee = amount - send
        if send <= 0 or fee < 0:
            raise RuntimeError("Invalid amount or fee")

        sm = calculate_storage_mass(NetworkId("mainnet"), [amount], [send])
        if sm is not None and sm > STORAGE_MASS_LIMIT:
            raise RuntimeError(
                f"KIP-9 storage mass {sm} exceeds {STORAGE_MASS_LIMIT}. "
                "Lower the send amount or use a larger UTXO."
            )

        wutxo = WalletUtxo(
            address=utxo["address"],
            address_index=int(utxo["address_index"]),
            transaction_id=utxo["transaction_id"],
            output_index=int(utxo["output_index"]),
            amount=amount,
            is_change=bool(utxo.get("is_change")),
            block_daa_score=int(utxo.get("block_daa_score") or utxo.get("blockDaaScore") or 0),
            is_coinbase=bool(utxo.get("is_coinbase") or utxo.get("isCoinbase") or False),
            covenant_id=utxo.get("covenant_id") or utxo.get("covenantId"),
        )
        step("Building transaction (PSKT + SeedMask JSON)…")
        from .tx_pipeline import save_draft_from_build

        draft_id, _pskt, unsigned = save_draft_from_build(cfg, wutxo, to_addr, send)
        try:
            import sys
            from pathlib import Path

            tools = Path(__file__).resolve().parent.parent / "tools"
            if not tools.is_dir():
                tools = Path(__file__).resolve().parent.parent.parent / "tools"
            if str(tools) not in sys.path:
                sys.path.insert(0, str(tools))
            from kaspa_mass import analyze_unsigned

            rep = analyze_unsigned(unsigned)
            if rep.minimum_relay_fee is not None and fee < rep.minimum_relay_fee:
                max_send = amount - rep.minimum_relay_fee
                raise RuntimeError(
                    f"Fee {fee} sompi is below network minimum {rep.minimum_relay_fee} sompi. "
                    f"Send at most {max(0, max_send) / 100_000_000:.8f} KAS from this UTXO."
                )
        except ImportError:
            pass
        st.draft_id = draft_id
        step("Generating QR code…")
        from .ur_qr import fountain_qr_frames_base64

        qr_pack = fountain_qr_frames_base64(unsigned, qr_display_mode="animated")
        return {
            "draft_id": draft_id,
            "unsigned": unsigned,
            **qr_pack,
            "summary": {
                "send_kas": send / SOMPI_PER_KAS,
                "fee_sompi": fee,
                "to_address": to_addr,
                "from_address": utxo["address"],
            },
        }

    def broadcast_sync(
        self, draft_id: str, signed: dict, on_progress=None, pskt_index: int = 0
    ) -> dict:
        from .network_settings import explorer_tx_url
        from .tx_pipeline import broadcast_for_draft_sync, is_bitcoin_draft, _load_draft_raw

        txid = broadcast_for_draft_sync(
            draft_id, signed, on_progress=on_progress, pskt_index=pskt_index
        )
        data = _load_draft_raw(draft_id)
        if is_bitcoin_draft(data):
            return {
                "transaction_id": txid,
                "explorer": explorer_tx_url(txid, coin="bitcoin"),
                "coin": "bitcoin",
            }
        return {"transaction_id": txid, "explorer": explorer_tx_url(txid, coin="kaspa"), "coin": "kaspa"}

    async def broadcast(
        self, draft_id: str, signed: dict, on_progress=None, pskt_index: int = 0
    ) -> dict:
        from .network_settings import explorer_tx_url
        from .tx_pipeline import broadcast_for_draft, is_bitcoin_draft, _load_draft_raw

        txid = await broadcast_for_draft(
            draft_id, signed, on_progress=on_progress, pskt_index=pskt_index
        )
        data = _load_draft_raw(draft_id)
        if is_bitcoin_draft(data):
            return {
                "transaction_id": txid,
                "explorer": explorer_tx_url(txid, coin="bitcoin"),
                "coin": "bitcoin",
            }
        return {"transaction_id": txid, "explorer": explorer_tx_url(txid, coin="kaspa"), "coin": "kaspa"}

    def shutdown(self) -> None:
        get_service().close()
