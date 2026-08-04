"""Build, finalize, and broadcast Bitcoin PSBTs for SeedMask (BIP-174 + ur:crypto-psbt)."""

from __future__ import annotations

import base64
from typing import Any

import httpx
from embit import ec, script
from embit.bip32 import HDKey
from embit.finalizer import finalize_psbt
from embit.psbt import PSBT, DerivationPath
from embit.script import address_to_scriptpubkey
from embit.transaction import Transaction, TransactionInput, TransactionOutput

from .btc_multisig import (
    multisig_address_at,
    multisig_is_enabled,
    multisig_redeem_script,
    _cosigner_account_path,
    _cosigner_fingerprint_bytes,
)
from .btc_script import script_type_from_derivation, script_type_from_xpub_prefix
from .bitcoin_service import SATS_PER_BTC, _address_for_pubkey, _resolve_script_type
from .kaspa_service import WalletUtxo, normalize_extended_key
from .kpub_parse import (
    _normalize_xfp,
    is_placeholder_fingerprint,
    resolve_bitcoin_master_fingerprint,
)
from .wallet_store import WalletConfig, effective_wallet_account

BTC_DRAFT_FORMAT = "seedpass_psbt_draft_v1"
_SIGHASH_ALL = 1
_RBF_SEQUENCE = 0xFFFFFFFD
_FINAL_SEQUENCE = 0xFFFFFFFF


def _broadcast_urls() -> tuple[str, ...]:
    from .network_settings import load_network_settings

    urls = load_network_settings().bitcoin.broadcast_urls
    return tuple(urls) if urls else ()


def _master_fingerprint_bytes(cfg: WalletConfig) -> bytes:
    fp = resolve_bitcoin_master_fingerprint(cfg.kpub, cfg.fingerprint)
    return bytes.fromhex(fp)


def _account_derivation_prefix(cfg: WalletConfig) -> list[int]:
    account = effective_wallet_account(cfg)
    purpose = _purpose_for_script(_resolve_script_type(cfg))
    return [
        purpose | 0x80000000,
        0 | 0x80000000,
        account | 0x80000000,
    ]


def _embed_global_xpub(psbt: PSBT, cfg: WalletConfig) -> None:
    """Sparrow/SeedMask expect PSBT_GLOBAL_XPUB with master fingerprint + account path."""
    account_hd = _account_hdkey(cfg)
    fp = _master_fingerprint_bytes(cfg)
    psbt.xpubs[account_hd] = DerivationPath(fp, _account_derivation_prefix(cfg))


def _purpose_for_script(script_type: str) -> int:
    return {
        "legacy": 44,
        "nested_segwit": 49,
        "native_segwit": 84,
        "taproot": 86,
    }.get(script_type, 84)


def _full_derivation_path(cfg: WalletConfig, chain: int, index: int) -> list[int]:
    account = effective_wallet_account(cfg)
    st = _resolve_script_type(cfg)
    purpose = _purpose_for_script(st)
    return [
        purpose | 0x80000000,
        0 | 0x80000000,
        account | 0x80000000,
        chain,
        index,
    ]


def _xonly_pubkey(pubkey) -> ec.PublicKey:
    return ec.PublicKey.from_xonly(pubkey.xonly())


def _set_taproot_key_path(scope, *, pubkey, fingerprint: bytes, path: list[int]) -> None:
    """BIP371 key-path fields for singlesig BIP86 (empty leaf-hash list)."""
    xonly = _xonly_pubkey(pubkey)
    scope.taproot_internal_key = xonly
    scope.taproot_bip32_derivations[xonly] = ([], DerivationPath(fingerprint, path))


def _account_hdkey(cfg: WalletConfig) -> HDKey:
    key = normalize_extended_key(cfg.kpub)
    prefix = key[:4].lower()
    if prefix not in {"xpub", "ypub", "zpub", "tpub", "upub", "vpub"}:
        raise ValueError("Bitcoin watch-only key must be xpub, ypub, or zpub")
    return HDKey.from_string(key)


