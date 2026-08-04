"""Normalize /api/fee/estimate JSON for the macOS client decoder."""

from __future__ import annotations

from typing import Any

SOMPI_PER_COIN = 100_000_000


def normalize_fee_estimate(payload: dict[str, Any]) -> dict[str, Any]:
    """Ensure fields required by FeeEstimateResponse (Swift) are always present."""
    out = dict(payload)
    fee = int(out.get("fee_sompi") or 0)
    mass = int(out.get("mass") or out.get("mass_grams") or 0)
    if (out.get("coin") or "").strip().lower() == "kaspa" and fee <= 0:
        fee = max(int(out.get("network_fee_sompi") or 0), int(out.get("minimum_relay_fee") or 0))
        if fee <= 0:
            import sys
            from pathlib import Path

            tools = Path(__file__).resolve().parent.parent / "tools"
            if str(tools) not in sys.path:
                sys.path.insert(0, str(tools))
            from kaspa_toccata import estimate_relay_fee_sompi

            fee = estimate_relay_fee_sompi(input_count=max(1, int(out.get("input_count") or 1)))
    out["fee_sompi"] = fee
    out["fee_kas"] = float(out.get("fee_kas") if out.get("fee_kas") is not None else fee / SOMPI_PER_COIN)
    out["mass_grams"] = mass
    if out.get("mass") is None:
        out["mass"] = mass
    if out.get("feerate") is None:
        out["feerate"] = float(fee / mass) if mass > 0 else 1.0
    else:
        out["feerate"] = float(out["feerate"])
    if out.get("storage_mass") is not None:
        out["storage_mass"] = int(out["storage_mass"])
    if out.get("maximum_standard_mass") is not None:
        out["maximum_standard_mass"] = int(out["maximum_standard_mass"])
    if out.get("max_send_sompi") is not None:
        out["max_send_sompi"] = int(out["max_send_sompi"])
    elif out.get("spendable_sompi") is not None:
        out["max_send_sompi"] = int(out["spendable_sompi"])
    if out.get("network_fee_sompi") is not None:
        out["network_fee_sompi"] = int(out["network_fee_sompi"])
    if out.get("excess_to_miner_sompi") is not None:
        out["excess_to_miner_sompi"] = int(out["excess_to_miner_sompi"])
        out["excess_to_miner_kas"] = float(
            out.get("excess_to_miner_kas")
            if out.get("excess_to_miner_kas") is not None
            else int(out["excess_to_miner_sompi"]) / SOMPI_PER_COIN
        )
    return out
