#!/usr/bin/env python3
"""Merge SeedMask signed QR JSON into the unsigned coordinator JSON.

Usage:
  python3 kaspa_apply_signatures.py unsigned.json signed_from_device.json
  python3 kaspa_apply_signatures.py unsigned.json signed.json -o ready.json

`ready.json` has signature_script on each signed input — use with your Kaspa node/wallet to broadcast.
"""

from __future__ import annotations

import argparse
import json
import sys


def merge(unsigned: dict, signed: dict) -> dict:
    sigs = {int(s["input_index"]): s["sig_hex"] for s in signed.get("signatures", [])}
    if not sigs:
        raise ValueError("No signatures in signed JSON")
    merged = json.loads(json.dumps(unsigned))
    inputs = merged.get("inputs") or []
    n_in = len(inputs)
    if n_in == 0:
        raise ValueError("Unsigned JSON has no inputs")
    if len(sigs) < n_in:
        raise ValueError(
            f"Signed data incomplete for this singlesig send: it spends {n_in} coins, "
            f"but SeedMask only returned {len(sigs)} of {n_in} input signatures. "
            "Approve once on SeedMask, then re-scan the full signed QR "
            "(one signature is returned per coin in that same payload)."
        )
    for idx in range(n_in):
        if idx not in sigs:
            prev = inputs[idx].get("prev_index") if isinstance(inputs[idx], dict) else "?"
            raise ValueError(
                f"Missing signature for input #{idx} (array index, not prev_index={prev}). "
                "Each signatures[] entry must use input_index 0..n-1 matching the unsigned inputs array."
            )
    for idx, sig_hex in sigs.items():
        if len(sig_hex) != 128:
            raise ValueError(f"input {idx}: expected 128 hex chars (64-byte sig), got {len(sig_hex)}")
        if idx >= len(inputs):
            raise ValueError(f"input_index {idx} out of range (have {len(inputs)} inputs)")
        inputs[idx]["signature_script"] = sig_hex
    merged["inputs"] = inputs
    merged["seedmask_signed"] = True
    return merged


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("unsigned", help="Unsigned JSON from kaspa_coordinator_qr.py")
    ap.add_argument("signed", help="Signed JSON from device QR")
    ap.add_argument("-o", "--out", metavar="PATH", help="Write merged JSON (recommended)")
    args = ap.parse_args()

    with open(args.unsigned, encoding="utf-8") as f:
        unsigned = json.load(f)
    with open(args.signed, encoding="utf-8") as f:
        signed = json.load(f)

    try:
        merged = merge(unsigned, signed)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    for idx, inp in enumerate(merged.get("inputs") or []):
        if inp.get("signature_script"):
            print(f"input[{idx}] signature_script = {inp['signature_script']}")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2)
            f.write("\n")
        print(f"\nWrote {args.out}", file=sys.stderr)
        print("Broadcast that tx with your Kaspa wallet/node (inputs already carry signature_script).", file=sys.stderr)
    else:
        print("\nTip: add -o ready.json to save the merged tx in one file.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
