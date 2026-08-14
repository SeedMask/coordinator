"""Kaspa tx v0 Schnorr sighash (matches rusty-kaspa / seedmask_kaspa_sighash.c)."""

from __future__ import annotations

import struct
from hashlib import blake2b
from typing import Any

KEY = b"TransactionSigningHash"


def _h_new():
    return blake2b(digest_size=32, key=KEY)


def _w_u8(h, v):
    h.update(bytes([v]))


def _w_u16(h, v):
    h.update(struct.pack("<H", v))


def _w_u32(h, v):
    h.update(struct.pack("<I", v))


def _w_u64(h, v):
    h.update(struct.pack("<Q", v))


def _w_bytes(h, b):
    h.update(b)


def _w_var(h, b):
    _w_u64(h, len(b))
    if b:
        h.update(b)


def _finalize(h) -> bytes:
    return h.digest()


def _hash_prev_outputs(inputs: list[dict[str, Any]]) -> bytes:
    h = _h_new()
    for inp in inputs:
        txid = str(inp.get("prev_tx_id") or "").strip().lower().replace("0x", "")
        _w_bytes(h, bytes.fromhex(txid))
        _w_u32(h, int(inp.get("prev_index", 0)))
    return _finalize(h)


def _hash_sequences(inputs: list[dict[str, Any]]) -> bytes:
    h = _h_new()
    for inp in inputs:
        _w_u64(h, int(inp.get("sequence", 0)))
    return _finalize(h)


def _hash_sigops(inputs: list[dict[str, Any]]) -> bytes:
    h = _h_new()
    for inp in inputs:
        _w_u8(h, int(inp.get("sig_op_count", 0)))
    return _finalize(h)


def _hash_outputs_v0(outputs: list[dict[str, Any]]) -> bytes:
    h = _h_new()
    for out in outputs:
        _w_u64(h, int(out.get("value", 0)))
        _w_u16(h, int(out.get("script_version", 0)))
        script = str(out.get("script_hex") or "").strip().lower().replace("0x", "")
        _w_var(h, bytes.fromhex(script))
    return _finalize(h)


def _hash_payload(unsigned: dict[str, Any]) -> bytes:
    sub = str(unsigned.get("subnetwork_id_hex") or "0" * 40).strip().lower().replace("0x", "")
    payload = str(unsigned.get("payload_hex") or "").strip().lower().replace("0x", "")
    if all(c == "0" for c in sub) and not payload:
        return bytes(32)
    h = _h_new()
    _w_var(h, bytes.fromhex(payload) if payload else b"")
    return _finalize(h)


def calc_schnorr_sighash_v0(
    unsigned: dict[str, Any],
    input_index: int = 0,
    *,
    utxo_script_hex: str | None = None,
    sig_op_count: int | None = None,
) -> bytes:
    """Return 32-byte digest for SIGHASH_ALL on a coordinator unsigned v2 dict."""
    inputs = list(unsigned.get("inputs") or [])
    outputs = list(unsigned.get("outputs") or [])
    if input_index < 0 or input_index >= len(inputs):
        raise ValueError(f"input_index {input_index} out of range")
    inp = inputs[input_index]
    script_hex = utxo_script_hex
    if script_hex is None:
        script_hex = str(inp.get("utxo_script_hex") or "").strip().lower().replace("0x", "")
    sop = int(sig_op_count if sig_op_count is not None else inp.get("sig_op_count", 0))

    h = _h_new()
    _w_u16(h, int(unsigned.get("tx_version", 0)))
    _w_bytes(h, _hash_prev_outputs(inputs))
    _w_bytes(h, _hash_sequences(inputs))
    _w_bytes(h, _hash_sigops(inputs))
    _w_bytes(h, bytes.fromhex(str(inp.get("prev_tx_id") or "").strip().lower().replace("0x", "")))
    _w_u32(h, int(inp.get("prev_index", 0)))
    _w_u16(h, int(inp.get("utxo_script_version", 0)))
    _w_var(h, bytes.fromhex(script_hex))
    _w_u64(h, int(inp.get("utxo_amount", 0)))
    _w_u64(h, int(inp.get("sequence", 0)))
    _w_u8(h, sop)
    _w_bytes(h, _hash_outputs_v0(outputs))
    _w_u64(h, int(unsigned.get("lock_time", 0)))
    sub = str(unsigned.get("subnetwork_id_hex") or "0" * 40).strip().lower().replace("0x", "")
    _w_bytes(h, bytes.fromhex(sub.zfill(40)[-40:]))
    _w_u64(h, int(unsigned.get("gas", 0)))
    _w_bytes(h, _hash_payload(unsigned))
    _w_u8(h, 1)
    return _finalize(h)


def device_unsigned_view(unsigned: dict[str, Any]) -> dict[str, Any]:
    """Match Coordinator Review QR fields (what SeedMask parses for sighash)."""
    import copy

    u = copy.deepcopy(unsigned)
    u.pop("draft_hash", None)
    u.pop("kpub", None)
    u.pop("xpub", None)
    if not (u.get("payload_hex") or "").strip():
        u.pop("payload_hex", None)
    for inp in u.get("inputs") or []:
        if isinstance(inp, dict):
            inp.pop("receive_address", None)
            inp.pop("block_daa_score", None)
            inp.pop("blockDaaScore", None)
            inp.pop("is_coinbase", None)
            inp.pop("isCoinbase", None)
    for out in u.get("outputs") or []:
        if isinstance(out, dict):
            out.pop("kaspa_address", None)
    return u
