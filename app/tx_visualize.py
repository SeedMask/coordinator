"""Normalize draft transactions for the Review & Sign visualizer (Kaspa + Bitcoin)."""

from __future__ import annotations

from typing import Any

import httpx

from .kaspa_service import SOMPI_PER_KAS, WalletUtxo
from kaspa_coordinator_qr import normalize_kaspa_address
from .wallet_store import WalletConfig

SOMPI_PER_COIN = 100_000_000
STORAGE_MASS_LIMIT = 100_000
_RBF_SEQUENCE_MAX = 0xFFFFFFFD
_tip_height_cache: tuple[int, float] = (0, 0.0)


def _btc_rbf_enabled(tx: dict) -> bool:
    """True when any non-coinbase input signals BIP125 (nSequence ≤ 0xFFFFFFFD)."""
    # Check both Esplora `vin` and blockchain.info `inputs` — never prefer an empty
    # normalized vin that dropped sequence over the original payload.
    seen: list[dict] = []
    for key in ("vin", "inputs"):
        rows = tx.get(key)
        if isinstance(rows, list):
            seen.extend(r for r in rows if isinstance(r, dict))
    for inp in seen:
        if inp.get("is_coinbase"):
            continue
        seq = inp.get("sequence")
        if seq is None:
            continue
        try:
            if int(seq) <= _RBF_SEQUENCE_MAX:
                return True
        except (TypeError, ValueError):
            continue
    return False


def _btc_block_height(tx: dict) -> int:
    status = tx.get("status") if isinstance(tx.get("status"), dict) else {}
    for raw in (
        status.get("block_height"),
        tx.get("block_height"),
        tx.get("block_index"),
    ):
        try:
            h = int(raw)
        except (TypeError, ValueError):
            continue
        if h > 0:
            return h
    return 0


async def _btc_confirmations_from_chain(tx: dict) -> int | None:
    """Real confirmation depth: tip_height − block_height + 1. None if unknown."""
    import asyncio

    height = _btc_block_height(tx)
    if height <= 0:
        return None
    tip = 0
    try:
        tip = int(await asyncio.wait_for(_btc_chain_tip_height(), timeout=5.0) or 0)
    except Exception:
        tip = 0
    if tip < height:
        return None
    return max(1, tip - height + 1)


def _format_unix_timestamp(block_time: int) -> str:
    from .transaction_history import _block_time_seconds

    bt = _block_time_seconds(int(block_time or 0))
    if bt <= 0:
        return ""
    from datetime import datetime, timezone

    try:
        return datetime.fromtimestamp(bt, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    except (OSError, OverflowError, ValueError):
        return ""


def _normalized_block_time(tx: dict, *, coin: str) -> int:
    from .transaction_history import _block_time_seconds

    if coin == "bitcoin":
        status = tx.get("status") or {}
        raw = int(status.get("block_time") or tx.get("blocktime") or tx.get("time") or 0)
    else:
        raw = int(tx.get("block_time") or tx.get("accepting_block_time") or 0)
    return _block_time_seconds(raw)


async def _btc_chain_tip_height() -> int:
    import time

    import certifi

    from .network_settings import allows_cross_provider_fallbacks
    from .transaction_history import _btc_esplora_bases

    global _tip_height_cache
    height, cached_at = _tip_height_cache
    if height > 0 and time.monotonic() - cached_at < 90:
        return height

    headers = {"User-Agent": "SeedMask-Coordinator/1.0"}
    tip_urls: list[str] = []
    for base in _btc_esplora_bases():
        url = f"{base.rstrip('/')}/blocks/tip/height"
        if url not in tip_urls:
            tip_urls.append(url)
    # Recommended may use extra tip sources; exclusive presets stay on configured only.
    if allows_cross_provider_fallbacks():
        for extra in (
            "https://blockstream.info/api/blocks/tip/height",
            "https://blockchain.info/q/getblockcount",
        ):
            if extra not in tip_urls:
                tip_urls.append(extra)
    for url in tip_urls:
        connect_s = 1.5 if "mempool.space" in url and allows_cross_provider_fallbacks() else 3.0
        read_s = 2.5 if "mempool.space" in url and allows_cross_provider_fallbacks() else 6.0
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(read_s, connect=connect_s),
                verify=certifi.where(),
                headers=headers,
                follow_redirects=True,
            ) as client:
                resp = await client.get(url)
                if resp.status_code != 200:
                    continue
                h = int(resp.text.strip())
                if h > 0:
                    _tip_height_cache = (h, time.monotonic())
                    return h
        except Exception:
            continue
    return height


def _confirmed_addr_subtitle(address: str) -> str | None:
    trimmed = (address or "").strip()
    return trimmed or None


def _short_address(address: str, *, coin: str) -> str:
    trimmed = (address or "").strip()
    if not trimmed:
        return ""
    if len(trimmed) <= 18:
        return trimmed
    prefix_len = 8 if coin == "bitcoin" else 12
    return f"{trimmed[:prefix_len]}…{trimmed[-8:]}"


def _short_txid(txid: str) -> str:
    t = (txid or "").strip().lower().replace("0x", "")
    if len(t) <= 16:
        return t
    return f"{t[:8]}…{t[-8:]}"


def _norm_txid(txid: str) -> str:
    return (txid or "").strip().lower().replace("0x", "")


def _script_pubkey_to_address(script_pubkey: Any) -> str:
    from embit.script import Script

    if script_pubkey is None:
        return ""
    try:
        if hasattr(script_pubkey, "data"):
            spk = script_pubkey
        else:
            spk = Script(bytes(script_pubkey))
        return str(spk.address())
    except Exception:
        return ""


def _kaspa_draft_tx_id(unsigned: dict[str, Any]) -> str | None:
    try:
        from kaspa_mass import unsigned_v2_to_transaction

        tx = unsigned_v2_to_transaction(unsigned)
        txid = str(getattr(tx, "id", "") or "").strip()
        return _norm_txid(txid) or None
    except Exception:
        return None


def _bitcoin_draft_tx_id(psbt: Any) -> str | None:
    try:
        return _norm_txid(psbt.tx.txid().hex())
    except Exception:
        return None


def _input_label(*, is_change: bool, address_index: int) -> str:
    if is_change:
        return f"Change #{address_index}"
    return f"Receive #{address_index}"


def _metadata_row(
    label: str,
    value: str,
    *,
    detail: str | None = None,
    is_warning: bool = False,
) -> dict[str, Any]:
    row: dict[str, Any] = {"label": label, "value": value}
    if detail:
        row["detail"] = detail
    if is_warning:
        row["is_warning"] = True
    return row


def _visual_warning(severity: str, message: str) -> dict[str, str]:
    return {"severity": severity, "message": message}


