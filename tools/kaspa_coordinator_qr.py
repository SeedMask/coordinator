#!/usr/bin/env python3
"""Kaspa mainnet coordinator JSON v2 QR for SeedMask on-device signing.

Usage:
  python3 kaspa_coordinator_qr.py --sample-test --png ~/kaspa_tx_test.png
  python3 kaspa_coordinator_qr.py --account 0 --png ~/kaspa_tx.png \\
      --prev-tx-id <hex> --prev-index 0 --amount-sompi N \\
      --receive-address kaspa:...   # your SeedMask Receive (funds you spend) \\
      --to-address kaspa:...        # who gets paid (required for real sends) \\
      --sign-index 0 --send-sompi N

  # With --png, also writes ~/kaspa_tx_unsigned.json automatically.

After the device shows the signed QR, run:
  python3 kaspa_apply_signatures.py ~/kaspa_tx_unsigned.json signed.json -o ready.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys

KASPA_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
REV_CHARSET = {c: i for i, c in enumerate(KASPA_CHARSET)}
# Mainnet Schnorr addresses: kaspa: + 61 bech32 chars (do not use {52,68} — trailing English
# words like "thanks" are valid charset and get swallowed by a greedy long match).
_BECH32_BODY_RE = re.compile(
    r"kaspa:([qpzry9x8gf2tvdw0s3jn54khce6mua7l]{59,61})",
    re.IGNORECASE,
)
_BECH32_ONLY_RE = re.compile(
    r"([qpzry9x8gf2tvdw0s3jn54khce6mua7l]{59,61})",
    re.IGNORECASE,
)


def normalize_kaspa_address(address: str) -> str:
    """Strip paste artifacts; extract kaspa:… from labels; lowercase bech32 body."""
    address = "".join(address.strip().split())
    for sep in ("?", "#"):
        if sep in address:
            address = address.split(sep, 1)[0]

    lower = address.lower()
    if lower.startswith("kaspatest:") or lower.startswith("kaspasim:") or lower.startswith("kaspadev:"):
        raise ValueError("Testnet/simnet addresses are not supported — use mainnet kaspa:…")

    matches = _BECH32_BODY_RE.findall(address)
    if not matches:
        matches = _BECH32_ONLY_RE.findall(address)
        if matches:
            address = "kaspa:" + max(matches, key=len)
        elif ":" in address:
            hrp, data = address.split(":", 1)
            if hrp.lower() == "kaspa":
                address = "kaspa:" + data.lower()
            else:
                raise ValueError("Address must start with kaspa:")
        else:
            raise ValueError("Address must start with kaspa:")
    else:
        address = "kaspa:" + max(matches, key=len).lower()

    if not address.startswith("kaspa:"):
        raise ValueError("Address must start with kaspa:")
    hrp, data = address.split(":", 1)
    if hrp != "kaspa":
        raise ValueError("Address must start with kaspa:")
    if len(data) < 59 or len(data) > 61:
        raise ValueError(
            f"Kaspa address length wrong ({len(data)} chars after kaspa:; expected 59–61)"
        )
    if any(c not in REV_CHARSET for c in data):
        bad = next(c for c in data if c not in REV_CHARSET)
        raise ValueError(f"Invalid character {bad!r} in address (check copy/paste)")
    return f"kaspa:{data}"


def _polymod(values: list[int]) -> int:
    c = 1
    for v in values:
        c0 = c >> 35
        c = ((c & 0x07FFFFFFFF) << 5) ^ v
        if c0 & 0x01:
            c ^= 0x98F2BC8E61
        if c0 & 0x02:
            c ^= 0x79B76D99E2
        if c0 & 0x04:
            c ^= 0xF33E5FB3C4
        if c0 & 0x08:
            c ^= 0xAE2EABE2A8
        if c0 & 0x10:
            c ^= 0x1E4F43E470
    return c ^ 1


def _hrp_expand(hrp: str) -> list[int]:
    out = [ord(x) & 0x1F for x in hrp]
    out.append(0)
    return out


def _convertbits(data: list[int], frombits: int, tobits: int, pad: bool = True) -> list[int]:
    acc = 0
    bits = 0
    ret: list[int] = []
    maxv = (1 << tobits) - 1
    for value in data:
        acc = (acc << frombits) | value
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad and bits:
        ret.append((acc << (tobits - bits)) & maxv)
    return ret


def kaspa_address_to_script_hex(address: str) -> str:
    """Script hex from a mainnet kaspa: address.

    Supports standard P2PK Schnorr addresses (version 0) and P2SH script-hash
    addresses (version 8), which are used by Kaspa multisig receive/change.
    """
    try:
        address = normalize_kaspa_address(address)
    except ValueError as e:
        raise SystemExit(str(e)) from e
    hrp, data = address.split(":", 1)
    if hrp != "kaspa":
        raise SystemExit("Only mainnet kaspa: addresses supported")
    data5 = [REV_CHARSET[c] for c in data]
    if len(data5) < 8:
        raise SystemExit("Address too short")
    payload5, chk5 = data5[:-8], data5[-8:]
    chk_u64 = int.from_bytes(b"\x00\x00\x00" + bytes(_convertbits(chk5, 5, 8, False)), "big")
    if _polymod(_hrp_expand(hrp) + payload5 + [0] * 8) != chk_u64:
        raise SystemExit("Address checksum invalid")
    payload8 = bytes(_convertbits(payload5, 5, 8, False))
    if len(payload8) != 33:
        raise SystemExit("Kaspa address payload length invalid")
    version = payload8[0]
    payload = payload8[1:33]
    if version == 0:
        return "20" + payload.hex() + "ac"
    if version == 8:
        return "aa20" + payload.hex() + "87"
    raise SystemExit(f"Unsupported Kaspa address type/version ({version})")

# rusty-kaspa native-all-0 sighash fixture (for scan/review/sign self-test without UTXOs).
SAMPLE_TEST_V2 = {
    "version": 2,
    "network": "mainnet",
    "account": 0,
    "tx_version": 0,
    "lock_time": 1615462089000,
    "gas": 0,
    "subnetwork_id_hex": "0" * 40,
    "payload_hex": "",
    "inputs": [
        {
            "prev_tx_id": "880eb9819a31821d9d2399e2f35e2433b72637e393d71ecc9b8d0250f49153c3",
            "prev_index": 0,
            "sequence": 0,
            "sig_op_count": 0,
            "utxo_amount": 100,
            "utxo_script_version": 0,
            "utxo_script_hex": "208325613d2eeaf7176ac6c670b13c0043156c427438ed72d74b7800862ad884e8ac",
            "sign_chain": 0,
            "sign_address_index": 0,
        },
        {
            "prev_tx_id": "880eb9819a31821d9d2399e2f35e2433b72637e393d71ecc9b8d0250f49153c3",
            "prev_index": 1,
            "sequence": 1,
            "sig_op_count": 0,
            "utxo_amount": 200,
            "utxo_script_version": 0,
            "utxo_script_hex": "20fcef4c106cf11135bbd70f02a726a92162d2fb8b22f0469126f800862ad884e8ac",
        },
        {
            "prev_tx_id": "880eb9819a31821d9d2399e2f35e2433b72637e393d71ecc9b8d0250f49153c3",
            "prev_index": 2,
            "sequence": 2,
            "sig_op_count": 0,
            "utxo_amount": 300,
            "utxo_script_version": 0,
            "utxo_script_hex": "20fcef4c106cf11135bbd70f02a726a92162d2fb8b22f0469126f800862ad884e8ac",
        },
    ],
    "outputs": [
        {
            "value": 300,
            "script_version": 0,
            "script_hex": "20fcef4c106cf11135bbd70f02a726a92162d2fb8b22f0469126f800862ad884e8ac",
        },
        {
            "value": 300,
            "script_version": 0,
            "script_hex": "208325613d2eeaf7176ac6c670b13c0043156c427438ed72d74b7800862ad884e8ac",
        },
    ],
}


def build_unsigned_v2(
    *,
    prev_tx_id: str,
    prev_index: int = 0,
    amount_sompi: int,
    send_sompi: int,
    receive_address: str,
    to_address: str,
    account: int = 0,
    sign_index: int = 0,
    change_to_receive: bool = False,
) -> dict:
    """Build coordinator JSON v2 (single output by default for KIP-9 storage mass)."""
    class _Args:
        pass

    args = _Args()
    args.prev_tx_id = prev_tx_id
    args.prev_index = prev_index
    args.amount_sompi = amount_sompi
    args.send_sompi = send_sompi
    args.receive_address = receive_address
    args.to_address = to_address
    args.account = account
    args.sign_index = sign_index
    args.script_hex = None
    args.output_script_hex = None
    args.change_to_receive = change_to_receive
    return build_manual_v2(args)


def build_manual_v2(args: argparse.Namespace) -> dict:
    if not args.prev_tx_id:
        raise SystemExit("Need --prev-tx-id from the funding transaction on kaspa.stream")
    if not args.amount_sompi:
        raise SystemExit("Need --amount-sompi (full UTXO value in sompi)")
    if args.receive_address:
        script_hex = kaspa_address_to_script_hex(args.receive_address)
        print(f"UTXO script from address ({len(script_hex)//2} bytes): {script_hex}", file=sys.stderr)
    elif args.script_hex:
        script_hex = args.script_hex.strip().lower()
        if script_hex.startswith("0x"):
            script_hex = script_hex[2:]
        if len(script_hex) == 64 and not script_hex.startswith("20"):
            print(
                "Warning: --script-hex is 32-byte x-only only (explorer quirk). "
                "Use --receive-address from SeedMask Receive so UTXO script and mass are correct.",
                file=sys.stderr,
            )
    else:
        raise SystemExit("Use --receive-address kaspa:... (from SeedMask Receive) OR --script-hex from explorer")
    send = int(args.send_sompi)
    amount = int(args.amount_sompi)
    fee = max(0, amount - send)
    if args.to_address and args.output_script_hex:
        raise SystemExit("Use only one of --to-address or --output-script-hex")
    if args.to_address:
        out_script = kaspa_address_to_script_hex(args.to_address)
        print(f"Payee script from --to-address ({len(out_script)//2} bytes): {out_script}", file=sys.stderr)
    else:
        out_script = args.output_script_hex or script_hex
        if not args.output_script_hex:
            print(
                "Note: no --to-address — payment output goes back to your receive script (test/change only).",
                file=sys.stderr,
            )
    payload = {
        "version": 2,
        "network": "mainnet",
        "account": args.account,
        "tx_version": 0,
        "lock_time": 0,
        "gas": 0,
        "subnetwork_id_hex": "0" * 40,
        "payload_hex": "",
        "inputs": [
            {
                "prev_tx_id": args.prev_tx_id.strip(),
                "prev_index": args.prev_index,
                "sequence": 0,
                "sig_op_count": 1,
                "utxo_amount": amount,
                "utxo_script_version": 0,
                "utxo_script_hex": script_hex,
                "sign_chain": 0,
                "sign_address_index": args.sign_index,
                "receive_address": args.receive_address.strip() if args.receive_address else "",
            }
        ],
        "outputs": [
            {
                "value": send,
                "script_version": 0,
                "script_hex": out_script.strip(),
                "kaspa_address": args.to_address.strip() if args.to_address else "",
            },
        ],
    }
    if fee > 0:
        if getattr(args, "change_to_receive", False):
            payload["outputs"].append(
                {
                    "value": fee,
                    "script_version": 0,
                    "script_hex": script_hex,
                    "kaspa_address": args.receive_address.strip() if args.receive_address else "",
                    "is_change": True,
                }
            )
        else:
            print(
                f"Implicit fee: {fee} sompi (inputs {amount} − output {send}). "
                "No change output — required for 1-input sends under KIP-9 storage mass.",
                file=sys.stderr,
            )
    try:
        from kaspa_mass import validate_unsigned_for_relay

        validate_unsigned_for_relay(payload)
    except SystemExit as e:
        print(f"Warning: {e}", file=sys.stderr)
    except ImportError:
        pass
    _warn_storage_mass(payload)
    return payload


def _warn_storage_mass(payload: dict) -> None:
    try:
        from kaspa_mass import warn_unsigned_mass

        warn_unsigned_mass(payload)
    except ImportError:
        pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--png", metavar="PATH", help="Write QR PNG")
    ap.add_argument("--json-out", metavar="PATH", help="Also write JSON file")
    ap.add_argument("--account", type=int, default=0)
    ap.add_argument("--sample-test", action="store_true", help="Built-in sighash test tx (no broadcast)")
    ap.add_argument("--prev-tx-id", help="Funding tx id (hex)")
    ap.add_argument("--prev-index", type=int, default=0)
    ap.add_argument("--amount-sompi", type=int, help="UTXO amount in sompi")
    ap.add_argument(
        "--receive-address",
        help="SeedMask Receive kaspa:... address — auto-builds correct utxo script (recommended)",
    )
    ap.add_argument("--script-hex", help="UTXO script hex from explorer (alternative to --receive-address)")
    ap.add_argument(
        "--to-address",
        help="Recipient kaspa:... address (where --send-sompi goes). Use this for real payments.",
    )
    ap.add_argument("--output-script-hex", help="Recipient script hex (advanced; overrides --to-address)")
    ap.add_argument("--sign-index", type=int, default=0, help="BIP44 address index to sign with")
    ap.add_argument(
        "--change-to-receive",
        action="store_true",
        help="Add a second output returning leftover sompi to Receive (often fails KIP-9 mass for 1→2)",
    )
    ap.add_argument("--send-sompi", type=int, default=0, help="Output value to pay (rest is implicit change)")
    ap.add_argument(
        "--png-scale",
        type=int,
        default=12,
        help="QR module size in pixels (larger = easier to scan from monitor, default 12)",
    )
    args = ap.parse_args()

    if args.sample_test:
        payload = dict(SAMPLE_TEST_V2)
        payload["account"] = args.account
    else:
        payload = build_manual_v2(args)

    text = json.dumps(payload, separators=(",", ":"))
    print(f"Payload ({len(text)} bytes):\n{text}\n", file=sys.stderr)

    outs = payload.get("outputs") or []
    if outs:
        pay = outs[0].get("value", 0)
        print(f"Summary: pay {pay} sompi in output[0]; change/fee in other outputs if any.", file=sys.stderr)
        if args.to_address:
            print(f"  Recipient (--to-address): {args.to_address.strip()}", file=sys.stderr)
        if args.receive_address:
            print(f"  Spending from Receive: {args.receive_address.strip()}", file=sys.stderr)

    json_out = args.json_out
    if not json_out and args.png:
        import os

        base, _ = os.path.splitext(args.png)
        json_out = base + "_unsigned.json"
    if json_out:
        with open(json_out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"Wrote {json_out} (keep this for finish after signing)", file=sys.stderr)

    try:
        import qrcode
    except ImportError:
        print("Install: pip install qrcode[pil]", file=sys.stderr)
        return 1

    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=max(4, args.png_scale))
    qr.add_data(text)
    qr.make(fit=True)

    if args.png:
        img = qr.make_image(fill_color="black", back_color="white")
        img = img.convert("RGB")
        border = max(16, args.png_scale * 2)
        from PIL import Image

        padded = Image.new("RGB", (img.size[0] + border * 2, img.size[1] + border * 2), "white")
        padded.paste(img, (border, border))
        padded.save(args.png)
        print(f"Wrote {args.png}", file=sys.stderr)
    else:
        qr.print_ascii(invert=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