def _pubkey_at(cfg: WalletConfig, chain: int, index: int):
    account = _account_hdkey(cfg)
    child = account.derive(f"{chain}/{index}")
    return child.key


def _txid_bytes(txid_hex: str) -> bytes:
    raw = bytes.fromhex(txid_hex.strip().lower())
    if len(raw) != 32:
        raise ValueError(f"Invalid txid length: {txid_hex}")
    return raw[::-1]


def _configure_input_scope(
    inp,
    *,
    cfg: WalletConfig,
    utxo: WalletUtxo,
    amount: int,
    script_type: str,
    rbf: bool = False,
) -> None:
    chain = 1 if utxo.is_change else 0
    if multisig_is_enabled(cfg):
        redeem = multisig_redeem_script(cfg, chain, utxo.address_index)
        addr = multisig_address_at(cfg, chain, utxo.address_index)
        spk = address_to_scriptpubkey(addr)
        inp.witness_utxo = TransactionOutput(amount, spk)
        inp.sighash_type = _SIGHASH_ALL
        if script_type == "nested_segwit":
            inp.redeem_script = script.p2wsh(redeem)
        elif script_type == "legacy":
            inp.redeem_script = redeem
        else:
            inp.witness_script = redeem
        for cosigner in cfg.multisig_cosigners or []:
            xpub = str(cosigner.get("xpub") or "").strip()
            if not xpub:
                continue
            node = HDKey.from_string(normalize_extended_key(xpub))
            child = node.derive(f"{chain}/{utxo.address_index}")
            fp = _cosigner_fingerprint_bytes(cosigner)
            prefix = _cosigner_account_path(cosigner, cfg)
            path = prefix + [chain, utxo.address_index]
            inp.bip32_derivations[child.key] = DerivationPath(fp, path)
        return

    pubkey = _pubkey_at(cfg, chain, utxo.address_index)
    spk = address_to_scriptpubkey(utxo.address)
    inp.witness_utxo = TransactionOutput(amount, spk)
    fp = _master_fingerprint_bytes(cfg)
    path = _full_derivation_path(cfg, chain, utxo.address_index)
    if script_type == "taproot":
        # BIP341 key-path: SIGHASH_DEFAULT (omit / 0) — OneKey / Sparrow style.
        _set_taproot_key_path(inp, pubkey=pubkey, fingerprint=fp, path=path)
    else:
        inp.sighash_type = _SIGHASH_ALL
        inp.bip32_derivations[pubkey] = DerivationPath(fp, path)
        if script_type == "nested_segwit":
            inp.redeem_script = script.p2wpkh(pubkey)
        elif script_type == "legacy":
            raise ValueError("Legacy P2PKH inputs are not supported for SeedMask PSBT signing yet.")
    _ = rbf


def _try_tag_wallet_payment_output(
    out,
    *,
    cfg: WalletConfig,
    to_address: str,
    script_type: str,
    max_scan: int = 40,
) -> None:
    """If payee is one of our receive addresses, add BIP32 deriv (Sparrow-style)."""
    try:
        pay_spk = address_to_scriptpubkey(to_address)
    except Exception:
        return
    fp = _master_fingerprint_bytes(cfg)
    for index in range(max_scan):
        for chain in (0, 1):
            pubkey = _pubkey_at(cfg, chain, index)
            addr = _address_for_pubkey(pubkey, script_type)
            if addr != to_address:
                continue
            out.script_pubkey = pay_spk
            path = _full_derivation_path(cfg, chain, index)
            if script_type == "taproot":
                _set_taproot_key_path(out, pubkey=pubkey, fingerprint=fp, path=path)
            else:
                out.bip32_derivations[pubkey] = DerivationPath(fp, path)
            return