def _is_high_fee(
    fee: int,
    send: int,
    *,
    coin: str,
    feerate: float | None = None,
    min_relay: int | None = None,
) -> bool:
    return _high_fee_reason(fee, send, coin=coin, feerate=feerate, min_relay=min_relay) is not None


def _high_fee_reason(
    fee: int,
    send: int,
    *,
    coin: str,
    feerate: float | None = None,
    min_relay: int | None = None,
) -> str | None:
    if fee <= 0:
        return None
    if coin == "kaspa":
        # Post-Toccata: minimum is ~100 sompi/gram (~0.002 KAS for a simple P2PK).
        # Do not treat normal relay fees (~200k sompi) as "high".
        try:
            from kaspa_toccata import TYPICAL_P2PK_RELAY_SOMPI
        except ImportError:
            TYPICAL_P2PK_RELAY_SOMPI = 203_600
        relay = int(min_relay) if min_relay and int(min_relay) > 0 else int(TYPICAL_P2PK_RELAY_SOMPI)
        if fee >= relay * 10:
            return "This fee is much higher than the network minimum for a transaction of this size."
        if send > 0 and fee / send >= 0.05:
            pct = (fee / send) * 100
            return f"Fee is {pct:.1f}% of the send amount."
        # Toccata minimum feerate is 100 sompi/gram; warn only well above that.
        if feerate is not None and feerate >= 500:
            return "This fee rate is much higher than the usual network minimum."
        return None
    relay = 141
    if fee >= relay * 20:
        return f"Network fee is unusually high ({fee:,} sats)"
    if send > 0 and fee / send >= 0.05:
        pct = (fee / send) * 100
        return f"Fee is {pct:.1f}% of the send amount"
    if feerate is not None and feerate >= 100:
        return f"Feerate is high ({feerate:.1f} sat/vB)"
    return None


def _warning_key(message: str) -> str:
    return " ".join((message or "").lower().split())


