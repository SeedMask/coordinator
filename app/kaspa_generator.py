"""Single Kaspa transaction builder via rusty-kaspa Generator / create_transactions."""

from __future__ import annotations

import itertools
import sys
from pathlib import Path
from typing import Any

from .kaspa_service import SOMPI_PER_KAS, WalletUtxo, get_service
from .wallet_store import WalletConfig, effective_wallet_account, resolve_kaspa_fingerprint

def _find_tools_dir() -> Path:
    coord = Path(__file__).resolve().parent.parent
    bundled = coord / "tools"
    if bundled.is_dir():
        return bundled
    # Dev fallback — never probe TCC-protected folders (Desktop/Documents/Downloads).
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

from kaspa_coordinator_qr import kaspa_address_to_script_hex, normalize_kaspa_address  # noqa: E402
from kaspa_toccata import (  # noqa: E402
    LEGACY_FALLBACK_RELAY_SOMPI,
    estimate_relay_grams,
    input_v2_fields_from_utxo,
    normalize_covenant_id,
    utxo_entry_dict_from_wallet_utxo,
)
from kaspa_pskt import (  # noqa: E402
    _account_derivation_path,
    _key_source,
    _leaf_derivation_path,
    _norm_txid,
    _parse_spk_wire,
    _signing_pubkey_hex,
    _spk_wire_hex,
    normalize_pskt_inner,
    pskt_to_seedmask_v2,
)


def _is_kaspa_multisig(cfg: WalletConfig) -> bool:
    return (
        (cfg.coin or "kaspa").strip().lower() == "kaspa"
        and (cfg.policy_type or "").strip().lower() == "multisig"
        and bool(cfg.multisig_cosigners)
    )

KASPA_STORAGE_MASS_LIMIT = 100_000
# Toccata relay fees are computed via rusty-kaspa SDK (100 sompi/gram); see kaspa_mass.
KASPA_MIN_SPENDABLE_REMAINDER_SOMPI = 100_000
# Custom-fee target tolerance (Kaspa generator fee steps in ~0.00005 KAS increments).
KASPA_CUSTOM_FEE_TOLERANCE_SOMPI = 5_000
# Signatures add a small amount of mass compared with the unsigned draft.
KASPA_SIGNED_RELAY_FEE_BUFFER_SOMPI = 5_000


def kaspa_unspendable_remainder_message(
    utxos: list[WalletUtxo],
    send_sompi: int,
    *,
    fee_sompi: int | None = None,
    change_sompi: int | None = None,
    max_send_sompi: int | None = None,
) -> str | None:
    """Return a user-facing error when a send would strand unspendable dust in the wallet."""
    total_in = sum(int(u.amount) for u in utxos)
    send = int(send_sompi)
    if send <= 0 or total_in <= send:
        return None
    gross_remainder = total_in - send
    change = max(0, int(change_sompi or 0))
    min_remainder = KASPA_MIN_SPENDABLE_REMAINDER_SOMPI
    min_kas = min_remainder / SOMPI_PER_KAS
    max_send = int(max_send_sompi or 0)

    # Max send spends everything except the network fee.
    if max_send > 0 and send >= max_send - 1_000:
        return None

    if 0 < change < min_remainder:
        return (
            f"This send would create {change / SOMPI_PER_KAS:.8f} KAS change, "
            f"below the minimum spendable amount ({min_kas:.2f} KAS). "
            f"Use Max to send all, or send less."
        )

    if 0 < gross_remainder < min_remainder:
        return (
            f"This send would leave {gross_remainder / SOMPI_PER_KAS:.8f} KAS in your wallet, "
            f"below the minimum spendable amount ({min_kas:.2f} KAS). "
            f"Use Max to send all, or send less."
        )
    return None


def _reject_unspendable_kaspa_remainder(
    utxos: list[WalletUtxo],
    send_sompi: int,
    summary: dict[str, Any],
    *,
    max_send_sompi: int | None = None,
) -> None:
    msg = kaspa_unspendable_remainder_message(
        utxos,
        send_sompi,
        fee_sompi=int(summary.get("fee_sompi") or 0),
        change_sompi=int(summary.get("change_sompi") or 0),
        max_send_sompi=max_send_sompi,
    )
    if msg:
        raise ValueError(msg)


def _kaspa_key_error(exc: KeyError) -> ValueError:
    """Turn rusty-kaspa KeyError into user-facing guidance."""
    msg = str(exc).strip("'\"")
    if "isCoinbase" in msg or "blockDaaScore" in msg or "scriptPublicKey" in msg or "covenantId" in msg:
        return ValueError(
            "Coin metadata from Kaspa mainnet is incomplete. Refresh the wallet, then try again."
        )
    return ValueError(f"Coin data is incomplete ({msg}). Refresh the wallet and try again.")


def _utxo_ref_dict(utxo: WalletUtxo) -> dict[str, Any]:
    addr = normalize_kaspa_address(utxo.address)
    script_hex = kaspa_address_to_script_hex(addr)
    return utxo_entry_dict_from_wallet_utxo(utxo, script_hex=script_hex)


def _utxo_ref_from_wallet_utxo(utxo: WalletUtxo) -> Any:
    from kaspa import UtxoEntryReference

    try:
        return UtxoEntryReference.from_dict(_utxo_ref_dict(utxo))
    except KeyError as exc:
        raise _kaspa_key_error(exc) from exc


def _multisig_policy_for_input(cfg: WalletConfig, chain: int, index: int):
    if not _is_kaspa_multisig(cfg):
        return None
    from kaspa import PublicKeyGenerator
    from kaspa_multisig import normalize_multisig_policy
    from .kaspa_service import normalize_extended_key

    cosigners = list(cfg.multisig_cosigners or [])
    threshold = int(cfg.multisig_m or 0)
    total = int(cfg.multisig_n or len(cosigners))
    if threshold < 1 or threshold > total or len(cosigners) != total:
        raise ValueError("Invalid Kaspa multisig quorum")
    policy_cosigners: list[dict[str, Any]] = []
    account = effective_wallet_account(cfg)
    seen_kpubs: set[str] = set()
    for i, cosigner in enumerate(cosigners, start=1):
        kpub = normalize_extended_key(str(cosigner.get("xpub") or ""))
        if not kpub.startswith("kpub"):
            raise ValueError(f"Cosigner {i}: Kaspa multisig requires kpub keys")
        if kpub in seen_kpubs:
            raise ValueError(
                f"Cosigner {i}: duplicate kpub. Each multisig cosigner must use a distinct "
                "BIP45 account kpub (e.g. m/45'/111111'/0' vs m/45'/111111'/2')."
            )
        seen_kpubs.add(kpub)
        gen = PublicKeyGenerator.from_xpub(kpub)
        pub = gen.change_pubkey(index) if int(chain) else gen.receive_pubkey(index)
        deriv = str(cosigner.get("derivation") or f"m/45'/111111'/{account}'")
        policy_cosigners.append(
            {
                "pubkey": pub.to_string().strip().lower(),
                "fingerprint": str(cosigner.get("fingerprint") or "00000000"),
                "derivation_path": f"{deriv}/{int(chain)}/{int(index)}",
                "label": str(cosigner.get("label") or ""),
            }
        )
    return normalize_multisig_policy(
        threshold=threshold,
        cosigners=policy_cosigners,
        account=account,
    )


def _multisig_xpub_sources(cfg: WalletConfig) -> dict[str, Any]:
    if not _is_kaspa_multisig(cfg):
        return {}
    account = effective_wallet_account(cfg)
    out: dict[str, Any] = {}
    for cosigner in cfg.multisig_cosigners or []:
        kpub = str(cosigner.get("xpub") or "").strip()
        if not kpub:
            continue
        deriv = str(cosigner.get("derivation") or f"m/45'/111111'/{account}'")
        out[kpub] = _key_source(str(cosigner.get("fingerprint") or "00000000"), deriv)
    return out


def _pskt_xpub_sources(
    cfg: WalletConfig,
    *,
    kpub: str,
    fingerprint: str,
    account: int,
) -> dict[str, Any]:
    xpubs: dict[str, Any] = {}
    if _is_kaspa_multisig(cfg):
        xpubs.update(_multisig_xpub_sources(cfg))
    elif kpub.strip():
        fp = (fingerprint or "").strip() or "00000000"
        xpubs[kpub.strip()] = _key_source(fp, _account_derivation_path(account))
    return xpubs


def _pskt_input_from_utxo(cfg: WalletConfig, utxo: WalletUtxo) -> dict[str, Any]:
    """One PSKT input row; multisig includes redeemScript and all cosigner derivations."""
    chain = 1 if utxo.is_change else 0
    sign_index = int(utxo.address_index)
    bip32: dict[str, Any] = {}
    redeem_script_hex = None
    sig_op_count = 1

    if _is_kaspa_multisig(cfg):
        from kaspa_multisig import multisig_p2sh_script_hex, multisig_redeem_script_hex

        policy = _multisig_policy_for_input(cfg, chain, sign_index)
        if policy is None:
            raise ValueError("Invalid Kaspa multisig policy")
        redeem_script_hex = multisig_redeem_script_hex(policy)
        in_script = multisig_p2sh_script_hex(redeem_script_hex)
        sig_op_count = len(policy.cosigners)
        for cosigner in policy.cosigners:
            bip32[cosigner.pubkey] = _key_source(cosigner.fingerprint, cosigner.derivation_path)
    else:
        addr = normalize_kaspa_address(utxo.address)
        in_script = kaspa_address_to_script_hex(addr)
        kpub = (cfg.kpub or "").strip()
        if kpub:
            fp = resolve_kaspa_fingerprint(cfg, kpub) or "00000000"
            account = effective_wallet_account(cfg)
            leaf_path = _leaf_derivation_path(account, chain, sign_index)
            pubkey_hex = _signing_pubkey_hex(kpub, chain, sign_index)
            if pubkey_hex:
                bip32[pubkey_hex] = _key_source(fp, leaf_path)

    row: dict[str, Any] = {
        "utxoEntry": {
            "amount": int(utxo.amount),
            "scriptPublicKey": _spk_wire_hex(0, in_script),
            "blockDaaScore": int(getattr(utxo, "block_daa_score", 0) or 0),
            "isCoinbase": bool(getattr(utxo, "is_coinbase", False)),
            "covenantId": normalize_covenant_id(getattr(utxo, "covenant_id", None)),
        },
        "previousOutpoint": {
            "transactionId": _norm_txid(utxo.transaction_id),
            "index": int(utxo.output_index),
        },
        "sequence": None,
        "partialSigs": {},
        "sighashType": 1,
        "sigOpCount": sig_op_count,
        "bip32Derivations": bip32,
        "proprietaries": {},
    }
    if redeem_script_hex:
        row["redeemScript"] = redeem_script_hex
    return row


def _bip45_device_account_hint(derivation: str) -> int:
    """SeedPass UI account index from cosigner path (m/45'/111111'/N')."""
    parts = (derivation or "").strip().lower().split("/")
    for part in reversed(parts):
        if part.endswith("'") and part[:-1].isdigit():
            return int(part[:-1])
    return 0


def enrich_kaspa_multisig_unsigned(unsigned: dict, cfg: WalletConfig) -> dict:
    """Fill multisig signing fields and attach cosigner hints for device export."""
    if not _is_kaspa_multisig(cfg):
        return unsigned
    out = dict(unsigned)
    inputs_out: list[dict[str, Any]] = []
    changed = False
    for inp in out.get("inputs") or []:
        if not isinstance(inp, dict):
            continue
        row = dict(inp)
        chain = int(row.get("sign_chain", 0))
        sign_index = int(row.get("sign_address_index", 0))
        try:
            policy = _multisig_policy_for_input(cfg, chain, sign_index)
        except ValueError:
            inputs_out.append(row)
            continue
        if policy is None:
            inputs_out.append(row)
            continue
        from kaspa_multisig import multisig_p2sh_address, multisig_p2sh_script_hex, multisig_redeem_script_hex

        redeem = multisig_redeem_script_hex(policy)
        p2sh = multisig_p2sh_script_hex(redeem)
        on_chain = str(row.get("utxo_script_hex") or "").strip().lower().replace("0x", "")
        if on_chain and p2sh != on_chain:
            inputs_out.append(row)
            continue
        if str(row.get("redeem_script_hex") or "").strip().lower() != redeem:
            row["redeem_script_hex"] = redeem
            changed = True
        if int(row.get("sig_op_count") or 0) != len(policy.cosigners):
            row["sig_op_count"] = len(policy.cosigners)
            changed = True
        if row.get("utxo_script_hex") != p2sh:
            row["utxo_script_hex"] = p2sh
            changed = True
        expected_addr = multisig_p2sh_address(policy)
        if row.get("receive_address") != expected_addr:
            row["receive_address"] = expected_addr
            changed = True
        inputs_out.append(row)
    if changed:
        out["inputs"] = inputs_out
    out["account"] = effective_wallet_account(cfg)
    out["multisig_m"] = int(cfg.multisig_m or 0)
    out["multisig_n"] = int(cfg.multisig_n or 0)
    out["multisig_cosigners"] = [
        {
            "fingerprint": str(c.get("fingerprint") or ""),
            "derivation": str(c.get("derivation") or ""),
            "label": str(c.get("label") or ""),
            "device_account": _bip45_device_account_hint(str(c.get("derivation") or "")),
        }
        for c in (cfg.multisig_cosigners or [])
    ]
    return out


