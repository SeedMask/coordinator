"""Persisted network/backend settings for Bitcoin and Kaspa (Sparrow-style transparency)."""

from __future__ import annotations

import contextvars
import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any
from urllib.parse import urlparse

from .wallet_store import DATA_DIR

SETTINGS_FILE = DATA_DIR / "network_settings.json"

_TXID_PLACEHOLDER = "{txid}"

_bitcoin_settings_override: contextvars.ContextVar["BitcoinNetworkSettings | None"] = contextvars.ContextVar(
    "bitcoin_settings_override", default=None
)


def _strip_url(url: str) -> str:
    return (url or "").strip().rstrip("/")


def _parse_legacy_electrum(url: str) -> tuple[str, int, bool]:
    parsed = urlparse((url or "").strip())
    host = parsed.hostname or "127.0.0.1"
    use_ssl = parsed.scheme == "ssl"
    port = parsed.port or (50002 if use_ssl else 50001)
    return host, int(port), use_ssl


def _parse_legacy_core(url: str) -> tuple[str, int, bool]:
    parsed = urlparse((url or "").strip())
    host = parsed.hostname or "127.0.0.1"
    use_ssl = parsed.scheme == "https"
    port = parsed.port or (8332 if not use_ssl else 443)
    return host, int(port), use_ssl


def _normalize_server_mode(raw: str) -> str:
    mode = (raw or "public").strip().lower()
    if mode in {"bitcoin_core", "core"}:
        return "bitcoin_core"
    if mode in {"electrum", "private_electrum"}:
        return "electrum"
    return "public"


def _valid_http_url(url: str, *, websockets: bool = False) -> bool:
    parsed = urlparse(url.strip())
    if not parsed.scheme or not parsed.netloc:
        return False
    if websockets:
        return parsed.scheme in {"ws", "wss"}
    return parsed.scheme in {"http", "https"}


def _normalize_public_preset(raw: str) -> str:
    preset = (raw or "recommended").strip().lower()
    if preset in {"mempool_space", "mempool.space"}:
        return "mempool_space"
    if preset in {"blockstream", "blockstream.info"}:
        return "blockstream"
    return "recommended"


def is_exclusive_public_preset(preset: str | None = None) -> bool:
    """True when the user picked a single public provider (no silent cross-fallback)."""
    return _normalize_public_preset(preset or "") in {"mempool_space", "blockstream"}


def allows_cross_provider_fallbacks(settings: "BitcoinNetworkSettings | None" = None) -> bool:
    """Whether public mode may use Electrum/blockchain.info/other providers.

    Exclusive presets (mempool.space / Blockstream) must stay on that provider only.
    Recommended may use curated backups when enable_legacy_fallbacks is on.
    """
    btc = settings if settings is not None else load_bitcoin_settings()
    if _normalize_server_mode(btc.server_mode) != "public":
        return False
    if is_exclusive_public_preset(btc.public_preset):
        return False
    return bool(btc.enable_legacy_fallbacks)


def _exclusive_preset_endpoints(preset: str) -> dict[str, Any] | None:
    """Strict single-provider endpoint maps for exclusive public presets."""
    if preset == "mempool_space":
        return {
            "esplora_primary": "https://mempool.space/api",
            "esplora_fallbacks": [],
            "websocket_url": "wss://mempool.space/api/v1/ws",
            "broadcast_urls": ["https://mempool.space/api/tx"],
            "fee_recommended_url": "https://mempool.space/api/v1/fees/recommended",
            "explorer_tx_template": "https://mempool.space/tx/{txid}",
            "enable_legacy_fallbacks": False,
        }
    if preset == "blockstream":
        return {
            "esplora_primary": "https://blockstream.info/api",
            "esplora_fallbacks": [],
            # No public Blockstream mempool websocket — poll-only watcher.
            "websocket_url": "",
            "broadcast_urls": ["https://blockstream.info/api/tx"],
            "fee_recommended_url": "https://blockstream.info/api/fee-estimates",
            "explorer_tx_template": "https://blockstream.info/tx/{txid}",
            "enable_legacy_fallbacks": False,
        }
    return None


