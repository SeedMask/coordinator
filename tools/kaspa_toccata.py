"""Kaspa Toccata (mainnet DAA 474165565) — shared field parsing and fee helpers."""

from __future__ import annotations

from typing import Any

STORAGE_MASS_LIMIT = 100_000
TOCCATA_FEE_SOMPI_PER_GRAM = 100
DEFAULT_TX_VERSION = 0
# Last-resort when the Kaspa SDK is unavailable (pre-Toccata legacy floor).
LEGACY_FALLBACK_RELAY_SOMPI = 10_000
TYPICAL_P2PK_RELAY_SOMPI = 203_600

_P2PK_PLACEHOLDER = "208325613d2eeaf7176ac6c670b13c0043156c427438ed72d74b7800862ad884e8ac"
_TEMPLATE_TXID = "880eb9819a31821d9d2399e2f35e2433b72637e393d71ecc9b8d0250f49153c3"


def normalize_covenant_id(value: Any) -> str | None:
    """Return lowercase 64-char hex covenant id, or None."""
    if value is None:
        return None
    if isinstance(value, dict):
        inner = value.get("hex") or value.get("hash") or value.get("inner")
        if inner is not None:
            return normalize_covenant_id(inner)
        return None
    raw = str(value).strip().lower()
    if raw.startswith("0x"):
        raw = raw[2:]
    if not raw or raw in {"null", "none"}:
        return None
    if len(raw) != 64:
        return None
    try:
        int(raw, 16)
    except ValueError:
        return None
    return raw


def covenant_binding_from_dict(raw: Any) -> dict[str, Any] | None:
    """Parse Toccata output covenant binding for SDK/RPC dicts."""
    if not isinstance(raw, dict):
        return None
    auth = raw.get("authorizingInput")
    if auth is None:
        auth = raw.get("authorizing_input")
    cid = normalize_covenant_id(raw.get("covenantId") or raw.get("covenant_id"))
    if auth is None or cid is None:
        return None
    return {"authorizingInput": int(auth), "covenantId": cid}


def tx_version_from_unsigned(unsigned: dict[str, Any]) -> int:
    return int(unsigned.get("tx_version", DEFAULT_TX_VERSION) or 0)


def input_commit_fields(tx_version: int, inp: dict[str, Any]) -> tuple[int, int]:
    """Return (sig_op_count, compute_budget) for the given tx version."""
    if int(tx_version) >= 1:
        budget = int(inp.get("compute_budget") or inp.get("computeBudget") or 0)
        return 0, max(0, budget)
    sig_ops = int(inp.get("sig_op_count") if inp.get("sig_op_count") is not None else 1)
    return max(0, sig_ops), 0


def _script_push_data_hex(data_hex: str) -> str:
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


def placeholder_signature_script_hex(inp: dict[str, Any]) -> str:
    """Approximate signed input script hex for relay-fee / mass quotes."""
    redeem = str(
        inp.get("redeem_script_hex") or inp.get("redeemScript") or ""
    ).strip().lower().replace("0x", "")
    if redeem:
        threshold = 2
        try:
            data = bytes.fromhex(redeem)
            if data and 0x51 <= data[0] <= 0x60:
                threshold = int(data[0]) - 0x50
        except Exception:
            threshold = int(inp.get("sig_op_count") or 2)
        threshold = max(1, min(threshold, 16))
        sig_hex = "00" * 64 + "01"
        parts = [_script_push_data_hex(sig_hex) for _ in range(threshold)]
        parts.append(_script_push_data_hex(redeem))
        return "".join(parts)
    return "00" * 64


def unsigned_for_mass_analysis(unsigned: dict[str, Any]) -> dict[str, Any]:
    """Return a copy with signed-size placeholder scripts for mass/fee analysis."""
    out = dict(unsigned)
    inputs = []
    for inp in unsigned.get("inputs") or []:
        if not isinstance(inp, dict):
            continue
        row = dict(inp)
        if not str(row.get("signature_script") or row.get("sig_hex") or "").strip():
            row["signature_script"] = placeholder_signature_script_hex(row)
        inputs.append(row)
    out["inputs"] = inputs
    return out


