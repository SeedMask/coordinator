"""Kaspa KIP-39-style P2SH multisig helpers."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any


KASPA_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


@dataclass(frozen=True)
class MultisigCosigner:
    pubkey: str
    fingerprint: str = "00000000"
    derivation_path: str = ""
    label: str = ""


@dataclass(frozen=True)
class MultisigPolicy:
    threshold: int
    cosigners: list[MultisigCosigner]
    account: int = 0


def normalize_compressed_pubkey(pubkey: str) -> str:
    key = (pubkey or "").strip().lower()
    if key.startswith("0x"):
        key = key[2:]
    if len(key) == 64:
        key = "02" + key
    if len(key) != 66 or key[:2] not in ("02", "03"):
        raise ValueError("Expected compressed secp256k1 public key")
    bytes.fromhex(key)
    return key


def compressed_pubkey_to_xonly(pubkey: str) -> str:
    return normalize_compressed_pubkey(pubkey)[2:]


def normalize_multisig_policy(
    *,
    threshold: int,
    cosigners: list[dict[str, Any] | MultisigCosigner],
    account: int = 0,
) -> MultisigPolicy:
    m = int(threshold or 0)
    normalized: list[MultisigCosigner] = []
    for item in cosigners or []:
        if isinstance(item, MultisigCosigner):
            c = item
            pubkey = normalize_compressed_pubkey(c.pubkey)
            normalized.append(
                MultisigCosigner(
                    pubkey=pubkey,
                    fingerprint=(c.fingerprint or "00000000").strip().lower(),
                    derivation_path=(c.derivation_path or "").strip(),
                    label=(c.label or "").strip(),
                )
            )
            continue
        pubkey = normalize_compressed_pubkey(str(item.get("pubkey") or item.get("public_key") or ""))
        normalized.append(
            MultisigCosigner(
                pubkey=pubkey,
                fingerprint=str(item.get("fingerprint") or "00000000").strip().lower(),
                derivation_path=str(item.get("derivation_path") or item.get("derivation") or "").strip(),
                label=str(item.get("label") or "").strip(),
            )
        )
    if len(normalized) < 2:
        raise ValueError("Kaspa multisig needs at least two cosigners")
    if m < 1 or m > len(normalized):
        raise ValueError("Invalid multisig threshold")
    pubkeys = [c.pubkey for c in normalized]
    if len(set(pubkeys)) != len(pubkeys):
        raise ValueError(
            "Kaspa multisig cosigners must have unique public keys. "
            "Each cosigner needs its own BIP45 kpub (m/45'/111111'/N') — duplicate kpub/account?"
        )
    normalized.sort(key=lambda c: c.pubkey)
    return MultisigPolicy(threshold=m, cosigners=normalized, account=int(account or 0))


def _op_small_int(n: int) -> str:
    if not 1 <= int(n) <= 16:
        raise ValueError("Script small integer out of range")
    return f"{0x50 + int(n):02x}"


def _push_data_hex(data_hex: str) -> str:
    data = data_hex.strip().lower().replace("0x", "")
    n = len(data) // 2
    if len(data) % 2:
        raise ValueError("script push data must be whole bytes")
    if n < 0x4C:
        return f"{n:02x}{data}"
    if n <= 0xFF:
        return f"4c{n:02x}{data}"
    if n <= 0xFFFF:
        return f"4d{n & 0xFF:02x}{(n >> 8) & 0xFF:02x}{data}"
    raise ValueError("script push data too large")


def multisig_redeem_script_hex(policy: MultisigPolicy) -> str:
    p = normalize_multisig_policy(
        threshold=policy.threshold,
        cosigners=policy.cosigners,
        account=policy.account,
    )
    parts = [_op_small_int(p.threshold)]
    parts.extend(_push_data_hex(compressed_pubkey_to_xonly(c.pubkey)) for c in p.cosigners)
    parts.append(_op_small_int(len(p.cosigners)))
    parts.append("ae")  # OP_CHECKMULTISIG
    return "".join(parts)


def _blake2b_256(data: bytes) -> bytes:
    return hashlib.blake2b(data, digest_size=32).digest()


def multisig_p2sh_script_hex(redeem_script_hex: str) -> str:
    digest = _blake2b_256(bytes.fromhex(redeem_script_hex))
    return "aa20" + digest.hex() + "87"


def _convertbits(data: bytes | list[int], from_bits: int, to_bits: int, pad: bool) -> list[int]:
    acc = 0
    bits = 0
    ret: list[int] = []
    maxv = (1 << to_bits) - 1
    max_acc = (1 << (from_bits + to_bits - 1)) - 1
    for value in data:
        if value < 0 or value >> from_bits:
            raise ValueError("Invalid bech32 value")
        acc = ((acc << from_bits) | value) & max_acc
        bits += from_bits
        while bits >= to_bits:
            bits -= to_bits
            ret.append((acc >> bits) & maxv)
    if pad:
        if bits:
            ret.append((acc << (to_bits - bits)) & maxv)
    elif bits >= from_bits or ((acc << (to_bits - bits)) & maxv):
        raise ValueError("Invalid padding")
    return ret


def _polymod_step(c: int, v: int) -> int:
    c0 = c >> 35
    c = ((c & 0x07FFFFFFFF) << 5) ^ v
    if c0 & 0x01:
        c ^= 0x98F2BC8E61
    if c0 & 0x02:
        c ^= 0x79B76D99E2
    if c0 & 0x04:
        c ^= 0xF33E5FB3C4
    if c0 & 0x08:
        c ^= 0xAE2EABE2A8
    if c0 & 0x10:
        c ^= 0x1E4F43E470
    return c


def _kaspa_checksum(payload5: list[int], hrp: str = "kaspa") -> list[int]:
    c = 1
    for ch in hrp:
        c = _polymod_step(c, ord(ch) & 0x1F)
    c = _polymod_step(c, 0)
    for value in payload5:
        c = _polymod_step(c, value)
    for _ in range(8):
        c = _polymod_step(c, 0)
    c ^= 1
    return _convertbits(c.to_bytes(8, "big")[3:], 8, 5, True)


def _kaspa_address(version: int, payload32: bytes) -> str:
    payload5 = _convertbits(bytes([version]) + payload32, 8, 5, True)
    data = payload5 + _kaspa_checksum(payload5)
    return "kaspa:" + "".join(KASPA_CHARSET[i] for i in data)


def multisig_p2sh_address(policy: MultisigPolicy) -> str:
    redeem = multisig_redeem_script_hex(policy)
    digest = _blake2b_256(bytes.fromhex(redeem))
    return _kaspa_address(8, digest)


def _sig_push_hex(sig: bytes | str | dict[str, Any]) -> str:
    if isinstance(sig, dict):
        if "schnorr" in sig and isinstance(sig["schnorr"], list):
            raw = bytes(int(x) & 0xFF for x in sig["schnorr"])
        else:
            raw = bytes.fromhex(str(sig.get("signature") or sig.get("hex") or ""))
    elif isinstance(sig, bytes):
        raw = sig
    else:
        raw = bytes.fromhex(str(sig))
    if len(raw) == 65:
        raw = raw[:64]
    if len(raw) != 64:
        raise ValueError("Kaspa Schnorr signatures must be 64 bytes")
    return _push_data_hex(raw.hex() + "01")


def finalize_multisig_input_signature_script(
    policy: MultisigPolicy,
    partial_sigs: dict[str, Any],
) -> str:
    p = normalize_multisig_policy(
        threshold=policy.threshold,
        cosigners=policy.cosigners,
        account=policy.account,
    )
    by_pub = {normalize_compressed_pubkey(k): v for k, v in (partial_sigs or {}).items()}
    parts: list[str] = []
    for cosigner in p.cosigners:
        sig = by_pub.get(cosigner.pubkey)
        if sig is None:
            continue
        parts.append(_sig_push_hex(sig))
        if len(parts) >= p.threshold:
            break
    if len(parts) < p.threshold:
        raise ValueError(f"Partial Kaspa multisig signature saved ({len(parts)}/{p.threshold})")
    parts.append(_push_data_hex(multisig_redeem_script_hex(p)))
    return "".join(parts)


def build_multisig_pskt(
    *,
    policy: MultisigPolicy,
    prev_tx_id: str,
    prev_index: int,
    amount_sompi: int,
    send_sompi: int,
    to_script_hex: str,
) -> dict[str, Any]:
    p = normalize_multisig_policy(
        threshold=policy.threshold,
        cosigners=policy.cosigners,
        account=policy.account,
    )
    redeem = multisig_redeem_script_hex(p)
    p2sh_script = multisig_p2sh_script_hex(redeem)
    bip32 = {
        c.pubkey: {"keyFingerprint": c.fingerprint or "00000000", "derivationPath": c.derivation_path}
        for c in p.cosigners
    }
    return {
        "global": {
            "version": 1,
            "txVersion": 0,
            "inputCount": 1,
            "outputCount": 1,
            "inputsModifiable": False,
            "outputsModifiable": False,
            "fallbackLockTime": None,
            "xpubs": {},
            "id": None,
            "payload": "",
            "subnetworkId": None,
            "proprietaries": {},
        },
        "inputs": [
            {
                "utxoEntry": {
                    "amount": int(amount_sompi),
                    "scriptPublicKey": "0000" + p2sh_script,
                    "blockDaaScore": 0,
                    "isCoinbase": False,
                    "covenantId": None,
                },
                "previousOutpoint": {
                    "transactionId": prev_tx_id.strip().lower().removeprefix("0x"),
                    "index": int(prev_index),
                },
                "sequence": None,
                "partialSigs": {},
                "sighashType": 1,
                "sigOpCount": len(p.cosigners),
                "redeemScript": redeem,
                "finalScriptSig": None,
                "bip32Derivations": {
                    pub: dict(src) for pub, src in bip32.items()
                },
                "proprietaries": {},
            }
        ],
        "outputs": [
            {
                "amount": int(send_sompi),
                "scriptPublicKey": "0000" + to_script_hex.strip().lower().removeprefix("0x"),
                "redeemScript": None,
                "bip32Derivations": {},
                "proprietaries": {},
            }
        ],
    }


def finalize_multisig_pskt(policy: MultisigPolicy, pskt: dict[str, Any]) -> dict[str, Any]:
    inputs = pskt.get("inputs") or []
    for inp in inputs:
        inp.setdefault("redeemScript", multisig_redeem_script_hex(policy))
        sigs = inp.get("partialSigs") or {}
        inp["finalScriptSig"] = finalize_multisig_input_signature_script(policy, sigs)
    return pskt
