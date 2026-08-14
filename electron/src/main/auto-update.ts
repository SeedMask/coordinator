/**
 * Auto-update configuration.
 *
 * AUTO_UPDATE_DEMO must stay false for shipped builds (GitHub SeedMask/coordinator).
 * Set true only for local UX testing of the update / What’s new flow.
 *
 * Product UX:
 * - Sidebar banner: Update / Dismiss
 * - Details popup: title, What’s new, GitHub release link, Later / Update now
 * - Update now → download progress → install → restart
 * - After restart: What’s new popup opens automatically (Got it to dismiss)
 *
 * Live releases:
 * - What’s new + release URL come from the real GitHub Release body / tag.
 * - After a successful install, do not re-offer the same update.
 * - Packaged apps use autoUpdater.quitAndInstall.
 * - Feed is GitHub SeedMask/coordinator via electron-builder publish.
 */
export const AUTO_UPDATE_DEMO = false
export const AUTO_UPDATE_DEMO_VERSION = '1.0.2'

/** Only used when AUTO_UPDATE_DEMO is true. */
export const AUTO_UPDATE_DEMO_RELEASE_URL =
  'https://github.com/SeedMask/coordinator/releases/tag/v1.0.2'

/**
 * Only used when AUTO_UPDATE_DEMO is true.
 * Paste the same markdown into the GitHub Release body so in-app What’s new parses
 * Highlights / Bugs fixed / Improvements into New / Fixed / Improved.
 */
export const AUTO_UPDATE_DEMO_RELEASE_NOTES = `### ✨ Highlights
- Auto-update
- Friendlier “running your own node” guidance (Kaspa how-to)
- Stronger Test connection for Kaspa, Bitcoin Core, and Electrum
- Cleaner Connections / System settings for both Kaspa and Bitcoin
- Richer sidebar status (exact connection + provider)
- Kaspa own-node confirmations counting
- Asset History Net includes send fees
- Editable derivation path
- Wallet import/export and SeedMask sealed export flow

### 🐛 Bugs fixed
- Connections UX / Kaspa \`ws://\` · \`wss://\` handling
- Asset History Net ignored network fees on sends
- Wallet strip selection snapping back
- Importing a wallet while using your own node and choosing public Kaspa transactions no longer changes settings permanently
- Explorer link opening the wrong transaction in some cases
- Occasional spinner hang when the backend was slow to answer
- Fee estimate edge cases on small Kaspa sends

### 🔧 Improvements
- Kaspa Test connection: connect → \`getInfo\` → sync + UTXO-index checks
- Clearer Kaspa errors (refused / wrong port \`16111\` vs \`17110\`, timeouts, missing \`--utxoindex\`)
- Syncing Kaspa nodes can pass with a “Connected — syncing” warning
- Convenient “Use local node” shortcut for Kaspa
- Bitcoin Core / Electrum: friendlier failures (cookie, auth, not running, wrong port, SSL, timeout)
- Bitcoin Core reports sync / IBD when reachable but not caught up
- System settings shows both Kaspa and Bitcoin connection details
- Improved chunked address visual demonstration in System settings
- Better Kaspa own-node “How to” explanation
- Past transactions on import don’t permanently change the transaction history preference while using your own node`
