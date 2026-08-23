### ✨ Highlights
- Smaller Mac app (~603 MB in Finder vs ~870 MB before) — installer is lighter too
- Broadcast returns as soon as the network accepts the tx (balances/history catch up in the background)
- **Time format** in System settings: System, 12-hour, or 24-hour
- **Back** on Review & sign returns to Send (Dashboard still leaves the wizard from Send)

### 🐛 Bugs fixed
- Singlesig Broadcast falsely failed: “multisig signature_script … redeem_script_hex is missing” (Schnorr `41…` push was mistaken for incomplete multisig)
- Broadcast UI waiting on a full wallet refresh after the node already had the tx

### 🔧 Improvements
- Bundled Python/Node runtime is trimmed (no OpenCV/numpy, no Node C headers, no pip/tests in the ship tree)
- Camera QR stays Electron/`jsqr`; OpenCV is optional for a local Tk scanner only
- Multisig preflight still runs when a redeem script is actually present
