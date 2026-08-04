"""SeedMask Kaspa coordinator — local Sparrow-style web UI."""

from __future__ import annotations

import asyncio
import math
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .controller import Coordinator
from .coin_service import service_for
from .kaspa_service import SOMPI_PER_KAS, get_service
from .wallet_watcher import get_event_hub, get_wallet_watcher
from .sync_worker import get_sync_worker
from . import wallet_state
from .btc_script import script_type_from_derivation
from .kpub_parse import _normalize_xfp, extended_key_wallet_info, extract_kpub, extract_xpub
from .tx_pipeline import (
    build_unsigned_for_send,
    load_draft,
    merge_signed,
    parse_payee_qr_text,
    parse_qr_text,
    save_draft,
    sompi_from_kas,
    validate_address,
)
from .wallet_store import (
    get_active_wallet,
    get_wallet,
    list_wallets,
    load_store,
    set_active_wallet,
    update_wallet,
)

_coordinator = Coordinator()
_event_hub = get_event_hub()
_wallet_watcher = get_wallet_watcher(_coordinator)
_sync_worker = get_sync_worker(_coordinator)
# Per-chain full-scan caps — Bitcoin and Kaspa never share a queue.
_btc_network_sem = asyncio.Semaphore(2)
_kaspa_network_sem = asyncio.Semaphore(4)


def _network_sem_for_wallet_id(wallet_id: str) -> asyncio.Semaphore:
    from .wallet_store import resolved_wallet_coin

    cfg = get_wallet(wallet_id)
    if cfg and resolved_wallet_coin(cfg) == "bitcoin":
        return _btc_network_sem
    return _kaspa_network_sem

STATIC = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    wallet_state.init_db()
    _sync_worker.set_hub_publish(_event_hub.publish)
    await _wallet_watcher.start()
    try:
        from .transaction_history import ensure_kaspa_tip_pump

        ensure_kaspa_tip_pump()
    except Exception:
        pass
    yield
    # Best-effort teardown — never fail the process on shutdown (smoke tests / SIGTERM).
    # CancelledError is BaseException, so it must be caught explicitly or uvicorn logs
    # "ERROR: Application shutdown failed".
    async def _safe_await(awaitable) -> None:
        try:
            await awaitable
        except Exception:
            pass
        except asyncio.CancelledError:
            pass

    try:
        from .transaction_history import stop_kaspa_tip_pump

        await _safe_await(stop_kaspa_tip_pump())
    except Exception:
        pass
    try:
        await _safe_await(_wallet_watcher.stop())
    except Exception:
        pass
    try:
        await _safe_await(get_service().shutdown())
    except Exception:
        pass


app = FastAPI(title="SeedMask Kaspa Coordinator", lifespan=lifespan)


class MultisigCosignerIn(BaseModel):
    xpub: str
    fingerprint: str | None = None
    derivation: str | None = None
    label: str | None = None


class WalletIn(BaseModel):
    kpub: str
    label: str = "SeedMask"
    account: int = 0
    scan_limit: int = Field(default=30, ge=5, le=100)
    coin: str = "kaspa"
    derivation: str | None = None
    fingerprint: str | None = None
    script_type: str | None = None
    policy_type: str | None = None
    multisig_m: int | None = None
    multisig_n: int | None = None
    multisig_cosigners: list[MultisigCosignerIn] | None = None
    hardware: str | None = None
    keystore_label: str | None = None
    activate: bool = True


class WalletUpdateIn(BaseModel):
    label: str | None = None
    scan_limit: int | None = Field(default=None, ge=5, le=100)
    fingerprint: str | None = None
    hardware: str | None = None
    keystore_label: str | None = None
    multisig_cosigners: list[MultisigCosignerIn] | None = None


class BuildTxIn(BaseModel):
    utxo_key: str | None = None
    utxo_keys: list[str] | None = None
    utxos: list[FeeUtxoIn] | None = None
    to_address: str
    send_sompi: int | None = None
    send_kas: float | None = None
    fee_sompi: int | None = None
    wallet_id: str | None = None
    qr_display_mode: str | None = None
    rbf: bool = False
    use_generator: bool = False
    feerate_sat_vb: float | None = None
    custom_fee: bool = False


class RbfBumpIn(BaseModel):
    txid: str
    wallet_id: str | None = None
    fee_sompi: int | None = None
    feerate_sat_vb: float | None = None
    qr_display_mode: str | None = None


class LabelIn(BaseModel):
    label: str = ""


class DescriptorWalletIn(BaseModel):
    descriptor: str
    label: str = "Descriptor wallet"
    scan_limit: int | None = Field(default=None, ge=5, le=100)
    activate: bool = True


class WalletImportIn(BaseModel):
    export_json: dict
    activate: bool = True


class BuildSweepIn(BaseModel):
    """Multi-UTXO sweep → PSKB bundle (one PSKT per coin). SeedMask signs first tx only."""

    utxo_keys: list[str]
    to_address: str
    fee_sompi_per_tx: int
    wallet_id: str | None = None
    qr_display_mode: str | None = None


class FeeUtxoIn(BaseModel):
    key: str
    address: str
    address_index: int
    transaction_id: str
    output_index: int
    amount: int
    is_change: bool = False
    block_daa_score: int = 0
    is_coinbase: bool = False
    covenant_id: str | None = None
    covenantId: str | None = None


class UtxoCacheIn(BaseModel):
    coin: str | None = None
    utxos: list[FeeUtxoIn] = Field(default_factory=list)


class FeeEstimateIn(BaseModel):
    coin: str | None = None
    wallet_id: str | None = None
    utxo_amount_sompi: int | None = None
    utxos: list[FeeUtxoIn] | None = None
    input_count: int = 1
    output_count: int = 2
    feerate_sat_vb: float | None = None
    send_sompi: int | None = None
    to_address: str | None = None
    refine_max: bool = False
    priority_fee_sompi: int | None = None
    requested_fee_sompi: int | None = None


class FinishIn(BaseModel):
    draft_id: str
    signed: dict
    pskt_index: int = 0


class SweepQrIn(BaseModel):
    index: int = 0
    qr_display_mode: str | None = None


class ImportTxIn(BaseModel):
    unsigned: dict
    qr_display_mode: str | None = None


class ParseQrIn(BaseModel):
    text: str
    coin: str | None = None


class QrTextIn(BaseModel):
    text: str
    qr_display_mode: str | None = None
    """``ur`` (default) = BC-UR frames for SeedMask; ``plain`` = raw text in one QR (Kaspium / BlueWallet)."""
    encoding: str | None = None


class SignedQrFrameIn(BaseModel):
    text: str


class BitcoinNetworkSettingsIn(BaseModel):
    server_mode: str = "public"
    public_preset: str = "recommended"
    bitcoin_core_url: str = ""
    electrum_url: str = ""
    core_host: str = "127.0.0.1"
    core_port: int = 8332
    core_user: str = ""
    core_password: str = ""
    core_use_ssl: bool = False
    core_cookie_path: str = ""
    electrum_host: str = "127.0.0.1"
    electrum_port: int = 50002
    electrum_use_ssl: bool = True
    esplora_primary: str = "https://blockstream.info/api"
    esplora_fallbacks: list[str] = Field(
        default_factory=lambda: [
            "https://mempool.emzy.de/api",
            "https://mempool.space/api",
        ]
    )
    websocket_url: str = "wss://mempool.space/api/v1/ws"
    broadcast_urls: list[str] = Field(
        default_factory=lambda: [
            "https://mempool.space/api/tx",
            "https://blockstream.info/api/tx",
        ]
    )
    fee_recommended_url: str = "https://mempool.space/api/v1/fees/recommended"
    explorer_tx_template: str = "https://mempool.space/tx/{txid}"
    enable_legacy_fallbacks: bool = True


class KaspaNetworkSettingsIn(BaseModel):
    rpc_mode: str = "resolver"
    rpc_url: str = ""
    history_mode: str = "public"
    history_api_base: str = ""
    explorer_tx_template: str


class NetworkSettingsIn(BaseModel):
    bitcoin: BitcoinNetworkSettingsIn
    kaspa: KaspaNetworkSettingsIn


def _wallet_dict(cfg) -> dict:
    from .wallet_store import effective_wallet_account

    d = cfg.to_dict()
    d["account"] = effective_wallet_account(cfg)
    stored_deriv = str(d.get("derivation") or "").strip()
    stored_fp = str(d.get("fingerprint") or "").strip()
    stored_script = str(d.get("script_type") or "").strip()
    if stored_deriv and stored_fp:
        d["derivation"] = stored_deriv
        d["fingerprint"] = stored_fp
        if not stored_script and cfg.coin == "bitcoin":
            d["script_type"] = script_type_from_derivation(stored_deriv)
        return d
    try:
        meta = extended_key_wallet_info(cfg.kpub, coin=cfg.coin)
        d["derivation"] = stored_deriv or meta["derivation"]
        d["fingerprint"] = stored_fp or meta["fingerprint"]
        d["script_type"] = stored_script or meta.get("script_type") or ""
    except ValueError:
        if not stored_deriv:
            acct = effective_wallet_account(cfg)
            if cfg.coin == "bitcoin":
                d["derivation"] = f"m/84'/0'/{acct}'"
            else:
                d["derivation"] = f"m/44'/111111'/{acct}'"
        else:
            d["derivation"] = stored_deriv
        d["fingerprint"] = stored_fp
        d["script_type"] = stored_script
    if cfg.coin == "bitcoin" and not d.get("script_type"):
        d["script_type"] = script_type_from_derivation(d.get("derivation"))
    if cfg.coin == "bitcoin":
        from .kpub_parse import resolve_bitcoin_master_fingerprint

        try:
            resolve_bitcoin_master_fingerprint(cfg.kpub, cfg.fingerprint)
            d["psbt_signing_ready"] = True
        except ValueError as e:
            d["psbt_signing_ready"] = False
            d["psbt_signing_error"] = str(e)
    return d


