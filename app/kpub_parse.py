"""Extract Kaspa kpub / Bitcoin xpub from pasted text or scanned QR payloads."""

from __future__ import annotations

import hashlib
import json
import re

from .btc_script import (
    parse_multisig_quorum,
    script_type_from_derivation,
    script_type_from_xpub_prefix,
)
_BRACKET_COSIGNER_RE = re.compile(
    r"\[([^\]]+)\]((?:xpub|ypub|zpub|tpub|upub|vpub)[a-zA-Z0-9]+)",
    re.IGNORECASE,
)

_KPUB_RE = re.compile(r"(kpub[a-zA-Z0-9]{80,})")
_XPUB_RE = re.compile(r"((?:xpub|ypub|zpub|tpub|upub|vpub)[a-zA-Z0-9]{80,})")
# SLIP-132 version → singlesig account prefix (child_num is account).
_BTC_VERSION_PATHS = {
    # Standard BIP32 xpub/tpub is ambiguous (Legacy / Native SegWit / Taproot) — do not invent a path.
    bytes([0x04, 0x9D, 0x7C, 0xB2]): "m/49'/0'",  # ypub
    bytes([0x04, 0xB2, 0x47, 0x46]): "m/84'/0'",  # zpub
    bytes([0x04, 0x5F, 0x1C, 0xF6]): "m/84'/1'",  # vpub
}
# SLIP-132 multisig versions: child_num is script type (1'/2'), not account — fixed BIP48 paths.
_BTC_MULTISIG_VERSION_PATHS = {
    bytes([0x02, 0x95, 0xB4, 0x3F]): "m/48'/0'/0'/1'",  # Ypub (P2WSH-P2SH)
    bytes([0x02, 0xAA, 0x7E, 0xD3]): "m/48'/0'/0'/2'",  # Zpub (P2WSH)
}
_BTC_PREFIX_PATHS = {
    "ypub": "m/49'/0'",
    "upub": "m/49'/1'",
    "zpub": "m/84'/0'",
    "vpub": "m/84'/1'",
}
_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_XFP_RE = re.compile(
    r'(?:["\']?(?:xfp|master_fingerprint|fingerprint)["\']?\s*[:=]\s*["\']?|SM\|)([A-Fa-f0-9]{8})',
    re.IGNORECASE,
)
_DERIV_RE = re.compile(r"m/(?:44|49|84|86)'/0'/\d+'", re.IGNORECASE)


def extract_kpub(raw: str) -> str:
    """Return normalized kpub or raise ValueError."""
    text = (raw or "").strip()
    if not text:
        raise ValueError("Empty scan — try again")

    if text.lower().startswith("ur:"):
        text = _decode_ur_bytes(text)

    if text.startswith("{"):
        try:
            obj = json.loads(text)
            for key in ("kpub", "xpub", "extended_public_key", "watch_only_key"):
                val = obj.get(key)
                if isinstance(val, str) and val.lower().startswith("kpub"):
                    return _normalize_kpub(val)
        except json.JSONDecodeError:
            pass

    match = _KPUB_RE.search(text.replace("\n", " "))
    if match:
        return _normalize_kpub(match.group(1))

    tokens = text.split()
    for token in reversed(tokens):
        if token.lower().startswith("kpub"):
            return _normalize_kpub(token)

    raise ValueError("No kpub found — scan the watch-only QR from SeedMask")


def _normalize_kpub(s: str) -> str:
    key = s.strip()
    if not key.lower().startswith("kpub"):
        raise ValueError("Expected a Kaspa watch-only key (kpub)")
    if len(key) < 100:
        raise ValueError("Key looks too short — export again from SeedMask")
    return key


def _decode_ur_bytes(ur: str) -> str:
    from .bcur.cbor_lite import CBORDecoder
    from .bcur.ur_decoder import URDecoder

    dec = URDecoder()
    if not dec.receive_part(ur.strip()):
        raise ValueError("Incomplete UR — scan all parts or paste kpub text")
    if not dec.is_complete() or not dec.is_success():
        raise ValueError("Incomplete UR — scan all parts or paste kpub text")
    ur_obj = dec.result_message()
    cbor_dec = CBORDecoder(list(ur_obj.cbor))
    value, _ = cbor_dec.decodeBytes()
    return value.decode("utf-8", errors="replace")


