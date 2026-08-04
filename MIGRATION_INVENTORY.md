# SeedMask Coordinator — migration inventory

Cross-platform desktop uses **Electron + React + TypeScript** (`coordinator/electron/`).  
The **Python backend** (`coordinator/app/`, `tools/`) stays the source of truth until mobile forces a Rust core.

Legend:

| Tag | Meaning |
|-----|---------|
| **KEEP** | Use as-is behind HTTP API; no rewrite |
| **WRAP** | Keep logic; add session/auth/encryption wrapper later |
| **PORT-RUST-LATER** | Reimplement in shared `seedmask-core` for iOS/Android |
| **REPLACE-UI** | Swift-only; replaced by Electron renderer |

---

## Python backend — `coordinator/app/`

| Module | Tag | Role | Depends on |
|--------|-----|------|------------|
| `main.py` | **KEEP** | FastAPI routes, app lifecycle | controller, wallet_store, tx_pipeline, network_settings |
| `controller.py` | **KEEP** | Orchestration, QR frames, refresh | coin_service, kaspa_service, bitcoin_service, ur_qr |
| `coin_service.py` | **KEEP** | Route by coin | kaspa_service, bitcoin_service |
| `wallet_store.py` | **WRAP** | Wallet persistence (`~/.seedmask-coordinator/`) | json, pathlib — encrypt at rest later |
| `network_settings.py` | **WRAP** | Bitcoin/Kaspa connection settings | wallet_store DATA_DIR |
| `kaspa_service.py` | **KEEP** | kpub derive, RPC scan, UTXOs | **`kaspa` pip (rusty-kaspa)**, wallet_store |
| `bitcoin_service.py` | **KEEP** | xpub scan, Esplora/Core path | **embit**, bitcoin_backend, btc_script |
| `bitcoin_backend.py` | **KEEP** | Mode router (public / Core / Electrum) | bitcoin_core_rpc, bitcoin_electrum, network_settings |
| `bitcoin_core_rpc.py` | **KEEP** | Bitcoin Core JSON-RPC | httpx, network_settings |
| `bitcoin_electrum.py` | **KEEP** | Private Electrum protocol | httpx, network_settings |
| `bitcoin_psbt.py` | **KEEP** | PSBT build/finalize/broadcast | **embit**, btc_multisig, bitcoin_service |
| `bitcoin_fees.py` | **KEEP** | BTC fee estimation | bitcoin_backend, httpx |
| `btc_multisig.py` | **KEEP** | Multisig addresses/scripts | embit, wallet_store |
| `btc_script.py` | **KEEP** | Script type from xpub/derivation | — |
| `descriptor_wallet.py` | **KEEP** | Output descriptors (Sparrow) | embit |
| `kpub_parse.py` | **KEEP** | Parse SM QR, xpub/kpub, UR | bcur, embit |
| `tx_pipeline.py` | **KEEP** | Send pipeline Kaspa+BTC | tools/kaspa_*, bitcoin_psbt, ur_qr* |
| `tx_visualize.py` | **KEEP** | Human-readable tx summary | kaspa_coordinator_qr (tools) |
| `send_fees.py` | **KEEP** | Fee helpers | kaspa_service, bitcoin_fees |
| `fee_response.py` | **KEEP** | Fee DTO shaping | — |
| `transaction_history.py` | **KEEP** | On-chain history | httpx, kaspa_service, bitcoin_backend |
| `transaction_store.py` | **WRAP** | Outgoing tx log (local JSON) | wallet_store DATA_DIR |
| `utxo_cache.py` | **WRAP** | Cached UTXOs/balances | wallet_store DATA_DIR |
| `address_usage.py` | **WRAP** | Receive index usage | wallet_store DATA_DIR |
| `labels_store.py` | **WRAP** | Address/tx labels | wallet_store DATA_DIR |
| `wallet_export.py` | **KEEP** | Import/export bundles | wallet_store |
| `wallet_watcher.py` | **KEEP** | SSE live balance events | kaspa_service |
| `watch_addresses.py` | **KEEP** | Next receive address | address_usage, kaspa/bitcoin services |
| `kaspa_generator.py` | **KEEP** | Kaspa tx generator path | kaspa pip |
| `qr_scanner.py` | **KEEP** | OpenCV QR decode (server-side) | opencv — desktop only |
| `signed_ur_assembly.py` | **KEEP** | Multi-frame signed UR ingest | bcur |
| `ur_qr.py` | **KEEP** | Fountain QR encode (Kaspa JSON) | bcur |
| `ur_qr_psbt.py` | **KEEP** | Fountain QR encode (PSBT) | bcur, ur_qr |
| `bcur/*` | **KEEP** | BCUR/UR protocol (pure Python) | — |

