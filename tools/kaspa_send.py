#!/usr/bin/env python3
"""Simpler two-step Kaspa send with SeedPass (Mac coordinator + device sign).

Step 1 — build QR (set who you pay with --to-address):
  python3 kaspa_send.py build \\
    --png ~/kaspa_tx.png \\
    --receive-address 'kaspa:YOUR_RECEIVE' \\
    --to-address 'kaspa:RECIPIENT' \\
    --prev-tx-id <funding_tx_hex> --amount-sompi <utxo_sompi> --send-sompi <pay_sompi minus fee>
  # Default: one output only (leftover sompi = fee). Do not use --change-to-receive unless you know KIP-9 limits.

  open ~/kaspa_tx.png   # scan on SeedPass → Review → Sign

Step 2 — paste or save signed QR JSON, then:
  python3 kaspa_send.py finish ~/kaspa_tx_unsigned.json ~/kaspa_signed.json

Produces ~/kaspa_tx_ready.json — then:
  pip install kaspa
  python3 kaspa_broadcast.py ~/kaspa_tx_ready.json
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent


def cmd_build(argv: list[str]) -> int:
    script = TOOLS / "kaspa_coordinator_qr.py"
    return subprocess.call([sys.executable, str(script), *argv])


def cmd_finish(unsigned: str, signed: str, out: str | None) -> int:
    u = Path(unsigned)
    if not u.is_file():
        print(f"Missing unsigned file: {u}", file=sys.stderr)
        print("Use the *_unsigned.json written when you ran build (same basename as --png).", file=sys.stderr)
        return 1
    ready = out or str(u.with_name(u.stem.replace("_unsigned", "") + "_ready.json"))
    script = TOOLS / "kaspa_apply_signatures.py"
    return subprocess.call([sys.executable, str(script), str(u), signed, "-o", ready])


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    sub = sys.argv[1]
    rest = sys.argv[2:]
    if sub == "build":
        return cmd_build(rest)
    if sub == "finish":
        if len(rest) < 2:
            print("Usage: kaspa_send.py finish UNSIGNED.json SIGNED.json [--out ready.json]", file=sys.stderr)
            return 1
        out = None
        if "--out" in rest:
            i = rest.index("--out")
            if i + 1 >= len(rest):
                print("--out needs a path", file=sys.stderr)
                return 1
            out = rest[i + 1]
            rest = rest[:i] + rest[i + 2 :]
        return cmd_finish(rest[0], rest[1], out)
    print(f"Unknown command: {sub}\n", file=sys.stderr)
    print(__doc__)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
