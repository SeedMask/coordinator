"""Regression tests for Kaspa UTXO subset preference (receive over change)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "coordinator" / "tools"))

from app.kaspa_generator import (  # noqa: E402
    _subset_candidate_rank,
    _subset_change_preference,
    _utxo_subsets_to_try,
)
from app.kaspa_service import WalletUtxo  # noqa: E402

SOMPI = 100_000_000


def _u(
    *,
    amount_kas: float,
    is_change: bool,
    address_index: int,
    tx: str,
    vout: int = 0,
) -> WalletUtxo:
    return WalletUtxo(
        address=f"kaspa:{'c' if is_change else 'r'}{address_index}",
        address_index=address_index,
        transaction_id=tx,
        output_index=vout,
        amount=int(round(amount_kas * SOMPI)),
        is_change=is_change,
    )


def test_change_preference_ranks_receive_first() -> None:
    recv = [_u(amount_kas=1.0, is_change=False, address_index=0, tx="recv0")]
    chg = [_u(amount_kas=0.5, is_change=True, address_index=0, tx="chg0")]
    mixed = recv + chg
    assert _subset_change_preference(recv) == 0
    assert _subset_change_preference(chg) == 1
    assert _subset_change_preference(mixed) == 1
    assert _subset_change_preference(recv) < _subset_change_preference(chg)


def test_small_send_prefers_receive_over_smaller_change() -> None:
    """0.2 KAS send: Change #0 (0.5) used to win as smallest cover; receive should win now."""
    utxos = [
        _u(amount_kas=5.0, is_change=False, address_index=0, tx="recv0"),
        _u(amount_kas=1.0, is_change=False, address_index=1, tx="recv1"),
        _u(amount_kas=0.5, is_change=True, address_index=0, tx="chg0"),
    ]
    send = int(0.2 * SOMPI)
    subsets = _utxo_subsets_to_try(utxos, send, priority_fee=None)
    assert subsets, "expected at least one candidate"
    best = subsets[0]
    assert all(not u.is_change for u in best), (
        f"expected receive UTXO(s) first, got {[ (u.is_change, u.address_index, u.amount) for u in best ]}"
    )


def test_candidate_rank_receive_beats_change_when_both_cover() -> None:
    send = int(0.2 * SOMPI)
    needed = send + 203_600 + 100_000  # approx relay + min change floor used in ranking
    recv = [_u(amount_kas=1.0, is_change=False, address_index=1, tx="recv1")]
    chg = [_u(amount_kas=0.5, is_change=True, address_index=0, tx="chg0")]
    r_rank = _subset_candidate_rank(recv, send_sompi=send, needed=needed, min_fee=203_600, min_change=100_000)
    c_rank = _subset_candidate_rank(chg, send_sompi=send, needed=needed, min_fee=203_600, min_change=100_000)
    assert r_rank < c_rank


if __name__ == "__main__":
    test_change_preference_ranks_receive_first()
    test_small_send_prefers_receive_over_smaller_change()
    test_candidate_rank_receive_beats_change_when_both_cover()
    print("ok")
