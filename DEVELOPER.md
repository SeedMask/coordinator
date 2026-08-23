# SeedMask Coordinator — Developer Guide

Technical setup for building, testing, and hacking on the coordinator. End users should use the packaged app (macOS `.dmg` or Windows `.exe`) — see [USER_GUIDE.md](USER_GUIDE.md).

## Repository layout

| Path | Purpose |
|------|---------|
| `app/` | FastAPI backend (wallet, RPC, tx pipeline) |
| `tools/` | Kaspa QR, broadcast, PSKT/PSKB + WASM helpers bundled into releases |
| `electron/` | Electron desktop app and release packaging |
| `scripts/` | Tests (PSKT round-trip, preflight) |
| `.github/workflows/release-windows.yml` | Windows x64 installer CI (does not replace Mac assets) |

Shipping builds only need **this** repository. See [RELEASE.md](RELEASE.md) for installer reproducibility (`tools/` is included here; firmware is optional).

## Dev environment

```bash
cd SeedMask_Coordinator
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Camera QR in the Electron UI uses **jsqr** (no OpenCV). Optional only if you run the legacy Tk scanner (`app/qr_scanner.py`):

```bash
.venv/bin/pip install opencv-python-headless
```

Node for rusty-kaspa WASM validation:

```bash
# macOS (Homebrew) example:
brew install node
# Prefer the copy shipped with this repo:
bash tools/kaspa_wasm_node/setup_kaspa_wasm.sh
# Or, if you keep firmware next door:
# bash ../SeedMask_Firmware/tools/kaspa_wasm_node/setup_kaspa_wasm.sh
```

## Run backend only

```bash
export SEEDMASK_COORDINATOR_ROOT="$(pwd)"
.venv/bin/python run_backend.py
# API: http://127.0.0.1:18765/api/status
```

## Run Electron app

```bash
cd SeedMask_Coordinator/electron
npm install
npm run dev
```

## Build shipping app

Bundles Python, Node, and Kaspa WASM into the Electron package, then **trims** unused bulk (Node headers, pip/setuptools, stdlib demos/tests, `__pycache__`). OpenCV/numpy are not installed for the ship runtime. From `electron/` **on the target OS**:

```bash
cd SeedMask_Coordinator/electron
npm install
npm run release
```

Or from the repo root:

```bash
bash SeedMask_Coordinator/release.sh
```

- **macOS** → `.dmg` + `.zip` (+ `latest-mac.yml` for auto-update)
- **Windows** → NSIS `.exe` + `.zip` (+ `latest-win.yml`; CI mirrors `latest.yml` for older clients)
- **Windows CI:** Actions workflow `release-windows.yml` (workflow_dispatch or `v*` tags)

Details: [RELEASE.md](RELEASE.md).

Sign and notarize separately with your Apple Developer ID for public macOS distribution (optional for private/unsigned builds). Windows Authenticode signing is likewise optional for preview builds.

## Tests

PSKT / PSKB rusty-kaspa round-trip (WASM parse):

```bash
bash SeedMask_Coordinator/run_kaspa_pskt_roundtrip.sh
```

Toccata preflight:

```bash
bash SeedMask_Coordinator/run_toccata_preflight.sh
```

## Transaction formats

- **SeedMask QR / microSD:** JSON v2 (`unsigned` in draft files) — firmware parser.
- **Internal / export:** rusty-kaspa-compatible PSKT JSON + `PSKT` hex; multi-UTXO sweeps use PSKB bundles.
- Draft files: `format: seedmask_pskt_draft_v1` with `pskt_hex`, `pskb_hex`, `pskts[]`, and `unsigned`.

## Data on disk

- `~/.seedmask-coordinator/` — wallets, UTXO cache, settings (see app data layout)
- `~/.seedmask-coordinator/drafts/` — unsigned transaction drafts
