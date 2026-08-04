"""BC-UR fountain QR for Bitcoin PSBT (ur:crypto-psbt/, SeedMask camera)."""

from __future__ import annotations

import base64

from .bcur.cbor_lite import CBOREncoder
from .bcur.ur import UR
from .bcur.ur_encoder import UREncoder
from .ur_qr import (
    ANIMATED_FRAME_MS,
    DEFAULT_QR_BOX_SIZE,
    MAX_DISPLAY_FRAMES,
    MAX_URI_CHARS_PER_PART,
    STATIC_MAX_QR_MODULES,
    STATIC_MAX_URI_CHARS,
    STATIC_QR_BOX_SIZE,
    _qr_modules_for_uri,
    pick_fragment_len,
    qr_png_base64_for_part,
)

UR_PSBT_TYPE = "crypto-psbt"


def _cbor_bytes_payload(data: bytes) -> list[int]:
    enc = CBOREncoder()
    enc.encodeBytes(data)
    return list(enc.get_bytes())


def _make_encoder(payload: bytes, max_fragment_len: int) -> UREncoder:
    ur = UR(UR_PSBT_TYPE, _cbor_bytes_payload(payload))
    return UREncoder(ur, max_fragment_len=max_fragment_len, first_seq_num=0, min_fragment_len=10)


def static_single_psbt_ur_part(psbt_bytes: bytes) -> str:
    ur = UR(UR_PSBT_TYPE, _cbor_bytes_payload(psbt_bytes))
    return UREncoder.encode(ur)


def ur_parts_for_psbt(
    psbt_bytes: bytes,
    max_fragment_len: int,
    *,
    max_frames: int = MAX_DISPLAY_FRAMES,
) -> list[str]:
    encoder = _make_encoder(psbt_bytes, max_fragment_len)
    if encoder.is_single_part():
        return [encoder.next_part()]
    seq_len = encoder.fountain_encoder.seq_len()
    if seq_len > max_frames:
        raise ValueError(
            f"PSBT needs {seq_len} UR parts; max {max_frames}. Try fewer inputs/outputs or animated mode."
        )
    return [encoder.next_part() for _ in range(seq_len)]


def fountain_qr_frames_base64_psbt(
    psbt_bytes: bytes,
    *,
    max_fragment_len: int | None = None,
    box_size: int = DEFAULT_QR_BOX_SIZE,
    frame_ms: int | None = None,
    qr_display_mode: str = "animated",
) -> dict:
    mode = (qr_display_mode or "animated").strip().lower()
    static = mode in ("static", "single", "one")
    if static:
        part = static_single_psbt_ur_part(psbt_bytes)
        modules = _qr_modules_for_uri(part)
        if len(part) <= STATIC_MAX_URI_CHARS and modules <= STATIC_MAX_QR_MODULES:
            parts = [part]
            frag = len(_cbor_bytes_payload(psbt_bytes))
            hold_ms = 0
            fountain = False
            unique_parts = 1
        else:
            static = False
    if not static:
        frag = max_fragment_len if max_fragment_len is not None else pick_fragment_len(psbt_bytes)
        parts = ur_parts_for_psbt(psbt_bytes, frag)
        hold_ms = frame_ms if frame_ms is not None else ANIMATED_FRAME_MS
        fountain = len(parts) > 1
        unique_parts = len(parts)
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
        "qr_payload_bytes": len(psbt_bytes),
        "ur_type": UR_PSBT_TYPE,
    }
