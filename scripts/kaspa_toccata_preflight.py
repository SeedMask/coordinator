#!/usr/bin/env python3
"""Pre-Toccata checks: sighash vector, mass/fee SDK, sample unsigned tx."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
TOOLS = ROOT / "tools"


def _run(cmd: list[str]) -> int:
    print(f"\n>> {' '.join(cmd)}", file=sys.stderr)
    return subprocess.call(cmd)


def main() -> int:
    errs = 0

    sighash = TOOLS / "kaspa_sighash_selftest.py"
    if sighash.is_file():
        if _run([sys.executable, str(sighash)]) != 0:
            errs += 1
            print("FAIL: sighash self-test", file=sys.stderr)
    else:
        print(f"skip: {sighash} missing", file=sys.stderr)

    sys.path.insert(0, str(TOOLS))
    try:
        import kaspa  # noqa: F401
        from kaspa import maximum_standard_transaction_mass
        from kaspa_coordinator_qr import SAMPLE_TEST_V2
        from kaspa_mass import analyze_unsigned, warn_unsigned_mass

        print(f"\nKaspa Python SDK loaded (max standard mass {maximum_standard_transaction_mass()})", file=sys.stderr)
        sample = dict(SAMPLE_TEST_V2)
        sample["inputs"] = [dict(sample["inputs"][0])]
        sample["outputs"] = [dict(sample["outputs"][0])]
        # Sighash fixture uses tiny sompi; use realistic amounts for mass/fee preflight.
        sample["inputs"][0]["utxo_amount"] = 1_000_000
        sample["outputs"][0]["value"] = 990_000
        rep = analyze_unsigned(sample)
        warn_unsigned_mass(sample)
        if rep.transaction_mass is None or rep.minimum_relay_fee is None:
            print("FAIL: SDK mass/fee calculation returned no values", file=sys.stderr)
            errs += 1
        elif int(rep.minimum_relay_fee or 0) <= 10_000:
            print(
                f"FAIL: Toccata relay fee still looks pre-fork ({rep.minimum_relay_fee} sompi); "
                "upgrade kaspa SDK to >= 2.0.1",
                file=sys.stderr,
            )
            errs += 1
        elif rep.storage_mass is not None and rep.storage_mass > 100_000:
            print("FAIL: sample storage mass exceeds limit", file=sys.stderr)
            errs += 1
    except ImportError as e:
        print(f"FAIL: kaspa SDK not installed ({e})\n  pip install 'kaspa>=1.1.0'", file=sys.stderr)
        errs += 1
    except Exception as e:
        print(f"FAIL: mass preflight: {e}", file=sys.stderr)
        errs += 1

    roundtrip = Path(__file__).resolve().parent / "kaspa_pskt_roundtrip.py"
    if roundtrip.is_file():
        if _run([sys.executable, str(roundtrip)]) != 0:
            errs += 1
            print("FAIL: PSKT round-trip", file=sys.stderr)

    if errs:
        print(f"\n{errs} check(s) failed.", file=sys.stderr)
        return 1
    print("\nAll Toccata preflight checks passed.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
