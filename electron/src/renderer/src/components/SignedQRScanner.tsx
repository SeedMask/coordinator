import { useCallback, useEffect, useRef, useState } from 'react'
import type { APIClient } from '@renderer/api/client'
import { isCompleteSignedTransactionPayload } from '@renderer/utils/buildSummary'

interface SignedQRScannerProps {
  api: APIClient
  onComplete: (payload: string) => void
  onCancel: () => void
}

export function SignedQRScanner({ api, onComplete, onCancel }: SignedQRScannerProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const handledRef = useRef(false)
  const lastPartialHintRef = useRef(0)

  const [hint, setHint] = useState('Starting camera…')
  const [progress, setProgress] = useState(0)

  const complete = useCallback(
    (payload: string) => {
      if (handledRef.current) return
      handledRef.current = true
      setHint('Signed transaction captured')
      onComplete(payload)
    },
    [onComplete],
  )

  const notePartialRead = useCallback(() => {
    const now = Date.now()
    if (now - lastPartialHintRef.current < 1000) return
    lastPartialHintRef.current = now
    if (!handledRef.current) {
      setHint('Almost — hold the QR steady and fill the preview')
    }
  }, [])

  const ingest = useCallback(
    async (payload: string) => {
      const trimmed = payload.trim()
      if (!trimmed) return

      if (trimmed.startsWith('{')) {
        if (isCompleteSignedTransactionPayload(trimmed)) {
          complete(trimmed)
        } else {
          notePartialRead()
        }
        return
      }

      try {
        const res = await api.ingestSignedQrFrame(trimmed)
        if (handledRef.current) return
        setProgress(res.progress ?? 0)
        setHint(res.message ?? 'Scanning…')
        if (res.complete && res.payload) {
          complete(res.payload)
        }
      } catch (e) {
        setHint(e instanceof Error ? e.message : 'Scan failed')
      }
    },
    [api, complete, notePartialRead],
  )

  const resetAssembly = useCallback(async () => {
    try {
      await api.resetSignedQrAssembly()
    } catch {
      /* optional */
    }
    handledRef.current = false
    setProgress(0)
    setHint('Scanning… hold SeedMask QR in view')
  }, [api])

  useEffect(() => {
    let cancelled = false
    void resetAssembly()

    async function startCamera(): Promise<void> {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        setHint('Scanning… hold SeedMask QR in view')
      } catch {
        setHint('No camera available — allow camera access or paste signed JSON')
      }
    }

    void startCamera()

    return () => {
      cancelled = true
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      void api.resetSignedQrAssembly()
    }
  }, [api, resetAssembly])

  useEffect(() => {
    let cancelled = false

    async function scanLoop(): Promise<void> {
      if (cancelled || handledRef.current) return
      const video = videoRef.current
      const canvas = canvasRef.current
      if (video && canvas && video.readyState >= video.HAVE_CURRENT_DATA) {
        const w = video.videoWidth
        const h = video.videoHeight
        if (w > 0 && h > 0) {
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          if (ctx) {
            ctx.drawImage(video, 0, 0, w, h)
            const imageData = ctx.getImageData(0, 0, w, h)
            try {
              const jsQR = (await import('jsqr')).default
              const code = jsQR(imageData.data, w, h, { inversionAttempts: 'attemptBoth' })
              if (code?.data) {
                void ingest(code.data)
              }
            } catch {
              /* jsQR load/decode */
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(() => void scanLoop())
    }

    rafRef.current = requestAnimationFrame(() => void scanLoop())
    return () => {
      cancelled = true
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [ingest])

  return (
    <div className="modal-overlay" onClick={onCancel} role="presentation">
      <div className="signed-qr-scanner card" onClick={(e) => e.stopPropagation()}>
        <h3 className="section-title" style={{ marginBottom: 8 }}>
          Scan signed transaction
        </h3>
        <p className="muted" style={{ fontSize: 13, textAlign: 'center' }}>
          Hold the SeedMask screen steady in the preview. Move closer or farther if scanning does not start.
        </p>
        <div className="signed-qr-preview">
          <video ref={videoRef} playsInline muted />
          <canvas ref={canvasRef} hidden />
        </div>
        {progress > 0 && progress < 1 && (
          <progress value={progress} max={1} style={{ width: '100%', marginTop: 12 }} />
        )}
        <p className="muted" style={{ fontSize: 12, textAlign: 'center', minHeight: 32 }}>
          {hint}
        </p>
        <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void resetAssembly()}>
            Reset scan
          </button>
        </div>
      </div>
    </div>
  )
}
