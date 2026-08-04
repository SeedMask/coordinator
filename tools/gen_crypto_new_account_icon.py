#!/usr/bin/env python3
"""Regenerate crypto_new_account_icon_rgb565.h from source PNG."""
from __future__ import annotations

from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "export_xpub_icon_source.png"
OUT_H = Path(__file__).resolve().parent.parent / "crypto_new_account_icon_rgb565.h"
TARGET_W, TARGET_H = 63, 76
CHROMA = 0xF81F
DOC_OUTLINE = (0, 0, 0)


def lum_map(rr: np.ndarray, gg: np.ndarray, bb: np.ndarray) -> np.ndarray:
    return (299 * rr + 587 * gg + 114 * bb) / 1000.0


def navy_mask(
    r: np.ndarray, g: np.ndarray, b: np.ndarray, a: np.ndarray
) -> np.ndarray:
    lum = lum_map(r.astype(np.float32), g.astype(np.float32), b.astype(np.float32))
    return (
        (a > 40)
        & (r < 72)
        & (g < 78)
        & (b < 105)
        & (b >= r - 8)
        & (lum < 100)
    )


def flood_outside(a: np.ndarray, th: int = 38) -> np.ndarray:
    h, w = a.shape
    passable = a < th
    outside = np.zeros((h, w), dtype=bool)
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if passable[y, x]:
                outside[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if passable[y, x] and not outside[y, x]:
                outside[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and passable[ny, nx] and not outside[ny, nx]:
                outside[ny, nx] = True
                q.append((ny, nx))
    return outside


def touch_outside(outside: np.ndarray) -> np.ndarray:
    h, w = outside.shape
    t = np.zeros_like(outside)
    t[1:, :] |= outside[:-1, :]
    t[:-1, :] |= outside[1:, :]
    t[:, 1:] |= outside[:, :-1]
    t[:, :-1] |= outside[:, 1:]
    return t


def inpaint_from_radius(
    rgb: np.ndarray,
    a: np.ndarray,
    mask: np.ndarray,
    max_rad: int = 28,
) -> None:
    h, w = mask.shape
    ys, xs = np.where(mask)
    lum = lambda rr, gg, bb: lum_map(
        np.float32(rr), np.float32(gg), np.float32(bb)
    )

    def is_navy_px(rr: float, gg: float, bb: float) -> bool:
        l = float(lum(rr, gg, bb))
        return (
            rr < 72 and gg < 78 and bb < 105 and bb >= rr - 8 and l < 100.0
        )

    for y, x in zip(ys, xs):
        found = None
        for rad in range(1, max_rad + 1):
            for dy in range(-rad, rad + 1):
                for dx in range(-rad, rad + 1):
                    if max(abs(dy), abs(dx)) != rad:
                        continue
                    ny, nx = y + dy, x + dx
                    if ny < 0 or ny >= h or nx < 0 or nx >= w:
                        continue
                    if a[ny, nx] < 35:
                        continue
                    if mask[ny, nx]:
                        continue
                    rr, gg, bb = rgb[ny, nx]
                    if is_navy_px(float(rr), float(gg), float(bb)):
                        continue
                    found = rgb[ny, nx].copy()
                    break
                if found is not None:
                    break
            if found is not None:
                break
        if found is not None:
            rgb[y, x] = found
            a[y, x] = 255


def rgb888_to_rgb565(r: int, g: int, b: int) -> int:
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


def dilate_bool(mask: np.ndarray, steps: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(steps):
        b = out.astype(np.uint8)
        out = (
            out
            | np.pad(b, ((1, 0), (0, 0)), constant_values=0)[: out.shape[0], :].astype(bool)
            | np.pad(b, ((0, 1), (0, 0)), constant_values=0)[1:, :].astype(bool)
            | np.pad(b, ((0, 0), (1, 0)), constant_values=0)[:, : out.shape[1]].astype(bool)
            | np.pad(b, ((0, 0), (0, 1)), constant_values=0)[:, 1:].astype(bool)
        )
    return out


def flood_exterior(ink: list[list[bool]]) -> list[list[bool]]:
    h, w = len(ink), len(ink[0])
    ext = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not ink[y][x] and not ext[y][x]:
                ext[y][x] = True
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not ink[y][x] and not ext[y][x]:
                ext[y][x] = True
                q.append((x, y))
    while q:
        x, y = q.popleft()
        for dx, dy in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not ink[ny][nx] and not ext[ny][nx]:
                ext[ny][nx] = True
                q.append((nx, ny))
    return ext


def colorize_export_doc(src_rgba: Image.Image, fill_rgb: tuple[int, int, int]) -> Image.Image:
    """Use Export xPub document line-art and fill color."""
    im = src_rgba.convert("RGBA")
    w, h = im.size
    bg = Image.new("RGB", (w, h), (255, 255, 255))
    bg.paste(im, mask=im.split()[3])
    gray = bg.convert("L")
    ink = [[gray.getpixel((x, y)) < 185 for x in range(w)] for y in range(h)]
    ext = flood_exterior(ink)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for y in range(h):
        for x in range(w):
            g = gray.getpixel((x, y))
            if g < 185:
                out.putpixel((x, y), (DOC_OUTLINE[0], DOC_OUTLINE[1], DOC_OUTLINE[2], 255))
            elif ext[y][x]:
                out.putpixel((x, y), (0, 0, 0, 0))
            else:
                out.putpixel((x, y), (fill_rgb[0], fill_rgb[1], fill_rgb[2], 255))
    return out


def remove_shortest_top_line(im: Image.Image, paper_rgb: tuple[int, int, int]) -> Image.Image:
    """Remove the shortest (top) text line from the front document."""
    out = im.copy().convert("RGBA")
    px = out.load()
    w, h = out.size

    # Candidate "text line" pixels (steel-grey guide lines inside the page).
    mask = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 200:
                continue
            if 85 <= r <= 150 and 95 <= g <= 165 and 105 <= b <= 180:
                mask[y][x] = True

    # Connected components on candidate line pixels.
    vis = [[False] * w for _ in range(h)]
    comps: list[list[tuple[int, int]]] = []
    for sy in range(h):
        for sx in range(w):
            if not mask[sy][sx] or vis[sy][sx]:
                continue
            q: deque[tuple[int, int]] = deque([(sx, sy)])
            vis[sy][sx] = True
            comp: list[tuple[int, int]] = []
            while q:
                x, y = q.popleft()
                comp.append((x, y))
                for dx, dy in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and mask[ny][nx] and not vis[ny][nx]:
                        vis[ny][nx] = True
                        q.append((nx, ny))
            comps.append(comp)

    if not comps:
        return out

    # Keep only components in upper half; remove the shortest one among them.
    upper = []
    for comp in comps:
        ys = [p[1] for p in comp]
        y0, y1 = min(ys), max(ys)
        if y1 <= int(h * 0.55):
            xs = [p[0] for p in comp]
            width = max(xs) - min(xs) + 1
            upper.append((width, comp))
    if not upper:
        return out

    _, target = min(upper, key=lambda it: it[0])
    pr, pg, pb = paper_rgb
    for x, y in target:
        px[x, y] = (pr, pg, pb, 255)
    return out


def build_icon() -> Image.Image:
    src = Image.open(SRC).convert("RGBA")
    # Same document shape as Export xPub, but stacked as two docs.
    back_doc = colorize_export_doc(src, (65, 179, 231))    # back: blue
    front_doc = colorize_export_doc(src, (250, 244, 232))  # front: warm white

    canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    back_small = back_doc.resize((330, 330), Image.Resampling.LANCZOS)
    front_small = front_doc.resize((330, 330), Image.Resampling.LANCZOS)
    front_small = remove_shortest_top_line(front_small, (250, 244, 232))
    # Explicitly erase the top short writing line on the front document.
    d_front = ImageDraw.Draw(front_small)
    d_front.rounded_rectangle((82, 62, 133, 76), radius=7, fill=(250, 244, 232, 255))
    # Normalize remaining writing lines to equal length.
    d_front.rectangle((70, 100, 260, 272), fill=(250, 244, 232, 255))
    for y in (112, 160, 208, 256):
        d_front.rounded_rectangle((82, y, 246, y + 11), radius=6, fill=(0, 0, 0, 255))

    canvas.paste(back_small, (160, 77), back_small)
    canvas.paste(front_small, (70, 135), front_small)
    return canvas


def rgba_to_header_pixels(im: Image.Image) -> list[int]:
    w, h = im.size
    px = im.load()
    out: list[int] = []
    for y in range(h):
        for x in range(w):
            r, g, b, al = px[x, y]
            if al < 128:
                out.append(CHROMA)
                continue
            c = rgb888_to_rgb565(r, g, b)
            if c == CHROMA:
                c ^= 0x20
            out.append(c)
    return out


def main() -> None:
    icon = build_icon()
    bbox = icon.getbbox()
    if not bbox:
        raise SystemExit("empty icon")
    cropped = icon.crop(bbox)
    cw, ch = cropped.size
    scale = min(TARGET_W / cw, TARGET_H / ch)
    nw, nh = max(1, int(round(cw * scale))), max(1, int(round(ch * scale)))
    resized = cropped.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (TARGET_W, TARGET_H), (0, 0, 0, 0))
    ox = (TARGET_W - nw) // 2
    oy = (TARGET_H - nh) // 2
    canvas.paste(resized, (ox, oy), resized)

    pixels = rgba_to_header_pixels(canvas)
    assert len(pixels) == TARGET_W * TARGET_H

    lines = [
        "#pragma once",
        "#include <Arduino.h>",
        "",
        "// New account (Crypto settings): stacked documents — RGB565, magenta chroma.",
        f"#define CRYPTO_NEW_ACCOUNT_ICON_W {TARGET_W}",
        f"#define CRYPTO_NEW_ACCOUNT_ICON_H {TARGET_H}",
        f"#define CRYPTO_NEW_ACCOUNT_ICON_CHROMA_KEY 0x{CHROMA:04X}u",
        "",
        "static const uint16_t CRYPTO_NEW_ACCOUNT_ICON_RGB565[] PROGMEM = {",
    ]
    row: list[str] = []
    for i, p in enumerate(pixels):
        row.append(f"0x{p:04X}u")
        if len(row) == 8 or i == len(pixels) - 1:
            lines.append("    " + ", ".join(row) + ("," if i < len(pixels) - 1 else ""))
            row = []
    lines.append("};")
    lines.append("")

    OUT_H.write_text("\n".join(lines), encoding="utf-8")
    preview = Path(__file__).resolve().parent.parent / "_crypto_new_edit.png"
    icon.save(preview)
    print("Wrote", OUT_H)
    print("Preview", preview, icon.size)


if __name__ == "__main__":
    main()
