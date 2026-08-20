# SeedMask Coordinator — Release

Cross-platform desktop app (Electron + bundled Python backend).

## What you need (reproducibility)

Clone **this** repository only. A full release uses:

| In this repo | Role |
|--------------|------|
| `app/` | Python backend bundled into the app |
| `tools/` | Kaspa QR / broadcast / PSKT helpers + `kaspa_wasm_node` (required in the package) |
| `electron/` | Electron UI + `npm run release` |

You do **not** need the SeedMask firmware repository to build installers.

### Optional firmware tools sync

If you develop with both trees side by side:

```text
Arduino2/
  SeedMask_Coordinator/     ← this repo
  SeedMask_Firmware/tools/  ← optional sibling
```

then `npm run release` will refresh `SeedMask_Coordinator/tools/` from `SeedMask_Firmware/tools` when that folder exists. If firmware tools are missing, the script keeps the existing `tools/` already in this repo and continues.

## Build installers

On **macOS** (produces `.dmg` + `.zip`):

```bash
cd SeedMask_Coordinator/electron
npm install
npm run release
```

On **Windows** (produces NSIS `.exe` + `.zip`):

```powershell
cd SeedMask_Coordinator\electron
npm install
npm run release
```

On **Linux** (produces `.AppImage` + `.deb`):

```bash
cd SeedMask_Coordinator/electron
npm install
npm run release
```

Artifacts land in `SeedMask_Coordinator/electron/release/`.

First run can take several minutes (bundled Python/Node runtime + packaging).

## Website downloads

1. Build installers on each platform (or CI matrix).
2. Copy artifacts: `bash SeedMask_Coordinator/electron/scripts/sync_website_downloads.sh`
3. Deploy `SeedMask_Coordinator/website/` to your static host.

The download page reads `website/downloads/manifest.js` for version and file names.

## CI suggestion

Use a matrix build on **this** repo only:

- `macos-latest` → `npm run release` → upload `release/*mac*`
- `windows-latest` → `npm run release` → upload `release/*win*` (see `.github/workflows/release-windows.yml`)
- `ubuntu-latest` → `npm run release` → upload `release/*linux*`

The Windows workflow builds **x64 only** and never replaces macOS Release assets.

Merge artifacts and run `sync_website_downloads.sh` before deploying the website.

Keep `tools/` committed (or restored in CI) so builds do not depend on a firmware checkout.
