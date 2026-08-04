"""Parse and export Bitcoin output descriptors (Sparrow / BIP380 / BIP389)."""

from __future__ import annotations

import re

from .btc_script import script_type_from_derivation
from .wallet_store import WalletConfig

# Bitcoin Core / Sparrow descriptor checksum charset (not the BIP380 doc ordering).
INPUT_CHARSET = (
    "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~"
    "ijklmnopqrstuvwxyzABCDEFGH`#\"\\ "
)
CHECKSUM_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_GENERATOR = [0xF5DEE51989, 0xA9FDCA3312, 0x1BAB10E32D, 0x3706B1677A, 0x644D626FFD]

_XPUB_PREFIX = r"(?:xpub|ypub|zpub|tpub|upub|vpub)"
_KEY_ORIGIN_RE = re.compile(r"^\[([^\]]+)\]")
_XPUB_TAIL_RE = re.compile(
    rf"^({_XPUB_PREFIX}[a-zA-Z0-9]+)(?:/(?:<([^>]+)>|\*|(\d+))(?:/\*)?)?$",
    re.IGNORECASE,
)
_WPKH_RE = re.compile(r"^wpkh\((.+)\)$", re.IGNORECASE)
_WSH_SORTED_RE = re.compile(r"^wsh\(\s*sortedmulti\((.+)\)\s*\)$", re.IGNORECASE)
_SH_WPKH_RE = re.compile(r"^sh\(\s*wpkh\((.+)\)\s*\)$", re.IGNORECASE)
_SH_WSH_SORTED_RE = re.compile(r"^sh\(\s*wsh\(\s*sortedmulti\((.+)\)\s*\)\s*\)$", re.IGNORECASE)
_SH_SORTED_RE = re.compile(r"^sh\(\s*sortedmulti\((.+)\)\s*\)$", re.IGNORECASE)
_PKH_RE = re.compile(r"^pkh\((.+)\)$", re.IGNORECASE)
_SORTED_MULTI_RE = re.compile(r"^\s*(\d+)\s*,\s*(.+)\s*$", re.IGNORECASE | re.DOTALL)
_FP_RE = re.compile(r"^[0-9a-fA-F]{8}$")


def _descsum_polymod(symbols: list[int]) -> int:
    chk = 1
    for value in symbols:
        top = chk >> 35
        chk = ((chk & 0x7FFFFFFFF) << 5) ^ value
        for i in range(5):
            if (top >> i) & 1:
                chk ^= _GENERATOR[i]
    return chk


def _descsum_expand(text: str) -> list[int] | None:
    groups: list[int] = []
    symbols: list[int] = []
    for char in text:
        if char not in INPUT_CHARSET:
            return None
        value = INPUT_CHARSET.find(char)
        symbols.append(value & 31)
        groups.append(value >> 5)
        if len(groups) == 3:
            symbols.append(groups[0] * 9 + groups[1] * 3 + groups[2])
            groups = []
    if len(groups) == 1:
        symbols.append(groups[0])
    elif len(groups) == 2:
        symbols.append(groups[0] * 3 + groups[1])
    return symbols


def descsum_check(descriptor: str) -> bool:
    """Return True when the descriptor checksum is valid (Bitcoin Core algorithm)."""
    text = (descriptor or "").strip()
    if len(text) < 9 or text[-9] != "#":
        return False
    body, suffix = text[:-9], text[-8:]
    if not all(ch in CHECKSUM_CHARSET for ch in suffix):
        return False
    symbols = _descsum_expand(body)
    if symbols is None:
        return False
    symbols = symbols + [CHECKSUM_CHARSET.find(ch) for ch in suffix]
    return _descsum_polymod(symbols) == 1


def descsum_create(body: str) -> str:
    """Append Bitcoin Core descriptor checksum."""
    symbols = _descsum_expand(body)
    if symbols is None:
        raise ValueError("Descriptor contains invalid characters")
    symbols = symbols + [0] * 8
    checksum = _descsum_polymod(symbols) ^ 1
    suffix = "".join(
        CHECKSUM_CHARSET[(checksum >> (5 * (7 - i))) & 31] for i in range(8)
    )
    return f"{body}#{suffix}"


