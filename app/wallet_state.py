"""Authoritative per-wallet state in SQLite — Trezor/Sparrow-style local-first store."""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .wallet_store import DATA_DIR

_DB_PATH = DATA_DIR / "wallet_state.db"
_LOCK = threading.RLock()
_MIGRATED = False

SYNC_CACHED = "cached"
SYNC_SYNCING = "syncing"
SYNC_LIVE = "live"
SYNC_INCOMPLETE = "incomplete"


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def _db() -> Iterator[sqlite3.Connection]:
    with _LOCK:
        conn = _connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def init_db() -> None:
    global _MIGRATED
    with _db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sync_meta (
                wallet_id TEXT PRIMARY KEY,
                coin TEXT NOT NULL DEFAULT 'kaspa',
                sync_status TEXT NOT NULL DEFAULT 'cached',
                balance_sompi INTEGER NOT NULL DEFAULT 0,
                last_hot_at TEXT,
                last_deep_at TEXT,
                indexed_receive_high INTEGER NOT NULL DEFAULT -1,
                indexed_change_high INTEGER NOT NULL DEFAULT -1
            );

            CREATE TABLE IF NOT EXISTS utxos (
                wallet_id TEXT NOT NULL,
                utxo_key TEXT NOT NULL,
                address TEXT NOT NULL,
                address_index INTEGER NOT NULL DEFAULT -1,
                transaction_id TEXT NOT NULL,
                output_index INTEGER NOT NULL DEFAULT 0,
                amount INTEGER NOT NULL DEFAULT 0,
                is_change INTEGER NOT NULL DEFAULT 0,
                block_daa_score INTEGER NOT NULL DEFAULT 0,
                is_coinbase INTEGER NOT NULL DEFAULT 0,
                payload_json TEXT,
                PRIMARY KEY (wallet_id, utxo_key)
            );
            CREATE INDEX IF NOT EXISTS idx_utxos_wallet ON utxos(wallet_id);

            CREATE TABLE IF NOT EXISTS transactions (
                wallet_id TEXT NOT NULL,
                transaction_id TEXT NOT NULL,
                direction TEXT NOT NULL,
                amount_kas REAL NOT NULL DEFAULT 0,
                block_time INTEGER NOT NULL DEFAULT 0,
                counterparty TEXT NOT NULL DEFAULT '',
                payload_json TEXT,
                PRIMARY KEY (wallet_id, transaction_id)
            );
            CREATE INDEX IF NOT EXISTS idx_tx_wallet_time ON transactions(wallet_id, block_time DESC);

            CREATE TABLE IF NOT EXISTS tx_raw_cache (
                wallet_id TEXT NOT NULL,
                transaction_id TEXT NOT NULL,
                raw_json TEXT NOT NULL,
                PRIMARY KEY (wallet_id, transaction_id)
            );

            CREATE TABLE IF NOT EXISTS address_sync_cursors (
                wallet_id TEXT NOT NULL,
                address TEXT NOT NULL,
                last_fetched_at TEXT,
                PRIMARY KEY (wallet_id, address)
            );
            """
        )
    if not _MIGRATED:
        _MIGRATED = True
        migrate_from_legacy()
        repair_stuck_sync_status()


def repair_stuck_sync_status() -> None:
    """Wallets left in 'syncing' after a crashed job block live updates."""
    with _db() as conn:
        rows = conn.execute(
            "SELECT wallet_id, coin, last_hot_at, last_deep_at FROM sync_meta WHERE sync_status = ?",
            (SYNC_SYNCING,),
        ).fetchall()
    for row in rows:
        status = SYNC_LIVE if row["last_hot_at"] or row["last_deep_at"] else SYNC_CACHED
        set_sync_status(row["wallet_id"], status, coin=row["coin"])


def _utxo_key(u: dict) -> str:
    return str(u.get("key") or f"{u.get('transaction_id')}:{u.get('output_index')}")


def _normalize_utxo_row(wallet_id: str, u: dict) -> tuple:
    from .address_index_parse import as_address_index

    key = _utxo_key(u)
    return (
        wallet_id,
        key,
        str(u.get("address") or ""),
        as_address_index(u.get("address_index"), -1),
        str(u.get("transaction_id") or ""),
        int(u.get("output_index") or 0),
        int(u.get("amount") or 0),
        1 if u.get("is_change") else 0,
        int(u.get("block_daa_score") or u.get("blockDaaScore") or 0),
        1 if u.get("is_coinbase") or u.get("isCoinbase") else 0,
        json.dumps(u),
    )


def _row_to_utxo(row: sqlite3.Row) -> dict:
    if row["payload_json"]:
        try:
            data = json.loads(row["payload_json"])
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass
    return {
        "key": row["utxo_key"],
        "address": row["address"],
        "address_index": row["address_index"],
        "transaction_id": row["transaction_id"],
        "output_index": row["output_index"],
        "amount": row["amount"],
        "is_change": bool(row["is_change"]),
        "block_daa_score": row["block_daa_score"],
        "is_coinbase": bool(row["is_coinbase"]),
    }


def ensure_wallet_meta(wallet_id: str, *, coin: str) -> None:
    init_db()
    with _db() as conn:
        conn.execute(
            """
            INSERT INTO sync_meta (wallet_id, coin, sync_status)
            VALUES (?, ?, ?)
            ON CONFLICT(wallet_id) DO UPDATE SET coin = excluded.coin
            """,
            (wallet_id, coin, SYNC_CACHED),
        )


def get_sync_meta(wallet_id: str) -> dict | None:
    init_db()
    with _db() as conn:
        row = conn.execute("SELECT * FROM sync_meta WHERE wallet_id = ?", (wallet_id,)).fetchone()
    if not row:
        return None
    return dict(row)


def set_sync_status(wallet_id: str, status: str, *, coin: str | None = None) -> None:
    init_db()
    with _db() as conn:
        if coin:
            conn.execute(
                """
                INSERT INTO sync_meta (wallet_id, coin, sync_status)
                VALUES (?, ?, ?)
                ON CONFLICT(wallet_id) DO UPDATE SET sync_status = excluded.sync_status, coin = excluded.coin
                """,
                (wallet_id, coin, status),
            )
        else:
            conn.execute(
                "UPDATE sync_meta SET sync_status = ? WHERE wallet_id = ?",
                (status, wallet_id),
            )


def touch_hot_sync(wallet_id: str) -> None:
    init_db()
    with _db() as conn:
        conn.execute(
            "UPDATE sync_meta SET last_hot_at = ? WHERE wallet_id = ?",
            (_now_iso(), wallet_id),
        )


def touch_deep_sync(wallet_id: str, *, status: str = SYNC_LIVE) -> None:
    init_db()
    with _db() as conn:
        conn.execute(
            """
            UPDATE sync_meta
            SET last_deep_at = ?, sync_status = ?, last_hot_at = ?
            WHERE wallet_id = ?
            """,
            (_now_iso(), status, _now_iso(), wallet_id),
        )


def replace_utxos(wallet_id: str, utxos: list[dict], *, coin: str, sync_status: str | None = None) -> int:
    """Replace all UTXOs for a wallet and update balance."""
    init_db()
    ensure_wallet_meta(wallet_id, coin=coin)
    balance = sum(int(u.get("amount") or 0) for u in utxos)
    with _db() as conn:
        conn.execute("DELETE FROM utxos WHERE wallet_id = ?", (wallet_id,))
        for u in utxos:
            conn.execute(
                """
                INSERT INTO utxos (
                    wallet_id, utxo_key, address, address_index, transaction_id,
                    output_index, amount, is_change, block_daa_score, is_coinbase, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                _normalize_utxo_row(wallet_id, u),
            )
        if sync_status:
            conn.execute(
                """
                UPDATE sync_meta SET balance_sompi = ?, coin = ?, sync_status = ?
                WHERE wallet_id = ?
                """,
                (balance, coin, sync_status, wallet_id),
            )
        else:
            conn.execute(
                "UPDATE sync_meta SET balance_sompi = ?, coin = ? WHERE wallet_id = ?",
                (balance, coin, wallet_id),
            )
    return balance


