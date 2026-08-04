"""Route Bitcoin chain queries by configured server mode."""

from __future__ import annotations

from typing import Any

from .wallet_store import WalletConfig


def _mode() -> str:
    from .network_settings import load_bitcoin_settings

    return load_bitcoin_settings().server_mode


def uses_public_endpoints() -> bool:
    return _mode() == "public"


def uses_poll_only_watcher() -> bool:
    return _mode() in {"bitcoin_core", "electrum"}


def _describe_request_error(exc: BaseException) -> str:
    from . import bitcoin_http

    return bitcoin_http.describe_http_error(exc)


async def test_bitcoin_connection(settings_dict: dict | None = None) -> dict[str, Any]:
    from .network_settings import BitcoinNetworkSettings, bitcoin_settings_override, load_bitcoin_settings

    if settings_dict is not None:
        trial = BitcoinNetworkSettings.from_dict(settings_dict)
        trial.validate()
        with bitcoin_settings_override(trial):
            return await _test_bitcoin_connection_impl()
    return await _test_bitcoin_connection_impl()


async def _test_bitcoin_connection_impl() -> dict[str, Any]:
    from .network_settings import is_exclusive_public_preset, load_bitcoin_settings

    mode = load_bitcoin_settings().server_mode

    if mode == "bitcoin_core":
        from . import bitcoin_core_rpc

        return await bitcoin_core_rpc.test_connection()
    if mode == "electrum":
        from . import bitcoin_electrum

        return await bitcoin_electrum.test_connection()

    from . import bitcoin_http

    btc = load_bitcoin_settings()
    exclusive = is_exclusive_public_preset(btc.public_preset)

    steps = [
        "Public server mode uses these endpoints only:",
        f"Block explorer: {btc.esplora_primary}",
    ]
    if btc.esplora_fallbacks and not exclusive:
        steps.append(f"Backups: {', '.join(btc.esplora_fallbacks[:3])}")
    elif exclusive:
        steps.append(f"Preset: {btc.public_preset} (no other providers)")

    primary = (btc.esplora_primary or "").strip().rstrip("/")
    if not primary:
        return {
            "ok": False,
            "mode": "public",
            "summary": "No explorer URL configured",
            "steps": steps,
        }

    import httpx

    # Exclusive presets: primary must work. Recommended may use configured backups.
    candidates: list[str] = [primary]
    if not exclusive:
        for url in btc.esplora_fallbacks or []:
            stripped = (url or "").strip().rstrip("/")
            if stripped and stripped not in candidates:
                candidates.append(stripped)

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(8.0, connect=4.0),
        headers={"User-Agent": "SeedMask-Coordinator/1.0", "Accept": "application/json"},
        follow_redirects=True,
        verify=__import__("certifi").where(),
    ) as client:
        primary_ok = False
        primary_summary = ""
        primary_height = 0
        try:
            ok, height, summary = await bitcoin_http.probe_esplora_tip(client, primary)
            primary_ok = bool(ok)
            primary_summary = summary
            primary_height = int(height or 0)
            steps.append(f"GET {primary}/blocks/tip/height")
            steps.append(summary if not ok else f"Esplora OK — tip height {primary_height}")
        except Exception as exc:
            primary_summary = str(exc)
            steps.append(f"{primary}: {exc}")

        if exclusive:
            if primary_ok:
                return {
                    "ok": True,
                    "mode": "public",
                    "summary": primary_summary or f"Connected to {primary}",
                    "steps": steps,
                }
            return {
                "ok": False,
                "mode": "public",
                "summary": f"Could not reach {primary}",
                "steps": [*steps, "Chosen server is unreachable — no fallback used"],
            }

        if primary_ok:
            return {
                "ok": True,
                "mode": "public",
                "summary": primary_summary or f"Connected to {primary}",
                "steps": steps,
            }

        for base in candidates[1:6]:
            try:
                ok, height, summary = await bitcoin_http.probe_esplora_tip(client, base)
            except Exception as exc:
                steps.append(f"{base}: {exc}")
                continue
            if not ok:
                steps.append(f"{base}: {summary}")
                continue
            return {
                "ok": True,
                "mode": "public",
                "summary": summary,
                "steps": [
                    *steps,
                    f"GET {base}/blocks/tip/height",
                    f"Esplora OK — tip height {height}",
                    f"Note: primary ({primary}) is unreachable; connected via backup {base}",
                ],
            }

    return {
        "ok": False,
        "mode": "public",
        "summary": "Could not reach any configured Bitcoin server",
        "steps": [*steps, "All explorer probes failed or timed out"],
    }


async def fetch_address_utxos(address: str, cfg: WalletConfig | None = None) -> list[dict]:
    mode = _mode()
    if mode == "bitcoin_core":
        from . import bitcoin_core_rpc

        if cfg is None:
            raise RuntimeError("Wallet config required for Bitcoin Core backend")
        return await bitcoin_core_rpc.fetch_address_utxos(address, cfg)
    if mode == "electrum":
        from . import bitcoin_electrum

        return await bitcoin_electrum.fetch_address_utxos(address, cfg)

    from .bitcoin_service import _fetch_address_utxos_esplora

    utxos, _failed = await _fetch_address_utxos_esplora(address)
    return utxos or []


