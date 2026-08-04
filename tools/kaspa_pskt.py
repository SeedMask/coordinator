"""Kaspa PSKT — rusty-kaspa compatible (kaspa-wallet-pskt serde JSON).

Serializes as PSKT + hex(json). SeedMask still signs coordinator JSON v2.
"""

from __future__ import annotations

import copy
import json
import re
from typing import Any

from kaspa_coordinator_qr import build_unsigned_v2, kaspa_address_to_script_hex, normalize_kaspa_address

KASPA_COIN_TYPE = 111111
PSKT_PREFIX = "PSKT"
PSKB_PREFIX = "PSKB"
DRAFT_FORMAT = "seedpass_pskt_draft_v1"
PSKT_VERSION_ONE = 1
SIG_HASH_ALL = 1
DEFAULT_TX_VERSION = 0
DEFAULT_NETWORK = "mainnet"


def _hex_script_body(script_hex: str) -> str:
    h = script_hex.strip().lower()
    if h.startswith("0x"):
        h = h[2:]
    if len(h) >= 72 and h[4:6] == "20" and h.endswith("ac"):
        return h[4:68] if len(h) >= 68 else h[4:]
    if len(h) == 64 and not h.startswith("20"):
        return "20" + h + "ac"
    return h


def _spk_wire_hex(version: int, script_hex: str) -> str:
    """rusty-kaspa ScriptPublicKey JSON: 2-byte BE version hex + script bytes hex."""
    body = _hex_script_body(script_hex)
    return f"{int(version):04x}{body}"


def _parse_spk_wire(spk: Any) -> tuple[int, str]:
    """Accept rusty hex string or legacy {version, script[]} objects."""
    if isinstance(spk, str):
        wire = spk.strip().lower()
        if len(wire) < 4:
            raise ValueError("scriptPublicKey hex too short")
        version = int(wire[:4], 16)
        return version, _hex_script_body(wire[4:])
    if isinstance(spk, dict):
        version = int(spk.get("version", 0))
        script = spk.get("script")
        if isinstance(script, list):
            body = bytes(script).hex()
        else:
            body = str(script or "")
        return version, _hex_script_body(body)
    raise ValueError("unsupported scriptPublicKey encoding")


def _norm_txid(txid: str) -> str:
    t = txid.strip().lower()
    return t[2:] if t.startswith("0x") else t


def _account_derivation_path(account: int) -> str:
    return f"m/44'/{KASPA_COIN_TYPE}'/{int(account)}'"


def _leaf_derivation_path(account: int, chain: int, index: int) -> str:
    return f"{_account_derivation_path(account)}/{int(chain)}/{int(index)}"


def _fingerprint_hex(fingerprint: str) -> str:
    """8-char master fingerprint hex for rusty-kaspa PSKT KeySource (WASM serde)."""
    fp = re.sub(r"[^0-9a-fA-F]", "", fingerprint or "")
    if len(fp) != 8:
        return "00000000"
    return fp.lower()


def _key_source(fingerprint: str, derivation_path: str) -> dict[str, Any]:
    return {
        "keyFingerprint": _fingerprint_hex(fingerprint),
        "derivationPath": derivation_path,
    }


def _normalize_key_source(src: Any) -> dict[str, Any]:
    if not isinstance(src, dict):
        return {}
    out = dict(src)
    kf = out.get("keyFingerprint")
    if isinstance(kf, list):
        try:
            out["keyFingerprint"] = bytes(int(x) & 0xFF for x in kf).hex()
        except (TypeError, ValueError):
            out["keyFingerprint"] = "00000000"
    elif isinstance(kf, str):
        out["keyFingerprint"] = _fingerprint_hex(kf)
    return out


def normalize_pskt_inner(pskt: dict[str, Any]) -> dict[str, Any]:
    """Ensure optional fields match kaspa-wallet-pskt / WASM serde (nulls, empty maps)."""
    out = copy.deepcopy(pskt)
    g = out.setdefault("global", {})
    g.setdefault("fallbackLockTime", None)
    g.setdefault("xpubs", {})
    g.setdefault("id", None)
    if "payload" not in g:
        g["payload"] = ""
    g.setdefault("proprietaries", {})
    xpubs = g.get("xpubs")
    if isinstance(xpubs, dict):
        g["xpubs"] = {k: _normalize_key_source(v) for k, v in xpubs.items()}
    for inp in out.get("inputs") or []:
        inp.setdefault("minTime", None)
        inp.setdefault("redeemScript", None)
        inp.setdefault("finalScriptSig", None)
        inp.setdefault("partialSigs", {})
        inp.setdefault("bip32Derivations", {})
        inp.setdefault("proprietaries", {})
        derivs = inp.get("bip32Derivations")
        if isinstance(derivs, dict):
            inp["bip32Derivations"] = {k: _normalize_key_source(v) for k, v in derivs.items()}
    for o in out.get("outputs") or []:
        o.setdefault("redeemScript", None)
        o.setdefault("bip32Derivations", {})
        o.setdefault("proprietaries", {})
        derivs = o.get("bip32Derivations")
        if isinstance(derivs, dict):
            o["bip32Derivations"] = {k: _normalize_key_source(v) for k, v in derivs.items()}
    return out