@dataclass
class BitcoinNetworkSettings:
    server_mode: str = "public"
    public_preset: str = "recommended"
    # Legacy single-URL fields (migrated on load)
    bitcoin_core_url: str = ""
    electrum_url: str = ""
    # Bitcoin Core RPC (Sparrow-style)
    core_host: str = "127.0.0.1"
    core_port: int = 8332
    core_user: str = ""
    core_password: str = ""
    core_use_ssl: bool = False
    core_cookie_path: str = ""
    # Private Electrum server
    electrum_host: str = "127.0.0.1"
    electrum_port: int = 50002
    electrum_use_ssl: bool = True
    # Public-server endpoints (used only when server_mode == public)
    esplora_primary: str = "https://blockstream.info/api"
    esplora_fallbacks: list[str] = field(
        default_factory=lambda: [
            "https://mempool.emzy.de/api",
            "https://mempool.space/api",
        ]
    )
    websocket_url: str = "wss://mempool.space/api/v1/ws"
    broadcast_urls: list[str] = field(
        default_factory=lambda: [
            "https://mempool.space/api/tx",
            "https://blockstream.info/api/tx",
        ]
    )
    fee_recommended_url: str = "https://mempool.space/api/v1/fees/recommended"
    explorer_tx_template: str = "https://mempool.space/tx/{txid}"
    enable_legacy_fallbacks: bool = True

    def normalized(self) -> BitcoinNetworkSettings:
        mode = _normalize_server_mode(self.server_mode)
        preset = _normalize_public_preset(self.public_preset)
        core_host = (self.core_host or "127.0.0.1").strip()
        core_port = int(self.core_port or 8332)
        core_user = (self.core_user or "").strip()
        core_password = self.core_password or ""
        core_use_ssl = bool(self.core_use_ssl)
        core_cookie_path = (self.core_cookie_path or "").strip()
        electrum_host = (self.electrum_host or "127.0.0.1").strip()
        electrum_port = int(self.electrum_port or (50002 if self.electrum_use_ssl else 50001))
        electrum_use_ssl = bool(self.electrum_use_ssl)

        legacy_core = _strip_url(self.bitcoin_core_url)
        if legacy_core and core_host == "127.0.0.1" and core_port == 8332 and not core_user:
            h, p, ssl_flag = _parse_legacy_core(legacy_core)
            core_host, core_port, core_use_ssl = h, p, ssl_flag

        legacy_electrum = (self.electrum_url or "").strip()
        if legacy_electrum and electrum_host == "127.0.0.1":
            h, p, ssl_flag = _parse_legacy_electrum(legacy_electrum)
            electrum_host, electrum_port, electrum_use_ssl = h, p, ssl_flag

        exclusive = _exclusive_preset_endpoints(preset) if mode == "public" else None
        if exclusive:
            esplora_primary = exclusive["esplora_primary"]
            esplora_fallbacks = list(exclusive["esplora_fallbacks"])
            websocket_url = exclusive["websocket_url"]
            broadcast_urls = list(exclusive["broadcast_urls"])
            fee_recommended_url = exclusive["fee_recommended_url"]
            explorer_tx_template = exclusive["explorer_tx_template"]
            enable_legacy = False
        else:
            esplora_primary = _strip_url(self.esplora_primary)
            esplora_fallbacks = [_strip_url(u) for u in self.esplora_fallbacks if _strip_url(u)]
            websocket_url = _strip_url(self.websocket_url)
            broadcast_urls = [_strip_url(u) for u in self.broadcast_urls if _strip_url(u)]
            fee_recommended_url = _strip_url(self.fee_recommended_url)
            explorer_tx_template = (self.explorer_tx_template or "").strip()
            # Recommended may use legacy backups; exclusive presets never do.
            enable_legacy = bool(self.enable_legacy_fallbacks) if mode == "public" else bool(self.enable_legacy_fallbacks)

        return BitcoinNetworkSettings(
            server_mode=mode,
            public_preset=preset,
            bitcoin_core_url=legacy_core,
            electrum_url=legacy_electrum,
            core_host=core_host,
            core_port=core_port,
            core_user=core_user,
            core_password=core_password,
            core_use_ssl=core_use_ssl,
            core_cookie_path=core_cookie_path,
            electrum_host=electrum_host,
            electrum_port=electrum_port,
            electrum_use_ssl=electrum_use_ssl,
            esplora_primary=esplora_primary,
            esplora_fallbacks=esplora_fallbacks,
            websocket_url=websocket_url,
            broadcast_urls=broadcast_urls,
            fee_recommended_url=fee_recommended_url,
            explorer_tx_template=explorer_tx_template,
            enable_legacy_fallbacks=enable_legacy,
        )

    def validate(self) -> None:
        norm = self.normalized()
        mode = norm.server_mode
        if mode == "bitcoin_core":
            if not norm.core_host:
                raise ValueError("Bitcoin Core host is required")
            if norm.core_port < 1 or norm.core_port > 65535:
                raise ValueError("Bitcoin Core port must be between 1 and 65535")
            if not norm.core_cookie_path and not norm.core_user:
                raise ValueError("Bitcoin Core requires RPC username/password or a data folder / cookie path")
        elif mode == "electrum":
            if not norm.electrum_host:
                raise ValueError("Electrum server host is required")
            if norm.electrum_port < 1 or norm.electrum_port > 65535:
                raise ValueError("Electrum port must be between 1 and 65535")
        else:
            if not _valid_http_url(norm.esplora_primary):
                raise ValueError("Bitcoin block explorer API must be a valid https:// address")
            for url in norm.esplora_fallbacks:
                if not _valid_http_url(url):
                    raise ValueError(f"Invalid Bitcoin fallback URL: {url}")
            # Empty websocket is allowed (poll-only), e.g. Blockstream exclusive preset.
            if norm.websocket_url and not _valid_http_url(norm.websocket_url, websockets=True):
                raise ValueError("Bitcoin live-updates WebSocket must be a valid wss:// address")
            if not norm.broadcast_urls:
                raise ValueError("At least one Bitcoin broadcast URL is required")
            for url in norm.broadcast_urls:
                if not _valid_http_url(url):
                    raise ValueError(f"Invalid Bitcoin broadcast URL: {url}")
            if not _valid_http_url(norm.fee_recommended_url):
                raise ValueError("Bitcoin fee API URL must be a valid https:// address")
        if _TXID_PLACEHOLDER not in norm.explorer_tx_template:
            raise ValueError("Bitcoin explorer link must include {txid}")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self.normalized())

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> BitcoinNetworkSettings:
        if not isinstance(raw, dict):
            return cls()
        fallbacks = raw.get("esplora_fallbacks")
        broadcasts = raw.get("broadcast_urls")
        return cls(
            server_mode=str(raw.get("server_mode") or "public"),
            public_preset=str(raw.get("public_preset") or "recommended"),
            bitcoin_core_url=str(raw.get("bitcoin_core_url") or ""),
            electrum_url=str(raw.get("electrum_url") or ""),
            core_host=str(raw.get("core_host") or "127.0.0.1"),
            core_port=int(raw.get("core_port") or 8332),
            core_user=str(raw.get("core_user") or ""),
            core_password=str(raw.get("core_password") or ""),
            core_use_ssl=bool(raw.get("core_use_ssl", False)),
            core_cookie_path=str(raw.get("core_cookie_path") or ""),
            electrum_host=str(raw.get("electrum_host") or "127.0.0.1"),
            electrum_port=int(raw.get("electrum_port") or 50002),
            electrum_use_ssl=bool(raw.get("electrum_use_ssl", True)),
            esplora_primary=str(raw.get("esplora_primary") or cls.esplora_primary),
            esplora_fallbacks=list(fallbacks) if isinstance(fallbacks, list) else cls().esplora_fallbacks,
            websocket_url=str(raw.get("websocket_url") or cls.websocket_url),
            broadcast_urls=list(broadcasts) if isinstance(broadcasts, list) else cls().broadcast_urls,
            fee_recommended_url=str(raw.get("fee_recommended_url") or cls.fee_recommended_url),
            explorer_tx_template=str(raw.get("explorer_tx_template") or cls.explorer_tx_template),
            enable_legacy_fallbacks=bool(raw.get("enable_legacy_fallbacks", True)),
        )


