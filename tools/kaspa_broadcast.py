#!/usr/bin/env python3
"""Submit kaspa_tx_ready.json to the Kaspa network (mainnet).

Requires: pip install kaspa

Usage:
  python3 kaspa_broadcast.py ~/kaspa_tx_ready.json
  python3 kaspa_broadcast.py ~/kaspa_tx_ready.json --check   # validate outputs only
  python3 kaspa_broadcast.py ~/kaspa_tx_ready.json --dry-run

Connects via the public node resolver (no local kaspad required).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

STORAGE_MASS_LIMIT = 100_000

try:
    from kaspa_mass import MassReport, analyze_unsigned, warn_unsigned_mass
except ImportError:
    MassReport = None  # type: ignore[misc, assignment]
    analyze_unsigned = None  # type: ignore[assignment]
    warn_unsigned_mass = None  # type: ignore[assignment]


def wrap_schnorr_signature_script(sig_hex: str) -> bytes:
    """SeedMask emits 64-byte BIP-340 sig (128 hex). Kaspa expects push + sig + SIGHASH_ALL."""
    sig_hex = sig_hex.strip().lower()
    if len(sig_hex) == 128:
        return bytes.fromhex("41" + sig_hex + "01")
    if len(sig_hex) == 132 and sig_hex.startswith("41") and sig_hex.endswith("01"):
        return bytes.fromhex(sig_hex)
    raise SystemExit(f"Unexpected signature_script length {len(sig_hex)} (want 128 or 132 hex chars)")


def normalize_script_hex(script_hex: str) -> str:
    """Return bare script body (P2PK or P2SH). Fixes explorer 32-byte x-only mistakes."""
    h = script_hex.strip().lower()
    if h.startswith("0x"):
        h = h[2:]
    if len(h) >= 72 and h[4:6] == "20" and h.endswith("ac"):
        body = h[4:]
        if len(body) == 68:
            return body
    if len(h) >= 74 and h[4:8] == "aa20" and h.endswith("87"):
        body = h[4:]
        if len(body) == 70:
            return body
    if len(h) == 64 and not h.startswith("20") and not h.startswith("aa"):
        print(
            "Warning: script_hex is 32-byte x-only only; wrapping as Schnorr P2PK (20…ac). "
            "Prefer --receive-address / --to-address when building the unsigned QR.",
            file=sys.stderr,
        )
        return "20" + h + "ac"
    if len(h) == 68 and h.startswith("20") and h.endswith("ac"):
        return h
    if len(h) == 70 and h.startswith("aa20") and h.endswith("87"):
        return h
    raise SystemExit(
        f"script_hex length {len(h)} does not look like Schnorr P2PK or P2SH "
        "(want 68 hex P2PK: 20 + 32-byte x + ac, 70 hex P2SH: aa20 + hash + 87, or 64 hex x-only)"
    )


def validate_script_public_key(spk, output_index: int) -> str:
    from kaspa import NetworkType, address_from_script_public_key

    try:
        addr = address_from_script_public_key(spk, NetworkType.Mainnet)
        return str(addr)
    except Exception as e:
        raise SystemExit(
            f"output #{output_index}: non-standard script ({e})\n"
            f"  version={spk.version} script={spk.script}\n"
            "  Fix: rebuild the unsigned QR with --to-address 'kaspa:...' (recipient) and\n"
            "  --receive-address 'kaspa:...' (your SeedMask Receive), sign again, then finish."
        ) from e


def script_public_key_from_hex(script_hex: str, version: int = 0):
    from kaspa import ScriptPublicKey

    body = normalize_script_hex(script_hex)
    return ScriptPublicKey(int(version), bytes.fromhex(body))


def script_public_key_for_address(addr: str):
    from kaspa import Address, pay_to_address_script

    addr = addr.strip()
    if not addr.lower().startswith("kaspa:"):
        raise SystemExit(f"invalid kaspa address {addr!r}")
    return pay_to_address_script(Address(addr))


def output_script_public_key(out: dict, index: int, default_receive: str):
    addr = (out.get("kaspa_address") or out.get("to_address") or "").strip()
    if not addr and out.get("is_change") and default_receive:
        addr = default_receive.strip()
    if addr:
        spk = script_public_key_for_address(addr)
        validate_script_public_key(spk, index)
        print(f"output #{index}: {addr} ({out.get('value')} sompi)", file=sys.stderr)
        return spk

    spk = script_public_key_from_hex(out.get("script_hex", ""), int(out.get("script_version", 0)))
    decoded_addr = validate_script_public_key(spk, index)
    print(f"output #{index}: {decoded_addr} ({out.get('value')} sompi)", file=sys.stderr)
    return spk


def input_script_public_key(inp: dict, index: int):
    """Locking script for the spent UTXO (must match what was on-chain when signed)."""
    addr = (inp.get("receive_address") or "").strip()
    if addr:
        spk = script_public_key_for_address(addr)
        print(f"input #{index}: UTXO script from receive_address {addr}", file=sys.stderr)
        return spk

    utxo_script = inp.get("utxo_script_hex", "").strip()
    if utxo_script.startswith("0x"):
        utxo_script = utxo_script[2:]
    if not utxo_script:
        raise SystemExit(
            f"input {inp.get('prev_index')}: missing receive_address and utxo_script_hex.\n"
            "  Rebuild unsigned QR with --receive-address 'kaspa:...' (your Receive address)."
        )
    return script_public_key_from_hex(utxo_script, int(inp.get("utxo_script_version", 0)))


def _validate_multisig_ready_input(inp: dict, index: int) -> None:
    """Catch common multisig finalize mistakes before the node rejects the tx."""
    redeem = str(inp.get("redeem_script_hex") or "").strip().lower().replace("0x", "")
    sig_script = str(inp.get("signature_script") or inp.get("sig_hex") or "").strip().lower().replace("0x", "")
    if not redeem and not sig_script.startswith(("41", "4c", "4d")):
        return
    if not redeem:
        raise SystemExit(
            f"input #{index}: multisig signature_script present but redeem_script_hex is missing.\n"
            "  Rebuild the unsigned draft on Send, re-sign on every cosigner, then Finish again."
        )
    if not sig_script:
        return
    try:
        from kaspa_multisig import _push_data_hex
        from kaspa_pskt import _redeem_script_pubkeys
    except ImportError as exc:
        print(f"Warning: multisig preflight skipped ({exc})", file=sys.stderr)
        return

    required, xonly_pubkeys = _redeem_script_pubkeys(redeem)
    redeem_push = _push_data_hex(redeem)
    if not sig_script.endswith(redeem_push):
        raise SystemExit(
            f"input #{index}: signature_script must end with a pushed redeem script.\n"
            "  Rebuild Coordinator, start a new Send, and re-sign on every cosigner."
        )
    sig_pushes = sig_script[: -len(redeem_push)]
    if sig_pushes.startswith("00"):
        raise SystemExit(
            f"input #{index}: Kaspa multisig must not include Bitcoin OP_0 dummy pushes.\n"
            "  Rebuild Coordinator and re-sign — old signed JSON cannot be repaired in place."
        )
    if len(sig_pushes) < required * 132:
        raise SystemExit(
            f"input #{index}: expected at least {required} signature push(es) before the redeem script."
        )
    if len(set(xonly_pubkeys)) != len(xonly_pubkeys):
        raise SystemExit(
            f"input #{index}: redeem script contains duplicate cosigner pubkeys.\n"
            "  Each cosigner must use a distinct BIP45 kpub/account in the Coordinator wallet."
        )
    print(
        f"input #{index}: multisig preflight OK ({required}-of-{len(xonly_pubkeys)} redeem script, "
        f"{len(sig_pushes) // 132} signature push(es))",
        file=sys.stderr,
    )


def _norm_txid(txid: str) -> str:
    txid = txid.strip().lower()
    if txid.startswith("0x"):
        txid = txid[2:]
    return txid


async def fetch_utxo_reference(
    client,
    receive_addr: str,
    txid: str,
    index: int,
    *,
    timeout_sec: float = 25.0,
):
    """Load real UTXO metadata (blockDaaScore, amount, script) from mainnet."""
    import asyncio

    from kaspa import UtxoEntryReference

    resp = await asyncio.wait_for(
        client.get_utxos_by_addresses({"addresses": [receive_addr]}),
        timeout=timeout_sec,
    )
    for entry in resp.get("entries", []):
        op = entry["outpoint"]
        tid = _norm_txid(str(op["transactionId"]))
        if tid == txid and int(op["index"]) == index:
            ref = UtxoEntryReference.from_dict(entry)
            print(
                f"  UTXO {txid[:16]}…:{index} blockDaaScore={ref.block_daa_score} "
                f"amount={ref.amount}",
                file=sys.stderr,
            )
            return ref
    return None


def utxo_reference_from_json(inp: dict, txid: str, index: int, spk) -> "UtxoEntryReference":
    from kaspa import UtxoEntryReference
    from kaspa_toccata import utxo_entry_dict_from_input

    utxo_amount = int(inp.get("utxo_amount", 0))
    if utxo_amount <= 0:
        raise SystemExit("input missing utxo_amount (need original unsigned JSON fields)")

    row = dict(inp)
    row["prev_tx_id"] = txid
    row["prev_index"] = index
    if not row.get("utxo_script_hex"):
        row["utxo_script_hex"] = spk.script.hex() if hasattr(spk.script, "hex") else bytes(spk.script).hex()
    return UtxoEntryReference.from_dict(utxo_entry_dict_from_input(row))


def check_storage_mass(ready: dict) -> int | None:
    """KIP-9 storage mass from input/output values (1 input + 2 small outputs → ~1011111)."""
    try:
        from kaspa import NetworkId, calculate_storage_mass
    except ImportError:
        return None
    in_vals = [int(i.get("utxo_amount", 0)) for i in ready.get("inputs") or []]
    out_vals = [int(o.get("value", 0)) for o in ready.get("outputs") or []]
    if not in_vals or not out_vals:
        return None
    return calculate_storage_mass(NetworkId("mainnet"), in_vals, out_vals)


def storage_mass_hint(ready: dict, storage_mass: int | None) -> str:
    n_in = len(ready.get("inputs") or [])
    n_out = len(ready.get("outputs") or [])
    if storage_mass is not None and storage_mass > STORAGE_MASS_LIMIT and n_in == 1 and n_out >= 2:
        return (
            f"\n  Likely cause: 1 input and {n_out} outputs (payment + change) with small sompi values.\n"
            "  Kaspa KIP-9 rejects this (storage mass explodes).\n"
            "  Fix: rebuild WITHOUT a change output (default since coordinator fix):\n"
            "    python3 kaspa_send.py build ... --send-sompi <amount minus fee>  # do NOT use --change-to-receive\n"
            "  Then sign again and finish. Leftover sompi stays as the tx fee."
        )
    return ""


def _input_has_utxo_metadata(inp: dict) -> bool:
    """True when the coordinator already captured live UTXO fields during wallet scan."""
    score = int(inp.get("block_daa_score") or inp.get("blockDaaScore") or 0)
    amount = int(inp.get("utxo_amount") or 0)
    script = str(inp.get("utxo_script_hex") or "").strip().lower().replace("0x", "")
    return score > 0 and amount > 0 and len(script) >= 4


def _input_has_local_utxo_fields(inp: dict) -> bool:
    """Enough to build UtxoEntryReference from the signed draft (skip slow RPC lookup)."""
    amount = int(inp.get("utxo_amount") or 0)
    script = str(inp.get("utxo_script_hex") or "").strip().lower().replace("0x", "")
    return amount > 0 and len(script) >= 4


async def ready_to_transaction(ready: dict, client=None) -> tuple:
    from kaspa import NetworkId, calculate_transaction_mass, update_transaction_mass
    from kaspa_toccata import build_transaction_input, build_transaction_output, tx_version_from_unsigned

    if not ready.get("seedmask_signed"):
        print("Warning: seedmask_signed flag missing — is this a merged ready.json?", file=sys.stderr)

    default_receive = ""
    for inp in ready.get("inputs") or []:
        ra = (inp.get("receive_address") or "").strip()
        if ra:
            default_receive = ra
            break

    tx_version = tx_version_from_unsigned(ready)
    fetched_utxos = False
    inputs = []
    for i, inp in enumerate(ready.get("inputs") or []):
        sig = inp.get("signature_script") or inp.get("sig_hex")
        if not sig:
            txid = _norm_txid(inp.get("prev_tx_id", ""))
            prev = inp.get("prev_index")
            raise SystemExit(
                f"input #{i} ({txid[:16]}…:{prev}) missing signature_script — "
                f"only {sum(1 for x in ready.get('inputs') or [] if str((x or {}).get('signature_script') or (x or {}).get('sig_hex') or '').strip())}/"
                f"{len(ready.get('inputs') or [])} inputs are signed"
            )

        _validate_multisig_ready_input(inp, i)

        txid = _norm_txid(inp["prev_tx_id"])
        index = int(inp["prev_index"])
        receive_addr = (inp.get("receive_address") or "").strip()

        row = dict(inp)
        row["signature_script"] = sig
        if _input_has_utxo_metadata(row):
            fetched_utxos = True
        elif _input_has_local_utxo_fields(row):
            fetched_utxos = True
        elif client and receive_addr:
            utxo_ref = await fetch_utxo_reference(client, receive_addr, txid, index)
            if utxo_ref is None:
                raise SystemExit(
                    f"No unspent UTXO at {txid}:{index} for {receive_addr}.\n"
                    "  Already spent, wrong prev-tx-id/index, or address mismatch."
                )
            fetched_utxos = True
            row["block_daa_score"] = int(getattr(utxo_ref, "block_daa_score", 0) or 0)
            row["is_coinbase"] = bool(getattr(utxo_ref, "is_coinbase", False))
            cid = getattr(utxo_ref, "covenant_id", None)
            if cid is not None:
                row["covenant_id"] = str(cid)
        elif client and not receive_addr:
            print(
                "Warning: input has no receive_address — using JSON UTXO fields; "
                "storage mass may be wrong. Rebuild QR with --receive-address.",
                file=sys.stderr,
            )

        inputs.append(build_transaction_input(row, tx_version))

    outputs = [
        build_transaction_output(out, default_receive) for out in ready.get("outputs") or []
    ]

    sub_hex = ready.get("subnetwork_id_hex", "0" * 40)
    if str(sub_hex).startswith("0x"):
        sub_hex = str(sub_hex)[2:]
    subnetwork_id = bytes.fromhex(sub_hex)
    payload_hex = ready.get("payload_hex", "") or ""
    if str(payload_hex).startswith("0x"):
        payload_hex = str(payload_hex)[2:]
    payload = bytes.fromhex(payload_hex) if payload_hex else b""

    lock_time = int(ready.get("lock_time", 0))
    if lock_time > 1_000_000_000_000:
        print(
            f"Warning: lock_time={lock_time} looks like a test vector; forcing lock_time=0 for mainnet send",
            file=sys.stderr,
        )
        lock_time = 0

    network = NetworkId("mainnet")
    from kaspa import Transaction

    signed_tx = Transaction(
        tx_version,
        inputs,
        outputs,
        lock_time,
        subnetwork_id,
        int(ready.get("gas", 0)),
        payload,
        0,
    )
    if not update_transaction_mass(network, signed_tx):
        raise SystemExit("Transaction mass exceeds standard limits — rebuild with fewer outputs or larger amounts.")

    mass = signed_tx.mass
    storage_mass = check_storage_mass(ready)
    if storage_mass is not None:
        print(f"KIP-9 storage mass (values only): {storage_mass} (limit {STORAGE_MASS_LIMIT})", file=sys.stderr)
        if storage_mass > STORAGE_MASS_LIMIT:
            raise SystemExit(
                f"Storage mass {storage_mass} exceeds limit {STORAGE_MASS_LIMIT}."
                + storage_mass_hint(ready, storage_mass)
            )

    try:
        calc_mass = calculate_transaction_mass(network, signed_tx)
        min_fee = None
        try:
            from kaspa import calculate_transaction_fee

            min_fee = calculate_transaction_fee(network, signed_tx)
        except Exception:
            pass
        print(f"Transaction mass: {calc_mass} (limit {STORAGE_MASS_LIMIT})", file=sys.stderr)
        if min_fee is not None:
            print(f"Minimum relay fee: {min_fee} sompi", file=sys.stderr)
            in_total = sum(int(i.get("utxo_amount", 0)) for i in ready.get("inputs") or [])
            out_total = sum(int(o.get("value", 0)) for o in ready.get("outputs") or [])
            implicit = in_total - out_total
            if implicit < min_fee:
                raise SystemExit(
                    f"Implicit fee {implicit} sompi is below network minimum {min_fee} sompi. "
                    "Rebuild unsigned tx with a smaller --send-sompi (leave more as fee)."
                )
        if calc_mass > STORAGE_MASS_LIMIT and (storage_mass is None or storage_mass <= STORAGE_MASS_LIMIT):
            print(
                "Warning: network mass high; ensure receive_address is set for correct UTXO metadata.",
                file=sys.stderr,
            )
        mass = calc_mass
        signed_tx.mass = mass
    except SystemExit:
        raise
    except Exception as e:
        print(f"Warning: could not calculate network mass ({e}); using mass={mass}", file=sys.stderr)

    return (signed_tx, fetched_utxos)


async def broadcast_async(ready_path: str, dry_run: bool, check_only: bool) -> int:
    with open(ready_path, encoding="utf-8") as f:
        ready = json.load(f)

    client = None
    need_network = not check_only and not dry_run
    if need_network:
        try:
            from kaspa import Resolver, RpcClient
        except ImportError:
            print("Install the Kaspa Python SDK:\n  pip install kaspa", file=sys.stderr)
            return 1
        print("Connecting to Kaspa mainnet (public resolver)...", file=sys.stderr)
        client = RpcClient(resolver=Resolver())
        await client.connect()

    try:
        tx, fetched_utxos = await ready_to_transaction(ready, client=client)
        if check_only or dry_run:
            print(json.dumps(tx.to_dict(), indent=2))
            if check_only:
                print("Check OK — outputs are standard mainnet P2PK scripts.", file=sys.stderr)
            return 0

        if not fetched_utxos:
            raise SystemExit(
                "Cannot submit: inputs lack receive_address, so UTXO blockDaaScore was not fetched.\n"
                "  Fix A — rebuild unsigned QR with --receive-address and --to-address, sign again, finish.\n"
                "  Fix B — if you already signed: add receive_address to each input in kaspa_tx_ready.json\n"
                "           (your SeedMask Receive kaspa:... address), then run broadcast again."
            )

        result = await client.submit_transaction({"transaction": tx, "allowOrphan": False})
    except Exception as exc:
        msg = str(exc)
        if "checkmultisig" in msg.lower() or "nullfail" in msg.lower():
            raise SystemExit(
                "Broadcast rejected: multisig signatures did not verify.\n"
                f"  Node error: {msg}\n"
                "  Common causes:\n"
                "    • SeedMask firmware not updated — multisig must sighash the P2SH utxo_script, not the redeem script.\n"
                "    • Old signed JSON from before a Coordinator/firmware fix — start a new Send and re-sign every cosigner.\n"
                "    • Wrong cosigner account on device (e.g. both signed with account 0 instead of 0 + 2).\n"
                "    • Duplicate kpub in Coordinator wallet — each cosigner needs its own m/45'/111111'/N' kpub."
            ) from exc
        raise
    finally:
        if client is not None:
            await client.disconnect()

    txid = result.get("transactionId") if isinstance(result, dict) else str(result)
    print(f"Submitted. Transaction ID:\n{txid}")
    print(f"Track on explorer: https://kaspa.stream/transactions/{txid}", file=sys.stderr)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ready_json", help="Merged file from kaspa_send.py finish / kaspa_apply_signatures -o")
    ap.add_argument("--check", action="store_true", help="Validate scripts only (no network submit)")
    ap.add_argument("--dry-run", action="store_true", help="Print transaction JSON only, do not submit")
    args = ap.parse_args()
    return asyncio.run(broadcast_async(args.ready_json, args.dry_run, args.check))


if __name__ == "__main__":
    raise SystemExit(main())
