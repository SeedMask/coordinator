### ✨ Highlights
- Faster Review & Sign (local QR encode, prefetch while on Send, snappier Dense ↔ Animated)
- Dense QR works for real Kaspa unsigned txs
- Clearer Review: coins to sign, totals, fees, and Broadcast layout
- Save → Load → sign on SeedMask → scan signed QR handoff works again
- Receive advances to the next unused address

### 🐛 Bugs fixed
- Balance after sending to your own receive address (hot sync kept dropping later indices)
- Broadcast stuck on “Building…”
- Multisig broadcast rejected P2SH change (`script_hex` / Schnorr P2PK false error)
- `draft_hash` mismatch when reloading a saved tx and signing the same file on SeedMask
- Loading a saved draft no longer gets overwritten by an automatic Review rebuild
- Loaded Kaspa drafts missing change amount/address in Review
- Transaction search not filtering; highlight no longer includes KAS / BTC / sats unit suffixes
- Undated Kaspa receives placed incorrectly (or stuck) in Asset History

### 🔧 Improvements
- Hot-watch covers more addresses and prioritizes live/funded ones on refresh
- After a successful send, refresh includes recipient and change addresses
- Addresses “Used” behavior matches 1.0.1 (balance when funded; Used when empty-with-history)
- Animated QR fragment count matches prior coordinator behavior again
- Local QR encode falls back to server if needed
- Pending / undated history rows stay at the tip until a real block time arrives
- Dashboard: Transactions heading shares a row with the on-chain description
