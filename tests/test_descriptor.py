"""Descriptor wallet parsing and Sparrow export."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "coordinator"))

from app.descriptor_wallet import (
    descsum_check,
    export_descriptor,
    parse_descriptor,
    strip_descriptor_checksum,
)
from app.wallet_store import WalletConfig

_XPUB = (
    "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3r"
    "APshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V"
)
_MSIG1 = (
    "xpub6ECz9BakuWe6tFn4t9J6eoABFuqZpNqPh6k8QqdwVwRAyod522kqftqVinewEooe37Zi2zufKj8U5gj5GVVo89W6JTaHq4tfqCQchmZ4gUv"
)
_MSIG2 = (
    "xpub6ErSoxTFmHrRNWtGa5hxFpgg3p8XUrF2oyeCwN9K2UHejcPYXDeXyaujpt9GGWtFiUURGprnarErYWCc8suruQTHLuqXGSKLk2gxeaq1dky"
)


def test_wpkh_descriptor():
    cfg = parse_descriptor(f"wpkh({_XPUB}/*)")
    assert cfg.coin == "bitcoin"
    assert cfg.policy_type == "singlesig"
    assert cfg.script_type == "native_segwit"


def test_sparrow_multipath_import():
    desc = (
        "wpkh([f02a9002/84h/0h/0h]xpub6Cj1BEonjzyt4fc3BXhpJDLmSqSUhbqHec7THNY7NZVMba52TwxM9ipkyEJqcntopeMzEFb2XjSKEcFYhjTreVm3BajsTKAv26EDrWbcsUa/<0;1>/*)"
        "#nqx2j6w4"
    )
    cfg = parse_descriptor(desc)
    assert cfg.fingerprint == "f02a9002"
    assert cfg.derivation == "m/84'/0'/0'"
    assert cfg.policy_type == "singlesig"


def test_multisig_sparrow_import():
    desc = (
        "wsh(sortedmulti(2,"
        f"[ee298649/48h/0h/0h/2h]{_MSIG1}/<0;1>/*,"
        f"[87478387/48h/0h/0h/2h]{_MSIG2}/<0;1>/*"
        "))#zz39umn5"
    )
    cfg = parse_descriptor(desc)
    assert cfg.policy_type == "multisig"
    assert cfg.multisig_m == 2
    assert cfg.multisig_n == 2
    assert len(cfg.multisig_cosigners or []) == 2
    assert cfg.multisig_cosigners[0]["fingerprint"] == "ee298649"
    assert cfg.multisig_cosigners[0]["derivation"] == "m/48'/0'/0'/2'"


_ZPUB = (
    "zpub6rPXna9d3N4qmFzGrFH4iPXmnmjNaqpHUq9trAKt8aF7hmhUyGHUPr931eE1ccCedvbbjCn9T49R1BUg98HtEy8EvG8id8otZYMWdf4c6S2"
)


def test_sparrow_zpub_checksum_matches_core():
    desc = (
        f"wpkh([f02a9002/84h/0h/0h]{_ZPUB}/<0;1>/*)#0syam0yw"
    )
    assert descsum_check(desc)
    cfg = parse_descriptor(desc)
    out = export_descriptor(cfg)
    assert out.endswith("#0syam0yw")
    assert descsum_check(out)


def test_export_singlesig_has_origin_multipath_checksum():
    cfg = WalletConfig(
        id="w1",
        label="Test",
        kpub=_XPUB,
        account=0,
        coin="bitcoin",
        derivation="m/84'/0'/0'",
        fingerprint="f02a9002",
        script_type="native_segwit",
        policy_type="singlesig",
    )
    out = export_descriptor(cfg)
    assert out.startswith("wpkh([f02a9002/84h/0h/0h]")
    assert "/<0;1>/*)#" in out
    assert len(out.rsplit("#", 1)[-1]) == 8


def test_export_multisig_uses_multipath_not_script_child():
    cfg = WalletConfig(
        id="w2",
        label="MS",
        kpub=_MSIG1,
        account=0,
        coin="bitcoin",
        derivation="m/48'/0'/0'/2'",
        fingerprint="ee298649",
        script_type="native_segwit",
        policy_type="multisig",
        multisig_m=2,
        multisig_n=2,
        multisig_cosigners=[
            {
                "xpub": _MSIG1,
                "fingerprint": "ee298649",
                "derivation": "m/48'/0'/0'/2'",
            },
            {
                "xpub": _MSIG2,
                "fingerprint": "87478387",
                "derivation": "m/48'/0'/0'/2'",
            },
        ],
    )
    out = export_descriptor(cfg)
    assert "sortedmulti(2," in out
    assert "/<0;1>/*" in out
    assert "/2/*" not in out
    assert "[ee298649/48h/0h/0h/2h]" in out
    assert "#" in out


def test_strip_checksum():
    raw = f"wpkh({_XPUB}/*)#qpzry9x8"
    assert "#" not in strip_descriptor_checksum(raw)