def _parse_derivation_path(path: str) -> tuple[int | None, int | None, int | None]:
    """Return (account, chain, index) from m/44'/111111'/N'/C/I."""
    parts = (path or "").strip().split("/")
    if not parts or parts[0] != "m":
        return None, None, None
    account = chain = index = None
    for i, part in enumerate(parts):
        if part.endswith("'") and part[:-1].isdigit():
            num = int(part[:-1])
            if i >= 3 and account is None and num == KASPA_COIN_TYPE:
                continue
            if account is None and i >= 3:
                account = num
        elif part.isdigit():
            if chain is None:
                chain = int(part)
            elif index is None:
                index = int(part)
    return account, chain, index


def _signing_pubkey_hex(kpub: str, sign_chain: int, sign_index: int) -> str | None:
    """Compressed secp pubkey hex for PSKT bip32Derivations / partialSigs keys."""
    key = (kpub or "").strip()
    if not key:
        return None
    try:
        from kaspa import PublicKeyGenerator

        gen = PublicKeyGenerator.from_xpub(key)
        pk = gen.change_pubkey(int(sign_index)) if int(sign_chain) else gen.receive_pubkey(int(sign_index))
        return pk.to_string().strip().lower()
    except Exception:
        return None


def _address_for_signing(kpub: str, sign_chain: int, sign_index: int) -> str:
    key = (kpub or "").strip()
    if not key:
        return ""
    try:
        from kaspa import NetworkType, PublicKeyGenerator

        gen = PublicKeyGenerator.from_xpub(key)
        pk = gen.change_pubkey(int(sign_index)) if int(sign_chain) else gen.receive_pubkey(int(sign_index))
        return str(pk.to_address(NetworkType.Mainnet))
    except Exception:
        return ""


def _legacy_seedpass_props(pskt: dict[str, Any]) -> dict[str, str]:
    g = pskt.get("global") or {}
    out = {str(k): str(v) for k, v in (g.get("proprietaries") or {}).items() if str(k).startswith("seedpass/")}
    if pskt.get("inputs"):
        ip = (pskt["inputs"][0].get("proprietaries") or {})
        out.update({str(k): str(v) for k, v in ip.items() if str(k).startswith("seedpass/")})
    return out


def _kpub_from_pskt(pskt: dict[str, Any], kpub: str = "") -> str:
    kp = (kpub or "").strip()
    if kp:
        return kp
    xpubs = (pskt.get("global") or {}).get("xpubs") or {}
    if isinstance(xpubs, dict) and xpubs:
        return next(iter(xpubs.keys())).strip()
    legacy = _legacy_seedpass_props(pskt)
    return (legacy.get("seedpass/kpub") or "").strip()


def _account_from_pskt(pskt: dict[str, Any], account: int | None = None) -> int:
    if account is not None:
        return int(account)
    xpubs = (pskt.get("global") or {}).get("xpubs") or {}
    if isinstance(xpubs, dict):
        for _xpub, src in xpubs.items():
            if isinstance(src, dict):
                acct, _, _ = _parse_derivation_path(str(src.get("derivationPath", "")))
                if acct is not None:
                    return acct
    legacy = _legacy_seedpass_props(pskt)
    try:
        return int(legacy.get("seedpass/account", 0))
    except (TypeError, ValueError):
        return 0


def _sign_path_from_input(inp: dict[str, Any], account: int) -> tuple[int, int]:
    derivs = inp.get("bip32Derivations") or {}
    if isinstance(derivs, dict):
        for _pk, src in derivs.items():
            if isinstance(src, dict):
                _, chain, index = _parse_derivation_path(str(src.get("derivationPath", "")))
                if chain is not None and index is not None:
                    return int(chain), int(index)
    legacy = {str(k): str(v) for k, v in (inp.get("proprietaries") or {}).items()}
    if legacy.get("seedpass/signChain") is not None:
        return int(legacy.get("seedpass/signChain", 0)), int(legacy.get("seedpass/signAddressIndex", 0))
    return 0, 0


