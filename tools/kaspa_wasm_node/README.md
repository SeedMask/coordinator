# rusty-kaspa WASM bridge (PSKT / PSKB)

Official **kaspa-wallet-pskt** parse validation for the Coordinator.

## Setup (once)

```bash
bash SeedMask Firmware/tools/kaspa_wasm_node/setup_kaspa_wasm.sh
```

Requires `curl`, `unzip`, and **Node.js** (`node` on PATH, or Cursor’s bundled node).

## Validate manually

```bash
node tools/kaspa_wasm_node/validate_pskt.mjs --pskt-hex 'PSKT…'
node tools/kaspa_wasm_node/validate_pskt.mjs --pskb-hex 'PSKB…'
```

Python wrapper: `tools/kaspa_pskt_wasm.py` (used automatically on tx build when WASM is ready).
