# SeedMask Coordinator — Release

Cross-platform desktop app (Electron + bundled Python backend).

## Build installers

On **macOS** (produces `.dmg` + `.zip`):

```bash
cd electron
npm ci
npm run release
```

On **Windows** (produces NSIS `.exe` + `.zip`):

```powershell
cd electron
npm ci
npm run release
```

On **Linux** (produces `.AppImage` + `.deb`):

```bash
cd electron
npm ci
npm run release
```

Artifacts land in `electron/release/`.

Or from the repo root:

```bash
bash release.sh
```

## Publishing downloads

1. Build installers on each platform (or CI matrix).
2. Upload artifacts to a GitHub Release on this repo and/or [SeedMask/seedmask.io](https://github.com/SeedMask/seedmask.io) Releases.
3. Point [seedmask.io/app](https://seedmask.io/app) at the release asset URL.

Do **not** commit installer binaries into git.

## Reproducibility

- Source of truth for the app is this repository.
- Tag releases (for example `v1.0.0`) to match shipped version strings in `electron/package.json` / `VERSION.txt`.
- Record the commit SHA in release notes when publishing a DMG.
- Apple code signing / notarization will change the final binary hash vs an unsigned local build.

## CI suggestion

Use a matrix build:

- `macos-latest` → `npm run release` → upload macOS artifacts
- `windows-latest` → `npm run release` → upload Windows artifacts
- `ubuntu-latest` → `npm run release` → upload Linux artifacts