def _dedupe_warnings(warnings: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for warning in warnings:
        key = _warning_key(warning.get("message", ""))
        if not key or key in seen:
            continue
        if any(key in other or other in key for other in seen):
            continue
        seen.add(key)
        out.append(warning)
    return out


def _kaspa_fee_breakdown(
    *,
    unsigned: dict[str, Any],
    summary: dict[str, Any] | None,
    input_total: int,
    explicit_out_total: int,
) -> tuple[int, int]:
    """Return (network_fee_sompi, excess_to_miner_sompi) for diagram display."""
    from .kaspa_generator import _kaspa_display_fees

    implicit = max(0, input_total - explicit_out_total)
    if summary:
        network = int(summary.get("network_fee_sompi") or summary.get("fee_sompi") or 0)
        excess = int(summary.get("excess_to_miner_sompi") or 0)
        if network > 0:
            if excess <= 0 and implicit > network:
                excess = max(0, implicit - network)
            return network, excess

    mass = None
    try:
        from kaspa_mass import analyze_unsigned

        rep = analyze_unsigned(unsigned)
        mass = rep.transaction_mass
    except Exception:
        mass = None

    fields = _kaspa_display_fees(implicit_sompi=implicit, unsigned=unsigned, mass=int(mass or 0))
    return int(fields["fee_sompi"]), int(fields["excess_to_miner_sompi"])


def _kaspa_mass_details(unsigned: dict[str, Any], *, fee_sompi: int) -> tuple[list[dict[str, Any]], list[dict[str, str]], float | None]:
    metadata: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []
    feerate: float | None = None
    try:
        from kaspa_mass import analyze_unsigned

        rep = analyze_unsigned(unsigned)
    except Exception:
        return metadata, warnings, feerate

    if rep.storage_mass is not None:
        sm_warn = rep.storage_mass > STORAGE_MASS_LIMIT
        metadata.append(
            _metadata_row(
                "KIP-9 storage mass",
                f"{rep.storage_mass:,}",
                detail=f"limit {STORAGE_MASS_LIMIT:,}",
                is_warning=sm_warn,
            )
        )
        if sm_warn:
            warnings.append(
                _visual_warning(
                    "danger",
                    f"KIP-9 storage mass {rep.storage_mass:,} exceeds limit {STORAGE_MASS_LIMIT:,}",
                )
            )

    if rep.transaction_mass is not None:
        tm_warn = rep.transaction_mass > STORAGE_MASS_LIMIT or not rep.within_limits
        metadata.append(
            _metadata_row(
                "Transaction mass",
                f"{rep.transaction_mass:,} grams",
                is_warning=tm_warn,
            )
        )

    if rep.minimum_relay_fee is not None:
        min_relay = int(rep.minimum_relay_fee)
        below_min = (
            rep.implicit_fee is not None
            and rep.implicit_fee < min_relay
        )
        kas_relay = min_relay / SOMPI_PER_COIN
        metadata.append(
            _metadata_row(
                "Minimum relay fee",
                f"{min_relay:,} sompi ({kas_relay:.8f} KAS)",
                is_warning=below_min,
            )
        )
        if below_min and rep.implicit_fee is not None:
            warnings.append(
                _visual_warning(
                    "danger",
                    f"Network fee {rep.implicit_fee:,} sompi is below the estimated minimum "
                    f"{min_relay:,} sompi",
                )
            )

    if rep.transaction_mass and fee_sompi > 0:
        feerate = fee_sompi / rep.transaction_mass
        metadata.append(_metadata_row("Feerate", f"{feerate:.2f} sompi/gram"))

    for note in rep.notes:
        if note.startswith("mass/fee calc failed"):
            continue
        if "implicit fee" in note.lower() and "below network minimum" in note.lower():
            continue
        note_key = _warning_key(note)
        if any(_warning_key(w["message"]) == note_key for w in warnings):
            continue
        severity = "danger" if any(k in note.lower() for k in ("exceeds", "below")) else "warning"
        warnings.append(_visual_warning(severity, note))

    return metadata, _dedupe_warnings(warnings), feerate


def _bitcoin_psbt_details(
    psbt: Any,
    *,
    fee_sompi: int,
    cfg: WalletConfig | None,
) -> tuple[list[dict[str, Any]], list[dict[str, str]], float | None]:
    from .bitcoin_fees import estimate_vbytes
    from .btc_multisig import multisig_is_enabled

    metadata: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []
    input_count = sum(1 for inp in psbt.inputs if inp.utxo is not None)
    output_count = len(psbt.outputs)
    multisig = multisig_is_enabled(cfg) if cfg else False
    vbytes = estimate_vbytes(
        input_count=max(1, input_count),
        output_count=max(1, output_count),
        multisig=multisig,
    )
    feerate = float(fee_sompi) / vbytes if vbytes > 0 and fee_sompi > 0 else None

    metadata.append(_metadata_row("Virtual size", f"{vbytes} vB"))
    if feerate is not None:
        metadata.append(
            _metadata_row(
                "Feerate",
                f"{feerate:.1f} sat/vB",
                is_warning=feerate >= 100,
            )
        )
        if feerate >= 100:
            warnings.append(_visual_warning("warning", f"Feerate is high ({feerate:.1f} sat/vB)"))

    rbf = any(int(getattr(inp, "sequence", 0xFFFFFFFF)) <= _RBF_SEQUENCE_MAX for inp in psbt.inputs)
    metadata.append(_metadata_row("RBF", "Enabled" if rbf else "Final (no RBF)"))

    return metadata, warnings, feerate


def _coin_unit(coin: str) -> str:
    return "BTC" if coin == "bitcoin" else "KAS"


def _visual_row(
    *,
    row_id: str,
    label: str,
    amount_sompi: int,
    coin: str,
    subtitle: str | None = None,
    address: str | None = None,
    kind: str | None = None,
    is_warning: bool = False,
) -> dict[str, Any]:
    unit = _coin_unit(coin)
    amount = amount_sompi / SOMPI_PER_COIN
    row: dict[str, Any] = {
        "id": row_id,
        "label": label,
        "amount_sompi": int(amount_sompi),
        "amount": amount,
        "amount_kas": amount if coin == "kaspa" else None,
        "amount_btc": amount if coin == "bitcoin" else None,
    }
    if subtitle:
        row["subtitle"] = subtitle
    if address:
        row["address"] = address
    if kind:
        row["kind"] = kind
    if is_warning:
        row["is_warning"] = True
    row["unit"] = unit
    return row


def _summary_address(address: str, *, coin: str) -> str:
    return (address or "").strip()


def _short_block_hash(block_hash: str) -> str:
    trimmed = (block_hash or "").strip()
    if len(trimmed) <= 22:
        return trimmed
    return f"{trimmed[:10]}…{trimmed[-10:]}"


def _confirmed_summary_lines(
    *,
    coin: str,
    input_total: int,
    fee: int,
    change: int,
    wallet_input_sompi: int,
    external_send_sompi: int,
    external_recipient: str,
    wallet_receive_sompi: int,
    wallet_receive_labels: list[str],
) -> tuple[str, str, str]:
    unit = _coin_unit(coin)
    fee_f = fee / SOMPI_PER_COIN
    in_f = input_total / SOMPI_PER_COIN
    fee_line = f"Network fee {fee_f:.8f} {unit}"
    change_part = f"  +  change {change / SOMPI_PER_COIN:.8f}" if change > 0 else ""

    # Incoming: external coins paid to our receive/change addresses (no wallet inputs spent).
    if wallet_receive_sompi > 0 and wallet_input_sompi == 0:
        recv_f = wallet_receive_sompi / SOMPI_PER_COIN
        dest = ", ".join(wallet_receive_labels) if wallet_receive_labels else "your wallet"
        summary = f"Received {recv_f:.8f} {unit} to {dest}"
        balance = (
            f"Coins in {in_f:.8f} {unit}  =  received {recv_f:.8f}  +  fee {fee_f:.8f}{change_part}"
        )
    elif wallet_input_sompi > 0:
        send_sompi = external_send_sompi if external_send_sompi > 0 else max(
            0, wallet_input_sompi - fee - change
        )
        send_f = send_sompi / SOMPI_PER_COIN
        dest = _summary_address(external_recipient, coin=coin)
        if not dest and wallet_receive_labels:
            dest = ", ".join(wallet_receive_labels)
        summary = (
            f"Sent {send_f:.8f} {unit} to {dest}" if dest else f"Sent {send_f:.8f} {unit}"
        )
        balance = (
            f"Coins in {in_f:.8f} {unit}  =  recipient {send_f:.8f}  +  fee {fee_f:.8f}{change_part}"
        )
    elif wallet_receive_sompi > 0:
        recv_f = wallet_receive_sompi / SOMPI_PER_COIN
        dest = ", ".join(wallet_receive_labels) if wallet_receive_labels else "your wallet"
        summary = f"Received {recv_f:.8f} {unit} to {dest}"
        balance = (
            f"Coins in {in_f:.8f} {unit}  =  received {recv_f:.8f}  +  fee {fee_f:.8f}{change_part}"
        )
    elif external_send_sompi > 0:
        send_f = external_send_sompi / SOMPI_PER_COIN
        dest = _summary_address(external_recipient, coin=coin)
        summary = (
            f"Sent {send_f:.8f} {unit} to {dest}" if dest else f"Sent {send_f:.8f} {unit}"
        )
        balance = (
            f"Coins in {in_f:.8f} {unit}  =  recipient {send_f:.8f}  +  fee {fee_f:.8f}{change_part}"
        )
    else:
        summary = f"Transaction {in_f:.8f} {unit}"
        balance = f"Coins in {in_f:.8f} {unit}  =  fee {fee_f:.8f}{change_part}"

    return summary, fee_line, balance


def _balance_lines(
    *,
    coin: str,
    input_total: int,
    send: int,
    fee: int,
    change: int,
    recipient: str,
) -> tuple[str, str, str]:
    unit = _coin_unit(coin)
    send_f = send / SOMPI_PER_COIN
    fee_f = fee / SOMPI_PER_COIN
    in_f = input_total / SOMPI_PER_COIN
    recipient_label = _summary_address(recipient, coin=coin)
    if recipient_label:
        summary = f"Send {send_f:.8f} {unit} to {recipient_label}"
    else:
        summary = f"Send {send_f:.8f} {unit}"
    fee_line = f"Network fee {fee_f:.8f} {unit}"
    change_part = f"  +  change {change / SOMPI_PER_COIN:.8f}" if change > 0 else ""
    balance = (
        f"Coins in {in_f:.8f} {unit}  =  recipient {send_f:.8f}  +  fee {fee_f:.8f}{change_part}"
    )
    return summary, fee_line, balance


def visualize_kaspa_unsigned(
    unsigned: dict[str, Any],
    *,
    pskt_hex: str | None,
    summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    coin = "kaspa"
    unit = _coin_unit(coin)
    inputs_raw = unsigned.get("inputs") or []
    outputs_raw = unsigned.get("outputs") or []

    inputs: list[dict[str, Any]] = []
    input_total = 0
    for idx, inp in enumerate(inputs_raw):
        if not isinstance(inp, dict):
            continue
        amount = int(inp.get("utxo_amount") or inp.get("amount") or 0)
        input_total += amount
        chain = int(inp.get("sign_chain") or 0)
        addr_index = int(inp.get("sign_address_index") or 0)
        is_change = chain == 1 or bool(inp.get("is_change"))
        txid = str(inp.get("prev_tx_id") or "")
        out_index = int(inp.get("prev_index") or 0)
        addr = str(inp.get("receive_address") or "")
        inputs.append(
            _visual_row(
                row_id=f"{txid}:{out_index}" if txid else f"in-{idx}",
                label=_input_label(is_change=is_change, address_index=addr_index),
                subtitle=f"{_short_txid(txid)}:{out_index}" if txid else None,
                amount_sompi=amount,
                coin=coin,
                address=addr or None,
            )
        )

    explicit_out_total = 0
    recipient_sompi = 0
    change_sompi = 0
    recipient_addr = ""
    change_addr = ""
    diagram_outputs: list[dict[str, Any]] = []

    payee = ""
    if summary:
        payee = str(summary.get("to_address") or "")

    for idx, out in enumerate(outputs_raw):
        if not isinstance(out, dict):
            continue
        amount = int(out.get("value") or out.get("amount") or 0)
        explicit_out_total += amount
        addr = str(out.get("kaspa_address") or out.get("address") or "")
        is_change = bool(out.get("is_change"))
        if payee and addr and normalize_kaspa_address(addr) == normalize_kaspa_address(payee):
            is_change = False

        if is_change:
            change_sompi += amount
            change_addr = addr or change_addr
            diagram_outputs.append(
                _visual_row(
                    row_id=f"out-change-{idx}",
                    label=f"Change #{int(out.get('change_address_index') or 0)}"
                    if out.get("change_address_index") is not None
                    else "Change",
                    subtitle=_confirmed_addr_subtitle(addr),
                    amount_sompi=amount,
                    coin=coin,
                    address=addr or None,
                    kind="change",
                )
            )
        else:
            recipient_sompi += amount
            recipient_addr = addr or recipient_addr
            diagram_outputs.insert(
                0,
                _visual_row(
                    row_id=f"out-pay-{idx}",
                    label="Recipient",
                    subtitle=_confirmed_addr_subtitle(addr),
                    amount_sompi=amount,
                    coin=coin,
                    address=addr or None,
                    kind="recipient",
                ),
            )

    if recipient_sompi <= 0 and summary:
        recipient_sompi = int(summary.get("send_sompi") or 0) or int(
            float(summary.get("send_kas") or 0) * SOMPI_PER_KAS
        )
        recipient_addr = str(summary.get("to_address") or recipient_addr)
        if recipient_sompi > 0 and not any(o.get("kind") == "recipient" for o in diagram_outputs):
            diagram_outputs.insert(
                0,
                _visual_row(
                    row_id="out-recipient",
                    label="Recipient",
                    subtitle=_short_address(recipient_addr, coin=coin) or None,
                    amount_sompi=recipient_sompi,
                    coin=coin,
                    address=recipient_addr or None,
                    kind="recipient",
                ),
            )

    fee_sompi = max(0, input_total - explicit_out_total)
    if fee_sompi <= 0 and summary:
        fee_sompi = int(summary.get("fee_sompi") or 0) + int(summary.get("excess_to_miner_sompi") or 0)

    network_fee_sompi, excess_sompi = _kaspa_fee_breakdown(
        unsigned=unsigned,
        summary=summary,
        input_total=input_total,
        explicit_out_total=explicit_out_total,
    )

    metadata, warnings, feerate = _kaspa_mass_details(unsigned, fee_sompi=network_fee_sompi)
    min_relay: int | None = None
    try:
        from kaspa_mass import analyze_unsigned

        rep = analyze_unsigned(unsigned)
        if rep.minimum_relay_fee is not None and int(rep.minimum_relay_fee) > 0:
            min_relay = int(rep.minimum_relay_fee)
    except Exception:
        min_relay = None
    fee_warning = _is_high_fee(
        network_fee_sompi,
        recipient_sompi,
        coin=coin,
        feerate=feerate,
        min_relay=min_relay,
    )
    if reason := _high_fee_reason(
        network_fee_sompi,
        recipient_sompi,
        coin=coin,
        feerate=feerate,
        min_relay=min_relay,
    ):
        warnings.insert(0, _visual_warning("warning" if not fee_warning else "danger", reason))
    warnings = _dedupe_warnings(warnings)

    if excess_sompi > 0:
        diagram_outputs.append(
            _visual_row(
                row_id="excess",
                label="Excess to miners",
                subtitle="KIP-9 unspendable remainder",
                amount_sompi=excess_sompi,
                coin=coin,
                kind="fee",
                is_warning=True,
            )
        )
        warnings.insert(
            0,
            _visual_warning(
                "warning",
                f"{excess_sompi / SOMPI_PER_COIN:.8f} KAS of leftover coin cannot be returned as change "
                f"and is added to the miner fee (KIP-9).",
            ),
        )
        warnings = _dedupe_warnings(warnings)

    fee_subtitle = "Paid to miners"

    diagram_outputs.append(
        _visual_row(
            row_id="fee",
            label="High fee" if fee_warning else "Network fee",
            subtitle=fee_subtitle,
            amount_sompi=network_fee_sompi,
            coin=coin,
            kind="fee",
            is_warning=fee_warning,
        )
    )

    summary_line, summary_fee_line, balance_line = _balance_lines(
        coin=coin,
        input_total=input_total,
        send=recipient_sompi,
        fee=network_fee_sompi + excess_sompi,
        change=change_sompi,
        recipient=recipient_addr or payee,
    )

    raw_hex = (pskt_hex or "").strip()
    txid = _kaspa_draft_tx_id(unsigned)
    return {
        "coin": coin,
        "unit_symbol": unit,
        "txid": txid,
        "txid_short": _short_txid(txid) if txid else None,
        "inputs": inputs,
        "outputs": diagram_outputs,
        "summary_line": summary_line,
        "summary_fee_line": summary_fee_line,
        "balance_line": balance_line,
        "raw_hex": raw_hex,
        "raw_hex_label": "PSKT hex (unsigned)" if raw_hex else None,
        "raw_hex_format": "hex" if raw_hex else None,
        "input_total_sompi": input_total,
        "fee_sompi": network_fee_sompi,
        "excess_to_miner_sompi": excess_sompi,
        "metadata": metadata,
        "warnings": warnings,
    }


def visualize_bitcoin_psbt(
    psbt_bytes: bytes,
    *,
    summary: dict[str, Any] | None,
    cfg: WalletConfig | None,
) -> dict[str, Any]:
    from embit.psbt import PSBT

    from .bitcoin_psbt import psbt_to_base64
    from .bitcoin_service import _resolve_script_type
    from .btc_multisig import multisig_address_at, multisig_is_enabled

    coin = "bitcoin"
    unit = _coin_unit(coin)
    psbt = PSBT.parse(psbt_bytes)

    inputs: list[dict[str, Any]] = []
    input_total = 0
    for idx, inp in enumerate(psbt.inputs):
        utxo = inp.utxo
        if utxo is None:
            continue
        amount = int(utxo.value or 0)
        input_total += amount
        addr = ""
        chain = 0
        addr_index = 0
        if inp.bip32_derivations:
            pubkey = next(iter(inp.bip32_derivations.keys()))
            path = inp.bip32_derivations[pubkey].derivation
            if len(path) >= 2:
                chain = int(path[-2])
                addr_index = int(path[-1])
        addr = _script_pubkey_to_address(utxo.script_pubkey)
        inputs.append(
            _visual_row(
                row_id=f"in-{idx}",
                label=_input_label(is_change=chain == 1, address_index=addr_index),
                subtitle=_short_address(addr, coin=coin) or None,
                amount_sompi=amount,
                coin=coin,
                address=addr or None,
            )
        )

    payee = str((summary or {}).get("to_address") or "")
    change_addr_expected = str((summary or {}).get("change_address") or "")

    diagram_outputs: list[dict[str, Any]] = []
    explicit_out_total = 0
    recipient_sompi = 0
    change_sompi = 0
    recipient_addr = payee

    for idx, out in enumerate(psbt.outputs):
        amount = int(out.value or 0)
        explicit_out_total += amount
        addr = ""
        addr = _script_pubkey_to_address(out.script_pubkey)
        is_change = False
        if change_addr_expected and addr and addr == change_addr_expected:
            is_change = True
        elif payee and addr and addr == payee:
            is_change = False
        elif len(psbt.outputs) == 2 and idx == 1 and not payee:
            is_change = True
        elif len(psbt.outputs) == 2 and idx == 1 and payee and addr != payee:
            is_change = True
        elif cfg and addr:
            st = _resolve_script_type(cfg)
            try:
                if multisig_is_enabled(cfg):
                    for ci in range(0, 4):
                        if addr == multisig_address_at(cfg, 1, ci):
                            is_change = True
                            break
                        if addr == multisig_address_at(cfg, 0, ci):
                            break
                else:
                    from .bitcoin_psbt import _address_for_pubkey, _pubkey_at

                    for ci in range(0, 6):
                        if addr == _address_for_pubkey(_pubkey_at(cfg, 1, ci), st):
                            is_change = True
                            break
            except Exception:
                pass
        if not is_change and payee and addr == payee:
            is_change = False
        elif not is_change and idx > 0 and len(psbt.outputs) > 1 and payee and addr != payee:
            is_change = True

        if is_change:
            change_sompi += amount
            diagram_outputs.append(
                _visual_row(
                    row_id=f"out-change-{idx}",
                    label=f"Change #{(summary or {}).get('change_address_index') or 0}",
                    subtitle=_confirmed_addr_subtitle(addr),
                    amount_sompi=amount,
                    coin=coin,
                    address=addr or None,
                    kind="change",
                )
            )
        else:
            recipient_sompi += amount
            recipient_addr = addr or recipient_addr
            diagram_outputs.insert(
                0,
                _visual_row(
                    row_id=f"out-pay-{idx}",
                    label="Recipient",
                    subtitle=_confirmed_addr_subtitle(addr),
                    amount_sompi=amount,
                    coin=coin,
                    address=addr or None,
                    kind="recipient",
                ),
            )

    if recipient_sompi <= 0 and summary:
        recipient_sompi = int(summary.get("send_sats") or summary.get("send_sompi") or 0)
        recipient_addr = str(summary.get("to_address") or recipient_addr)

    fee_sompi = max(0, input_total - explicit_out_total)
    if fee_sompi <= 0 and summary:
        fee_sompi = int(summary.get("fee_sats") or summary.get("fee_sompi") or 0)

    metadata, warnings, feerate = _bitcoin_psbt_details(psbt, fee_sompi=fee_sompi, cfg=cfg)
    fee_warning = _is_high_fee(fee_sompi, recipient_sompi, coin=coin)
    if reason := _high_fee_reason(fee_sompi, recipient_sompi, coin=coin, feerate=feerate):
        if not any(w["message"] == reason for w in warnings):
            warnings.insert(0, _visual_warning("warning" if not fee_warning else "danger", reason))

    fee_subtitle = "Paid to miners"
    if feerate is not None:
        fee_subtitle = f"{feerate:.1f} sat/vB · Paid to miners"

    diagram_outputs.append(
        _visual_row(
            row_id="fee",
            label="High fee" if fee_warning else "Network fee",
            subtitle=fee_subtitle,
            amount_sompi=fee_sompi,
            coin=coin,
            kind="fee",
            is_warning=fee_warning,
        )
    )

    summary_line, summary_fee_line, balance_line = _balance_lines(
        coin=coin,
        input_total=input_total,
        send=recipient_sompi,
        fee=fee_sompi,
        change=change_sompi,
        recipient=recipient_addr,
    )

    b64 = psbt_to_base64(psbt_bytes)
    txid = _bitcoin_draft_tx_id(psbt)
    return {
        "coin": coin,
        "unit_symbol": unit,
        "txid": txid,
        "txid_short": _short_txid(txid) if txid else None,
        "inputs": inputs,
        "outputs": diagram_outputs,
        "summary_line": summary_line,
        "summary_fee_line": summary_fee_line,
        "balance_line": balance_line,
        "raw_hex": b64,
        "raw_hex_label": "PSBT (base64, unsigned)",
        "raw_hex_format": "base64",
        "input_total_sompi": input_total,
        "fee_sompi": fee_sompi,
        "metadata": metadata,
        "warnings": warnings,
    }


def visualize_draft(draft_id: str, *, wallet_id: str | None = None) -> dict[str, Any]:
    from .tx_pipeline import (
        _load_draft_raw,
        export_btc_draft,
        is_bitcoin_draft,
        load_draft_envelope,
        pskt_to_hex,
    )
    from .wallet_store import get_wallet

    cfg = get_wallet(wallet_id) if wallet_id else None
    data = _load_draft_raw(draft_id)

    if is_bitcoin_draft(data):
        from .bitcoin_psbt import psbt_from_base64

        exported = export_btc_draft(draft_id)
        summary = exported.get("unsigned") if isinstance(exported.get("unsigned"), dict) else {}
        if not summary and isinstance(data.get("summary"), dict):
            summary = data["summary"]
        raw = psbt_from_base64(str(exported.get("psbt_base64") or ""))
        return visualize_bitcoin_psbt(raw, summary=summary, cfg=cfg)

    pskt, unsigned = load_draft_envelope(draft_id)
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else None
    pskt_hex = None
    if pskt:
        try:
            pskt_hex = pskt_to_hex(pskt)
        except Exception:
            pskt_hex = None
    return visualize_kaspa_unsigned(unsigned, pskt_hex=pskt_hex, summary=summary)


def _btc_addr_label(
    addr: str,
    receive_pairs: list[tuple[int, str]],
    change_pairs: list[tuple[int, str]],
) -> tuple[str, bool]:
    for index, candidate in receive_pairs:
        if candidate == addr:
            return f"Receive #{index}", False
    for index, candidate in change_pairs:
        if candidate == addr:
            return f"Change #{index}", True
    return "Input", False


def _kaspa_addr_label(
    addr: str,
    receive_pairs: list[tuple[int, str]],
    change_pairs: list[tuple[int, str]],
) -> tuple[str, bool]:
    from .transaction_history import _kaspa_addr_key

    key = _kaspa_addr_key(addr)
    for index, candidate in receive_pairs:
        if _kaspa_addr_key(candidate) == key:
            return f"Receive #{index}", False
    for index, candidate in change_pairs:
        if _kaspa_addr_key(candidate) == key:
            return f"Change #{index}", True
    return "External", False


def _btc_addr_in_wallet(addr: str, wallet_addrs: set[str]) -> bool:
    trimmed = (addr or "").strip()
    if not trimmed:
        return False
    if trimmed in wallet_addrs:
        return True
    lower = trimmed.lower()
    return any(candidate.lower() == lower for candidate in wallet_addrs)


def visualize_bitcoin_confirmed(
    tx: dict,
    *,
    receive_pairs: list[tuple[int, str]],
    change_pairs: list[tuple[int, str]],
) -> dict[str, Any]:
    coin = "bitcoin"
    unit = _coin_unit(coin)
    from .transaction_history import _btc_tx_id_from_record

    txid = _btc_tx_id_from_record(tx)
    wallet_addrs = {a for _, a in receive_pairs} | {a for _, a in change_pairs}
    change_addrs = {a for _, a in change_pairs}

    inputs: list[dict[str, Any]] = []
    input_total = 0
    wallet_input_sompi = 0
    for idx, inp in enumerate(tx.get("vin") or tx.get("inputs") or []):
        prev = inp.get("prevout") or inp.get("prev_out") or {}
        amount = int(prev.get("value") or 0)
        addr = str(prev.get("scriptpubkey_address") or prev.get("addr") or "")
        input_total += amount
        in_wallet = _btc_addr_in_wallet(addr, wallet_addrs)
        if in_wallet:
            wallet_input_sompi += amount
        label, _ = _btc_addr_label(addr, receive_pairs, change_pairs) if in_wallet else ("External", False)
        if not in_wallet:
            label = "External"
        inputs.append(
            _visual_row(
                row_id=f"in-{idx}",
                label=label,
                subtitle=_confirmed_addr_subtitle(addr),
                amount_sompi=amount,
                coin=coin,
                address=addr or None,
            )
        )

    diagram_outputs: list[dict[str, Any]] = []
    explicit_out_total = 0
    recipient_sompi = 0
    change_sompi = 0
    recipient_addr = ""
    wallet_receive_sompi = 0
    wallet_receive_labels: list[str] = []

    for idx, out in enumerate(tx.get("vout") or tx.get("out") or []):
        amount = int(out.get("value") or 0)
        explicit_out_total += amount
        addr = str(out.get("scriptpubkey_address") or out.get("addr") or "")
        is_change = _btc_addr_in_wallet(addr, change_addrs)
        in_wallet = _btc_addr_in_wallet(addr, wallet_addrs)
        if is_change:
            change_sompi += amount
            label, _ = _btc_addr_label(addr, receive_pairs, change_pairs)
            diagram_outputs.append(
                _visual_row(
                    row_id=f"out-change-{idx}",
                    label=label,
                    subtitle=_confirmed_addr_subtitle(addr),
                    amount_sompi=amount,
                    coin=coin,
                    address=addr or None,
                    kind="change",
                )
            )
        elif in_wallet:
            label, _ = _btc_addr_label(addr, receive_pairs, change_pairs)
            wallet_receive_sompi += amount
            if label not in wallet_receive_labels:
                wallet_receive_labels.append(label)
            diagram_outputs.append(
                _visual_row(
                    row_id=f"out-wallet-{idx}",
                    label=label,
                    subtitle=_confirmed_addr_subtitle(addr),
                    amount_sompi=amount,
                    coin=coin,
                    address=addr or None,
                    kind="change" if is_change else "recipient",
                )
            )
        else:
            recipient_sompi += amount
            recipient_addr = addr or recipient_addr
            diagram_outputs.insert(
                0,
                _visual_row(
                    row_id=f"out-pay-{idx}",
                    label="Recipient",
                    subtitle=_confirmed_addr_subtitle(addr),
                    amount_sompi=amount,
                    coin=coin,
                    address=addr or None,
                    kind="recipient",
                ),
            )

    fee_sompi = max(0, input_total - explicit_out_total)
    block_time = _normalized_block_time(tx, coin="bitcoin")
    block_height = _btc_block_height(tx)
    metadata: list[dict[str, Any]] = [
        _metadata_row("RBF", "Enabled" if _btc_rbf_enabled(tx) else "Disabled"),
    ]
    if block_height > 0:
        metadata.append(_metadata_row("Block height", f"{block_height:,}"))
    if block_time > 0:
        metadata.append(_metadata_row("Timestamp", _format_unix_timestamp(block_time)))

    diagram_outputs.append(
        _visual_row(
            row_id="fee",
            label="Network fee",
            subtitle="Paid to miners",
            amount_sompi=fee_sompi,
            coin=coin,
            kind="fee",
        )
    )

    summary_line, summary_fee_line, balance_line = _confirmed_summary_lines(
        coin=coin,
        input_total=input_total,
        fee=fee_sompi,
        change=change_sompi,
        wallet_input_sompi=wallet_input_sompi,
        external_send_sompi=recipient_sompi,
        external_recipient=recipient_addr,
        wallet_receive_sompi=wallet_receive_sompi,
        wallet_receive_labels=wallet_receive_labels,
    )

    return {
        "coin": coin,
        "unit_symbol": unit,
        "txid": txid,
        "txid_short": _short_txid(txid) if txid else None,
        "inputs": inputs,
        "outputs": diagram_outputs,
        "summary_line": summary_line,
        "summary_fee_line": summary_fee_line,
        "balance_line": balance_line,
        "metadata": metadata,
        "warnings": [],
        "block_time": block_time if block_time > 0 else None,
    }


def visualize_kaspa_confirmed(
    tx: dict,
    *,
    receive_pairs: list[tuple[int, str]],
    change_pairs: list[tuple[int, str]],
    confirmations: int | None = None,
) -> dict[str, Any]:
    from .transaction_history import _kaspa_addr_key, _kaspa_wallet_addrs

    coin = "kaspa"
    unit = _coin_unit(coin)
    txid = _norm_txid(str(tx.get("transaction_id") or ""))
    wallet_addrs = _kaspa_wallet_addrs(receive_pairs, change_pairs)
    change_keys = _kaspa_wallet_addrs(change_pairs, [])

    inputs: list[dict[str, Any]] = []
    input_total = 0
    wallet_input_sompi = 0
    for idx, inp in enumerate(tx.get("inputs") or []):
        raw_addr = str(inp.get("previous_outpoint_address") or "")
        amount = int(inp.get("previous_outpoint_amount") or 0)
        input_total += amount
        key = _kaspa_addr_key(raw_addr)
        if key in wallet_addrs:
            wallet_input_sompi += amount
            label, _ = _kaspa_addr_label(raw_addr, receive_pairs, change_pairs)
        else:
            label = "External"
        inputs.append(
            _visual_row(
                row_id=f"in-{idx}",
                label=label,
                subtitle=_confirmed_addr_subtitle(raw_addr),
                amount_sompi=amount,
                coin=coin,
                address=raw_addr or None,
            )
        )

    diagram_outputs: list[dict[str, Any]] = []
    explicit_out_total = 0
    recipient_sompi = 0
    change_sompi = 0
    recipient_addr = ""
    wallet_receive_sompi = 0
    wallet_receive_labels: list[str] = []

    for idx, out in enumerate(tx.get("outputs") or []):
        raw_addr = str(out.get("script_public_key_address") or "")
        amount = int(out.get("amount") or 0)
        explicit_out_total += amount
        key = _kaspa_addr_key(raw_addr)
        is_change = key in change_keys
        if key in wallet_addrs and is_change:
            change_sompi += amount
            label, _ = _kaspa_addr_label(raw_addr, receive_pairs, change_pairs)
            diagram_outputs.append(
                _visual_row(
                    row_id=f"out-change-{idx}",
                    label=label,
                    subtitle=_confirmed_addr_subtitle(raw_addr),
                    amount_sompi=amount,
                    coin=coin,
                    address=raw_addr or None,
                    kind="change",
                )
            )
        elif key in wallet_addrs:
            label, _ = _kaspa_addr_label(raw_addr, receive_pairs, change_pairs)
            wallet_receive_sompi += amount
            if label not in wallet_receive_labels:
                wallet_receive_labels.append(label)
            diagram_outputs.append(
                _visual_row(
                    row_id=f"out-wallet-{idx}",
                    label=label,
                    subtitle=_confirmed_addr_subtitle(raw_addr),
                    amount_sompi=amount,
                    coin=coin,
                    address=raw_addr or None,
                    kind="recipient",
                )
            )
        else:
            recipient_sompi += amount
            recipient_addr = raw_addr or recipient_addr
            diagram_outputs.insert(
                0,
                _visual_row(
                    row_id=f"out-pay-{idx}",
                    label="Recipient",
                    subtitle=_confirmed_addr_subtitle(raw_addr),
                    amount_sompi=amount,
                    coin=coin,
                    address=raw_addr or None,
                    kind="recipient",
                ),
            )

    fee_sompi = max(0, input_total - explicit_out_total)
    block_time = _normalized_block_time(tx, coin="kaspa")
    from .transaction_history import _accepting_blue_from_tx

    accepting_blue = _accepting_blue_from_tx(tx)
    metadata: list[dict[str, Any]] = []
    if confirmations is not None:
        metadata.append(_metadata_row("Confirmations", f"{max(0, int(confirmations)):,}"))
    elif accepting_blue > 0 or block_time > 0:
        metadata.append(_metadata_row("Confirmations", "1"))
    else:
        metadata.append(_metadata_row("Confirmations", "0"))
    if block_time > 0:
        metadata.append(_metadata_row("Timestamp", _format_unix_timestamp(block_time)))
    if accepting_blue > 0:
        metadata.append(_metadata_row("Blue score", f"{accepting_blue:,}"))

    diagram_outputs.append(
        _visual_row(
            row_id="fee",
            label="Network fee",
            subtitle="Paid to miners",
            amount_sompi=fee_sompi,
            coin=coin,
            kind="fee",
        )
    )

    summary_line, summary_fee_line, balance_line = _confirmed_summary_lines(
        coin=coin,
        input_total=input_total,
        fee=fee_sompi,
        change=change_sompi,
        wallet_input_sompi=wallet_input_sompi,
        external_send_sompi=recipient_sompi,
        external_recipient=recipient_addr,
        wallet_receive_sompi=wallet_receive_sompi,
        wallet_receive_labels=wallet_receive_labels,
    )

    return {
        "coin": coin,
        "unit_symbol": unit,
        "txid": txid,
        "txid_short": _short_txid(txid) if txid else None,
        "inputs": inputs,
        "outputs": diagram_outputs,
        "summary_line": summary_line,
        "summary_fee_line": summary_fee_line,
        "balance_line": balance_line,
        "metadata": metadata,
        "warnings": [],
        "block_time": block_time if block_time > 0 else None,
        "confirmations": int(confirmations) if confirmations is not None else None,
        "accepting_block_blue_score": accepting_blue if accepting_blue > 0 else None,
    }


async def fetch_kaspa_tx_for_wallet(
    wallet_id: str,
    txid: str,
) -> dict | None:
    from .tx_raw_cache import cached_wallet_tx, kaspa_tx_outpoints_resolved, remember_wallet_txs

    cached = cached_wallet_tx(wallet_id, txid)
    if cached and kaspa_tx_outpoints_resolved(cached):
        return cached

    fetched = await _fetch_confirmed_kaspa_tx(txid)
    if fetched:
        norm = _norm_txid(txid)
        if norm:
            remember_wallet_txs(wallet_id, {norm: fetched})
            try:
                from . import wallet_state

                wallet_state.save_raw_tx(wallet_id, norm, fetched)
            except Exception:
                pass
        return fetched
    return cached


async def _fetch_confirmed_kaspa_tx(txid: str) -> dict | None:
    import urllib.parse

    from .transaction_history import _kaspa_history_base

    norm = _norm_txid(txid)
    if not norm:
        return None
    q = urllib.parse.urlencode({"resolve_previous_outpoints": "light"})
    url = f"{_kaspa_history_base().rstrip('/')}/transactions/{norm}?{q}"
    headers = {"Accept": "application/json", "User-Agent": "SeedMask-Coordinator/1.0"}
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=4.0),
            headers=headers,
            follow_redirects=True,
        ) as client:
            resp = await client.get(url)
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, dict) else None
    except httpx.HTTPError:
        return None


