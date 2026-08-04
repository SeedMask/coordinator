import { useEffect, useRef, useState } from 'react'
import type { APIClient } from '@renderer/api/client'

interface QRScannerSheetProps {
  title: string
  hint: string
  onScan: (payload: string) => void
  onCancel: () => void
  /** When set, assembles animated BC-UR (Connect software / SeedMask pairing) via the backend. */
  api?: APIClient | null
  assembleAnimatedUr?: boolean
}

declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats: string[] }) => {
      detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>>
    }
  }
}

const SCAN_INTERVAL_MS = 180

export function QRScannerSheet({
  title,
  hint,
  onScan,
  onCancel,
  api = null,
  assembleAnimatedUr = false,
}: QRScannerSheetProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const handledRef = useRef(false)
  const streamRef = useRef<MediaStream | null>(null)
  const scanTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onScanRef = useRef(onScan)
  const onCancelRef = useRef(onCancel)
  const lastFrameRef = useRef('')
  const [statusHint, setStatusHint] = useState('Starting camera…')
  const [progress, setProgress] = useState(0)

  onScanRef.current = onScan
  onCancelRef.current = onCancel

  useEffect(() => {
    handledRef.current = false
    lastFrameRef.current = ''
    let cancelled = false

    async function start(): Promise<void> {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatusHint('Camera not supported in this environment')
        return
      }
      try {
        if (assembleAnimatedUr && api) {
          try {
            await api.resetSignedQrAssembly()
          } catch {
            /* optional */
          }
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 960 },
            height: { ideal: 720 },
          },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (!video) return
        video.setAttribute('playsinline', 'true')
        video.muted = true
        video.srcObject = stream
        await video.play()
        setStatusHint('Scanning…')
        scanTimerRef.current = setInterval(() => {
          void scanFrame()
        }, SCAN_INTERVAL_MS)
      } catch {
        setStatusHint('Camera unavailable — allow camera access in System Settings')
      }
    }

    function finish(payload: string): void {
      if (handledRef.current || cancelled) return
      handledRef.current = true
      if (scanTimerRef.current != null) clearInterval(scanTimerRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      onScanRef.current(payload)
    }

    async function ingestUrFrame(payload: string): Promise<void> {
      if (!api || handledRef.current || cancelled) return
      if (payload === lastFrameRef.current) return
      lastFrameRef.current = payload
      try {
        const res = await api.ingestSignedQrFrame(payload)
        if (handledRef.current || cancelled) return
        setProgress(res.progress ?? 0)
        setStatusHint(res.message ?? 'Assembling…')
        if (res.complete && res.payload) {
          finish(res.payload)
        }
      } catch (e) {
        setStatusHint(e instanceof Error ? e.message : 'Scan failed')
      }
    }

    async function scanFrame(): Promise<void> {
      if (cancelled || handledRef.current) return
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return

      const w = video.videoWidth
      const h = video.videoHeight
      if (w <= 0 || h <= 0) return

      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(video, 0, 0, w, h)
      const payload = await detectQr(canvas)
      if (!payload || handledRef.current || cancelled) return

      const trimmed = payload.trim()
      if (assembleAnimatedUr && api && trimmed.toLowerCase().startsWith('ur:')) {
        await ingestUrFrame(trimmed)
        return
      }

      // Static SM| / JSON / bare key — complete immediately.
      finish(trimmed)
    }

    void start()

    return () => {
      cancelled = true
      if (scanTimerRef.current != null) clearInterval(scanTimerRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      if (assembleAnimatedUr && api) {
        void api.resetSignedQrAssembly().catch(() => undefined)
      }
    }
  }, [api, assembleAnimatedUr])

  return (
    <div className="qr-scanner-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="qr-scanner-sheet">
        <h2 className="qr-scanner-title">{title}</h2>
        <p className="muted qr-scanner-hint">{hint}</p>
        <div className="qr-scanner-preview">
          <video ref={videoRef} className="qr-scanner-video" playsInline muted autoPlay />
          <canvas ref={canvasRef} className="qr-scanner-canvas" aria-hidden />
        </div>
        <p className="muted qr-scanner-status">
          {statusHint}
          {assembleAnimatedUr && progress > 0 && progress < 1 ? ` (${Math.round(progress * 100)}%)` : ''}
        </p>
        <div className="row">
          <button type="button" className="btn btn-ghost" onClick={() => onCancelRef.current()}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

async function detectQr(source: HTMLCanvasElement): Promise<string | null> {
  if (typeof window.BarcodeDetector === 'function') {
    try {
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
      const codes = await detector.detect(source)
      const value = codes[0]?.rawValue?.trim()
      if (value) return value
    } catch {
      /* fall through */
    }
  }
  return null
}