def _app_version() -> str:
    root = os.environ.get("SEEDPASS_COORDINATOR_ROOT", "").strip()
    if root:
        ver = Path(root) / "VERSION.txt"
        if ver.is_file():
            return ver.read_text(encoding="utf-8").strip()
    return ""


def _build_stamp() -> str:
    ver = _app_version()
    return f"v{ver}" if ver else ""


def _resolve_wallet_id(wallet_id: str | None) -> str:
    if wallet_id:
        if not get_wallet(wallet_id):
            raise HTTPException(404, "Wallet not found")
        return wallet_id
    active = get_active_wallet()
    if not active:
        raise HTTPException(400, "No watch-only wallet — add kpub first")
    return active.id


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/status")
async def status():
    from .network_settings import load_network_settings

    store = load_store()
    active = get_active_wallet()
    net = load_network_settings()
    summaries = wallet_state.get_all_wallet_summaries()
    wallets_out = []
    for w in store.wallets:
        d = _wallet_dict(w)
        snap = summaries.get(w.id)
        if snap:
            d["cached_balance_sompi"] = snap["balance_sompi"]
            d["cached_balance_kas"] = snap["balance_kas"]
            d["sync_status"] = snap["sync_status"]
        wallets_out.append(d)
    return {
        "wallet_configured": active is not None,
        "network": "mainnet",
        "build_stamp": _build_stamp(),
        "wallet": _wallet_dict(active) if active else None,
        "active_wallet_id": store.active_wallet_id,
        "active_wallet_by_coin": dict(store.active_wallet_by_coin),
        "wallets": wallets_out,
        "wallet_summaries": summaries,
        "network_settings": net.to_dict(),
    }


@app.get("/api/wallets/{wallet_id}/state")
async def wallet_state_get(wallet_id: str, include_transactions: bool = True):
    """Instant wallet snapshot from local DB — no network scan."""
    _resolve_wallet_id(wallet_id)
    cfg = get_wallet(wallet_id)
    if not cfg:
        raise HTTPException(404, "Wallet not found")
    from .wallet_store import resolved_wallet_coin

    coin = resolved_wallet_coin(cfg)
    wallet_state.sanitize_wallet_balance(wallet_id, coin=coin)
    state = wallet_state.get_wallet_state(wallet_id, include_transactions=include_transactions)
    state["coin"] = coin
    return state


@app.post("/api/wallets/{wallet_id}/sync")
async def wallet_sync_enqueue(
    wallet_id: str,
    mode: str = "hot",
    wait: bool = False,
):
    """Enqueue background sync (hot | discover | deep). UI reads /state immediately."""
    _resolve_wallet_id(wallet_id)
    if mode not in ("hot", "discover", "deep"):
        raise HTTPException(400, "mode must be hot, discover, or deep")
    from .sync_worker import SyncPriority

    priority = SyncPriority.ACTIVE_HOT if mode == "hot" else SyncPriority.BACKGROUND_DEEP
    try:
        result = await _sync_worker.enqueue(
            wallet_id,
            mode,
            priority=priority,
            wait=wait,
        )
        if wait and result:
            return result
        return {"ok": True, "wallet_id": wallet_id, "mode": mode, "queued": True}
    except Exception as e:
        raise HTTPException(502, str(e)) from e


@app.get("/api/settings/network")
async def network_settings_get():
    from .network_settings import default_network_settings, load_network_settings

    current = load_network_settings()
    return {
        "settings": current.to_dict(),
        "defaults": default_network_settings().to_dict(),
    }


@app.put("/api/settings/network")
async def network_settings_put(body: NetworkSettingsIn):
    from .network_settings import (
        BitcoinNetworkSettings,
        KaspaNetworkSettings,
        NetworkSettings,
        save_network_settings,
    )

    try:
        saved = save_network_settings(
            NetworkSettings(
                bitcoin=BitcoinNetworkSettings.from_dict(body.bitcoin.model_dump()),
                kaspa=KaspaNetworkSettings.from_dict(body.kaspa.model_dump()),
            )
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"settings": saved.to_dict()}


@app.post("/api/settings/network/test-bitcoin")
async def network_settings_test_bitcoin(body: BitcoinNetworkSettingsIn):
    from .bitcoin_backend import test_bitcoin_connection
    from .network_settings import BitcoinNetworkSettings

    try:
        BitcoinNetworkSettings.from_dict(body.model_dump()).validate()
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    try:
        return await test_bitcoin_connection(body.model_dump())
    except Exception as e:
        return {
            "ok": False,
            "mode": body.server_mode,
            "summary": str(e),
            "steps": [str(e)],
        }


@app.get("/api/wallets")
async def wallets_list():
    store = load_store()
    return {
        "active_wallet_id": store.active_wallet_id,
        "active_wallet_by_coin": dict(store.active_wallet_by_coin),
        "wallets": [_wallet_dict(w) for w in store.wallets],
    }


@app.post("/api/wallets")
async def wallets_create(body: WalletIn):
    try:
        coin = (body.coin or "kaspa").strip().lower()
        meta = extended_key_wallet_info(body.kpub, coin=coin)
        key = meta["kpub"]
        derivation = (body.derivation or meta.get("derivation") or "").strip()
        fingerprint = (body.fingerprint or meta.get("fingerprint") or "").strip()
        if coin == "bitcoin":
            from .kpub_parse import is_placeholder_fingerprint, resolve_bitcoin_master_fingerprint

            if is_placeholder_fingerprint(fingerprint):
                raise HTTPException(
                    400,
                    "Invalid master fingerprint (placeholder). "
                    "Scan the SeedMask Bitcoin watch-only QR (SM|xfp|m/84'/0'/0'|zpub…).",
                )
            try:
                fingerprint = resolve_bitcoin_master_fingerprint(key, fingerprint)
            except ValueError as e:
                raise HTTPException(400, str(e)) from e
        script_type = (body.script_type or meta.get("script_type") or "").strip()
        from .btc_script import policy_type_from_derivation, validate_multisig_quorum

        policy_type = (body.policy_type or "").strip()
        raw_cosigners = body.multisig_cosigners or []
        if raw_cosigners and coin in {"bitcoin", "kaspa"}:
            policy_type = "multisig"
        elif not policy_type and coin == "bitcoin":
            policy_type = policy_type_from_derivation(derivation)
        elif (
            coin == "bitcoin"
            and policy_type != "multisig"
            and policy_type_from_derivation(derivation) == "multisig"
        ):
            raise HTTPException(
                400,
                "This derivation path is for multisig — choose Policy type MultiSig and add every cosigner xpub",
            )
        multisig_m = int(body.multisig_m or 0)
        multisig_n = int(body.multisig_n or 0)
        multisig_cosigners: list[dict] = []
        if policy_type == "multisig":
            if not validate_multisig_quorum(multisig_m, multisig_n):
                raise HTTPException(400, "Multisig quorum required — set M-of-N (e.g. 2 of 3)")
            if len(raw_cosigners) != multisig_n:
                raise HTTPException(
                    400,
                    f"Multisig needs {multisig_n} cosigner {'kpubs' if coin == 'kaspa' else 'xpubs'} — add one card per cosigner",
                )
            if coin == "kaspa":
                script_type = script_type or "p2sh"
            for idx, cosigner in enumerate(raw_cosigners, start=1):
                try:
                    xpub = extract_kpub(cosigner.xpub) if coin == "kaspa" else extract_xpub(cosigner.xpub)
                except ValueError as e:
                    raise HTTPException(400, f"Cosigner {idx}: {e}") from e
                from .btc_script import DEFAULT_MULTISIG_COSIGNER_DERIVATION

                default_deriv = f"m/45'/111111'/{int(body.account or 0)}'" if coin == "kaspa" else DEFAULT_MULTISIG_COSIGNER_DERIVATION
                cosigner_deriv = (cosigner.derivation or derivation or default_deriv).strip()
                multisig_cosigners.append(
                    {
                        "xpub": xpub,
                        "fingerprint": _normalize_xfp(cosigner.fingerprint) or "",
                        "derivation": cosigner_deriv or default_deriv,
                        "label": (cosigner.label or "").strip(),
                    }
                )
            key = multisig_cosigners[0]["xpub"]
            if not fingerprint:
                fingerprint = multisig_cosigners[0].get("fingerprint") or ""
        else:
            multisig_m = 0
            multisig_n = 0
            multisig_cosigners = []
        account = int(meta.get("account", body.account))
        cfg = _coordinator.create_wallet(
            kpub=key,
            label=body.label.strip() or "SeedMask",
            scan_limit=body.scan_limit,
            account=account,
            coin=coin,
            derivation=derivation,
            fingerprint=fingerprint,
            script_type=script_type,
            policy_type=policy_type,
            multisig_m=multisig_m,
            multisig_n=multisig_n,
            multisig_cosigners=multisig_cosigners,
            hardware=(body.hardware or "").strip().lower(),
            keystore_label=(body.keystore_label or "").strip(),
            activate=body.activate,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True, "wallet": _wallet_dict(cfg)}


@app.get("/api/wallets/{wallet_id}")
async def wallets_get(wallet_id: str):
    cfg = get_wallet(wallet_id)
    if not cfg:
        raise HTTPException(404, "Wallet not found")
    return {"wallet": _wallet_dict(cfg)}


