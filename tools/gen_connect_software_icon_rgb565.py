#!/usr/bin/env python3
"""Gears + loading bar: outline black, inner progress SIGN blue — no black on blue."""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets" / "connect_software_icon_source.png"
LOAD_SRC = ROOT / "assets" / "connect_loading_icon_source.png"
OUT = ROOT / "connect_software_icon_rgb565.h"

W, H = 74, 60
CHROMA = 0xF81F
SIGN_BLUE = 0x06BF
# Matches RGB565_BITCOIN_ORANGE in SeedPass_UI_Shell.ino (big gear).
BIG_GEAR_ORANGE = 0xFCA0
def rgb888_to_rgb565(r, g, b):
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


def rgb565_to_rgb888(c):
    return ((c >> 11) & 0x1F) << 3, ((c >> 5) & 0x3F) << 2, (c & 0x1F) << 3


def label_ink_components(ink):
    h, w = len(ink), len(ink[0])
    lab = [[-1] * w for _ in range(h)]
    comps = []
    cid = 0
    for sy in range(h):
        for sx in range(w):
            if not ink[sy][sx] or lab[sy][sx] != -1:
                continue
            stack = [(sx, sy)]
            lab[sy][sx] = cid
            cells = []
            while stack:
                x, y = stack.pop()
                cells.append((x, y))
                for dx, dy in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and ink[ny][nx] and lab[ny][nx] == -1:
                        lab[ny][nx] = cid
                        stack.append((nx, ny))
            comps.append(cells)
            cid += 1
    return lab, comps


def nearest_component(lab, x, y, w, h, max_r=2):
    best = -1
    best_d = 999
    for dy in range(-max_r, max_r + 1):
        for dx in range(-max_r, max_r + 1):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and lab[ny][nx] >= 0:
                d = dx * dx + dy * dy
                if d < best_d:
                    best_d = d
                    best = lab[ny][nx]
    return best


def dilate_mask(mask, radius):
    h, w = len(mask), len(mask[0])
    out = [[False] * w for _ in range(h)]
    offsets = []
    rr = radius * radius
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx * dx + dy * dy <= rr:
                offsets.append((dx, dy))
    for y in range(h):
        for x in range(w):
            if not mask[y][x]:
                continue
            for dx, dy in offsets:
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h:
                    out[ny][nx] = True
    return out


