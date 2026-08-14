# SeedMask Coordinator

Electron companion for **SeedMask** hardware wallets — Kaspa and Bitcoin mainnet, watch-only balances, send flow with on-device signing.

**End users:** see [USER_GUIDE.md](USER_GUIDE.md) and install **SeedMask Coordinator.app** (no terminal required).

**Developers:** see [DEVELOPER.md](DEVELOPER.md) for venv, tests, and Electron builds.

**Reproducible builds:** this repository is enough. Kaspa helper scripts and WASM live in `tools/` inside this repo. You do **not** need the SeedMask firmware tree to run `npm run release`. Optional: if `SeedMask_Firmware/tools` sits next to this folder, the release script can refresh `tools/` from it. Details: [RELEASE.md](RELEASE.md).

## Quick links

| Task | Command / doc |
|------|----------------|
| User install & send flow | [USER_GUIDE.md](USER_GUIDE.md) |
| Build Electron app | [DEVELOPER.md](DEVELOPER.md) |
| Build installers (repro) | [RELEASE.md](RELEASE.md) |
| PSKT round-trip test | `bash run_kaspa_pskt_roundtrip.sh` |

Signing stays on SeedMask. This app never sees your seed.
