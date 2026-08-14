#!/usr/bin/env python3
"""Verify coordinator Kaspa PSKT UR parts decode with the same BC-UR stack as the device."""
import json
import sys
from pathlib import Path

COORD = Path(__file__).resolve().parents[1]
APP = COORD / "app"
sys.path.insert(0, str(APP))
sys.path.insert(0, str(COORD.parent / "tools"))

from kaspa import PublicKeyGenerator, NetworkType
from kaspa_coordinator_qr import build_unsigned_v2

from bcur.bytewords import Bytewords, Bytewords_Style_minimal
from bcur.fountain_decoder import FountainDecoder
from bcur.fountain_encoder import Part
from ur_qr import fountain_qr_frames_base64, pick_fragment_len, ur_parts_for_text, unsigned_json_for_qr


def main() -> int:
    wallet = Path.home() / ".seedmask-coordinator/wallet.json"
    if not wallet.is_file():
        print("no wallet — using sample fixture")
        from kaspa_coordinator_qr import SAMPLE_TEST_V2

        unsigned = SAMPLE_TEST_V2
    else:
        cfg = json.loads(wallet.read_text())
        recv = str(
            PublicKeyGenerator.from_xpub(cfg["kpub"]).receive_address_as_string(
                NetworkType.Mainnet, 0
            )
        )
        unsigned = build_unsigned_v2(
            prev_tx_id="ab" * 32,
            prev_index=0,
            amount_sompi=50_000_000,
            send_sompi=25_000_000,
            receive_address=recv,
            to_address=recv,
            account=0,
            sign_index=0,
            change_to_receive=False,
        )

    text = unsigned_json_for_qr(unsigned)
    payload = text.encode()
    frag = pick_fragment_len(payload)
    parts = ur_parts_for_text(text, frag, anim_cycles=1)
    info = fountain_qr_frames_base64(unsigned)

    print(f"json_bytes={len(payload)} fragment_len={frag} parts={len(parts)}")
    print(
        f"qr_modules={info['qr_modules_per_frame']} frames={info['qr_frame_count']} "
        f"display_px={info['qr_display_pixels']}"
    )

    dec = FountainDecoder()
    for p in parts:
        comps = p[3:].split("/")
        body = Bytewords.decode(Bytewords_Style_minimal, comps[2])
        part = Part.from_cbor(body)
        if not dec.receive_part(part):
            if dec.is_complete():
                print("reject after complete:", comps[1])
                return 1
    if not dec.is_complete() or not dec.is_success():
        print("fountain failed")
        return 1
    got = bytes(dec.result_message()).decode()
    if got != text:
        print("payload mismatch", len(got), len(text))
        return 1
    print("OK — all parts decode to original JSON")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