@app.put("/api/wallets/{wallet_id}")
async def wallets_update(wallet_id: str, body: WalletUpdateIn):
    try:
        multisig_cosigners: list[dict] | None = None
        if body.multisig_cosigners is not None:
            multisig_cosigners = [
                {
                    "xpub": cosigner.xpub.strip(),
                    "fingerprint": _normalize_xfp(cosigner.fingerprint) or "",
                    "derivation": (cosigner.derivation or "").strip(),
                    "label": (cosigner.label or "").strip(),
                }
                for cosigner in body.multisig_cosigners
            ]
        fingerprint = _normalize_xfp(body.fingerprint) if body.fingerprint is not None else None
        cfg = update_wallet(
            wallet_id,
            label=body.label,
            scan_limit=body.scan_limit,
            fingerprint=fingerprint,
            hardware=body.hardware,
            keystore_label=body.keystore_label,
            multisig_cosigners=multisig_cosigners,
        )
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return {"ok": True, "wallet": _wallet_dict(cfg)}


@app.delete("/api/wallets/{wallet_id}")
async def wallets_delete(wallet_id: str):
    if not get_wallet(wallet_id):
        raise HTTPException(404, "Wallet not found")
    _coordinator.delete_wallet(wallet_id)
    return {"ok": True}


@app.post("/api/wallets/{wallet_id}/activate")
async def wallets_activate(wallet_id: str):
    try:
        cfg = set_active_wallet(wallet_id)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return {"ok": True, "wallet": _wallet_dict(cfg)}


@app.post("/api/kpub/parse")
async def kpub_parse(body: ParseQrIn):
    try:
        meta = extended_key_wallet_info(body.text, coin=body.coin)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return meta


# Legacy single-wallet routes (active wallet).
@app.post("/api/wallet")
async def set_wallet(body: WalletIn):
    return await wallets_create(body)


@app.delete("/api/wallet")
async def remove_wallet():
    active = get_active_wallet()
    if not active:
        return {"ok": True}
    _coordinator.delete_wallet(active.id)
    return {"ok": True}


@app.post("/api/wallets/{wallet_id}/refresh/discover")
async def refresh_wallet_discover(wallet_id: str):
    _resolve_wallet_id(wallet_id)
    cfg = get_wallet(wallet_id)
    from .wallet_store import resolved_wallet_coin

    coin = resolved_wallet_coin(cfg) if cfg else "unknown"
    try:
        data = await _coordinator.refresh_discover(wallet_id=wallet_id)
        return {
            **data,
            "address_count": cfg.scan_limit if cfg else 0,
        }
    except Exception as e:
        label = "Bitcoin" if coin == "bitcoin" else "Kaspa" if coin == "kaspa" else coin.title()
        raise HTTPException(502, f"{label} network error: {e}") from e


@app.post("/api/wallets/{wallet_id}/refresh/discover/stream")
async def refresh_wallet_discover_stream(wallet_id: str):
    """Stream discovery refresh with live progress (SSE)."""
    import asyncio
    import json

    _resolve_wallet_id(wallet_id)
    cfg = get_wallet(wallet_id)
    if not cfg:
        raise HTTPException(404, "Wallet not found")
    from .wallet_store import resolved_wallet_coin

    coin = resolved_wallet_coin(cfg)

    async def event_stream():
        queue: asyncio.Queue[tuple[str, object]] = asyncio.Queue()

        def on_progress(msg: str) -> None:
            try:
                queue.put_nowait(("progress", msg))
            except asyncio.QueueFull:
                pass

        async def run_discover() -> None:
            try:
                data = await _coordinator.refresh_discover(wallet_id=wallet_id, on_progress=on_progress)
                await queue.put(("complete", data))
            except Exception as e:
                await queue.put(("error", str(e)))

        task = asyncio.create_task(run_discover())
        yield "event: connected\ndata: {}\n\n"
        while True:
            kind, payload = await queue.get()
            if kind == "progress":
                yield f"event: progress\ndata: {json.dumps({'message': payload})}\n\n"
            elif kind == "complete":
                body = {**(payload if isinstance(payload, dict) else {}), "address_count": cfg.scan_limit}
                yield f"event: complete\ndata: {json.dumps(body)}\n\n"
                break
            elif kind == "error":
                label = "Bitcoin" if coin == "bitcoin" else "Kaspa" if coin == "kaspa" else coin.title()
                yield f"event: error\ndata: {json.dumps({'message': f'{label} network error: {payload}'})}\n\n"
                break
        await task

    from starlette.responses import StreamingResponse

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/wallets/{wallet_id}/refresh/watch")
async def refresh_wallet_watch(wallet_id: str):
    _resolve_wallet_id(wallet_id)
    cfg = get_wallet(wallet_id)
    from .wallet_store import resolved_wallet_coin

    coin = resolved_wallet_coin(cfg) if cfg else "unknown"
    try:
        data = await _sync_worker.enqueue(wallet_id, "hot", wait=True)
        if not data:
            data = await _coordinator.refresh_watch(wallet_id=wallet_id)
        return {
            **data,
            "address_count": cfg.scan_limit if cfg else 0,
        }
    except Exception as e:
        label = "Bitcoin" if coin == "bitcoin" else "Kaspa" if coin == "kaspa" else coin.title()
        raise HTTPException(502, f"{label} network error: {e}") from e


async def _refresh_wallet_watch(wallet_id: str) -> dict:
    return await _coordinator.refresh_watch(wallet_id=wallet_id)


@app.post("/api/wallets/{wallet_id}/refresh")
async def refresh_wallet_by_id(wallet_id: str):
    _resolve_wallet_id(wallet_id)
    cfg = get_wallet(wallet_id)
    from .wallet_store import resolved_wallet_coin

    coin = resolved_wallet_coin(cfg) if cfg else "unknown"
    try:
        from .network_priority import run_deep_scan

        async def _run() -> dict:
            sem = _network_sem_for_wallet_id(wallet_id)
            async with sem:
                return await _coordinator.refresh(wallet_id=wallet_id)

        data = await run_deep_scan(coin, _run)
        return {
            **data,
            "address_count": cfg.scan_limit if cfg else 0,
        }
    except Exception as e:
        label = "Bitcoin" if coin == "bitcoin" else "Kaspa" if coin == "kaspa" else coin.title()
        raise HTTPException(502, f"{label} network error: {e}") from e


@app.post("/api/wallets/{wallet_id}/refresh/stream")
async def refresh_wallet_stream(wallet_id: str):
    """Stream wallet refresh with live progress (SSE)."""
    import asyncio
    import json

    _resolve_wallet_id(wallet_id)
    cfg = get_wallet(wallet_id)
    if not cfg:
        raise HTTPException(404, "Wallet not found")
    from .wallet_store import resolved_wallet_coin

    coin = resolved_wallet_coin(cfg)

    async def event_stream():
        queue: asyncio.Queue[tuple[str, object]] = asyncio.Queue()

        def on_progress(msg: str) -> None:
            try:
                queue.put_nowait(("progress", msg))
            except asyncio.QueueFull:
                pass

        async def run_refresh() -> None:
            try:
                from .network_priority import run_deep_scan

                async def _run() -> dict:
                    sem = _network_sem_for_wallet_id(wallet_id)
                    async with sem:
                        return await _coordinator.refresh(wallet_id=wallet_id, on_progress=on_progress)

                data = await run_deep_scan(coin, _run)
                await queue.put(("complete", data))
            except Exception as e:
                await queue.put(("error", str(e)))

        task = asyncio.create_task(run_refresh())
        yield "event: connected\ndata: {}\n\n"
        while True:
            kind, payload = await queue.get()
            if kind == "progress":
                yield f"event: progress\ndata: {json.dumps({'message': payload})}\n\n"
            elif kind == "complete":
                body = {**(payload if isinstance(payload, dict) else {}), "address_count": cfg.scan_limit}
                yield f"event: complete\ndata: {json.dumps(body)}\n\n"
                break
            elif kind == "error":
                label = "Bitcoin" if coin == "bitcoin" else "Kaspa" if coin == "kaspa" else coin.title()
                yield f"event: error\ndata: {json.dumps({'message': f'{label} network error: {payload}'})}\n\n"
                break
        await task

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/wallets/{wallet_id}/events")
async def wallet_events(wallet_id: str):
    """Server-sent events stream for live balance updates."""
    import asyncio
    import json

    _resolve_wallet_id(wallet_id)

    async def event_stream():
        queue = await _event_hub.subscribe(wallet_id)
        await _wallet_watcher.subscriber_connected(wallet_id)
        try:
            yield "event: connected\ndata: {}\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=25.0)
                    yield f"event: balance\ndata: {json.dumps(payload)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            await _event_hub.unsubscribe(wallet_id, queue)
            await _wallet_watcher.subscriber_disconnected(wallet_id)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/wallet/refresh")
async def refresh_wallet():
    raise HTTPException(
        400,
        "Use POST /api/wallets/{wallet_id}/refresh for the wallet you are viewing.",
    )


@app.get("/api/wallets/{wallet_id}/balance")
async def get_balance_by_id(wallet_id: str):
    _resolve_wallet_id(wallet_id)
    cfg = get_wallet(wallet_id)
    if not cfg:
        raise HTTPException(404, "Wallet not found")
    cached = _coordinator.get_cached_balance(wallet_id)
    if cached:
        return cached
    # Balance reads never scan the network — use POST /refresh explicitly.
    if cfg.coin == "bitcoin":
        return {
            "wallet_id": wallet_id,
            "balance_sats": 0,
            "balance_btc": 0.0,
            "balance_sompi": 0,
            "balance_kas": 0.0,
            "utxos": [],
            "coin": "bitcoin",
        }
    return {
        "wallet_id": wallet_id,
        "balance_sompi": 0,
        "balance_kas": 0.0,
        "utxos": [],
        "coin": "kaspa",
    }