def _configure_change_output(out, *, cfg: WalletConfig, change_index: int, amount: int, script_type: str) -> None:
    if multisig_is_enabled(cfg):
        addr = multisig_address_at(cfg, 1, change_index)
        out.script_pubkey = address_to_scriptpubkey(addr)
        for cosigner in cfg.multisig_cosigners or []:
            xpub = str(cosigner.get("xpub") or "").strip()
            if not xpub:
                continue
            node = HDKey.from_string(normalize_extended_key(xpub))
            child = node.derive(f"1/{change_index}")
            fp = _cosigner_fingerprint_bytes(cosigner)
            prefix = _cosigner_account_path(cosigner, cfg)
            out.bip32_derivations[child.key] = DerivationPath(fp, prefix + [1, change_index])
        return

    pubkey = _pubkey_at(cfg, 1, change_index)
    addr = _address_for_pubkey(pubkey, script_type)
    out.script_pubkey = address_to_scriptpubkey(addr)
    fp = _master_fingerprint_bytes(cfg)
    path = _full_derivation_path(cfg, 1, change_index)
    if script_type == "taproot":
        _set_taproot_key_path(out, pubkey=pubkey, fingerprint=fp, path=path)
    else:
        out.bip32_derivations[pubkey] = DerivationPath(fp, path)


def _change_address_for_cfg(cfg: WalletConfig, script_type: str, change_index: int) -> str:
    if multisig_is_enabled(cfg):
        return multisig_address_at(cfg, 1, change_index)
    return _address_for_pubkey(_pubkey_at(cfg, 1, change_index), script_type)


def _summary_dict(
    *,
    send_sats: int,
    fee_sats: int,
    change_sats: int,
    to_address: str,
    from_address: str,
    utxos: list[WalletUtxo],
    rbf: bool,
    change_address: str | None = None,
    change_address_index: int | None = None,
) -> dict[str, Any]:
    used_keys = [f"{u.transaction_id}:{int(u.output_index)}" for u in utxos]
    return {
        "coin": "bitcoin",
        "send_sats": send_sats,
        "send_sompi": send_sats,
        "send_kas": send_sats / SATS_PER_BTC,
        "send_btc": send_sats / SATS_PER_BTC,
        "fee_sats": fee_sats,
        "fee_sompi": fee_sats,
        "fee_kas": fee_sats / SATS_PER_BTC,
        "change_sats": change_sats,
        "change_sompi": change_sats,
        "change_kas": change_sats / SATS_PER_BTC,
        "change_address": change_address,
        "change_address_index": change_address_index,
        "to_address": to_address,
        "from_address": from_address,
        "sign_index": utxos[0].address_index if utxos else 0,
        "input_count": len(utxos),
        "used_utxo_keys": used_keys,
        "input_total_sompi": sum(int(u.amount) for u in utxos),
        "input_total_kas": sum(int(u.amount) for u in utxos) / SATS_PER_BTC,
        "inputs": [
            {
                "prev_tx_id": u.transaction_id,
                "prev_index": int(u.output_index),
                "amount": int(u.amount),
                "utxo_amount": int(u.amount),
            }
            for u in utxos
        ],
        "rbf": rbf,
    }


def _resolve_change_index(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    change_index: int | None,
) -> int:
    if change_index is not None:
        return int(change_index)
    from .address_usage import next_change_index_for_wallet

    return next_change_index_for_wallet(
        cfg.id,
        scan_limit=max(1, int(cfg.scan_limit or 20)),
        utxo_items=utxos,
    )


def build_psbt_for_send(
    cfg: WalletConfig,
    utxo: WalletUtxo,
    to_address: str,
    send_sats: int,
    *,
    fee_sats: int | None = None,
    change_index: int | None = None,
    rbf: bool = False,
) -> tuple[bytes, dict[str, Any]]:
    """Build unsigned PSBT (1 input, payment + optional change). Returns (psbt_bytes, summary)."""
    return build_psbt_multi_input(
        cfg,
        [utxo],
        to_address,
        send_sats,
        fee_sats=fee_sats,
        change_index=change_index,
        rbf=rbf,
    )


