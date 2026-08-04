/**
 * Classic Coordinator descriptor PDF:
 * landscape letter · vector text · sharp QR · Xpub on its own line · no right-edge clip.
 */
import QRCode from 'qrcode'
import type { WalletDTO } from '@renderer/api/types'
import {
  walletIsMultisig,
  walletMultisigCosigners,
  walletResolvedDerivation,
  walletResolvedFingerprint,
} from '@renderer/utils/walletHelpers'

/** US Letter landscape — wider page so long descriptors / xpubs fit with side margin. */
const PAGE_W = 792
/** Preferred height for short (singlesig) content. Grows for multisig. */
const PAGE_H_MIN = 560
const MARGIN = 56
const CONTENT_W = PAGE_W - MARGIN * 2
const QR_PT = 256
const TITLE_SIZE = 18
const BODY_SIZE = 12
const DETAIL_SIZE = 13

export function descriptorPdfDetailLines(
  wallet: WalletDTO,
  label: string,
  keyLabel: 'Xpub' | 'Kpub' = 'Xpub',
): string[] {
  const lines: string[] = []
  if (walletIsMultisig(wallet)) {
    const cosigners = walletMultisigCosigners(wallet)
    if (cosigners.length > 0) {
      cosigners.forEach((c, index) => {
        const name = (c.label || label || 'Wallet').trim() || `Cosigner ${index + 1}`
        const fp = (c.fingerprint || walletResolvedFingerprint(wallet) || '').toUpperCase()
        const deriv = (c.derivation || walletResolvedDerivation(wallet) || '').trim()
        lines.push(
          `Wallet ${index + 1}: label: ${name}    Fingerprint: ${fp}    Derivation: ${deriv}`,
        )
        lines.push(`${keyLabel}: ${c.xpub}`)
      })
      return lines
    }
  }
  const fp = (walletResolvedFingerprint(wallet) || '').toUpperCase()
  const deriv = walletResolvedDerivation(wallet)
  const xpub = wallet.kpub.trim()
  lines.push(
    `Wallet 1: label: ${label.trim() || wallet.label || 'Wallet'}    Fingerprint: ${fp}    Derivation: ${deriv}`,
  )
  lines.push(`${keyLabel}: ${xpub}`)
  return lines
}

function textWidth(text: string, fontSize: number, font: 'Helv' | 'Cour'): number {
  // Conservative widths so wrap fires before the real glyph edge (avoids right-side clip).
  const avg = font === 'Cour' ? 0.6 : 0.58
  let w = 0
  for (const ch of text) {
    if (ch === ' ') w += font === 'Cour' ? 0.6 : 0.278
    else if ('ilIjtf.,:;'.includes(ch)) w += font === 'Cour' ? 0.6 : 0.28
    else if ('mwMW@%'.includes(ch)) w += font === 'Cour' ? 0.6 : 0.85
    else w += avg
  }
  return w * fontSize
}

function wrapLines(text: string, fontSize: number, font: 'Helv' | 'Cour', maxWidth: number): string[] {
  // Leave a little slack inside the content box for white space on the right.
  const limit = maxWidth * 0.96
  const out: string[] = []
  let line = ''
  for (const ch of text) {
    const trial = line + ch
    if (textWidth(trial, fontSize, font) <= limit || line.length === 0) {
      line = trial
    } else {
      out.push(line)
      line = ch === ' ' ? '' : ch
    }
  }
  if (line) out.push(line)
  return out.length ? out : ['']
}

