"""Bitcoin PSBT: multi-input, RBF, multisig build."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from embit.psbt import PSBT

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "coordinator"))
sys.path.insert(0, str(ROOT / "tools"))

from app.bitcoin_psbt import build_psbt_for_send, build_psbt_multi_input
from app.kaspa_service import WalletUtxo
from app.wallet_store import WalletConfig

_TEST_XPUB = (
    "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3r"
    "APshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V"
)
_TEST_ADDR = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
_TEST_PAYEE = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"
_TXID = "a" * 64


def _wallet() -> WalletConfig:
    return WalletConfig(
        id="t",
        label="t",
        kpub=_TEST_XPUB,
        fingerprint="73C5DA0A",
        coin="bitcoin",
        script_type="native_segwit",
        account=0,
        derivation="m/84'/0'/0'",
    )


def _utxo(amount: int = 50_000, idx: int = 0, txid: str = _TXID) -> WalletUtxo:
    return WalletUtxo(
        address=_TEST_ADDR,
        address_index=idx,
        transaction_id=txid,
        output_index=0,
        amount=amount,
        is_change=False,
    )


def test_multi_input_psbt():
    cfg = _wallet()
    utxos = [_utxo(40_000, txid="b" * 64), _utxo(35_000, txid="c" * 64)]
    raw, summary = build_psbt_multi_input(cfg, utxos, _TEST_PAYEE, 60_000, fee_sats=5_000)
    assert raw.startswith(PSBT.MAGIC)
    assert summary["input_count"] == 2
    assert summary["fee_sats"] == 5_000


def test_rbf_sequence():
    cfg = _wallet()
    raw, _ = build_psbt_for_send(cfg, _utxo(), _TEST_PAYEE, 40_000, fee_sats=5_000, rbf=True)
    from io import BytesIO

    psbt = PSBT.read_from(BytesIO(raw))
    assert psbt.tx.vin[0].sequence == 0xFFFFFFFD