def build_loading_rgba(load_src: Image.Image, lw: int, lh: int) -> Image.Image:
    load_bbox = load_src.split()[3].getbbox()
    if load_bbox:
        load_src = load_src.crop(load_bbox)
    load_icon = load_src.resize((lw, lh), Image.Resampling.LANCZOS)
    w, h = load_icon.size
    bg = Image.new("RGB", (w, h), (255, 255, 255))
    bg.paste(load_icon, mask=load_icon.split()[3])
    gray = bg.convert("L")
    ink = [[gray.getpixel((x, y)) < 200 for x in range(w)] for y in range(h)]
    lab, comps = label_ink_components(ink)
    if len(comps) < 2:
        # Fallback: single blob — treat as outline only (black).
        order = list(range(len(comps)))
        outline_id = order[0] if order else -1
        fill_id = -1
    else:
    order = sorted(range(len(comps)), key=lambda i: len(comps[i]), reverse=True)
        outline_id = order[0]
        fill_id = order[1]

    outline_base = [[False] * w for _ in range(h)]
    fill_base = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            cid = lab[y][x]
            if cid == outline_id:
                outline_base[y][x] = True
            elif cid == fill_id:
                fill_base[y][x] = True

    blue_r, blue_g, blue_b = rgb565_to_rgb888(SIGN_BLUE)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    def bbox_from_mask(mask):
        xs, ys = [], []
        for yy in range(h):
            for xx in range(w):
                if mask[yy][xx]:
                    xs.append(xx)
                    ys.append(yy)
        if not xs:
            return None
        return (min(xs), min(ys), max(xs), max(ys))

    ob = bbox_from_mask(outline_base)
    fb = bbox_from_mask(fill_base)
    if not ob:
        return out

    ox0, oy0, ox1, oy1 = ob
    outline_w = ox1 - ox0 + 1
    fill_ratio = 0.5
    if fb:
        fx0, _, fx1, _ = fb
        fill_w = fx1 - fx0 + 1
        usable = max(1, outline_w - 4)
        fill_ratio = max(0.15, min(0.95, fill_w / usable))

    # Draw directly on the target grid to avoid AA asymmetry at tiny sizes.
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    border_px = 2
    gap_px = 1
    bx0 = ox0
    by0 = oy0
    bx1 = ox1
    by1 = oy1
    outer_h = by1 - by0 + 1
    outer_radius = max(1, outer_h // 2)
    draw.rounded_rectangle((bx0, by0, bx1, by1), radius=outer_radius, fill=(0, 0, 0, 255))

    inset = border_px
    ix0, iy0 = bx0 + inset, by0 + inset
    ix1, iy1 = bx1 - inset, by1 - inset
    if ix1 > ix0 and iy1 > iy0:
        inner_radius = max(1, (iy1 - iy0 + 1) // 2)
        draw.rounded_rectangle((ix0, iy0, ix1, iy1), radius=inner_radius, fill=(0, 0, 0, 0))

        gx = gap_px
        fx0, fy0 = ix0 + gx, iy0 + gx
        fx1_max, fy1 = ix1 - gx, iy1 - gx
        if fx1_max > fx0 and fy1 > fy0:
            fill_w = max(2, int((fx1_max - fx0 + 1) * fill_ratio))
            fx1 = min(fx1_max, fx0 + fill_w - 1)
            fill_radius = max(1, (fy1 - fy0 + 1) // 2)
            draw.rounded_rectangle(
                (fx0, fy0, fx1, fy1), radius=fill_radius, fill=(blue_r, blue_g, blue_b, 255)
            )

    return canvas


def render_gear_high_quality(src: Image.Image, size: int, clockwise_deg: float = 0.0, ss: int = 4) -> Image.Image:
    """Render a gear with supersampled transform to reduce jagged edges."""
    hi = size * ss
    base_hi = src.resize((hi, hi), Image.Resampling.LANCZOS)
    # Add transparent safety padding so rotation does not clip edge teeth.
    pad = max(2, hi // 6)
    canvas = Image.new("RGBA", (hi + 2 * pad, hi + 2 * pad), (0, 0, 0, 0))
    canvas.paste(base_hi, (pad, pad), base_hi)
    if clockwise_deg:
        # Pillow uses CCW-positive angles.
        canvas = canvas.rotate(
            -clockwise_deg, resample=Image.Resampling.BICUBIC, expand=False
        )
    # Crop back to center target area before final downsample.
    cx = canvas.size[0] // 2
    cy = canvas.size[1] // 2
    half = hi // 2
    cropped = canvas.crop((cx - half, cy - half, cx + half, cy + half))
    return cropped.resize((size, size), Image.Resampling.LANCZOS)


def silhouette_to_flat_grey(rgba: Image.Image, grey: tuple[int, int, int]) -> Image.Image:
    """Recolor a dark silhouette to flat grey while keeping the alpha channel (smooth edges)."""
    _, _, _, a = rgba.split()
    w, h = rgba.size
    gr, gg, gb = grey
    return Image.merge(
        "RGBA",
        (
            Image.new("L", (w, h), gr),
            Image.new("L", (w, h), gg),
            Image.new("L", (w, h), gb),
            a,
        ),
    )


def main():
    src = Image.open(SRC).convert("RGBA")
    load_src = Image.open(LOAD_SRC).convert("RGBA")

    # 4% clockwise turn = 14.4 degrees clockwise.
    or_r, or_g, or_b = rgb565_to_rgb888(BIG_GEAR_ORANGE)
    gear_big = silhouette_to_flat_grey(
        render_gear_high_quality(src, size=44, clockwise_deg=14.4, ss=4),
        (or_r, or_g, or_b),
    )
    gear_small = silhouette_to_flat_grey(
        render_gear_high_quality(src, size=28, clockwise_deg=0.0, ss=3),
        (0, 0, 0),
    )

    load_colored = build_loading_rgba(load_src, 68, 11)

    comp = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    # y=0 so the big gear is not clipped at the top (was y=-3).
    comp.paste(gear_big, (0, 0), gear_big)
    # Same relative offset to big gear as before the canvas height fix (+3 vs old y=-3).
    comp.paste(gear_small, (43, 18), gear_small)
    # Longer bar, shifted left to remain centered.
    comp.paste(load_colored, (3, 49), load_colored)

    pixels = []
    for y in range(H):
        for x in range(W):
            r, g, b, a = comp.getpixel((x, y))
            if a < 128:
                pixels.append(CHROMA)
            else:
                pixels.append(rgb888_to_rgb565(r, g, b))

    lines = [
        "#pragma once",
        "#include <Arduino.h>",
        "",
        "// Auto-generated: gears + loading (orange big gear; black small gear; bar SIGN blue).",
        "#define CONNECT_SOFTWARE_ICON_W 74",
        "#define CONNECT_SOFTWARE_ICON_H 60",
        "#define CONNECT_SOFTWARE_ICON_CHROMA_KEY 0xF81Fu",
        "",
        "static const uint16_t CONNECT_SOFTWARE_ICON_RGB565[] PROGMEM = {",
    ]
    for i in range(0, len(pixels), 12):
        chunk = pixels[i : i + 12]
        line = "    " + ", ".join(f"0x{v:04X}u" for v in chunk)
        if i + 12 < len(pixels):
            line += ","
        lines.append(line)
    lines.append("};")
    OUT.write_text("\n".join(lines) + "\n")
    print("wrote", OUT, "pixels", len(pixels))


if __name__ == "__main__":
    main()
