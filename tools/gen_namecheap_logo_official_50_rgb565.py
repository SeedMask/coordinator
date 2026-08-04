#!/usr/bin/env python3
"""
Regenerate namecheap_logo_50_rgb565.h from the official Namecheap wordmark.

Source SVG: tools/namecheap_official_wordmark.svg (same artwork as namecheap.com;
  Wikimedia Commons: https://commons.wikimedia.org/wiki/File:Namecheap_Logo.svg)

Raster intermediate: tools/namecheap_wordmark_raster_512.png
  Produces macOS QuickLook: qlmanage -t -s 512 -o tools tools/namecheap_official_wordmark.svg

Icon crop: SVG viewBox 258×47; grey wordmark paths start at x ≥ 97. Symbol-only strip is x ∈ [0, 96)
  — aspect ~96:47 (~2:1), so it must not be stretched to a square.

Placing: uniform scale to fit inside OUT×OUT with white margins (letterbox), max dim MAX_CONTENT_PX,
  then shift OFFSET_X_PX right (trim right edge if needed so the bitmap stays 50×50).
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC_PNG = Path(__file__).resolve().parent / "namecheap_wordmark_raster_512.png"
OUT_H = ROOT / "namecheap_logo_50_rgb565.h"

OUT = 50
# SVG viewBox width; grey "Namecheap" text begins at x ≈ 97.
SVG_VIEW_W = 258
ICON_X1 = 96  # exclusive end of symbol in SVG x-coordinates
# Symbol is much wider than tall; leave margin so the avatar matches favicon-style proportions.
MAX_CONTENT_PX = 50
# Nudge right vs centered letterbox (optical alignment in the avatar tile).
OFFSET_X_PX = 3


def rgb888_to_rgb565(r: int, g: int, b: int) -> int:
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


def main() -> None:
    im = Image.open(SRC_PNG).convert("RGBA")
    a = np.array(im)
    rgb = a[:, :, :3]
    alpha = a[:, :, 3]
    mask = (alpha > 20) & (np.abs(rgb.astype(np.int16) - 255).sum(axis=2) > 15)
    colsum = mask.sum(axis=0)
    nz = np.where(colsum > 0)[0]
    if len(nz) == 0:
        raise SystemExit(f"No content in {SRC_PNG}")
    left, right = int(nz[0]), int(nz[-1])
    logow = right - left + 1
    rows = np.where(mask.sum(axis=1) > 0)[0]
    y0, y1 = int(rows[0]), int(rows[-1])
    logoh = y1 - y0 + 1

    icon_w_px = max(1, int(round(logow * (ICON_X1 / SVG_VIEW_W))))
    x0, x1 = left, left + icon_w_px
    icon = im.crop((x0, y0, x1, y1))

    cw, ch = icon.size
    scale = min(MAX_CONTENT_PX / cw, MAX_CONTENT_PX / ch)
    nw = max(1, int(round(cw * scale)))
    nh = max(1, int(round(ch * scale)))
    scaled = icon.resize((nw, nh), Image.Resampling.LANCZOS)

    bg = Image.new("RGB", (OUT, OUT), (255, 255, 255))
    ox = (OUT - nw) // 2 + OFFSET_X_PX
    oy = (OUT - nh) // 2
    if ox < 0:
        ox = 0
    if ox + nw > OUT:
        trim = ox + nw - OUT
        scaled = scaled.crop((0, 0, nw - trim, nh))
        nw -= trim
    bg.paste(scaled.convert("RGB"), (ox, oy), mask=scaled.split()[3])

    pixels: list[int] = []
    px = bg.load()
    for y in range(OUT):
        for x in range(OUT):
            r, g, b = px[x, y]
            pixels.append(rgb888_to_rgb565(r, g, b))

    lines = [
        "#pragma once",
        "// Namecheap symbol: SVG-accurate crop (96/258 width), aspect-preserving letterbox in 50×50,",
        f"// max dim {MAX_CONTENT_PX}px, offset_x +{OFFSET_X_PX} — see tools/gen_namecheap_logo_official_50_rgb565.py",
        "// SVG: tools/namecheap_official_wordmark.svg",
        "// Commons: https://commons.wikimedia.org/wiki/File:Namecheap_Logo.svg",
        "#include <Arduino.h>",
        "",
        "static const uint16_t NAMECHEAP_LOGO_OFFICIAL_50_RGB565[50 * 50] PROGMEM = {",
    ]
    for i in range(0, len(pixels), 16):
        chunk = pixels[i : i + 16]
        line = "    " + ", ".join(f"0x{v:04X}" for v in chunk)
        if i + 16 < len(pixels):
            line += ","
        lines.append(line)
    lines.append("};")
    OUT_H.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("Wrote", OUT_H)


if __name__ == "__main__":
    main()
