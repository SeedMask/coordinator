"""Isolate interactive API work from low-priority background gap scans."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")

# At most one deep gap scan per chain — keeps Kaspa RPC / Send / Tx details responsive.
_btc_deep_scan_sem = asyncio.Semaphore(1)
_kaspa_deep_scan_sem = asyncio.Semaphore(1)


def deep_scan_sem_for_coin(coin: str) -> asyncio.Semaphore:
    if (coin or "").strip().lower() == "bitcoin":
        return _btc_deep_scan_sem
    return _kaspa_deep_scan_sem


async def run_deep_scan(coin: str, factory: Callable[[], Awaitable[T]]) -> T:
    sem = deep_scan_sem_for_coin(coin)
    async with sem:
        return await factory()