@app.get("/api/wallet/balance")
async def get_balance():
    wid = _resolve_wallet_id(None)
    return await get_balance_by_id(wid)


@app.get("/api/wallets/{wallet_id}/addresses")
async def list_addresses_by_id(wallet_id: str):
    cfg = get_wallet(wallet_id)
    if not cfg:
        raise HTTPException(404, "Wallet not found")
    addrs = service_for(cfg).receive_addresses(cfg)
    return {"addresses": [{"index": i, "address": a} for i, a in addrs]}


async def _resolve_build_wutxos(
    wid: str,
    cfg,
    *,
    keys: list[str],
    snapshots: list | None,
) -> list:
    """Resolve WalletUtxo list for tx build — prefer client snapshots (matches fee quote)."""
    from .kaspa_service import WalletUtxo, get_service
    from .send_fees import wallet_utxo_from_dict

    if snapshots:
        wutxos = [wallet_utxo_from_dict(u.model_dump() if hasattr(u, "model_dump") else u) for u in snapshots]
    else:
        selected = await _wallet_utxos_for_keys(wid, keys)
        if len(selected) != len(keys):
            missing = len(keys) - len(selected)
            raise HTTPException(
                400,
                f"UTXO not found ({missing} missing) — refresh wallet and retry",
            )
        wutxos = [wallet_utxo_from_dict(u) for u in selected]

    if (cfg.coin or "kaspa").strip().lower() == "kaspa":
        wutxos = get_service().reclassify_utxos(cfg, wutxos)
    return wutxos


async def _wallet_utxos_for_keys(wallet_id: str, keys: list[str]) -> list[dict]:
    """Resolve UTXO dicts for keys; lightweight watch refresh if cache is stale."""
    keys = [k.strip() for k in keys if k and k.strip()]
    if not keys:
        return []

    def _pick(utxos: list[dict]) -> list[dict]:
        selected: list[dict] = []
        for key in keys:
            u = next((x for x in utxos if x["key"] == key), None)
            if u:
                selected.append(u)
        return selected

    _coordinator._hydrate_from_disk(wallet_id)
    cached = _coordinator.get_cached_balance(wallet_id)
    utxos = (cached or {}).get("utxos") or []
    selected = _pick(utxos)
    if len(selected) < len(keys):
        await _refresh_wallet_watch(wallet_id)
        cached = _coordinator.get_cached_balance(wallet_id)
        utxos = (cached or {}).get("utxos") or []
        selected = _pick(utxos)
    return selected


def _wallet_utxos_from_cache(wallet_id: str) -> list:
    from .kaspa_service import WalletUtxo, get_service

    cfg = get_wallet(wallet_id)
    cached = _coordinator.get_cached_balance(wallet_id)
    utxo_dicts = (cached or {}).get("utxos") or []
    utxos = [
        WalletUtxo(
            address=u["address"],
            address_index=int(u["address_index"]),
            transaction_id=u["transaction_id"],
            output_index=int(u["output_index"]),
            amount=int(u["amount"]),
            is_change=bool(u.get("is_change")),
            block_daa_score=int(u.get("block_daa_score") or u.get("blockDaaScore") or 0),
            is_coinbase=bool(u.get("is_coinbase") or u.get("isCoinbase") or False),
            covenant_id=u.get("covenant_id") or u.get("covenantId"),
        )
        for u in utxo_dicts
    ]
    if cfg and (cfg.coin or "kaspa").strip().lower() == "kaspa":
        return get_service().reclassify_utxos(cfg, utxos)
    return utxos


@app.post("/api/wallets/{wallet_id}/utxos/cache")
async def push_wallet_utxo_cache(wallet_id: str, body: UtxoCacheIn):
    """Deprecated — backend owns wallet state. No-op for compatibility."""
    return {"ok": True, "count": 0, "deprecated": True}


@app.get("/api/wallets/{wallet_id}/addresses/detailed")
async def addresses_detailed(wallet_id: str, balances: bool = True):
    cfg = get_wallet(wallet_id)
    if not cfg:
        raise HTTPException(404, "Wallet not found")
    # Addresses are derived offline from kpub/xpub; balances use cached UTXOs only (no forced refresh).
    utxos = _wallet_utxos_from_cache(wallet_id) if balances else []
    return service_for(cfg).address_book(cfg, utxos or [], wallet_id=wallet_id)


@app.get("/api/wallets/{wallet_id}/transactions")
async def wallet_transactions(wallet_id: str, q: str | None = None, refresh: bool = False):
    from .labels_store import apply_labels_to_transactions, search_transactions
    from .tx_index import get_cached_transactions, sync_wallet_transactions

    cfg = get_wallet(wallet_id)
    if not cfg:
        raise HTTPException(404, "Wallet not found")

    dicts = get_cached_transactions(wallet_id, q)
    if refresh or not dicts:
        utxos_raw = _wallet_utxos_from_cache(wallet_id)
        utxo_dicts = [u.to_dict() if hasattr(u, "to_dict") else dict(u) for u in utxos_raw]
        try:
            dicts = await sync_wallet_transactions(wallet_id, cfg, utxo_dicts)
        except Exception:
            if not dicts:
                from .transaction_history import fetch_wallet_transactions
                from .address_pairs import bounded_address_pairs

                receive, change = bounded_address_pairs(cfg, utxos_raw or [])
                rows = await fetch_wallet_transactions(cfg, receive, change, utxos_raw or [])
                dicts = [t.to_dict() for t in rows]
    # Always fold in just-broadcast sends (indexer / hot-sync lag).
    from .transaction_history import (
        _dedupe_tx_dicts,
        enrich_counterparties_from_raw_cache,
        merge_outgoing_into_tx_dicts,
        merge_receive_utxos_into_tx_dicts,
    )
    from .wallet_store import resolved_wallet_coin
    from .address_pairs import bounded_address_pairs

    dicts = _dedupe_tx_dicts(dicts or [])
    dicts = merge_outgoing_into_tx_dicts(wallet_id, dicts or [])
    dicts = merge_receive_utxos_into_tx_dicts(
        dicts,
        _wallet_utxos_from_cache(wallet_id),
        coin=resolved_wallet_coin(cfg),
    )
    dicts = _dedupe_tx_dicts(dicts)
    receive_pairs, change_pairs = bounded_address_pairs(
        cfg,
        _wallet_utxos_from_cache(wallet_id) or [],
    )
    dicts = enrich_counterparties_from_raw_cache(
        wallet_id,
        dicts,
        receive_pairs=receive_pairs,
        change_pairs=change_pairs,
        coin=resolved_wallet_coin(cfg),
    )
    dicts = apply_labels_to_transactions(wallet_id, dicts)
    from . import wallet_state as _ws

    if (cfg.coin or "kaspa").strip().lower() == "bitcoin":
        from .tx_visualize import _btc_chain_tip_height

        tip = 0
        try:
            tip = int(await _btc_chain_tip_height() or 0)
        except Exception:
            tip = 0
        refreshed: list[dict] = []
        from .tx_raw_cache import cached_wallet_tx
        from .transaction_history import _norm_txid

        for d in dicts:
            btc = float(d.get("amount_kas") or 0)
            d["amount_btc"] = btc
            d["amount_sats"] = int(round(btc * 100_000_000))
            try:
                bh = int(d.get("block_height") or 0)
            except (TypeError, ValueError):
                bh = 0
            if bh <= 0:
                # Heal older rows that only stored a fake confirmations count.
                try:
                    raw = cached_wallet_tx(wallet_id, _norm_txid(str(d.get("transaction_id") or "")))
                    if isinstance(raw, dict):
                        status = raw.get("status") if isinstance(raw.get("status"), dict) else {}
                        bh = int(
                            status.get("block_height")
                            or raw.get("block_height")
                            or raw.get("block_index")
                            or 0
                        )
                        if bh > 0:
                            d["block_height"] = bh
                except Exception:
                    bh = 0
            try:
                prev_conf = int(d.get("confirmations") or 0)
            except (TypeError, ValueError):
                prev_conf = 0
            if tip > 0 and bh > 0 and tip >= bh:
                # Real depth only — never invent ages like "3 confirmations".
                d["confirmations"] = max(1, tip - bh + 1)
                if d["confirmations"] != prev_conf or d.get("block_height") != bh:
                    d["block_height"] = bh
                    refreshed.append(d)
            elif bh > 0:
                # Mined but tip unavailable: leave count unknown (UI shows Confirmed).
                d["confirmations"] = 0
                d["block_height"] = bh
            # Do not force rbf=False for confirmed txs — RBF signal is historical fact.
        if refreshed:
            try:
                _ws.upsert_transactions(wallet_id, refreshed)
            except Exception:
                pass
    elif (cfg.coin or "kaspa").strip().lower() == "kaspa":
        from .transaction_history import refresh_kaspa_confirmation_counts

        dicts = await refresh_kaspa_confirmation_counts(dicts)
        # Persist accepting blue + live conf so the next tip poll advances at ~10 BPS
        # instead of re-deriving from wall-clock age each request.
        try:
            _ws.upsert_transactions(wallet_id, dicts)
        except Exception:
            pass
    dicts = search_transactions(dicts, q or "")
    meta = _ws.get_sync_meta(wallet_id)
    return {
        "transactions": dicts,
        "sync_status": (meta or {}).get("sync_status", _ws.SYNC_CACHED),
    }


@app.get("/api/kaspa/tip-blue")
async def kaspa_tip_blue():
    """Current Kaspa VSPC blue score (tip) — cheap poll for smooth confirmation UI."""
    from .transaction_history import get_kaspa_tip_blue

    return await get_kaspa_tip_blue(force=True)