def _b58decode(s: str) -> bytes:
    raw = s.strip()
    if not raw:
        raise ValueError("Empty key")
    num = 0
    for ch in raw:
        idx = _B58_ALPHABET.find(ch)
        if idx < 0:
            raise ValueError("Invalid base58 character in kpub")
        num = num * 58 + idx
    pad = 0
    for ch in raw:
        if ch == "1":
            pad += 1
        else:
            break
    full = num.to_bytes((num.bit_length() + 7) // 8, "big") if num else b""
    return b"\x00" * pad + full


def _b58decode_check(s: str) -> bytes:
    payload = _b58decode(s)
    if len(payload) < 5:
        raise ValueError("Invalid kpub encoding")
    data, checksum = payload[:-4], payload[-4:]
    expected = hashlib.sha256(hashlib.sha256(data).digest()).digest()[:4]
    if checksum != expected:
        raise ValueError("Invalid kpub checksum")
    return data


def _normalize_xfp(raw: str | None) -> str | None:
    if not raw:
        return None
    cleaned = "".join(str(raw).strip().split()).upper()
    if len(cleaned) != 8 or any(ch not in "0123456789ABCDEF" for ch in cleaned):
        return None
    return cleaned


_PLACEHOLDER_FINGERPRINTS = frozenset(
    {
        "00000000",
        "11111111",
        "12345678",
        "AAAAAAAA",
        "DDDDDDDD",
        "FFFFFFFF",
    }
)


def is_placeholder_fingerprint(raw: str | None) -> bool:
    fp = _normalize_xfp(raw)
    return bool(fp and fp in _PLACEHOLDER_FINGERPRINTS)


def resolve_bitcoin_master_fingerprint(
    kpub: str,
    stored_fp: str | None = None,
) -> str:
    """Master fingerprint for PSBT BIP32 fields (must match SeedMask seed, not xpub parent fp)."""
    fp = _normalize_xfp(stored_fp)
    if fp and not is_placeholder_fingerprint(fp):
        return fp

    text = (kpub or "").strip()
    for parser in (_parse_seedmask_compact, _parse_bitcoin_export_json):
        wrapped = parser(text)
        if not wrapped:
            continue
        cand = _normalize_xfp(wrapped.get("fingerprint"))
        if cand and not is_placeholder_fingerprint(cand):
            return cand

    if is_placeholder_fingerprint(fp):
        raise ValueError(
            f"Wallet fingerprint {fp} is a placeholder. "
            "Re-import from SeedMask using the Bitcoin watch-only QR (SM|xfp|m/84'/0'/0'|zpub…)."
        )
    raise ValueError(
        "Master fingerprint is required for Bitcoin PSBT signing. "
        "Re-import the wallet from SeedMask (watch-only QR includes xfp)."
    )


def _parse_seedmask_compact(text: str) -> dict | None:
    raw = (text or "").strip()
    if not raw.upper().startswith("SM|"):
        return None
    parts = raw.split("|")
    if len(parts) == 3:
        _, xfp_raw, xpub_raw = parts
        deriv_raw = None
    elif len(parts) >= 4:
        _, xfp_raw, deriv_raw, xpub_raw = parts[0], parts[1], parts[2], "|".join(parts[3:])
    else:
        return None
    raw_key = xpub_raw.strip()
    try:
        xpub = _normalize_kpub(raw_key) if raw_key.lower().startswith("kpub") else _normalize_xpub(raw_key)
    except ValueError:
        return None
    deriv = (deriv_raw or "").strip()
    derivation = deriv if deriv.startswith("m/") else None
    return {
        "xpub": xpub,
        "derivation": derivation,
        "fingerprint": _normalize_xfp(xfp_raw),
        "format": "seedmask_export",
    }


def _parse_seedmask_connect(text: str) -> dict | None:
    """SeedMask Coordinator pairing JSON (from Connect software → SeedMask animated UR)."""
    raw = (text or "").strip()
    if not raw.startswith("{"):
        return None
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    if str(obj.get("format") or "").strip().lower() != "seedmask_connect":
        # Also accept Sparrow-style multi-script bundles (bip84/…) without the marker.
        if not any(k in obj for k in ("bip84", "bip49", "bip44", "bip86", "bip48_2", "bip48_1", "bip45")):
            return None
        if "xfp" not in obj and "fingerprint" not in obj:
            return None

    coin = str(obj.get("coin") or "").strip().lower()
    policy = str(obj.get("policy") or "").strip().lower()
    xfp = _normalize_xfp(obj.get("xfp") or obj.get("fingerprint"))
    account = obj.get("account")
    try:
        account_i = int(account) if account is not None else None
    except (TypeError, ValueError):
        account_i = None

    if coin == "kaspa" or str(obj.get("kpub") or "").lower().startswith("kpub"):
        kpub = obj.get("kpub")
        if not isinstance(kpub, str):
            return None
        deriv = obj.get("deriv") or obj.get("derivation")
        info = kpub_wallet_info(
            kpub,
            derivation=deriv if isinstance(deriv, str) else None,
            fingerprint=xfp,
        )
        info["format"] = "seedmask_connect"
        info["policy_type"] = "multisig" if policy == "multisig" else "singlesig"
        if account_i is not None:
            info["account"] = account_i
        return info

    block_map = (
        ("bip84", "native_segwit", "Native SegWit"),
        ("bip49", "nested_segwit", "Nested SegWit"),
        ("bip44", "legacy", "Legacy"),
        ("bip86", "taproot", "Taproot"),
        ("bip48_2", "native_segwit", "Native SegWit"),
        ("bip48_1", "nested_segwit", "Nested SegWit"),
        ("bip45", "legacy", "Legacy"),
    )
    options: list[dict] = []
    for key, script_type, label in block_map:
        block = obj.get(key)
        if not isinstance(block, dict):
            continue
        xpub_raw = block.get("xpub") or block.get("ypub") or block.get("zpub")
        if not isinstance(xpub_raw, str):
            continue
        try:
            xpub = _normalize_xpub(xpub_raw)
        except ValueError:
            continue
        deriv = block.get("deriv") or block.get("derivation")
        deriv_s = deriv.strip() if isinstance(deriv, str) and deriv.strip().startswith("m/") else None
        options.append(
            {
                "script_type": script_type,
                "label": label,
                "derivation": deriv_s or "",
                "xpub": xpub,
            }
        )
    if not options:
        return None

    # Keep a neutral default — the Mac UI picks from script_options using the
    # script type / policy the user already selected (e.g. Taproot, not Native SegWit).
    preferred = options[0]
    meta = xpub_wallet_info(
        preferred["xpub"],
        derivation=preferred["derivation"] or None,
        fingerprint=xfp,
        script_type=preferred["script_type"],
    )
    meta["format"] = "seedmask_connect"
    # Honor explicit policy from SeedMask. Do not flip to multisig merely because
    # a multi-script bundle also lists bip48 keys (singlesig exports never do).
    if policy in ("multisig", "singlesig"):
        meta["policy_type"] = policy
    elif any(k in obj for k in ("bip48_2", "bip48_1", "bip45")) and not any(
        k in obj for k in ("bip84", "bip86", "bip49", "bip44")
    ):
        meta["policy_type"] = "multisig"
    else:
        meta["policy_type"] = "singlesig"
    meta["script_options"] = options
    if account_i is not None:
        meta["account"] = account_i
    return meta


def _parse_bitcoin_export_json(text: str) -> dict | None:
    if not text.strip().startswith("{"):
        return None
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None

    xpub = None
    for key in ("xpub", "ypub", "zpub", "tpub", "upub", "vpub", "extended_public_key", "watch_only_key"):
        val = obj.get(key)
        if isinstance(val, str) and val[:4].lower() in _BTC_PREFIX_PATHS:
            xpub = _normalize_xpub(val)
            break
    if not xpub:
        return None

    deriv = obj.get("deriv") or obj.get("derivation")
    if isinstance(deriv, str) and deriv.strip().startswith("m/"):
        derivation = deriv.strip()
    else:
        derivation = None

    xfp = _normalize_xfp(obj.get("xfp") or obj.get("master_fingerprint") or obj.get("fingerprint"))
    return {"xpub": xpub, "derivation": derivation, "fingerprint": xfp}


def _parse_multisig_policy_from_text(text: str) -> tuple[int, int] | None:
    """Extract M-of-N from Passport/Sparrow/SeedMask policy export lines."""
    for line in (text or "").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.lower().startswith("policy:"):
            payload = stripped.split(":", 1)[1].strip()
            parsed = parse_multisig_quorum(payload)
            if parsed:
                return parsed
    return parse_multisig_quorum(text)


def _attach_multisig_quorum(meta: dict, raw_text: str) -> dict:
    parsed = _parse_multisig_policy_from_text(raw_text)
    if parsed:
        meta["multisig_m"], meta["multisig_n"] = parsed
    return meta


def _script_type_from_export_format(fmt: str) -> str:
    key = (fmt or "").strip().lower().replace(" ", "").replace("-", "")
    if key in {"p2shp2wsh", "p2sh_p2wsh", "nestedsegwit"}:
        return "nested_segwit"
    if key in {"p2sh", "legacy"}:
        return "legacy"
    if key in {"p2wsh", "nativesegwit", "segwit"}:
        return "native_segwit"
    return ""


def _parse_bracket_cosigner(inside: str, xpub: str) -> dict:
    fp = ""
    deriv = ""
    label = ""
    chunk = (inside or "").strip()
    slash = chunk.find("/")
    if slash >= 0:
        head, tail = chunk[:slash], chunk[slash + 1 :]
        if _normalize_xfp(head):
            fp = _normalize_xfp(head) or ""
            deriv = f"m/{tail}" if tail else ""
        else:
            deriv = f"m/{chunk}" if chunk else ""
    elif _normalize_xfp(chunk):
        fp = _normalize_xfp(chunk) or ""
    else:
        label = chunk
    return {
        "xpub": xpub,
        "fingerprint": fp,
        "derivation": deriv,
        "label": label,
    }


def _parse_descriptor_cosigners(text: str) -> list[dict]:
    cosigners: list[dict] = []
    seen: set[str] = set()
    for match in _BRACKET_COSIGNER_RE.finditer(text or ""):
        inside, xpub_raw = match.group(1), match.group(2)
        try:
            xpub = _normalize_xpub(xpub_raw)
        except ValueError:
            continue
        if xpub in seen:
            continue
        seen.add(xpub)
        cosigners.append(_parse_bracket_cosigner(inside, xpub))
    return cosigners


def _parse_passport_multisig_export(text: str) -> dict | None:
    """Parse Sparrow/Passport/SeedMask multisig policy text with multiple cosigner xpubs."""
    raw = (text or "").strip()
    if not raw:
        return None
    # Compact SeedMask watch-only export is singlesig (or one cosigner key) — never multisig policy text.
    if raw.upper().startswith("SM|"):
        return None
    cosigners: list[dict] = _parse_descriptor_cosigners(raw)
    derivation = ""
    export_format = ""
    wallet_name = ""
    pending_fp = ""
    quorum = _parse_multisig_policy_from_text(raw)

    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        lower = stripped.lower()
        if lower.startswith("name:"):
            wallet_name = stripped.split(":", 1)[1].strip()
            continue
        if lower.startswith("derivation:"):
            derivation = stripped.split(":", 1)[1].strip()
            continue
        if lower.startswith("format:"):
            export_format = stripped.split(":", 1)[1].strip()
            continue
        if lower.startswith("xfp:"):
            pending_fp = _normalize_xfp(stripped.split(":", 1)[1].strip()) or ""
            continue

        if cosigners:
            continue

        fp = ""
        scan_line = stripped
        if ":" in stripped:
            head, tail = stripped.split(":", 1)
            head_fp = _normalize_xfp(head.strip())
            if head_fp:
                fp = head_fp
                scan_line = tail.strip()
            elif head.strip().lower() == "fp":
                parts = tail.strip().split()
                if parts:
                    head_fp = _normalize_xfp(parts[0])
                    if head_fp:
                        fp = head_fp
                        scan_line = " ".join(parts[1:]) if len(parts) > 1 else tail.strip()

        match = _XPUB_RE.search(scan_line.replace("\n", " "))
        if not match:
            continue
        try:
            xpub = _normalize_xpub(match.group(1))
        except ValueError:
            continue
        cosigner_fp = fp or pending_fp or ""
        pending_fp = ""
        cosigners.append(
            {
                "xpub": xpub,
                "fingerprint": cosigner_fp,
                "derivation": derivation,
                "label": "",
            }
        )

    # A lone xpub line (e.g. SM|…|xpub or bare xpub) is not a multisig wallet export.
    if not cosigners:
        return None
    if len(cosigners) == 1 and not quorum and not wallet_name and not export_format:
        return None
    if len(cosigners) < 1 and not quorum:
        return None

    for idx, cosigner in enumerate(cosigners):
        if not cosigner.get("derivation") and derivation:
            cosigner["derivation"] = derivation
        if not cosigner.get("label"):
            cosigner["label"] = f"Cosigner {idx + 1}"

    script_type = _script_type_from_export_format(export_format)
    if not script_type and derivation:
        script_type = script_type_from_derivation(derivation)

    result: dict = {
        "xpub": cosigners[0]["xpub"],
        "derivation": derivation or cosigners[0].get("derivation") or None,
        "fingerprint": cosigners[0].get("fingerprint") or None,
        "multisig_cosigners": cosigners,
        "policy_type": "multisig",
        "wallet_name": wallet_name,
    }
    if script_type:
        result["script_type"] = script_type
    if quorum:
        result["multisig_m"], result["multisig_n"] = quorum
    elif len(cosigners) >= 2:
        result["multisig_m"] = min(2, len(cosigners))
        result["multisig_n"] = len(cosigners)
    else:
        result["multisig_m"] = 1
        result["multisig_n"] = len(cosigners)
    return result


def _attach_multisig_import(meta: dict, raw_text: str) -> dict:
    wrapped = _parse_passport_multisig_export(raw_text)
    if not wrapped:
        return _attach_multisig_quorum(meta, raw_text)
    meta.update(
        {
            "kpub": wrapped["xpub"],
            "derivation": wrapped.get("derivation") or meta.get("derivation") or "",
            "fingerprint": wrapped.get("fingerprint") or meta.get("fingerprint") or "",
            "multisig_cosigners": wrapped.get("multisig_cosigners") or [],
            "policy_type": "multisig",
        }
    )
    if wrapped.get("multisig_m") and wrapped.get("multisig_n"):
        meta["multisig_m"] = wrapped["multisig_m"]
        meta["multisig_n"] = wrapped["multisig_n"]
    if wrapped.get("script_type"):
        meta["script_type"] = wrapped["script_type"]
    if wrapped.get("wallet_name"):
        meta["wallet_name"] = wrapped["wallet_name"]
    return meta


def _parse_bitcoin_export_payload(text: str) -> dict | None:
    raw = (text or "").strip()
    if not raw:
        return None
    if raw.lower().startswith("ur:"):
        try:
            raw = _decode_ur_bytes(raw)
        except ValueError:
            return None
    # Compact SM|xfp|path|xpub must win over the Passport multisig line scanner
    # (which otherwise treats a Taproot export as 1-of-1 Multisig Native SegWit).
    compact = _parse_seedmask_compact(raw)
    if compact:
        return compact
    connect = _parse_seedmask_connect(raw)
    if connect:
        return connect
    passport = _parse_passport_multisig_export(raw)
    if passport:
        return passport
    wrapped = _parse_bitcoin_export_json(raw)
    if wrapped:
        return wrapped
    xfp = None
    m = _XFP_RE.search(raw)
    if m:
        xfp = _normalize_xfp(m.group(1))
    deriv = None
    dm = _DERIV_RE.search(raw)
    if dm:
        deriv = dm.group(0)
    match = _XPUB_RE.search(raw.replace("\n", " "))
    if not match:
        return None
    try:
        xpub = _normalize_xpub(match.group(1))
    except ValueError:
        return None
    if not (xfp or deriv):
        return None
    return {"xpub": xpub, "derivation": deriv, "fingerprint": xfp}


def kpub_wallet_info(kpub: str, *, derivation: str | None = None, fingerprint: str | None = None) -> dict:
    """Derivation + fingerprint matching SeedMask Kaspa kpub export UI."""
    key = _normalize_kpub("".join(kpub.strip().split()))
    data = _b58decode_check(key)
    if len(data) != 78:
        raise ValueError("Invalid extended key length")
    parent_fp = int.from_bytes(data[5:9], "big")
    child_num = int.from_bytes(data[9:13], "big")
    if child_num < 0x80000000:
        raise ValueError("Expected hardened account in kpub")
    account = child_num - 0x80000000
    default_derivation = f"m/44'/111111'/{account}'"
    deriv = derivation if derivation and derivation.startswith("m/") else default_derivation
    fp = _normalize_xfp(fingerprint) or f"{parent_fp:08X}"
    return {
        "kpub": key,
        "coin": "kaspa",
        "derivation": deriv,
        "fingerprint": fp,
        "script_type": "",
        "account": account,
    }


def extract_xpub(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        raise ValueError("Empty scan — try again")

    for parser in (_parse_seedmask_compact, _parse_bitcoin_export_json):
        wrapped = parser(text)
        if wrapped:
            return wrapped["xpub"]

    if text.startswith("{"):
        try:
            obj = json.loads(text)
            for key in ("xpub", "ypub", "zpub", "extended_public_key", "watch_only_key"):
                val = obj.get(key)
                if isinstance(val, str) and val[:1].lower() in "xyztuv":
                    return _normalize_xpub(val)
        except json.JSONDecodeError:
            pass
    match = _XPUB_RE.search(text.replace("\n", " "))
    if match:
        return _normalize_xpub(match.group(1))
    tokens = text.split()
    for token in reversed(tokens):
        if token[:1].lower() in "xyztuv" and token[1:4].isalpha():
            return _normalize_xpub(token)
    raise ValueError("No xpub found — scan the watch-only QR from SeedMask")


def _normalize_xpub(s: str) -> str:
    key = "".join(s.strip().split())
    prefix = key[:4].lower()
    if prefix not in {"xpub", "ypub", "zpub", "tpub", "upub", "vpub"}:
        raise ValueError("Expected a Bitcoin watch-only key (xpub / ypub / zpub)")
    if len(key) < 100:
        raise ValueError("Key looks too short — export again from SeedMask")
    return key


def _btc_derivation_from_key(key: str, account: int, explicit: str | None = None) -> str:
    if explicit:
        return explicit
    prefix = key[:4].lower()
    # Bare xpub/tpub: leave derivation empty so the UI keeps the script type the user picked
    # (e.g. Taproot → m/86'). Only ypub/zpub (and SLIP-132 versions) imply a path.
    if prefix in {"xpub", "tpub"}:
        return ""
    try:
        version = _b58decode_check(key)[:4]
    except Exception:
        version = b""
    # Multisig Ypub/Zpub must not fall through to ypub/zpub prefix → m/49' / m/84'.
    ms_path = _BTC_MULTISIG_VERSION_PATHS.get(version)
    if ms_path:
        return ms_path
    path_prefix = _BTC_VERSION_PATHS.get(version) or _BTC_PREFIX_PATHS.get(prefix)
    if not path_prefix:
        return ""
    return f"{path_prefix}/{account}'"


def xpub_wallet_info(
    xpub: str,
    *,
    derivation: str | None = None,
    fingerprint: str | None = None,
    script_type: str | None = None,
) -> dict:
    from .btc_script import policy_type_from_derivation

    key = _normalize_xpub("".join(xpub.strip().split()))
    data = _b58decode_check(key)
    if len(data) != 78:
        raise ValueError("Invalid extended key length")
    child_num = int.from_bytes(data[9:13], "big")
    if child_num < 0x80000000:
        raise ValueError("Expected hardened account in xpub")
    version = data[:4]
    # BIP48 cosigner xpubs use child_num as script type (1'/2'), not account index.
    if version in _BTC_MULTISIG_VERSION_PATHS:
        account = 0
    else:
        account = child_num - 0x80000000
    deriv = _btc_derivation_from_key(key, account, derivation)
    fp = _normalize_xfp(fingerprint) or ""
    st = (script_type or "").strip().lower()
    if not st:
        st = script_type_from_derivation(deriv) or script_type_from_xpub_prefix(key)
    meta = {
        "kpub": key,
        "coin": "bitcoin",
        "derivation": deriv,
        "fingerprint": fp,
        "script_type": st,
        "account": account,
        "multisig_cosigners": [],
    }
    policy = policy_type_from_derivation(deriv)
    if policy:
        meta["policy_type"] = policy
    return meta


def extended_key_wallet_info(raw: str, coin: str | None = None) -> dict:
    coin_key = (coin or "").strip().lower()
    text = (raw or "").strip()
    if text.lower().startswith("ur:"):
        try:
            text = _decode_ur_bytes(text)
        except ValueError:
            pass

    connect = _parse_seedmask_connect(text)
    if connect:
        connect_coin = str(connect.get("coin") or "").lower()
        if coin_key and connect_coin and coin_key != connect_coin:
            raise ValueError(f"This QR is for {connect_coin}, but the form is set to {coin_key}")
        if connect.get("script_options"):
            return connect
        if connect_coin == "kaspa" or str(connect.get("kpub") or "").lower().startswith("kpub"):
            return connect

    if coin_key != "kaspa":
        wrapped = _parse_bitcoin_export_payload(text)
        if wrapped and wrapped.get("script_options"):
            return wrapped
        if wrapped and wrapped.get("format") == "seedmask_connect":
            return wrapped
        if wrapped:
            meta = xpub_wallet_info(
                wrapped["xpub"],
                derivation=wrapped.get("derivation"),
                fingerprint=wrapped.get("fingerprint"),
            )
            if wrapped.get("format"):
                meta["format"] = wrapped["format"]
            # SM|xfp|m/86'/…|xpub is singlesig Taproot — never treat as multisig.
            if wrapped.get("format") == "seedmask_export":
                from .btc_script import policy_type_from_derivation

                meta["policy_type"] = policy_type_from_derivation(meta.get("derivation")) or "singlesig"
                if not meta.get("script_type"):
                    meta["script_type"] = script_type_from_derivation(meta.get("derivation") or "") or ""
                return meta
            return _attach_multisig_import(meta, text)

    if coin_key == "bitcoin":
        meta = xpub_wallet_info(extract_xpub(text))
        return _attach_multisig_import(meta, text)
    if coin_key == "kaspa":
        wrapped = _parse_seedmask_compact(text)
        if wrapped and str(wrapped.get("xpub") or "").lower().startswith("kpub"):
            info = kpub_wallet_info(
                wrapped["xpub"],
                derivation=wrapped.get("derivation"),
                fingerprint=wrapped.get("fingerprint"),
            )
            if wrapped.get("format"):
                info["format"] = wrapped["format"]
            return info
        if connect and str(connect.get("kpub") or "").lower().startswith("kpub"):
            return connect
        return kpub_wallet_info(extract_kpub(text))
    lowered = text.lower()
    if lowered.startswith("kpub") or "kpub" in lowered:
        return kpub_wallet_info(extract_kpub(text))
    return xpub_wallet_info(extract_xpub(text))
