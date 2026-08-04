# SeedMask Coordinator — Developer Guide

Technical setup for building, testing, and hacking on the coordinator. End users should use the packaged app — see [USER_GUIDE.md](USER_GUIDE.md) and [seedmask.io/app](https://seedmask.io/app).

## Repository layout

| Path | Purpose |
|------|---------|
| `app/` | FastAPI backend (wallet, RPC, tx pipeline) |
| `tools/` | Kaspa QR, broadcast, PSKT/PSKB local copy used by coordinator builds |
| `electron/` | Electron desktop app and release packaging |
| `scripts/` | Tests (PSKT round-trip, preflight) |

## Dev environment

```bash
cd coordinator
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Optional: Kaspa Python SDK for broadcast tests:

```bash
.venv/bin/pip install kaspa
```

Node for rusty-kaspa WASM validation:

```bash
# Node 20+ recommended
bash tools/kaspa_wasm_node/setup_kaspa_wasm.sh
```

## Run backend only

```bash
export SEEDPASS_COORDINATOR_ROOT="$(pwd)"
.venv/bin/python run_backend.py
# API: http://127.0.0.1:18765/api/status
```

## Run Electron app

```bash
cd electron
npm install
npm run dev
```

## Build shipping app

Bundles Python, Node, and Kaspa WASM into the Electron package:

```bash
bash release.sh
```

Sign and notarize separately with your Apple Developer ID for public macOS distribution.

## Tests

PSKT / PSKB rusty-kaspa round-trip (WASM parse):

```bash
bash run_kaspa_pskt_roundtrip.sh
```

Toccata preflight:

```bash
bash run_toccata_preflight.sh
```

## Transaction formats

- **SeedMask QR / microSD:** JSON v2 (`unsigned` in draft files) — firmware parser.
- **Internal / export:** rusty-kaspa-compatible PSKT JSON + `PSKT` hex; multi-UTXO sweeps use PSKB bundles.
- Draft files: `format: seedpass_pskt_draft_v1` with `pskt_hex`, `pskb_hex`, `pskts[]`, and `unsigned`.

## Notes

- Do not commit `electron/release/`, `electron/build/`, or `node_modules/`.
- Installers (`.dmg`, etc.) belong on GitHub Releases, not in git history.
