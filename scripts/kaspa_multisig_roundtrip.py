#!/usr/bin/env python3
"""Kaspa P2SH multisig policy/PSKT/finalization round-trip checks."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
for tools_dir in (ROOT / "tools", ROOT / "coordinator" / "tools"):
    if str(tools_dir) not in sys.path:
        sys.path.insert(0, str(tools_dir))

from kaspa_multisig import (  # noqa: E402
    _push_data_hex,
    build_multisig_pskt,
    finalize_multisig_input_signature_script,
    finalize_multisig_pskt,
    multisig_p2sh_address,
    multisig_p2sh_script_hex,
    multisig_redeem_script_hex,
    normalize_multisig_policy,
)
from kaspa_pskt import (  # noqa: E402
    _finalize_multisig_signature_script_from_redeem,
    pskt_to_hex,
    validate_rusty_pskt_shape,
)
from kaspa_pskt_wasm import validate_pskt_hex, wasm_validate_ready  # noqa: E402


PUB_A = "020000000000000000000000000000000000000000000000000000000000000001"
PUB_B = "030000000000000000000000000000000000000000000000000000000000000002"
PUB_C = "020000000000000000000000000000000000000000000000000000000000000003"
EXPECTED_ADDR = "kaspa:pp9q7yv9a84rejtyl8p0jvkrkt4af7sldxvnu7fddylg3h3rsfe9kqhmwgv78"
EXPECTED_P2SH_SCRIPT = "aa204a0f1185e9ea3cc964f9c2f932c3b2ebd4fa1f69993e792d693e88de2382725b87"


def fail(message: str) -> int:
    print(f"FAIL: {message}", file=sys.stderr)
    return 1


def main() -> int:
    policy = normalize_multisig_policy(
        threshold=2,
        cosigners=[
            {"pubkey": PUB_A, "fingerprint": "aaaaaaaa", "derivation_path": "m/44'/111111'/0'/0/0"},
            {"pubkey": PUB_B, "fingerprint": "bbbbbbbb", "derivation_path": "m/44'/111111'/0'/0/0"},
            {"pubkey": PUB_C, "fingerprint": "cccccccc", "derivation_path": "m/44'/111111'/0'/0/0"},
        ],
    )

    redeem = multisig_redeem_script_hex(policy)
    if redeem != (
        "52"
        + "20" + PUB_A[2:]
        + "20" + PUB_C[2:]
        + "20" + PUB_B[2:]
        + "53ae"
    ):
        return fail("unexpected x-only sorted redeem script")

    if multisig_p2sh_script_hex(redeem) != EXPECTED_P2SH_SCRIPT:
        return fail("unexpected P2SH script hash")
    if multisig_p2sh_address(policy) != EXPECTED_ADDR:
        return fail("unexpected P2SH address")

    pskt = build_multisig_pskt(
        policy=policy,
        prev_tx_id="880eb9819a31821d9d2399e2f35e2433b72637e393d71ecc9b8d0250f49153c3",
        prev_index=0,
        amount_sompi=1_000_000,
        send_sompi=790_000,
        to_script_hex="20" + "11" * 32 + "ac",
    )
    inp = pskt["inputs"][0]
    if inp.get("sigOpCount") != 3:
        return fail("multisig PSKT must use sigOpCount=N")
    if inp.get("redeemScript") != redeem:
        return fail("missing PSKT input redeemScript")
    if len(inp.get("bip32Derivations") or {}) != 3:
        return fail("missing cosigner derivations")

    issues = validate_rusty_pskt_shape(pskt)
    if issues:
        return fail(f"rusty PSKT shape: {issues}")
    if wasm_validate_ready():
        res = validate_pskt_hex(pskt_to_hex(pskt))
        if not res.get("ok"):
            return fail(f"WASM rejected multisig PSKT: {res.get('error')}")
        print("WASM multisig PSKT parse OK", file=sys.stderr)
    else:
        print("WARN: WASM validation skipped", file=sys.stderr)

    sigs = {
        PUB_B: {"schnorr": list(bytes.fromhex("bb" * 64))},
        PUB_A: {"schnorr": list(bytes.fromhex("aa" * 64))},
    }
    script_sig = finalize_multisig_input_signature_script(policy, sigs)
    if script_sig.startswith("00"):
        return fail("Kaspa multisig signature script must not include Bitcoin OP_0 dummy")
    if not script_sig.startswith("41" + "aa" * 64 + "01"):
        return fail("signatures must be 65-byte pushes with SIGHASH_ALL, ordered by sorted policy pubkeys")
    if ("41" + "bb" * 64 + "01") not in script_sig:
        return fail("second signature missing from final script")
    redeem_push = _push_data_hex(redeem)
    if not script_sig.endswith(redeem_push):
        return fail("final signature script must end with pushed redeem script")

    pskt["inputs"][0]["partialSigs"] = sigs
    finalized = finalize_multisig_pskt(policy, pskt)
    if finalized["inputs"][0].get("finalScriptSig") != script_sig:
        return fail("finalized PSKT finalScriptSig mismatch")

    pskt_script = _finalize_multisig_signature_script_from_redeem(redeem, sigs)
    if pskt_script != script_sig:
        return fail("PSKT finalize signature script mismatch")

    print("Kaspa multisig policy/PSKT round-trip OK", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
