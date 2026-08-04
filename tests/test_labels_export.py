"""Tests for labels store and wallet export/import."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest


@pytest.fixture()
def labels_env(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        data = Path(tmp)
        monkeypatch.setattr("app.labels_store.DATA_DIR", data)
        monkeypatch.setattr("app.labels_store.LABELS_FILE", data / "labels.json")
        yield data


def test_labels_roundtrip(labels_env):
    from app.labels_store import list_labels, search_transactions, set_tx_label

    set_tx_label("w1", "abcd", "Coffee shop")
    labels = list_labels("w1")
    assert labels["transactions"]["abcd"] == "Coffee shop"
    rows = [{"transaction_id": "abcd", "counterparty": "x", "direction": "sent", "label": "Coffee shop"}]
    found = search_transactions(rows, "coffee")
    assert len(found) == 1


def test_wallet_export_import(monkeypatch, tmp_path):
    from app import wallet_export, wallet_store

    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(wallet_store, "DATA_DIR", data)
    monkeypatch.setattr(wallet_store, "WALLETS_FILE", data / "wallets.json")

    cfg = wallet_store.add_wallet(
        "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V",
        "export-test",
        30,
        coin="bitcoin",
        activate=True,
    )
    bundle = wallet_export.export_wallet_bundle(cfg.id)
    assert bundle["format"] == "seedmask_wallet_export"
    assert bundle["wallet"]["kpub"] == cfg.kpub
    assert "labels" in bundle