@app.get("/api/wallets/{wallet_id}/kaspa-confirmations")
async def wallet_kaspa_confirmations(wallet_id: str):
    """Lightweight live confirmation tick (tip − accepting blue) for Kaspa dashboards."""
    cfg = get_wallet(wallet_id)
    if not cfg:
        raise HTTPException(404, "Wallet not found")
    if (cfg.coin or "kaspa").strip().lower() != "kaspa":
        return {"tip_blue": 0, "bps": 10, "server_time_ms": 0, "updates": []}
    from .transaction_history import tick_kaspa_confirmations

    return await tick_kaspa_confirmations(wallet_id)


@app.get("/api/wallets/{wallet_id}/transactions/{txid}/visualize")
async def wallet_transaction_visualize(wallet_id: str, txid: str):
    from .tx_visualize import visualize_wallet_transaction
    from .wallet_store import resolved_wallet_coin

    cfg = get_wallet(wallet_id)
    if not cfg:
        raise HTTPException(404, "Wallet not found")
    from .address_pairs import bounded_address_pairs

    utxos = _wallet_utxos_from_cache(wallet_id)
    receive, change = bounded_address_pairs(cfg, utxos or [])
    coin = resolved_wallet_coin(cfg)
    try:
        return await visualize_wallet_transaction(
            wallet_id,
            txid,
            receive_pairs=receive,
            change_pairs=change,
            coin=coin,
            cfg=cfg,
            utxos=utxos or [],
        )
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


@app.post("/api/tx/rbf-bump")
async def tx_rbf_bump(body: RbfBumpIn):
    """Build a BIP125 RBF replacement PSBT for an unconfirmed Bitcoin send."""
    wid = _resolve_wallet_id(body.wallet_id)
    cfg = get_wallet(wid)
    if not cfg:
        raise HTTPException(400, "Configure watch-only wallet first")
    if (cfg.coin or "").strip().lower() != "bitcoin":
        raise HTTPException(400, "RBF speed-up is only available for Bitcoin")

    txid = (body.txid or "").strip().lower()
    if len(txid) != 64:
        raise HTTPException(400, "Invalid transaction id")

    from .address_pairs import bounded_address_pairs
    from .transaction_history import fetch_btc_tx_by_id
    from .tx_pipeline import save_draft_from_rbf_bump
    from .tx_raw_cache import cached_wallet_tx, remember_wallet_txs
    from .ur_qr_psbt import fountain_qr_frames_base64_psbt

    utxos = _wallet_utxos_from_cache(wid)
    receive, change = bounded_address_pairs(cfg, utxos or [])
    original = cached_wallet_tx(wid, txid)
    if not original:
        original = await fetch_btc_tx_by_id(txid)
        if original:
            remember_wallet_txs(wid, {txid: original})
    if not original:
        raise HTTPException(404, "Transaction not found — refresh wallet and try again")

    status = original.get("status") or {}
    if status.get("confirmed") or (
        isinstance(status.get("block_height"), int) and int(status.get("block_height") or 0) > 0
    ):
        raise HTTPException(400, "Transaction is already confirmed — RBF is no longer possible")

    vins = original.get("vin") or []
    vouts = original.get("vout") or original.get("out") or []
    total_in = 0
    for inp in vins:
        prev = inp.get("prevout") or {}
        total_in += int(prev.get("value") or 0)
    total_out = sum(int(o.get("value") or 0) for o in vouts)
    old_fee = max(0, total_in - total_out)
    input_count = max(1, len(vins))
    output_count = max(1, len(vouts))

    new_fee = body.fee_sompi
    if new_fee is None:
        from .bitcoin_fees import estimate_vbytes, fetch_recommended_feerates

        try:
            rates = await fetch_recommended_feerates()
            rate = float(body.feerate_sat_vb or rates.get("fastest") or rates.get("halfHour") or 2)
        except Exception:
            rate = float(body.feerate_sat_vb or 2)
        vbytes = estimate_vbytes(input_count=input_count, output_count=output_count)
        new_fee = max(old_fee + 1, math.ceil(rate * vbytes))
    new_fee = int(new_fee)
    if new_fee <= old_fee:
        new_fee = old_fee + max(100, input_count * 50)

    try:
        draft_id, psbt_bytes, summary = await asyncio.to_thread(
            save_draft_from_rbf_bump,
            cfg,
            original,
            receive_pairs=receive,
            change_pairs=change,
            new_fee_sats=new_fee,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    try:
        qr_pack = await asyncio.to_thread(
            fountain_qr_frames_base64_psbt,
            psbt_bytes,
            qr_display_mode=body.qr_display_mode or "animated",
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    return {
        "draft_id": draft_id,
        "unsigned": summary,
        "coin": "bitcoin",
        "summary": summary,
        **qr_pack,
    }


@app.get("/api/wallets/{wallet_id}/labels")
async def wallet_labels_get(wallet_id: str):
    from .labels_store import list_labels

    if not get_wallet(wallet_id):
        raise HTTPException(404, "Wallet not found")
    return list_labels(wallet_id)


@app.put("/api/wallets/{wallet_id}/labels/address/{address}")
async def wallet_label_address(wallet_id: str, address: str, body: LabelIn):
    from .labels_store import set_address_label

    if not get_wallet(wallet_id):
        raise HTTPException(404, "Wallet not found")
    try:
        return set_address_label(wallet_id, address, body.label)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.put("/api/wallets/{wallet_id}/labels/tx/{txid}")
async def wallet_label_tx(wallet_id: str, txid: str, body: LabelIn):
    from .labels_store import set_tx_label

    if not get_wallet(wallet_id):
        raise HTTPException(404, "Wallet not found")
    try:
        return set_tx_label(wallet_id, txid, body.label)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/wallets/{wallet_id}/export")
async def wallet_export(wallet_id: str):
    from .wallet_export import export_wallet_bundle

    try:
        return export_wallet_bundle(wallet_id)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


@app.get("/api/wallets/export-all")
async def wallets_export_all():
    from .wallet_export import export_all_wallets_bundle

    return export_all_wallets_bundle()


@app.post("/api/wallets/import")
async def wallet_import(body: WalletImportIn):
    from .wallet_export import import_wallet_bundle

    try:
        cfg = import_wallet_bundle(body.export_json, activate=body.activate)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"wallet": cfg.to_dict()}


@app.post("/api/descriptor/parse")
async def descriptor_parse(body: DescriptorWalletIn):
    from .descriptor_wallet import export_descriptor, wallet_from_descriptor

    try:
        parsed = wallet_from_descriptor(body.descriptor, label=body.label)
        preview = export_descriptor(parsed)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {
        "descriptor": preview,
        "wallet": parsed.to_dict(),
    }


@app.get("/api/wallets/{wallet_id}/descriptor")
async def wallet_descriptor_export(wallet_id: str):
    from .descriptor_wallet import export_descriptor

    cfg = get_wallet(wallet_id)
    if not cfg:
        raise HTTPException(404, "Wallet not found")
    try:
        text = export_descriptor(cfg)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"descriptor": text, "wallet_id": wallet_id}


@app.post("/api/wallets/descriptor")
async def wallet_from_descriptor(body: DescriptorWalletIn):
    from .descriptor_wallet import wallet_from_descriptor
    from .wallet_store import add_wallet

    try:
        parsed = wallet_from_descriptor(body.descriptor, label=body.label)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    scan_limit = int(body.scan_limit if body.scan_limit is not None else parsed.scan_limit)
    saved = add_wallet(
        parsed.kpub,
        parsed.label,
        scan_limit,
        account=parsed.account,
        coin=parsed.coin,
        derivation=parsed.derivation or None,
        fingerprint=parsed.fingerprint or None,
        script_type=parsed.script_type or None,
        policy_type=parsed.policy_type or None,
        multisig_m=parsed.multisig_m or None,
        multisig_n=parsed.multisig_n or None,
        multisig_cosigners=parsed.multisig_cosigners or None,
        descriptor=parsed.descriptor,
        activate=body.activate,
    )
    return {"wallet": saved.to_dict()}


@app.get("/api/wallet/transactions")
async def active_wallet_transactions():
    wid = _resolve_wallet_id(None)
    return await wallet_transactions(wid)


@app.get("/api/wallet/addresses")
async def list_addresses():
    wid = _resolve_wallet_id(None)
    return await list_addresses_by_id(wid)


@app.post("/api/tx/signed-qr/reset")
async def signed_qr_reset():
    from .signed_ur_assembly import reset

    reset()
    return {"ok": True}


