"""Build unsigned QR, merge signatures, broadcast — wraps SeedPass tools."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import sys
import uuid
from pathlib import Path

def _find_tools_dir() -> Path:
    """SeedPass_UI_Shell/tools in dev; bundled as coordinator/tools inside .app."""
    coord = Path(__file__).resolve().parent.parent
    bundled = coord / "tools"
    if bundled.is_dir():
        return bundled
    repo = coord.parent / "tools"
    home = Path.home()
    protected = {home / "Desktop", home / "Documents", home / "Downloads"}
    if any(str(repo).startswith(str(p) + "/") or repo == p for p in protected):
        raise RuntimeError(f"Cannot find tools/ next to coordinator at {bundled}")
    if repo.is_dir():
        return repo
    raise RuntimeError(f"Cannot find tools/ (looked in {bundled} and {repo})")


TOOLS = _find_tools_dir()
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from kaspa_apply_signatures import merge  # noqa: E402
from kaspa_coordinator_qr import (  # noqa: E402
    kaspa_address_to_script_hex,
    normalize_kaspa_address,
)
from kaspa_pskt import (  # noqa: E402
    DRAFT_FORMAT,
    enrich_pskt_signing_paths,
    apply_seedmask_signed_to_pskt,
    build_pskb_sweep,
    build_pskt_and_v2_for_send,
    draft_envelope,
    parse_draft_file,
    pskt_from_hex,
    pskt_signed_to_ready_v2,
    pskt_to_hex,
    pskt_to_seedmask_v2,
    pskb_to_hex,
)

from .kaspa_service import RPC_TIMEOUT_SEC, WalletUtxo, get_service
from .wallet_store import DATA_DIR, WalletConfig, effective_wallet_account

DRAFTS_DIR = DATA_DIR / "drafts"
SUBMIT_TIMEOUT_SEC = 60.0


def _validate_pskt_with_wasm(pskt: dict) -> None:
    """Official rusty-kaspa parse proof when WASM SDK + node are available."""
    try:
        from kaspa_pskt_wasm import require_valid_pskt, wasm_validate_ready

        if wasm_validate_ready():
            require_valid_pskt(pskt)
    except ImportError:
        pass


def sompi_from_kas(kas: float) -> int:
    if kas <= 0:
        raise ValueError("Amount must be positive")
    return int(round(kas * 100_000_000))


def _drop_default_field(obj: dict, key: str, default) -> None:
    if obj.get(key) == default:
        obj.pop(key, None)


def compact_unsigned_for_qr(unsigned: dict) -> dict:
    """Drop display-only fields so BC-UR parts fit fewer QR modules.

    Keep every field that affects Kaspa sighash (gas, lock_time, sequences, scripts).
    """
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


def unsigned_draft_hash(unsigned: dict) -> str:
    """Hash the exact unsigned body SeedMask scans (compact QR payload, no draft_hash)."""
    payload = json.dumps(compact_unsigned_for_qr(unsigned), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def attach_unsigned_draft_hash(unsigned: dict) -> dict:
    unsigned["draft_hash"] = unsigned_draft_hash(unsigned)
    return unsigned


def validate_signed_matches_draft_hash(unsigned: dict, signed: dict) -> None:
    expected = unsigned_draft_hash(unsigned)
    got = str(signed.get("draft_hash") or "").strip().lower()
    if got != expected:
        raise ValueError(
            "Signed transaction does not match this Review & Sign draft — scan the current QR on SeedMask "
            f"(do not reuse an older signed file), then import that signed result. "
            f"Expected draft_hash {expected[:16]}…, got {got[:16] if got else '(missing)'}…"
        )


def unsigned_json_for_qr(unsigned: dict) -> str:
    body = compact_unsigned_for_qr(unsigned)
    body["draft_hash"] = unsigned_draft_hash(unsigned)
    return json.dumps(body, separators=(",", ":"))


def qr_png_base64(payload_text: str, scale: int = 8) -> str:
    import qrcode
    from PIL import Image

    # L + moderate scale: faster encode, still scannable on SeedPass camera
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_L, box_size=max(4, scale))
    qr.add_data(payload_text)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    border = max(16, scale * 2)
    padded = Image.new("RGB", (img.size[0] + border * 2, img.size[1] + border * 2), "white")
    padded.paste(img, (border, border))
    buf = io.BytesIO()
    padded.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def ensure_unsigned_has_kpub(unsigned: dict, kpub: str) -> dict:
    """Embed wallet kpub for SeedMask SD export when older drafts omit it."""
    key = (kpub or "").strip()
    if not key:
        return unsigned
    if (unsigned.get("kpub") or unsigned.get("xpub") or "").strip():
        return unsigned
    out = dict(unsigned)
    out["kpub"] = key
    return out


def build_unsigned_for_send(
    cfg: WalletConfig,
    utxo: WalletUtxo,
    to_address: str,
    send_sompi: int,
) -> dict:
    if send_sompi <= 0 or send_sompi > utxo.amount:
        raise ValueError(f"send amount must be 1..{utxo.amount} sompi")
    receive = utxo.address
    kpub = (cfg.kpub or "").strip()
    fingerprint = (cfg.fingerprint or "").strip()
    _pskt, unsigned = build_pskt_and_v2_for_send(
        prev_tx_id=utxo.transaction_id,
        prev_index=utxo.output_index,
        amount_sompi=utxo.amount,
        send_sompi=send_sompi,
        receive_address=receive,
        to_address=to_address,
        account=effective_wallet_account(cfg),
        sign_index=utxo.address_index,
        sign_chain=1 if utxo.is_change else 0,
        kpub=kpub,
        fingerprint=fingerprint,
        change_to_receive=False,
    )
    return unsigned


def save_draft(
    unsigned: dict,
    pskt: dict | None = None,
    *,
    pskts: list[dict] | None = None,
    pskb_hex: str | None = None,
    summary: dict | None = None,
) -> str:
    DRAFTS_DIR.mkdir(parents=True, exist_ok=True)
    draft_id = str(uuid.uuid4())
    path = DRAFTS_DIR / f"{draft_id}.json"
    if pskt is None and unsigned.get("_pskt"):
        pskt = unsigned.pop("_pskt")
    attach_unsigned_draft_hash(unsigned)
    payload: dict
    if pskt:
        payload = draft_envelope(pskt, unsigned, pskts=pskts, pskb_hex=pskb_hex)
    else:
        payload = {"format": DRAFT_FORMAT, "unsigned": unsigned}
    if summary:
        payload["summary"] = summary
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return draft_id


def save_draft_from_build(cfg: WalletConfig, utxo: WalletUtxo, to_address: str, send_sompi: int) -> tuple[str, dict, dict]:
    """Build PSKT + v2 and persist draft envelope. Returns (draft_id, pskt, unsigned_v2)."""
    if send_sompi <= 0 or send_sompi > utxo.amount:
        raise ValueError(f"send amount must be 1..{utxo.amount} sompi")
    from .wallet_store import resolve_kaspa_fingerprint

    kpub = (cfg.kpub or "").strip()
    fingerprint = resolve_kaspa_fingerprint(cfg, kpub)
    pskt, unsigned = build_pskt_and_v2_for_send(
        prev_tx_id=utxo.transaction_id,
        prev_index=utxo.output_index,
        amount_sompi=utxo.amount,
        send_sompi=send_sompi,
        receive_address=utxo.address,
        to_address=to_address,
        account=effective_wallet_account(cfg),
        sign_index=utxo.address_index,
        sign_chain=1 if utxo.is_change else 0,
        kpub=kpub,
        fingerprint=fingerprint,
        change_to_receive=False,
    )
    _validate_pskt_with_wasm(pskt)
    draft_id = save_draft(unsigned, pskt=pskt)
    return draft_id, pskt, unsigned


def save_sweep_draft_from_build(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    to_address: str,
    fee_sompi_per_tx: int,
) -> tuple[str, list[dict], dict, str]:
    """Build PSKB (one PSKT per UTXO). SeedMask still signs first tx JSON v2 only."""
    if not utxos:
        raise ValueError("sweep requires at least one UTXO")
    if fee_sompi_per_tx < 0:
        raise ValueError("fee_sompi_per_tx must be non-negative")
    from .wallet_store import resolve_kaspa_fingerprint

    kpub = (cfg.kpub or "").strip()
    fingerprint = resolve_kaspa_fingerprint(cfg, kpub)
    utxo_dicts = [
        {
            "address": u.address,
            "address_index": u.address_index,
            "transaction_id": u.transaction_id,
            "output_index": u.output_index,
            "amount": u.amount,
            "is_change": u.is_change,
        }
        for u in utxos
    ]
    acct = effective_wallet_account(cfg)
    pskts, pskb_hex = build_pskb_sweep(
        utxo_dicts,
        to_address=to_address,
        fee_sompi_per_tx=fee_sompi_per_tx,
        account=acct,
        kpub=kpub,
        fingerprint=fingerprint,
    )
    for p in pskts:
        _validate_pskt_with_wasm(p)
    try:
        from kaspa_pskt_wasm import validate_pskb_hex, wasm_validate_ready

        if wasm_validate_ready():
            res = validate_pskb_hex(pskb_hex)
            if not res.get("ok"):
                raise ValueError(f"PSKB rejected by rusty-kaspa WASM: {res.get('error', res)}")
    except ImportError:
        pass
    first = utxos[0]
    send_sompi = first.amount - fee_sompi_per_tx
    if send_sompi <= 0:
        raise ValueError(f"fee exceeds first UTXO amount ({first.amount} sompi)")
    unsigned = pskt_to_seedmask_v2(pskts[0], kpub=kpub, account=acct)
    outs = unsigned.get("outputs") or []
    if outs:
        outs[0]["kaspa_address"] = normalize_kaspa_address(to_address)
    draft_id = save_draft(unsigned, pskt=pskts[0], pskts=pskts, pskb_hex=pskb_hex)
    return draft_id, pskts, unsigned, pskb_hex


def load_draft(draft_id: str) -> dict:
    _pskt, unsigned = load_draft_envelope(draft_id)
    return unsigned


def load_draft_envelope(draft_id: str) -> tuple[dict | None, dict]:
    path = DRAFTS_DIR / f"{draft_id}.json"
    if not path.is_file():
        raise FileNotFoundError("Draft not found — rebuild unsigned tx on Send tab")
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    return parse_draft_file(data)


def load_draft_pskt_hex(draft_id: str) -> str | None:
    pskt, _ = load_draft_envelope(draft_id)
    if pskt:
        return pskt_to_hex(pskt)
    return None


def _input_outpoints(unsigned: dict) -> list[tuple[str, int]]:
    out: list[tuple[str, int]] = []
    for inp in unsigned.get("inputs") or []:
        if not isinstance(inp, dict):
            continue
        txid = str(inp.get("prev_tx_id") or "").strip().lower()
        if txid.startswith("0x"):
            txid = txid[2:]
        out.append((txid, int(inp.get("prev_index", 0))))
    return out


def _is_ready_v2_tx(signed: dict) -> bool:
    """SeedMask / merge output: full v2 tx with signature_script on each input."""
    if signed.get("signatures"):
        return False
    if int(signed.get("version") or 0) != 2:
        return False
    inputs = signed.get("inputs") or []
    if not inputs:
        return False
    return all(
        isinstance(inp, dict) and str(inp.get("signature_script") or "").strip()
        for inp in inputs
    )


def _validate_ready_matches_unsigned(unsigned: dict, ready: dict) -> None:
    if _input_outpoints(unsigned) != _input_outpoints(ready):
        raise ValueError(
            "Signed transaction does not match the unsigned draft — rebuild on Send, sign that QR, then load the signed file"
        )


def _ready_missing_signature_indices(ready: dict) -> list[int]:
    missing: list[int] = []
    for i, inp in enumerate(ready.get("inputs") or []):
        if isinstance(inp, dict) and not str(inp.get("signature_script") or inp.get("sig_hex") or "").strip():
            missing.append(i)
    return missing


def _validate_ready_signatures(unsigned: dict, ready: dict, signed: dict | None = None) -> None:
    missing = _ready_missing_signature_indices(ready)
    if not missing:
        return
    n_in = len(unsigned.get("inputs") or [])
    n_sig = len(signed.get("signatures") or []) if signed else 0
    parts: list[str] = []
    inputs = ready.get("inputs") or []
    for i in missing:
        inp = inputs[i] if i < len(inputs) else {}
        if isinstance(inp, dict):
            txid = str(inp.get("prev_tx_id") or "")[:16]
            prev = inp.get("prev_index")
            parts.append(f"#{i} ({txid}…:{prev})")
        else:
            parts.append(f"#{i}")
    raise ValueError(
        f"Signed data incomplete for this singlesig send: it spends {n_in} coins, "
        f"but SeedMask only returned {n_sig} of {n_in} input signatures "
        f"(still missing {', '.join(parts)}). "
        "Singlesig still needs one cryptographic signature per coin (one SeedMask "
        "approval should return all of them) — reflash if the device still caps at 4, "
        "then re-scan the full signed QR (do not reuse an older signed file)."
    )


def merge_signed(unsigned: dict, signed: dict, pskt: dict | None = None) -> dict:
    """Apply SeedMask signing output to the draft unsigned tx (ready to broadcast)."""
    validate_signed_matches_draft_hash(unsigned, signed)
    if _is_ready_v2_tx(signed):
        import copy

        _validate_ready_matches_unsigned(unsigned, signed)
        return copy.deepcopy(signed)

    if pskt:
        ready = pskt_signed_to_ready_v2(pskt, signed, unsigned=unsigned)
        _validate_ready_signatures(unsigned, ready, signed)
        return ready
    merged = merge(unsigned, signed)
    _validate_ready_signatures(unsigned, merged, signed)
    return merged


def _load_draft_raw(draft_id: str) -> dict:
    path = DRAFTS_DIR / f"{draft_id}.json"
    if not path.is_file():
        raise FileNotFoundError("Draft not found — rebuild unsigned tx on Send tab")
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def pskt_at_draft_index(draft_id: str, index: int = 0) -> tuple[dict, dict]:
    """Return (pskt, unsigned v2) for sweep index or single-tx draft."""
    data = _load_draft_raw(draft_id)
    pskts = data.get("pskts")
    if isinstance(pskts, list) and pskts:
        if index < 0 or index >= len(pskts):
            raise ValueError(f"Coin index {index} out of range (0..{len(pskts) - 1})")
        pskt = pskts[index]
        unsigned = data.get("unsigned") or {}
        if index == 0 and unsigned.get("version") == 2:
            return pskt, unsigned
        kpub = ""
        if unsigned.get("kpub"):
            kpub = str(unsigned["kpub"])
        acct = int(unsigned.get("account") or 0)
        unsigned = pskt_to_seedmask_v2(pskt, kpub=kpub, account=acct)
        outs = unsigned.get("outputs") or []
        if outs and pskt.get("outputs"):
            to_addr = (pskt["outputs"][0] or {}).get("address")
            if to_addr:
                outs[0]["kaspa_address"] = normalize_kaspa_address(str(to_addr))
        return pskt, unsigned
    pskt, unsigned = parse_draft_file(data)
    if index != 0:
        raise ValueError("Not a multi-UTXO sweep draft")
    return pskt, unsigned  # type: ignore[return-value]


def _save_updated_kaspa_pskt(draft_id: str, pskt: dict, index: int = 0) -> None:
    path = DRAFTS_DIR / f"{draft_id}.json"
    data = _load_draft_raw(draft_id)
    pskts = data.get("pskts")
    if isinstance(pskts, list) and pskts:
        if index < 0 or index >= len(pskts):
            raise ValueError(f"Coin index {index} out of range (0..{len(pskts) - 1})")
        pskts[index] = pskt
        data["pskts"] = pskts
        data["pskb_hex"] = pskb_to_hex(pskts)
        if index == 0:
            data["pskt"] = pskt
            data["pskt_hex"] = pskt_to_hex(pskt)
    else:
        data["pskt"] = pskt
        data["pskt_hex"] = pskt_to_hex(pskt)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def _kaspa_partial_signature_status(pskt: dict) -> tuple[int, int]:
    from kaspa_pskt import _multisig_sig_progress

    required = 0
    have = 0
    for inp in pskt.get("inputs") or []:
        if not isinstance(inp, dict) or not inp.get("redeemScript"):
            continue
        redeem = str(inp.get("redeemScript") or "").strip().lower().replace("0x", "")
        input_have, input_required, _missing = _multisig_sig_progress(redeem, inp.get("partialSigs") or {})
        required = max(required, max(1, input_required))
        have = max(have, input_have)
    return have, required


def sweep_qr_for_draft_index(
    draft_id: str,
    index: int,
    cfg: WalletConfig,
    *,
    qr_display_mode: str = "animated",
) -> dict:
    """Build QR pack for coin `index` in a sweep draft."""
    data = _load_draft_raw(draft_id)
    if is_bitcoin_draft(data):
        return btc_sweep_qr_for_draft_index(
            draft_id, index, qr_display_mode=qr_display_mode
        )

    from .ur_qr import fountain_qr_frames_base64

    pskt, unsigned = pskt_at_draft_index(draft_id, index)
    unsigned = ensure_unsigned_has_kpub(unsigned, cfg.kpub)
    qr_pack = fountain_qr_frames_base64(unsigned, qr_display_mode=qr_display_mode)
    inp = (unsigned.get("inputs") or [{}])[0]
    outs = unsigned.get("outputs") or []
    pay = outs[0] if outs else {}
    send = int(pay.get("amount") or 0)
    total_in = int(inp.get("utxo_amount") or inp.get("amount_sompi") or inp.get("amount") or 0)
    fee = max(0, total_in - send) if total_in else 0
    data = _load_draft_raw(draft_id)
    pskt_count = len(data.get("pskts") or []) or 1
    return {
        "draft_id": draft_id,
        "unsigned": unsigned,
        "pskt_index": index,
        "pskt_count": pskt_count,
        **qr_pack,
        "summary": {
            "is_sweep": pskt_count > 1,
            "utxo_count": pskt_count,
            "sweep_index": index,
            "send_sompi": send,
            "send_kas": send / 100_000_000.0,
            "fee_sompi": fee,
            "to_address": str(pay.get("kaspa_address") or pay.get("to_address") or ""),
            "from_address": str(inp.get("receive_address") or ""),
        },
    }


def _preserve_input_metadata(unsigned: dict, ready: dict) -> dict:
    """Keep wallet-scanned UTXO fields on the broadcast-ready tx."""
    src_inputs = unsigned.get("inputs") or []
    dst_inputs = ready.get("inputs") or []
    if not src_inputs or not dst_inputs:
        return ready
    for i, src in enumerate(src_inputs):
        if i >= len(dst_inputs) or not isinstance(src, dict) or not isinstance(dst_inputs[i], dict):
            continue
        dst = dst_inputs[i]
        for key in (
            "receive_address",
            "block_daa_score",
            "blockDaaScore",
            "is_coinbase",
            "isCoinbase",
            "covenant_id",
            "covenantId",
            "utxo_script_hex",
            "utxo_amount",
            "redeem_script_hex",
            "sig_op_count",
        ):
            if src.get(key) not in (None, "", 0) and not dst.get(key):
                dst[key] = src[key]
    return ready


def merge_signed_for_draft(draft_id: str, signed: dict, pskt_index: int = 0) -> dict:
    pskt, unsigned = pskt_at_draft_index(draft_id, pskt_index)
    validate_signed_matches_draft_hash(unsigned, signed)
    if pskt and any(isinstance(inp, dict) and inp.get("redeemScript") for inp in pskt.get("inputs") or []):
        updated = apply_seedmask_signed_to_pskt(pskt, signed, unsigned=unsigned)
        from kaspa_pskt import _multisig_sig_progress, verify_multisig_partial_sigs

        for inp in updated.get("inputs") or []:
            if not isinstance(inp, dict) or not inp.get("redeemScript"):
                continue
            redeem = str(inp.get("redeemScript") or "").strip().lower().replace("0x", "")
            partial = inp.get("partialSigs") or {}
            have, need, _missing = _multisig_sig_progress(redeem, partial)
            if need > 0 and have >= need:
                sig_errors = verify_multisig_partial_sigs(unsigned, partial)
                if sig_errors:
                    raise ValueError(sig_errors[0])
        try:
            ready = pskt_signed_to_ready_v2(updated, None, unsigned=unsigned)
        except ValueError as exc:
            _save_updated_kaspa_pskt(draft_id, updated, pskt_index)
            msg = str(exc)
            if msg.startswith("Partial Kaspa multisig signature saved"):
                raise ValueError(msg) from exc
            have, need = _kaspa_partial_signature_status(updated)
            if need > 0:
                raise ValueError(
                    f"Partial Kaspa multisig signature saved ({have}/{need}). "
                    "Scan or load the next cosigner signature for this same draft."
                ) from exc
            raise
        _save_updated_kaspa_pskt(draft_id, updated, pskt_index)
        return _preserve_input_metadata(unsigned, ready)
    return _preserve_input_metadata(unsigned, merge_signed(unsigned, signed, pskt=pskt))


def import_pskt_hex(pskt_hex: str) -> tuple[dict, dict]:
    pskt = pskt_from_hex(pskt_hex)
    unsigned = pskt_to_seedmask_v2(pskt)
    return pskt, unsigned


def _looks_like_bitcoin_address(addr: str) -> bool:
    a = addr.strip()
    low = a.lower()
    if low.startswith(("bc1", "tb1", "bcrt1")):
        return True
    if a[:1] in "13" and ":" not in a:
        return True
    return False


def validate_bitcoin_address(addr: str) -> str:
    """Validate Bitcoin mainnet payee (native segwit, legacy, or P2SH)."""
    import embit.script as embit_script

    raw = addr.strip()
    if not raw:
        raise ValueError("Address is empty")
    try:
        embit_script.address_to_scriptpubkey(raw)
    except Exception as e:
        msg = str(e) or "Invalid Bitcoin address"
        raise ValueError(
            f"Invalid Bitcoin address. Use a mainnet bc1…, 1…, or 3… address. ({msg})"
        ) from e
    return raw


def _address_script_check(addr: str) -> str:
    """Normalize, Kaspa SDK checksum, then Schnorr P2PK script decode (SeedPass build)."""
    from kaspa import Address

    addr = normalize_kaspa_address(addr)
    try:
        canonical = str(Address(addr))
    except Exception as e:
        msg = str(e) or "Invalid Kaspa address"
        if "checksum" in msg.lower():
            raise ValueError(
                "Invalid Kaspa address (checksum failed). Copy the full mainnet "
                "address from your wallet or explorer (~67 characters including kaspa:). "
                "Do not type it by hand."
            ) from e
        raise ValueError(msg) from e
    try:
        kaspa_address_to_script_hex(canonical)
    except SystemExit as e:
        msg = str(e) or "Invalid Kaspa address"
        if "unsupported kaspa address type" in msg.lower():
            raise ValueError(
                "Recipient must be a standard Kaspa P2PK Schnorr or P2SH multisig address."
            ) from e
        raise ValueError(msg) from e
    return canonical


def validate_address_fast(addr: str, *, coin: str | None = None) -> str:
    """Bech32/checksum only — fast path for Send tab (no RPC/SDK)."""
    return validate_address(addr, coin=coin)


def validate_address(addr: str, *, coin: str | None = None) -> str:
    """Validate recipient (coordinator API / Review step)."""
    raw = addr.strip()
    if coin == "bitcoin" or (coin is None and _looks_like_bitcoin_address(raw)):
        return validate_bitcoin_address(raw)
    return _address_script_check(raw)


def parse_qr_text(text: str) -> str:
    """Accept kaspa:address or JSON coordinator/signed payloads (Kaspa legacy alias)."""
    return parse_payee_qr_text(text, coin="kaspa")


def _extract_payee_from_json(obj: dict) -> str | None:
    for key in ("to_address", "address", "kaspa_address", "bitcoin_address", "receive_address"):
        val = obj.get(key)
        if val:
            return str(val).strip()
    outs = obj.get("outputs") or []
    if outs and isinstance(outs[0], dict):
        o0 = outs[0]
        for key in ("kaspa_address", "address", "to_address"):
            if o0.get(key):
                return str(o0[key]).strip()
    return None


def parse_payee_qr_text(text: str, *, coin: str | None = None) -> str:
    """Accept payee address from QR scan, paste, bitcoin: URI, or payment JSON."""
    t = text.strip()
    c = (coin or "").strip().lower()

    if t.startswith("{"):
        try:
            obj = json.loads(t)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON: {e}") from e
        if not isinstance(obj, dict):
            raise ValueError("Payment JSON must be an object")
        if "signatures" in obj:
            raise ValueError("This looks like a signed QR — use the Sign & Broadcast step")
        extracted = _extract_payee_from_json(obj)
        if extracted:
            return extracted

    if c == "bitcoin" or (not c and _looks_like_bitcoin_address(t)):
        raw = t
        low = t.lower()
        if low.startswith("bitcoin:"):
            raw = t.split("?")[0]
            if raw.lower().startswith("bitcoin:"):
                raw = raw[8:]
        return raw.strip()

    if t.lower().startswith("kaspa:") or (":" not in t and t[:1].lower() in "qpzry9"):
        return normalize_kaspa_address(t)

    raise ValueError(
        "QR must be a valid payee address "
        "(Kaspa kaspa:… or Bitcoin bc1… / 1… / 3…) or payment JSON"
    )


def _gui_error(exc: BaseException) -> ValueError:
    if isinstance(exc, SystemExit):
        msg = str(exc) or "Transaction rejected"
        return ValueError(msg)
    if isinstance(exc, ValueError):
        return exc
    if isinstance(exc, TimeoutError):
        return exc
    msg = str(exc).strip() or "Broadcast failed"
    low = msg.lower()
    if "checkmultisig" in low or "nullfail" in low:
        return ValueError(
            "Multisig signatures did not verify on the node. "
            "Reflash SeedMask firmware, start a new Send in Coordinator, and re-sign on every cosigner "
            "(account 0 and account 2 for 1st kas). Old signed JSON cannot be fixed in place.\n"
            f"Node: {msg}"
        )
    return ValueError(msg)


async def broadcast_ready(ready: dict, on_progress=None) -> str:
    import kaspa_broadcast

    def progress(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    svc = get_service()
    last_exc: BaseException | None = None
    for attempt in range(3):
        try:
            progress("Connecting to Kaspa mainnet…" if attempt == 0 else "Reconnecting to Kaspa mainnet…")
            if attempt > 0:
                await svc._reset_client()
            client = await svc._get_client()
            progress("Building transaction…")
            tx, _fetched = await kaspa_broadcast.ready_to_transaction(ready, client=client)
            progress("Submitting to mainnet…")
            result = await asyncio.wait_for(
                client.submit_transaction({"transaction": tx, "allowOrphan": False}),
                timeout=SUBMIT_TIMEOUT_SEC,
            )
            if isinstance(result, dict):
                return str(result.get("transactionId", result))
            return str(result)
        except asyncio.TimeoutError as e:
            raise TimeoutError(
                "Submit timed out (60s). The tx may still propagate — check kaspa.stream in a minute."
            ) from e
        except BaseException as e:
            last_exc = e
            if attempt < 2 and svc._transient_rpc_error(e):
                continue
            raise _gui_error(e) from e
    raise _gui_error(last_exc or RuntimeError("Broadcast failed"))


def broadcast_ready_sync(ready: dict, on_progress=None) -> str:
    return asyncio.run(broadcast_ready(ready, on_progress=on_progress))


def is_bitcoin_draft(data: dict) -> bool:
    from .bitcoin_psbt import BTC_DRAFT_FORMAT

    if data.get("format") == BTC_DRAFT_FORMAT:
        return True
    if (data.get("coin") or "").strip().lower() == "bitcoin":
        return bool(data.get("psbt_base64") or data.get("psbts"))
    return False


def btc_psbt_base64_list(data: dict) -> list[str]:
    from .bitcoin_psbt import psbt_from_base64

    psbts = data.get("psbts")
    if isinstance(psbts, list) and psbts:
        out = [str(x).strip() for x in psbts if str(x).strip()]
        if out:
            return out
    b64 = data.get("psbt_base64")
    if isinstance(b64, str) and b64.strip():
        psbt_from_base64(b64)
        return [b64.strip()]
    raise ValueError("Bitcoin draft is missing psbt_base64 or psbts")


def save_btc_draft(psbt_bytes: bytes, summary: dict) -> str:
    from .bitcoin_psbt import BTC_DRAFT_FORMAT, psbt_to_base64

    DRAFTS_DIR.mkdir(parents=True, exist_ok=True)
    draft_id = str(uuid.uuid4())
    path = DRAFTS_DIR / f"{draft_id}.json"
    payload = {
        "format": BTC_DRAFT_FORMAT,
        "coin": "bitcoin",
        "psbt_base64": psbt_to_base64(psbt_bytes),
        "summary": summary,
    }
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return draft_id


def _mark_summary_change_used(wallet_id: str | None, summary: dict | None) -> None:
    if not wallet_id or not isinstance(summary, dict):
        return
    idx = summary.get("change_address_index")
    if idx is None:
        return
    try:
        change_idx = int(idx)
    except (TypeError, ValueError):
        return
    if change_idx < 0:
        return
    from .address_usage import mark_change_index_used

    mark_change_index_used(
        str(wallet_id),
        change_idx,
        address=str(summary.get("change_address") or "") or None,
    )


def save_draft_from_build_btc(
    cfg: WalletConfig,
    utxo: WalletUtxo,
    to_address: str,
    send_sats: int,
    *,
    fee_sats: int | None = None,
    rbf: bool = False,
) -> tuple[str, bytes, dict]:
    return save_draft_from_build_btc_multi(
        cfg, [utxo], to_address, send_sats, fee_sats=fee_sats, rbf=rbf
    )


def save_draft_from_build_btc_multi(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    to_address: str,
    send_sats: int,
    *,
    fee_sats: int | None = None,
    rbf: bool = False,
) -> tuple[str, bytes, dict]:
    from .bitcoin_psbt import build_psbt_multi_input

    psbt_bytes, summary = build_psbt_multi_input(
        cfg, utxos, to_address, send_sats, fee_sats=fee_sats, rbf=rbf
    )
    draft_id = save_btc_draft(psbt_bytes, summary)
    return draft_id, psbt_bytes, summary


def save_draft_from_rbf_bump(
    cfg: WalletConfig,
    original_tx: dict,
    *,
    receive_pairs: list[tuple[int, str]],
    change_pairs: list[tuple[int, str]],
    new_fee_sats: int,
) -> tuple[str, bytes, dict]:
    from .bitcoin_psbt import build_rbf_bump_psbt

    psbt_bytes, summary = build_rbf_bump_psbt(
        cfg,
        original_tx,
        receive_pairs=receive_pairs,
        change_pairs=change_pairs,
        new_fee_sats=new_fee_sats,
    )
    draft_id = save_btc_draft(psbt_bytes, summary)
    return draft_id, psbt_bytes, summary


def save_draft_from_build_kaspa_generator(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    to_address: str,
    send_sompi: int,
    *,
    priority_fee: int | None = None,
    target_fee_sompi: int | None = None,
) -> tuple[str, dict, dict, dict]:
    from .kaspa_generator import build_single_transaction

    pskt, unsigned, summary = build_single_transaction(
        cfg,
        utxos,
        to_address=to_address,
        send_sompi=send_sompi,
        priority_fee=priority_fee,
        target_fee_sompi=target_fee_sompi,
    )
    from .kaspa_generator import enrich_kaspa_multisig_unsigned

    unsigned = enrich_kaspa_multisig_unsigned(unsigned, cfg)
    _validate_pskt_with_wasm(pskt)
    try:
        import sys
        from pathlib import Path

        tools = Path(__file__).resolve().parent.parent / "tools"
        if not tools.is_dir():
            tools = Path(__file__).resolve().parent.parent.parent / "tools"
        if str(tools) not in sys.path:
            sys.path.insert(0, str(tools))
        from kaspa_mass import validate_v2_relay_fee

        validate_v2_relay_fee(unsigned)
    except ImportError:
        pass
    except ValueError as e:
        raise ValueError(str(e)) from e
    draft_id = save_draft(unsigned, pskt=pskt, summary=summary)
    return draft_id, pskt, unsigned, summary


def load_btc_draft(draft_id: str, index: int = 0) -> tuple[bytes, dict]:
    from .bitcoin_psbt import psbt_from_base64

    data = _load_draft_raw(draft_id)
    if not is_bitcoin_draft(data):
        raise ValueError("Draft is not a Bitcoin PSBT")
    b64_list = btc_psbt_base64_list(data)
    if index < 0 or index >= len(b64_list):
        raise ValueError(f"Coin index {index} out of range (0..{len(b64_list) - 1})")
    raw = psbt_from_base64(b64_list[index])
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else {}
    per_coin = data.get("summaries")
    if isinstance(per_coin, list) and 0 <= index < len(per_coin):
        item = per_coin[index]
        if isinstance(item, dict):
            summary = item
    return raw, summary


def export_btc_draft(draft_id: str) -> dict:
    from .bitcoin_psbt import BTC_DRAFT_FORMAT

    data = _load_draft_raw(draft_id)
    if not is_bitcoin_draft(data):
        raise ValueError("Draft is not a Bitcoin PSBT")
    b64_list = btc_psbt_base64_list(data)
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else {}
    return {
        "draft_id": draft_id,
        "unsigned": summary,
        "psbt_base64": b64_list[0],
        "psbts": b64_list,
        "psbt_count": len(b64_list),
        "pskt_count": len(b64_list),
        "format": BTC_DRAFT_FORMAT,
        "coin": "bitcoin",
        "is_sweep": bool(data.get("is_sweep")) or len(b64_list) > 1,
    }


def import_btc_unsigned(unsigned: dict) -> tuple[str, bytes, int]:
    """Persist imported Bitcoin PSBT draft; return (draft_id, first_psbt_bytes, count)."""
    from .bitcoin_psbt import BTC_DRAFT_FORMAT, psbt_from_base64, psbt_to_base64

    DRAFTS_DIR.mkdir(parents=True, exist_ok=True)
    draft_id = str(uuid.uuid4())
    path = DRAFTS_DIR / f"{draft_id}.json"

    if unsigned.get("format") == BTC_DRAFT_FORMAT and (
        unsigned.get("psbt_base64") or unsigned.get("psbts")
    ):
        payload = dict(unsigned)
        payload["draft_id"] = draft_id
        payload["coin"] = "bitcoin"
        b64_list = btc_psbt_base64_list(payload)
    elif isinstance(unsigned.get("psbt_base64"), str) and unsigned["psbt_base64"].strip():
        raw = psbt_from_base64(unsigned["psbt_base64"])
        summary = unsigned.get("summary") if isinstance(unsigned.get("summary"), dict) else {}
        b64_list = [psbt_to_base64(raw)]
        payload = {
            "format": BTC_DRAFT_FORMAT,
            "coin": "bitcoin",
            "psbt_base64": b64_list[0],
            "psbts": b64_list,
            "summary": summary,
        }
    else:
        raise ValueError("Bitcoin import requires psbt_base64 or psbts")

    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return draft_id, psbt_from_base64(b64_list[0]), len(b64_list)


def save_sweep_draft_from_build_btc(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    to_address: str,
    fee_sats_per_tx: int,
) -> tuple[str, list[bytes], dict]:
    from .bitcoin_psbt import BTC_DRAFT_FORMAT, build_psbt_sweep, psbt_to_base64

    if not utxos:
        raise ValueError("sweep requires at least one UTXO")
    if fee_sats_per_tx < 0:
        raise ValueError("fee_sats_per_tx must be non-negative")

    psbt_list, summaries = build_psbt_sweep(
        cfg, utxos, to_address, fee_sats_per_tx=fee_sats_per_tx
    )
    b64_list = [psbt_to_base64(p) for p in psbt_list]
    total_send = sum(int(s.get("send_sats") or 0) for s in summaries)
    first = summaries[0] if summaries else {}
    draft_id = str(uuid.uuid4())
    path = DRAFTS_DIR / f"{draft_id}.json"
    payload = {
        "format": BTC_DRAFT_FORMAT,
        "coin": "bitcoin",
        "is_sweep": True,
        "psbts": b64_list,
        "psbt_base64": b64_list[0],
        "summaries": summaries,
        "summary": {
            "coin": "bitcoin",
            "is_sweep": True,
            "utxo_count": len(utxos),
            "fee_sats_per_tx": fee_sats_per_tx,
            "fee_sompi_per_tx": fee_sats_per_tx,
            "first_send_sats": first.get("send_sats"),
            "send_sats": first.get("send_sats"),
            "send_sompi": first.get("send_sats"),
            "send_btc": first.get("send_btc"),
            "total_send_sats": total_send,
            "total_send_sompi": total_send,
            "total_fee_sats": fee_sats_per_tx * len(utxos),
            "to_address": to_address,
            "from_address": first.get("from_address"),
            "note": "Sign each coin on SeedMask, then broadcast all together.",
        },
    }
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return draft_id, psbt_list, payload["summary"]


def btc_sweep_qr_for_draft_index(
    draft_id: str,
    index: int,
    *,
    qr_display_mode: str = "animated",
) -> dict:
    from .ur_qr_psbt import fountain_qr_frames_base64_psbt

    data = _load_draft_raw(draft_id)
    if not is_bitcoin_draft(data):
        raise ValueError("Not a Bitcoin PSBT draft")
    b64_list = btc_psbt_base64_list(data)
    if index < 0 or index >= len(b64_list):
        raise ValueError(f"Coin index {index} out of range (0..{len(b64_list) - 1})")
    from .bitcoin_psbt import psbt_from_base64

    psbt_bytes = psbt_from_base64(b64_list[index])
    qr_pack = fountain_qr_frames_base64_psbt(psbt_bytes, qr_display_mode=qr_display_mode)
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else {}
    per_coin = data.get("summaries")
    if isinstance(per_coin, list) and 0 <= index < len(per_coin):
        item = per_coin[index]
        if isinstance(item, dict):
            summary = {**summary, **item}
    return {
        "draft_id": draft_id,
        "coin": "bitcoin",
        "psbt_index": index,
        "psbt_count": len(b64_list),
        "pskt_index": index,
        "pskt_count": len(b64_list),
        "unsigned": summary,
        **qr_pack,
        "summary": {
            **summary,
            "is_sweep": len(b64_list) > 1,
            "utxo_count": len(b64_list),
            "sweep_index": index,
        },
    }


def merge_signed_btc_for_draft(draft_id: str, signed: dict) -> dict:
    from .bitcoin_psbt import psbt_to_base64, signed_psbt_bytes

    _psbt_raw, summary = load_btc_draft(draft_id)
    signed_raw = signed_psbt_bytes(signed)
    return {
        "format": "bitcoin_psbt_ready",
        "coin": "bitcoin",
        "psbt_base64": psbt_to_base64(signed_raw),
        "summary": summary,
    }


async def broadcast_btc_signed(draft_id: str, signed: dict, on_progress=None) -> str:
    from .bitcoin_psbt import broadcast_raw_tx, finalize_signed_psbt, signed_psbt_bytes

    def progress(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    signed_raw = signed_psbt_bytes(signed)
    progress("Finalizing PSBT…")
    raw_tx = finalize_signed_psbt(signed_raw)
    progress("Broadcasting to Bitcoin mainnet…")
    return await broadcast_raw_tx(raw_tx)


def broadcast_btc_signed_sync(draft_id: str, signed: dict, on_progress=None) -> str:
    return asyncio.run(broadcast_btc_signed(draft_id, signed, on_progress=on_progress))


async def broadcast_for_draft(
    draft_id: str, signed: dict, on_progress=None, pskt_index: int = 0
) -> str:
    data = _load_draft_raw(draft_id)
    if is_bitcoin_draft(data):
        return await broadcast_btc_signed(draft_id, signed, on_progress=on_progress)
    ready = merge_signed_for_draft(draft_id, signed, pskt_index=pskt_index)
    return await broadcast_ready(ready, on_progress=on_progress)


def broadcast_for_draft_sync(
    draft_id: str, signed: dict, on_progress=None, pskt_index: int = 0
) -> str:
    data = _load_draft_raw(draft_id)
    if is_bitcoin_draft(data):
        return broadcast_btc_signed_sync(draft_id, signed, on_progress=on_progress)
    ready = merge_signed_for_draft(draft_id, signed, pskt_index=pskt_index)
    return broadcast_ready_sync(ready, on_progress=on_progress)
