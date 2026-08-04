"""Private Electrum server protocol (electrs / Fulcrum compatible)."""

from __future__ import annotations

import asyncio
import hashlib
import json
import ssl
from typing import Any

from embit import script
from embit.networks import NETWORKS

from .wallet_store import WalletConfig

_NETWORK = NETWORKS["main"]
_REQ_ID = 0
_REQ_LOCK = asyncio.Lock()


def _settings():
    from .network_settings import load_bitcoin_settings

    return load_bitcoin_settings()


def _address_scripthash(address: str) -> str:
    spk = script.address_to_scriptpubkey(address)
    return hashlib.sha256(spk.data).digest()[::-1].hex()


async def _next_id() -> int:
    global _REQ_ID
    async with _REQ_LOCK:
        _REQ_ID += 1
        return _REQ_ID


async def _rpc(method: str, params: list) -> Any:
    s = _settings()
    host = (s.electrum_host or "127.0.0.1").strip()
    port = int(s.electrum_port or (50002 if s.electrum_use_ssl else 50001))
    ssl_ctx = ssl.create_default_context() if s.electrum_use_ssl else None
    if ssl_ctx is not None:
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(host, port, ssl=ssl_ctx),
        timeout=12.0,
    )
    try:
        req_id = await _next_id()
        payload = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        writer.write((payload + "\n").encode())
        await writer.drain()
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=20.0)
            if not line:
                raise RuntimeError("Electrum server closed the connection")
            data = json.loads(line.decode())
            if data.get("id") != req_id:
                continue
            if data.get("error"):
                err = data["error"]
                raise RuntimeError(err.get("message") or str(err))
            return data.get("result")
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass


async def test_connection() -> dict[str, Any]:
    steps: list[str] = []
    s = _settings()
    proto = "ssl" if s.electrum_use_ssl else "tcp"
    steps.append(f"Connecting to {proto}://{s.electrum_host}:{int(s.electrum_port)}")
    version = await _rpc("server.version", ["SeedMask Coordinator", "1.4"])
    if isinstance(version, list) and version:
        steps.append(f"Server version: {version[0]}")
    else:
        steps.append(f"Server version: {version}")
    await _rpc("server.ping", [])
    steps.append("Ping OK")
    return {
        "ok": True,
        "mode": "electrum",
        "summary": steps[-1],
        "steps": steps,
    }


async def fetch_address_utxos(address: str, cfg: WalletConfig | None = None) -> list[dict]:
    sh = _address_scripthash(address)
    rows = await _rpc("blockchain.scripthash.listunspent", [sh])
    if not isinstance(rows, list):
        return []
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
    return out


async def fetch_address_history(address: str) -> list[dict]:
    sh = _address_scripthash(address)
    rows = await _rpc("blockchain.scripthash.get_history", [sh])
    return rows if isinstance(rows, list) else []


async def get_transaction_verbose(txid: str) -> dict:
    raw = await _rpc("blockchain.transaction.get", [txid, True])
    if isinstance(raw, str):
        return {"hex": raw}
    return raw if isinstance(raw, dict) else {}


async def estimate_fee_sat_vb(blocks: int = 6) -> float:
    try:
        btc_per_kb = await _rpc("blockchain.estimatefee", [blocks])
        if btc_per_kb is None or float(btc_per_kb) <= 0:
            return 1.0
        return max(0.1, round(float(btc_per_kb) * 100_000, 3))
    except Exception:
        return 1.0


async def broadcast_raw_tx(raw_tx: bytes) -> str:
    tx_hex = raw_tx.hex()
    txid = await _rpc("blockchain.transaction.broadcast", [tx_hex])
    return str(txid).lower()
