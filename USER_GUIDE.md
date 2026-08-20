# SeedMask Coordinator — User Guide

SeedMask Coordinator is a watch-only desktop app for **Kaspa and Bitcoin** mainnet. It helps you watch balances, build transactions, and broadcast — while private keys stay on hardware. Use it with **SeedMask**, and also with **Ledger** or **OneKey** (same rule: public state on the computer, signing on the device). SeedMask is not affiliated with Ledger or OneKey.

**Supported installs today:** macOS Apple Silicon and Windows x64.

## Install

### macOS (Apple Silicon)

1. Download **SeedMask-Coordinator-…-arm64.dmg** from [seedmask.io/app](https://seedmask.io/app) or [GitHub Releases](https://github.com/SeedMask/coordinator/releases).
2. Open the DMG and drag **SeedMask Coordinator** into Applications.
3. Launch from Applications (not from inside the DMG).

If macOS blocks the app (not notarized yet): **System Settings → Privacy & Security → Open Anyway**. Details are on the download page.

### Windows (64-bit)

1. Download **SeedMask-Coordinator-…-win-x64.exe** from [seedmask.io/app](https://seedmask.io/app) or [GitHub Releases](https://github.com/SeedMask/coordinator/releases).
2. Run the installer. If SmartScreen appears: **More info → Run anyway**.
3. Open **SeedMask Coordinator** from the Start menu or desktop shortcut.

No Python, Node, or terminal setup is required. Everything runs inside the app.

## First launch

1. Open **SeedMask Coordinator**.
2. On the welcome screen, choose **Add wallet**.
3. On your SeedMask device: **Crypto → Kaspa → Export kpub** (or Bitcoin → Export xpub).
4. Scan the QR or paste the key into the coordinator.
5. Wait for the mainnet scan to finish — your balance and coins appear on the dashboard.

**Privacy:** Only watch-only public keys are stored on this computer (`~/.seedmask-coordinator/` on macOS/Linux; under your user profile on Windows). Your seed never leaves SeedMask.

## Send Kaspa

1. **Dashboard → Send** (or the send button).
2. Pick one coin, or **select several** to sweep them all to the same address.
3. Enter recipient `kaspa:…` address (and amount for a single coin).
4. Review the fee, then **Build transaction**.
5. A QR appears — on SeedMask: scan it on **Review**, then tap **Sign**.
6. Back on the computer: **Scan signed QR** (camera) or paste the signed JSON.
7. **Broadcast** — done.

### Sweep (multiple coins)

When you select **2 or more coins**, the coordinator builds one transaction per coin (same recipient). You **sign each coin on SeedMask** (one QR at a time), then tap **Broadcast all** to send every transaction together.

### Tips for scanning QR codes

- Hold SeedMask **15–25 cm** from the screen.
- For animated multi-part QRs, keep steady until all parts have been shown.
- Use full-screen QR mode if the code looks dense.
- Grant **Camera** permission when the OS asks (macOS: System Settings → Privacy & Security → Camera; Windows: Settings → Privacy → Camera).

## Receive

**Receive** shows your next unused address. Copy it or scan the QR for deposits.

## Multiple wallets

Add more wallets from the sidebar. Switch between Kaspa and Bitcoin using the chain picker. Each chain remembers its active wallet.

## Updates

In **System settings**, use **Check for updates**. The app loads release notes from GitHub. macOS and Windows each use their own update feed on the same GitHub Release.

## Troubleshooting

| Problem | What to do |
|--------|------------|
| App won’t start | Quit and reopen. If it persists, reinstall from the official download page. |
| macOS blocks open | System Settings → Privacy & Security → Open Anyway. |
| Windows SmartScreen | More info → Run anyway (preview builds are unsigned). |
| “Can’t reach Kaspa mainnet” | Check internet; try again in a minute. |
| Invalid kpub | Re-export from SeedMask after updating firmware. |
| Camera not working | Enable camera for SeedMask Coordinator in OS privacy settings. |
| Coin no longer available | Refresh wallet — UTXO may have been spent. |

## Support

For device issues (signing, firmware), see SeedMask device documentation.  
For coordinator bugs, contact SeedMask support with your app version (**System settings → About**).