def _change_target(cfg: WalletConfig, utxos: list[WalletUtxo]) -> tuple[str, int]:
    """Pick the next unused change address (never reuse Change #0 once it has been used)."""
    try:
        from .address_usage import next_change_index_for_wallet

        svc = get_service()
        idx = next_change_index_for_wallet(
            cfg.id,
            scan_limit=max(1, int(cfg.scan_limit or 20)),
            utxo_items=utxos,
        )
        return svc.change_address_at(cfg, idx), idx
    except Exception:
        idx = int(utxos[0].address_index) if utxos else 0
        if utxos:
            return normalize_kaspa_address(utxos[0].address), idx
        raise


def _change_address(cfg: WalletConfig, utxos: list[WalletUtxo]) -> str:
    return _change_target(cfg, utxos)[0]


def _output_sompi_list(tx_dict: dict[str, Any]) -> list[int]:
    vals: list[int] = []
    for o in tx_dict.get("outputs") or []:
        v = o.get("amount")
        if v is None:
            v = o.get("value")
        if v is None and isinstance(o.get("utxoEntry"), dict):
            v = o["utxoEntry"].get("amount")
        vals.append(int(v or 0))
    return vals


def _summary_from_pending(
    pending: Any,
    tx_dict: dict[str, Any],
    *,
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    payee: str,
    send_sompi: int,
) -> dict[str, Any]:
    from kaspa import NetworkId, calculate_storage_mass

    sdk_fee = int(getattr(pending, "fee_amount", 0) or 0)
    fee = sdk_fee
    mass = int(getattr(pending, "mass", 0) or 0)
    if not mass:
        mass = int(tx_dict.get("mass", 0) or 0)
    out_vals = _output_sompi_list(tx_dict)
    tx_inputs = tx_dict.get("inputs") or []
    in_vals = []
    for inp in tx_inputs:
        utxo = inp.get("utxo") or {}
        in_vals.append(int(utxo.get("amount", 0)))
    if not in_vals:
        in_vals = [int(u.amount) for u in utxos]
    storage_mass = None
    if out_vals:
        try:
            storage_mass = int(calculate_storage_mass(NetworkId("mainnet"), in_vals, out_vals))
        except Exception:
            pass
    total_in = sum(in_vals)
    payment = int(send_sompi)
    total_out = sum(out_vals)
    implicit = max(0, total_in - total_out) if total_in > 0 and total_out > 0 else 0
    change_sompi = max(0, total_out - payment) if total_out > 0 else 0
    if len(out_vals) == 1:
        change_sompi = 0
    # Miners are paid inputs − outputs (implicit). Never display generator fee_amount alone.
    if implicit > 0:
        fee = implicit
    elif sdk_fee > 0:
        fee = sdk_fee
    else:
        fee = _relay_fee_sompi()
    change_addr, change_idx = _change_target(cfg, utxos)
    used_keys: list[str] = []
    for inp in tx_inputs:
        op = inp.get("previousOutpoint") or inp.get("outpoint") or {}
        txid = op.get("transactionId") or op.get("transaction_id")
        idx = op.get("index")
        if txid is not None and idx is not None:
            used_keys.append(f"{_norm_txid(str(txid))}:{int(idx)}")
    if not used_keys:
        used_keys = [f"{_norm_txid(u.transaction_id)}:{int(u.output_index)}" for u in utxos]
    implicit = max(0, total_in - total_out) if total_in > 0 and total_out > 0 else max(0, int(fee))
    paid_fee = int(fee)
    excess = 0
    return {
        "coin": "kaspa",
        "used_utxo_keys": used_keys,
        "input_count": len(used_keys),
        "fee_sompi": paid_fee,
        "fee_kas": paid_fee / SOMPI_PER_KAS,
        "network_fee_sompi": paid_fee,
        "excess_to_miner_sompi": excess,
        "excess_to_miner_kas": excess / SOMPI_PER_KAS,
        "input_total_sompi": total_in,
        "input_total_kas": total_in / SOMPI_PER_KAS,
        "feerate": float(paid_fee / mass) if mass > 0 else 1.0,
        "mass": mass,
        "mass_grams": mass,
        "storage_mass": storage_mass,
        "send_sompi": int(send_sompi),
        "change_sompi": change_sompi,
        "change_kas": change_sompi / SOMPI_PER_KAS,
        "change_address": change_addr if change_sompi > 0 else None,
        "change_address_index": change_idx if change_sompi > 0 else None,
        "output_count": len(out_vals),
        "input_count": len(in_vals),
        "maximum_standard_mass": _maximum_standard_mass(),
        "to_address": payee,
        "from_address": utxos[0].address,
        "is_multi_input": len(in_vals) > 1,
        "generator": True,
    }


def _kaspa_min_relay_fee(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    priority_fee: int | None = None,
    *,
    output_count: int = 2,
) -> int:
    """Minimum relay fee for this wallet's inputs (multisig-aware signed-size placeholders)."""
    relay = _relay_fee_sompi(
        _kaspa_fee_estimate_unsigned(cfg, utxos, output_count=output_count)
    )
    return max(relay, int(priority_fee or 0))


def _kaspa_insufficient_coins_message(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    send_sompi: int,
    priority_fee: int | None = None,
) -> str:
    selected = _canonical_utxo_subset(utxos)
    total_in = sum(int(u.amount) for u in selected)
    relay = _kaspa_min_relay_fee(cfg, selected, priority_fee)
    min_change_kas = KASPA_MIN_SPENDABLE_REMAINDER_SOMPI / SOMPI_PER_KAS
    max_with_change = max(0, total_in - relay - KASPA_MIN_SPENDABLE_REMAINDER_SOMPI)
    max_sweep = max(0, total_in - relay)
    send_kas = int(send_sompi) / SOMPI_PER_KAS
    total_kas = total_in / SOMPI_PER_KAS
    relay_kas = relay / SOMPI_PER_KAS
    if max_with_change > 0 and int(send_sompi) > max_with_change:
        return (
            f"Selected coins total {total_kas:.8f} KAS — not enough for {send_kas:.8f} KAS "
            f"plus network fee (~{relay_kas:.8f} KAS) and minimum change "
            f"({min_change_kas:.8f} KAS). Try up to {max_with_change / SOMPI_PER_KAS:.8f} KAS "
            f"or Max (~{max_sweep / SOMPI_PER_KAS:.8f} KAS)."
        )
    return (
        f"Selected coins total {total_kas:.8f} KAS — not enough for {send_kas:.8f} KAS "
        f"plus network fee (~{relay_kas:.8f} KAS). "
        f"Try Max (~{max_sweep / SOMPI_PER_KAS:.8f} KAS) or a lower amount."
    )


def _relay_fee_sompi(
    unsigned: dict[str, Any] | None = None,
    *,
    mass: int | None = None,
    input_count: int = 1,
    output_count: int = 2,
    input_amount: int = 1_000_000,
) -> int:
    """Toccata minimum relay fee via rusty-kaspa SDK."""
    _ = mass
    try:
        from kaspa_mass import minimum_relay_fee_for_transaction

        return minimum_relay_fee_for_transaction(
            unsigned,
            input_count=input_count,
            output_count=output_count,
            input_amount=input_amount,
        )
    except ImportError:
        from kaspa_toccata import estimate_relay_fee_sompi

        return estimate_relay_fee_sompi(
            unsigned=unsigned,
            input_count=input_count,
            output_count=output_count,
            input_amount=input_amount,
        )


def _unsigned_relay_check(unsigned: dict[str, Any]) -> tuple[bool, int, int]:
    """Return (ok, implicit_fee_sompi, minimum_relay_fee_sompi) using broadcast rules."""
    try:
        from kaspa_mass import analyze_unsigned

        rep = analyze_unsigned(unsigned)
    except ImportError:
        return True, 0, LEGACY_FALLBACK_RELAY_SOMPI
    implicit = int(rep.implicit_fee or 0)
    min_fee = int(rep.minimum_relay_fee or LEGACY_FALLBACK_RELAY_SOMPI)
    min_fee += KASPA_SIGNED_RELAY_FEE_BUFFER_SOMPI
    if not rep.within_limits:
        return False, implicit, min_fee
    if implicit < min_fee:
        return False, implicit, min_fee
    return True, implicit, min_fee


def _kaspa_paid_fee_sompi(*, implicit_sompi: int | None) -> int:
    """Fee actually paid to miners (inputs − outputs)."""
    implicit = max(0, int(implicit_sompi or 0))
    return implicit if implicit > 0 else _relay_fee_sompi()


def _kaspa_display_fees(
    *,
    implicit_sompi: int | None = None,
    generator_fee: int | None = None,
    unsigned: dict[str, Any] | None = None,
    mass: int | None = None,
) -> dict[str, int]:
    """Return the fee the user actually pays (implicit), not transaction mass."""
    _ = generator_fee, unsigned, mass
    paid = _kaspa_paid_fee_sompi(implicit_sompi=implicit_sompi)
    return {
        "fee_sompi": paid,
        "network_fee_sompi": paid,
        "excess_to_miner_sompi": 0,
    }


def _analyze_unsigned_limits(unsigned: dict[str, Any]) -> tuple[bool, int | None]:
    """Return (within_limits, minimum_relay_fee_sompi)."""
    try:
        from kaspa_mass import analyze_unsigned

        rep = analyze_unsigned(unsigned)
        return bool(rep.within_limits), rep.minimum_relay_fee
    except ImportError:
        return True, None
    except Exception:
        return False, None


def _select_utxos_for_no_change_send(
    utxos: list[WalletUtxo],
    send_sompi: int,
    *,
    priority_fee: int = 0,
) -> list[WalletUtxo] | None:
    """Pick a minimal input set that can pay send_sompi with one output (leftover = fee)."""
    from kaspa import NetworkId, calculate_storage_mass

    requested = int(send_sompi)
    if requested <= 0 or not utxos:
        return None
    network = NetworkId("mainnet")
    best: tuple[tuple[int, int], list[WalletUtxo]] | None = None
    ordered = sorted(utxos, key=lambda u: int(u.amount))
    for size in range(1, len(ordered) + 1):
        for combo in itertools.combinations(ordered, size):
            total_in = sum(int(u.amount) for u in combo)
            if total_in <= requested:
                continue
            implicit_fee = total_in - requested
            if implicit_fee < max(1_000, int(priority_fee or 0)):
                continue
            in_vals = [int(u.amount) for u in combo]
            storage_mass = calculate_storage_mass(network, in_vals, [requested])
            if storage_mass is not None and storage_mass > KASPA_STORAGE_MASS_LIMIT:
                continue
            min_idx = min((int(u.address_index) for u in combo), default=999_999)
            unique_addrs = len({(bool(u.is_change), int(u.address_index)) for u in combo})
            # Prefer fewer spending addresses first — OneKey confirms once per unique path
            # before Slide to Sign.
            score = (unique_addrs, len(combo), implicit_fee, total_in, min_idx)
            if best is None or score < best[0]:
                best = (score, list(combo))
        if best is not None:
            break
    return best[1] if best else None


def _build_unsigned_v2_no_change(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
) -> dict[str, Any]:
    payee = normalize_kaspa_address(to_address)
    out_script = kaspa_address_to_script_hex(payee)
    account = effective_wallet_account(cfg)
    inputs_v2: list[dict[str, Any]] = []
    for utxo in utxos:
        chain = 1 if utxo.is_change else 0
        sign_index = int(utxo.address_index)
        if _is_kaspa_multisig(cfg):
            from kaspa_multisig import multisig_p2sh_address, multisig_p2sh_script_hex, multisig_redeem_script_hex

            policy = _multisig_policy_for_input(cfg, chain, sign_index)
            if policy is None:
                raise ValueError("Invalid Kaspa multisig policy")
            redeem = multisig_redeem_script_hex(policy)
            in_script = multisig_p2sh_script_hex(redeem)
            row = input_v2_fields_from_utxo(utxo, script_hex=in_script)
            row["redeem_script_hex"] = redeem
            row["sig_op_count"] = len(policy.cosigners)
            row["receive_address"] = multisig_p2sh_address(policy)
            inputs_v2.append(row)
        else:
            addr = normalize_kaspa_address(utxo.address)
            in_script = kaspa_address_to_script_hex(addr)
            inputs_v2.append(input_v2_fields_from_utxo(utxo, script_hex=in_script))
    unsigned: dict[str, Any] = {
        "version": 2,
        "network": "mainnet",
        "account": account,
        "tx_version": 0,
        "lock_time": 0,
        "gas": 0,
        "subnetwork_id_hex": "0" * 40,
        "payload_hex": "",
        "inputs": inputs_v2,
        "outputs": [
            {
                "value": int(send_sompi),
                "script_version": 0,
                "script_hex": out_script,
                "kaspa_address": payee,
            }
        ],
    }
    kpub = (cfg.kpub or "").strip()
    if kpub:
        unsigned["kpub"] = kpub
    return unsigned