function escapePdf(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== 'undefined') {
    const stream = new Blob([data.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream('deflate'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  return data
}

async function qrRgbFlate(descriptor: string, qrPx: number): Promise<Uint8Array> {
  const dataUrl = await QRCode.toDataURL(descriptor, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: qrPx,
    color: { dark: '#000000', light: '#ffffff' },
  })
  const img = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = qrPx
  canvas.height = qrPx
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, qrPx, qrPx)
  ctx.drawImage(img, 0, 0, qrPx, qrPx)
  const { data } = ctx.getImageData(0, 0, qrPx, qrPx)
  const rgb = new Uint8Array(qrPx * qrPx * 3)
  for (let i = 0, j = 0; i < data.length; i += 4) {
    rgb[j++] = data[i]!
    rgb[j++] = data[i + 1]!
    rgb[j++] = data[i + 2]!
  }
  return deflate(rgb)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('QR image failed to load'))
    img.src = src
  })
}

function buildPdf(parts: {
  title: string
  pageH: number
  titleY: number
  bodyLines: { text: string; y: number }[]
  detailLines: { text: string; y: number }[]
  qrY: number
  qrPt: number
  qrPx: number
  qrFlate: Uint8Array
}): Uint8Array {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const offsets: number[] = [0]
  let pos = 0
  const w = (data: Uint8Array | string): void => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data
    chunks.push(bytes)
    pos += bytes.length
  }
  const obj = (id: number, writeBody: () => void): void => {
    offsets[id] = pos
    w(`${id} 0 obj\n`)
    writeBody()
    w('\nendobj\n')
  }

  let content = 'q\nBT\n'
  content += `/F1 ${TITLE_SIZE} Tf\n0 g\n`
  content += `1 0 0 1 ${MARGIN} ${parts.titleY.toFixed(2)} Tm\n(${escapePdf(parts.title)}) Tj\n`
  content += `/F2 ${BODY_SIZE} Tf\n`
  for (const line of parts.bodyLines) {
    content += `1 0 0 1 ${MARGIN} ${line.y.toFixed(2)} Tm\n(${escapePdf(line.text)}) Tj\n`
  }
  content += `0.36 g\n/F3 ${DETAIL_SIZE} Tf\n`
  for (const line of parts.detailLines) {
    content += `1 0 0 1 ${MARGIN} ${line.y.toFixed(2)} Tm\n(${escapePdf(line.text)}) Tj\n`
  }
  content += 'ET\n'
  content += `q\n${parts.qrPt} 0 0 ${parts.qrPt} ${MARGIN} ${parts.qrY.toFixed(2)} cm\n/Im1 Do\nQ\n`
  content += 'Q\n'
  const contentBytes = enc.encode(content)

  w('%PDF-1.4\n')
  obj(1, () => w('<< /Type /Catalog /Pages 2 0 R >>'))
  obj(2, () => w('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'))
  obj(3, () =>
    w(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${parts.pageH}] /Contents 4 0 R /Resources << /Font << /F1 6 0 R /F2 7 0 R /F3 8 0 R >> /XObject << /Im1 5 0 R >> >> >>`,
    ),
  )
  obj(4, () => {
    w(`<< /Length ${contentBytes.length} >>\nstream\n`)
    w(contentBytes)
    w('endstream')
  })
  obj(5, () => {
    w(
      `<< /Type /XObject /Subtype /Image /Width ${parts.qrPx} /Height ${parts.qrPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate false /Filter /FlateDecode /Length ${parts.qrFlate.length} >>\nstream\n`,
    )
    w(parts.qrFlate)
    w('\nendstream')
  })
  obj(6, () => w('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'))
  obj(7, () => w('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'))
  obj(8, () => w('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'))

  const xrefPos = pos
  w(`xref\n0 ${offsets.length}\n`)
  w('0000000000 65535 f \n')
  for (let i = 1; i < offsets.length; i++) {
    w(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  }
  w(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`)

  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

export type DescriptorPdfOptions = {
  title?: string
  keyLabel?: 'Xpub' | 'Kpub'
  /** Shown above the QR. Defaults to `payload` (e.g. descriptor). Use a short summary when QR carries JSON. */
  bodyText?: string
  bodyFont?: 'Helv' | 'Cour'
}

/** Human-readable body for Kaspa policy JSON PDFs (QR still carries the full JSON). */
export function formatKaspaPolicyPdfBody(policyJson: string): string {
  try {
    const data = JSON.parse(policyJson) as {
      format?: string
      coin?: string
      name?: string
      policy?: string
      derivation?: string
      fingerprint?: string
      cosigners?: unknown[]
    }
    const lines: string[] = []
    if (data.format) lines.push(`format: ${data.format}`)
    if (data.coin) lines.push(`coin: ${data.coin}`)
    if (data.name) lines.push(`name: ${data.name}`)
    if (data.policy) {
      const raw = String(data.policy).trim()
      const policyLabel = /^\d+of\d+$/i.test(raw)
        ? `${raw} Multisig`
        : raw.toLowerCase() === 'singlesig'
          ? 'Singlesig'
          : raw
      lines.push(`policy: ${policyLabel}`)
    }
    if (data.derivation) lines.push(`derivation: ${data.derivation}`)
    if (data.fingerprint) lines.push(`fingerprint: ${data.fingerprint}`)
    if (Array.isArray(data.cosigners) && data.cosigners.length > 0) {
      lines.push(`cosigners: ${data.cosigners.length} (kpubs below)`)
    }
    return lines.join('\n')
  } catch {
    return policyJson
  }
}

export async function buildDescriptorPdf(
  payload: string,
  wallet: WalletDTO,
  label: string,
  options: DescriptorPdfOptions = {},
): Promise<Uint8Array> {
  const title = options.title ?? 'Output descriptor'
  const keyLabel = options.keyLabel ?? 'Xpub'
  const keyPrefix = `${keyLabel}:`
  const bodyFont = options.bodyFont ?? 'Cour'
  const bodySource = options.bodyText ?? payload
  const detailBlocks = descriptorPdfDetailLines(wallet, label, keyLabel)
  const bodyWrapped = bodySource
    .split('\n')
    .flatMap((line) => wrapLines(line, BODY_SIZE, bodyFont, CONTENT_W))
  const detailWithGaps: string[] = []
  detailBlocks.forEach((block, i) => {
    detailWithGaps.push(...wrapLines(block, DETAIL_SIZE, 'Helv', CONTENT_W))
    if (block.startsWith(keyPrefix) && i < detailBlocks.length - 1) detailWithGaps.push('')
  })

  const titleBlock = TITLE_SIZE + 6
  const gapAfterTitle = 10
  const bodyLineH = BODY_SIZE + 3
  const detailLineH = DETAIL_SIZE + 3
  const gapAroundQr = 16
  const qrPt = QR_PT
  const qrPx = qrPt * 3
  const descriptorHeight = bodyWrapped.length * bodyLineH
  const detailsHeight = Math.max(detailWithGaps.length, 1) * detailLineH
  // Grow past the classic landscape height when multisig (or long) details need room.
  const contentH =
    MARGIN +
    titleBlock +
    gapAfterTitle +
    descriptorHeight +
    gapAroundQr +
    qrPt +
    gapAroundQr +
    detailsHeight +
    MARGIN
  const pageH = Math.max(PAGE_H_MIN, Math.ceil(contentH))

  let y = pageH - MARGIN
  const titleY = y - TITLE_SIZE
  y = titleY - gapAfterTitle

  const bodyLines: { text: string; y: number }[] = []
  for (const line of bodyWrapped) {
    y -= bodyLineH
    bodyLines.push({ text: line, y })
  }

  y -= gapAroundQr
  const qrY = y - qrPt
  y = qrY - gapAroundQr

  const detailLines: { text: string; y: number }[] = []
  for (const line of detailWithGaps) {
    y -= detailLineH
    if (line) detailLines.push({ text: line, y })
  }

  const qrFlate = await qrRgbFlate(payload, qrPx)
  return buildPdf({
    title,
    pageH,
    titleY,
    bodyLines,
    detailLines,
    qrY,
    qrPt,
    qrPx,
    qrFlate,
  })
}