---

## Python tools — `coordinator/tools/` (bundled with backend)

| Module | Tag | Role | Depends on |
|--------|-----|------|------------|
| `kaspa_coordinator_qr.py` | **KEEP** | Unsigned tx JSON v2 for SeedMask QR | kaspa_mass |
| `kaspa_pskt.py` | **KEEP** | PSKT/PSKB serde | kaspa pip (optional) |
| `kaspa_apply_signatures.py` | **KEEP** | Merge signed payload | — |
| `kaspa_mass.py` | **KEEP** | Mass/fee validation | **`kaspa` pip (rusty-kaspa)** |
| `kaspa_broadcast.py` | **KEEP** | Relay signed tx | kaspa pip |
| `kaspa_send.py` | **KEEP** | CLI send helper | above |
| `kaspa_pskt_wasm.py` | **KEEP** | Bridge to WASM validator | Node + **rusty-kaspa WASM** |
| `kaspa_wasm_node/` | **KEEP** | Official kaspa-wasm32-sdk v2 | Rust→WASM binary |

Device UI RGB565 generators (`gen_*_rgb565.py`, etc.) live in firmware, not this repo.

---

## External crypto (do not rewrite)

| Asset | Tag | Used by |
|-------|-----|---------|
| **`kaspa` PyPI** (rusty-kaspa bindings) | **KEEP** | kaspa_service, kaspa_mass, kaspa_broadcast |
| **rusty-kaspa WASM v2** | **KEEP** | kaspa_pskt_wasm.py |
| **embit** | **KEEP** | bitcoin_psbt, bitcoin_service, descriptors |
| **Node.js runtime** | **WRAP** | PSKT WASM validation only — on mobile use WASM-in-JS or Rust FFI |

---

## Mobile future (`PORT-RUST-LATER` priority)

High priority to port into shared Rust (or call WASM):

1. `kpub_parse.py` + `bcur/*` + UR encode/decode  
2. `kaspa_pskt.py` + mass rules (use rusty-kaspa directly)  
3. `bitcoin_psbt.py` + embit-equivalent (`rust-bitcoin`)  
4. `wallet_store` schema + encrypted vault format  

Keep on desktop as Python until mobile ships; dual-run acceptable short term.

---

## UI — replaced by Electron

| Asset | Tag |
|-------|-----|
| `macos/SeedPassCoordinator/**/*.swift` | **REPLACE-UI** |
| `macos/build_app.sh`, `bundle_runtime.sh` | **REPLACE-UI** (see `electron/scripts/`) |
| `coordinator/static/` | **REPLACE-UI** (legacy Kaspa web; reference only) |

---

## Electron shell — `coordinator/electron/`

| Piece | Tag | Role |
|-------|-----|------|
| `src/main/backend-manager.ts` | **NEW** | Spawn `run_backend.py`, env vars, port 18765 |
| `src/renderer/api/client.ts` | **NEW** | Port of `APIClient.swift` |
| `src/renderer/state/` | **NEW** | Port of `AppState.swift` |
| `src/renderer/views/` | **NEW** | Port of Swift views |

---

## API contract (frozen for all platforms)

Base URL: `http://127.0.0.1:18765`  
Entry: `coordinator/run_backend.py`  
Data dir: `~/.seedmask-coordinator/`

See `coordinator/app/main.py` for all routes. Electron renderer must not duplicate business rules that live in Python.

---

*Last updated: cross-platform Electron desktop migration.*