def _build_pskt_multi_no_change(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Multi-input PSKT with a single payee output; leftover sompi is the network fee."""
    payee = normalize_kaspa_address(to_address)
    out_script = kaspa_address_to_script_hex(payee)
    account = effective_wallet_account(cfg)
    kpub = (cfg.kpub or "").strip()
    fingerprint = resolve_kaspa_fingerprint(cfg, kpub)

    inputs_pskt = [_pskt_input_from_utxo(cfg, utxo) for utxo in utxos]

    outputs_pskt = [
        {
            "amount": int(send_sompi),
            "scriptPublicKey": _spk_wire_hex(0, out_script),
            "bip32Derivations": {},
            "proprietaries": {},
        }
    ]
    xpubs = _pskt_xpub_sources(cfg, kpub=kpub, fingerprint=fingerprint, account=account)

    pskt = normalize_pskt_inner(
        {
            "global": {
                "version": 1,
                "txVersion": 0,
                "inputCount": len(inputs_pskt),
                "outputCount": 1,
                "inputsModifiable": False,
                "outputsModifiable": False,
                "xpubs": xpubs,
                "proprietaries": {},
            },
            "inputs": inputs_pskt,
            "outputs": outputs_pskt,
        }
    )
    unsigned = _pskt_to_seedmask_v2_multi(
        pskt, kpub=kpub, account=account, utxo_meta=utxos
    )
    outs = unsigned.get("outputs") or []
    if outs:
        outs[0]["kaspa_address"] = payee
    return pskt, unsigned


def _build_pskt_multi_with_change(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    change_sompi: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    payee = normalize_kaspa_address(to_address)
    out_script = kaspa_address_to_script_hex(payee)
    change_addr, change_idx = _change_target(cfg, utxos)
    change_script = kaspa_address_to_script_hex(change_addr)
    account = effective_wallet_account(cfg)
    kpub = (cfg.kpub or "").strip()
    fingerprint = resolve_kaspa_fingerprint(cfg, kpub)

    inputs_pskt = [_pskt_input_from_utxo(cfg, utxo) for utxo in utxos]

    outputs_pskt = [
        {
            "amount": int(send_sompi),
            "scriptPublicKey": _spk_wire_hex(0, out_script),
            "bip32Derivations": {},
            "proprietaries": {},
        },
        {
            "amount": int(change_sompi),
            "scriptPublicKey": _spk_wire_hex(0, change_script),
            "bip32Derivations": {},
            "proprietaries": {},
        },
    ]
    xpubs = _pskt_xpub_sources(cfg, kpub=kpub, fingerprint=fingerprint, account=account)
    pskt = normalize_pskt_inner(
        {
            "global": {
                "version": 1,
                "txVersion": 0,
                "inputCount": len(inputs_pskt),
                "outputCount": 2,
                "inputsModifiable": False,
                "outputsModifiable": False,
                "xpubs": xpubs,
                "proprietaries": {},
            },
            "inputs": inputs_pskt,
            "outputs": outputs_pskt,
        }
    )
    unsigned = _pskt_to_seedmask_v2_multi(
        pskt, kpub=kpub, account=account, utxo_meta=utxos
    )
    outs = unsigned.get("outputs") or []
    if len(outs) >= 1:
        outs[0]["kaspa_address"] = payee
    if len(outs) >= 2:
        outs[1]["kaspa_address"] = change_addr
        outs[1]["is_change"] = True
        outs[1]["change_address_index"] = change_idx
    return pskt, unsigned


def _summary_from_manual_change(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    payee: str,
    send_sompi: int,
    change_sompi: int,
    fee_sompi: int,
    unsigned: dict[str, Any],
) -> dict[str, Any]:
    in_vals = [int(u.amount) for u in utxos]
    total_in = sum(in_vals)
    storage_mass = None
    try:
        from kaspa import NetworkId, calculate_storage_mass

        storage_mass = int(
            calculate_storage_mass(NetworkId("mainnet"), in_vals, [int(send_sompi), int(change_sompi)])
        )
    except Exception:
        pass
    try:
        from kaspa_mass import analyze_unsigned

        rep = analyze_unsigned(unsigned)
        mass = int(rep.transaction_mass or 0)
    except BaseException:
        mass = estimate_relay_grams(input_count=len(utxos), output_count=2)
    change_addr, change_idx = _change_target(cfg, utxos)
    used_keys = [f"{_norm_txid(u.transaction_id)}:{int(u.output_index)}" for u in utxos]
    return {
        "coin": "kaspa",
        "used_utxo_keys": used_keys,
        "input_count": len(utxos),
        "fee_sompi": int(fee_sompi),
        "fee_kas": int(fee_sompi) / SOMPI_PER_KAS,
        "network_fee_sompi": int(fee_sompi),
        "excess_to_miner_sompi": 0,
        "excess_to_miner_kas": 0.0,
        "input_total_sompi": total_in,
        "input_total_kas": total_in / SOMPI_PER_KAS,
        "feerate": float(int(fee_sompi) / mass) if mass > 0 else 1.0,
        "mass": mass,
        "mass_grams": mass,
        "storage_mass": storage_mass,
        "send_sompi": int(send_sompi),
        "send_kas": int(send_sompi) / SOMPI_PER_KAS,
        "change_sompi": int(change_sompi),
        "change_kas": int(change_sompi) / SOMPI_PER_KAS,
        "change_address": change_addr,
        "change_address_index": change_idx,
        "output_count": 2,
        "maximum_standard_mass": _maximum_standard_mass(),
        "to_address": payee,
        "from_address": utxos[0].address,
        "is_multi_input": len(utxos) > 1,
        "generator": False,
    }


def _try_manual_change_send(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]] | None:
    payee = normalize_kaspa_address(to_address)
    selected = _canonical_utxo_subset(utxos)
    total_in = sum(int(u.amount) for u in selected)
    min_fee = _kaspa_min_relay_fee(cfg, selected, priority_fee)
    if total_in <= int(send_sompi) + min_fee + KASPA_MIN_SPENDABLE_REMAINDER_SOMPI:
        return None
    fee = min_fee
    for _ in range(64):
        change = total_in - int(send_sompi) - fee
        if change < KASPA_MIN_SPENDABLE_REMAINDER_SOMPI:
            return None
        try:
            pskt, unsigned = _build_pskt_multi_with_change(
                cfg,
                selected,
                to_address=payee,
                send_sompi=int(send_sompi),
                change_sompi=change,
            )
        except Exception:
            return None
        ok, implicit, required = _unsigned_relay_check(unsigned)
        if ok:
            summary = _summary_from_manual_change(
                cfg,
                selected,
                payee=payee,
                send_sompi=int(send_sompi),
                change_sompi=change,
                fee_sompi=fee,
                unsigned=unsigned,
            )
            _reject_unspendable_kaspa_remainder(
                selected,
                int(send_sompi),
                summary,
                max_send_sompi=max(0, total_in - fee),
            )
            return pskt, unsigned, summary
        bump = max(1, int(required) - int(implicit))
        fee += bump
    return None


def _summary_from_no_change(
    utxos: list[WalletUtxo],
    *,
    payee: str,
    send_sompi: int,
    unsigned: dict[str, Any],
) -> dict[str, Any]:
    from kaspa import NetworkId, calculate_storage_mass

    in_vals = [int(u.amount) for u in utxos]
    total_in = sum(in_vals)
    implicit = max(0, total_in - int(send_sompi))
    out_vals = [int(send_sompi)]
    storage_mass = None
    try:
        storage_mass = int(calculate_storage_mass(NetworkId("mainnet"), in_vals, out_vals))
    except Exception:
        pass
    mass = None
    try:
        from kaspa_mass import analyze_unsigned

        rep = analyze_unsigned(unsigned)
        mass = rep.transaction_mass
    except BaseException:
        mass = estimate_relay_grams(input_count=len(utxos), output_count=1)
    paid_fee = _kaspa_paid_fee_sompi(implicit_sompi=implicit)
    network_fee = paid_fee
    excess_to_miner = 0
    used_keys = [f"{_norm_txid(u.transaction_id)}:{int(u.output_index)}" for u in utxos]
    return {
        "coin": "kaspa",
        "used_utxo_keys": used_keys,
        "fee_sompi": network_fee,
        "fee_kas": network_fee / SOMPI_PER_KAS,
        "network_fee_sompi": network_fee,
        "excess_to_miner_sompi": excess_to_miner,
        "excess_to_miner_kas": excess_to_miner / SOMPI_PER_KAS,
        "input_total_sompi": total_in,
        "input_total_kas": total_in / SOMPI_PER_KAS,
        "feerate": float(network_fee / mass) if mass and mass > 0 else 1.0,
        "mass": int(mass or 0),
        "mass_grams": int(mass or 0),
        "storage_mass": storage_mass,
        "send_sompi": int(send_sompi),
        "change_sompi": 0,
        "output_count": 1,
        "input_count": len(utxos),
        "maximum_standard_mass": _maximum_standard_mass(),
        "to_address": payee,
        "from_address": utxos[0].address,
        "is_multi_input": len(utxos) > 1,
        "generator": False,
        "no_change": True,
    }


def _try_no_change_send(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
    selected_utxos: list[WalletUtxo] | None = None,
) -> tuple[list[WalletUtxo], dict[str, Any], dict[str, Any], dict[str, Any]] | None:
    """Build a valid exact-amount send without a change output when the generator cannot."""
    payee = normalize_kaspa_address(to_address)
    if selected_utxos is not None:
        selected = _canonical_utxo_subset(selected_utxos)
    else:
        selected = _select_utxos_for_no_change_send(
            utxos, int(send_sompi), priority_fee=int(priority_fee or 0)
        )
    if not selected:
        return None
    unsigned = _build_unsigned_v2_no_change(
        cfg, selected, to_address=payee, send_sompi=int(send_sompi)
    )
    implicit_fee = sum(int(u.amount) for u in selected) - int(send_sompi)
    relay = _kaspa_min_relay_fee(cfg, selected, priority_fee, output_count=1)
    if implicit_fee < relay:
        return None
    # Do not gate on analyze_unsigned — kaspa 2.x SDK mass API can drift; selection already checks KIP-9 storage mass.
    pskt, unsigned = _build_pskt_multi_no_change(
        cfg, selected, to_address=payee, send_sompi=int(send_sompi)
    )
    ok, implicit, min_fee = _unsigned_relay_check(unsigned)
    if not ok:
        return None
    summary = _summary_from_no_change(
        selected, payee=payee, send_sompi=int(send_sompi), unsigned=unsigned
    )
    return selected, pskt, unsigned, summary


def _kaspa_no_change_burn_message(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
) -> str | None:
    """Warn when the only viable path burns leftover as miner fee (no change output)."""
    payee = normalize_kaspa_address(to_address)
    try:
        alt = _try_no_change_send(
            cfg,
            utxos,
            to_address=payee,
            send_sompi=int(send_sompi),
            priority_fee=priority_fee,
        )
    except Exception:
        return (
            "This amount cannot be sent with change (Kaspa KIP-9). "
            "Try a larger amount, Max, or pick a smaller coin."
        )
    if alt is None:
        return None
    _selected, _pskt, _unsigned, summary = alt
    excess = int(summary.get("excess_to_miner_sompi") or 0)
    if excess <= KASPA_MIN_SPENDABLE_REMAINDER_SOMPI:
        return None
    relay_kas = int(summary.get("fee_sompi") or _relay_fee_sompi()) / SOMPI_PER_KAS
    burn_kas = excess / SOMPI_PER_KAS
    return (
        f"This amount cannot be sent with change (Kaspa KIP-9). "
        f"The only option without change would add {burn_kas:.8f} KAS to miners "
        f"on top of the ~{relay_kas:.8f} KAS network fee. "
        f"Try a larger amount, Max, or pick a smaller coin."
    )


def quote_kaspa_network_send(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
) -> dict[str, Any]:
    """Quote a normal payment + change send; never treat no-change burn as the network fee."""
    payee = normalize_kaspa_address(to_address)
    subsets = _utxo_subsets_to_try(utxos, int(send_sompi), priority_fee)

    best_summary: dict[str, Any] | None = None
    best_sort_key: tuple[Any, ...] | None = None
    for subset in subsets:
        amounts = _generator_build_amounts(
            cfg,
            subset,
            to_address=payee,
            send_sompi=int(send_sompi),
            priority_fee=int(priority_fee or 0),
        )
        if amounts is None:
            continue
        change = int(amounts.get("change_sompi") or 0)
        if change < KASPA_MIN_SPENDABLE_REMAINDER_SOMPI:
            continue
        fee = int(amounts.get("fee_sompi") or 0)
        mass_est = int(getattr(amounts["pending"], "mass", 0) or 0)
        if not mass_est:
            mass_est = estimate_relay_grams(input_count=len(subset), output_count=2)
        min_relay = _relay_fee_sompi(input_count=len(subset), output_count=2)
        if fee < max(min_relay, mass_est):
            continue
        summary = _summary_from_pending(
            amounts["pending"],
            amounts["tx_dict"],
            cfg=cfg,
            utxos=subset,
            payee=payee,
            send_sompi=int(send_sompi),
        )
        fee = int(summary.get("fee_sompi") or 0)
        if fee < max(min_relay, mass_est):
            continue
        input_total = int(summary.get("input_total_sompi") or 0)
        min_addr_idx = min((int(u.address_index) for u in subset), default=999_999)
        sort_key = _kaspa_build_sort_key(
            summary,
            input_count=_summary_input_count(summary, subset),
            input_total=input_total,
            wallet_total=sum(int(u.amount) for u in utxos),
            sweep_intent=False,
            address_count=_subset_address_count(subset),
            address_group_total=_address_group_total_sompi(subset, utxos),
            min_address_index=min_addr_idx,
            change_preference=_subset_change_preference(subset),
        )
        if best_sort_key is None or sort_key < best_sort_key:
            best_sort_key = sort_key
            best_summary = summary
    if best_summary is not None:
        best_summary["excess_to_miner_sompi"] = 0
        best_summary["send_kas"] = int(send_sompi) / SOMPI_PER_KAS
        return best_summary

    burn_msg = _kaspa_no_change_burn_message(
        cfg, utxos, to_address=payee, send_sompi=int(send_sompi), priority_fee=priority_fee
    )
    if burn_msg:
        raise ValueError(burn_msg)

    # Legitimate max/sweep: leftover is only the network fee, no change output needed.
    if not _warrants_change_output(utxos, int(send_sompi), priority_fee):
        alt = _try_no_change_send(
            cfg,
            utxos,
            to_address=payee,
            send_sompi=int(send_sompi),
            priority_fee=priority_fee,
        )
        if alt is not None:
            _selected, _pskt, _unsigned, summary = alt
            summary["excess_to_miner_sompi"] = 0
            summary["send_kas"] = int(send_sompi) / SOMPI_PER_KAS
            return summary

    raise ValueError("Cannot build Kaspa transaction with the selected coins")


def _quote_kaspa_send_raw(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
    max_send_sompi: int | None = None,
) -> dict[str, Any]:
    """Quote fee/mass — try generator (payment + change), then no-change fallback."""
    if int(send_sompi) <= 0:
        raise ValueError("Send amount must be positive")
    payee = normalize_kaspa_address(to_address)
    utxos = _canonical_utxo_subset(utxos)
    from kaspa import Address, NetworkId, create_transactions

    refs = [_utxo_ref_from_wallet_utxo(u) for u in utxos]
    change = Address(_change_address(cfg, utxos))
    try:
        result = create_transactions(
            refs,
            change,
            network_id=NetworkId("mainnet"),
            outputs=[{"address": payee, "amount": int(send_sompi)}],
            priority_fee=int(priority_fee or 0),
            priority_entries=refs,
        )
    except KeyError as exc:
        raise _kaspa_key_error(exc) from exc
    except Exception:
        pass
    else:
        pending = (result.get("transactions") or [None])[0]
        if pending is not None:
            tx_dict = (
                pending.transaction.to_dict() if hasattr(pending.transaction, "to_dict") else {}
            )
            return _summary_from_pending(
                pending, tx_dict, cfg=cfg, utxos=utxos, payee=payee, send_sompi=int(send_sompi)
            )
    alt = _try_no_change_send(
        cfg,
        utxos,
        to_address=payee,
        send_sompi=int(send_sompi),
        priority_fee=priority_fee,
    )
    if alt is not None:
        _selected, _pskt, _unsigned, summary = alt
        return summary
    raise ValueError("Cannot build Kaspa transaction with the selected coins")


def quote_kaspa_send(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
    max_send_sompi: int | None = None,
) -> dict[str, Any]:
    summary = _quote_kaspa_send_raw(
        cfg,
        utxos,
        to_address=to_address,
        send_sompi=int(send_sompi),
        priority_fee=priority_fee,
        max_send_sompi=max_send_sompi,
    )
    _reject_unspendable_kaspa_remainder(
        utxos,
        int(send_sompi),
        summary,
        max_send_sompi=max_send_sompi,
    )
    return summary


def _quote_fee_sompi(summary: dict[str, Any]) -> int:
    """Network fee sompi from a quote/summary dict (never 0 when build succeeded)."""
    fee = int(summary.get("network_fee_sompi") or summary.get("fee_sompi") or 0)
    if fee > 0:
        return fee
    return _relay_fee_sompi()


def _mark_no_change_fee_as_network(summary: dict[str, Any]) -> dict[str, Any]:
    """For intentional sweeps/MAX, the whole input-output delta is the network fee."""
    fee = max(0, int(summary.get("input_total_sompi") or 0) - int(summary.get("send_sompi") or 0))
    if fee <= 0:
        fee = int(summary.get("fee_sompi") or 0)
    summary["fee_sompi"] = fee
    summary["fee_kas"] = fee / SOMPI_PER_KAS
    summary["network_fee_sompi"] = fee
    summary["excess_to_miner_sompi"] = 0
    summary["excess_to_miner_kas"] = 0.0
    summary["is_sweep"] = True
    return summary


def _utxo_address_key(u: WalletUtxo) -> tuple[int, int]:
    return (1 if u.is_change else 0, int(u.address_index))


def _subset_address_count(sub: list[WalletUtxo]) -> int:
    return len({_utxo_address_key(u) for u in sub})


def _group_utxos_by_address(utxos: list[WalletUtxo]) -> list[list[WalletUtxo]]:
    groups: dict[tuple[int, int], list[WalletUtxo]] = {}
    for u in utxos:
        groups.setdefault(_utxo_address_key(u), []).append(u)
    return list(groups.values())


def _minimal_sufficient_subset(pool: list[WalletUtxo], needed: int) -> list[WalletUtxo] | None:
    """Fewest/smallest coins in pool whose sum >= needed (ascending greedy)."""
    ordered = sorted(pool, key=lambda u: int(u.amount))
    acc: list[WalletUtxo] = []
    total = 0
    for u in ordered:
        acc.append(u)
        total += int(u.amount)
        if total >= needed:
            return _canonical_utxo_subset(acc)
    return None


def _minimal_utxo_greedy_largest(utxos: list[WalletUtxo], needed: int) -> list[WalletUtxo] | None:
    """Cover `needed` with large UTXOs first, then swap the last for the smallest that still fits."""
    if not utxos:
        return None
    ordered_desc = sorted(utxos, key=lambda u: int(u.amount), reverse=True)
    selected: list[WalletUtxo] = []
    total = 0
    for u in ordered_desc:
        if total >= needed:
            break
        selected.append(u)
        total += int(u.amount)
    if total < needed:
        return None

    used_ids = {id(u) for u in selected}
    while len(selected) >= 2:
        last = selected[-1]
        total_without = total - int(last.amount)
        gap = needed - total_without
        if gap <= 0:
            selected.pop()
            total = total_without
            continue
        smaller = [
            u
            for u in utxos
            if id(u) not in used_ids and int(u.amount) >= gap and int(u.amount) < int(last.amount)
        ]
        if not smaller:
            break
        replacement = min(smaller, key=lambda u: int(u.amount))
        selected[-1] = replacement
        total = total_without + int(replacement.amount)
        used_ids = {id(u) for u in selected}
        break

    return _canonical_utxo_subset(selected) if total >= needed else None


def _address_headroom_sompi(send_sompi: int) -> int:
    """Minimum extra balance at an address beyond send before detailed relay checks."""
    _ = send_sompi
    return max(
        KASPA_MIN_SPENDABLE_REMAINDER_SOMPI * 8,
        6_000_000,
    )


def _single_coin_overshoot_sompi(u: WalletUtxo, send_sompi: int) -> int:
    """Leftover when spending one coin exactly at send amount (no-change band)."""
    amt = int(u.amount)
    if amt <= int(send_sompi):
        return 0
    return amt - int(send_sompi)


def _is_awkward_single_coin(u: WalletUtxo, send_sompi: int) -> bool:
    """One coin slightly above send → likely burn if generator skips change."""
    overshoot = _single_coin_overshoot_sompi(u, send_sompi)
    if overshoot <= 0:
        return False
    return overshoot < 2_000_000  # under 0.02 KAS leftover band


def _register_subset_candidates(
    candidates: list[list[WalletUtxo]],
    seen: set[tuple[str, ...]],
    subset_key,
    *subsets: list[WalletUtxo] | None,
) -> None:
    for sub in subsets:
        if not sub:
            continue
        k = subset_key(sub)
        if k in seen:
            continue
        seen.add(k)
        candidates.append(_canonical_utxo_subset(sub))


def _add_address_group_combo_candidates(
    groups: list[list[WalletUtxo]],
    *,
    needed: int,
    seen: set[tuple[str, ...]],
    candidates: list[list[WalletUtxo]],
    subset_key,
) -> None:
    """Add minimal address-group covers; the SDK may still use a smaller input subset."""
    ordered = sorted(
        groups,
        key=lambda g: (sum(int(u.amount) for u in g), int(g[0].address_index)),
    )
    max_groups = min(4, len(ordered))
    combos: list[tuple[int, int, int, tuple[list[WalletUtxo], ...]]] = []
    for size in range(2, max_groups + 1):
        for combo in itertools.combinations(ordered, size):
            total = sum(sum(int(u.amount) for u in g) for g in combo)
            if total < needed:
                continue
            min_idx = min(int(g[0].address_index) for g in combo)
            combos.append((size, total, min_idx, combo))
    for _size, _total, _min_idx, combo in sorted(combos, key=lambda row: row[:3])[:24]:
        flattened = [u for g in combo for u in g]
        _register_subset_candidates(candidates, seen, subset_key, flattened)


def _add_intra_address_candidates(
    group: list[WalletUtxo],
    *,
    needed: int,
    send_sompi: int,
    seen: set[tuple[str, ...]],
    candidates: list[list[WalletUtxo]],
    subset_key,
) -> None:
    """Normal sends spend a chosen address group as a group, then return change."""
    _ = send_sompi
    by_amount = sorted(group, key=lambda u: (-int(u.amount), int(u.address_index), int(u.output_index)))
    for u in by_amount:
        if int(u.amount) >= needed:
            _register_subset_candidates(candidates, seen, subset_key, [u])
    picked: list[WalletUtxo] = []
    running = 0
    for u in by_amount:
        picked.append(u)
        running += int(u.amount)
        if running >= needed:
            _register_subset_candidates(candidates, seen, subset_key, picked)
            break
    _register_subset_candidates(candidates, seen, subset_key, group)


def _subset_change_preference(sub: list[WalletUtxo]) -> int:
    """Prefer receive-only (0). Any change input ranks equally behind (1)."""
    return 1 if any(bool(u.is_change) for u in sub) else 0


def _subset_candidate_rank(
    sub: list[WalletUtxo],
    *,
    send_sompi: int,
    needed: int,
    min_fee: int,
    min_change: int,
) -> tuple[Any, ...]:
    """Lower is better: receive over change, one address, tightest cover, then fewer inputs."""
    total = sum(int(u.amount) for u in sub)
    n = len(sub)
    addr_count = _subset_address_count(sub)
    needed_amt = needed
    slack = max(0, total - needed_amt) if total >= needed_amt else 999_999_999
    min_idx = min((int(u.address_index) for u in sub), default=999_999)
    change_pref = _subset_change_preference(sub)

    if addr_count == 1 and n == 1 and _is_awkward_single_coin(sub[0], send_sompi):
        overshoot = _single_coin_overshoot_sompi(sub[0], send_sompi)
        return (change_pref, 3, addr_count, overshoot, total, n, min_idx)

    if total >= needed_amt:
        # Prefer smallest sufficient combination (may combine several UTXOs), not one large coin.
        return (change_pref, addr_count - 1, total, slack, n, min_idx)

    rem = total - int(send_sompi)
    if rem >= min_fee:
        return (change_pref, 2, addr_count, rem, total, n, min_idx)
    return (change_pref, 4, addr_count, total, n, min_idx)


def _summary_is_viable_payment(
    summary: dict[str, Any],
    *,
    send_sompi: int,
    sweep_intent: bool,
    allow_no_change: bool,
) -> bool:
    if sweep_intent or allow_no_change:
        return True
    if summary.get("no_change"):
        return False
    change = int(summary.get("change_sompi") or 0)
    if change < KASPA_MIN_SPENDABLE_REMAINDER_SOMPI:
        return False
    return True


def _canonical_utxo_subset(utxos: list[WalletUtxo]) -> list[WalletUtxo]:
    """Stable input order for create_transactions (KIP-9 is sensitive to entry order)."""
    return sorted(
        utxos,
        key=lambda u: (
            int(u.amount),
            int(u.address_index),
            int(u.output_index),
            str(u.transaction_id),
        ),
    )


def _generator_build_amounts(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int = 0,
) -> dict[str, Any] | None:
    """Run create_transactions on an exact UTXO set; return fee/change from conservation."""
    if not utxos:
        return None
    utxos = _canonical_utxo_subset(utxos)
    from kaspa import Address, NetworkId, create_transactions

    payee = normalize_kaspa_address(to_address)
    refs = [_utxo_ref_from_wallet_utxo(u) for u in utxos]
    try:
        change = Address(_change_address(cfg, utxos))
    except Exception:
        change = Address(normalize_kaspa_address(utxos[0].address))
    try:
        result = create_transactions(
            refs,
            change,
            network_id=NetworkId("mainnet"),
            outputs=[{"address": payee, "amount": int(send_sompi)}],
            priority_fee=int(priority_fee or 0),
            priority_entries=refs,
        )
    except Exception:
        return None
    pending = (result.get("transactions") or [None])[0]
    if pending is None:
        return None
    tx_dict = pending.transaction.to_dict() if hasattr(pending.transaction, "to_dict") else {}
    tx_inputs = tx_dict.get("inputs") or []
    in_vals = []
    for inp in tx_inputs:
        utxo = inp.get("utxo") or {}
        in_vals.append(int(utxo.get("amount", 0)))
    if not in_vals:
        in_vals = [int(u.amount) for u in utxos]
    out_vals = _output_sompi_list(tx_dict)
    total_in = sum(in_vals)
    total_out = sum(out_vals)
    if total_in <= 0 or total_out <= 0:
        return None
    fee = max(0, total_in - total_out)
    payment = int(send_sompi)
    change_sompi = max(0, total_out - payment) if len(out_vals) >= 2 else 0
    return {
        "fee_sompi": fee,
        "change_sompi": change_sompi,
        "input_total_sompi": total_in,
        "pending": pending,
        "tx_dict": tx_dict,
        "utxos": utxos,
    }


def _probe_create_fee(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
) -> int | None:
    """Return actual generator fee sompi when create_transactions succeeds on this UTXO set."""
    amounts = _generator_build_amounts(
        cfg,
        utxos,
        to_address=to_address,
        send_sompi=int(send_sompi),
        priority_fee=int(priority_fee or 0),
    )
    if amounts is None:
        return None
    fee = int(amounts.get("fee_sompi") or 0)
    return fee if fee > 0 else None


def resolve_kaspa_send_sompi(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
) -> tuple[int, bool]:
    """Map requested send to a KIP-9-valid amount (exact, or nearest valid).

    Kaspa storage mass can reject amounts that leave awkward change even when max
    send works. Prefer the smallest valid amount >= requested, else nearest below.
    """
    requested = int(send_sompi)
    if requested <= 0:
        raise ValueError("Send amount must be positive")
    payee = normalize_kaspa_address(to_address)
    if _probe_create_fee(
        cfg, utxos, to_address=payee, send_sompi=requested, priority_fee=priority_fee
    ) is not None:
        return requested, False

    limits = max_sendable_kaspa(cfg, utxos, to_address=payee, priority_fee=priority_fee)
    max_send = int(limits.get("max_send_sompi") or 0)
    if max_send <= 0:
        fallback = _max_sendable_no_change_fallback(
            cfg, utxos, to_address=payee, priority_fee=priority_fee
        )
        if fallback is not None:
            max_send = int(fallback[0])
    if max_send <= 0:
        raise ValueError(
            "Selected coins cannot cover the network fee. Add funds or pick different coins."
        )
    if requested > max_send:
        raise ValueError(
            f"Send exceeds max {max_send / SOMPI_PER_KAS:.8f} KAS "
            f"(fee ~{int(limits.get('fee_sompi') or 0)} sompi)"
        )

    total_in = sum(int(u.amount) for u in utxos)
    step = max(1, 1_000)  # 0.00001 KAS
    upward_cap = min(max_send, requested + max(step, total_in // 20))
    for candidate in range(requested, upward_cap + 1, step):
        if _probe_create_fee(
            cfg, utxos, to_address=payee, send_sompi=candidate, priority_fee=priority_fee
        ) is not None:
            return candidate, True

    for candidate in range(requested - step, 0, -step):
        if _probe_create_fee(
            cfg, utxos, to_address=payee, send_sompi=candidate, priority_fee=priority_fee
        ) is not None:
            return candidate, True

    raise ValueError(
        "This amount cannot be sent with the selected coins (Kaspa KIP-9 storage mass). "
        "Try Max, a slightly lower amount, or different coins."
    )


def kip9_send_neighbors(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
) -> dict[str, int | None]:
    """Nearest valid send amounts below/above a KIP-9-blocked request (no auto-adjust)."""
    payee = normalize_kaspa_address(to_address)
    requested = int(send_sompi)
    step = max(1, 1_000)
    below: int | None = None
    for candidate in range(requested - step, 0, -step):
        if _probe_create_fee(
            cfg, utxos, to_address=payee, send_sompi=candidate, priority_fee=priority_fee
        ) is not None:
            below = candidate
            break
    above: int | None = None
    limits = max_sendable_kaspa(cfg, utxos, to_address=payee, priority_fee=priority_fee)
    max_send = int(limits.get("max_send_sompi") or 0)
    for candidate in range(requested + step, max_send + 1, step):
        if _probe_create_fee(
            cfg, utxos, to_address=payee, send_sompi=candidate, priority_fee=priority_fee
        ) is not None:
            above = candidate
            break
    return {"below_sompi": below, "above_sompi": above}


def _quick_kaspa_send_limits(
    utxos: list[WalletUtxo],
    *,
    priority_fee: int | None = None,
    cfg: WalletConfig | None = None,
) -> dict[str, Any]:
    """Fast upper-bound limits without generator search (UI fee display / Max prefill)."""
    total_in = sum(int(u.amount) for u in utxos)
    if cfg is not None and utxos:
        relay = _relay_fee_sompi(_kaspa_fee_estimate_unsigned(cfg, utxos))
    else:
        relay = _relay_fee_sompi(input_count=max(1, len(utxos)), output_count=2, input_amount=total_in)
    extra = max(0, int(priority_fee or 0))
    fee = max(relay, extra) if extra > 0 else relay
    max_send_sweep = max(0, total_in - fee)
    max_send = max(
        0, total_in - fee - KASPA_MIN_SPENDABLE_REMAINDER_SOMPI
    )
    if max_send <= 0 and max_send_sweep > 0:
        max_send = max_send_sweep
    mass_unsigned = _kaspa_fee_estimate_unsigned(cfg, utxos) if cfg is not None and utxos else None
    mass = estimate_relay_grams(input_count=len(utxos), output_count=2)
    if mass_unsigned:
        try:
            from kaspa_mass import analyze_unsigned

            rep = analyze_unsigned(mass_unsigned)
            if rep.transaction_mass is not None:
                mass = int(rep.transaction_mass)
            else:
                mass = estimate_relay_grams(unsigned=mass_unsigned)
        except Exception:
            mass = estimate_relay_grams(unsigned=mass_unsigned)
    return {
        "max_send_sompi": max_send,
        "max_send_kas": max_send / SOMPI_PER_KAS,
        "fee_sompi": fee,
        "fee_kas": fee / SOMPI_PER_KAS,
        "feerate": float(fee / total_in) if total_in > 0 else 1.0,
        "mass_grams": mass,
        "mass": mass,
        "spendable_sompi": max_send,
        "insufficient_funds": total_in <= fee,
        "input_count": len(utxos),
        "coin": "kaspa",
    }


def _placeholder_signature_script_hex_fallback(inp: dict[str, Any]) -> str:
    """Local fallback when an older kaspa_toccata.py lacks placeholder_signature_script_hex."""
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
        parts = []
        for _ in range(threshold):
            n = len(sig_hex) // 2
            parts.append(f"{n:02x}{sig_hex}")
        n = len(redeem) // 2
        if n < 0x4C:
            parts.append(f"{n:02x}{redeem}")
        elif n <= 0xFF:
            parts.append(f"4c{n:02x}{redeem}")
        else:
            parts.append(f"4d{n & 0xFF:02x}{(n >> 8) & 0xFF:02x}{redeem}")
        return "".join(parts)
    return "00" * 64


def _kaspa_fee_estimate_unsigned(cfg: WalletConfig, utxos: list[WalletUtxo], *, output_count: int = 2) -> dict[str, Any]:
    """Skeleton unsigned v2 with signed-size placeholders for relay-fee quotes."""
    from kaspa_toccata import template_unsigned_v0

    try:
        from kaspa_toccata import placeholder_signature_script_hex
    except ImportError:
        placeholder_signature_script_hex = _placeholder_signature_script_hex_fallback

    count = max(1, len(utxos))
    total_in = sum(int(u.amount) for u in utxos)
    per_in = max(1, total_in // count)
    base = template_unsigned_v0(
        input_count=count,
        output_count=output_count,
        input_amount=per_in,
        send_sompi=max(1, per_in // 2),
    )
    if not _is_kaspa_multisig(cfg):
        for inp in base.get("inputs") or []:
            if isinstance(inp, dict):
                inp["signature_script"] = placeholder_signature_script_hex(inp)
        return base
    lead = utxos[0]
    chain = 1 if lead.is_change else 0
    sign_index = int(lead.address_index)
    try:
        policy = _multisig_policy_for_input(cfg, chain, sign_index)
    except ValueError:
        policy = None
    if policy is None:
        return base
    from kaspa_multisig import multisig_p2sh_script_hex, multisig_redeem_script_hex

    redeem = multisig_redeem_script_hex(policy)
    p2sh = multisig_p2sh_script_hex(redeem)
    for i, inp in enumerate(base.get("inputs") or []):
        if not isinstance(inp, dict):
            continue
        utxo = utxos[i] if i < len(utxos) else lead
        inp["redeem_script_hex"] = redeem
        inp["sig_op_count"] = len(policy.cosigners)
        inp["utxo_script_hex"] = p2sh
        inp["receive_address"] = str(utxo.address)
        inp["signature_script"] = placeholder_signature_script_hex(inp)
    return base


def kaspa_send_fee_preview(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
    target_fee_sompi: int | None = None,
) -> dict[str, Any]:
    """Fee/mass quote for Send UI — avoids full multi-subset search for multisig."""
    if _is_kaspa_multisig(cfg):
        payee = normalize_kaspa_address(to_address)
        selected = _canonical_utxo_subset(utxos)
        manual = _try_manual_change_send(
            cfg,
            selected,
            to_address=payee,
            send_sompi=int(send_sompi),
            priority_fee=priority_fee,
        )
        if manual is not None:
            return manual[2]
        raise ValueError(
            _kaspa_insufficient_coins_message(
                cfg,
                selected,
                send_sompi=int(send_sompi),
                priority_fee=priority_fee,
            )
        )
    return preview_kaspa_send_summary(
        cfg,
        utxos,
        to_address=to_address,
        send_sompi=int(send_sompi),
        priority_fee=priority_fee,
        target_fee_sompi=target_fee_sompi,
    )


def _max_sendable_no_change_fallback(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    priority_fee: int | None = None,
) -> tuple[int, int] | None:
    """Estimate max send + fee when the generator search finds no valid payment+change tx."""
    sweep = _max_sendable_all_utxos_sweep(
        cfg, utxos, to_address=to_address, priority_fee=priority_fee
    )
    if sweep is not None:
        return sweep
    payee = normalize_kaspa_address(to_address)
    total_in = sum(int(u.amount) for u in utxos)
    relay = _kaspa_min_relay_fee(cfg, utxos, priority_fee, output_count=1)
    if total_in <= relay:
        return None
    send = total_in - relay
    alt = _try_no_change_send(
        cfg,
        utxos,
        to_address=payee,
        send_sompi=send,
        priority_fee=priority_fee,
    )
    if alt is not None:
        _selected, _pskt, _unsigned, summary = alt
        return int(summary.get("send_sompi") or send), _quote_fee_sompi(summary)
    return None


def _is_wallet_sweep_amount(
    send_sompi: int,
    wallet_total: int,
    priority_fee: int | None = None,
    *,
    cfg: WalletConfig | None = None,
    utxos: list[WalletUtxo] | None = None,
) -> bool:
    """True when the user is trying to spend essentially the whole selected wallet."""
    if wallet_total <= 0:
        return False
    if cfg is not None and utxos:
        relay = _kaspa_min_relay_fee(cfg, utxos, priority_fee, output_count=1)
    else:
        relay = max(_relay_fee_sompi(), int(priority_fee or 0))
    margin = max(500_000, wallet_total // 50)
    return int(send_sompi) >= wallet_total - relay - margin


def _max_sendable_all_utxos_sweep(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    priority_fee: int | None = None,
) -> tuple[int, int] | None:
    """Max send spending every provided UTXO in one no-change output (wallet sweep)."""
    all_utxos = _canonical_utxo_subset(utxos)
    total_in = sum(int(u.amount) for u in all_utxos)
    if total_in <= 0:
        return None
    payee = normalize_kaspa_address(to_address)
    fee = _kaspa_min_relay_fee(cfg, all_utxos, priority_fee, output_count=1)
    for _ in range(64):
        send = total_in - fee
        if send <= 0:
            return None
        try:
            pskt, unsigned = _build_pskt_multi_no_change(
                cfg, all_utxos, to_address=payee, send_sompi=send
            )
            ok, implicit, required = _unsigned_relay_check(unsigned)
            if ok:
                summary = _summary_from_no_change(
                    all_utxos,
                    payee=payee,
                    send_sompi=send,
                    unsigned=unsigned,
                )
                _mark_no_change_fee_as_network(summary)
                return int(summary.get("send_sompi") or send), int(summary.get("fee_sompi") or fee)
            bump = max(1, int(required or 0) - int(implicit or 0))
            fee += bump
        except Exception:
            return None
    return None


def _address_group_total_sompi(sub: list[WalletUtxo], wallet_utxos: list[WalletUtxo]) -> int:
    """Full wallet balance at the address(es) touched by this input subset."""
    if not sub:
        return 0
    keys = {_utxo_address_key(u) for u in sub}
    return sum(int(u.amount) for u in wallet_utxos if _utxo_address_key(u) in keys)


def _kaspa_build_sort_key(
    summary: dict[str, Any],
    *,
    input_count: int,
    input_total: int,
    wallet_total: int,
    sweep_intent: bool,
    address_count: int = 1,
    address_group_total: int = 0,
    min_address_index: int = 999_999,
    change_preference: int = 0,
) -> tuple[Any, ...]:
    """Lower is better: payment+change, receive over change, tight cover, sane fee."""
    no_change = 1 if summary.get("no_change") else 0
    fee = int(summary.get("fee_sompi") or 0)
    change = int(summary.get("change_sompi") or 0)
    has_change = change >= KASPA_MIN_SPENDABLE_REMAINDER_SOMPI
    relay = _relay_fee_sompi()
    fee_tier = 0 if fee <= relay * 2 else 1 if fee <= relay * 10 else 2
    if sweep_intent:
        return (no_change, fee, -input_total, input_count)
    if no_change or not has_change:
        return (
            1,
            change_preference,
            address_count,
            fee_tier,
            input_total,
            input_count,
            fee,
        )
    return (
        0,
        change_preference,
        address_count,
        input_total,
        fee_tier,
        fee,
        input_count,
        min_address_index,
    )


def _summary_input_count(
    summary: dict[str, Any],
    subset: list[WalletUtxo],
    unsigned: dict[str, Any] | None = None,
) -> int:
    """Actual spent inputs (SDK may use fewer than the candidate subset)."""
    if unsigned and isinstance(unsigned.get("inputs"), list) and unsigned["inputs"]:
        return len(unsigned["inputs"])
    keys = summary.get("used_utxo_keys")
    if isinstance(keys, list) and keys:
        return len(keys)
    n = int(summary.get("input_count") or 0)
    if n > 0:
        return n
    return len(subset)


def _max_sendable_kaspa_multisig(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    priority_fee: int | None = None,
) -> dict[str, Any]:
    """Fast max-send for multisig — no generator subset search."""
    selected = _canonical_utxo_subset(utxos)
    total_in = sum(int(u.amount) for u in selected)
    payee = normalize_kaspa_address(to_address)
    relay = _kaspa_min_relay_fee(cfg, selected, priority_fee)

    sweep = _max_sendable_all_utxos_sweep(
        cfg, selected, to_address=payee, priority_fee=priority_fee
    )
    if sweep is not None:
        best_send, best_fee = sweep
        return {
            "max_send_sompi": best_send,
            "max_send_kas": best_send / SOMPI_PER_KAS,
            "fee_sompi": best_fee,
            "fee_kas": best_fee / SOMPI_PER_KAS,
            "feerate": float(best_fee / total_in) if total_in > 0 else 1.0,
            "mass_grams": 0,
            "mass": 0,
            "spendable_sompi": best_send,
            "insufficient_funds": False,
            "input_count": len(selected),
            "coin": "kaspa",
        }

    best_send = 0
    best_fee = relay
    low, high = 0, max(0, total_in - relay - KASPA_MIN_SPENDABLE_REMAINDER_SOMPI)
    while low <= high:
        mid = (low + high) // 2
        if mid <= 0:
            break
        manual = _try_manual_change_send(
            cfg,
            selected,
            to_address=payee,
            send_sompi=mid,
            priority_fee=priority_fee,
        )
        if manual is not None:
            _pskt, _unsigned, summary = manual
            best_send = mid
            best_fee = int(summary.get("fee_sompi") or relay)
            low = mid + 1
        else:
            high = mid - 1

    if best_send > 0:
        return {
            "max_send_sompi": best_send,
            "max_send_kas": best_send / SOMPI_PER_KAS,
            "fee_sompi": best_fee,
            "fee_kas": best_fee / SOMPI_PER_KAS,
            "feerate": float(best_fee / total_in) if total_in > 0 else 1.0,
            "mass_grams": 0,
            "mass": 0,
            "spendable_sompi": best_send,
            "insufficient_funds": False,
            "input_count": len(selected),
            "coin": "kaspa",
        }

    fallback = _max_sendable_no_change_fallback(
        cfg, selected, to_address=payee, priority_fee=priority_fee
    )
    if fallback is not None:
        best_send, best_fee = fallback
        return {
            "max_send_sompi": best_send,
            "max_send_kas": best_send / SOMPI_PER_KAS,
            "fee_sompi": best_fee,
            "fee_kas": best_fee / SOMPI_PER_KAS,
            "feerate": float(best_fee / total_in) if total_in > 0 else 1.0,
            "mass_grams": 0,
            "mass": 0,
            "spendable_sompi": best_send,
            "insufficient_funds": False,
            "input_count": len(selected),
            "coin": "kaspa",
        }

    return {
        "max_send_sompi": 0,
        "max_send_kas": 0.0,
        "fee_sompi": relay,
        "fee_kas": relay / SOMPI_PER_KAS,
        "feerate": float(relay / total_in) if total_in > 0 else 1.0,
        "mass_grams": 0,
        "mass": 0,
        "spendable_sompi": 0,
        "insufficient_funds": total_in <= relay,
        "input_count": len(selected),
        "coin": "kaspa",
    }


def max_sendable_kaspa(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    priority_fee: int | None = None,
) -> dict[str, Any]:
    """Largest recipient amount the generator can build (fee + change reserved).

    KIP-9 storage mass can reject *moderate* sends (payment + change) while allowing
    near-max sends. Search from the top down — not a classic low→high binary search.
    """
    if not utxos:
        raise ValueError("At least one UTXO required")
    if _is_kaspa_multisig(cfg):
        return _max_sendable_kaspa_multisig(
            cfg, utxos, to_address=to_address, priority_fee=priority_fee
        )
    total_in = sum(int(u.amount) for u in utxos)
    payee = normalize_kaspa_address(to_address)
    relay = _kaspa_min_relay_fee(cfg, utxos, priority_fee)
    sweep = _max_sendable_all_utxos_sweep(
        cfg, utxos, to_address=payee, priority_fee=priority_fee
    )
    if sweep is not None:
        best_send, best_fee = sweep
        return {
            "max_send_sompi": best_send,
            "max_send_kas": best_send / SOMPI_PER_KAS,
            "fee_sompi": best_fee,
            "fee_kas": best_fee / SOMPI_PER_KAS,
            "feerate": float(best_fee / total_in) if total_in > 0 else 1.0,
            "mass_grams": 0,
            "mass": 0,
            "spendable_sompi": best_send,
            "insufficient_funds": False,
            "input_count": len(utxos),
            "coin": "kaspa",
        }
    sweep_send = max(0, total_in - max(relay, int(priority_fee or 0)))
    if sweep_send > 0 and not _warrants_change_output(utxos, sweep_send, priority_fee):
        alt = _try_no_change_send(
            cfg,
            utxos,
            to_address=payee,
            send_sompi=sweep_send,
            priority_fee=priority_fee,
        )
        if alt is not None:
            _selected, _pskt, _unsigned, summary = alt
            best_send = int(summary.get("send_sompi") or sweep_send)
            best_fee = _quote_fee_sompi(summary)
            return {
                "max_send_sompi": best_send,
                "max_send_kas": best_send / SOMPI_PER_KAS,
                "fee_sompi": best_fee,
                "fee_kas": best_fee / SOMPI_PER_KAS,
                "feerate": float(best_fee / total_in) if total_in > 0 else 1.0,
                "mass_grams": int(summary.get("mass") or 0),
                "mass": int(summary.get("mass") or 0),
                "spendable_sompi": best_send,
                "insufficient_funds": False,
                "input_count": len(utxos),
                "coin": "kaspa",
            }
    step = max(1, total_in // 500)
    seed_send = 0
    seed_fee = 0
    probe = total_in - 1
    while probe > 0:
        fee = _probe_create_fee(
            cfg, utxos, to_address=payee, send_sompi=probe, priority_fee=priority_fee
        )
        if fee is not None:
            seed_send = probe
            seed_fee = fee
            break
        probe -= step
    best_send = seed_send
    best_fee = seed_fee
    if seed_send > 0:
        low, high = seed_send, total_in - 1
        while low <= high:
            mid = (low + high) // 2
            fee = _probe_create_fee(
                cfg, utxos, to_address=payee, send_sompi=mid, priority_fee=priority_fee
            )
            if fee is not None:
                best_send = mid
                best_fee = fee
                low = mid + 1
            else:
                high = mid - 1
    if best_send <= 0:
        fallback = _max_sendable_no_change_fallback(
            cfg, utxos, to_address=payee, priority_fee=priority_fee
        )
        if fallback is not None:
            best_send, best_fee = fallback
    if best_fee <= 0:
        best_fee = _relay_fee_sompi()
    return {
        "max_send_sompi": best_send,
        "max_send_kas": best_send / SOMPI_PER_KAS,
        "fee_sompi": best_fee,
        "fee_kas": best_fee / SOMPI_PER_KAS,
        "feerate": float(best_fee / total_in) if total_in > 0 else 1.0,
        "mass_grams": 0,
        "mass": 0,
        "spendable_sompi": best_send,
        "insufficient_funds": best_send <= 0,
        "input_count": len(utxos),
        "coin": "kaspa",
    }


def estimate_kaspa_send(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
) -> dict[str, Any]:
    """Alias for quote_kaspa_send (create_transactions — same as build)."""
    if not utxos:
        raise ValueError("At least one UTXO required")
    return quote_kaspa_send(
        cfg,
        utxos,
        to_address=to_address,
        send_sompi=int(send_sompi),
        priority_fee=priority_fee,
    )


def _maximum_standard_mass() -> int:
    try:
        from kaspa import maximum_standard_transaction_mass

        return int(maximum_standard_transaction_mass())
    except Exception:
        return 100_000


def build_pskt_from_transaction(
    tx_dict: dict[str, Any],
    *,
    cfg: WalletConfig,
    utxo_meta: list[WalletUtxo],
    kpub: str,
    fingerprint: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Convert rusty-kaspa Transaction dict to PSKT + SeedMask v2 (multi-input)."""
    account = effective_wallet_account(cfg)
    inputs_pskt: list[dict[str, Any]] = []
    meta_by_outpoint = {
        f"{_norm_txid(u.transaction_id)}:{u.output_index}": u for u in utxo_meta
    }

    for inp in tx_dict.get("inputs") or []:
        prev = inp.get("previousOutpoint") or {}
        txid = _norm_txid(str(prev.get("transactionId", "")))
        idx = int(prev.get("index", 0))
        utxo = inp.get("utxo") or {}
        amount = int(utxo.get("amount", 0))
        spk = utxo.get("scriptPublicKey") or {}
        ver, _ = _parse_spk_wire(spk)
        meta = meta_by_outpoint.get(f"{txid}:{idx}")
        chain = 1 if meta and meta.is_change else 0
        sign_index = int(meta.address_index) if meta else 0
        receive = normalize_kaspa_address(meta.address) if meta else ""
        bip32: dict[str, Any] = {}
        redeem_script_hex = None
        sig_op_count = int(inp.get("sigOpCount") or 1)
        if _is_kaspa_multisig(cfg):
            from kaspa_multisig import multisig_redeem_script_hex

            policy = _multisig_policy_for_input(cfg, chain, sign_index)
            if policy is None:
                raise ValueError("Invalid Kaspa multisig policy")
            redeem_script_hex = multisig_redeem_script_hex(policy)
            sig_op_count = len(policy.cosigners)
            for cosigner in policy.cosigners:
                bip32[cosigner.pubkey] = _key_source(cosigner.fingerprint, cosigner.derivation_path)
        elif kpub.strip():
            leaf_path = _leaf_derivation_path(account, chain, sign_index)
            fp = (fingerprint or "").strip() or "00000000"
            pubkey_hex = _signing_pubkey_hex(kpub, chain, sign_index)
            if pubkey_hex:
                bip32[pubkey_hex] = _key_source(fp, leaf_path)
        if isinstance(spk, dict) and isinstance(spk.get("script"), str):
            wire = _spk_wire_hex(ver, spk["script"])
        else:
            wire = _spk_wire_hex(ver, kaspa_address_to_script_hex(receive) if receive else "")
        row = {
            "utxoEntry": {
                "amount": amount,
                "scriptPublicKey": wire,
                "blockDaaScore": int(
                    utxo.get("blockDaaScore")
                    or (meta.block_daa_score if meta else 0)
                    or 0
                ),
                "isCoinbase": bool(
                    utxo.get("isCoinbase")
                    if utxo.get("isCoinbase") is not None
                    else (meta.is_coinbase if meta else False)
                ),
            },
            "previousOutpoint": {"transactionId": txid, "index": idx},
            "sequence": inp.get("sequence"),
            "partialSigs": {},
            "sighashType": 1,
            "sigOpCount": sig_op_count,
            "bip32Derivations": bip32,
            "proprietaries": {},
        }
        if redeem_script_hex:
            row["redeemScript"] = redeem_script_hex
        inputs_pskt.append(row)

    outputs_pskt: list[dict[str, Any]] = []
    for out in tx_dict.get("outputs") or []:
        spk = out.get("scriptPublicKey") or {}
        ver, script_hex = _parse_spk_wire(spk)
        outputs_pskt.append(
            {
                "amount": int(out.get("value", 0)),
                "scriptPublicKey": _spk_wire_hex(ver, script_hex),
                "bip32Derivations": {},
                "proprietaries": {},
            }
        )

    xpubs: dict[str, Any] = {}
    if _is_kaspa_multisig(cfg):
        xpubs.update(_multisig_xpub_sources(cfg))
    elif kpub.strip():
        from kaspa_pskt import _account_derivation_path

        fp = (fingerprint or "").strip() or "00000000"
        xpubs[kpub.strip()] = _key_source(fp, _account_derivation_path(account))

    pskt = normalize_pskt_inner(
        {
            "global": {
                "version": 1,
                "txVersion": int(tx_dict.get("version", 0)),
                "inputCount": len(inputs_pskt),
                "outputCount": len(outputs_pskt),
                "inputsModifiable": False,
                "outputsModifiable": False,
                "fallbackLockTime": int(tx_dict.get("lockTime", 0)) or None,
                "xpubs": xpubs,
                "proprietaries": {},
                "payload": str(tx_dict.get("payload") or ""),
            },
            "inputs": inputs_pskt,
            "outputs": outputs_pskt,
        }
    )
    v2 = _pskt_to_seedmask_v2_multi(pskt, kpub=kpub, account=account, utxo_meta=utxo_meta)
    outs = v2.get("outputs") or []
    if outs:
        outs[0]["kaspa_address"] = ""
    return pskt, v2


def _pskt_to_seedmask_v2_multi(
    pskt: dict[str, Any],
    *,
    kpub: str,
    account: int,
    utxo_meta: list[WalletUtxo],
) -> dict[str, Any]:
    """Multi-input SeedMask v2 from PSKT."""
    base = pskt_to_seedmask_v2(pskt, kpub=kpub, account=account)
    inputs_pskt = pskt.get("inputs") or []

    meta_by_outpoint = {
        f"{_norm_txid(u.transaction_id)}:{u.output_index}": u for u in utxo_meta
    }
    inputs_v2 = []
    for inp in inputs_pskt:
        prev = inp.get("previousOutpoint") or {}
        txid = str(prev.get("transactionId", ""))
        idx = int(prev.get("index", 0))
        utxo = inp.get("utxoEntry") or {}
        ver, script_hex = _parse_spk_wire(utxo.get("scriptPublicKey"))
        meta = meta_by_outpoint.get(f"{_norm_txid(txid)}:{idx}")
        if meta:
            row = input_v2_fields_from_utxo(meta, script_hex=script_hex)
        else:
            row = {
                "sign_chain": 0,
                "sign_address_index": 0,
                "receive_address": "",
                "block_daa_score": 0,
                "is_coinbase": False,
            }
        inputs_v2.append(
            {
                **row,
                "prev_tx_id": txid,
                "prev_index": idx,
                "sequence": int(inp.get("sequence") if inp.get("sequence") is not None else 0),
                "sig_op_count": int(inp.get("sigOpCount") or 1),
                "utxo_amount": int(utxo.get("amount", 0)),
                "utxo_script_version": ver,
                "utxo_script_hex": script_hex,
            }
        )
        redeem = inp.get("redeemScript")
        if isinstance(redeem, str) and redeem.strip():
            inputs_v2[-1]["redeem_script_hex"] = redeem.strip().lower().replace("0x", "")
    base["inputs"] = inputs_v2
    return base


def _warrants_change_output(
    utxos: list[WalletUtxo],
    send_sompi: int,
    priority_fee: int | None = None,
) -> bool:
    """Use generator (payment + change) when leftover after min relay fee is spendable."""
    _ = priority_fee  # custom/priority fee must not suppress change outputs
    total_in = sum(int(u.amount) for u in utxos)
    leftover = total_in - int(send_sompi)
    if leftover <= 0:
        return False
    min_relay = _relay_fee_sompi()
    return leftover > min_relay + KASPA_MIN_SPENDABLE_REMAINDER_SOMPI


def _build_with_generator(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
    max_send_sompi: int,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    from kaspa import Address, NetworkId, create_transactions

    payee = normalize_kaspa_address(to_address)
    utxos = _canonical_utxo_subset(utxos)
    refs = [_utxo_ref_from_wallet_utxo(u) for u in utxos]
    change = Address(_change_address(cfg, utxos))
    pri = int(priority_fee or 0)
    last_implicit = 0
    last_min = _relay_fee_sompi(input_count=len(utxos), output_count=2)
    for _ in range(24):
        result = create_transactions(
            refs,
            change,
            network_id=NetworkId("mainnet"),
            outputs=[{"address": payee, "amount": int(send_sompi)}],
            priority_fee=pri,
            priority_entries=refs,
        )
        pending = (result.get("transactions") or [None])[0]
        if pending is None:
            raise ValueError("Generator produced no transaction")
        tx_dict = pending.transaction.to_dict() if hasattr(pending.transaction, "to_dict") else {}
        kpub = (cfg.kpub or "").strip()
        fingerprint = resolve_kaspa_fingerprint(cfg, kpub)
        pskt, unsigned = build_pskt_from_transaction(
            tx_dict, cfg=cfg, utxo_meta=utxos, kpub=kpub, fingerprint=fingerprint
        )
        outs = unsigned.get("outputs") or []
        if outs:
            outs[0]["kaspa_address"] = payee
        summary = _summary_from_pending(
            pending, tx_dict, cfg=cfg, utxos=utxos, payee=payee, send_sompi=int(send_sompi)
        )
        summary["send_kas"] = int(send_sompi) / SOMPI_PER_KAS
        change_addr, change_idx = _change_target(cfg, utxos)
        if len(outs) > 1 and int(summary.get("change_sompi") or 0) > 0:
            outs[1]["kaspa_address"] = change_addr
            outs[1]["is_change"] = True
            outs[1]["change_address_index"] = change_idx
        ok, last_implicit, last_min = _unsigned_relay_check(unsigned)
        if ok:
            _reject_unspendable_kaspa_remainder(
                utxos,
                int(send_sompi),
                summary,
                max_send_sompi=max_send_sompi,
            )
            return pskt, unsigned, summary
        gap = max(0, last_min - last_implicit)
        if gap <= 0:
            break
        pri += gap
    raise ValueError(
        f"Network fee {last_implicit} sompi is below network minimum {last_min} sompi "
        f"for these coins. Try Max, a slightly different amount, or different coins."
    )


def _priority_fee_for_target(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    target_fee_sompi: int,
    tolerance: int = KASPA_CUSTOM_FEE_TOLERANCE_SOMPI,
) -> int | None:
    """Find priority_fee so generator fee is close to target_fee_sompi."""
    target = int(target_fee_sompi)
    send = int(send_sompi)
    total_in = sum(int(u.amount) for u in utxos)
    leftover = total_in - send
    if leftover < target:
        return None
    # Sweep (no change) or change >= dust are valid; dust-sized change is not.
    change_after_fee = leftover - target
    if 0 < change_after_fee < KASPA_MIN_SPENDABLE_REMAINDER_SOMPI:
        return None

    base = _generator_build_amounts(
        cfg, utxos, to_address=to_address, send_sompi=send, priority_fee=0
    )
    if base is not None:
        base_fee = int(base.get("fee_sompi") or 0)
        if abs(base_fee - target) <= tolerance:
            return 0
        if base_fee > target:
            return None

    if target <= _relay_fee_sompi() + tolerance:
        return 0 if base is not None else None

    lo, hi = 0, max(target * 2, target + 50_000)
    best_pri: int | None = None
    best_delta = target + 1
    for _ in range(24):
        if lo > hi:
            break
        mid = (lo + hi) // 2
        amounts = _generator_build_amounts(
            cfg, utxos, to_address=to_address, send_sompi=send, priority_fee=mid
        )
        if amounts is None:
            lo = mid + 1
            continue
        fee = int(amounts.get("fee_sompi") or 0)
        delta = abs(fee - target)
        if delta < best_delta:
            best_pri = mid
            best_delta = delta
            if delta <= tolerance:
                break
        if fee < target:
            lo = mid + 1
        else:
            hi = mid - 1

    if best_pri is None or best_delta > tolerance:
        return None
    return best_pri


def kaspa_custom_fee_feasible(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    target_fee_sompi: int,
) -> tuple[bool, dict[str, Any] | None]:
    """Whether send + custom fee can be built from some UTXO subset; returns best quote."""
    payee = normalize_kaspa_address(to_address)
    subsets = _utxo_subsets_to_try(
        utxos, int(send_sompi), None, target_fee_sompi=int(target_fee_sompi)
    )
    best_quote: dict[str, Any] | None = None
    for subset in subsets:
        priority = _priority_fee_for_target(
            cfg,
            subset,
            to_address=payee,
            send_sompi=int(send_sompi),
            target_fee_sompi=int(target_fee_sompi),
        )
        if priority is None:
            continue
        amounts = _generator_build_amounts(
            cfg,
            subset,
            to_address=payee,
            send_sompi=int(send_sompi),
            priority_fee=priority,
        )
        if amounts is None:
            continue
        fee = int(amounts.get("fee_sompi") or 0)
        if abs(fee - int(target_fee_sompi)) > KASPA_CUSTOM_FEE_TOLERANCE_SOMPI:
            continue
        quote = {
            "fee_sompi": fee,
            "fee_kas": fee / SOMPI_PER_KAS,
            "network_fee_sompi": fee,
            "change_sompi": int(amounts.get("change_sompi") or 0),
            "change_kas": int(amounts.get("change_sompi") or 0) / SOMPI_PER_KAS,
            "input_total_sompi": int(amounts.get("input_total_sompi") or 0),
            "input_total_kas": int(amounts.get("input_total_sompi") or 0) / SOMPI_PER_KAS,
            "input_count": len(subset),
            "send_sompi": int(send_sompi),
            "coin": "kaspa",
        }
        if best_quote is None or int(quote["input_total_sompi"]) < int(
            best_quote.get("input_total_sompi") or 0
        ):
            best_quote = quote
    return best_quote is not None, best_quote


def max_sendable_kaspa_custom_fee(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    target_fee_sompi: int,
) -> dict[str, Any]:
    """Largest recipient amount buildable with a fixed custom network fee."""
    if not utxos:
        raise ValueError("At least one UTXO required")
    payee = normalize_kaspa_address(to_address)
    selected = _canonical_utxo_subset(utxos)
    total_in = sum(int(u.amount) for u in selected)
    target = int(target_fee_sompi)
    # Prefer sweep (balance − fee). Fall back to leaving dust-sized change when needed.
    high = max(0, total_in - target)
    relay = _kaspa_min_relay_fee(cfg, selected, None)

    best_send = 0
    best_quote: dict[str, Any] | None = None
    low = 0
    while low <= high:
        mid = (low + high) // 2
        if mid <= 0:
            break
        change_after = total_in - mid - target
        if 0 < change_after < KASPA_MIN_SPENDABLE_REMAINDER_SOMPI:
            # Dust change band — try lower send so change can meet minimum.
            high = mid - 1
            continue
        ok, quote = kaspa_custom_fee_feasible(
            cfg,
            selected,
            to_address=payee,
            send_sompi=mid,
            target_fee_sompi=target,
        )
        if ok and quote is not None:
            best_send = mid
            best_quote = quote
            low = mid + 1
        else:
            high = mid - 1

    # Serious wallets: Max = balance − custom fee. Generator search is best-effort;
    # build still validates the final transaction.
    arithmetic_max = max(0, total_in - target)
    if arithmetic_max <= 0:
        return {
            "max_send_sompi": 0,
            "max_send_kas": 0.0,
            "fee_sompi": target,
            "fee_kas": target / SOMPI_PER_KAS,
            "network_fee_sompi": target,
            "feerate": float(target / total_in) if total_in > 0 else 1.0,
            "mass_grams": 0,
            "mass": 0,
            "spendable_sompi": 0,
            "insufficient_funds": True,
            "input_count": len(selected),
            "coin": "kaspa",
            "send_amount_valid": False,
            "send_block_reason": (
                "Selected coins cannot cover this custom network fee. "
                "Lower the fee or add more funds."
            ),
        }
    if best_send < arithmetic_max or best_quote is None:
        change_sompi = max(0, total_in - arithmetic_max - target)
        best_send = arithmetic_max
        best_quote = {
            "fee_sompi": target,
            "fee_kas": target / SOMPI_PER_KAS,
            "network_fee_sompi": target,
            "change_sompi": change_sompi,
            "change_kas": change_sompi / SOMPI_PER_KAS,
            "input_total_sompi": total_in,
            "input_total_kas": total_in / SOMPI_PER_KAS,
            "input_count": len(selected),
            "send_sompi": best_send,
            "coin": "kaspa",
        }

    out = dict(best_quote)
    out["max_send_sompi"] = best_send
    out["max_send_kas"] = best_send / SOMPI_PER_KAS
    out["spendable_sompi"] = best_send
    out["fee_sompi"] = target
    out["fee_kas"] = target / SOMPI_PER_KAS
    out["network_fee_sompi"] = target
    out["send_amount_valid"] = True
    out["insufficient_funds"] = False
    out["input_count"] = len(selected)
    out["coin"] = "kaspa"
    out.pop("send_block_reason", None)
    if out.get("mass") is None and relay > 0:
        out["mass"] = 0
        out["mass_grams"] = 0
    return out


def _utxo_subsets_to_try(
    utxos: list[WalletUtxo],
    send_sompi: int,
    priority_fee: int | None,
    *,
    target_fee_sompi: int | None = None,
) -> list[list[WalletUtxo]]:
    """Try single addresses first, then minimal address-group covers."""
    min_change = KASPA_MIN_SPENDABLE_REMAINDER_SOMPI
    send = int(send_sompi)
    if target_fee_sompi is not None:
        needed = send + int(target_fee_sompi) + min_change
    else:
        min_fee = max(_relay_fee_sompi(), int(priority_fee or 0))
        needed = send + min_fee + min_change

    def subset_key(sub: list[WalletUtxo]) -> tuple[str, ...]:
        return tuple(sorted(f"{u.transaction_id}:{u.output_index}" for u in sub))

    candidates: list[list[WalletUtxo]] = []
    seen: set[tuple[str, ...]] = set()
    for u in utxos:
        if int(u.amount) >= needed:
            _register_subset_candidates(candidates, seen, subset_key, [u])
    groups = _group_utxos_by_address(utxos)
    headroom = _address_headroom_sompi(send)
    qualifying_groups = [
        g
        for g in groups
        if sum(int(u.amount) for u in g) >= needed
        and sum(int(u.amount) for u in g) - send >= headroom
    ]

    for group in sorted(
        qualifying_groups,
        key=lambda g: (
            1 if bool(g[0].is_change) else 0,
            sum(int(u.amount) for u in g),
            int(g[0].address_index),
        ),
    ):
        _add_intra_address_candidates(
            group,
            needed=needed,
            send_sompi=send,
            seen=seen,
            candidates=candidates,
            subset_key=subset_key,
        )

    _add_address_group_combo_candidates(
        groups,
        needed=needed,
        seen=seen,
        candidates=candidates,
        subset_key=subset_key,
    )

    if not qualifying_groups:
        _register_subset_candidates(
            candidates,
            seen,
            subset_key,
            _minimal_utxo_greedy_largest(utxos, needed),
        )

    if not candidates:
        return [list(utxos)]

    min_fee = max(_relay_fee_sompi(), int(priority_fee or 0))
    candidates.sort(
        key=lambda sub: _subset_candidate_rank(
            sub,
            send_sompi=send,
            needed=needed,
            min_fee=min_fee,
            min_change=min_change,
        )
    )
    return candidates


def annotate_kaspa_build_summary(
    summary: dict[str, Any],
    selected_utxos: list[WalletUtxo],
    *,
    requested_fee_sompi: int | None = None,
) -> dict[str, Any]:
    selected_total = sum(int(u.amount) for u in selected_utxos)
    used = int(summary.get("input_total_sompi") or 0)
    unused = max(0, selected_total - used)
    if unused > 1_000:
        summary["unused_selected_sompi"] = unused
        summary["unused_selected_kas"] = unused / SOMPI_PER_KAS
    if requested_fee_sompi is not None:
        summary["requested_fee_sompi"] = int(requested_fee_sompi)
    return summary


def _build_single_transaction_subset(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
    allow_no_change: bool = False,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    payee = normalize_kaspa_address(to_address)
    total_in = sum(int(u.amount) for u in utxos)
    relay = _kaspa_min_relay_fee(cfg, utxos, priority_fee)
    max_send = max(0, total_in - relay)
    warrants_change = _warrants_change_output(utxos, int(send_sompi), priority_fee)

    if _is_kaspa_multisig(cfg):
        if warrants_change or not allow_no_change:
            manual = _try_manual_change_send(
                cfg,
                utxos,
                to_address=payee,
                send_sompi=int(send_sompi),
                priority_fee=priority_fee,
            )
            if manual is not None:
                return manual
        if allow_no_change or total_in >= int(send_sompi) + relay:
            alt = _try_no_change_send(
                cfg,
                utxos,
                to_address=payee,
                send_sompi=int(send_sompi),
                priority_fee=priority_fee,
            )
            if alt is not None:
                _selected, pskt, unsigned, summary = alt
                summary["send_kas"] = int(send_sompi) / SOMPI_PER_KAS
                return pskt, unsigned, summary
        raise ValueError(
            _kaspa_insufficient_coins_message(
                cfg,
                utxos,
                send_sompi=int(send_sompi),
                priority_fee=priority_fee,
            )
        )

    if warrants_change or not allow_no_change:
        manual = _try_manual_change_send(
            cfg,
            utxos,
            to_address=payee,
            send_sompi=int(send_sompi),
            priority_fee=priority_fee,
        )
        if manual is not None:
            return manual
        try:
            return _build_with_generator(
                cfg,
                utxos,
                to_address=payee,
                send_sompi=int(send_sompi),
                priority_fee=priority_fee,
                max_send_sompi=max_send,
            )
        except KeyError as exc:
            raise _kaspa_key_error(exc) from exc
        except ValueError:
            if not allow_no_change:
                raise
        except Exception:
            if not allow_no_change:
                raise

    if allow_no_change:
        alt = _try_no_change_send(
            cfg,
            utxos,
            to_address=payee,
            send_sompi=int(send_sompi),
            priority_fee=priority_fee,
        )
        if alt is not None:
            _selected, pskt, unsigned, summary = alt
            summary["send_kas"] = int(send_sompi) / SOMPI_PER_KAS
            return pskt, unsigned, summary

    return _build_with_generator(
        cfg,
        utxos,
        to_address=payee,
        send_sompi=int(send_sompi),
        priority_fee=priority_fee,
        max_send_sompi=max_send,
    )


def preview_kaspa_send_summary(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
    target_fee_sompi: int | None = None,
) -> dict[str, Any]:
    """Fee/mass quote using the same coin selection as build_single_transaction."""
    _pskt, _unsigned, summary = build_single_transaction(
        cfg,
        utxos,
        to_address=to_address,
        send_sompi=int(send_sompi),
        priority_fee=priority_fee,
        target_fee_sompi=target_fee_sompi,
    )
    return summary


def _build_kaspa_multisig_transaction(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
    target_fee_sompi: int | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Build multisig tx on the selected UTXO set only — no combinatorial subset search."""
    payee = normalize_kaspa_address(to_address)
    selected = _canonical_utxo_subset(utxos)
    total_in = sum(int(u.amount) for u in selected)
    sweep_intent = _is_wallet_sweep_amount(
        int(send_sompi),
        total_in,
        priority_fee,
        cfg=cfg,
        utxos=selected,
    )
    allow_no_change = sweep_intent or target_fee_sompi is not None

    if target_fee_sompi is not None:
        target = int(target_fee_sompi)
        subset_priority = _priority_fee_for_target(
            cfg,
            selected,
            to_address=payee,
            send_sompi=int(send_sompi),
            target_fee_sompi=target,
        )
        if subset_priority is None and not _warrants_change_output(
            selected, int(send_sompi), priority_fee
        ):
            implicit_fee = total_in - int(send_sompi)
            relay = _kaspa_min_relay_fee(cfg, selected, priority_fee, output_count=1)
            if (
                implicit_fee >= relay
                and abs(implicit_fee - target) <= KASPA_CUSTOM_FEE_TOLERANCE_SOMPI
            ):
                subset_priority = None
            else:
                raise ValueError(
                    _kaspa_insufficient_coins_message(
                        cfg,
                        selected,
                        send_sompi=int(send_sompi),
                        priority_fee=priority_fee,
                    )
                )
        pskt, unsigned, summary = _build_single_transaction_subset(
            cfg,
            selected,
            to_address=payee,
            send_sompi=int(send_sompi),
            priority_fee=subset_priority if subset_priority else None,
            allow_no_change=allow_no_change,
        )
        actual_fee = int(summary.get("fee_sompi") or 0)
        if abs(actual_fee - target) > KASPA_CUSTOM_FEE_TOLERANCE_SOMPI:
            retry_pri = max(0, int(subset_priority or 0) + target - actual_fee)
            pskt, unsigned, summary = _build_single_transaction_subset(
                cfg,
                selected,
                to_address=payee,
                send_sompi=int(send_sompi),
                priority_fee=retry_pri if retry_pri > 0 else None,
                allow_no_change=allow_no_change,
            )
        if sweep_intent and summary.get("no_change"):
            _mark_no_change_fee_as_network(summary)
        return pskt, unsigned, summary

    pskt, unsigned, summary = _build_single_transaction_subset(
        cfg,
        selected,
        to_address=payee,
        send_sompi=int(send_sompi),
        priority_fee=priority_fee,
        allow_no_change=allow_no_change,
    )
    if sweep_intent and summary.get("no_change"):
        _mark_no_change_fee_as_network(summary)
    return pskt, unsigned, summary


def build_single_transaction(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str,
    send_sompi: int,
    priority_fee: int | None = None,
    target_fee_sompi: int | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Build one Kaspa tx; return (pskt, unsigned_v2, summary)."""
    if not utxos:
        raise ValueError("At least one UTXO required")
    if _is_kaspa_multisig(cfg):
        return _build_kaspa_multisig_transaction(
            cfg,
            utxos,
            to_address=to_address,
            send_sompi=int(send_sompi),
            priority_fee=priority_fee,
            target_fee_sompi=target_fee_sompi,
        )
    payee = normalize_kaspa_address(to_address)
    wallet_total = sum(int(u.amount) for u in utxos)
    sweep_intent = _is_wallet_sweep_amount(
        int(send_sompi), wallet_total, priority_fee, cfg=cfg, utxos=utxos
    )
    allow_no_change = sweep_intent or target_fee_sompi is not None
    subsets = _utxo_subsets_to_try(
        utxos,
        int(send_sompi),
        priority_fee,
        target_fee_sompi=target_fee_sompi,
    )
    if sweep_intent:
        full = _canonical_utxo_subset(utxos)
        full_key = tuple(
            sorted(f"{u.transaction_id}:{u.output_index}" for u in full)
        )
        subsets = [full] + [
            s
            for s in subsets
            if tuple(sorted(f"{u.transaction_id}:{u.output_index}" for u in s)) != full_key
        ]
    last_exc: Exception | None = None
    best_result: tuple[dict[str, Any], dict[str, Any], dict[str, Any]] | None = None
    best_sort_key: tuple[Any, ...] | None = None

    def _consider_build(
        subset: list[WalletUtxo],
        summary: dict[str, Any],
        pskt: dict[str, Any],
        unsigned: dict[str, Any],
    ) -> None:
        nonlocal best_result, best_sort_key
        if not _summary_is_viable_payment(
            summary,
            send_sompi=int(send_sompi),
            sweep_intent=sweep_intent,
            allow_no_change=allow_no_change,
        ):
            return
        input_total = int(summary.get("input_total_sompi") or 0)
        min_addr_idx = min((int(u.address_index) for u in subset), default=999_999)
        actual_inputs = _summary_input_count(summary, subset, unsigned)
        sort_key = _kaspa_build_sort_key(
            summary,
            input_count=actual_inputs,
            input_total=input_total,
            wallet_total=wallet_total,
            sweep_intent=sweep_intent,
            address_count=_subset_address_count(subset),
            address_group_total=_address_group_total_sompi(subset, utxos),
            min_address_index=min_addr_idx,
            change_preference=_subset_change_preference(subset),
        )
        if best_sort_key is None or sort_key < best_sort_key:
            best_sort_key = sort_key
            best_result = (pskt, unsigned, summary)

    def _prefer_subset(
        subset: list[WalletUtxo],
        input_total: int,
        *,
        fee_sompi: int,
        summary: dict[str, Any],
        pskt: dict[str, Any],
        unsigned: dict[str, Any],
    ) -> bool:
        _consider_build(subset, summary, pskt, unsigned)
        return True

    for subset in subsets:
        subset_priority = priority_fee
        if target_fee_sompi is not None:
            target = int(target_fee_sompi)
            if not _warrants_change_output(subset, int(send_sompi), priority_fee):
                implicit_fee = sum(int(u.amount) for u in subset) - int(send_sompi)
                relay = _relay_fee_sompi()
                if (
                    implicit_fee >= relay
                    and abs(implicit_fee - target) <= KASPA_CUSTOM_FEE_TOLERANCE_SOMPI
                ):
                    try:
                        pskt, unsigned, summary = _build_single_transaction_subset(
                            cfg,
                            subset,
                            to_address=payee,
                            send_sompi=int(send_sompi),
                            priority_fee=None,
                            allow_no_change=allow_no_change,
                        )
                        actual_fee = int(summary.get("fee_sompi") or implicit_fee)
                        if abs(actual_fee - target) <= KASPA_CUSTOM_FEE_TOLERANCE_SOMPI:
                            input_total = int(summary.get("input_total_sompi") or 0)
                            _prefer_subset(
                                subset,
                                input_total,
                                fee_sompi=actual_fee,
                                summary=summary,
                                pskt=pskt,
                                unsigned=unsigned,
                            )
                        continue
                    except Exception as exc:
                        last_exc = exc
                        continue
            subset_priority = _priority_fee_for_target(
                cfg,
                subset,
                to_address=payee,
                send_sompi=int(send_sompi),
                target_fee_sompi=target,
            )
            if subset_priority is None:
                continue
        try:
            pskt, unsigned, summary = _build_single_transaction_subset(
                cfg,
                subset,
                to_address=payee,
                send_sompi=int(send_sompi),
                priority_fee=subset_priority if subset_priority else None,
                allow_no_change=allow_no_change,
            )
            if target_fee_sompi is not None:
                actual_fee = int(summary.get("fee_sompi") or 0)
                if abs(actual_fee - int(target_fee_sompi)) > KASPA_CUSTOM_FEE_TOLERANCE_SOMPI:
                    retry_pri = max(
                        0, int(subset_priority or 0) + int(target_fee_sompi) - actual_fee
                    )
                    pskt, unsigned, summary = _build_single_transaction_subset(
                        cfg,
                        subset,
                        to_address=payee,
                        send_sompi=int(send_sompi),
                        priority_fee=retry_pri if retry_pri > 0 else None,
                        allow_no_change=allow_no_change,
                    )
                    actual_fee = int(summary.get("fee_sompi") or 0)
                    if abs(actual_fee - int(target_fee_sompi)) > KASPA_CUSTOM_FEE_TOLERANCE_SOMPI:
                        continue
            input_total = int(summary.get("input_total_sompi") or 0)
            actual_fee = int(summary.get("fee_sompi") or 0)
            if target_fee_sompi is not None:
                _prefer_subset(
                    subset,
                    input_total,
                    fee_sompi=actual_fee,
                    summary=summary,
                    pskt=pskt,
                    unsigned=unsigned,
                )
                continue
            _consider_build(subset, summary, pskt, unsigned)
        except KeyError as exc:
            raise _kaspa_key_error(exc) from exc
        except Exception as exc:
            last_exc = exc
            continue

    if best_result is not None:
        if sweep_intent and best_result[2].get("no_change"):
            _mark_no_change_fee_as_network(best_result[2])
        return best_result

    neighbors = kip9_send_neighbors(
        cfg,
        utxos,
        to_address=payee,
        send_sompi=int(send_sompi),
        priority_fee=priority_fee,
    )
    hints: list[str] = []
    below = neighbors.get("below_sompi")
    above = neighbors.get("above_sompi")
    if below is not None:
        hints.append(f"up to {int(below) / SOMPI_PER_KAS:.8f} KAS")
    if above is not None:
        hints.append(f"from {int(above) / SOMPI_PER_KAS:.8f} KAS")
    hint = f" Try {' or '.join(hints)}." if hints else ""
    base = (
        "This amount cannot be sent with the selected coins (Kaspa KIP-9 storage mass). "
        "Try Max, a slightly different amount, or different coins."
    )
    if last_exc is not None:
        raise ValueError(base + hint) from last_exc
    raise ValueError(base + hint)