def strip_descriptor_checksum(descriptor: str) -> str:
    text = " ".join((descriptor or "").strip().split())
    if "#" not in text:
        return text
    body, checksum = text.rsplit("#", 1)
    if len(checksum) == 8 and all(ch in CHECKSUM_CHARSET for ch in checksum):
        return body.strip()
    return text


def origin_path_to_m(origin: str) -> str:
    parts = [p for p in (origin or "").split("/") if p]
    out: list[str] = []
    for part in parts:
        hardened = part.lower().endswith("h") or part.endswith("'")
        num = part.rstrip("h").rstrip("H").rstrip("'")
        out.append(f"{num}'" if hardened else num)
    return "m/" + "/".join(out) if out else ""


def derivation_to_origin(path: str) -> str:
    parts = [p for p in (path or "").strip().split("/") if p and p.lower() != "m"]
    out: list[str] = []
    for part in parts:
        hardened = part.endswith("'") or part.lower().endswith("h")
        num = part.rstrip("'").rstrip("h").rstrip("H")
        out.append(f"{num}h" if hardened else num)
    return "/".join(out)


def _normalize_fingerprint(raw: str | None) -> str:
    fp = re.sub(r"[^0-9a-fA-F]", "", str(raw or ""))
    return fp.lower() if len(fp) == 8 else ""


def _purpose_from_derivation(derivation: str) -> int:
    m = re.search(r"m/(\d+)'", derivation or "")
    return int(m.group(1)) if m else 84


def _account_from_derivation(derivation: str, default: int = 0) -> int:
    parts = [p for p in (derivation or "").split("/") if p and p.lower() != "m"]
    for part in reversed(parts):
        if part.endswith("'"):
            num = part[:-1]
            if num.isdigit():
                return int(num)
    return default


def _script_type_from_wrapper(kind: str) -> str:
    if kind == "sh_wpkh":
        return "nested_segwit"
    if kind == "pkh":
        return "legacy"
    if kind == "sh_sorted":
        return "legacy"
    return "native_segwit"


def _parse_sortedmulti_body(body: str) -> tuple[int, list[str]]:
    m = _SORTED_MULTI_RE.match(body.strip())
    if not m:
        raise ValueError("sortedmulti syntax not recognized")
    required = int(m.group(1))
    rest = m.group(2).strip()
    keys: list[str] = []
    depth = 0
    current: list[str] = []
    for char in rest:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == "," and depth == 0:
            piece = "".join(current).strip()
            if piece:
                keys.append(piece)
            current = []
            continue
        current.append(char)
    piece = "".join(current).strip()
    if piece:
        keys.append(piece)
    if len(keys) < 2:
        raise ValueError("sortedmulti descriptor needs at least two xpubs")
    return required, keys


def _parse_key_expression(expr: str, *, default_derivation: str = "") -> dict:
    text = " ".join((expr or "").strip().split())
    if not text:
        raise ValueError("Empty key expression")

    fingerprint = ""
    derivation = default_derivation
    tail = text

    origin = _KEY_ORIGIN_RE.match(text)
    if origin:
        inside = origin.group(1).strip()
        tail = text[origin.end() :].strip()
        slash = inside.find("/")
        if slash >= 0:
            head, path = inside[:slash].strip(), inside[slash + 1 :].strip()
            if _FP_RE.fullmatch(head):
                fingerprint = head.lower()
                derivation = origin_path_to_m(path) or derivation
        elif _FP_RE.fullmatch(inside):
            fingerprint = inside.lower()

    m = _XPUB_TAIL_RE.match(tail)
    if not m:
        raise ValueError(f"Unrecognized key expression: {expr}")

    xpub = m.group(1)
    multipath = m.group(2)
    single_chain = m.group(3)
    account = _account_from_derivation(derivation, 0)

    if multipath:
        chains = [int(x) for x in multipath.split(";") if x.isdigit()]
        if chains and chains != [0, 1]:
            pass
    elif single_chain is not None:
        chain_num = int(single_chain)
        if derivation and "/48'" in derivation:
            last_h = re.findall(r"/(\d+)'", derivation)
            if last_h and int(last_h[-1]) == chain_num:
                pass
            else:
                account = chain_num
        else:
            account = chain_num

    if not derivation:
        purpose = 84
        if xpub.lower().startswith(("ypub", "upub")):
            purpose = 49
        elif xpub.lower().startswith(("xpub", "tpub")):
            purpose = 44
        derivation = f"m/{purpose}'/0'/{account}'"

    return {
        "xpub": xpub,
        "fingerprint": fingerprint,
        "derivation": derivation,
        "account": account,
    }