def build_pskt_for_send(
    *,
    prev_tx_id: str,
    prev_index: int,
    amount_sompi: int,
    send_sompi: int,
    receive_address: str,
    to_address: str,
    account: int = 0,
    sign_index: int = 0,
    sign_chain: int = 0,
    kpub: str = "",
    fingerprint: str = "",
    change_to_receive: bool = False,
    block_daa_score: int = 0,
) -> dict[str, Any]:
    """Build unsigned PSKT matching kaspa-wallet-pskt JSON (Signer-ready)."""
    receive = normalize_kaspa_address(receive_address)
    to_addr = normalize_kaspa_address(to_address)
    in_script_hex = kaspa_address_to_script_hex(receive)
    out_script_hex = kaspa_address_to_script_hex(to_addr)
    fee = max(0, int(amount_sompi) - int(send_sompi))

    outputs: list[dict[str, Any]] = [
        {
            "amount": int(send_sompi),
            "scriptPublicKey": _spk_wire_hex(0, out_script_hex),
            "bip32Derivations": {},
            "proprietaries": {},
        }
    ]
    if fee > 0 and change_to_receive:
        outputs.append(
            {
                "amount": fee,
                "scriptPublicKey": _spk_wire_hex(0, in_script_hex),
                "bip32Derivations": {},
                "proprietaries": {},
            }
        )

    leaf_path = _leaf_derivation_path(account, sign_chain, sign_index)
    bip32: dict[str, Any] = {}
    xpubs: dict[str, Any] = {}
    if kpub.strip():
        fp = (fingerprint or "").strip() or "00000000"
        pubkey_hex = _signing_pubkey_hex(kpub, sign_chain, sign_index)
        if pubkey_hex:
            bip32[pubkey_hex] = _key_source(fp, leaf_path)
        xpubs[kpub.strip()] = _key_source(fp, _account_derivation_path(account))

    inp: dict[str, Any] = {
        "utxoEntry": {
            "amount": int(amount_sompi),
            "scriptPublicKey": _spk_wire_hex(0, in_script_hex),
            "blockDaaScore": int(block_daa_score),
            "isCoinbase": False,
            "covenantId": None,
        },
        "previousOutpoint": {
            "transactionId": _norm_txid(prev_tx_id),
            "index": int(prev_index),
        },
        "sequence": None,
        "partialSigs": {},
        "sighashType": SIG_HASH_ALL,
        "sigOpCount": 1,
        "bip32Derivations": bip32,
        "proprietaries": {},
    }

    global_map: dict[str, Any] = {
        "version": PSKT_VERSION_ONE,
        "txVersion": DEFAULT_TX_VERSION,
        "inputCount": 1,
        "outputCount": len(outputs),
        "inputsModifiable": False,
        "outputsModifiable": False,
        "xpubs": xpubs,
        "proprietaries": {},
    }

    return normalize_pskt_inner(
        {
            "global": global_map,
            "inputs": [inp],
            "outputs": outputs,
        }
    )


def pskt_to_hex(pskt: dict[str, Any]) -> str:
    body = normalize_pskt_inner(pskt)
    payload = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return PSKT_PREFIX + payload.hex()


def pskt_from_hex(data: str) -> dict[str, Any]:
    raw = (data or "").strip()
    if not raw.upper().startswith(PSKT_PREFIX):
        raise ValueError("Expected PSKT-prefixed hex payload")
    body = raw[len(PSKT_PREFIX) :]
    return json.loads(bytes.fromhex(body).decode("utf-8"))


def pskt_to_seedmask_v2(
    pskt: dict[str, Any],
    *,
    kpub: str = "",
    account: int | None = None,
    network: str = DEFAULT_NETWORK,
) -> dict[str, Any]:
    """Derive SeedMask coordinator JSON v2 from standard (or legacy) PSKT.

    Exports every PSKT input (singlesig multi-UTXO spends need one signature per
    input after a single SeedMask approval).
    """
    g = pskt.get("global") or {}
    legacy = _legacy_seedpass_props(pskt)
    acct = _account_from_pskt(pskt, account)
    kp = _kpub_from_pskt(pskt, kpub)

    inputs_pskt = pskt.get("inputs") or []
    outputs_pskt = pskt.get("outputs") or []
    if not inputs_pskt:
        raise ValueError("PSKT has no inputs")

    outs_v2 = []
    for i, out in enumerate(outputs_pskt):
        ver, script_hex = _parse_spk_wire(out.get("scriptPublicKey"))
        entry: dict[str, Any] = {
            "value": int(out.get("amount", 0)),
            "script_version": ver,
            "script_hex": script_hex,
        }
        if i == 0 and len(outputs_pskt) == 1:
            entry["kaspa_address"] = ""
        outs_v2.append(entry)

    net = legacy.get("seedpass/network") or network
    inputs_v2: list[dict[str, Any]] = []
    for inp in inputs_pskt:
        if not isinstance(inp, dict):
            continue
        prev = inp.get("previousOutpoint") or {}
        utxo = inp.get("utxoEntry") or {}
        utxo_ver, utxo_script_hex = _parse_spk_wire(utxo.get("scriptPublicKey"))
        sign_chain, sign_index = _sign_path_from_input(inp, acct)
        receive = ""
        if kp:
            receive = _address_for_signing(kp, sign_chain, sign_index)
        # Legacy single-input props only apply to the first input.
        if not receive and not inputs_v2:
            receive = (legacy.get("seedpass/receiveAddress") or "").strip()
        input_v2: dict[str, Any] = {
            "prev_tx_id": str(prev.get("transactionId", "")),
            "prev_index": int(prev.get("index", 0)),
            "sequence": int(inp.get("sequence") if inp.get("sequence") is not None else 0),
            "sig_op_count": int(inp.get("sigOpCount") or 1),
            "utxo_amount": int(utxo.get("amount", 0)),
            "utxo_script_version": utxo_ver,
            "utxo_script_hex": utxo_script_hex,
            "sign_chain": sign_chain,
            "sign_address_index": sign_index,
            "receive_address": receive,
        }
        redeem_script = str(inp.get("redeemScript") or "").strip().lower().replace("0x", "")
        if redeem_script:
            input_v2["redeem_script_hex"] = redeem_script
        inputs_v2.append(input_v2)

    if not inputs_v2:
        raise ValueError("PSKT has no usable inputs")

    v2: dict[str, Any] = {
        "version": 2,
        "network": net,
        "account": int(acct),
        "tx_version": int(g.get("txVersion", DEFAULT_TX_VERSION)),
        "lock_time": int(g.get("fallbackLockTime") or 0),
        "gas": 0,
        "subnetwork_id_hex": "0" * 40,
        "payload_hex": "",
        "inputs": inputs_v2,
        "outputs": outs_v2,
    }
    if kp:
        v2["kpub"] = kp
    return v2


