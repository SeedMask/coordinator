import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface AnimatedQRViewProps {
  frames: string[]
  frameIntervalMs?: number
  maxDisplaySize?: number
  isStatic?: boolean
  /** When true, tapping the QR toggles full screen (dense or animated). */
  allowFullscreen?: boolean
  /** @deprecated use allowFullscreen */
  allowDenseFullscreen?: boolean
  isPlaying: boolean
  onPlayingChange: (playing: boolean) => void
  onFullscreen?: () => void
  /** @deprecated use onFullscreen */
  onDenseFullscreen?: () => void
  footer?: ReactNode
}

export function AnimatedQRView({
  frames,
  frameIntervalMs = 480,
  maxDisplaySize = 440,
  isStatic = false,
  allowFullscreen,
  allowDenseFullscreen = false,
  isPlaying,
  onPlayingChange,
  onFullscreen,
  onDenseFullscreen,
  footer,
}: AnimatedQRViewProps): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const canFullscreen = allowFullscreen ?? allowDenseFullscreen
  const openFullscreen = onFullscreen ?? onDenseFullscreen

  useEffect(() => {
    setIndex(0)
  }, [frames.length, isStatic])

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (isStatic || frames.length <= 1 || !isPlaying) return
    const interval = Math.max(200, frameIntervalMs)
    timerRef.current = setInterval(() => {
      setIndex((i) => (i + 1) % frames.length)
    }, interval)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [frames.length, frameIntervalMs, isPlaying, isStatic])

  if (frames.length === 0) {
    return <p className="muted">Generating QR…</p>
  }

  const frame = frames[index] ?? frames[0]
  const single = isStatic || frames.length <= 1

  return (
    <div className="animated-qr">
      <button
        type="button"
        className="qr-frame qr-frame-btn"
        style={{ width: maxDisplaySize, maxWidth: '100%', maxHeight: maxDisplaySize }}
        onClick={(e) => {
          e.stopPropagation()
          if (canFullscreen) openFullscreen?.()
        }}
        aria-label={canFullscreen ? 'Toggle QR full screen' : 'QR code'}
      >
        <img src={frame} alt="QR code" draggable={false} />
      </button>

      <div className="animated-qr-meta" style={{ maxWidth: maxDisplaySize + 24 }}>
        <div>
          {single ? (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              {canFullscreen ? 'Dense QR · tap for full screen' : 'Dense QR'}
            </p>
          ) : (
            <>
              <p className="animated-qr-part" style={{ margin: 0 }}>
                UR part {index + 1} of {frames.length}
              </p>
              <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
                {canFullscreen
                  ? isPlaying
                    ? 'Animated · tap QR for full screen'
                    : 'Paused — tap Start to resume · tap QR for full screen'
                  : !isPlaying
                    ? 'Paused — tap Start to resume.'
                    : null}
              </p>
            </>
          )}
        </div>
        {footer}
      </div>
    </div>
  )
}

/** Full-screen QR overlay — tap the QR (or Close / backdrop) to dismiss. Supports animated frames. */
export function DenseQRFullscreen({
  image,
  frames,
  frameIntervalMs = 480,
  isStatic = true,
  isPlaying = true,
  onClose,
}: {
  /** Single-frame shortcut (legacy). Prefer `frames` when animating. */
  image?: string
  frames?: string[]
  frameIntervalMs?: number
  isStatic?: boolean
  isPlaying?: boolean
  onClose: () => void
}): React.JSX.Element {
  const list = frames && frames.length > 0 ? frames : image ? [image] : []
  const [index, setIndex] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const single = isStatic || list.length <= 1

  useEffect(() => {
    setIndex(0)
  }, [list.length, isStatic])

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (single || !isPlaying || list.length <= 1) return
    const interval = Math.max(200, frameIntervalMs)
    timerRef.current = setInterval(() => {
      setIndex((i) => (i + 1) % list.length)
    }, interval)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [list.length, frameIntervalMs, isPlaying, single])

  const frame = list[index] ?? list[0]
  if (!frame) return <></>

  const overlay = (
    <div
      className="modal-overlay qr-fullscreen-overlay"
      onClick={onClose}
      role="presentation"
      onMouseDown={(e) => {
        // Ignore the same gesture that opened the overlay (avoids instant close / shrink flash).
        if (e.target === e.currentTarget) e.preventDefault()
      }}
    >
      <div
        className="dense-qr-fullscreen"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="row spread" style={{ marginBottom: 12 }}>
          <strong>{single ? 'Dense QR' : 'Animated QR'}</strong>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <button
          type="button"
          className="qr-fullscreen-tap"
          onClick={onClose}
          aria-label="Exit full screen"
        >
          <img src={frame} alt="Full screen QR" className="dense-qr-fullscreen-img" draggable={false} />
        </button>
        <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
          {single
            ? 'Tap the QR to exit full screen.'
            : `Part ${index + 1} of ${list.length} · tap the QR to exit full screen.`}
        </p>
      </div>
    </div>
  )

  // Portal above export modals / transformed ancestors so tap-to-enlarge always shows.
  if (typeof document !== 'undefined') {
    return createPortal(overlay, document.body)
  }
  return overlay
}

export function QrTransportControls({
  qrDensity,
  densityLabelFlash,
  frameCount,
  isPlaying,
  onTogglePlaying,
  onToggleDensity,
}: {
  qrDensity: 'animated' | 'static'
  densityLabelFlash: string | null
  frameCount: number
  isPlaying: boolean
  onTogglePlaying: () => void
  onToggleDensity: () => void
}): React.JSX.Element {
  return (
    <div className="row" style={{ gap: 10 }}>
      {qrDensity === 'animated' && frameCount > 1 && (
        <button type="button" className="btn btn-ghost" onClick={onTogglePlaying}>
          {isPlaying ? 'Pause' : 'Start'}
        </button>
      )}
      <button type="button" className="btn btn-ghost" style={{ minWidth: 88 }} onClick={onToggleDensity}>
        {densityLabelFlash ?? (qrDensity === 'static' ? 'Dense' : 'Animated')}
      </button>
    </div>
  )
}
