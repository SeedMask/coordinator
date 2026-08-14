#!/usr/bin/env python3
"""Smoke test: Bitcoin PSBT build, payee validation, draft export/import, sweep.

Uses public watch-only fixtures only (xpub, fingerprint, addresses). The coordinator
never handles seeds or mnemonics — tests mirror that boundary.
"""

from __future__ import annotations

import sys
import tempfile
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "coordinator"))
sys.path.insert(0, str(ROOT / "tools"))

from embit.psbt import PSBT

from app.bitcoin_psbt import build_psbt_for_send, build_psbt_sweep, psbt_to_base64
from app.kpub_parse import is_placeholder_fingerprint
from app.kaspa_service import WalletUtxo
from app.tx_pipeline import (
    export_btc_draft,
    import_btc_unsigned,
    parse_payee_qr_text,
    save_btc_draft,
    save_sweep_draft_from_build_btc,
    validate_address,
)
from app.wallet_store import WalletConfig

# Public BIP32/BIP84 test fixtures (watch-only). Not user data; no seed in this repo.
_TEST_XPUB = (
    "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3r"
    "APshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V"
)
_TEST_MASTER_FP = "73C5DA0A"
_TEST_UTXO_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
_TEST_PAYEE_ADDRESS = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"
_TEST_TXID = "0" * 64


def _test_wallet() -> WalletConfig:
    return WalletConfig(
        id="test-btc",
        label="test",
        kpub=_TEST_XPUB,
        fingerprint=_TEST_MASTER_FP,
        coin="bitcoin",
        script_type="native_segwit",
        account=0,
        derivation="m/84'/0'/0'",
    )


def _utxo(amount: int = 100_000) -> WalletUtxo:
    return WalletUtxo(
        address=_TEST_UTXO_ADDRESS,
        address_index=0,
        transaction_id=_TEST_TXID,
        output_index=0,
        amount=amount,
        is_change=False,
    )


def main() -> int:
    cfg = _test_wallet()
    payee = _TEST_PAYEE_ADDRESS

    addr = parse_payee_qr_text(payee, coin="bitcoin")
    assert validate_address(addr, coin="bitcoin") == payee

    uri = f"bitcoin:{payee}?amount=0.001"
    assert parse_payee_qr_text(uri, coin="bitcoin") == payee

    psbt_bytes, summary = build_psbt_for_send(cfg, _utxo(), payee, 90_000, fee_sats=10_000)
    assert psbt_bytes.startswith(PSBT.MAGIC)
    assert summary["send_sats"] == 90_000
    psbt = PSBT.read_from(BytesIO(psbt_bytes))
    inp_fp = next(iter(psbt.inputs[0].bip32_derivations.values())).fingerprint.hex()
    assert inp_fp == _TEST_MASTER_FP.lower()
    assert len(psbt.xpubs) >= 1

    bad = WalletConfig(
        id="bad",
        label="bad",
        kpub=_TEST_XPUB,
        fingerprint="DDDDDDDD",
        coin="bitcoin",
        script_type="native_segwit",
        account=0,
    )
    assert is_placeholder_fingerprint("DDDDDDDD")
    try:
        build_psbt_for_send(bad, _utxo(), payee, 90_000, fee_sats=10_000)
        raise AssertionError("expected placeholder fingerprint to be rejected")
    except ValueError:
        pass

    with tempfile.TemporaryDirectory() as tmp:
        drafts = Path(tmp) / "drafts"
        drafts.mkdir()
        import app.tx_pipeline as tp

        tp.DRAFTS_DIR = drafts
        draft_id = save_btc_draft(psbt_bytes, summary)
        exported = export_btc_draft(draft_id)
        assert exported["psbt_base64"]
        assert exported["format"] == "seedmask_psbt_draft_v1"

        draft_id2, raw2, count = import_btc_unsigned(
            {"format": "seedmask_psbt_draft_v1", "coin": "bitcoin", "psbt_base64": exported["psbt_base64"]}
        )
        assert count == 1
        assert raw2.startswith(PSBT.MAGIC)

        _, _, sweep_summary = save_sweep_draft_from_build_btc(
            cfg, [_utxo(50_000), _utxo(80_000)], payee, 5_000
        )
        assert sweep_summary["utxo_count"] == 2

    sweep_psbts, _ = build_psbt_sweep(cfg, [_utxo(50_000), _utxo(80_000)], payee, fee_sats_per_tx=5_000)
    assert len(sweep_psbts) == 2
    print("bitcoin_psbt_roundtrip: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