def utxo_entry_dict(
    *,
    txid: str,
    index: int,
    amount: int,
    script_version: int,
    script_hex: str,
    address: str | None = None,
    block_daa_score: int = 0,
    is_coinbase: bool = False,
    covenant_id: Any = None,
) -> dict[str, Any]:
    body = (script_hex or "").strip().lower()
    if body.startswith("0x"):
        body = body[2:]
    return {
        "address": address,
        "outpoint": {"transactionId": txid, "index": int(index)},
        "amount": int(amount),
        "scriptPublicKey": {"version": int(script_version), "script": list(bytes.fromhex(body))},
        "blockDaaScore": int(block_daa_score or 0),
        "isCoinbase": bool(is_coinbase),
        "covenantId": normalize_covenant_id(covenant_id),
    }


def utxo_entry_dict_from_input(inp: dict[str, Any]) -> dict[str, Any]:
    txid = str(inp.get("prev_tx_id") or "").strip().lower()
    if txid.startswith("0x"):
        txid = txid[2:]
    script_hex = (inp.get("utxo_script_hex") or "").strip()
    if script_hex.startswith("0x"):
        script_hex = script_hex[2:]
    return utxo_entry_dict(
        txid=txid,
        index=int(inp.get("prev_index", 0)),
        amount=int(inp.get("utxo_amount", 0)),
        script_version=int(inp.get("utxo_script_version", 0)),
        script_hex=script_hex,
        address=(inp.get("receive_address") or None),
        block_daa_score=int(inp.get("block_daa_score") or inp.get("blockDaaScore") or 0),
        is_coinbase=bool(inp.get("is_coinbase") or inp.get("isCoinbase") or False),
        covenant_id=inp.get("covenant_id") or inp.get("covenantId"),
    )


def utxo_entry_dict_from_wallet_utxo(utxo: Any, *, script_hex: str) -> dict[str, Any]:
    txid = str(getattr(utxo, "transaction_id", "") or "").strip().lower()
    if txid.startswith("0x"):
        txid = txid[2:]
    return utxo_entry_dict(
        txid=txid,
        index=int(getattr(utxo, "output_index", 0)),
        amount=int(getattr(utxo, "amount", 0)),
        script_version=0,
        script_hex=script_hex,
        address=getattr(utxo, "address", None),
        block_daa_score=int(getattr(utxo, "block_daa_score", 0) or 0),
        is_coinbase=bool(getattr(utxo, "is_coinbase", False)),
        covenant_id=getattr(utxo, "covenant_id", None),
    )


def _norm_script_hex(script_hex: str) -> str:
    h = (script_hex or "").strip().lower()
    if h.startswith("0x"):
        h = h[2:]
    if len(h) >= 72 and h[4:6] == "20" and h.endswith("ac"):
        body = h[4:]
        if len(body) == 68:
            return body
    if len(h) == 64 and not h.startswith("20"):
        return "20" + h + "ac"
    if len(h) == 68 and h.startswith("20") and h.endswith("ac"):
        return h
    raise ValueError(f"script_hex does not look like Schnorr P2PK ({len(h)} hex chars)")


def _spk_from_hex(script_hex: str, version: int = 0):
    from kaspa import ScriptPublicKey

    return ScriptPublicKey(int(version), bytes.fromhex(_norm_script_hex(script_hex)))


def _spk_for_address(addr: str):
    from kaspa import Address, pay_to_address_script

    a = (addr or "").strip()
    if not a.lower().startswith("kaspa:"):
        raise ValueError(f"invalid kaspa address {addr!r}")
    return pay_to_address_script(Address(a))


def input_spk(inp: dict[str, Any]):
    addr = (inp.get("receive_address") or "").strip()
    if addr:
        return _spk_for_address(addr)
    utxo_script = (inp.get("utxo_script_hex") or "").strip()
    if utxo_script.startswith("0x"):
        utxo_script = utxo_script[2:]
    if not utxo_script:
        raise ValueError("input missing receive_address and utxo_script_hex")
    return _spk_from_hex(utxo_script, int(inp.get("utxo_script_version", 0)))


def output_spk(out: dict[str, Any], default_receive: str = ""):
    addr = (out.get("kaspa_address") or out.get("to_address") or "").strip()
    if not addr and out.get("is_change") and default_receive:
        addr = default_receive.strip()
    if addr:
        return _spk_for_address(addr)
    return _spk_from_hex(out.get("script_hex", ""), int(out.get("script_version", 0)))


def _covenant_binding_obj(raw: Any):
    binding = covenant_binding_from_dict(raw)
    if not binding:
        return None
    from kaspa import CovenantBinding, Hash

    return CovenantBinding(int(binding["authorizingInput"]), Hash(str(binding["covenantId"])))


