#!/usr/bin/env python3
"""Bitcoin logos from https://cryptologos.cc/coin/bitcoin/ — 32×32 front + 26×26 back."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

from logo_rgb565_util import master_raster_rgba, rgba_at_size_to_rgb565, write_logo_header

ROOT = Path(__file__).resolve().parents[1]
PNG = ROOT / "assets" / "bitcoin-btc-logo.png"
OUT = ROOT / "bitcoin_logo_menu_rgb565.h"
FRONT = 32
BACK = 26
SOURCE_URL = "https://cryptologos.cc/coin/bitcoin/"


def main() -> None:
    if not PNG.is_file():
        raise SystemExit(f"Missing {PNG} — download bitcoin-btc-logo.png from {SOURCE_URL}")

    master = master_raster_rgba(Image.open(PNG))
    write_logo_header(
        OUT,
        [
            f"// Bitcoin (BTC) — {SOURCE_URL}",
            f"// Source: assets/bitcoin-btc-logo.png — {FRONT}×{FRONT} front, {BACK}×{BACK} back",
            "// Regenerate: python3 tools/gen_bitcoin_logo_menu_rgb565.py",
        ],
        [
            ("BITCOIN_LOGO_MENU_RGB565", FRONT, rgba_at_size_to_rgb565(master, FRONT)),
            ("BITCOIN_LOGO_MENU_BACK_RGB565", BACK, rgba_at_size_to_rgb565(master, BACK)),
        ],
    )
    print(f"Wrote {OUT} ({FRONT}×{FRONT} + {BACK}×{BACK})")


if __name__ == "__main__":
    main()
