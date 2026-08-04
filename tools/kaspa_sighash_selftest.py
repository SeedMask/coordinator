#!/usr/bin/env python3
"""Verify native-all-0 sighash matches rusty-kaspa test vector."""

from __future__ import annotations

import struct
from hashlib import blake2b

KEY = b"TransactionSigningHash"


def h_new():
    return blake2b(digest_size=32, key=KEY)


def w_u8(h, v):
    h.update(bytes([v]))


def w_u16(h, v):
    h.update(struct.pack("<H", v))


def w_u32(h, v):
    h.update(struct.pack("<I", v))


def w_u64(h, v):
    h.update(struct.pack("<Q", v))


def w_bytes(h, b):
    h.update(b)


def w_var(h, b):
    w_u64(h, len(b))
    if b:
        h.update(b)


def finalize(h):
    return h.hexdigest()


def hash_prev_outputs(inputs):
    h = h_new()
    for inp in inputs:
        w_bytes(h, inp["prev_tx_id"])
        w_u32(h, inp["prev_index"])
    return finalize(h)


def hash_sequences(inputs):
    h = h_new()
    for inp in inputs:
        w_u64(h, inp["sequence"])
    return finalize(h)


def hash_sigops(inputs):
    h = h_new()
    for inp in inputs:
        w_u8(h, inp["sig_op_count"])
    return finalize(h)


def hash_outputs(outputs):
    h = h_new()
    for o in outputs:
        w_u64(h, o["value"])
        w_u16(h, o["script_version"])
        w_var(h, o["script"])
    return finalize(h)


def hash_payload(payload: bytes, subnetwork: bytes) -> str:
    if all(x == 0 for x in subnetwork) and not payload:
        return "0" * 64
    h = h_new()
    w_var(h, payload)
    return finalize(h)


def sighash_all(tx, inputs, outputs, input_index: int) -> str:
    inp = inputs[input_index]
    h = h_new()
    w_u16(h, tx["version"])
    w_bytes(h, bytes.fromhex(hash_prev_outputs(inputs)))
    w_bytes(h, bytes.fromhex(hash_sequences(inputs)))
    w_bytes(h, bytes.fromhex(hash_sigops(inputs)))
    w_bytes(h, inp["prev_tx_id"])
    w_u32(h, inp["prev_index"])
    w_u16(h, inp["utxo_script_version"])
    w_var(h, inp["utxo_script"])
    w_u64(h, inp["utxo_amount"])
    w_u64(h, inp["sequence"])
    w_u8(h, inp["sig_op_count"])
    w_bytes(h, bytes.fromhex(hash_outputs(outputs)))
    w_u64(h, tx["lock_time"])
    w_bytes(h, tx["subnetwork_id"])
    w_u64(h, tx["gas"])
    w_bytes(h, bytes.fromhex(hash_payload(tx["payload"], tx["subnetwork_id"])))
    w_u8(h, 1)
    return finalize(h)


def main() -> int:
    prev = bytes.fromhex("880eb9819a31821d9d2399e2f35e2433b72637e393d71ecc9b8d0250f49153c3")
    spk1 = bytes.fromhex("208325613d2eeaf7176ac6c670b13c0043156c427438ed72d74b7800862ad884e8ac")
    spk2 = bytes.fromhex("20fcef4c106cf11135bbd70f02a726a92162d2fb8b22f0469126f800862ad884e8ac")
    inputs = [
        {"prev_tx_id": prev, "prev_index": 0, "sequence": 0, "sig_op_count": 0, "utxo_amount": 100, "utxo_script_version": 0, "utxo_script": spk1},
        {"prev_tx_id": prev, "prev_index": 1, "sequence": 1, "sig_op_count": 0, "utxo_amount": 200, "utxo_script_version": 0, "utxo_script": spk2},
        {"prev_tx_id": prev, "prev_index": 2, "sequence": 2, "sig_op_count": 0, "utxo_amount": 300, "utxo_script_version": 0, "utxo_script": spk2},
    ]
    outputs = [
        {"value": 300, "script_version": 0, "script": spk2},
        {"value": 300, "script_version": 0, "script": spk1},
    ]
    tx = {"version": 0, "lock_time": 1615462089000, "subnetwork_id": bytes(20), "gas": 0, "payload": b""}
    got = sighash_all(tx, inputs, outputs, 0)
    want = "03b7ac6927b2b67100734c3cc313ff8c2e8b3ce3e746d46dd660b706a916b1f5"
    print("got ", got)
    print("want", want)
    return 0 if got == want else 1


if __name__ == "__main__":
    raise SystemExit(main())