def _wrap_schnorr_signature_script(sig_hex: str) -> bytes:
    sig_hex = sig_hex.strip().lower()
    if len(sig_hex) == 128:
        return bytes.fromhex("41" + sig_hex + "01")
    if len(sig_hex) == 132 and sig_hex.startswith("41") and sig_hex.endswith("01"):
        return bytes.fromhex(sig_hex)
    raise ValueError(f"Unexpected signature length {len(sig_hex)} (want 128 or 132 hex chars)")


def build_transaction_input(inp: dict[str, Any], tx_version: int):
    from kaspa import Hash, TransactionInput, TransactionOutpoint, UtxoEntryReference

    txid = str(inp.get("prev_tx_id") or "").strip().lower()
    if txid.startswith("0x"):
        txid = txid[2:]
    index = int(inp.get("prev_index", 0))
    sig_op_count, compute_budget = input_commit_fields(tx_version, inp)
    ref = UtxoEntryReference.from_dict(utxo_entry_dict_from_input(inp))
    sig_script = inp.get("signature_script") or inp.get("sig_hex")
    if isinstance(sig_script, str) and sig_script.strip():
        if str(inp.get("redeem_script_hex") or "").strip():
            sig_bytes = bytes.fromhex(sig_script.strip().lower().replace("0x", ""))
        else:
            sig_bytes = _wrap_schnorr_signature_script(sig_script)
    else:
        sig_bytes = b""
    return TransactionInput(
        TransactionOutpoint(Hash(txid), index),
        sig_bytes,
        int(inp.get("sequence", 0)),
        sig_op_count,
        compute_budget,
        ref,
    )


def build_transaction_output(out: dict[str, Any], default_receive: str = ""):
    from kaspa import TransactionOutput

    val = int(out.get("value", 0))
    if val <= 0:
        raise ValueError("output value must be > 0")
    spk = output_spk(out, default_receive)
    covenant = _covenant_binding_obj(out.get("covenant"))
    if covenant is not None:
        return TransactionOutput(val, spk, covenant)
    return TransactionOutput(val, spk)


def unsigned_v2_to_transaction(unsigned: dict[str, Any]):
    """Build a Transaction for Toccata mass/fee validation (signed or unsigned)."""
    from kaspa import Transaction

    default_receive = ""
    for inp in unsigned.get("inputs") or []:
        ra = (inp.get("receive_address") or "").strip()
        if ra:
            default_receive = ra
            break

    tx_version = tx_version_from_unsigned(unsigned)
    inputs = [build_transaction_input(inp, tx_version) for inp in unsigned.get("inputs") or []]
    outputs = [
        build_transaction_output(out, default_receive) for out in unsigned.get("outputs") or []
    ]

    sub_hex = str(unsigned.get("subnetwork_id_hex", "0" * 40))
    if sub_hex.startswith("0x"):
        sub_hex = sub_hex[2:]
    payload_hex = unsigned.get("payload_hex", "") or ""
    if str(payload_hex).startswith("0x"):
        payload_hex = str(payload_hex)[2:]
    lock_time = int(unsigned.get("lock_time", 0))
    if lock_time > 1_000_000_000_000:
        lock_time = 0

    storage_mass = unsigned.get("storage_mass")
    if storage_mass is None:
        storage_mass = unsigned.get("mass")

    return Transaction(
        tx_version,
        inputs,
        outputs,
        lock_time,
        bytes.fromhex(sub_hex),
        int(unsigned.get("gas", 0)),
        bytes.fromhex(payload_hex) if payload_hex else b"",
        int(storage_mass or 0),
    )