def build_pskt_and_v2_for_send(
    *,
    prev_tx_id: str,
    prev_index: int,
    amount_sompi: int,
    send_sompi: int,
    receive_address: str,
    to_address: str,
    account: int = 0,
    sign_index: int = 0,
    sign_chain: int = 0,
    kpub: str = "",
    fingerprint: str = "",
    change_to_receive: bool = False,
    network: str = DEFAULT_NETWORK,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """PSKT (rusty-kaspa) + derived SeedMask JSON v2."""
    pskt = build_pskt_for_send(
        prev_tx_id=prev_tx_id,
        prev_index=prev_index,
        amount_sompi=amount_sompi,
        send_sompi=send_sompi,
        receive_address=receive_address,
        to_address=to_address,
        account=account,
        sign_index=sign_index,
        sign_chain=sign_chain,
        kpub=kpub,
        fingerprint=fingerprint,
        change_to_receive=change_to_receive,
    )
    v2 = pskt_to_seedmask_v2(pskt, kpub=kpub, account=account, network=network)
    outs = v2.get("outputs") or []
    if outs:
        outs[0]["kaspa_address"] = normalize_kaspa_address(to_address)
    return pskt, v2


def pskb_to_hex(pskts: list[dict[str, Any]]) -> str:
    """Serialize PSKB bundle (JSON array of PSKT inners) per kaspa-wallet-pskt."""
    body = [normalize_pskt_inner(p) for p in pskts]
    payload = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return PSKB_PREFIX + payload.hex()


def pskb_from_hex(data: str) -> list[dict[str, Any]]:
    raw = (data or "").strip()
    if not raw.upper().startswith(PSKB_PREFIX):
        raise ValueError("Expected PSKB-prefixed hex payload")
    body = raw[len(PSKB_PREFIX) :]
    items = json.loads(bytes.fromhex(body).decode("utf-8"))
    if not isinstance(items, list):
        raise ValueError("PSKB payload must be a JSON array of PSKTs")
    return [normalize_pskt_inner(p) for p in items]


def build_pskt_sweep_utxo(
    *,
    prev_tx_id: str,
    prev_index: int,
    amount_sompi: int,
    receive_address: str,
    to_address: str,
    fee_sompi: int,
    account: int = 0,
    sign_index: int = 0,
    sign_chain: int = 0,
    kpub: str = "",
    fingerprint: str = "",
    block_daa_score: int = 0,
) -> dict[str, Any]:
    """One PSKT per UTXO (full value minus fee) — standard sweep entry for PSKB."""
    send = int(amount_sompi) - int(fee_sompi)
    if send <= 0:
        raise ValueError("fee_sompi must be less than UTXO amount")
    return build_pskt_for_send(
        prev_tx_id=prev_tx_id,
        prev_index=prev_index,
        amount_sompi=amount_sompi,
        send_sompi=send,
        receive_address=receive_address,
        to_address=to_address,
        account=account,
        sign_index=sign_index,
        sign_chain=sign_chain,
        kpub=kpub,
        fingerprint=fingerprint,
        change_to_receive=False,
        block_daa_score=block_daa_score,
    )


def build_pskb_sweep(
    utxos: list[dict[str, Any]],
    *,
    to_address: str,
    fee_sompi_per_tx: int,
    account: int = 0,
    kpub: str = "",
    fingerprint: str = "",
) -> tuple[list[dict[str, Any]], str]:
    """Build one PSKT per UTXO and return (pskts, pskb_hex)."""
    if not utxos:
        raise ValueError("sweep requires at least one UTXO")
    pskts: list[dict[str, Any]] = []
    for u in utxos:
        pskts.append(
            build_pskt_sweep_utxo(
                prev_tx_id=str(u["transaction_id"]),
                prev_index=int(u["output_index"]),
                amount_sompi=int(u["amount"]),
                receive_address=str(u["address"]),
                to_address=to_address,
                fee_sompi=fee_sompi_per_tx,
                account=account,
                sign_index=int(u.get("address_index", 0)),
                sign_chain=1 if u.get("is_change") else 0,
                kpub=kpub,
                fingerprint=fingerprint,
                block_daa_score=int(u.get("block_daa_score", 0)),
            )
        )
    return pskts, pskb_to_hex(pskts)


def draft_envelope(
    pskt: dict[str, Any],
    unsigned_v2: dict[str, Any],
    *,
    pskts: list[dict[str, Any]] | None = None,
    pskb_hex: str | None = None,
) -> dict[str, Any]:
    env: dict[str, Any] = {
        "format": DRAFT_FORMAT,
        "pskt": normalize_pskt_inner(pskt),
        "pskt_hex": pskt_to_hex(pskt),
        "unsigned": unsigned_v2,
    }
    if pskts and len(pskts) > 1:
        env["pskts"] = [normalize_pskt_inner(p) for p in pskts]
        env["pskb_hex"] = pskb_hex or pskb_to_hex(pskts)
    return env


def parse_draft_file(data: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Return (pskt or None, unsigned v2). Accepts legacy drafts."""
    if data.get("format") == DRAFT_FORMAT:
        pskt = data.get("pskt")
        if not pskt and isinstance(data.get("pskts"), list) and data["pskts"]:
            pskt = data["pskts"][0]
        unsigned = data.get("unsigned") or {}
        if unsigned.get("version") == 2:
            return pskt if isinstance(pskt, dict) else None, unsigned
    unsigned = data.get("unsigned") or data
    if unsigned.get("version") == 2:
        return None, unsigned
    raise ValueError("Draft is not a valid unsigned transaction")


def _input_pubkey_hex(
    inp: dict[str, Any],
    pskt: dict[str, Any],
    *,
    unsigned: dict[str, Any] | None = None,
    input_index: int | None = None,
) -> str | None:
    derivs = inp.get("bip32Derivations") or {}
    if isinstance(derivs, dict) and derivs:
        return next(iter(derivs.keys())).strip().lower()
    kp = _kpub_from_pskt(pskt, str((unsigned or {}).get("kpub") or ""))
    if not kp:
        return None
    acct = _account_from_pskt(pskt, (unsigned or {}).get("account"))
    chain, index = 0, 0
    if unsigned is not None and input_index is not None:
        uins = unsigned.get("inputs") or []
        if 0 <= input_index < len(uins) and isinstance(uins[input_index], dict):
            ui = uins[input_index]
            chain = int(ui.get("sign_chain", 0))
            index = int(ui.get("sign_address_index", 0))
        else:
            chain, index = _sign_path_from_input(inp, acct)
    else:
        chain, index = _sign_path_from_input(inp, acct)
    return _signing_pubkey_hex(kp, chain, index)


def _populate_input_bip32_derivation(
    inp: dict[str, Any],
    *,
    kpub: str,
    account: int,
    chain: int,
    index: int,
    fingerprint: str = "",
) -> None:
    derivs = inp.get("bip32Derivations") or {}
    if isinstance(derivs, dict) and derivs:
        return
    kp = (kpub or "").strip()
    if not kp:
        return
    pubkey_hex = _signing_pubkey_hex(kp, int(chain), int(index))
    if not pubkey_hex:
        return
    fp = (fingerprint or "").strip() or "00000000"
    inp["bip32Derivations"] = {
        pubkey_hex: _key_source(fp, _leaf_derivation_path(int(account), int(chain), int(index)))
    }


def enrich_pskt_signing_paths(
    pskt: dict[str, Any],
    unsigned: dict[str, Any],
    *,
    kpub: str = "",
    fingerprint: str = "",
) -> dict[str, Any]:
    """Ensure each PSKT input has bip32Derivations so partialSigs can be attached."""
    out = copy.deepcopy(pskt)
    kp = _kpub_from_pskt(out, kpub or str(unsigned.get("kpub") or ""))
    if not kp:
        return out
    acct = int(unsigned.get("account") if unsigned.get("account") is not None else _account_from_pskt(out))
    fp = (fingerprint or "").strip()
    uins = unsigned.get("inputs") or []
    for idx, inp in enumerate(out.get("inputs") or []):
        if not isinstance(inp, dict):
            continue
        chain, sign_index = 0, 0
        if idx < len(uins) and isinstance(uins[idx], dict):
            chain = int(uins[idx].get("sign_chain", 0))
            sign_index = int(uins[idx].get("sign_address_index", 0))
        else:
            chain, sign_index = _sign_path_from_input(inp, acct)
        _populate_input_bip32_derivation(
            inp,
            kpub=kp,
            account=acct,
            chain=chain,
            index=sign_index,
            fingerprint=fp,
        )
    g = out.setdefault("global", {})
    xpubs = g.setdefault("xpubs", {})
    if kp and not xpubs:
        xpubs[kp] = _key_source(fp or "00000000", _account_derivation_path(acct))
    return out


def _partial_sig_entry(sig_bytes: list[int]) -> dict[str, Any]:
    return {"schnorr": sig_bytes}


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


def _sig_push_hex(sig: Any) -> str:
    if isinstance(sig, dict):
        if "schnorr" in sig and isinstance(sig["schnorr"], list):
            raw = bytes(int(x) & 0xFF for x in sig["schnorr"])
        else:
            raw = bytes.fromhex(str(sig.get("signature") or sig.get("hex") or ""))
    elif isinstance(sig, bytes):
        raw = sig
    elif isinstance(sig, list):
        raw = bytes(int(x) & 0xFF for x in sig)
    else:
        raw = bytes.fromhex(str(sig))
    if len(raw) == 65:
        raw = raw[:64]
    if len(raw) != 64:
        raise ValueError("Kaspa Schnorr signatures must be 64 bytes")
    return _push_data_hex(raw.hex() + "01")


def _redeem_script_pubkeys(redeem_script_hex: str) -> tuple[int, list[str]]:
    redeem = redeem_script_hex.strip().lower().replace("0x", "")
    data = bytes.fromhex(redeem)
    if len(data) < 3 or not (0x51 <= data[0] <= 0x60):
        raise ValueError("Unsupported Kaspa multisig redeem script")
    required = data[0] - 0x50
    pos = 1
    xonly_pubkeys: list[str] = []
    while pos < len(data):
        op = data[pos]
        if 0x51 <= op <= 0x60:
            total = op - 0x50
            if pos + 1 >= len(data) or data[pos + 1] != 0xAE:
                raise ValueError("Unsupported Kaspa multisig redeem script")
            if total != len(xonly_pubkeys):
                raise ValueError("Kaspa multisig redeem script pubkey count mismatch")
            return required, xonly_pubkeys
        if op != 0x20 or pos + 33 > len(data):
            raise ValueError("Unsupported Kaspa multisig redeem script")
        xonly_pubkeys.append(data[pos + 1 : pos + 33].hex())
        pos += 33
    raise ValueError("Unsupported Kaspa multisig redeem script")


def _partial_sig_xonly(pubkey: str) -> str:
    return str(pubkey).strip().lower().replace("0x", "")[-64:]


def _multisig_sig_progress(
    redeem_script_hex: str,
    partial_sigs: dict[str, Any],
) -> tuple[int, int, list[str]]:
    """Return (signatures_present, signatures_required, missing_xonly_pubkeys)."""
    required, xonly_pubkeys = _redeem_script_pubkeys(redeem_script_hex)
    present_xonly: list[str] = []
    for pubkey, sig in (partial_sigs or {}).items():
        xonly = _partial_sig_xonly(pubkey)
        if xonly not in xonly_pubkeys:
            continue
        if _sig_hex_from_partial_sigs({pubkey: sig}):
            present_xonly.append(xonly)
    missing = [pk for pk in xonly_pubkeys if pk not in present_xonly]
    return len(present_xonly), required, missing


def _finalize_multisig_signature_script_from_redeem(
    redeem_script_hex: str,
    partial_sigs: dict[str, Any],
) -> str:
    required, xonly_pubkeys = _redeem_script_pubkeys(redeem_script_hex)
    by_xonly = {
        _partial_sig_xonly(pubkey): sig
        for pubkey, sig in (partial_sigs or {}).items()
    }
    parts: list[str] = []
    for xonly in xonly_pubkeys:
        sig = by_xonly.get(xonly)
        if sig is None:
            continue
        parts.append(_sig_push_hex(sig))
        if len(parts) >= required:
            break
    if len(parts) < required:
        have, need, missing = _multisig_sig_progress(redeem_script_hex, partial_sigs)
        raise ValueError(
            f"Partial Kaspa multisig signature saved ({have}/{need}). "
            f"Missing signatures for {len(missing)} cosigner pubkey(s) in the redeem script."
        )
    redeem = redeem_script_hex.strip().lower().replace("0x", "")
    parts.append(_push_data_hex(redeem))
    return "".join(parts)


def verify_multisig_partial_sigs(unsigned: dict[str, Any], partial_sigs: dict[str, Any]) -> list[str]:
    """Return human-readable errors when cosigner sigs do not match the unsigned QR payload."""
    try:
        import secp256k1
    except ImportError:
        return []

    from kaspa_sighash import calc_schnorr_sighash_v0, device_unsigned_view

    view = device_unsigned_view(unsigned)
    inp = (view.get("inputs") or [{}])[0]
    redeem = str(inp.get("redeem_script_hex") or "").strip().lower().replace("0x", "")
    p2sh = str(inp.get("utxo_script_hex") or "").strip().lower().replace("0x", "")
    if not redeem or not partial_sigs:
        return []

    errors: list[str] = []
    digest = calc_schnorr_sighash_v0(view, 0, utxo_script_hex=p2sh)
    for pubkey, sig in (partial_sigs or {}).items():
        raw = _sig_hex_from_partial_sigs({pubkey: sig})
        if not raw:
            errors.append(f"cosigner {str(pubkey)[:12]}…: missing 64-byte signature")
            continue
        try:
            pk = secp256k1.PublicKey(bytes.fromhex(str(pubkey).strip().lower()), raw=True)
            if not pk.schnorr_verify(bytes.fromhex(raw), digest, b"", raw=True):
                errors.append(
                    f"cosigner {str(pubkey)[:12]}…: signature does not match this unsigned QR "
                    "(reflash SeedMask, rebuild Send, re-sign both cosigners)"
                )
        except Exception as exc:
            errors.append(f"cosigner {str(pubkey)[:12]}…: {exc}")
    return errors


def apply_seedmask_signed_to_pskt(
    pskt: dict[str, Any],
    signed: dict[str, Any],
    *,
    unsigned: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Attach device Schnorr signatures to PSKT input partialSigs (rusty-kaspa format)."""
    out = copy.deepcopy(pskt)
    if unsigned:
        out = enrich_pskt_signing_paths(
            out,
            unsigned,
            kpub=str(unsigned.get("kpub") or ""),
        )
    sigs = {int(s["input_index"]): s for s in signed.get("signatures", [])}
    for idx, sig_row in sigs.items():
        sig_hex = str(sig_row.get("sig_hex") or "")
        if len(sig_hex) != 128:
            raise ValueError(f"input {idx}: expected 128 hex chars (64-byte sig)")
        if idx >= len(out.get("inputs") or []):
            raise ValueError(f"input_index {idx} out of range")
        sig_bytes = list(bytes.fromhex(sig_hex))
        inp = out["inputs"][idx]
        signed_pubkey = str(sig_row.get("pubkey_hex") or "").strip().lower().replace("0x", "")
        pubkey_hex = signed_pubkey if len(signed_pubkey) == 66 and signed_pubkey[:2] in ("02", "03") else ""
        expected_pubkeys = {
            str(pk).strip().lower().replace("0x", "")
            for pk in (inp.get("bip32Derivations") or {}).keys()
        }
        if pubkey_hex and expected_pubkeys and pubkey_hex not in expected_pubkeys:
            raise ValueError(f"input {idx}: signature pubkey is not a cosigner for this draft")
        if not pubkey_hex and inp.get("redeemScript") and len(expected_pubkeys) > 1:
            raise ValueError(
                f"input {idx}: multisig signature is missing pubkey_hex "
                "(update SeedMask firmware and sign this draft again)"
            )
        if not pubkey_hex:
            pubkey_hex = _input_pubkey_hex(inp, out, unsigned=unsigned, input_index=idx)
        if not pubkey_hex:
            raise ValueError(
                f"input {idx}: cannot resolve signing pubkey for partialSigs "
                "(rebuild the transaction with your watch-only wallet loaded, then re-sign on SeedMask)"
            )
        inp.setdefault("partialSigs", {})
        inp["partialSigs"][pubkey_hex] = _partial_sig_entry(sig_bytes)
    return out


def _sig_hex_from_partial_sigs(partial: dict[str, Any]) -> str | None:
    for val in partial.values():
        if isinstance(val, dict):
            schnorr = val.get("schnorr")
            if isinstance(schnorr, list) and len(schnorr) == 64:
                return bytes(schnorr).hex()
        elif isinstance(val, list) and len(val) == 64:
            return bytes(val).hex()
    return None


def pskt_signed_to_ready_v2(
    pskt: dict[str, Any],
    signed: dict[str, Any] | None = None,
    *,
    unsigned: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Merge PSKT + optional SeedMask signed JSON into broadcast-ready JSON v2."""
    if signed and any(isinstance(inp, dict) and inp.get("redeemScript") for inp in pskt.get("inputs") or []):
        return pskt_signed_to_ready_v2(
            apply_seedmask_signed_to_pskt(pskt, signed, unsigned=unsigned),
            None,
            unsigned=unsigned,
        )
    if unsigned and unsigned.get("version") == 2 and unsigned.get("inputs"):
        v2 = copy.deepcopy(unsigned)
    else:
        v2 = pskt_to_seedmask_v2(pskt)
    if signed:
        from kaspa_apply_signatures import merge

        return merge(v2, signed)
    sigs = {}
    multisig_ready = False
    for i, inp in enumerate(pskt.get("inputs") or []):
        redeem = str(inp.get("redeemScript") or "").strip().lower().replace("0x", "")
        if redeem:
            partial = inp.get("partialSigs") or {}
            final_script = _finalize_multisig_signature_script_from_redeem(redeem, partial)
            if i >= len(v2.get("inputs") or []):
                raise ValueError(f"input_index {i} out of range")
            v2["inputs"][i]["signature_script"] = final_script
            multisig_ready = True
            continue
        props = inp.get("proprietaries") or {}
        if props.get("seedpass/sigHex"):
            sigs[i] = props["seedpass/sigHex"]
            continue
        sig_hex = _sig_hex_from_partial_sigs(inp.get("partialSigs") or {})
        if sig_hex:
            sigs[i] = sig_hex
    if multisig_ready:
        v2["seedpass_signed"] = True
        return v2
    if not sigs:
        raise ValueError("PSKT has no signatures — scan signed JSON from SeedMask first")
    signed_obj = {"signatures": [{"input_index": k, "sig_hex": v} for k, v in sigs.items()]}
    from kaspa_apply_signatures import merge

    return merge(v2, signed_obj)


def validate_rusty_pskt_shape(pskt: dict[str, Any]) -> list[str]:
    """Return human-readable issues if PSKT JSON diverges from rusty-kaspa serde expectations."""
    issues: list[str] = []
    g = pskt.get("global")
    if not isinstance(g, dict):
        return ["missing global map"]
    if g.get("version") != PSKT_VERSION_ONE:
        issues.append(f"global.version should be {PSKT_VERSION_ONE} (rusty-kaspa default One)")
    for key in ("inputs", "outputs"):
        if not isinstance(pskt.get(key), list):
            issues.append(f"missing {key} array")
    for scope in (g, *((pskt.get("inputs") or []), *((pskt.get("outputs") or [])))):
        if isinstance(scope, dict):
            props = scope.get("proprietaries") or {}
            for pk in props:
                if str(pk).startswith("seedpass/"):
                    issues.append(f"non-standard proprietary key in exported PSKT: {pk}")
    for inp in pskt.get("inputs") or []:
        if not isinstance(inp, dict):
            continue
        utxo = inp.get("utxoEntry") or {}
        if utxo and not isinstance(utxo.get("scriptPublicKey"), str):
            issues.append("utxoEntry.scriptPublicKey should be a hex string (rusty-kaspa ScriptPublicKey)")
        for pk, src in (inp.get("bip32Derivations") or {}).items():
            if isinstance(src, dict) and not isinstance(src.get("derivationPath"), str):
                issues.append("bip32Derivations.derivationPath should be a BIP32 string (m/44'/…)")
            if isinstance(src, dict):
                kf = src.get("keyFingerprint")
                if not isinstance(kf, str) or len(kf) != 8:
                    issues.append("bip32Derivations.keyFingerprint should be an 8-char hex string")
        for pk, sig in (inp.get("partialSigs") or {}).items():
            if pk == "seedmask":
                issues.append("partialSigs must be keyed by secp pubkey, not seedmask")
            if isinstance(sig, list):
                issues.append("partialSigs values must use Signature enum (e.g. {schnorr: [...]})")
    for out in pskt.get("outputs") or []:
        if isinstance(out, dict) and out.get("scriptPublicKey") is not None:
            if not isinstance(out.get("scriptPublicKey"), str):
                issues.append("output.scriptPublicKey should be a hex string")
    xpubs = g.get("xpubs") or {}
    if isinstance(xpubs, dict):
        for xpub, src in xpubs.items():
            if not str(xpub).startswith(("kpub", "xpub", "tpub")):
                issues.append(f"global.xpubs key looks invalid: {xpub!r}")
            if isinstance(src, dict) and not isinstance(src.get("derivationPath"), str):
                issues.append("global.xpubs derivationPath should be a BIP32 string")
    return issues


def v2_from_legacy_build(**kwargs: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """Fallback: build v2 via legacy helper then wrap as PSKT metadata."""
    v2 = build_unsigned_v2(**kwargs)
    pskt = build_pskt_for_send(
        prev_tx_id=kwargs["prev_tx_id"],
        prev_index=kwargs.get("prev_index", 0),
        amount_sompi=kwargs["amount_sompi"],
        send_sompi=kwargs["send_sompi"],
        receive_address=kwargs["receive_address"],
        to_address=kwargs["to_address"],
        account=kwargs.get("account", 0),
        sign_index=kwargs.get("sign_index", 0),
        sign_chain=kwargs.get("sign_chain", 0),
        kpub=kwargs.get("kpub", ""),
        fingerprint=kwargs.get("fingerprint", ""),
        change_to_receive=kwargs.get("change_to_receive", False),
    )
    v2_from_pskt = pskt_to_seedmask_v2(pskt, kpub=kwargs.get("kpub", ""), account=kwargs.get("account", 0))
    outs = v2_from_pskt.get("outputs") or []
    if outs and kwargs.get("to_address"):
        outs[0]["kaspa_address"] = normalize_kaspa_address(kwargs["to_address"])
    if kwargs.get("kpub"):
        v2_from_pskt["kpub"] = kwargs["kpub"]
    return pskt, v2_from_pskt
