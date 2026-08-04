"""Send-wizard fee estimation — Bitcoin (sat/vB × vsize) and Kaspa (rusty-kaspa generator)."""

from __future__ import annotations

from typing import Any

from .kaspa_service import SOMPI_PER_KAS, WalletUtxo
from .wallet_store import WalletConfig

KASPA_STORAGE_MASS_LIMIT = 100_000


def wallet_utxo_from_dict(u: dict[str, Any]) -> WalletUtxo:
    covenant = u.get("covenant_id") or u.get("covenantId")
    return WalletUtxo(
        address=str(u["address"]),
        address_index=int(u["address_index"]),
        transaction_id=str(u["transaction_id"]),
        output_index=int(u["output_index"]),
        amount=int(u["amount"]),
        is_change=bool(u.get("is_change")),
        block_daa_score=int(u.get("block_daa_score") or u.get("blockDaaScore") or 0),
        is_coinbase=bool(u.get("is_coinbase") or u.get("isCoinbase") or False),
        covenant_id=str(covenant).lower() if covenant else None,
    )


async def estimate_bitcoin_send_fee(
    *,
    utxo_amount_sats: int | None,
    input_count: int,
    output_count: int = 2,
    feerate_sat_vb: float | None = None,
    multisig: bool = False,
) -> dict[str, Any]:
    from .bitcoin_service import fee_estimate_bitcoin

    return await fee_estimate_bitcoin(
        utxo_amount_sats,
        input_count=max(1, input_count),
        output_count=max(1, output_count),
        feerate_sat_vb=feerate_sat_vb,
        multisig=multisig,
    )


def _finalize_kaspa_limits(
    out: dict[str, Any],
    *,
    total_in: int,
    min_relay: int,
    max_send: int,
) -> dict[str, Any]:
    out["max_send_sompi"] = max_send
    out["max_send_kas"] = max_send / SOMPI_PER_KAS
    out["spendable_sompi"] = max_send
    out["coin"] = "kaspa"
    _ensure_kaspa_fee_fields(out, min_relay=min_relay)
    if total_in <= min_relay:
        out["insufficient_funds"] = True
    elif max_send <= 0 and total_in > min_relay:
        out["insufficient_funds"] = False
        max_send = max(0, total_in - int(out["fee_sompi"]))
        out["max_send_sompi"] = max_send
        out["max_send_kas"] = max_send / SOMPI_PER_KAS
        out["spendable_sompi"] = max_send
    elif max_send <= 0:
        out["insufficient_funds"] = True
    else:
        out.setdefault("insufficient_funds", False)
    return out