def template_unsigned_v0(
    *,
    input_count: int = 1,
    output_count: int = 2,
    input_amount: int = 1_000_000,
    send_sompi: int | None = None,
) -> dict[str, Any]:
    """Minimal unsigned v2 skeleton for relay-fee estimation."""
    send = int(send_sompi or max(1, input_amount // 2))
    fee_reserve = max(LEGACY_FALLBACK_RELAY_SOMPI, min(input_amount // 20, 5_000_000))
    if output_count <= 1:
        out_vals = [max(1, input_amount - fee_reserve)]
    else:
        change = max(1, input_amount - send - fee_reserve)
        out_vals = [send, change]
    inputs = []
    for i in range(max(1, input_count)):
        inputs.append(
            {
                "prev_tx_id": _TEMPLATE_TXID,
                "prev_index": i,
                "sequence": 0,
                "sig_op_count": 1,
                "utxo_amount": int(input_amount),
                "utxo_script_version": 0,
                "utxo_script_hex": _P2PK_PLACEHOLDER,
                "block_daa_score": 1,
                "is_coinbase": False,
                "covenant_id": None,
            }
        )
    outputs = [
        {
            "value": int(v),
            "script_version": 0,
            "script_hex": _P2PK_PLACEHOLDER,
        }
        for v in out_vals
    ]
    return {
        "version": 2,
        "network": "mainnet",
        "account": 0,
        "tx_version": DEFAULT_TX_VERSION,
        "lock_time": 0,
        "gas": 0,
        "subnetwork_id_hex": "0" * 40,
        "payload_hex": "",
        "inputs": inputs,
        "outputs": outputs,
    }


def estimate_relay_fee_sompi(
    *,
    unsigned: dict[str, Any] | None = None,
    input_count: int = 1,
    output_count: int = 2,
    input_amount: int = 1_000_000,
    send_sompi: int | None = None,
) -> int:
    """Toccata minimum relay fee using the post-fork relay policy.

    Toccata relay policy is 100 sompi * max(compute grams, 2 * tx bytes).
    KIP-9 storage mass is a separate limit and must not be used as the fee mass.
    """
    _ = input_amount, send_sompi
    if unsigned:
        try:
            from kaspa_mass import analyze_unsigned

            rep = analyze_unsigned(unsigned)
            if rep.minimum_relay_fee is not None and int(rep.minimum_relay_fee) > 0:
                return int(rep.minimum_relay_fee)
        except ImportError:
            pass

    grams = estimate_relay_grams(unsigned=unsigned, input_count=input_count, output_count=output_count)
    return max(LEGACY_FALLBACK_RELAY_SOMPI, grams * TOCCATA_FEE_SOMPI_PER_GRAM)


def estimate_relay_grams(
    *,
    unsigned: dict[str, Any] | None = None,
    input_count: int = 1,
    output_count: int = 2,
) -> int:
    """Estimate post-Toccata relay grams: max(compute grams, 2 * tx bytes)."""
    if unsigned:
        inputs = list(unsigned.get("inputs") or [])
        outputs = list(unsigned.get("outputs") or [])
        input_count = max(1, len(inputs) or int(input_count))
        output_count = max(1, len(outputs) or int(output_count))
        tx_version = tx_version_from_unsigned(unsigned)
        sig_ops = 0
        compute_budget = 0
        for inp in inputs:
            sig, budget = input_commit_fields(tx_version, inp if isinstance(inp, dict) else {})
            sig_ops += sig
            compute_budget += budget
        output_script_bytes = 0
        for out in outputs:
            if not isinstance(out, dict):
                continue
            script_hex = str(out.get("script_hex") or out.get("scriptPublicKey") or "")
            if script_hex.startswith("0x"):
                script_hex = script_hex[2:]
            output_script_bytes += max(0, len(script_hex) // 2)
    else:
        sig_ops = max(1, int(input_count))
        compute_budget = 0
        output_script_bytes = max(1, int(output_count)) * 35

    tx_bytes = 16 + int(input_count) * 150 + int(output_count) * 43
    compute_grams = tx_bytes + output_script_bytes * 10 + sig_ops * 1_000 + compute_budget
    transient_grams = tx_bytes * 2
    return max(compute_grams, transient_grams)


def input_v2_fields_from_utxo(utxo: Any, *, script_hex: str) -> dict[str, Any]:
    """SeedMask unsigned JSON input row with Toccata metadata."""
    addr = str(getattr(utxo, "address", "") or "")
    chain = 1 if getattr(utxo, "is_change", False) else 0
    row: dict[str, Any] = {
        "prev_tx_id": str(getattr(utxo, "transaction_id", "")).lower().replace("0x", ""),
        "prev_index": int(getattr(utxo, "output_index", 0)),
        "sequence": 0,
        "sig_op_count": 1,
        "utxo_amount": int(getattr(utxo, "amount", 0)),
        "utxo_script_version": 0,
        "utxo_script_hex": script_hex,
        "sign_chain": chain,
        "sign_address_index": int(getattr(utxo, "address_index", 0)),
        "receive_address": addr,
        "block_daa_score": int(getattr(utxo, "block_daa_score", 0) or 0),
        "is_coinbase": bool(getattr(utxo, "is_coinbase", False)),
    }
    cid = normalize_covenant_id(getattr(utxo, "covenant_id", None))
    if cid:
        row["covenant_id"] = cid
    return row