@dataclass
class KaspaNetworkSettings:
    rpc_mode: str = "resolver"
    rpc_url: str = ""
    history_mode: str = "public"
    history_api_base: str = "https://api.kaspa.org"
    explorer_tx_template: str = "https://kaspa.stream/transactions/{txid}"

    def normalized(self) -> KaspaNetworkSettings:
        mode = (self.rpc_mode or "resolver").strip().lower()
        if mode not in {"resolver", "custom"}:
            mode = "resolver"
        history_mode = (self.history_mode or "").strip().lower()
        if history_mode not in {"public", "disabled", "custom"}:
            history_mode = "disabled" if mode == "custom" else "public"
        history_api_base = _strip_url(self.history_api_base)
        if history_mode == "public":
            history_api_base = KaspaNetworkSettings.history_api_base
        template = (self.explorer_tx_template or "").strip()
        low = template.lower()
        if not template or "kas.fyi" in low or "explorer.kaspa.org" in low:
            template = KaspaNetworkSettings.explorer_tx_template
        return KaspaNetworkSettings(
            rpc_mode=mode,
            rpc_url=_strip_url(self.rpc_url),
            history_mode=history_mode,
            history_api_base=history_api_base,
            explorer_tx_template=template,
        )

    def validate(self) -> None:
        norm = self.normalized()
        if norm.rpc_mode == "custom":
            if not norm.rpc_url:
                raise ValueError("Custom Kaspa node URL is required when not using the public resolver")
            if not _valid_http_url(norm.rpc_url, websockets=True):
                raise ValueError("Kaspa node URL must be a valid wss:// address")
        if norm.history_mode == "custom" and norm.history_api_base:
            if not _valid_http_url(norm.history_api_base):
                raise ValueError("Private Kaspa history API must be a valid http:// or https:// address")
        if _TXID_PLACEHOLDER not in norm.explorer_tx_template:
            raise ValueError("Kaspa explorer link must include {txid}")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self.normalized())

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> KaspaNetworkSettings:
        if not isinstance(raw, dict):
            return cls()
        rpc_mode = str(raw.get("rpc_mode") or "resolver")
        history_api_base = str(raw.get("history_api_base") or "")
        history_mode_raw = raw.get("history_mode")
        if history_mode_raw is None:
            # Migration: old own-node settings silently used api.kaspa.org.
            # Fail closed after upgrade unless a non-default private API was entered.
            if rpc_mode.strip().lower() == "custom":
                history_mode = (
                    "custom"
                    if history_api_base
                    and _strip_url(history_api_base) != cls.history_api_base
                    else "disabled"
                )
            else:
                history_mode = "public"
        else:
            history_mode = str(history_mode_raw)
        return cls(
            rpc_mode=rpc_mode,
            rpc_url=str(raw.get("rpc_url") or ""),
            history_mode=history_mode,
            history_api_base=history_api_base,
            explorer_tx_template=str(raw.get("explorer_tx_template") or cls.explorer_tx_template),
        )