async def fetch_address_transactions(address: str, cfg: WalletConfig | None = None) -> list[dict]:
    mode = _mode()
    if mode == "electrum":
        from . import bitcoin_electrum

        history = await bitcoin_electrum.fetch_address_history(address)
        txs: list[dict] = []
        for item in history:
            txid = str(item.get("tx_hash") or "").lower()
            if not txid:
                continue
            tx = await bitcoin_electrum.get_transaction_verbose(txid)
            if tx:
                txs.append(_electrum_tx_to_esplora(txid, tx, address))
        return txs

    if mode == "bitcoin_core":
        from . import bitcoin_core_rpc

        if cfg is None:
            return []
        wallet_addrs = _wallet_address_set(cfg)
        if address not in wallet_addrs:
            return []
        all_txs = await bitcoin_core_rpc.fetch_wallet_transactions(cfg, wallet_addrs)
        filtered: list[dict] = []
        for tx in all_txs:
            vouts = tx.get("vout") or []
            vins = tx.get("vin") or []
            addrs = {
                str(o.get("scriptpubkey_address") or "")
                for o in vouts
            } | {
                str((i.get("prevout") or {}).get("scriptpubkey_address") or "")
                for i in vins
            }
            if address in addrs:
                filtered.append(tx)
        return filtered

    from .transaction_history import _fetch_btc_address_txs_esplora

    return await _fetch_btc_address_txs_esplora(address)


async def fetch_recommended_feerates() -> dict[str, float]:
    mode = _mode()
    if mode == "bitcoin_core":
        from . import bitcoin_core_rpc

        fastest = await bitcoin_core_rpc.estimatesmartfee_sat_vb(2)
        half = await bitcoin_core_rpc.estimatesmartfee_sat_vb(6)
        hour = await bitcoin_core_rpc.estimatesmartfee_sat_vb(12)
        economy = await bitcoin_core_rpc.estimatesmartfee_sat_vb(144)
        return {
            "fastest": float(fastest),
            "halfHour": float(half),
            "hour": float(hour),
            "economy": float(economy),
            "minimum": float(min(economy, half)),
        }
    if mode == "electrum":
        from . import bitcoin_electrum

        fastest = await bitcoin_electrum.estimate_fee_sat_vb(2)
        half = await bitcoin_electrum.estimate_fee_sat_vb(6)
        hour = await bitcoin_electrum.estimate_fee_sat_vb(12)
        economy = await bitcoin_electrum.estimate_fee_sat_vb(25)
        return {
            "fastest": float(fastest),
            "halfHour": float(half),
            "hour": float(hour),
            "economy": float(economy),
            "minimum": float(min(economy, half)),
        }

    from .bitcoin_fees import fetch_recommended_feerates_public

    return await fetch_recommended_feerates_public()


async def broadcast_raw_tx(raw_tx: bytes) -> str:
    mode = _mode()
    if mode == "bitcoin_core":
        from . import bitcoin_core_rpc

        return await bitcoin_core_rpc.broadcast_raw_tx(raw_tx)
    if mode == "electrum":
        from . import bitcoin_electrum

        return await bitcoin_electrum.broadcast_raw_tx(raw_tx)

    from .bitcoin_psbt import broadcast_raw_tx_public

    return await broadcast_raw_tx_public(raw_tx)


def invalidate_backend_cache() -> None:
    from . import bitcoin_core_rpc

    bitcoin_core_rpc.invalidate_import_cache()


def _wallet_address_set(cfg: WalletConfig) -> set[str]:
    from .bitcoin_service import get_bitcoin_service

    svc = get_bitcoin_service()
    addrs = [a for _, a in svc.receive_addresses(cfg)] + [a for _, a in svc.change_addresses(cfg)]
    return set(addrs)


def _electrum_tx_to_esplora(txid: str, tx: dict, address: str) -> dict:
    vouts = []
    for idx, out in enumerate(tx.get("vout") or []):
        spk = out.get("scriptPubKey") or {}
        addr = spk.get("address") or ""
        value = out.get("value")
        if isinstance(value, float):
            value = int(round(value * 100_000_000))
        vouts.append(
            {
                "vout": idx,
                "scriptpubkey_address": addr,
                "value": int(value or 0),
            }
        )
    vins = []
    for vin in tx.get("vin") or []:
        prev = vin.get("txid")
        prevout = vin.get("vout")
        if prev is not None:
            vins.append({"txid": prev, "vout": prevout})
    status = tx.get("status") or {}
    block_time = int(
        status.get("block_time")
        or tx.get("blocktime")
        or tx.get("time")
        or 0
    )
    return {
        "txid": txid,
        "vout": vouts,
        "vin": vins,
        "status": {"block_time": block_time, "confirmed": bool(status.get("confirmed"))},
    }


def _core_tx_placeholder(txid: str, raw_hex: str) -> dict:
    return {"txid": txid, "hex": raw_hex}
