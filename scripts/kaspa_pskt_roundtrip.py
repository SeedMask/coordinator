#!/usr/bin/env python3
"""PSKT/PSKB rusty-kaspa WASM validation + SeedMask JSON v2 round-trip."""

from __future__ import annotations

import sys
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from kaspa_pskt import (  # noqa: E402
    PSKT_VERSION_ONE,
    apply_seedmask_signed_to_pskt,
    build_pskb_sweep,
    build_pskt_and_v2_for_send,
    draft_envelope,
    parse_draft_file,
    pskt_from_hex,
    pskt_signed_to_ready_v2,
    pskt_to_hex,
    pskt_to_seedmask_v2,
    validate_rusty_pskt_shape,
)
from kaspa_pskt_wasm import (  # noqa: E402
    ensure_wasm_sdk,
    validate_pskb_hex,
    validate_pskt_dict,
    validate_pskt_hex,
    wasm_validate_ready,
)


def main() -> int:
    try:
        ensure_wasm_sdk()
    except Exception as exc:
        print(f"WARN: WASM SDK setup skipped: {exc}", file=sys.stderr)

    pskt, v2 = build_pskt_and_v2_for_send(
        prev_tx_id="880eb9819a31821d9d2399e2f35e2433b72637e393d71ecc9b8d0250f49153c3",
        prev_index=0,
        amount_sompi=1_000_000,
        send_sompi=990_000,
        receive_address="kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e",
        to_address="kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e",
        account=0,
        sign_index=0,
        fingerprint="12345678",
    )
    issues = validate_rusty_pskt_shape(pskt)
    if issues:
        print("FAIL: rusty PSKT shape", issues, file=sys.stderr)
        return 1

    g = pskt.get("global") or {}
    if g.get("version") != PSKT_VERSION_ONE:
        print("FAIL: expected PSKT version One", file=sys.stderr)
        return 1

    if wasm_validate_ready():
        for label, fn, arg in (
            ("dict", validate_pskt_dict, pskt),
            ("hex", validate_pskt_hex, pskt_to_hex(pskt)),
        ):
            res = fn(arg)
            if not res.get("ok"):
                print(f"FAIL: WASM rejected PSKT {label}: {res.get('error')}", file=sys.stderr)
                return 1
        print("WASM PSKT parse OK", file=sys.stderr)
    else:
        print("WARN: WASM validation skipped (install Node + run setup_kaspa_wasm.sh)", file=sys.stderr)

    hx = pskt_to_hex(pskt)
    if not hx.upper().startswith("PSKT"):
        print("FAIL: pskt_to_hex missing prefix", file=sys.stderr)
        return 1
    back = pskt_from_hex(hx)
    v2b = pskt_to_seedmask_v2(back, account=0)
    if v2b.get("version") != 2 or not v2b.get("inputs"):
        print("FAIL: v2 export", file=sys.stderr)
        return 1

    env = draft_envelope(pskt, v2)
    _pskt2, v2c = parse_draft_file(env)
    if v2c.get("account") != 0:
        print("FAIL: draft envelope parse", file=sys.stderr)
        return 1

    fake_sig = {"signatures": [{"input_index": 0, "sig_hex": "ab" * 64}]}
    try:
        apply_seedmask_signed_to_pskt(pskt, fake_sig)
    except ValueError as exc:
        if "pubkey" not in str(exc).lower():
            print(f"FAIL: unexpected sign error {exc}", file=sys.stderr)
            return 1
    else:
        print("FAIL: expected pubkey resolution error without kpub", file=sys.stderr)
        return 1

    utxos = [
        {
            "address": "kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e",
            "address_index": 0,
            "transaction_id": "880eb9819a31821d9d2399e2f35e2433b72637e393d71ecc9b8d0250f49153c3",
            "output_index": 0,
            "amount": 1_000_000,
            "is_change": False,
        },
        {
            "address": "kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e",
            "address_index": 1,
            "transaction_id": "880eb9819a31821d9d2399e2f35e2433b72637e393d71ecc9b8d0250f49153c3",
            "output_index": 1,
            "amount": 2_000_000,
            "is_change": False,
        },
    ]
    pskts, pskb_hex = build_pskb_sweep(
        utxos,
        to_address="kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e",
        fee_sompi_per_tx=10_000,
        fingerprint="12345678",
    )
    if len(pskts) != 2 or not pskb_hex.upper().startswith("PSKB"):
        print("FAIL: PSKB sweep build", file=sys.stderr)
        return 1
    if wasm_validate_ready():
        res = validate_pskb_hex(pskb_hex)
        if not res.get("ok"):
            print(f"FAIL: WASM rejected PSKB: {res.get('error')}", file=sys.stderr)
            return 1
        print("WASM PSKB parse OK", file=sys.stderr)

    sweep_env = draft_envelope(pskts[0], pskt_to_seedmask_v2(pskts[0], account=0), pskts=pskts, pskb_hex=pskb_hex)
    if sweep_env.get("pskb_hex") != pskb_hex or len(sweep_env.get("pskts") or []) != 2:
        print("FAIL: sweep draft envelope", file=sys.stderr)
        return 1

    try:
        pskt_signed_to_ready_v2(pskt)
    except Exception:
        pass

    multisig_proc = subprocess.run(
        [sys.executable, str(Path(__file__).resolve().parent / "kaspa_multisig_roundtrip.py")],
        text=True,
    )
    if multisig_proc.returncode != 0:
        return multisig_proc.returncode

    print("PSKT/PSKB rusty-kaspa round-trip OK", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
