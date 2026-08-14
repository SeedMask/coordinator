"""BC-UR fountain QR frames for Kaspa unsigned PSKT JSON (ur:bytes/, not Bitcoin PSBT)."""

from __future__ import annotations

import base64
import io

import qrcode

from .bcur.cbor_lite import CBOREncoder
from .bcur.ur import UR
from .bcur.ur_encoder import UREncoder
from .tx_pipeline import unsigned_json_for_qr

# Mac UI auto-cycles unique BC-UR parts; SeedMask fountain decoder has no hard 8-part cap.
# Large MAX sends can need more than 16 parts; keep parts scannable but do not block them.
MAX_DISPLAY_FRAMES = 16
DEFAULT_MAX_FRAGMENT_LEN = 50
# Fewer QR modules = easier for SeedMask camera; large multisig payloads may use more frames.
TARGET_QR_MODULES = 101
MAX_QR_MODULES_SINGLE = 41
# Static single QR: full payload in one symbol (SeedMask uses zoom + violent decode once seen).
STATIC_MAX_QR_MODULES = 129
STATIC_MAX_URI_CHARS = 2800
# Animated multipart: Mac UI auto-cycles unique parts (Start/Pause below QR).
DEFAULT_FRAME_MS = 900
# Each frame visible long enough for SeedMask handoff (~400ms) before violent snap of next part.
ANIMATED_FRAME_MS = 450
# Native pixels per module — large PNG, shown ~1:1 on Mac (avoid blurry upscale).
DEFAULT_QR_BOX_SIZE = 16
# Dense (static) single QR: larger modules on Mac + fullscreen tap target.
STATIC_QR_BOX_SIZE = 20
MAX_URI_CHARS_PER_PART = 900
# Larger fragments → fewer parts (multi-input Kaspa txs need >125 B fragments to stay ≤16 parts).
_FRAGMENT_CANDIDATES = tuple(range(25, 805, 5))


def _cbor_bytes_payload(data: bytes) -> list[int]:
    enc = CBOREncoder()
    enc.encodeBytes(data)
    return list(enc.get_bytes())


def _make_encoder(payload: bytes, max_fragment_len: int) -> UREncoder:
    ur = UR("bytes", _cbor_bytes_payload(payload))
    return UREncoder(ur, max_fragment_len=max_fragment_len, first_seq_num=0, min_fragment_len=10)


def _qr_modules_for_uri(uri: str) -> int:
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_L, box_size=1)
    qr.add_data(uri)
    qr.make(fit=True)
    return qr.modules_count


def pick_fragment_len(
    payload: bytes,
    *,
    max_frames: int = MAX_DISPLAY_FRAMES,
    target_modules: int = TARGET_QR_MODULES,
) -> int:
    """Pick fragment length: ≤max_frames parts, lowest QR version, UR under device limit."""
    best = DEFAULT_MAX_FRAGMENT_LEN
    best_score = (999, 999, 999)

    for frag in _FRAGMENT_CANDIDATES:
        encoder = _make_encoder(payload, frag)
        seq_len = encoder.fountain_encoder.seq_len()
        if seq_len > max_frames:
            continue
        part = encoder.next_part()
        modules = _qr_modules_for_uri(part)
        if seq_len == 1 and modules > MAX_QR_MODULES_SINGLE:
            continue
        if len(part) > MAX_URI_CHARS_PER_PART:
            continue
        # Prefer fewer standard UR fragments; use the density target only to
        # break ties between choices with the same part count.
        over_target = max(0, modules - target_modules)
        score = (seq_len, over_target, modules, len(part))
        if score < best_score:
            best_score = score
            best = frag

    if best_score[0] == 999:
        # Prefer the largest fragment that still fits the animated part cap (fewest parts).
        for frag in reversed(_FRAGMENT_CANDIDATES):
            encoder = _make_encoder(payload, frag)
            seq_len = encoder.fountain_encoder.seq_len()
            if seq_len > max_frames:
                continue
            part = encoder.next_part()
            if len(part) > MAX_URI_CHARS_PER_PART:
                continue
            modules = _qr_modules_for_uri(part)
            if seq_len == 1 and modules > MAX_QR_MODULES_SINGLE:
                continue
            return frag
        raise ValueError(
            f"Transaction needs more than {max_frames} animated QR parts. "
            "Save the transaction file and sign on SeedMask, or select fewer coins."
        )
    return best


