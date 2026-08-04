"""Shared HTTP client + public-endpoint probes for Bitcoin."""

from __future__ import annotations

import asyncio

import certifi
import httpx

_DEFAULT_HEADERS = {"User-Agent": "SeedMask-Coordinator/1.0", "Accept": "application/json"}
_DEFAULT_TIMEOUT = httpx.Timeout(15.0, connect=8.0)

_client: httpx.AsyncClient | None = None
_client_lock = asyncio.Lock()


async def bitcoin_http_client(timeout: httpx.Timeout | None = None) -> httpx.AsyncClient:
    global _client
    if _client is not None and not _client.is_closed:
        return _client
    async with _client_lock:
        if _client is None or _client.is_closed:
            _client = httpx.AsyncClient(
                timeout=timeout or _DEFAULT_TIMEOUT,
                headers=dict(_DEFAULT_HEADERS),
                follow_redirects=True,
                verify=certifi.where(),
            )
    return _client


def reset_bitcoin_http_client() -> None:
    global _client
    _client = None


def describe_http_error(exc: BaseException) -> str:
    if isinstance(exc, httpx.TimeoutException):
        return "Timed out — server did not respond in time"
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        detail = (exc.response.text or "").strip().replace("\n", " ")
        if detail:
            detail = detail[:140]
            return f"HTTP {code} — {detail}"
        return f"HTTP {code} ({exc.response.reason_phrase})"
    if isinstance(exc, httpx.ConnectError):
        msg = str(exc).strip()
        return f"Could not connect{(': ' + msg) if msg else ''}"
    msg = str(exc).strip()
    return msg or type(exc).__name__


def _positive_feerate(value: object) -> float | None:
    """Parse a sat/vB quote; keep fractional rates (e.g. 0.74) — never truncate to 0."""
    try:
        rate = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not rate or rate != rate or rate <= 0:  # NaN / non-positive
        return None
    return round(rate, 3)


def _ordered_tier_rates(
    *,
    fastest: float,
    half: float,
    hour: float,
    economy: float,
    minimum: float,
) -> dict[str, float]:
    """Preserve live quotes; only clamp so Slow ≤ Normal ≤ Priority."""
    economy_f = min(economy, half, fastest)
    fastest_f = max(economy_f, half, fastest)
    half_f = min(max(half, economy_f), fastest_f)
    hour_f = min(max(hour, economy_f), fastest_f)
    minimum_f = min(minimum, economy_f)
    return {
        "fastest": fastest_f,
        "halfHour": half_f,
        "hour": hour_f,
        "economy": economy_f,
        "minimum": max(0.1, minimum_f),
    }


def mempool_fee_json_to_rates(data: dict) -> dict[str, float] | None:
    if not isinstance(data, dict):
        return None
    fastest = _positive_feerate(data.get("fastestFee"))
    half = _positive_feerate(data.get("halfHourFee"))
    hour = _positive_feerate(data.get("hourFee"))
    if fastest is None and half is None and hour is None:
        return None
    half_f = half or hour or fastest or 1.0
    hour_f = hour or half_f
    fastest_f = fastest or half_f
    economy = _positive_feerate(data.get("economyFee"))
    if economy is None:
        economy = _positive_feerate(data.get("minimumFee")) or min(hour_f, half_f)
    minimum = _positive_feerate(data.get("minimumFee")) or economy
    return _ordered_tier_rates(
        fastest=fastest_f,
        half=half_f,
        hour=hour_f,
        economy=economy,
        minimum=minimum,
    )


def esplora_fee_estimates_to_rates(data: dict) -> dict[str, float] | None:
    if not isinstance(data, dict) or not data:
        return None

    def pick(*keys: str) -> float | None:
        for key in keys:
            if key in data:
                parsed = _positive_feerate(data[key])
                if parsed is not None:
                    return parsed
        return None

    # Targets in blocks: Priority≈next, Normal≈~30m, Slow≈day+.
    fastest = pick("1", "2", "3")
    half = pick("3", "2", "6", "1")
    hour = pick("6", "12", "24", "3")
    economy = pick("144", "504", "1008", "24")
    if half is None and hour is None and fastest is None:
        return None
    half_f = half or fastest or 1.0
    hour_f = hour or half_f
    fastest_f = fastest or half_f
    economy_f = economy or min(hour_f, half_f)
    return _ordered_tier_rates(
        fastest=fastest_f,
        half=half_f,
        hour=hour_f,
        economy=economy_f,
        minimum=economy_f,
    )


async def probe_esplora_tip(client: httpx.AsyncClient, base: str) -> tuple[bool, str, str]:
    url = f"{base.rstrip('/')}/blocks/tip/height"
    try:
        resp = await client.get(url)
        resp.raise_for_status()
        text = resp.text.strip()
        if text.isdigit():
            return True, text, f"Connected via {base} (height {text})"
        try:
            data = resp.json()
            if isinstance(data, dict):
                raw_height = data.get("height") or data.get("block_height")
                if raw_height is not None:
                    height = str(int(raw_height))
                    return True, height, f"Connected via {base} (height {height})"
        except Exception:
            pass
        return False, "", f"Unexpected response from {base}"
    except Exception as e:
        return False, "", describe_http_error(e)


async def probe_mempool_fee_url(client: httpx.AsyncClient, fee_url: str) -> tuple[bool, str, dict[str, float] | None]:
    url = (fee_url or "").strip()
    if not url:
        return False, "Fee URL missing", None
    try:
        resp = await client.get(url)
        resp.raise_for_status()
        rates = mempool_fee_json_to_rates(resp.json())
        if rates:
            return True, f"Fee API reachable (~{rates['halfHour']} sat/vB)", rates
        return True, "Fee API responded", None
    except Exception as e:
        return False, describe_http_error(e), None


async def probe_blockstream_fees(client: httpx.AsyncClient, esplora_base: str) -> tuple[bool, str, dict[str, float] | None]:
    url = f"{esplora_base.rstrip('/')}/fee-estimates"
    try:
        resp = await client.get(url)
        resp.raise_for_status()
        rates = esplora_fee_estimates_to_rates(resp.json())
        if rates:
            return True, f"Fee estimates reachable (~{rates['halfHour']} sat/vB)", rates
        return False, "Fee estimates empty", None
    except Exception as e:
        return False, describe_http_error(e), None


async def probe_blockchain_info(client: httpx.AsyncClient) -> tuple[bool, str, str]:
    try:
        resp = await client.get("https://blockchain.info/q/getblockcount")
        resp.raise_for_status()
        height = resp.text.strip()
        if height.isdigit():
            return True, height, f"Connected via blockchain.info (height {height})"
        return False, "", "Unexpected blockchain.info response"
    except Exception as e:
        return False, "", describe_http_error(e)
