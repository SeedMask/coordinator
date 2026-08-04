#!/usr/bin/env python3
"""Kaspa logos from https://cryptologos.cc/coin/kaspa/ — 32×32 front + 26×26 back."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

from logo_rgb565_util import master_raster_rgba, rgba_at_size_to_rgb565, write_logo_header

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets" / "kaspa-kas-logo.png"
OUT = ROOT / "kaspa_logo_rgb565.h"
FRONT = 32
BACK = 26
SOURCE_URL = "https://cryptologos.cc/coin/kaspa/"


def main() -> None:
    if not SRC.is_file():
        raise SystemExit(f"Missing {SRC} — download kaspa-kas-logo.png from {SOURCE_URL}")

    master = master_raster_rgba(Image.open(SRC))
    write_logo_header(
        OUT,
        [
            f"// Kaspa (KAS) — {SOURCE_URL}",
            f"// Source: assets/kaspa-kas-logo.png — {FRONT}×{FRONT} front, {BACK}×{BACK} back",
            "// Regenerate: python3 tools/gen_kaspa_logo_rgb565.py",
        ],
        [
            ("KASPA_LOGO_RGB565", FRONT, rgba_at_size_to_rgb565(master, FRONT)),
            ("KASPA_LOGO_BACK_RGB565", BACK, rgba_at_size_to_rgb565(master, BACK)),
        ],
    )
    print(f"Wrote {OUT} ({FRONT}×{FRONT} + {BACK}×{BACK})")


if __name__ == "__main__":
    main()
