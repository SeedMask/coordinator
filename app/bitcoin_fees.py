"""Bitcoin fee estimation with vsize-aware sat/vB."""

from __future__ import annotations

import asyncio
import math
import time

from .bitcoin_service import SATS_PER_BTC

# P2WPKH input ≈ 68 vB; output ≈ 31 vB; overhead ≈ 11 vB
_VBYTES_PER_P2WPKH_IN = 68
_VBYTES_PER_P2WPKH_OUT = 31
_VBYTES_OVERHEAD = 11
# P2WSH multisig input (2-of-3) rough estimate
_VBYTES_PER_P2WSH_MULTISIG_IN = 105

_Feerate_CACHE: tuple[float, dict[str, float]] | None = None
_Feerate_TTL_SEC = 45.0
# Offline-only last resort — never preferred over a live quote.
_DEFAULT_RATES = {"fastest": 2.0, "halfHour": 1.0, "hour": 1.0, "economy": 0.5, "minimum": 0.1}


async def fetch_recommended_feerates() -> dict[str, float]:
    global _Feerate_CACHE
    now = time.monotonic()
    if _Feerate_CACHE is not None and now - _Feerate_CACHE[0] < _Feerate_TTL_SEC:
        return dict(_Feerate_CACHE[1])
    from . import bitcoin_backend

    if not bitcoin_backend.uses_public_endpoints():
        rates = await bitcoin_backend.fetch_recommended_feerates()
    else:
        rates = await fetch_recommended_feerates_public()
    _Feerate_CACHE = (now, dict(rates))
    return rates


async def fetch_recommended_feerates_public() -> dict[str, float]:
    """Fetch fee rates from configured endpoints only (no silent cross-provider hops)."""
    from . import bitcoin_http
    from .network_settings import allows_cross_provider_fallbacks, load_network_settings

    btc = load_network_settings().bitcoin
    client = await bitcoin_http.bitcoin_http_client()
    allow_cross = allows_cross_provider_fallbacks(btc)

    bases: list[str] = []
    for base in [btc.esplora_primary, *(btc.esplora_fallbacks or [])]:
        stripped = (base or "").strip().rstrip("/")
        if stripped and stripped not in bases:
            bases.append(stripped)
    if allow_cross:
        for extra in ("https://blockstream.info/api",):
            if extra not in bases:
                bases.append(extra)

    async def try_mempool() -> dict[str, float] | None:
        ok, _summary, rates = await bitcoin_http.probe_mempool_fee_url(client, btc.fee_recommended_url)
        return rates if ok and rates else None

    async def try_esplora(base: str) -> dict[str, float] | None:
        ok, _summary, rates = await bitcoin_http.probe_blockstream_fees(client, base)
        return rates if ok and rates else None

    tasks = [asyncio.create_task(try_mempool())]
    for base in bases:
        tasks.append(asyncio.create_task(try_esplora(base)))

    try:
        for fut in asyncio.as_completed(tasks):
            try:
                rates = await fut
            except Exception:
                continue
            if rates:
                for t in tasks:
                    if not t.done():
                        t.cancel()
                return rates
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()

    return dict(_DEFAULT_RATES)


def estimate_vbytes(
    *,
    input_count: int = 1,
    output_count: int = 2,
    multisig: bool = False,
) -> int:
    in_vb = _VBYTES_PER_P2WSH_MULTISIG_IN if multisig else _VBYTES_PER_P2WPKH_IN
    return _VBYTES_OVERHEAD + input_count * in_vb + output_count * _VBYTES_PER_P2WPKH_OUT


async def fee_estimate_bitcoin_detailed(
    *,
    utxo_amount_sats: int | None = None,
    input_count: int = 1,
    output_count: int = 2,
    feerate_sat_vb: float | None = None,
    multisig: bool = False,
) -> dict:
    try:
        rates = await fetch_recommended_feerates()
    except Exception:
        rates = dict(_DEFAULT_RATES)
    if feerate_sat_vb is not None and float(feerate_sat_vb) > 0:
        rate = float(feerate_sat_vb)
    else:
        rate = float(rates.get("halfHour") or rates.get("hour") or 1.0)
    vbytes = estimate_vbytes(
        input_count=max(1, input_count),
        output_count=max(1, output_count),
        multisig=multisig,
    )
    fee_sats = max(141, math.ceil(rate * vbytes))
    spendable_sats = None
    insufficient = False
    if utxo_amount_sats is not None and utxo_amount_sats > 0:
        spendable_sats = max(0, utxo_amount_sats - fee_sats)
        insufficient = utxo_amount_sats < fee_sats
    return {
        "fee_sompi": fee_sats,
        "fee_kas": fee_sats / SATS_PER_BTC,
        "spendable_sompi": spendable_sats,
        "max_send_sompi": spendable_sats,
        "insufficient_funds": insufficient,
        "feerate": float(rate),
        "feerate_sat_vb": float(rate),
        "vbytes": vbytes,
        "mass_grams": vbytes,
        "input_count": input_count,
        "output_count": output_count,
        "feerates": rates,
        "coin": "bitcoin",
        "rbf_supported": True,
    }
