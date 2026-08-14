# SeedMask Coordinator — User Guide

SeedMask Coordinator is the Mac companion app for your **SeedMask** hardware wallet. It helps you watch balances, build transactions, and broadcast to Kaspa (and Bitcoin) mainnet — while your seed stays on the device.

## Install

1. Download **SeedMask-Coordinator.dmg** from SeedMask.
2. Open the DMG and drag **SeedMask Coordinator** into Applications.
3. Launch from Applications (or Spotlight).

No Python, Node, or terminal setup is required. Everything runs inside the app.

## First launch

1. Open **SeedMask Coordinator**.
2. On the welcome screen, choose **Add wallet**.
3. On your SeedMask device: **Crypto → Kaspa → Export kpub** (or Bitcoin → Export xpub).
4. Scan the QR or paste the key into the coordinator.
5. Wait for the mainnet scan to finish — your balance and coins appear on the dashboard.

**Privacy:** Only watch-only public keys are stored on your Mac (`~/.seedmask-coordinator/`). Your seed never leaves SeedMask.

## Send Kaspa

1. **Dashboard → Send** (or the send button).
2. Pick one coin, or **select several** to sweep them all to the same address.
3. Enter recipient `kaspa:…` address (and amount for a single coin).
4. Review the fee, then **Build transaction**.
5. A QR appears — on SeedMask: scan it on **Review**, then tap **Sign**.
6. Back on the Mac: **Scan signed QR** (camera) or paste the signed JSON.
7. **Broadcast** — done.

### Sweep (multiple coins)

When you select **2 or more coins**, the coordinator builds one transaction per coin (same recipient). You **sign each coin on SeedMask** (one QR at a time), then tap **Broadcast all** to send every transaction together.

### Tips for scanning QR codes

- Hold SeedMask **15–25 cm** from the screen.
- For animated multi-part QRs, keep steady until all parts have been shown.
- Use full-screen QR mode if the code looks dense.
- Grant **Camera** permission when macOS asks (System Settings → Privacy & Security → Camera).

## Receive

**Receive** shows your next unused address. Copy it or scan the QR for deposits.

## Multiple wallets

Add more wallets from the sidebar. Switch between Kaspa and Bitcoin using the chain picker. Each chain remembers its active wallet.

## Troubleshooting

| Problem | What to do |
|--------|------------|
| App won’t start | Quit and reopen. If it persists, reinstall from the official DMG. |
| “Can’t reach Kaspa mainnet” | Check internet; try again in a minute. |
| Invalid kpub | Re-export from SeedMask after updating firmware. |
| Camera not working | Enable camera for SeedMask Coordinator in System Settings. |
| Coin no longer available | Refresh wallet — UTXO may have been spent. |

## Support

For device issues (signing, firmware), see SeedMask device documentation.  
For coordinator bugs, contact SeedMask support with your app version (**System settings → About**).
