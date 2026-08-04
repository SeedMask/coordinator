const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function isBech32Payload(s: string): boolean {
  if (s.length < 59 || s.length > 61) return false
  for (let i = 0; i < s.length; i++) {
    if (!BECH32_CHARSET.includes(s.charAt(i))) return false
  }
  return true
}

/** Normalize pasted Kaspa payee addresses before API validation (Swift KaspaAddressValidator). */
export function normalizeKaspaAddress(raw: string): string {
  let s = raw.trim().replace(/\s/g, '')
  const q = s.indexOf('?')
  if (q >= 0) s = s.slice(0, q)
  const h = s.indexOf('#')
  if (h >= 0) s = s.slice(0, h)
  const lower = s.toLowerCase()
  if (lower.startsWith('kaspatest:') || lower.startsWith('kaspasim:')) {
    return lower
  }
  const embedded = lower.match(/kaspa:[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{59,61}/)
  if (embedded) return embedded[0]
  const colon = s.indexOf(':')
  if (colon >= 0) {
    const hrp = s.slice(0, colon).toLowerCase()
    const data = s.slice(colon + 1).toLowerCase()
    if (hrp === 'kaspa') return `kaspa:${data}`
  }
  if (!lower.startsWith('kaspa:') && isBech32Payload(lower)) {
    return `kaspa:${lower}`
  }
  return lower
}

/** Fast client-side check before Review — full checksum still runs at build time. */
export function isLikelyValidKaspaAddress(raw: string): boolean {
  const normalized = normalizeKaspaAddress(raw)
  if (!normalized.startsWith('kaspa:')) return false
  const payload = normalized.slice('kaspa:'.length)
  return isBech32Payload(payload)
}