def static_single_ur_part(text: str) -> str:
    """One BC-UR frame: ``ur:bytes/<bytewords>`` (no ``seq/seqlen`` multipart)."""
    payload = text.encode("utf-8")
    ur = UR("bytes", _cbor_bytes_payload(payload))
    return UREncoder.encode(ur)


def ur_parts_for_text(
    text: str,
    max_fragment_len: int = DEFAULT_MAX_FRAGMENT_LEN,
    *,
    max_frames: int = MAX_DISPLAY_FRAMES,
    anim_cycles: int = 2,
) -> list[str]:
    """Encode UTF-8 text as `ur:bytes/…` parts (fixed-rate only, no extra fountain mixes)."""
    payload = text.encode("utf-8")
    encoder = _make_encoder(payload, max_fragment_len)

    if encoder.is_single_part():
        return [encoder.next_part()]

    seq_len = encoder.fountain_encoder.seq_len()
    if seq_len > max_frames:
        raise ValueError(
            f"Transaction needs {seq_len} animated QR parts (max {max_frames}). "
            "Select fewer coins or save the transaction file."
        )
    # First seq_len parts are the pure fragments (BC-UR spec) — device must see each index once.
    base = [encoder.next_part() for _ in range(seq_len)]
    if anim_cycles <= 1:
        return base
    # Legacy auto-animation: repeat each part twice, then optional full cycle.
    parts: list[str] = []
    for p in base:
        parts.append(p)
        parts.append(p)
    if anim_cycles > 1:
        parts.extend(base)
    return parts


def ur_text_parts_pack(text: str, *, target_modules: int = 73) -> dict:
    """
    BC-UR part strings only (no PNG). Mac UI rasterizes with qrcode.js.

    Large policies may not fit a single Dense QR — in that case ``static_part`` is null
    and the UI must use Animated (never fail the whole export).
    """
    payload = (text or "").encode("utf-8")
    if not text.strip():
        raise ValueError("QR payload is empty")

    static_part: str | None
    try:
        candidate = static_single_ur_part(text)
        if len(candidate) > STATIC_MAX_URI_CHARS:
            static_part = None
        elif _qr_modules_for_uri(candidate) > STATIC_MAX_QR_MODULES:
            static_part = None
        else:
            static_part = candidate
    except Exception:
        static_part = None

    frag = pick_fragment_len(payload, target_modules=target_modules)
    animated_parts = ur_parts_for_text(text, max_fragment_len=frag, anim_cycles=1)
    return {
        "qr_encoding": "ur",
        "static_part": static_part,
        "animated_parts": animated_parts,
        "qr_frame_ms": ANIMATED_FRAME_MS,
        "qr_fragment_len": frag,
        "qr_unique_parts": len(animated_parts),
        "qr_payload_bytes": len(payload),
        "qr_static_available": static_part is not None,
    }


def qr_png_base64_for_part(part: str, box_size: int = DEFAULT_QR_BOX_SIZE) -> str:
    from PIL import Image

    # Low ECC; box_size sets native pixels/module — do not shrink heavily in the UI.
    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=max(4, box_size),
        border=4,
    )
    qr.add_data(part)
    qr.make(fit=True)
    # Pure white quiet zone — intended for on-screen scan (light theme monitors / phone cameras).
    qr_back = "#ffffff"
    qr_fill = "#000000"
    img = qr.make_image(fill_color=qr_fill, back_color=qr_back).convert("RGB")
    border_px = max(16, box_size * 2)
    padded = Image.new("RGB", (img.size[0] + border_px * 2, img.size[1] + border_px * 2), qr_back)
    padded.paste(img, (border_px, border_px))
    buf = io.BytesIO()
    padded.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def plain_qr_frames_base64_text(text: str, *, box_size: int = STATIC_QR_BOX_SIZE) -> dict:
    """Encode raw UTF-8 text in a single QR (no BC-UR). For Kaspium / BlueWallet / Sparrow."""
    payload = (text or "").strip()
    if not payload:
        raise ValueError("QR payload is empty")
    modules = _qr_modules_for_uri(payload)
    if modules > STATIC_MAX_QR_MODULES:
        raise ValueError(
            f"Payload needs {modules}×{modules} modules (max {STATIC_MAX_QR_MODULES}). "
            "Save as a file instead, or pick SeedMask export."
        )
    if len(payload) > STATIC_MAX_URI_CHARS:
        raise ValueError(
            f"Payload too large for a single QR ({len(payload)} characters; max {STATIC_MAX_URI_CHARS})."
        )
    bs = max(4, box_size)
    frame = qr_png_base64_for_part(payload, box_size=bs)
    display_px = modules * bs + 8 * bs
    return {
        "qr_frames_base64": [frame],
        "qr_frame_count": 1,
        "qr_unique_parts": 1,
        "qr_frame_ms": 0,
        "qr_stepped": False,
        "qr_fountain": False,
        "qr_display_mode": "static",
        "qr_png_base64": frame,
        "qr_fragment_len": len(payload.encode("utf-8")),
        "qr_modules_per_frame": modules,
        "qr_display_pixels": display_px,
        "qr_payload_bytes": len(payload.encode("utf-8")),
        "qr_encoding": "plain",
    }