def _format_key_expression(
    xpub: str,
    *,
    fingerprint: str = "",
    derivation: str = "",
    multipath: bool = True,
) -> str:
    xpub = (xpub or "").strip()
    fp = _normalize_fingerprint(fingerprint)
    origin = ""
    if fp and derivation:
        origin_path = derivation_to_origin(derivation)
        if origin_path:
            origin = f"[{fp}/{origin_path}]"
    suffix = "<0;1>/*" if multipath else "/*"
    return f"{origin}{xpub}/{suffix}"


def _build_descriptor_body(cfg: WalletConfig) -> str:
    from .btc_multisig import multisig_is_enabled
    from .wallet_store import effective_wallet_account

    if (cfg.coin or "kaspa").strip().lower() != "bitcoin":
        raise ValueError("Output descriptors are only available for Bitcoin wallets")

    account = effective_wallet_account(cfg)
    script_type = (cfg.script_type or "native_segwit").strip().lower()

    if multisig_is_enabled(cfg):
        required = int(cfg.multisig_m or 0)
        cosigners = list(cfg.multisig_cosigners or [])
        parts: list[str] = []
        for cosigner in cosigners:
            xp = str(cosigner.get("xpub") or "").strip()
            if not xp:
                continue
            deriv = str(cosigner.get("derivation") or cfg.derivation or "m/48'/0'/0'/2'").strip()
            if account and f"/{account}'" not in deriv:
                deriv = re.sub(
                    r"m/48'/0'/(\d+)'/2'",
                    f"m/48'/0'/{account}'/2'",
                    deriv,
                    count=1,
                )
            parts.append(
                _format_key_expression(
                    xp,
                    fingerprint=str(cosigner.get("fingerprint") or ""),
                    derivation=deriv,
                )
            )
        if len(parts) < 1:
            raise ValueError("Cannot export multisig descriptor — add cosigner xpubs")
        inner = f"sortedmulti({required}," + ",".join(parts) + ")"
        if script_type == "nested_segwit":
            return f"sh(wsh({inner}))"
        if script_type == "legacy":
            return f"sh({inner})"
        return f"wsh({inner})"

    xpub = (cfg.kpub or "").strip()
    deriv = (cfg.derivation or "").strip()
    if not deriv:
        purpose = 84
        if script_type == "nested_segwit":
            purpose = 49
        elif script_type == "legacy":
            purpose = 44
        deriv = f"m/{purpose}'/0'/{account}'"
    elif account and re.search(r"m/\d+'/0'/(\d+)'", deriv):
        deriv = re.sub(r"(m/\d+'/0'/)(\d+)(')", rf"\g<1>{account}\g<3>", deriv, count=1)

    key = _format_key_expression(
        xpub,
        fingerprint=str(cfg.fingerprint or ""),
        derivation=deriv,
    )
    if script_type == "nested_segwit":
        return f"sh(wpkh({key}))"
    if script_type == "legacy":
        return f"pkh({key})"
    return f"wpkh({key})"


