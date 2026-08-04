"""Next unused change address selection."""

from __future__ import annotations

from app.address_usage import (
    first_unused_change_index,
    mark_change_index_used,
    next_change_index_for_wallet,
    used_change_indices,
)


def test_first_unused_change_index_gaps():
    assert first_unused_change_index(set(), 20) == 0
    assert first_unused_change_index({0}, 20) == 1
    assert first_unused_change_index({0, 1, 3}, 20) == 2
    assert first_unused_change_index(set(range(20)), 20) == 20


def test_next_change_skips_live_change_utxos(tmp_path, monkeypatch):
    monkeypatch.setattr("app.address_usage.DATA_DIR", tmp_path)
    monkeypatch.setattr("app.address_usage._USAGE_DIR", tmp_path / "address_usage")
    monkeypatch.setattr("app.address_index.DATA_DIR", tmp_path)
    monkeypatch.setattr("app.address_index._INDEX_DIR", tmp_path / "address_index")

    utxos = [
        {"address_index": 0, "is_change": True, "address": "change0"},
        {"address_index": 2, "is_change": False, "address": "recv2"},
    ]
    assert next_change_index_for_wallet("w1", scan_limit=20, utxo_items=utxos) == 1


def test_mark_change_reserves_index(tmp_path, monkeypatch):
    monkeypatch.setattr("app.address_usage.DATA_DIR", tmp_path)
    monkeypatch.setattr("app.address_usage._USAGE_DIR", tmp_path / "address_usage")
    monkeypatch.setattr("app.address_index.DATA_DIR", tmp_path)
    monkeypatch.setattr("app.address_index._INDEX_DIR", tmp_path / "address_index")

    assert next_change_index_for_wallet("w2", scan_limit=20) == 0
    mark_change_index_used("w2", 0, address="chg0")
    assert 0 in used_change_indices("w2")
    assert next_change_index_for_wallet("w2", scan_limit=20) == 1