def build_psbt_multi_input(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    to_address: str,
    send_sats: int,
    *,
    fee_sats: int | None = None,
    change_index: int | None = None,
    rbf: bool = False,
) -> tuple[bytes, dict[str, Any]]:
    """Build unsigned PSBT with one or more inputs."""
    if not utxos:
        raise ValueError("At least one UTXO required")
    script_type = _resolve_script_type(cfg)
    # taproot: BIP86 key-path PSBTs (OneKey / Sparrow); SeedMask airgap QR may still be limited.
    amount_in = sum(int(u.amount) for u in utxos)
    if send_sats <= 0 or send_sats > amount_in:
        raise ValueError(f"Send amount must be 1..{amount_in} sats")
    if fee_sats is None:
        fee_sats = amount_in - send_sats
    fee_sats = int(fee_sats)
    if fee_sats < 0 or send_sats + fee_sats > amount_in:
        raise ValueError("Fee is taken from selected coins — reduce recipient amount or fee")
    change_sats = amount_in - send_sats - fee_sats
    resolved_change_index = _resolve_change_index(cfg, utxos, change_index) if change_sats > 0 else 0

    seq = _RBF_SEQUENCE if rbf else _FINAL_SEQUENCE
    pay_spk = address_to_scriptpubkey(to_address)
    vins = [
        TransactionInput(_txid_bytes(u.transaction_id), int(u.output_index), b"", seq)
        for u in utxos
    ]
    vouts = [TransactionOutput(send_sats, pay_spk)]
    if change_sats > 0:
        change_addr = _change_address_for_cfg(cfg, script_type, resolved_change_index)
        vouts.append(TransactionOutput(change_sats, address_to_scriptpubkey(change_addr)))

    tx = Transaction(version=2, vin=vins, vout=vouts, locktime=0)
    psbt = PSBT(tx)
    for i, utxo in enumerate(utxos):
        _configure_input_scope(
            psbt.inputs[i],
            cfg=cfg,
            utxo=utxo,
            amount=int(utxo.amount),
            script_type=script_type,
            rbf=rbf,
        )
    if change_sats > 0:
        _configure_change_output(
            psbt.outputs[1],
            cfg=cfg,
            change_index=resolved_change_index,
            amount=change_sats,
            script_type=script_type,
        )
    else:
        _try_tag_wallet_payment_output(psbt.outputs[0], cfg=cfg, to_address=to_address, script_type=script_type)

    if not multisig_is_enabled(cfg):
        _embed_global_xpub(psbt, cfg)
    elif cfg.kpub.strip():
        try:
            _embed_global_xpub(psbt, cfg)
        except Exception:
            pass

    raw = psbt.serialize()
    change_addr: str | None = None
    change_idx: int | None = None
    if change_sats > 0:
        change_addr = _change_address_for_cfg(cfg, script_type, resolved_change_index)
        change_idx = resolved_change_index
    summary = _summary_dict(
        send_sats=send_sats,
        fee_sats=fee_sats,
        change_sats=change_sats,
        to_address=to_address,
        from_address=utxos[0].address,
        utxos=utxos,
        rbf=rbf,
        change_address=change_addr,
        change_address_index=change_idx,
    )
    return raw, summary


def build_psbt_sweep(
    cfg: WalletConfig,
    utxos: list[WalletUtxo],
    to_address: str,
    *,
    fee_sats_per_tx: int,
    change_index: int | None = None,
) -> tuple[list[bytes], list[dict[str, Any]]]:
    """Build one unsigned PSBT per UTXO (sweep all coins to the same payee)."""
    if not utxos:
        raise ValueError("sweep requires at least one UTXO")
    psbts: list[bytes] = []
    summaries: list[dict[str, Any]] = []
    for utxo in utxos:
        send_sats = int(utxo.amount) - int(fee_sats_per_tx)
        if send_sats <= 0:
            raise ValueError(
                f"fee {fee_sats_per_tx} sats exceeds UTXO amount ({utxo.amount} sats) "
                f"at {utxo.address}"
            )
        raw, summary = build_psbt_for_send(
            cfg,
            utxo,
            to_address,
            send_sats,
            fee_sats=fee_sats_per_tx,
            change_index=change_index,
        )
        psbts.append(raw)
        summaries.append(summary)
    return psbts, summaries


