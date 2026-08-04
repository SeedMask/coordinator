"""Background sync queue — mainnet reconciliation never blocks UI reads."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Awaitable, Callable

from . import wallet_state
from .wallet_store import get_wallet, resolved_wallet_coin

log = logging.getLogger(__name__)


class SyncPriority(IntEnum):
    INTERACTIVE = 0
    ACTIVE_HOT = 1
    BACKGROUND_HOT = 2
    BACKGROUND_DEEP = 3


@dataclass(order=True)
class SyncJob:
    priority: int
    wallet_id: str = field(compare=False)
    mode: str = field(compare=False)  # hot | discover | deep
    on_progress: Callable[[str], None] | None = field(compare=False, default=None)


class SyncWorker:
    def __init__(self, coordinator) -> None:
        self._coordinator = coordinator
        self._queue: asyncio.PriorityQueue[SyncJob] = asyncio.PriorityQueue()
        self._pending: set[tuple[str, str]] = set()
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._active_wallet_id: str | None = None
        self._hub_publish: Callable[[str, dict[str, Any]], Awaitable[None]] | None = None

    def set_active_wallet(self, wallet_id: str | None) -> None:
        self._active_wallet_id = wallet_id

    def set_hub_publish(self, cb: Callable[[str, dict[str, Any]], Awaitable[None]]) -> None:
        self._hub_publish = cb

    def ensure_started(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="sync-worker")

    async def enqueue(
        self,
        wallet_id: str,
        mode: str = "hot",
        *,
        priority: SyncPriority | None = None,
        on_progress: Callable[[str], None] | None = None,
        wait: bool = False,
    ) -> dict | None:
        job = SyncJob(
            priority=int(priority or SyncPriority.BACKGROUND_HOT),
            wallet_id=wallet_id,
            mode=mode,
            on_progress=on_progress,
        )
        if wait:
            return await self._execute(job)

        self.ensure_started()
        key = (wallet_id, mode)
        async with self._lock:
            if key in self._pending:
                return None
            self._pending.add(key)

        job.priority = int(
            priority
            if priority is not None
            else (
                SyncPriority.BACKGROUND_DEEP
                if mode == "deep"
                else SyncPriority.ACTIVE_HOT
                if wallet_id == self._active_wallet_id
                else SyncPriority.BACKGROUND_HOT
            )
        )
        await self._queue.put(job)
        return None

    async def _run(self) -> None:
        while True:
            job = await self._queue.get()
            key = (job.wallet_id, job.mode)
            try:
                await self._execute(job)
            except Exception as exc:
                log.warning("sync job %s %s failed: %s", job.wallet_id, job.mode, exc)
            finally:
                async with self._lock:
                    self._pending.discard(key)
                self._queue.task_done()

    async def _execute(self, job: SyncJob) -> dict:
        cfg = get_wallet(job.wallet_id)
        if not cfg:
            raise RuntimeError("Wallet not found")
        coin = resolved_wallet_coin(cfg)
        meta = wallet_state.get_sync_meta(job.wallet_id)
        already_live = bool(meta and meta.get("sync_status") == wallet_state.SYNC_LIVE)
        # Hot refresh of an already-live wallet: keep status Live (avoids UI Live↔Syncing flicker).
        if not (job.mode == "hot" and already_live):
            wallet_state.set_sync_status(job.wallet_id, wallet_state.SYNC_SYNCING, coin=coin)

        coordinator = self._coordinator
        try:
            if job.mode == "deep":
                result = await coordinator.refresh(job.wallet_id, on_progress=job.on_progress)
                wallet_state.touch_deep_sync(job.wallet_id, status=wallet_state.SYNC_LIVE)
            elif job.mode == "discover":
                result = await coordinator.refresh_discover(job.wallet_id, on_progress=job.on_progress)
                meta = wallet_state.get_sync_meta(job.wallet_id)
                if not meta or meta.get("sync_status") not in (
                    wallet_state.SYNC_LIVE,
                    wallet_state.SYNC_INCOMPLETE,
                ):
                    wallet_state.set_sync_status(job.wallet_id, wallet_state.SYNC_INCOMPLETE, coin=coin)
            else:
                result = await coordinator.refresh_watch(job.wallet_id)
                wallet_state.touch_hot_sync(job.wallet_id)
                wallet_state.set_sync_status(job.wallet_id, wallet_state.SYNC_LIVE, coin=coin)

            if job.mode in ("deep", "discover"):
                try:
                    from .tx_index import sync_wallet_transactions

                    await sync_wallet_transactions(
                        job.wallet_id,
                        cfg,
                        wallet_state.get_utxos(job.wallet_id),
                        replace=job.mode == "deep",
                    )
                except Exception as exc:
                    log.debug("tx index sync failed for %s: %s", job.wallet_id, exc)

            await self._publish_state(job.wallet_id, result)
            return result
        except Exception:
            wallet_state.set_sync_status(job.wallet_id, wallet_state.SYNC_CACHED, coin=coin)
            raise

    async def _publish_state(self, wallet_id: str, scan_result: dict | None) -> None:
        if not self._hub_publish:
            return
        state = wallet_state.get_wallet_state(wallet_id)
        payload = dict(state)
        payload["type"] = "state"
        if scan_result:
            payload["changed"] = scan_result.get("changed", True)
            payload["sync_mode"] = scan_result.get("sync_mode", "hot")
        try:
            await self._hub_publish(wallet_id, payload)
        except Exception as exc:
            log.debug("hub publish failed for %s: %s", wallet_id, exc)


_worker: SyncWorker | None = None


def get_sync_worker(coordinator) -> SyncWorker:
    global _worker
    if _worker is None:
        _worker = SyncWorker(coordinator)
    return _worker