def fountain_qr_frames_base64_text(
    text: str,
    *,
    max_fragment_len: int | None = None,
    box_size: int = DEFAULT_QR_BOX_SIZE,
    frame_ms: int | None = None,
    qr_display_mode: str = "animated",
    target_modules: int | None = None,
) -> dict:
    """
    Return QR frame PNGs + metadata.
    `qr_display_mode`: ``animated`` (multipart fountain, auto-cycle on Mac) or ``static`` (single QR).
    `target_modules`: animated QR size hint (lower = less dense, more parts).
    """
    payload = text.encode("utf-8")
    mode = (qr_display_mode or "animated").strip().lower()
    static = mode in ("static", "single", "one")
    parts: list[str] = []
    unique_parts = 1
    hold_ms = 0
    fountain = False
    frag = len(_cbor_bytes_payload(payload))
    modules_target = target_modules if target_modules is not None else TARGET_QR_MODULES

    def _encode_static() -> None:
        nonlocal parts, frag, hold_ms, fountain, unique_parts, static
        part = static_single_ur_part(text)
        uri_len = len(part)
        if uri_len > STATIC_MAX_URI_CHARS:
            raise ValueError(
                f"Transaction too large for static QR ({uri_len} character UR; max {STATIC_MAX_URI_CHARS}). "
                "Select fewer coins or save the transaction file and sign on SeedMask."
            )
        modules = _qr_modules_for_uri(part)
        if modules > STATIC_MAX_QR_MODULES:
            raise ValueError(
                f"Static QR needs {modules}×{modules} modules (max {STATIC_MAX_QR_MODULES}). "
                "Select fewer coins."
            )
        static = True
        parts = [part]
        frag = len(_cbor_bytes_payload(payload))
        hold_ms = 0
        fountain = False
        unique_parts = 1

    def _encode_animated() -> None:
        nonlocal parts, frag, hold_ms, fountain, unique_parts, static
        frag = (
            max_fragment_len
            if max_fragment_len is not None
            else pick_fragment_len(payload, target_modules=modules_target)
        )
        parts = ur_parts_for_text(text, max_fragment_len=frag, anim_cycles=1)
        static = False
        hold_ms = frame_ms if frame_ms is not None else ANIMATED_FRAME_MS
        fountain = len(parts) > 1
        unique_parts = len(parts)

    if static:
        try:
            _encode_static()
        except ValueError:
            _encode_animated()
    else:
        try:
            _encode_animated()
        except ValueError:
            _encode_static()

    modules = _qr_modules_for_uri(parts[0]) if parts else 0
    bs = STATIC_QR_BOX_SIZE if static else box_size
    frames = [qr_png_base64_for_part(p, box_size=bs) for p in parts]
    display_px = (modules * bs + 8 * bs) if modules else 320
    return {
        "qr_frames_base64": frames,
        "qr_frame_count": len(frames),
        "qr_unique_parts": unique_parts,
        "qr_frame_ms": hold_ms,
        "qr_stepped": False,
        "qr_fountain": fountain,
        "qr_display_mode": "static" if static else "animated",
        "qr_png_base64": frames[0],
        "qr_fragment_len": frag,
        "qr_modules_per_frame": modules,
        "qr_display_pixels": display_px,
        "qr_payload_bytes": len(payload),
    }


def fountain_qr_frames_base64(
    unsigned: dict,
    *,
    max_fragment_len: int | None = None,
    box_size: int = DEFAULT_QR_BOX_SIZE,
    frame_ms: int | None = None,
    qr_display_mode: str = "animated",
) -> dict:
    text = unsigned_json_for_qr(unsigned)
    return fountain_qr_frames_base64_text(
        text,
        max_fragment_len=max_fragment_len,
        box_size=box_size,
        frame_ms=frame_ms,
        qr_display_mode=qr_display_mode,
    )