def psbt_to_base64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def psbt_from_base64(data: str) -> bytes:
    try:
        raw = base64.b64decode(data.strip(), validate=True)
    except Exception as e:
        raise ValueError("Invalid PSBT base64") from e
    if not raw.startswith(PSBT.MAGIC):
        raise ValueError("Data is not a PSBT (missing psbt\\xff magic)")
    return raw


def signed_psbt_bytes(signed: dict) -> bytes:
    """Extract signed PSBT bytes from coordinator signed payload."""
    if isinstance(signed.get("psbt_base64"), str) and signed["psbt_base64"].strip():
        return psbt_from_base64(signed["psbt_base64"])
    if isinstance(signed.get("psbt_hex"), str) and signed["psbt_hex"].strip():
        raw = bytes.fromhex(signed["psbt_hex"].strip())
        if not raw.startswith(PSBT.MAGIC):
            raise ValueError("Invalid signed PSBT hex")
        return raw
    raise ValueError("Signed payload must include psbt_base64 (from SeedMask QR or .psbt file)")


def finalize_signed_psbt(raw: bytes) -> bytes:
    psbt = PSBT.read_from(raw)
    tx = finalize_psbt(psbt, ignore_missing=False)
    if tx is None:
        raise ValueError("PSBT is not fully signed — scan all signature QR parts on SeedMask")
    return tx.serialize()


async def broadcast_raw_tx(raw_tx: bytes) -> str:
    from . import bitcoin_backend

    if not bitcoin_backend.uses_public_endpoints():
        return await bitcoin_backend.broadcast_raw_tx(raw_tx)
    return await broadcast_raw_tx_public(raw_tx)


async def broadcast_raw_tx_public(raw_tx: bytes) -> str:
    tx_hex = raw_tx.hex()
    last_err = "Broadcast failed"
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=8.0)) as client:
        for url in _broadcast_urls():
            try:
                resp = await client.post(url, content=tx_hex)
                if resp.status_code == 200:
                    txid = resp.text.strip().strip('"')
                    if len(txid) == 64:
                        return txid.lower()
                last_err = resp.text.strip() or f"HTTP {resp.status_code}"
            except httpx.HTTPError as e:
                last_err = str(e)
    raise RuntimeError(f"Bitcoin broadcast failed: {last_err}")


def signed_payload_from_psbt_bytes(raw: bytes) -> dict:
    return {"format": "bitcoin_psbt", "psbt_base64": psbt_to_base64(raw)}


def signed_payload_from_ur_bytes(raw: bytes) -> dict:
    if raw.startswith(PSBT.MAGIC):
        return signed_payload_from_psbt_bytes(raw)
    raise ValueError("Decoded UR is not a PSBT")


_RBF_SEQUENCE_MAX = 0xFFFFFFFD


def _btc_tx_signals_rbf(tx: dict) -> bool:
    for inp in tx.get("vin") or tx.get("inputs") or []:
        if inp.get("is_coinbase"):
            continue
        seq = inp.get("sequence")
        try:
            if seq is not None and int(seq) <= _RBF_SEQUENCE_MAX:
                return True
        except (TypeError, ValueError):
            continue
    return False


def _addr_meta(
    address: str,
    receive_pairs: list[tuple[int, str]],
    change_pairs: list[tuple[int, str]],
) -> tuple[int, bool] | None:
    for idx, addr in receive_pairs:
        if addr == address:
            return int(idx), False
    for idx, addr in change_pairs:
        if addr == address:
            return int(idx), True
    return None