@app.post("/api/qr/text")
async def qr_text(body: QrTextIn):
    from .ur_qr import fountain_qr_frames_base64_text, plain_qr_frames_base64_text

    text = body.text or ""
    if not text.strip():
        raise HTTPException(400, "QR payload is empty")
    encoding = (body.encoding or "ur").strip().lower()
    try:
        if encoding in ("plain", "raw", "text"):
            return plain_qr_frames_base64_text(text)
        # Policy / watch-only text QRs: prefer fewer modules (easier SeedMask scan) over minimal part count.
        # Smaller box_size keeps PNG encode fast; the Mac UI scales the preview.
        return fountain_qr_frames_base64_text(
            text,
            qr_display_mode=body.qr_display_mode or "animated",
            target_modules=73,
            box_size=8,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/qr/text-parts")
async def qr_text_parts(body: QrTextIn):
    """UR part strings for both Dense + Animated (no PNG). Renderer draws QRs locally."""
    from .ur_qr import ur_text_parts_pack

    text = body.text or ""
    if not text.strip():
        raise HTTPException(400, "QR payload is empty")
    try:
        return ur_text_parts_pack(text, target_modules=73)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/tx/signed-qr/ingest")
async def signed_qr_ingest(body: SignedQrFrameIn):
    from .signed_ur_assembly import feed

    return feed(body.text)


@app.post("/api/address/validate")
async def address_validate(body: ParseQrIn):
    try:
        coin = (body.coin or "").strip().lower() or None
        addr = parse_payee_qr_text(body.text, coin=coin)
        return {"address": validate_address(addr, coin=coin)}
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        raise HTTPException(400, str(e) or "Invalid address") from e


def _normalize_fee_response(payload: dict) -> dict:
    from .fee_response import normalize_fee_estimate

    return normalize_fee_estimate(payload)


def _wallet_cfg_for_coin(wallet_id: str | None, resolved_coin: str):
    cfg = None
    if wallet_id:
        cfg = get_wallet(wallet_id)
        if not cfg:
            try:
                cfg = get_wallet(_resolve_wallet_id(wallet_id))
            except Exception:
                cfg = None
    if cfg and (cfg.coin or "kaspa").strip().lower() != resolved_coin:
        return None
    return cfg


async def _fee_estimate_impl(
    *,
    utxo_amount_sompi: int | None,
    wallet_id: str | None,
    coin: str | None,
    input_count: int,
    output_count: int,
    feerate_sat_vb: float | None,
    send_sompi: int | None,
    to_address: str | None,
    utxo_keys: list[str] | None,
    utxo_snapshots: list[dict] | None,
    refine_max: bool = False,
    priority_fee_sompi: int | None = None,
    requested_fee_sompi: int | None = None,
):
    from .send_fees import (
        estimate_bitcoin_send_fee,
        estimate_kaspa_fallback_fee,
        estimate_kaspa_send_fee,
        wallet_utxo_from_dict,
    )

    requested_coin = (coin or "").strip().lower()
    cfg = _wallet_cfg_for_coin(wallet_id, requested_coin) if requested_coin else None
    if requested_coin:
        resolved_coin = requested_coin
    elif cfg:
        resolved_coin = (cfg.coin or "kaspa").strip().lower()
    else:
        resolved_coin = "kaspa"

    if resolved_coin == "bitcoin":
        from .btc_multisig import multisig_is_enabled

        multisig = bool(cfg and multisig_is_enabled(cfg))
        return _normalize_fee_response(
            await estimate_bitcoin_send_fee(
                utxo_amount_sats=utxo_amount_sompi,
                input_count=max(1, input_count),
                output_count=max(1, output_count),
                feerate_sat_vb=feerate_sat_vb,
                multisig=multisig,
            )
        )

    selected_dicts: list[dict] = []
    if utxo_snapshots:
        selected_dicts = [u for u in utxo_snapshots if u.get("key")]
    elif cfg and utxo_keys:
        selected_dicts = await _wallet_utxos_for_keys(cfg.id, utxo_keys)
        if len(selected_dicts) != len(utxo_keys):
            raise HTTPException(
                400,
                f"UTXO not found ({len(selected_dicts)}/{len(utxo_keys)}) — refresh wallet and retry",
            )

    if cfg and selected_dicts:
        utxos = [wallet_utxo_from_dict(u) for u in selected_dicts]
        if resolved_coin == "kaspa":
            from .kaspa_service import get_service

            utxos = get_service().reclassify_utxos(cfg, utxos)
        try:
            est = estimate_kaspa_send_fee(
                cfg,
                utxos,
                to_address=to_address,
                send_sompi=send_sompi,
                refine_max=refine_max,
                priority_fee_sompi=priority_fee_sompi,
                requested_fee_sompi=requested_fee_sompi,
            )
            return _normalize_fee_response(est)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e

    return _normalize_fee_response(
        await estimate_kaspa_fallback_fee(input_count=max(1, input_count))
    )


@app.get("/api/fee/estimate")
async def fee_estimate(
    utxo_amount_sompi: int | None = None,
    wallet_id: str | None = None,
    coin: str | None = None,
    input_count: int = 1,
    output_count: int = 2,
    feerate_sat_vb: float | None = None,
    send_sompi: int | None = None,
    to_address: str | None = None,
    utxo_keys: str | None = None,
):
    try:
        keys = [k.strip() for k in (utxo_keys or "").split(",") if k.strip()] or None
        return await _fee_estimate_impl(
            utxo_amount_sompi=utxo_amount_sompi,
            wallet_id=wallet_id,
            coin=coin,
            input_count=input_count,
            output_count=output_count,
            feerate_sat_vb=feerate_sat_vb,
            send_sompi=send_sompi,
            to_address=to_address,
            utxo_keys=keys,
            utxo_snapshots=None,
            refine_max=False,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Fee estimate failed: {e}") from e


@app.post("/api/fee/estimate")
async def fee_estimate_post(body: FeeEstimateIn):
    try:
        utxo_amount = body.utxo_amount_sompi
        snapshots = None
        if body.utxos:
            snapshots = [u.model_dump() for u in body.utxos]
            if not utxo_amount:
                utxo_amount = sum(int(u.amount) for u in body.utxos)
        return await _fee_estimate_impl(
            utxo_amount_sompi=utxo_amount,
            wallet_id=body.wallet_id,
            coin=body.coin,
            input_count=body.input_count,
            output_count=body.output_count,
            feerate_sat_vb=body.feerate_sat_vb,
            send_sompi=body.send_sompi,
            to_address=body.to_address,
            utxo_keys=None,
            utxo_snapshots=snapshots,
            refine_max=bool(body.refine_max),
            priority_fee_sompi=body.priority_fee_sompi,
            requested_fee_sompi=body.requested_fee_sompi,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Fee estimate failed: {e}") from e


@app.post("/api/tx/build")
async def tx_build(body: BuildTxIn):
    wid = _resolve_wallet_id(body.wallet_id)
    cfg = get_wallet(wid)
    if not cfg:
        raise HTTPException(400, "Configure watch-only wallet first")
    keys = list(body.utxo_keys or [])
    if body.utxo_key:
        keys.insert(0, body.utxo_key)
    keys = list(dict.fromkeys(k.strip() for k in keys if k and k.strip()))
    if not keys and not body.utxos:
        raise HTTPException(400, "Provide utxo_key, utxo_keys, or utxos")

    if body.utxos:
        coin = (cfg.coin or "kaspa").strip().lower()
        snapshot_dicts = [u.model_dump() for u in body.utxos]
        _coordinator.apply_utxo_snapshots(wid, snapshot_dicts, coin=coin)
        wutxos = await _resolve_build_wutxos(wid, cfg, keys=[], snapshots=body.utxos)
    else:
        wutxos = await _resolve_build_wutxos(wid, cfg, keys=keys, snapshots=None)
    if not wutxos:
        raise HTTPException(400, "No coins selected — refresh wallet and try again")

    amount = sum(int(u.amount) for u in wutxos)
    if body.send_sompi is not None:
        send = int(body.send_sompi)
    elif body.send_kas is not None:
        send = sompi_from_kas(body.send_kas)
    else:
        raise HTTPException(400, "Provide send_kas or send_sompi")
    if send <= 0:
        raise HTTPException(400, "Invalid send amount")

    try:
        to_addr = validate_address(
            body.to_address.strip(),
            coin=(cfg.coin or "kaspa").strip().lower(),
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    is_bitcoin = (cfg.coin or "kaspa").strip().lower() == "bitcoin"

    if is_bitcoin:
        if body.fee_sompi is not None:
            fee = int(body.fee_sompi)
            if body.send_sompi is not None or body.send_kas is not None:
                if send + fee > amount:
                    raise HTTPException(400, "Fee exceeds selected coins — reduce amount or fee")
            else:
                send = amount - fee
        else:
            fee = amount - send
        if fee < 0 or send + fee > amount:
            raise HTTPException(400, "Fee exceeds selected coins — reduce amount or fee")
        from .tx_pipeline import save_draft_from_build_btc_multi
        from .ur_qr_psbt import fountain_qr_frames_base64_psbt

        try:
            draft_id, psbt_bytes, summary = await asyncio.to_thread(
                save_draft_from_build_btc_multi,
                cfg, wutxos, to_addr, send, fee_sats=fee, rbf=body.rbf
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        try:
            qr_pack = await asyncio.to_thread(
                fountain_qr_frames_base64_psbt,
                psbt_bytes, qr_display_mode=body.qr_display_mode or "animated"
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        return {
            "draft_id": draft_id,
            "unsigned": summary,
            "coin": "bitcoin",
            **qr_pack,
            "summary": summary,
        }

    # Kaspa: generator computes mass-based fee; custom_fee uses per-subset priority search.
    from .kaspa_generator import kip9_send_neighbors, resolve_kaspa_send_sompi
    from .tx_pipeline import save_draft_from_build_kaspa_generator
    from .ur_qr import fountain_qr_frames_base64

    custom_fee = bool(body.custom_fee)
    requested_fee_sompi: int | None = None
    if custom_fee and body.fee_sompi is not None:
        requested_fee_sompi = int(body.fee_sompi)
    resolve_priority_fee = requested_fee_sompi if custom_fee else None
    _adjusted = False

    if custom_fee:
        try:
            send, _adjusted = resolve_kaspa_send_sompi(
                cfg,
                wutxos,
                to_address=to_addr,
                send_sompi=send,
                priority_fee=resolve_priority_fee,
            )
        except ValueError as exc:
            block_msg = str(exc)
            neighbors = kip9_send_neighbors(
                cfg, wutxos, to_address=to_addr, send_sompi=send, priority_fee=resolve_priority_fee
            )
            hints: list[str] = []
            below = neighbors.get("below_sompi")
            above = neighbors.get("above_sompi")
            if below is not None:
                hints.append(f"up to {int(below) / SOMPI_PER_KAS:.8f} KAS")
            if above is not None:
                hints.append(f"from {int(above) / SOMPI_PER_KAS:.8f} KAS")
            hint = f" Try {' or '.join(hints)}." if hints else ""
            raise HTTPException(400, f"{block_msg}{hint}") from exc

    try:
        draft_id, _pskt, unsigned, summary = await asyncio.to_thread(
            save_draft_from_build_kaspa_generator,
            cfg,
            wutxos,
            to_addr,
            send,
            priority_fee=resolve_priority_fee,
            target_fee_sompi=requested_fee_sompi,
        )
        from .kaspa_generator import annotate_kaspa_build_summary

        summary = annotate_kaspa_build_summary(
            summary,
            wutxos,
            requested_fee_sompi=requested_fee_sompi,
        )
        if _adjusted:
            summary["requested_send_sompi"] = int(body.send_sompi or send)
            summary["send_sompi"] = send
            summary["send_kas"] = send / SOMPI_PER_KAS
    except ValueError as exc:
        block_msg = str(exc)
        if "minimum spendable" in block_msg.lower():
            raise HTTPException(400, block_msg) from exc
        neighbors = kip9_send_neighbors(
            cfg, wutxos, to_address=to_addr, send_sompi=send, priority_fee=resolve_priority_fee
        )
        hints: list[str] = []
        below = neighbors.get("below_sompi")
        above = neighbors.get("above_sompi")
        if below is not None:
            hints.append(f"up to {int(below) / SOMPI_PER_KAS:.8f} KAS")
        if above is not None:
            hints.append(f"from {int(above) / SOMPI_PER_KAS:.8f} KAS")
        hint = f" Try {' or '.join(hints)}." if hints else ""
        if "cannot be built" in block_msg.lower() or "cannot be sent" in block_msg.lower() or "not enough" in block_msg.lower() or "coin metadata" in block_msg.lower():
            raise HTTPException(400, block_msg) from exc
        raise HTTPException(
            400,
            f"Amount {send / SOMPI_PER_KAS:.8f} KAS cannot be built with these coins.{hint}",
        ) from exc
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Could not build Kaspa transaction: {e}") from e
    try:
        qr_pack = await asyncio.to_thread(
            fountain_qr_frames_base64,
            unsigned, qr_display_mode=body.qr_display_mode or "animated"
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {
        "draft_id": draft_id,
        "unsigned": unsigned,
        **qr_pack,
        "summary": summary,
    }


@app.post("/api/tx/build-sweep")
async def tx_build_sweep(body: BuildSweepIn):
    """Build PSKB bundle for multi-UTXO sweep (rusty-kaspa transport format)."""
    wid = _resolve_wallet_id(body.wallet_id)
    cfg = get_wallet(wid)
    if not cfg:
        raise HTTPException(400, "Configure watch-only wallet first")
    is_bitcoin = (cfg.coin or "kaspa").strip().lower() == "bitcoin"
    if not body.utxo_keys:
        raise HTTPException(400, "Provide at least one utxo_key")

    cached = _coordinator.get_cached_balance(wid)
    if not cached:
        _coordinator._hydrate_from_disk(wid)
        cached = _coordinator.get_cached_balance(wid)
    if not cached:
        await _refresh_wallet_watch(wid)
        cached = _coordinator.get_cached_balance(wid)
    utxos = (cached or {}).get("utxos") or []
    selected = []
    for key in body.utxo_keys:
        u = next((x for x in utxos if x["key"] == key), None)
        if not u:
            raise HTTPException(400, f"UTXO not found: {key}")
        selected.append(u)

    try:
        to_addr = validate_address(
            body.to_address.strip(),
            coin="bitcoin" if is_bitcoin else "kaspa",
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    fee_each = int(body.fee_sompi_per_tx)
    if fee_each < 0:
        raise HTTPException(400, "fee_sompi_per_tx must be non-negative")

    from .kaspa_service import WalletUtxo

    wutxos = [
        WalletUtxo(
            address=u["address"],
            address_index=int(u["address_index"]),
            transaction_id=u["transaction_id"],
            output_index=int(u["output_index"]),
            amount=int(u["amount"]),
            is_change=bool(u.get("is_change")),
            block_daa_score=int(u.get("block_daa_score") or u.get("blockDaaScore") or 0),
            is_coinbase=bool(u.get("is_coinbase") or u.get("isCoinbase") or False),
            covenant_id=u.get("covenant_id") or u.get("covenantId"),
        )
        for u in selected
    ]

    if is_bitcoin:
        from .tx_pipeline import save_sweep_draft_from_build_btc
        from .ur_qr_psbt import fountain_qr_frames_base64_psbt

        try:
            draft_id, psbt_list, summary = save_sweep_draft_from_build_btc(
                cfg, wutxos, to_addr, fee_each
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        try:
            qr_pack = fountain_qr_frames_base64_psbt(
                psbt_list[0], qr_display_mode=body.qr_display_mode or "animated"
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        return {
            "draft_id": draft_id,
            "unsigned": summary,
            "coin": "bitcoin",
            "pskt_count": len(psbt_list),
            "psbt_count": len(psbt_list),
            **qr_pack,
            "summary": summary,
        }

    from .tx_pipeline import save_sweep_draft_from_build

    try:
        draft_id, pskts, unsigned, pskb_hex = save_sweep_draft_from_build(
            cfg, wutxos, to_addr, fee_each
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    from .ur_qr import fountain_qr_frames_base64

    try:
        qr_pack = fountain_qr_frames_base64(
            unsigned, qr_display_mode=body.qr_display_mode or "animated"
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    first = selected[0]
    send = int(first["amount"]) - fee_each
    total_send = sum(int(u["amount"]) - fee_each for u in selected)
    return {
        "draft_id": draft_id,
        "unsigned": unsigned,
        "pskb_hex": pskb_hex,
        "pskt_count": len(pskts),
        **qr_pack,
        "summary": {
            "is_sweep": True,
            "utxo_count": len(selected),
            "fee_sompi_per_tx": fee_each,
            "first_send_sompi": send,
            "send_sompi": send,
            "send_kas": send / SOMPI_PER_KAS,
            "fee_sompi": fee_each,
            "total_send_sompi": total_send,
            "total_send_kas": total_send / SOMPI_PER_KAS,
            "total_fee_sompi": fee_each * len(selected),
            "to_address": to_addr,
            "from_address": first["address"],
            "note": "Sign each coin on SeedMask, then broadcast all together.",
        },
    }


@app.post("/api/tx/draft/{draft_id}/sweep-qr")
async def draft_sweep_qr(draft_id: str, body: SweepQrIn, wallet_id: str | None = None):
    """QR for coin N in a multi-UTXO sweep draft (0-based index)."""
    wid = _resolve_wallet_id(wallet_id)
    cfg = get_wallet(wid)
    if not cfg:
        raise HTTPException(400, "Configure watch-only wallet first")
    from .tx_pipeline import sweep_qr_for_draft_index

    try:
        pack = sweep_qr_for_draft_index(
            draft_id,
            body.index,
            cfg,
            qr_display_mode=body.qr_display_mode or "animated",
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return pack


@app.get("/api/tx/draft/{draft_id}")
async def get_draft_export(draft_id: str, wallet_id: str | None = None):
    try:
        from .tx_pipeline import (
            _load_draft_raw,
            export_btc_draft,
            is_bitcoin_draft,
            load_draft_envelope,
            pskt_to_hex,
        )

        data = _load_draft_raw(draft_id)
        if is_bitcoin_draft(data):
            return export_btc_draft(draft_id)

        pskt, unsigned = load_draft_envelope(draft_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if wallet_id:
        from .kaspa_generator import enrich_kaspa_multisig_unsigned
        from .tx_pipeline import ensure_unsigned_has_kpub
        from .wallet_store import effective_wallet_account, get_wallet

        cfg = get_wallet(wallet_id)
        if cfg:
            unsigned = ensure_unsigned_has_kpub(unsigned, cfg.kpub)
            if pskt:
                try:
                    from kaspa_pskt import pskt_to_seedmask_v2

                    rebuilt = pskt_to_seedmask_v2(
                        pskt,
                        kpub=(cfg.kpub or "").strip(),
                        account=effective_wallet_account(cfg),
                    )
                    if unsigned.get("draft_hash"):
                        rebuilt["draft_hash"] = unsigned["draft_hash"]
                    # Preserve UI/address metadata that is not always recoverable from PSKT script hex.
                    for idx, src in enumerate(unsigned.get("inputs") or []):
                        if idx < len(rebuilt.get("inputs") or []) and isinstance(src, dict):
                            dst = rebuilt["inputs"][idx]
                            if src.get("receive_address"):
                                dst["receive_address"] = src["receive_address"]
                    for idx, src in enumerate(unsigned.get("outputs") or []):
                        if idx < len(rebuilt.get("outputs") or []) and isinstance(src, dict):
                            dst = rebuilt["outputs"][idx]
                            if src.get("kaspa_address"):
                                dst["kaspa_address"] = src["kaspa_address"]
                    unsigned = rebuilt
                except Exception:
                    # Keep legacy export behavior if an old draft cannot be rebuilt from PSKT.
                    pass
            unsigned = enrich_kaspa_multisig_unsigned(unsigned, cfg)
    pskb_hex = None
    pskt_count = 1 if pskt else 0
    try:
        import json as _json

        from .tx_pipeline import DRAFTS_DIR

        path = DRAFTS_DIR / f"{draft_id}.json"
        if path.is_file():
            raw = _json.loads(path.read_text(encoding="utf-8"))
            pskb_hex = raw.get("pskb_hex")
            if isinstance(raw.get("pskts"), list):
                pskt_count = len(raw["pskts"])
    except Exception:
        pass
    pskt_hex = None
    if pskt:
        try:
            pskt_hex = pskt_to_hex(pskt)
        except Exception:
            pskt_hex = None
    return {
        "draft_id": draft_id,
        "unsigned": unsigned,
        "pskt_hex": pskt_hex,
        "pskb_hex": pskb_hex,
        "pskt_count": pskt_count,
        "format": "seedpass_pskt_draft_v1" if pskt or pskb_hex else "legacy_json_v2",
    }


@app.get("/api/tx/draft/{draft_id}/visualize")
async def get_draft_visualize(draft_id: str, wallet_id: str | None = None):
    try:
        from .tx_visualize import visualize_draft

        return visualize_draft(draft_id, wallet_id=wallet_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        raise HTTPException(502, f"Visualize failed: {e}") from e


@app.post("/api/tx/import")
async def tx_import(body: ImportTxIn):
    from .tx_pipeline import import_btc_unsigned, import_pskt_hex, is_bitcoin_draft, parse_draft_file

    unsigned = body.unsigned
    pskt = None

    if is_bitcoin_draft(unsigned) or (
        unsigned.get("format") == "seedpass_psbt_draft_v1"
        and (unsigned.get("psbt_base64") or unsigned.get("psbts"))
    ) or (
        isinstance(unsigned.get("psbt_base64"), str) and unsigned["psbt_base64"].strip()
    ):
        from .ur_qr_psbt import fountain_qr_frames_base64_psbt

        try:
            draft_id, psbt_bytes, psbt_count = import_btc_unsigned(unsigned)
            qr_pack = fountain_qr_frames_base64_psbt(
                psbt_bytes, qr_display_mode=body.qr_display_mode or "animated"
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        from .tx_pipeline import _load_draft_raw

        raw = _load_draft_raw(draft_id)
        summary = raw.get("summary") if isinstance(raw.get("summary"), dict) else {}
        return {
            "draft_id": draft_id,
            "unsigned": summary,
            "coin": "bitcoin",
            "pskt_count": psbt_count,
            "psbt_count": psbt_count,
            **qr_pack,
            "summary": summary,
        }

    if isinstance(unsigned.get("pskt_hex"), str) and unsigned["pskt_hex"].strip().upper().startswith("PSKT"):
        pskt, unsigned = import_pskt_hex(unsigned["pskt_hex"])
    elif unsigned.get("format") == "seedpass_pskt_draft_v1":
        pskt, unsigned = parse_draft_file(unsigned)
    elif "inputs" not in unsigned and isinstance(unsigned.get("unsigned"), dict):
        inner = unsigned["unsigned"]
        if isinstance(inner, dict) and inner.get("format") == "seedpass_pskt_draft_v1":
            pskt, unsigned = parse_draft_file(inner)
        else:
            unsigned = inner
    if not unsigned.get("inputs"):
        if unsigned.get("signatures"):
            raise HTTPException(
                400,
                "This file contains device signatures, not a signing draft. "
                "In Send → Review & Sign, use “Load signed transaction…” after loading the unsigned draft, "
                "or paste the JSON under Signed from SeedMask.",
            )
        raise HTTPException(400, "Invalid unsigned transaction JSON (missing inputs)")
    try:
        wid = _resolve_wallet_id(None)
        cfg = get_wallet(wid)
        if cfg and (cfg.coin or "kaspa").strip().lower() != "bitcoin":
            from .tx_pipeline import ensure_unsigned_has_kpub
            from .wallet_store import resolve_kaspa_fingerprint

            unsigned = ensure_unsigned_has_kpub(unsigned, cfg.kpub)
            if pskt:
                from kaspa_pskt import enrich_pskt_signing_paths

                pskt = enrich_pskt_signing_paths(
                    pskt,
                    unsigned,
                    kpub=cfg.kpub,
                    fingerprint=resolve_kaspa_fingerprint(cfg, cfg.kpub),
                )
    except Exception:
        pass
    draft_id = save_draft(unsigned, pskt=pskt)
    from .ur_qr import fountain_qr_frames_base64

    try:
        qr_pack = fountain_qr_frames_base64(
            unsigned, qr_display_mode=body.qr_display_mode or "animated"
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {
        "draft_id": draft_id,
        "unsigned": unsigned,
        **qr_pack,
        "summary": _summary_from_unsigned(unsigned),
    }


@app.post("/api/tx/finish")
async def tx_finish(body: FinishIn):
    try:
        from .tx_pipeline import (
            _load_draft_raw,
            is_bitcoin_draft,
            merge_signed_btc_for_draft,
            merge_signed_for_draft,
        )

        data = _load_draft_raw(body.draft_id)
        if is_bitcoin_draft(data):
            ready = merge_signed_btc_for_draft(body.draft_id, body.signed)
        else:
            ready = merge_signed_for_draft(
                body.draft_id, body.signed, pskt_index=body.pskt_index
            )
            try:
                import sys
                from pathlib import Path

                tools = Path(__file__).resolve().parent.parent / "tools"
                if not tools.is_dir():
                    tools = Path(__file__).resolve().parent.parent.parent / "tools"
                if str(tools) not in sys.path:
                    sys.path.insert(0, str(tools))
                from kaspa_mass import validate_v2_relay_fee

                validate_v2_relay_fee(ready)
            except ImportError:
                pass
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        msg = str(e)
        if msg.startswith("Partial Kaspa multisig signature saved"):
            import re

            m = re.search(r"\((\d+)/(\d+)\)", msg)
            loaded = int(m.group(1)) if m else 0
            required = int(m.group(2)) if m else 0
            return {
                "ready": None,
                "draft_id": body.draft_id,
                "complete": False,
                "message": msg,
                "signatures_loaded": loaded,
                "signatures_required": required,
            }
        raise HTTPException(400, msg) from e
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    return {"ready": ready, "draft_id": body.draft_id, "complete": True}


def _output_sompi(out: dict) -> int:
    for key in ("value", "amount", "amount_sompi"):
        raw = out.get(key)
        if raw is not None:
            try:
                return int(raw)
            except (TypeError, ValueError):
                continue
    return 0


def _summary_from_unsigned(unsigned: dict) -> dict:
    inputs = unsigned.get("inputs") or []
    inp = inputs[0] if inputs else {}
    outs = unsigned.get("outputs") or []
    pay = outs[0] if outs else {}
    send = _output_sompi(pay)
    total_in = sum(
        int(i.get("utxo_amount") or i.get("amount_sompi") or i.get("amount") or 0)
        for i in inputs
        if isinstance(i, dict)
    )
    if not total_in:
        total_in = int(inp.get("utxo_amount") or inp.get("amount_sompi") or inp.get("amount") or 0)
    out_sum = sum(_output_sompi(o) for o in outs if isinstance(o, dict))
    fee = max(0, total_in - out_sum) if total_in else 0
    return {
        "send_kas": send / SOMPI_PER_KAS,
        "fee_sompi": fee,
        "to_address": str(pay.get("kaspa_address") or pay.get("to_address") or ""),
        "from_address": str(inp.get("receive_address") or ""),
        "input_count": len(inputs) if inputs else 1,
    }


@app.post("/api/tx/broadcast")
async def tx_broadcast(body: FinishIn):
    wid = _resolve_wallet_id(None)
    try:
        from .tx_pipeline import _load_draft_raw, is_bitcoin_draft, load_btc_draft, load_draft

        data = _load_draft_raw(body.draft_id)
        if is_bitcoin_draft(data):
            _psbt, summary = load_btc_draft(body.draft_id)
        else:
            unsigned = load_draft(body.draft_id)
            summary = data.get("summary") if isinstance(data.get("summary"), dict) else None
            if not summary:
                summary = _summary_from_unsigned(unsigned)
            elif float(summary.get("send_kas") or 0) <= 0:
                summary = {**summary, **_summary_from_unsigned(unsigned)}
        result = await _coordinator.broadcast(
            body.draft_id, body.signed, pskt_index=body.pskt_index
        )
        txid = result["transaction_id"]
        # A draft may be previewed or abandoned. Advance the change chain only
        # after the node accepts the transaction for broadcast.
        from .tx_pipeline import _mark_summary_change_used

        _mark_summary_change_used(wid, summary)
        from .transaction_store import record_broadcast

        send_kas = float(summary.get("send_kas") or summary.get("send_btc") or 0)
        record_broadcast(
            wallet_id=wid,
            transaction_id=txid,
            send_kas=send_kas,
            fee_sompi=int(summary.get("fee_sompi") or summary.get("fee_sats") or 0),
            to_address=str(summary.get("to_address") or ""),
            from_address=str(summary.get("from_address") or ""),
        )
        try:
            from .transaction_history import ensure_broadcast_in_tx_index

            ensure_broadcast_in_tx_index(
                wid,
                txid,
                send_kas=send_kas,
                to_address=str(summary.get("to_address") or ""),
                fee_sompi=int(summary.get("fee_sompi") or summary.get("fee_sats") or 0),
            )
        except Exception:
            pass
        try:
            await _wallet_watcher.nudge_wallet(wid)
        except Exception:
            pass
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    from .network_settings import explorer_tx_url

    explorer = result.get("explorer") or explorer_tx_url(
        txid, coin=str(result.get("coin") or "kaspa")
    )
    return {
        "transaction_id": txid,
        "explorer": explorer,
        "coin": result.get("coin", "kaspa"),
    }


if STATIC.is_dir():
    app.mount("/static", StaticFiles(directory=STATIC), name="static")
