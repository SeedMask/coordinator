"""Crisp RGB565 logos from CryptoLogos PNGs — 1024px master raster, progressive LANCZOS to each size."""
from __future__ import annotations

from PIL import Image

MASTER_PX = 1024
CHROMA_KEY_RGB565 = 0xF81F
ALPHA_TRANSPARENT = 6


def rgb888_to_rgb565(r: int, g: int, b: int) -> int:
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


def prepare_logo_square(im: Image.Image) -> Image.Image:
    im = im.convert("RGBA")
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    w, h = im.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    return canvas


def _progressive_downscale_rgba(im: Image.Image, size: int) -> Image.Image:
    w, h = im.size
    while max(w, h) > max(size * 2, 2):
        w = max(size, w // 2)
        h = max(size, h // 2)
        im = im.resize((w, h), Image.Resampling.LANCZOS)
    if w != size or h != size:
        im = im.resize((size, size), Image.Resampling.LANCZOS)
    return im


def master_raster_rgba(im: Image.Image) -> Image.Image:
    im = prepare_logo_square(im)
    return im.resize((MASTER_PX, MASTER_PX), Image.Resampling.LANCZOS)


def rgba_at_size_to_rgb565(master: Image.Image, size: int) -> list[int]:
    flat = _progressive_downscale_rgba(master, size)
    out: list[int] = []
    for y in range(size):
        for x in range(size):
            r, g, b, a = flat.getpixel((x, y))
            if a < ALPHA_TRANSPARENT:
                out.append(CHROMA_KEY_RGB565)
            else:
                af = a / 255.0
                rr = int(r * af + 0.5)
                gg = int(g * af + 0.5)
                bb = int(b * af + 0.5)
                out.append(rgb888_to_rgb565(rr, gg, bb))
    return out


def write_logo_header(
    path,
    comment_lines: list[str],
    variants: list[tuple[str, int, list[int]]],
) -> None:
    lines = ["#pragma once", *comment_lines, ""]
    for name, size, pixels in variants:
        lines.append(f"#define {name}_W {size}")
        lines.append(f"#define {name}_H {size}")
        lines.append("")
        lines.append(f"static const uint16_t {name}[] PROGMEM = {{")
        for i in range(0, len(pixels), 8):
            chunk = pixels[i : i + 8]
            line = "  " + ", ".join(f"0x{v:04X}" for v in chunk)
            if i + 8 < len(pixels):
                line += ","
            lines.append(line)
        lines.append("};")
        lines.append("")
    path.write_text("\n".join(lines))