def build_rbf_bump_psbt(
    cfg: WalletConfig,
    original_tx: dict,
    *,
    receive_pairs: list[tuple[int, str]],
    change_pairs: list[tuple[int, str]],
    new_fee_sats: int,
) -> tuple[bytes, dict[str, Any]]:
    """Replace an unconfirmed RBF-signaled tx with the same inputs and a higher fee (BIP125)."""
    if not _btc_tx_signals_rbf(original_tx):
        raise ValueError("This transaction did not opt in to Replace-by-Fee (RBF)")

    vins = original_tx.get("vin") or original_tx.get("inputs") or []
    vouts = original_tx.get("vout") or original_tx.get("out") or []
    if not vins or not vouts:
        raise ValueError("Original transaction is incomplete — refresh and try again")

    wallet_addrs = {a for _, a in receive_pairs} | {a for _, a in change_pairs}
    change_addrs = {a for _, a in change_pairs}

    utxos: list[WalletUtxo] = []
    for inp in vins:
        prev = inp.get("prevout") or inp.get("prev_out") or {}
        addr = str(prev.get("scriptpubkey_address") or prev.get("addr") or "")
        amount = int(prev.get("value") or 0)
        txid = str(inp.get("txid") or "").strip().lower()
        vout = inp.get("vout")
        if vout is None:
            vout = inp.get("n")
        if not addr or amount <= 0 or not txid or vout is None:
            raise ValueError("Cannot rebuild inputs for RBF — missing prevout data")
        if addr not in wallet_addrs:
            raise ValueError("RBF bump requires all inputs to belong to this wallet")
        meta = _addr_meta(addr, receive_pairs, change_pairs)
        if meta is None:
            raise ValueError(f"Unknown wallet address in inputs: {addr}")
        idx, is_change = meta
        utxos.append(
            WalletUtxo(
                address=addr,
                address_index=idx,
                transaction_id=txid,
                output_index=int(vout),
                amount=amount,
                is_change=is_change,
            )
        )

    total_in = sum(int(u.amount) for u in utxos)
    old_out = sum(int(o.get("value") or 0) for o in vouts)
    old_fee = max(0, total_in - old_out)
    target_fee = int(new_fee_sats)
    if target_fee <= old_fee:
        raise ValueError(f"New fee must be higher than the current fee ({old_fee} sats)")
    if target_fee >= total_in:
        raise ValueError("Fee exceeds input value")

    payment_outs: list[tuple[int, str]] = []
    change_outs: list[tuple[int, str]] = []
    for out in vouts:
        addr = str(out.get("scriptpubkey_address") or out.get("addr") or "")
        val = int(out.get("value") or 0)
        if val <= 0 or not addr:
            continue
        if addr in wallet_addrs:
            change_outs.append((val, addr))
        else:
            payment_outs.append((val, addr))

    if not payment_outs and change_outs:
        change_outs.sort(key=lambda x: x[0], reverse=True)
        payment_outs = [change_outs[0]]
        change_outs = change_outs[1:]

    if not payment_outs:
        raise ValueError("Could not identify payment output for RBF bump")

    pay_val, pay_addr = max(payment_outs, key=lambda x: x[0])
    if total_in - target_fee - pay_val < 0:
        pay_val = total_in - target_fee
        if pay_val <= 0:
            raise ValueError("Fee too high for this transaction")

    change_index: int | None = None
    if change_outs:
        # Prefer an explicit change-path address when present.
        change_outs.sort(key=lambda x: (0 if x[1] in change_addrs else 1, -x[0]))
        meta = _addr_meta(change_outs[0][1], receive_pairs, change_pairs)
        if meta:
            change_index = meta[0]

    raw, summary = build_psbt_multi_input(
        cfg,
        utxos,
        pay_addr,
        pay_val,
        fee_sats=target_fee,
        change_index=change_index,
        rbf=True,
    )
    summary["rbf_bump"] = True
    summary["replaces_txid"] = str(
        original_tx.get("txid") or original_tx.get("hash") or ""
    ).lower()
    summary["previous_fee_sats"] = old_fee
    return raw, summary