def estimate_kaspa_send_fee(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    *,
    to_address: str | None = None,
    send_sompi: int | None = None,
    refine_max: bool = False,
    priority_fee_sompi: int | None = None,
    requested_fee_sompi: int | None = None,
) -> dict[str, Any]:
    """Max-send limits + fee/mass quote. Fast by default; set refine_max for accurate Max."""
    from .kaspa_generator import (
        _kaspa_fee_estimate_unsigned,
        _probe_create_fee,
        _quick_kaspa_send_limits,
        _relay_fee_sompi,
        kaspa_custom_fee_feasible,
        kaspa_send_fee_preview,
        max_sendable_kaspa,
        max_sendable_kaspa_custom_fee,
        quote_kaspa_network_send,
    )

    if not utxos:
        raise ValueError("At least one UTXO required")
    payee = (to_address or "").strip() or utxos[0].address
    total_in = sum(int(u.amount) for u in utxos)
    min_relay = _relay_fee_sompi(_kaspa_fee_estimate_unsigned(cfg, utxos))
    priority = int(priority_fee_sompi or 0)
    requested = int(requested_fee_sompi) if requested_fee_sompi is not None else None

    # Max at a fixed custom fee — binary search on generator feasibility.
    if (
        refine_max
        and requested is not None
        and requested > 0
        and (send_sompi is None or int(send_sompi) <= 0)
    ):
        limits = max_sendable_kaspa_custom_fee(
            cfg, utxos, to_address=payee, target_fee_sompi=requested
        )
        max_send = int(limits.get("max_send_sompi") or 0)
        out = dict(limits)
        return _finalize_kaspa_limits(out, total_in=total_in, min_relay=min_relay, max_send=max_send)

    # Max button: generator search only — never the quick total−relay estimate.
    if refine_max and (send_sompi is None or int(send_sompi) <= 0):
        limits = max_sendable_kaspa(
            cfg, utxos, to_address=payee, priority_fee=priority if priority > 0 else None
        )
        max_send = int(limits.get("max_send_sompi") or 0)
        out = dict(limits)
        out["send_amount_valid"] = max_send > 0
        out.pop("send_block_reason", None)
        return _finalize_kaspa_limits(out, total_in=total_in, min_relay=min_relay, max_send=max_send)

    if refine_max:
        limits = max_sendable_kaspa(cfg, utxos, to_address=payee, priority_fee=0)
    else:
        limits = _quick_kaspa_send_limits(utxos, priority_fee=0, cfg=cfg)
    max_send = int(limits.get("max_send_sompi") or 0)

    # No send amount — limits + relay fee only (instant; no generator quote probe).
    if send_sompi is None or int(send_sompi) <= 0:
        out = dict(limits)
        # Custom fee without Max yet: still quote fee + arithmetic max (balance − fee).
        if requested is not None and requested > 0:
            out["fee_sompi"] = requested
            out["fee_kas"] = requested / SOMPI_PER_KAS
            out["network_fee_sompi"] = requested
            effective_max = max(0, total_in - requested)
            out["send_amount_valid"] = effective_max > 0
            out["insufficient_funds"] = total_in <= requested
            out.pop("send_block_reason", None)
            return _finalize_kaspa_limits(
                out, total_in=total_in, min_relay=min_relay, max_send=effective_max
            )
        effective_max = max_send
        if effective_max <= 0 and total_in > min_relay:
            effective_max = max(0, total_in - int(limits.get("fee_sompi") or min_relay))
        out["send_amount_valid"] = effective_max > 0
        if refine_max and effective_max > 0:
            try:
                quote = quote_kaspa_network_send(
                    cfg,
                    utxos,
                    to_address=payee,
                    send_sompi=effective_max,
                    priority_fee=priority if priority > 0 else None,
                )
                out.update(quote)
                effective_max = int(quote.get("send_sompi") or effective_max)
            except ValueError:
                # Keep generator search result; do not fall back to total − flat relay.
                effective_max = int(limits.get("max_send_sompi") or effective_max)
            out["send_amount_valid"] = True
            out.pop("send_block_reason", None)
            out["excess_to_miner_sompi"] = int(out.get("excess_to_miner_sompi") or 0)
            out["excess_to_miner_kas"] = float(out.get("excess_to_miner_kas") or 0)
        return _finalize_kaspa_limits(
            out, total_in=total_in, min_relay=min_relay, max_send=effective_max
        )

    probe = int(send_sompi)
    relay_fee = max(min_relay, int(limits.get("fee_sompi") or min_relay))

    if requested is not None and requested > 0:
        if requested <= min_relay + 5_000:
            fee_probe = _probe_create_fee(
                cfg,
                utxos,
                to_address=payee,
                send_sompi=probe,
                priority_fee=0,
            )
            out = dict(limits)
            if fee_probe is not None and probe + fee_probe <= total_in:
                out.update(
                    quote_kaspa_network_send(
                        cfg,
                        utxos,
                        to_address=payee,
                        send_sompi=probe,
                        priority_fee=0,
                    )
                )
                out["send_amount_valid"] = True
                out.pop("send_block_reason", None)
            else:
                out["send_amount_valid"] = False
                out["send_block_reason"] = (
                    "This amount cannot be sent with the selected coins. "
                    "Try Max, a slightly different amount, or change which coins are included."
                )
            return _finalize_kaspa_limits(out, total_in=total_in, min_relay=min_relay, max_send=max_send)

        ok, quote = kaspa_custom_fee_feasible(
            cfg,
            utxos,
            to_address=payee,
            send_sompi=probe,
            target_fee_sompi=requested,
        )
        out = dict(limits)
        out["send_amount_valid"] = ok
        if ok and quote:
            out.update(quote)
            out["fee_sompi"] = requested
            out["fee_kas"] = requested / SOMPI_PER_KAS
            out["network_fee_sompi"] = requested
        else:
            custom_limits = max_sendable_kaspa_custom_fee(
                cfg, utxos, to_address=payee, target_fee_sompi=requested
            )
            adjusted = int(custom_limits.get("max_send_sompi") or 0)
            if adjusted > 0:
                out.update(custom_limits)
                out["send_amount_valid"] = True
                out["send_sompi"] = adjusted
                out.pop("send_block_reason", None)
                max_send = adjusted
            else:
                out["send_block_reason"] = (
                    "Selected coins cannot cover this custom network fee. "
                    "Lower the fee or add more funds."
                )
        return _finalize_kaspa_limits(out, total_in=total_in, min_relay=min_relay, max_send=max_send)

    from .kaspa_generator import kaspa_send_fee_preview, preview_kaspa_send_summary, quote_kaspa_network_send

    try:
        summary = kaspa_send_fee_preview(
            cfg,
            utxos,
            to_address=payee,
            send_sompi=probe,
            priority_fee=priority if priority > 0 else None,
        )
    except ValueError as exc:
        block_msg = str(exc)
        out = dict(limits)
        out["send_amount_valid"] = False
        out["send_block_reason"] = block_msg
        out["excess_to_miner_sompi"] = 0
        out["excess_to_miner_kas"] = 0.0
        return _finalize_kaspa_limits(
            out, total_in=total_in, min_relay=min_relay, max_send=max_send
        )

    out = {**limits, **summary}
    out["send_amount_valid"] = True
    out["excess_to_miner_sompi"] = int(summary.get("excess_to_miner_sompi") or 0)
    out["excess_to_miner_kas"] = float(summary.get("excess_to_miner_kas") or 0.0)
    max_send = int(out.get("max_send_sompi") or max_send)
    out = _finalize_kaspa_limits(out, total_in=total_in, min_relay=min_relay, max_send=max_send)
    if probe > max_send:
        out["insufficient_funds"] = True
    storage = int(out.get("storage_mass") or 0)
    mass = int(out.get("mass") or 0)
    if storage > KASPA_STORAGE_MASS_LIMIT or mass > KASPA_STORAGE_MASS_LIMIT:
        out["storage_mass_exceeded"] = True
    return out