async def _enrich_btc_tx_record(tx: dict, txid: str, *, wallet_id: str | None = None) -> dict:
    """Fill missing block height / time from a full indexer lookup when the wallet cache is partial."""
    from .transaction_history import _btc_tx_id_from_record, fetch_btc_tx_by_id

    status = tx.get("status") or {}
    block_height = status.get("block_height")
    block_time = _normalized_block_time(tx, coin="bitcoin")
    has_io = bool(tx.get("vin") or tx.get("inputs")) and bool(tx.get("vout") or tx.get("out"))
    needs = (
        not has_io
        or block_time <= 0
        or not isinstance(block_height, int)
    )
    if not needs:
        return tx

    record_id = _btc_tx_id_from_record(tx) or _norm_txid(txid)
    if not record_id:
        return tx
    enriched = await fetch_btc_tx_by_id(record_id)
    if enriched and wallet_id:
        from .tx_raw_cache import remember_wallet_txs

        remember_wallet_txs(wallet_id, {record_id: enriched})
    return enriched if enriched else tx


async def visualize_wallet_transaction(
    wallet_id: str,
    txid: str,
    *,
    receive_pairs: list[tuple[int, str]],
    change_pairs: list[tuple[int, str]],
    coin: str,
    cfg: Any | None = None,
    utxos: list[Any] | None = None,
) -> dict[str, Any]:
    coin_key = (coin or "kaspa").strip().lower()
    norm = _norm_txid(txid)
    if not norm:
        raise ValueError("Invalid transaction id")

    if coin_key == "bitcoin":
        from .transaction_history import _bc_info_tx_to_standard, fetch_btc_tx_for_wallet
        from .tx_raw_cache import cached_wallet_tx

        tx = cached_wallet_tx(wallet_id, norm)
        has_io = bool(tx and (tx.get("vin") or tx.get("inputs")) and (tx.get("vout") or tx.get("out")))
        # Cache hit with vin/vout → skip indexer round-trips for diagram; confirmations still use tip.
        if not has_io:
            tx = None
            if cfg is not None:
                tx = await fetch_btc_tx_for_wallet(norm, cfg, receive_pairs, change_pairs, utxos or [])
            if not tx:
                from .transaction_history import fetch_btc_tx_by_id

                tx = await fetch_btc_tx_by_id(norm)
            if not tx:
                raise ValueError("Transaction not found on chain")
            tx = await _enrich_btc_tx_record(tx, norm, wallet_id=wallet_id)
        elif tx and not (tx.get("vin") and tx.get("vout")):
            # blockchain.info multiaddr shape — preserve sequence + block height.
            tx = _bc_info_tx_to_standard(tx)
        elif tx and (tx.get("inputs") or tx.get("block_height") or tx.get("block_index")):
            # Even when vin/vout already present, keep status.block_height / sequence coherent.
            tx = _bc_info_tx_to_standard(tx)
        payload = visualize_bitcoin_confirmed(tx, receive_pairs=receive_pairs, change_pairs=change_pairs)
        block_time = _normalized_block_time(tx, coin="bitcoin")
        # Never trust persisted/stale confirmations — always tip − height + 1.
        conf = await _btc_confirmations_from_chain(tx)
        if conf is not None:
            conf_meta = _metadata_row("Confirmations", f"{conf:,}")
        elif _btc_block_height(tx) > 0 or block_time > 0:
            conf_meta = _metadata_row("Confirmations", "Confirmed")
        else:
            conf_meta = _metadata_row("Confirmations", "0")
        # Put live confirmations + RBF first (RBF already in visualize metadata).
        meta = [m for m in (payload.get("metadata") or []) if (m.get("label") or "") != "Confirmations"]
        payload["metadata"] = [conf_meta, *meta]
        if block_time > 0:
            payload["block_time"] = block_time
        return payload

    tx = await fetch_kaspa_tx_for_wallet(wallet_id, norm)
    if not tx:
        raise ValueError("Transaction not found on chain")

    from .transaction_history import (
        _accepting_blue_from_tx,
        _fetch_kaspa_tx_acceptance,
        _kaspa_confirmations_from_tx,
        _kaspa_virtual_blue_score,
    )

    # Prefer accepting blue already stored on the wallet history row.
    try:
        from . import wallet_state

        for row in wallet_state.get_transactions(wallet_id) or []:
            if not isinstance(row, dict):
                continue
            if _norm_txid(str(row.get("transaction_id") or "")) != norm:
                continue
            if _accepting_blue_from_tx(tx) <= 0:
                blue = _accepting_blue_from_tx(row)
                if blue > 0:
                    tx = {**tx, "accepting_block_blue_score": blue}
            if not tx.get("accepting_block_hash") and (
                row.get("accepting_block_hash") or row.get("acceptingBlockHash")
            ):
                tx = {
                    **tx,
                    "accepting_block_hash": row.get("accepting_block_hash")
                    or row.get("acceptingBlockHash"),
                }
            if _normalized_block_time(tx, coin="kaspa") <= 0:
                try:
                    bt = int(row.get("block_time") or 0)
                except (TypeError, ValueError):
                    bt = 0
                if bt > 0:
                    tx = {**tx, "block_time": bt}
            break
    except Exception:
        pass

    if _accepting_blue_from_tx(tx) <= 0:
        try:
            info = await _fetch_kaspa_tx_acceptance(norm)
            if isinstance(info, dict):
                blue = _accepting_blue_from_tx(info)
                if blue > 0:
                    tx = {**tx, "accepting_block_blue_score": blue}
                if info.get("accepting_block_hash") or info.get("acceptingBlockHash"):
                    tx = {
                        **tx,
                        "accepting_block_hash": info.get("accepting_block_hash")
                        or info.get("acceptingBlockHash"),
                    }
                if info.get("is_accepted") is not None:
                    tx = {**tx, "is_accepted": info.get("is_accepted")}
                api_bt = int(info.get("block_time") or info.get("accepting_block_time") or 0)
                if api_bt > 0 and _normalized_block_time(tx, coin="kaspa") <= 0:
                    tx = {**tx, "block_time": api_bt}
        except Exception:
            pass

    tip_blue = int(await _kaspa_virtual_blue_score(force=False) or 0)
    conf = _kaspa_confirmations_from_tx(tx, tip_blue)
    return visualize_kaspa_confirmed(
        tx,
        receive_pairs=receive_pairs,
        change_pairs=change_pairs,
        confirmations=conf,
    )