@dataclass
class NetworkSettings:
    bitcoin: BitcoinNetworkSettings = field(default_factory=BitcoinNetworkSettings)
    kaspa: KaspaNetworkSettings = field(default_factory=KaspaNetworkSettings)

    def normalized(self) -> NetworkSettings:
        return NetworkSettings(
            bitcoin=self.bitcoin.normalized(),
            kaspa=self.kaspa.normalized(),
        )

    def validate(self) -> None:
        self.bitcoin.validate()
        self.kaspa.validate()

    def to_dict(self) -> dict[str, Any]:
        norm = self.normalized()
        return {
            "bitcoin": norm.bitcoin.to_dict(),
            "kaspa": norm.kaspa.to_dict(),
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> NetworkSettings:
        if not isinstance(raw, dict):
            return cls()
        return cls(
            bitcoin=BitcoinNetworkSettings.from_dict(raw.get("bitcoin")),
            kaspa=KaspaNetworkSettings.from_dict(raw.get("kaspa")),
        )


_settings_cache: NetworkSettings | None = None


def default_network_settings() -> NetworkSettings:
    return NetworkSettings()


def load_network_settings() -> NetworkSettings:
    global _settings_cache
    if _settings_cache is not None:
        return _settings_cache
    if not SETTINGS_FILE.is_file():
        _settings_cache = default_network_settings()
        return _settings_cache
    try:
        with SETTINGS_FILE.open(encoding="utf-8") as f:
            data = json.load(f)
        raw = NetworkSettings.from_dict(data if isinstance(data, dict) else None)
        norm = raw.normalized()
        _settings_cache = norm
        try:
            if raw.to_dict() != norm.to_dict():
                save_network_settings(norm)
        except Exception:
            pass
    except (OSError, json.JSONDecodeError, ValueError):
        _settings_cache = default_network_settings()
    return _settings_cache


def load_bitcoin_settings() -> BitcoinNetworkSettings:
    override = _bitcoin_settings_override.get()
    if override is not None:
        return override.normalized()
    return load_network_settings().bitcoin


class bitcoin_settings_override:
    def __init__(self, settings: BitcoinNetworkSettings) -> None:
        self._settings = settings.normalized()
        self._token = None

    def __enter__(self):
        self._token = _bitcoin_settings_override.set(self._settings)
        return self._settings

    def __exit__(self, exc_type, exc, tb):
        if self._token is not None:
            _bitcoin_settings_override.reset(self._token)


def save_network_settings(settings: NetworkSettings) -> NetworkSettings:
    global _settings_cache
    norm = settings.normalized()
    norm.validate()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with SETTINGS_FILE.open("w", encoding="utf-8") as f:
        json.dump(norm.to_dict(), f, indent=2)
        f.write("\n")
    _settings_cache = norm
    invalidate_network_clients()
    return norm


def invalidate_network_clients() -> None:
    from . import bitcoin_service
    from . import bitcoin_backend
    from .kaspa_service import get_service

    bitcoin_service.reset_http_client()
    bitcoin_backend.invalidate_backend_cache()
    try:
        svc = get_service()
        svc.mark_settings_changed()
    except Exception:
        pass


def explorer_tx_url(txid: str, *, coin: str) -> str:
    coin_key = (coin or "kaspa").strip().lower()
    settings = load_network_settings()
    template = (
        settings.bitcoin.explorer_tx_template
        if coin_key == "bitcoin"
        else settings.kaspa.explorer_tx_template
    )
    safe_txid = re.sub(r"[^0-9a-fA-F]", "", str(txid or ""))
    return template.replace(_TXID_PLACEHOLDER, safe_txid.lower())