def merge_utxos(
    wallet_id: str,
    fresh_utxos: list[dict],
    watch_addresses: set[str] | list[str],
    *,
    coin: str,
) -> tuple[list[dict], int]:
    """Merge hot-address UTXO results with off-watch cached UTXOs (Kaspa/BTC hot path)."""
    init_db()
    ensure_wallet_meta(wallet_id, coin=coin)
    watch_set = set(watch_addresses)
    existing = get_utxos(wallet_id)
    kept = [u for u in existing if str(u.get("address") or "") not in watch_set]
    by_key: dict[str, dict] = {}
    for u in kept + fresh_utxos:
        key = _utxo_key(u)
        by_key[key] = u
    merged = list(by_key.values())
    balance = replace_utxos(wallet_id, merged, coin=coin)
    return merged, balance


def get_utxos(wallet_id: str) -> list[dict]:
    init_db()
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM utxos WHERE wallet_id = ? ORDER BY amount DESC",
            (wallet_id,),
        ).fetchall()
    return [_row_to_utxo(r) for r in rows]


def replace_transactions(wallet_id: str, txs: list[dict]) -> None:
    init_db()
    from .transaction_history import _dedupe_tx_dicts

    # Collapse Esplora ↔ blockchain.info byte-reversed duplicates before write.
    cleaned = _dedupe_tx_dicts([dict(t) for t in txs if isinstance(t, dict)])
    with _db() as conn:
        conn.execute("DELETE FROM transactions WHERE wallet_id = ?", (wallet_id,))
        for t in cleaned:
            tid = str(t.get("transaction_id") or "")
            if not tid:
                continue
            conn.execute(
                """
                INSERT INTO transactions (
                    wallet_id, transaction_id, direction, amount_kas,
                    block_time, counterparty, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    wallet_id,
                    tid,
                    str(t.get("direction") or ""),
                    float(t.get("amount_kas") or 0),
                    int(t.get("block_time") or 0),
                    str(t.get("counterparty") or ""),
                    json.dumps(t),
                ),
            )


def upsert_transactions(wallet_id: str, txs: list[dict]) -> None:
    init_db()
    from .transaction_history import _btc_tx_id_aliases, _dedupe_tx_dicts, _norm_txid

    # Dedupe the batch first so Esplora + blockchain.info aliases can't flip-flop deletes.
    cleaned = _dedupe_tx_dicts([dict(t) for t in txs if isinstance(t, dict)])
    with _db() as conn:
        for t in cleaned:
            tid = _norm_txid(str(t.get("transaction_id") or ""))
            if not tid:
                continue
            # Drop byte-reversed alias rows so Esplora + blockchain.info don't double-count.
            for alias in _btc_tx_id_aliases(tid):
                if alias != tid:
                    conn.execute(
                        "DELETE FROM transactions WHERE wallet_id = ? AND transaction_id = ?",
                        (wallet_id, alias),
                    )
            payload = dict(t)
            payload["transaction_id"] = tid
            conn.execute(
                """
                INSERT INTO transactions (
                    wallet_id, transaction_id, direction, amount_kas,
                    block_time, counterparty, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(wallet_id, transaction_id) DO UPDATE SET
                    direction = excluded.direction,
                    amount_kas = excluded.amount_kas,
                    block_time = excluded.block_time,
                    counterparty = excluded.counterparty,
                    payload_json = excluded.payload_json
                """,
                (
                    wallet_id,
                    tid,
                    str(payload.get("direction") or ""),
                    float(payload.get("amount_kas") or 0),
                    int(payload.get("block_time") or 0),
                    str(payload.get("counterparty") or ""),
                    json.dumps(payload),
                ),
            )


def get_transactions(wallet_id: str, query: str | None = None) -> list[dict]:
    init_db()
    with _db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM transactions WHERE wallet_id = ?
            ORDER BY block_time DESC, transaction_id DESC
            """,
            (wallet_id,),
        ).fetchall()
    out: list[dict] = []
    q = (query or "").strip().lower()
    for row in rows:
        if row["payload_json"]:
            try:
                t = json.loads(row["payload_json"])
                if isinstance(t, dict):
                    item = t
                else:
                    item = {
                        "transaction_id": row["transaction_id"],
                        "direction": row["direction"],
                        "amount_kas": row["amount_kas"],
                        "block_time": row["block_time"],
                        "counterparty": row["counterparty"],
                    }
            except json.JSONDecodeError:
                item = {
                    "transaction_id": row["transaction_id"],
                    "direction": row["direction"],
                    "amount_kas": row["amount_kas"],
                    "block_time": row["block_time"],
                    "counterparty": row["counterparty"],
                }
        else:
            item = {
                "transaction_id": row["transaction_id"],
                "direction": row["direction"],
                "amount_kas": row["amount_kas"],
                "block_time": row["block_time"],
                "counterparty": row["counterparty"],
            }
        if q:
            hay = " ".join(
                str(item.get(k) or "")
                for k in ("transaction_id", "direction", "counterparty")
            ).lower()
            if q not in hay:
                continue
        out.append(item)
    # Collapse Esplora txid ↔ blockchain.info byte-reversed hash duplicates.
    from .transaction_history import _dedupe_tx_dicts

    deduped = _dedupe_tx_dicts(out)
    # Heal persisted alias duplicates so local snapshots / older clients stop seeing 2× txs.
    if len(deduped) < len(out) and not q:
        try:
            replace_transactions(wallet_id, deduped)
        except Exception:
            pass
    return deduped


def save_raw_tx(wallet_id: str, txid: str, raw: dict) -> None:
    init_db()
    with _db() as conn:
        conn.execute(
            """
            INSERT INTO tx_raw_cache (wallet_id, transaction_id, raw_json)
            VALUES (?, ?, ?)
            ON CONFLICT(wallet_id, transaction_id) DO UPDATE SET raw_json = excluded.raw_json
            """,
            (wallet_id, txid, json.dumps(raw)),
        )


def get_raw_tx(wallet_id: str, txid: str) -> dict | None:
    init_db()
    with _db() as conn:
        row = conn.execute(
            "SELECT raw_json FROM tx_raw_cache WHERE wallet_id = ? AND transaction_id = ?",
            (wallet_id, txid),
        ).fetchone()
    if not row:
        return None
    try:
        data = json.loads(row["raw_json"])
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        return None


def delete_wallet_state(wallet_id: str) -> None:
    init_db()
    with _db() as conn:
        for table in ("utxos", "transactions", "tx_raw_cache", "address_sync_cursors", "sync_meta"):
            conn.execute(f"DELETE FROM {table} WHERE wallet_id = ?", (wallet_id,))


def get_wallet_state(wallet_id: str, *, include_transactions: bool = True, tx_limit: int = 500) -> dict:
    """Full wallet snapshot for GET /state — no network I/O."""
    init_db()
    meta = get_sync_meta(wallet_id)
    utxos = get_utxos(wallet_id)
    coin = (meta or {}).get("coin") or "kaspa"
    balance_sompi = sum(int(u.get("amount") or 0) for u in utxos)
    if meta and int(meta.get("balance_sompi") or 0) != balance_sompi:
        balance_sompi = sum(int(u.get("amount") or 0) for u in utxos)
        with _db() as conn:
            conn.execute(
                "UPDATE sync_meta SET balance_sompi = ? WHERE wallet_id = ?",
                (balance_sompi, wallet_id),
            )
    txs: list[dict] = []
    if include_transactions:
        txs = get_transactions(wallet_id)[:tx_limit]
    sync_status = (meta or {}).get("sync_status") or SYNC_CACHED
    return {
        "wallet_id": wallet_id,
        "coin": coin,
        "sync_status": sync_status,
        "balance_sompi": balance_sompi,
        "balance_kas": balance_sompi / 1e8,
        "balance_sats": balance_sompi,
        "balance_btc": balance_sompi / 1e8,
        "utxos": utxos,
        "transactions": txs,
        "last_hot_at": (meta or {}).get("last_hot_at"),
        "last_deep_at": (meta or {}).get("last_deep_at"),
    }


def get_all_wallet_summaries() -> dict[str, dict]:
    """Per-wallet balance + sync_status for /api/status."""
    init_db()
    with _db() as conn:
        rows = conn.execute("SELECT * FROM sync_meta").fetchall()
    return {
        row["wallet_id"]: {
            "coin": row["coin"],
            "sync_status": row["sync_status"],
            "balance_sompi": int(row["balance_sompi"] or 0),
            "balance_kas": int(row["balance_sompi"] or 0) / 1e8,
            "last_hot_at": row["last_hot_at"],
            "last_deep_at": row["last_deep_at"],
        }
        for row in rows
    }


def migrate_from_legacy() -> None:
    """Import utxo_cache JSON files into SQLite."""
    from .address_index import load_address_index
    from .utxo_cache import _CACHE_DIR

    if not _CACHE_DIR.is_dir():
        return
    from .wallet_store import get_wallet, list_wallets

    known_ids = {w.id for w in list_wallets()}
    for path in _CACHE_DIR.glob("*.json"):
        wallet_id = path.stem
        if wallet_id not in known_ids:
            continue
        if get_sync_meta(wallet_id):
            existing_utxos = get_utxos(wallet_id)
            if existing_utxos:
                continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(data, dict):
            continue
        utxos = list(data.get("utxos") or [])
        coin = str(data.get("coin") or "kaspa").strip().lower()
        balance = int(data.get("balance_sompi") or 0)
        if not utxos and balance <= 0:
            continue
        index = load_address_index(wallet_id)
        status = SYNC_LIVE if index.get("addresses") else SYNC_INCOMPLETE
        replace_utxos(wallet_id, utxos, coin=coin, sync_status=status)
        with _db() as conn:
            conn.execute(
                """
                UPDATE sync_meta SET balance_sompi = ? WHERE wallet_id = ?
                """,
                (balance if balance > 0 else sum(int(u.get("amount") or 0) for u in utxos), wallet_id),
            )


def sanitize_wallet_balance(wallet_id: str, *, coin: str) -> None:
    """One-time fix: balance must equal sum(utxos)."""
    init_db()
    utxos = get_utxos(wallet_id)
    balance = sum(int(u.get("amount") or 0) for u in utxos)
    with _db() as conn:
        conn.execute(
            "UPDATE sync_meta SET balance_sompi = ?, coin = ? WHERE wallet_id = ?",
            (balance, coin, wallet_id),
        )
