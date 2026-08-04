/**
 * Local BC-UR + QR packs (Sparrow-style): encode in Electron main (Node Buffer),
 * no Python HTTP round-trip. Matches coordinator `ur:bytes/` encoding.
 */
import { UR, UREncoder } from '@ngraveio/bc-ur'
import QRCode from 'qrcode'

const STATIC_MAX_QR_MODULES = 129
const STATIC_MAX_URI_CHARS = 2800
const MAX_ANIMATED_PARTS = 16
/** Soft animated frames for SeedMask camera (~version 10–12 QR). */
const TARGET_ANIMATED_MODULES = 61
const MAX_URI_CHARS_PER_PART = 900
const ANIMATED_FRAME_MS = 450
/** High-res frames so fullscreen enlarge is crisp (modal scales down with CSS). */
const QR_WIDTH = 720
const MIN_FRAGMENT = 10
const FRAGMENT_CANDIDATES = [
  25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100, 120, 150, 180, 200, 250, 300, 350, 400,
] as const

export type ExportQrPackDto = { frames: string[]; frameMs: number }

export type ExportQrPacksDto = {
  static: ExportQrPackDto | null
  animated: ExportQrPackDto
  qr_static_available: boolean
}

function modulesForUri(uri: string): number {
  return QRCode.create(uri, { errorCorrectionLevel: 'L' }).modules.size
}

/**
 * Soft animated QRs: stay near TARGET_ANIMATED_MODULES, ≤MAX_ANIMATED_PARTS.
 * Prefer under-target density first, then fewer parts (not maxed-out fragmentation).
 */
function pickFragmentLen(payload: Buffer): number {
  let best = 50
  let bestScore: [number, number, number, number] = [9999, 9999, 9999, 9999]

  for (const frag of FRAGMENT_CANDIDATES) {
    const enc = new UREncoder(UR.fromBuffer(payload), frag, 0, MIN_FRAGMENT)
    const seqLen = enc.fragmentsLength
    if (seqLen > MAX_ANIMATED_PARTS) continue
    const part = enc.nextPart()
    if (part.length > MAX_URI_CHARS_PER_PART) continue
    const modules = modulesForUri(part)
    const overTarget = Math.max(0, modules - TARGET_ANIMATED_MODULES)
    const score: [number, number, number, number] = [overTarget, seqLen, modules, part.length]
    if (
      score[0] < bestScore[0] ||
      (score[0] === bestScore[0] && score[1] < bestScore[1]) ||
      (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] < bestScore[2]) ||
      (score[0] === bestScore[0] &&
        score[1] === bestScore[1] &&
        score[2] === bestScore[2] &&
        score[3] < bestScore[3])
    ) {
      bestScore = score
      best = frag
    }
  }

  if (bestScore[0] === 9999) {
    for (const frag of [...FRAGMENT_CANDIDATES].reverse()) {
      const enc = new UREncoder(UR.fromBuffer(payload), frag, 0, MIN_FRAGMENT)
      if (enc.fragmentsLength <= MAX_ANIMATED_PARTS) return frag
    }
    return 25
  }
  return best
}

function urAnimatedParts(text: string): string[] {
  const payload = Buffer.from(text, 'utf8')
  const ur = UR.fromBuffer(payload)
  const frag = pickFragmentLen(payload)
  const enc = new UREncoder(ur, frag, 0, MIN_FRAGMENT)
  if (enc.fragmentsLength <= 1) {
    return [UREncoder.encodeSinglePart(ur)]
  }
  if (enc.fragmentsLength > MAX_ANIMATED_PARTS) {
    throw new Error(
      `Payload needs ${enc.fragmentsLength} animated QR parts (max ${MAX_ANIMATED_PARTS}). Save as a file instead.`,
    )
  }
  const parts: string[] = []
  for (let i = 0; i < enc.fragmentsLength; i++) {
    parts.push(enc.nextPart())
  }
  return parts
}

function urStaticPart(text: string): string | null {
  try {
    const ur = UR.fromBuffer(Buffer.from(text, 'utf8'))
    const part = UREncoder.encodeSinglePart(ur)
    if (part.length > STATIC_MAX_URI_CHARS) return null
    if (modulesForUri(part) > STATIC_MAX_QR_MODULES) return null
    return part
  } catch {
    return null
  }
}

async function framesFromParts(parts: string[]): Promise<string[]> {
  return Promise.all(
    parts.map((part) =>
      QRCode.toDataURL(part, {
        errorCorrectionLevel: 'L',
        margin: 2,
        width: QR_WIDTH,
        color: { dark: '#000000', light: '#ffffff' },
      }),
    ),
  )
}

async function plainStaticFrame(text: string): Promise<string | null> {
  const payload = text.trim()
  if (!payload) return null
  if (payload.length > STATIC_MAX_URI_CHARS) return null
  try {
    if (modulesForUri(payload) > STATIC_MAX_QR_MODULES) return null
    return QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: QR_WIDTH,
      color: { dark: '#000000', light: '#ffffff' },
    })
  } catch {
    return null
  }
}

/** Build Dense + Animated image packs entirely in-process (ms, not seconds). */
export async function buildExportQrPacks(
  text: string,
  preferredEncoding: 'ur' | 'plain' = 'ur',
): Promise<ExportQrPacksDto> {
  const payload = (text || '').trim()
  if (!payload) throw new Error('QR payload is empty')

  const animatedParts = urAnimatedParts(payload)

  if (preferredEncoding === 'plain') {
    // Dense = plain payload (BlueWallet / Sparrow / etc.). Animated = BC-UR of the same text
    // (BlueWallet and SeedMask can scan animated UR).
    const [animatedFrames, plainFrame] = await Promise.all([
      framesFromParts(animatedParts),
      plainStaticFrame(payload),
    ])
    return {
      static: plainFrame ? { frames: [plainFrame], frameMs: 0 } : null,
      animated: {
        frames: animatedFrames,
        frameMs: animatedFrames.length > 1 ? ANIMATED_FRAME_MS : 0,
      },
      qr_static_available: !!plainFrame,
    }
  }

  const staticPart = urStaticPart(payload)
  const [animatedFrames, staticFrames] = await Promise.all([
    framesFromParts(animatedParts),
    staticPart ? framesFromParts([staticPart]) : Promise.resolve([] as string[]),
  ])
  const animated: ExportQrPackDto = {
    frames: animatedFrames,
    frameMs: animatedFrames.length > 1 ? ANIMATED_FRAME_MS : 0,
  }
  if (!staticFrames.length) {
    return { static: null, animated, qr_static_available: false }
  }
  return {
    static: { frames: staticFrames, frameMs: 0 },
    animated,
    qr_static_available: true,
  }
}