def _ensure_kaspa_fee_fields(out: dict[str, Any], *, min_relay: int) -> None:
    """Never expose fee_sompi=0 to the UI — use quoted or minimum relay fee."""
    fee = int(out.get("network_fee_sompi") or out.get("fee_sompi") or 0)
    if fee <= 0:
        fee = max(min_relay, int(out.get("fee_sompi") or 0) or min_relay)
    out["fee_sompi"] = fee
    out["fee_kas"] = fee / SOMPI_PER_KAS
    out["network_fee_sompi"] = fee
    if out.get("mass") is None and out.get("mass_grams") is None:
        import sys
        from pathlib import Path

        tools = Path(__file__).resolve().parent.parent / "tools"
        if str(tools) not in sys.path:
            sys.path.insert(0, str(tools))
        from kaspa_toccata import estimate_relay_grams

        inputs = max(1, int(out.get("input_count") or 1))
        outputs = max(1, int(out.get("output_count") or 2))
        mass = estimate_relay_grams(input_count=inputs, output_count=outputs)
        out["mass"] = mass
        out["mass_grams"] = mass


async def estimate_kaspa_fallback_fee(
    *,
    input_count: int = 1,
) -> dict[str, Any]:
    """Minimal fallback when wallet/UTXO details are unavailable."""
    import sys
    from pathlib import Path

    tools = Path(__file__).resolve().parent.parent / "tools"
    if str(tools) not in sys.path:
        sys.path.insert(0, str(tools))
    from kaspa_mass import minimum_relay_fee_for_transaction

    inputs = max(1, int(input_count or 1))
    fee_sompi = minimum_relay_fee_for_transaction(input_count=inputs, output_count=2)
    from kaspa_toccata import estimate_relay_grams

    mass = estimate_relay_grams(input_count=inputs, output_count=2)
    base = {
        "fee_sompi": fee_sompi,
        "fee_kas": fee_sompi / SOMPI_PER_KAS,
        "feerate": float(fee_sompi / mass) if mass > 0 else 100.0,
        "mass_grams": mass,
        "mass": mass,
        "input_count": inputs,
        "coin": "kaspa",
    }
    try:
        from kaspa import maximum_standard_transaction_mass

        base["maximum_standard_mass"] = int(maximum_standard_transaction_mass())
    except Exception:
        base["maximum_standard_mass"] = 100_000
    return base
