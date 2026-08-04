"""Kaspa transaction mass / relay-fee helpers (KIP-9 + Toccata SDK rules)."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Any

from kaspa_toccata import (
    LEGACY_FALLBACK_RELAY_SOMPI,
    STORAGE_MASS_LIMIT,
    estimate_relay_fee_sompi,
    estimate_relay_grams,
    template_unsigned_v0,
    unsigned_for_mass_analysis,
    unsigned_v2_to_transaction,
)


@dataclass
class MassReport:
    storage_mass: int | None
    transaction_mass: int | None
    minimum_relay_fee: int | None
    implicit_fee: int | None
    input_total: int
    output_total: int
    within_limits: bool
    notes: list[str]


def _sdk():
    try:
        from kaspa import NetworkId

        return NetworkId("mainnet")
    except ImportError:
        return None


def _unsigned_for_mass(unsigned: dict) -> dict:
    """Apply signed-size placeholder scripts when building from an unsigned QR."""
    needs_placeholders = any(
        isinstance(inp, dict)
        and not str(inp.get("signature_script") or inp.get("sig_hex") or "").strip()
        for inp in unsigned.get("inputs") or []
    )
    if needs_placeholders:
        return unsigned_for_mass_analysis(unsigned)
    return unsigned


def analyze_unsigned(unsigned: dict) -> MassReport:
    notes: list[str] = []
    network = _sdk()
    if network is None:
        return MassReport(None, None, None, None, 0, 0, True, ["kaspa SDK not installed"])

    from kaspa import (
        calculate_storage_mass,
        calculate_transaction_fee,
        calculate_transaction_mass,
        maximum_standard_transaction_mass,
        update_transaction_mass,
    )

    mass_unsigned = _unsigned_for_mass(unsigned)
    in_vals = [int(i.get("utxo_amount", 0)) for i in mass_unsigned.get("inputs") or []]
    out_vals = [int(o.get("value", 0)) for o in mass_unsigned.get("outputs") or []]
    input_total = sum(in_vals)
    output_total = sum(out_vals)
    implicit_fee = input_total - output_total if input_total and output_total else None

    storage_mass = None
    if in_vals and out_vals:
        storage_mass = calculate_storage_mass(network, in_vals, out_vals)
        if storage_mass is not None and storage_mass > STORAGE_MASS_LIMIT:
            notes.append(f"KIP-9 storage mass {storage_mass} exceeds {STORAGE_MASS_LIMIT}")

    tx_mass = None
    min_fee = None
    within = True
    try:
        tx = unsigned_v2_to_transaction(mass_unsigned)
        if not update_transaction_mass(network, tx):
            within = False
            notes.append("transaction mass exceeds standard limits")
        tx_mass = int(calculate_transaction_mass(network, tx))
        min_fee = int(calculate_transaction_fee(network, tx))
        max_std = maximum_standard_transaction_mass()
        if tx_mass is not None and tx_mass > max_std:
            within = False
            notes.append(f"transaction mass {tx_mass} exceeds standard max {max_std}")
    except Exception as e:
        within = False
        notes.append(f"mass/fee calc failed: {e}")
        try:
            tx_mass = estimate_relay_grams(unsigned=mass_unsigned)
            min_fee = int(tx_mass) * 100
        except Exception:
            min_fee = LEGACY_FALLBACK_RELAY_SOMPI

    if implicit_fee is not None and min_fee is not None and implicit_fee < min_fee:
        within = False
        notes.append(
            f"implicit fee {implicit_fee} sompi is below Toccata network minimum {min_fee} sompi"
        )

    return MassReport(
        storage_mass=storage_mass,
        transaction_mass=tx_mass,
        minimum_relay_fee=min_fee,
        implicit_fee=implicit_fee,
        input_total=input_total,
        output_total=output_total,
        within_limits=within,
        notes=notes,
    )


def warn_unsigned_mass(unsigned: dict, *, stream: Any = None) -> MassReport:
    """Print mass/fee summary to stderr; return the report."""
    if stream is None:
        stream = sys.stderr
    rep = analyze_unsigned(unsigned)
    if rep.storage_mass is not None:
        print(f"KIP-9 storage mass: {rep.storage_mass} (limit {STORAGE_MASS_LIMIT})", file=stream)
    if rep.transaction_mass is not None:
        print(f"Transaction mass: {rep.transaction_mass}", file=stream)
    if rep.minimum_relay_fee is not None:
        print(f"Toccata minimum relay fee: {rep.minimum_relay_fee} sompi", file=stream)
    if rep.implicit_fee is not None:
        print(f"Implicit fee (inputs − outputs): {rep.implicit_fee} sompi", file=stream)
    for note in rep.notes:
        print(f"Warning: {note}", file=stream)
    return rep


def validate_unsigned_for_relay(unsigned: dict) -> None:
    """Raise SystemExit when storage mass or relay fee is insufficient."""
    rep = analyze_unsigned(unsigned)
    for note in rep.notes:
        if "storage mass" in note and "exceeds" in note:
            raise SystemExit(note)
    if not rep.within_limits:
        detail = "; ".join(rep.notes) or "unsigned transaction fails mass/fee checks"
        raise SystemExit(detail)


def minimum_relay_fee_for_transaction(unsigned: dict | None = None, **shape: Any) -> int:
    """Return strict Toccata relay fee for an unsigned v2 tx or input/output shape."""
    if unsigned:
        rep = analyze_unsigned(unsigned)
        if rep.minimum_relay_fee is not None and int(rep.minimum_relay_fee) > 0:
            return int(rep.minimum_relay_fee)
    return estimate_relay_fee_sompi(unsigned=unsigned, **shape)


def validate_v2_relay_fee(unsigned: dict) -> None:
    """Raise ValueError when implicit fee is below the strict Toccata relay minimum."""
    rep = analyze_unsigned(unsigned)
    for note in rep.notes:
        if "storage mass" in note and "exceeds" in note:
            raise ValueError(note)
        if "transaction mass" in note and "exceeds" in note:
            raise ValueError(note)
    if rep.implicit_fee is None:
        raise ValueError("Could not determine implicit transaction fee")
    minimum = int(rep.minimum_relay_fee or LEGACY_FALLBACK_RELAY_SOMPI)
    if int(rep.implicit_fee) < minimum:
        raise ValueError(
            f"Network fee too low: implicit fee {int(rep.implicit_fee)} sompi "
            f"is below Toccata network minimum {minimum} sompi"
        )
