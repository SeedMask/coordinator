"""Assemble signed payloads from BC-UR fountain frames (Mac camera scan)."""

from __future__ import annotations

import base64
import json

from app.bcur.cbor_lite import CBORDecoder
from app.bcur.ur_decoder import URDecoder

_decoder = URDecoder()
_PSBT_MAGIC = b"psbt\xff"


def _ur_message_bytes(ur) -> bytes:
    dec = CBORDecoder(list(ur.cbor))
    value, _ = dec.decodeBytes()
    return value


def reset() -> None:
    global _decoder
    _decoder = URDecoder()


def feed(frame: str) -> dict:
    global _decoder
    text = frame.strip()
    if not text:
        return {"complete": False, "progress": 0.0, "message": "Empty scan", "payload": None}
    if text.startswith("{"):
        return {
            "complete": True,
            "progress": 1.0,
            "message": "Signed JSON captured",
            "payload": text,
        }
    if not text.lower().startswith("ur:"):
        return {
            "complete": False,
            "progress": 0.0,
            "message": "Expected ur:… or JSON — keep scanning",
            "payload": None,
        }
    if not _decoder.receive_part(text):
        return {
            "complete": False,
            "progress": float(_decoder.estimated_percent_complete()),
            "message": "Unreadable frame — adjust distance",
            "payload": None,
        }
    pct = float(_decoder.estimated_percent_complete())
    if _decoder.is_complete():
        if _decoder.is_success():
            ur = _decoder.result_message()
            raw = _ur_message_bytes(ur)
            reset()
            ur_type = (getattr(ur, "type", None) or "").lower()
            if ur_type in {"crypto-psbt", "psbt"} or raw.startswith(_PSBT_MAGIC):
                payload = json.dumps(
                    {
                        "format": "bitcoin_psbt",
                        "psbt_base64": base64.b64encode(raw).decode("ascii"),
                    },
                    separators=(",", ":"),
                )
                return {
                    "complete": True,
                    "progress": 1.0,
                    "message": "Signed PSBT assembled",
                    "payload": payload,
                }
            try:
                payload = raw.decode("utf-8")
            except Exception:
                return {
                    "complete": False,
                    "progress": pct,
                    "message": "Decoded payload is not UTF-8 JSON or PSBT",
                    "payload": None,
                }
            if not payload.strip().startswith("{"):
                return {
                    "complete": False,
                    "progress": 1.0,
                    "message": "UR OK but not JSON or PSBT",
                    "payload": None,
                }
            msg = "Connect payload assembled"
            try:
                import json as _json

                obj = _json.loads(payload)
                if isinstance(obj, dict) and str(obj.get("format") or "").lower() == "seedmask_connect":
                    msg = "SeedMask pairing assembled"
                elif isinstance(obj, dict) and ("psbt_base64" in obj or "inputs" in obj):
                    msg = "Signed transaction assembled"
            except Exception:
                pass
            return {
                "complete": True,
                "progress": 1.0,
                "message": msg,
                "payload": payload,
            }
        err = "UR assembly failed"
        if _decoder.is_failure():
            try:
                err = str(_decoder.result_error())
            except Exception:
                pass
        reset()
        return {"complete": False, "progress": pct, "message": err, "payload": None}
    return {
        "complete": False,
        "progress": pct,
        "message": f"Assembling signed QR… {int(pct * 100)}%",
        "payload": None,
    }
