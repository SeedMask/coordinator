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

`bundle_runtime.sh` ships a **trimmed** runtime: no Node C headers, no pip/setuptools in the final tree, no OpenCV/numpy (Electron uses `jsqr` for camera QR). Expect roughly ~200–220MB compressed installers on macOS arm64 after trim (exact size varies by Electron/deps).

## Website downloads

Public downloads for end users are linked from **[seedmask.io/app](https://seedmask.io/app)** to GitHub Release assets (macOS `.dmg`, Windows `.exe`).

Optional local static page in this repo:

1. Build installers on each platform (or CI).
2. Copy artifacts: `bash SeedMask_Coordinator/electron/scripts/sync_website_downloads.sh`
3. Deploy `SeedMask_Coordinator/website/` to your static host.

The in-repo download page reads `website/downloads/manifest.js` for version and file names.

## Auto-update feeds (GitHub Releases)

Attach both OS feeds on the same release tag when both platforms ship:

| File | OS |
|------|-----|
| `latest-mac.yml` | macOS |
| `latest-win.yml` | Windows (primary from next builds) |
| `latest.yml` | Windows (compat mirror for older clients) |

## CI

- **Windows x64:** [`.github/workflows/release-windows.yml`](.github/workflows/release-windows.yml) — `workflow_dispatch` or push tags `v*`. Builds Windows only; does not replace macOS assets.
- Suggested matrix for full coverage:
  - `macos-latest` → `npm run release` → upload `release/*mac*` + `latest-mac.yml`
  - `windows-latest` → workflow above → upload `release/*win*` + `latest-win.yml`
  - `ubuntu-latest` → `npm run release` → upload `release/*linux*` (when shipping Linux)

Merge artifacts onto one GitHub Release tag so each OS can update independently.

Keep `tools/` committed (or restored in CI) so builds do not depend on a firmware checkout.
