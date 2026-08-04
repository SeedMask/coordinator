"""BIP48 / BIP45 sorted-multisig address derivation (matches Sparrow / SeedMask)."""

from __future__ import annotations

import re

from embit import script
from embit.bip32 import HDKey
from embit.networks import NETWORKS

from .kaspa_service import normalize_extended_key
from .wallet_store import WalletConfig

_NETWORK = NETWORKS["main"]


def _leaf_pubkey(xpub: str, chain: int, index: int):
    node = HDKey.from_string(normalize_extended_key(xpub))
    child = node.derive(f"{chain}/{index}")
    return child.key


def multisig_address_at(cfg: WalletConfig, chain: int, index: int) -> str:
    cosigners = list(cfg.multisig_cosigners or [])
    if len(cosigners) < 1:
        raise ValueError("Multisig wallet missing cosigner xpubs")
    required = int(cfg.multisig_m or 0)
    total = int(cfg.multisig_n or len(cosigners))
    if required < 1 or required > total:
        raise ValueError("Invalid multisig quorum")

    pubkeys = [_leaf_pubkey(str(c.get("xpub") or ""), chain, index) for c in cosigners]
    pubkeys.sort(key=lambda key: key.sec())
    redeem = script.multisig(required, pubkeys)

    script_type = (cfg.script_type or "").strip().lower()
    if script_type == "nested_segwit":
        return script.p2sh(script.p2wsh(redeem)).address(network=_NETWORK)
    if script_type == "legacy":
        return script.p2sh(redeem).address(network=_NETWORK)
    return script.p2wsh(redeem).address(network=_NETWORK)


def multisig_cache_token(cfg: WalletConfig) -> str:
    xpubs = sorted(str(c.get("xpub") or "").strip() for c in (cfg.multisig_cosigners or []) if c.get("xpub"))
    return "|".join(xpubs)


def multisig_redeem_script(cfg: WalletConfig, chain: int, index: int):
    cosigners = list(cfg.multisig_cosigners or [])
    required = int(cfg.multisig_m or 0)
    pubkeys = [_leaf_pubkey(str(c.get("xpub") or ""), chain, index) for c in cosigners]
    pubkeys.sort(key=lambda key: key.sec())
    return script.multisig(required, pubkeys)


def _cosigner_fingerprint_bytes(cosigner: dict) -> bytes:
    fp = re.sub(r"[^0-9a-fA-F]", "", str(cosigner.get("fingerprint") or ""))
    if len(fp) == 8:
        return bytes.fromhex(fp)
    return bytes(4)


def _cosigner_account_path(cosigner: dict, cfg: WalletConfig) -> list[int]:
    deriv = str(cosigner.get("derivation") or cfg.derivation or "m/48'/0'/0'/2'").strip()
    parts = deriv.split("/")
    nums: list[int] = []
    for part in parts[1:]:
        hardened = part.endswith("'")
        num = int(part.rstrip("'"))
        nums.append(num | 0x80000000 if hardened else num)
    return nums


def multisig_is_enabled(cfg: WalletConfig) -> bool:
    return (cfg.policy_type or "").strip() == "multisig" or bool(cfg.multisig_cosigners)
