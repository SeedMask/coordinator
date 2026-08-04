import { useEffect, useState } from 'react'
import { SeedMaskLogoMark } from '@renderer/components/BrandMarks'
import { LoadingSpinner } from '@renderer/components/icons'

export function LoadingScreen({
  error,
  statusMessage,
}: {
  error: string | null
  statusMessage: string
}): React.JSX.Element {
  const [logPath, setLogPath] = useState<string | null>(null)
  const [showInstallHint, setShowInstallHint] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setShowInstallHint(true), 12_000)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    void window.seedmask?.getBackendLogPath?.().then((p) => {
      if (p) setLogPath(p)
    })
  }, [])

  const showDownloadHelp = Boolean(error) || showInstallHint

  return (
    <div className="loading-screen">
      <SeedMaskLogoMark height={72} />
      <LoadingSpinner size={36} />
      <h1>SeedMask Coordinator</h1>
      {error ? (
        <>
          <p className="loading-error">{error}</p>
          <div className="loading-dev-hint muted">
            <p>
              <strong>Downloaded from the website?</strong>
            </p>
            <ol style={{ textAlign: 'left', margin: '8px auto', maxWidth: 420, paddingLeft: 20 }}>
              <li>Open the .dmg and drag <strong>SeedMask Coordinator</strong> to Applications.</li>
              <li>Eject the disk image — do not run the app from inside the .dmg.</li>
              <li>
                First launch: right-click the app in Applications → <strong>Open</strong> (macOS may block
                unsigned downloads).
              </li>
              <li>This Mac build requires an Apple Silicon Mac (M1/M2/M3).</li>
            </ol>
          </div>
        </>
      ) : (
        <>
          <p className="muted">{statusMessage || 'Starting coordinator backend…'}</p>
          {showDownloadHelp && (
            <div className="loading-dev-hint muted" style={{ maxWidth: 420 }}>
              <p style={{ marginTop: 12 }}>
                Still starting? If you opened the app from the .dmg, move it to Applications first, then try
                again.
              </p>
            </div>
          )}
        </>
      )}
      {logPath && (
        <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          Backend log:{' '}
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: '2px 8px' }}
            onClick={() => void window.seedmask?.openPath(logPath)}
          >
            Open log file
          </button>
        </p>
      )}
    </div>
  )
}
