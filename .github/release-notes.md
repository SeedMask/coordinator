### ✨ Highlights
- First Windows x64 installer (NSIS + portable zip)
- Windows Bluetooth stack rebuild for Ledger and OneKey (BLE-capable devices)
- Platform-aware wording (this PC / this Mac) in settings and wallet remove flow

### 🐛 Bugs fixed
- Windows CI packaging: runtime download/extract, pip paths, and electron-builder publish cleanup
- Mac-only “this Mac” copy shown on Windows

### 🔧 Improvements
- Safer Windows native rebuild path (USB/HID + noble) without breaking macOS packaging
- Loading / install hints now match the OS you’re on