def parse_descriptor(descriptor: str, *, label: str = "Descriptor wallet") -> WalletConfig:
    """Parse Sparrow-style descriptors into WalletConfig."""
    text = strip_descriptor_checksum(descriptor)
    text = " ".join(text.split())
    if not text:
        raise ValueError("Descriptor is empty")

    kind = "wpkh"
    inner = ""
    for pattern, k in (
        (_SH_WSH_SORTED_RE, "wsh_sorted"),
        (_SH_WPKH_RE, "sh_wpkh"),
        (_SH_SORTED_RE, "sh_sorted"),
        (_WSH_SORTED_RE, "wsh_sorted"),
        (_WPKH_RE, "wpkh"),
        (_PKH_RE, "pkh"),
    ):
        m = pattern.match(text)
        if m:
            kind = k
            inner = m.group(1).strip()
            break
    else:
        if text.lower().startswith("wpkh(") or "sortedmulti" in text.lower():
            raise ValueError(
                "Descriptor syntax not recognized — use wpkh([fp/84h/0h/0h]xpub/<0;1>/*) "
                "or wsh(sortedmulti(M,[fp/48h/0h/0h/2h]xpub/<0;1>/*,...))"
            )
        raise ValueError("Unsupported descriptor — only wpkh and wsh(sortedmulti) are supported")

    script_type = _script_type_from_wrapper(kind)

    if "sorted" in kind:
        required, key_exprs = _parse_sortedmulti_body(inner)
        cosigners: list[dict] = []
        for key_expr in key_exprs:
            parsed = _parse_key_expression(key_expr, default_derivation="m/48'/0'/0'/2'")
            cosigners.append(
                {
                    "xpub": parsed["xpub"],
                    "fingerprint": parsed.get("fingerprint") or "",
                    "derivation": parsed.get("derivation") or "m/48'/0'/0'/2'",
                    "label": "",
                }
            )
        primary = cosigners[0]
        account = int(primary.get("account") or _account_from_derivation(str(primary.get("derivation") or ""), 0))
        return WalletConfig(
            id="",
            label=label,
            kpub=str(primary["xpub"]),
            account=account,
            coin="bitcoin",
            derivation=str(primary.get("derivation") or "m/48'/0'/0'/2'"),
            fingerprint=str(primary.get("fingerprint") or ""),
            script_type=script_type,
            policy_type="multisig",
            multisig_m=required,
            multisig_n=len(cosigners),
            multisig_cosigners=cosigners,
        )

    parsed = _parse_key_expression(inner)
    account = int(parsed.get("account") or 0)
    derivation = str(parsed.get("derivation") or "")
    if not derivation:
        purpose = _purpose_from_derivation(derivation)
        if parsed["xpub"].lower().startswith(("ypub", "upub")):
            purpose = 49
        elif parsed["xpub"].lower().startswith(("xpub", "tpub")):
            purpose = 44
        else:
            purpose = 84
        derivation = f"m/{purpose}'/0'/{account}'"
    return WalletConfig(
        id="",
        label=label,
        kpub=str(parsed["xpub"]),
        account=account,
        coin="bitcoin",
        derivation=derivation,
        fingerprint=str(parsed.get("fingerprint") or ""),
        script_type=script_type or script_type_from_derivation(derivation) or "native_segwit",
        policy_type="singlesig",
    )


def wallet_from_descriptor(descriptor: str, *, label: str = "Descriptor wallet") -> WalletConfig:
    text = strip_descriptor_checksum(descriptor)
    text = " ".join(text.strip().split())
    cfg = parse_descriptor(text, label=label)
    if not cfg.script_type:
        cfg.script_type = script_type_from_derivation(cfg.derivation) or "native_segwit"
    cfg.descriptor = text
    return cfg


def export_descriptor(cfg: WalletConfig) -> str:
    """Build Sparrow-compatible descriptor (key origin, multipath, checksum)."""
    body = _build_descriptor_body(cfg)
    return descsum_create(body)


def export_descriptor_chain(cfg: WalletConfig, chain: int) -> str:
    """Watch-only descriptor for receive (0) or change (1) chain."""
    body = _build_descriptor_body(cfg)
    idx = body.rfind(")")
    if idx < 0:
        raise ValueError("Invalid descriptor body")
    chained = body[:idx] + f"/{int(chain)}/*" + body[idx:]
    return descsum_create(chained)
