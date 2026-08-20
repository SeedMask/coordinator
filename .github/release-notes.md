### 🐛 Bugs fixed
- Encrypted wallets sealed before `cryptography` was available could not unlock with the correct password (HMAC legacy vs AES-GCM mismatch)

### 🔧 Improvements
- Wallet decrypt accepts both AES-GCM and legacy HMAC seals; new seals mark the cipher and prefer AES-GCM
