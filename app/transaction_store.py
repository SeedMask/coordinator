"""Persist outgoing (broadcast) transactions per wallet — coordinator send history."""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from .wallet_store import DATA_DIR

TX_FILE = DATA_DIR / "outgoing_transactions.json"


@dataclass
class OutgoingTx:
    id: str
    wallet_id: str
    transaction_id: str
    send_kas: float
    fee_sompi: int
    to_address: str
    from_address: str
    created_at: str

    def to_dict(self) -> dict:
        return asdict(self)


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _load_all() -> list[dict]:
    if not TX_FILE.is_file():
        return []
    with TX_FILE.open(encoding="utf-8") as f:
        return json.load(f).get("transactions") or []


def _save_all(rows: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with TX_FILE.open("w", encoding="utf-8") as f:
        json.dump({"transactions": rows}, f, indent=2)
        f.write("\n")


def list_for_wallet(wallet_id: str) -> list[OutgoingTx]:
    rows = [r for r in _load_all() if r.get("wallet_id") == wallet_id]
    rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return [OutgoingTx(**r) for r in rows]


def record_broadcast(
    wallet_id: str,
    transaction_id: str,
    send_kas: float,
    fee_sompi: int,
    to_address: str,
    from_address: str,
) -> OutgoingTx:
    tx = OutgoingTx(
        id=str(uuid.uuid4()),
        wallet_id=wallet_id,
        transaction_id=transaction_id.strip().lower().replace("0x", ""),
        send_kas=send_kas,
        fee_sompi=fee_sompi,
        to_address=to_address,
        from_address=from_address,
        created_at=_now_iso(),
    )
    rows = _load_all()
    rows.append(tx.to_dict())
    _save_all(rows)
    return tx
