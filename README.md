# SeedMask Coordinator

Watch-only desktop companion for [SeedMask](https://seedmask.io) hardware wallets.

**Bitcoin** and **Kaspa**. Balances and unsigned transactions on your computer. Signing stays on the device.

- Website: [seedmask.io](https://seedmask.io)
- App / downloads: [seedmask.io/app](https://seedmask.io/app)
- Org: [github.com/SeedMask](https://github.com/SeedMask)

## Status

**Early / public alpha.** Not security audited.

Treat builds as **pre-release**. Do **not** rely on this software for large amounts of funds. Prefer verifying downloads on [seedmask.io/app](https://seedmask.io/app).

## What it does

| On your computer (Coordinator) | On SeedMask (device) |
|--------------------------------|----------------------|
| Watch balances & history | Hold keys / seed |
| Prepare unsigned transactions | Review & sign offline |
| Broadcast after signing | Air-gapped confirmation |

Coordinator is **watch-only** by design. It should never see your seed.

## Repository layout

| Path | Purpose |
|------|---------|
| `app/` | FastAPI backend (wallet, RPC, tx pipeline) |
| `tools/` | Kaspa QR, broadcast, PSKT/PSKB helpers + WASM SDK |
| `electron/` | Electron desktop app and packaging |
| `scripts/` | Tests and helpers |

## Reproduce a macOS build

Requirements: macOS, Node.js 20+, Python 3.11+.

```bash
git clone https://github.com/SeedMask/coordinator.git
cd coordinator

python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# Optional: ensure rusty-kaspa WASM SDK for PSKT validation
bash tools/kaspa_wasm_node/setup_kaspa_wasm.sh

cd electron
npm ci
npm run release
```

Installers land in `electron/release/` locally. Official prebuilt macOS Apple Silicon DMGs are attached to **[this repo’s Releases](https://github.com/SeedMask/coordinator/releases)** (also mirrored on [seedmask.io Releases](https://github.com/SeedMask/seedmask.io/releases) and linked from [seedmask.io/app](https://seedmask.io/app)).

Signing and notarization require an Apple Developer ID and are **not** included in this repository.

More detail: [DEVELOPER.md](DEVELOPER.md), [RELEASE.md](RELEASE.md), [USER_GUIDE.md](USER_GUIDE.md).

## License

[MIT](./LICENSE) — Copyright (c) 2026 SeedMask.

## Security

See [SECURITY.md](./SECURITY.md).

## Disclaimer

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND. SeedMask Coordinator is experimental. You are solely responsible for your keys, backups, and funds. Nothing in this repository is financial, legal, or investment advice.
