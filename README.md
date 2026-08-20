# SeedMask Coordinator

Watch-only desktop companion for **Kaspa and Bitcoin** mainnet — balances, addresses, and a send flow where signing stays on hardware. Works with **any air-gapped device** that can export an **xPub** (Bitcoin) or **kPub** (Kaspa). Built around **SeedMask**; USB/BLE signing helpers also cover Ledger and OneKey. SeedMask is not affiliated with Ledger or OneKey.

**Platforms:** macOS (Apple Silicon) and Windows x64. Linux packaging exists in the build scripts but is not shipped yet.

**End users:** see [USER_GUIDE.md](USER_GUIDE.md). Download installers from [seedmask.io/app](https://seedmask.io/app) or [GitHub Releases](https://github.com/SeedMask/coordinator/releases).

**Developers:** see [DEVELOPER.md](DEVELOPER.md) for venv, tests, and Electron builds.

**Reproducible builds:** this repository is enough. Kaspa helper scripts and WASM live in `tools/` inside this repo. You do **not** need the SeedMask firmware tree to run `npm run release` on the OS you are targeting (Mac build on macOS, Windows build on Windows or via `.github/workflows/release-windows.yml`). Optional: if `SeedMask_Firmware/tools` sits next to this folder, the release script can refresh `tools/` from it. Details: [RELEASE.md](RELEASE.md).

## Quick links

| Task | Command / doc |
|------|----------------|
| User install & send flow | [USER_GUIDE.md](USER_GUIDE.md) |
| Build Electron app | [DEVELOPER.md](DEVELOPER.md) |
| Build installers (repro) | [RELEASE.md](RELEASE.md) |
| Windows CI | [`.github/workflows/release-windows.yml`](.github/workflows/release-windows.yml) |
| PSKT round-trip test | `bash run_kaspa_pskt_roundtrip.sh` |

Signing stays on your air-gapped device. This app never sees your seed.

SeedMask Coordinator is early software and has not completed a public security audit.
