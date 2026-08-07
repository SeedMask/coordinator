import { LockIcon } from '@renderer/components/icons'

/** One shared lock screen for Dashboard / Addresses / Coins / Wallet settings / Send. */
export function WalletLockedPanel({
  walletLabel,
  onUnlock,
}: {
  walletLabel?: string
  onUnlock: () => void
}): React.JSX.Element {
  return (
    <div className="wallet-locked-panel">
      <div className="card wallet-locked-card">
        <div className="wallet-locked-icon" aria-hidden>
          <LockIcon size={28} />
        </div>
        <h2 className="section-title" style={{ marginTop: 12 }}>
          Locked
        </h2>
        <p className="muted" style={{ marginTop: 8, lineHeight: 1.45 }}>
          Unlock {walletLabel?.trim() ? `“${walletLabel.trim()}”` : 'this wallet'} to continue.
        </p>
        <div className="row" style={{ marginTop: 18 }}>
          <button type="button" className="btn btn-primary" onClick={onUnlock}>
            Unlock
          </button>
        </div>
      </div>
    </div>
  )
}
