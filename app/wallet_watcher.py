"""Live wallet balance watcher — Kaspa RPC subscriptions + Bitcoin mempool websocket."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import defaultdict
from typing import Any

from .controller import Coordinator
from .wallet_store import WalletConfig, get_wallet
from .watch_addresses import watch_addresses_for_wallet

log = logging.getLogger(__name__)

_BITCOIN_WS_DEFAULT = "wss://mempool.space/api/v1/ws"
_WATCH_POLL_SEC = 5.0
_DEBOUNCE_SEC = 0.35


class WalletEventHub:
    def __init__(self) -> None:
        self._queues: dict[str, list[asyncio.Queue[dict[str, Any]]]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def subscribe(self, wallet_id: str) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=8)
        async with self._lock:
            self._queues[wallet_id].append(queue)
        return queue

    async def unsubscribe(self, wallet_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._lock:
            if wallet_id in self._queues:
                self._queues[wallet_id] = [q for q in self._queues[wallet_id] if q is not queue]
                if not self._queues[wallet_id]:
                    del self._queues[wallet_id]

    async def publish(self, wallet_id: str, payload: dict[str, Any]) -> None:
        async with self._lock:
            queues = list(self._queues.get(wallet_id, []))
        for queue in queues:
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                try:
                    _ = queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(payload)
                except asyncio.QueueFull:
                    pass


class _Debounced:
    def __init__(self, callback, delay: float = _DEBOUNCE_SEC) -> None:
        self._callback = callback
        self._delay = delay
        self._task: asyncio.Task | None = None

    def trigger(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        try:
            await asyncio.sleep(self._delay)
            result = self._callback()
            if asyncio.iscoroutine(result):
                await result
        except asyncio.CancelledError:
            return


class WalletWatcherService:
    def __init__(self, coordinator: Coordinator, hub: WalletEventHub) -> None:
        self._coordinator = coordinator
        self._hub = hub
        self._tasks: dict[str, asyncio.Task] = {}
        self._subscriber_counts: dict[str, int] = defaultdict(int)
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        return

    async def stop(self) -> None:
        async with self._lock:
            tasks = list(self._tasks.values())
            self._tasks.clear()
            self._subscriber_counts.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def subscriber_connected(self, wallet_id: str) -> None:
        async with self._lock:
            self._subscriber_counts[wallet_id] += 1
            if wallet_id not in self._tasks or self._tasks[wallet_id].done():
                self._tasks[wallet_id] = asyncio.create_task(
                    self._watch_wallet(wallet_id),
                    name=f"wallet-watch-{wallet_id}",
                )

    async def subscriber_disconnected(self, wallet_id: str) -> None:
        async with self._lock:
            self._subscriber_counts[wallet_id] = max(0, self._subscriber_counts[wallet_id] - 1)
            if self._subscriber_counts[wallet_id] > 0:
                return
            task = self._tasks.pop(wallet_id, None)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _watch_wallet(self, wallet_id: str) -> None:
        while True:
            cfg = get_wallet(wallet_id)
            if not cfg:
                await asyncio.sleep(2.0)
                continue
            coin = (cfg.coin or "kaspa").strip().lower()
            try:
                if coin == "bitcoin":
                    await self._watch_bitcoin(wallet_id, cfg)
                else:
                    await self._watch_kaspa(wallet_id, cfg)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("wallet watch %s failed: %s", wallet_id, exc)
                await asyncio.sleep(5.0)

    async def nudge_wallet(self, wallet_id: str) -> None:
        """Push a lightweight refresh after local activity (e.g. broadcast)."""
        await self._publish_refresh(wallet_id, full=False)

    async def _publish_refresh(self, wallet_id: str, *, full: bool = False) -> None:
        from .sync_worker import get_sync_worker

        worker = get_sync_worker(self._coordinator)
        mode = "deep" if full else "hot"
        await worker.enqueue(wallet_id, mode)

    async def _watch_kaspa(self, wallet_id: str, cfg: WalletConfig) -> None:
        from kaspa import Address, NotificationEvent

        from .kaspa_service import get_service

        svc = get_service()
        debouncer = _Debounced(lambda: self._publish_refresh(wallet_id, full=False))
        client = await svc._get_client()
        subscribed: list[Address] = []
        loop = asyncio.get_running_loop()
        last_poll = 0.0

        def on_utxos_changed(_notification) -> None:
            loop.call_soon_threadsafe(debouncer.trigger)

        client.add_event_listener(NotificationEvent.UtxosChanged, on_utxos_changed)

        try:
            while True:
                st = self._coordinator._state_for(wallet_id)
                if not st.utxos:
                    self._coordinator._hydrate_from_disk(wallet_id)
                    st = self._coordinator._state_for(wallet_id)
                addrs = watch_addresses_for_wallet(wallet_id, cfg, st.utxos)
                kaspa_addrs = [Address(a) for a in addrs]

                if subscribed:
                    try:
                        await client.unsubscribe_utxos_changed(subscribed)
                    except Exception:
                        pass
                subscribed = kaspa_addrs
                if kaspa_addrs:
                    await client.subscribe_utxos_changed(kaspa_addrs)

                now = time.monotonic()
                if now - last_poll >= _WATCH_POLL_SEC:
                    last_poll = now
                    await self._publish_refresh(wallet_id, full=False)

                await asyncio.sleep(1.0)
        finally:
            client.remove_event_listener(NotificationEvent.UtxosChanged, on_utxos_changed)
            if subscribed:
                try:
                    await client.unsubscribe_utxos_changed(subscribed)
                except Exception:
                    pass

    async def _watch_bitcoin(self, wallet_id: str, cfg: WalletConfig) -> None:
        from . import bitcoin_backend
        from .network_settings import load_network_settings

        if bitcoin_backend.uses_poll_only_watcher():
            await self._watch_bitcoin_poll_only(wallet_id, cfg)
            return

        try:
            import websockets
        except ImportError:
            await self._watch_bitcoin_poll_only(wallet_id, cfg)
            return

        debouncer = _Debounced(lambda: self._publish_refresh(wallet_id, full=False))
        last_poll = 0.0

        while True:
            ws_url = (load_network_settings().bitcoin.websocket_url or "").strip()
            if not ws_url:
                # Exclusive Blockstream (and any empty-WS config) uses poll-only —
                # do not silently attach to mempool.space.
                await self._watch_bitcoin_poll_only(wallet_id, cfg)
                return
            st = self._coordinator._state_for(wallet_id)
            if not st.utxos:
                self._coordinator._hydrate_from_disk(wallet_id)
                st = self._coordinator._state_for(wallet_id)
            addrs = watch_addresses_for_wallet(wallet_id, cfg, st.utxos)

            try:
                async with websockets.connect(
                    ws_url,
                    ping_interval=20,
                    ping_timeout=20,
                    close_timeout=5,
                ) as ws:
                    for addr in addrs:
                        await ws.send(json.dumps({"track-address": addr}))

                    while True:
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                        except asyncio.TimeoutError:
                            raw = None

                        if raw:
                            try:
                                msg = json.loads(raw)
                            except json.JSONDecodeError:
                                msg = {}
                            if msg.get("address-transaction") or msg.get("block-transaction"):
                                debouncer.trigger()

                        now = time.monotonic()
                        if now - last_poll >= _WATCH_POLL_SEC:
                            last_poll = now
                            await self._publish_refresh(wallet_id, full=False)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.debug("bitcoin ws reconnect for %s: %s", wallet_id, exc)
                await asyncio.sleep(3.0)

    async def _watch_bitcoin_poll_only(self, wallet_id: str, cfg: WalletConfig) -> None:
        while True:
            await self._publish_refresh(wallet_id, full=False)
            await asyncio.sleep(_WATCH_POLL_SEC)


_event_hub = WalletEventHub()
_watcher: WalletWatcherService | None = None


def get_event_hub() -> WalletEventHub:
    return _event_hub


def get_wallet_watcher(coordinator: Coordinator) -> WalletWatcherService:
    global _watcher
    if _watcher is None:
        _watcher = WalletWatcherService(coordinator, _event_hub)
    return _watcher
