"""Bitcoin Core JSON-RPC backend (watch-only descriptors, Sparrow-style)."""

from __future__ import annotations

import asyncio
import base64
from pathlib import Path
from typing import Any

import httpx

from .descriptor_wallet import descsum_create, export_descriptor_chain
from .wallet_store import WalletConfig

_RPC_TIMEOUT = httpx.Timeout(45.0, connect=6.0)
_imported_wallets: set[str] = set()
_import_lock = asyncio.Lock()


def _settings():
    from .network_settings import load_bitcoin_settings

    return load_bitcoin_settings()


def _rpc_url() -> str:
    s = _settings()
    scheme = "https" if s.core_use_ssl else "http"
    return f"{scheme}://{s.core_host}:{int(s.core_port)}"


def _auth_header() -> dict[str, str]:
    s = _settings()
    cookie_path = (s.core_cookie_path or "").strip()
    if cookie_path:
        path = Path(cookie_path).expanduser()
        if path.is_dir():
            path = path / ".cookie"
        if path.is_file():
            user, _, password = path.read_text(encoding="utf-8").strip().partition(":")
            token = base64.b64encode(f"{user}:{password}".encode()).decode()
            return {"Authorization": f"Basic {token}"}
    user = (s.core_user or "").strip()
    password = s.core_password or ""
    if user:
        token = base64.b64encode(f"{user}:{password}".encode()).decode()
        return {"Authorization": f"Basic {token}"}
    return {}


async def rpc_call(method: str, params: list | None = None) -> Any:
    payload = {
        "jsonrpc": "1.0",
        "id": "seedmask",
        "method": method,
        "params": params or [],
    }
    headers = {"Content-Type": "application/json", **_auth_header()}
    async with httpx.AsyncClient(timeout=_RPC_TIMEOUT, verify=False) as client:
        resp = await client.post(_rpc_url(), json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    if data.get("error"):
        err = data["error"]
        raise RuntimeError(err.get("message") or str(err))
    return data.get("result")


async def test_connection() -> dict[str, Any]:
    steps: list[str] = []
    info = await rpc_call("getblockchaininfo")
    chain = str(info.get("chain") or "")
    blocks = int(info.get("blocks") or 0)
    steps.append(f"Connected to Bitcoin Core ({chain}, block {blocks:,})")
    if chain and chain != "main":
        raise RuntimeError(f"Expected mainnet, got {chain!r}")
    ver = await rpc_call("getnetworkinfo")
    subver = str(ver.get("subversion") or "")
    steps.append(f"Node version: {subver.strip() or 'unknown'}")
    steps.append(f"RPC endpoint: {_rpc_url()}")
    return {
        "ok": True,
        "mode": "bitcoin_core",
        "summary": steps[0],
        "steps": steps,
    }


async def ensure_wallet_descriptors(cfg: WalletConfig) -> None:
    wallet_key = cfg.id or cfg.kpub
    if wallet_key in _imported_wallets:
        return
    async with _import_lock:
        if wallet_key in _imported_wallets:
            return
        scan_limit = max(1, int(cfg.scan_limit or 30))
        receive_desc = export_descriptor_chain(cfg, 0)
        change_desc = export_descriptor_chain(cfg, 1)
        requests = [
            {
                "desc": receive_desc,
                "active": True,
                "range": [0, scan_limit],
                "next_index": 0,
                "timestamp": "now",
                "internal": False,
            },
            {
                "desc": change_desc,
                "active": True,
                "range": [0, scan_limit],
                "next_index": 0,
                "timestamp": "now",
                "internal": True,
            },
        ]
        result = await rpc_call("importdescriptors", [requests])
        if not isinstance(result, list):
            raise RuntimeError("importdescriptors returned unexpected response")
        errors = [r for r in result if not r.get("success")]
        if errors:
            msg = errors[0].get("error", {}).get("message") or str(errors[0])
            raise RuntimeError(f"Could not import watch-only descriptors: {msg}")
        _imported_wallets.add(wallet_key)


async def list_unspent() -> list[dict]:
    rows = await rpc_call("listunspent", [0, 9999999, [], True, {"minimumAmount": 0}])
    return rows if isinstance(rows, list) else []


async def fetch_address_utxos(address: str, cfg: WalletConfig | None = None) -> list[dict]:
    if cfg is not None:
        await ensure_wallet_descriptors(cfg)
        utxos = await list_unspent()
        return [u for u in utxos if str(u.get("address") or "") == address]
    return []


async def list_transactions(count: int = 500) -> list[dict]:
    rows = await rpc_call("listtransactions", ["*", count, 0, True])
    return rows if isinstance(rows, list) else []


async def fetch_wallet_utxos(cfg: WalletConfig) -> list[dict]:
    await ensure_wallet_descriptors(cfg)
    return await list_unspent()


async def fetch_wallet_transactions(cfg: WalletConfig, wallet_addrs: set[str]) -> list[dict]:
    """Return Esplora-shaped tx dicts built from Core wallet history."""
    await ensure_wallet_descriptors(cfg)
    rows = await list_transactions(1000)
    grouped: dict[str, dict] = {}
    for row in rows:
        addr = str(row.get("address") or "")
        if addr not in wallet_addrs:
            continue
        txid = str(row.get("txid") or "").lower()
        if not txid:
            continue
        amount_btc = float(row.get("amount") or 0.0)
        amount_sats = int(round(abs(amount_btc) * 100_000_000))
        category = str(row.get("category") or "")
        block_time = int(row.get("blocktime") or row.get("time") or 0)
        tx = grouped.setdefault(
            txid,
            {
                "txid": txid,
                "vout": [],
                "vin": [],
                "status": {"block_time": block_time, "confirmed": block_time > 0},
            },
        )
        if category in {"receive", "immature", "generate"}:
            tx["vout"].append(
                {"scriptpubkey_address": addr, "value": amount_sats}
            )
        elif category in {"send", "move"}:
            tx["vin"].append(
                {"prevout": {"scriptpubkey_address": addr, "value": amount_sats}}
            )
            if row.get("address") and category == "send":
                fee = row.get("fee")
                if fee is not None:
                    tx.setdefault("fee", int(round(abs(float(fee)) * 100_000_000)))
    return list(grouped.values())


async def get_raw_transaction_hex(txid: str) -> str:
    return str(await rpc_call("getrawtransaction", [txid, False]))


async def estimatesmartfee_sat_vb(blocks: int = 6) -> float:
    result = await rpc_call("estimatesmartfee", [blocks])
    if not isinstance(result, dict):
        return 1.0
    rate_btc_kb = result.get("feerate")
    if rate_btc_kb is None:
        return 1.0
    # BTC/kvB → sat/vB
    return max(0.1, round(float(rate_btc_kb) * 100_000, 3))


async def broadcast_raw_tx(raw_tx: bytes) -> str:
    tx_hex = raw_tx.hex()
    txid = await rpc_call("sendrawtransaction", [tx_hex])
    return str(txid).lower()


def invalidate_import_cache() -> None:
    _imported_wallets.clear()
