# SeedMask Coordinator — Electron (cross-platform desktop)

Watch-only companion UI for **Windows, macOS, and Linux**.  
The **Python backend** (`../app/`, `../tools/`) is unchanged — Electron spawns `run_backend.py` on `127.0.0.1:18765`.

This is the only supported coordinator desktop app.

## Quick start (development)

```bash
cd ..   # SeedMask_Coordinator
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

cd electron
npm install
npm run dev
```

## Production release (self-contained installers)

**Important:** the Electron app lives under `SeedMask_Coordinator/electron`.

From the **Arduino2** folder (repo root):

```bash
bash SeedMask_Coordinator/release.sh
```

Or:

```bash
cd SeedMask_Coordinator/electron
npm install   # first time only
npm run release
```

First run takes **several minutes** (pip downloads + packaging). On macOS you get a `.dmg`/`.zip`; on Windows an `.exe`/`.zip`. You should see `[preflight]` lines immediately — if you see nothing, you're in the wrong directory.

This will:

1. Bundle Python + Node + Kaspa WASM into `build/runtime/`
2. Build the Electron UI
3. Produce installers in `release/`
4. Smoke-test the bundled backend
5. Optionally sync artifacts to `../website/downloads/` (local Mac releases; skipped on GitHub Actions)

### Scripts

| Command | Purpose |
|---------|---------|
| `npm run release` | Full self-contained release for current OS |
| `npm run bundle:runtime` | Bundle Python/Node/WASM only |
| `npm run release:dev-package` | Package without bundling runtime (uses system Python) |
| `npm run package:mac` / `:win` / `:linux` | Electron-builder only (after `npm run build`) |

Windows packaging uses `latest-win.yml` for auto-update (`package:win`). See [RELEASE.md](../RELEASE.md).

## Website download page

End-user downloads: [seedmask.io/app](https://seedmask.io/app) → GitHub Releases.

Optional static site at [`../website/`](../website/index.html) with Mac / Windows / Linux buttons.

After building installers locally, you can run:

```bash
bash scripts/sync_website_downloads.sh
```

Host `coordinator/website/` on any static host if you use that path.

## Architecture

| Layer | Path | Role |
|-------|------|------|
| Main | `src/main/` | Window, spawn/kill Python backend, native file dialogs |
| Preload | `src/preload/` | Safe IPC bridge |
| Renderer | `src/renderer/src/` | React UI → HTTP API |
| Backend | `../app/` | Wallet logic (see `MIGRATION_INVENTORY.md`) |
| Runtime | `build/runtime/` | Bundled Python venv, Node, Kaspa WASM (packaged only) |

## Environment variables

| Variable | Purpose |
|----------|---------|
| `SEEDMASK_COORDINATOR_ROOT` | Path to folder containing `run_backend.py` |
| `SEEDMASK_PYTHON` | Python executable with deps installed |
| `SEEDMASK_COORDINATOR_PORT` | API port (default `18765`) |
| `SEEDMASK_NODE` | Bundled Node for PSKT validation |
| `SEEDMASK_WASM_DIR` | Bundled Kaspa WASM SDK |

## Requirements for building runtime

- Python **3.10–3.13** (kaspa SDK does not support 3.14+)
- Network access (pip + nodejs.org + optional Kaspa WASM download)
- ~500MB disk for bundled runtime

See also: [`../MIGRATION_INVENTORY.md`](../MIGRATION_INVENTORY.md)
