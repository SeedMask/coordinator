import { useApp } from '@renderer/state/AppProvider'
import { SeedMaskLogoMark } from '@renderer/components/BrandMarks'
import { EyeSlashIcon } from '@renderer/components/icons'

export function WelcomeView(): React.JSX.Element {
  const { markWelcomeSeen, setIsAddingWallet } = useApp()

  function begin(): void {
    markWelcomeSeen()
    setIsAddingWallet(true)
  }

  return (
    <div className="welcome-screen welcome-layout">
      <div className="welcome-copy">
        <div className="welcome-brand">
          <SeedMaskLogoMark height={64} />
          <div>
            <strong className="welcome-brand-name">SeedMask</strong>
            <p className="muted welcome-brand-sub">Kaspa Coordinator</p>
          </div>
        </div>

        <h1>
          Watch-only wallet
          <br />
          for Kaspa
        </h1>
        <p className="muted welcome-lead">
          Your seed never touches this Mac. Import a kpub, track balances, build transactions, and sign on your SeedMask device.
        </p>

        <div className="welcome-chips">
          <span className="welcome-chip">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M12 2 4 5v6c0 5.25 3.4 10.15 8 11.35C16.6 21.15 20 16.25 20 11V5l-8-3Zm0 2.2 6 2.25V11c0 4.08-2.55 7.92-6 9.05-3.45-1.13-6-4.97-6-9.05V6.45l6-2.25Z" />
            </svg>
            No seed on Mac
          </span>
          <span className="welcome-chip">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm7.93 9h-3.16a15.3 15.3 0 0 0-1.2-4.32A8 8 0 0 1 19.93 11ZM12 4a13.4 13.4 0 0 1 1.91 5H10.09A13.4 13.4 0 0 1 12 4Z" />
            </svg>
            Mainnet
          </span>
          <span className="welcome-chip">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M3 3h8v8H3V3Zm12 0h6v6h-6V3ZM3 13h8v8H3v-8Zm13 3h3v3h-3v-3Z" />
            </svg>
            QR signing
          </span>
        </div>

        <div className="row welcome-actions">
          <button type="button" className="btn btn-primary welcome-primary" onClick={begin}>
            Get started
          </button>
          <button type="button" className="btn btn-secondary" onClick={begin}>
            I already have a kpub
          </button>
        </div>
      </div>

      <div className="welcome-art">
        <div className="welcome-art-card">
          <EyeSlashIcon size={56} className="welcome-art-icon" />
          <strong className="welcome-art-title">Watch-only</strong>
          <p className="muted">
            Coordinator sees public keys only.
            <br />
            Private keys stay on SeedMask.
          </p>
        </div>
      </div>
    </div>
  )
}
