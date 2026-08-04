import { useCallback, useEffect, useState } from 'react'
import type { APIClient } from '@renderer/api/client'
import type { BuildTxResponse, WalletTxDTO } from '@renderer/api/types'
import { AnimatedQRView } from '@renderer/components/AnimatedQRView'
import { SignedQRScanner } from '@renderer/components/SignedQRScanner'
import { decodeQrImages } from '@renderer/utils/buildSummary'
import { txId } from '@renderer/utils/txHelpers'

export function RbfBumpSheet({
  tx,
  walletId,
  api,
  onClose,
  onBroadcast,
}: {
  tx: WalletTxDTO
  walletId: string
  api: APIClient
  onClose: () => void
  onBroadcast?: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [build, setBuild] = useState<BuildTxResponse | null>(null)
  const [qrFrames, setQrFrames] = useState<string[]>([])
  const [status, setStatus] = useState('Preparing RBF replacement…')
  const [signedJSON, setSignedJSON] = useState('')
  const [broadcastReady, setBroadcastReady] = useState(false)
  const [showScanner, setShowScanner] = useState(false)

  const previousFee = tx.fee_sompi ?? tx.fee_sats ?? null
  const summary = build?.summary as Record<string, unknown> | undefined
  const summaryFee =
    typeof summary?.fee_sompi === 'number'
      ? summary.fee_sompi
      : typeof summary?.fee_sats === 'number'
        ? summary.fee_sats
        : null

  const startBump = useCallback(async () => {
    setBusy(true)
    setError(null)
    setBroadcastReady(false)
    setSignedJSON('')
    setStatus('Building higher-fee replacement…')
    try {
      const res = await api.rbfBump({
        txid: txId(tx),
        walletId,
        qrDisplayMode: 'animated',
      })
      setBuild(res)
      setQrFrames(decodeQrImages(res))
      setStatus('Scan this QR on SeedMask, then load the signed transaction')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'RBF bump failed')
    } finally {
      setBusy(false)
    }
  }, [api, tx, walletId])

  useEffect(() => {
    void startBump()
  }, [startBump])

  async function applySigned(payload: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const draftId = build?.draft_id
      if (!draftId) throw new Error('Missing draft')
      const res = await api.finishTx(draftId, payload, 0)
      if (res.complete === false) {
        setBroadcastReady(false)
        setStatus(res.message || 'Partial signature — load the next cosigner')
        return
      }
      setSignedJSON(payload)
      setBroadcastReady(true)
      setStatus('Signed — ready to broadcast')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not apply signed transaction')
    } finally {
      setBusy(false)
    }
  }

  async function broadcast(): Promise<void> {
    if (!build?.draft_id || !signedJSON) return
    setBusy(true)
    setError(null)
    try {
      await api.broadcast(build.draft_id, signedJSON, 0)
      setStatus('Broadcast submitted — miners should prefer this higher-fee replacement')
      onBroadcast?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Broadcast failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-sheet rbf-bump-sheet"
        role="dialog"
        aria-label="RBF speed up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row spread" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>RBF — Speed up</h3>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Replace-by-fee builds a new transaction with the same inputs and a higher network fee. Sign it on
          SeedMask, then broadcast — the mempool should drop the old tx in favor of this one.
        </p>
        {(previousFee != null || summaryFee != null) && (
          <p className="muted" style={{ fontSize: 12 }}>
            {previousFee != null ? `Previous fee: ${previousFee} sats` : ''}
            {previousFee != null && summaryFee != null ? ' · ' : ''}
            {summaryFee != null ? `New fee: ${summaryFee} sats` : ''}
          </p>
        )}
        <p style={{ fontSize: 13 }}>{status}</p>
        {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}
        {qrFrames.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <AnimatedQRView
              frames={qrFrames}
              frameIntervalMs={build?.qr_frame_ms ?? 480}
              isPlaying
              onPlayingChange={() => undefined}
            />
          </div>
        )}
        <div className="row" style={{ marginTop: 16, gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || !build?.draft_id}
            onClick={() => setShowScanner(true)}
          >
            Scan signed QR
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void startBump()}>
            Rebuild
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !broadcastReady}
            onClick={() => void broadcast()}
          >
            Broadcast
          </button>
        </div>
      </div>
      {showScanner && (
        <SignedQRScanner
          api={api}
          onComplete={(payload) => {
            setShowScanner(false)
            void applySigned(payload)
          }}
          onCancel={() => setShowScanner(false)}
        />
      )}
    </div>
  )
}
