#!/usr/bin/env python3
"""Verify SeedPass kaspa_address.c matches rusty-kaspa bech32 checksum."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def polymod(values):
    c = 1
    for d in values:
        c0 = c >> 35
        c = ((c & 0x07ffffffff) << 5) ^ d
        if c0 & 0x01:
            c ^= 0x98f2bc8e61
        if c0 & 0x02:
            c ^= 0x79b76d99e2
        if c0 & 0x04:
            c ^= 0xf33e5fb3c4
        if c0 & 0x08:
            c ^= 0xae2eabe2a8
        if c0 & 0x10:
            c ^= 0x1e4f43e470
    return c ^ 1


def checksum(payload5, prefix_bytes):
    return polymod(list(prefix_bytes) + [0] + list(payload5) + [0] * 8)


def conv8to5(payload: bytes) -> list[int]:
    padding = 0 if len(payload) % 5 == 0 else 1
    five_bit = [0] * (len(payload) * 8 // 5 + padding)
    idx = 0
    buff = 0
    bits = 0
    for c in payload:
        buff = (buff << 8) | c
        bits += 8
        while bits >= 5:
            bits -= 5
            five_bit[idx] = (buff >> bits) & 0x1f
            buff &= (1 << bits) - 1
            idx += 1
    if bits:
        five_bit[idx] = (buff << (5 - bits)) & 0x1f
    return five_bit


def encode_kaspa_official(hrp: str, version: int, payload32: bytes) -> str:
    pl = bytes([version]) + payload32
    five = conv8to5(pl)
    pref = [ord(c) & 0x1f for c in hrp]
    chk = checksum(five, pref)
    chk_bytes = chk.to_bytes(8, "big")[3:]
    data = five + conv8to5(chk_bytes)
    return hrp + ":" + "".join(CHARSET[d] for d in data)


def c_encode(xonly32: bytes) -> str:
    src = ROOT / "tools" / "_kaspa_addr_test.c"
    src.write_text(
        f"""
#include <stdio.h>
#include <string.h>
#include "src/kaspa_address.h"
int main(void) {{
  uint8_t x[32] = {{{",".join(f"0x{b:02x}" for b in xonly32)}}};
  char out[80];
  if (!kaspa_encode_address_mainnet(x, out, sizeof(out))) return 1;
  puts(out);
  return 0;
}}
""",
        encoding="utf-8",
    )
    out = subprocess.check_output(
        ["cc", "-I", str(ROOT), str(src), str(ROOT / "src/kaspa_address.c"), "-o", "/tmp/kaspa_addr_test"],
        cwd=ROOT,
    )
    return subprocess.check_output(["/tmp/kaspa_addr_test"], text=True).strip()


def main() -> int:
    x = bytes([0xAB] * 32)
    want = encode_kaspa_official("kaspa", 0, x)
    got = c_encode(x)
    print("official:", want)
    print("seedpass:", got)
    if got != want:
        print("MISMATCH", file=sys.stderr)
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
