import type { CoinChain } from '@renderer/api/types'
import type { ExtendedKeyMetadata } from './bitcoinWallet'

const XPUB_PREFIXES = ['xpub', 'ypub', 'zpub', 'tpub', 'upub', 'vpub']
const ALL_PREFIXES = ['kpub', ...XPUB_PREFIXES]

export function extractKey(raw: string): string {
  const s = raw.trim()
  if (s.split(/\s+/).length > 1) {
    const last = s.split(/\s+/).pop() ?? s
    if (ALL_PREFIXES.some((p) => last.toLowerCase().startsWith(p))) return last
  }
  return s
}

export function extractKeyForCoin(coin: CoinChain, raw: string): string {
  const s = raw.trim()
  if (s.toUpperCase().startsWith('SM|')) {
    const key = s.split('|').pop()?.trim()
    if (key) return key
  }
  if (coin === 'kaspa') {
    if (s.split(/\s+/).length > 1) {
      const last = s.split(/\s+/).pop() ?? s
      if (last.toLowerCase().startsWith('kpub')) return last
    }
    if (s.toLowerCase().startsWith('kpub')) return s
    return s
  }
  return extractKey(raw)
}

export function validateXpub(raw: string): string | null {
  const token = extractKey(raw)
  const lower = token.toLowerCase()
  if (!XPUB_PREFIXES.some((p) => lower.startsWith(p))) {
    return 'Expected a Bitcoin watch-only key (xpub / ypub / zpub)'
  }
  if (token.length < 100) {
    return 'Key looks too short — export again from SeedMask'
  }
  return null
}

export function validateKpub(raw: string): string | null {
  const s = raw.trim()
  if (!s) return 'Paste or scan your kpub from SeedMask'
  if (s.includes(' ') && !s.toLowerCase().startsWith('kpub')) {
    return 'Paste only the kpub string, not the full label line'
  }
  const token = s.split(/\s+/).pop() ?? s
  if (!token.toLowerCase().startsWith('kpub')) {
    return 'Expected a Kaspa watch-only key (starts with kpub)'
  }
  if (token.length < 100) {
    return 'Key looks too short — export again from SeedMask'
  }
  return null
}

export function importKeyValidationError(coin: CoinChain, key: string): string | null {
  return coin === 'bitcoin' ? validateXpub(key) : validateKpub(key)
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const EXTENDED_PUB_VERSIONS: Record<string, number> = {
  xpub: 0x0488b21e,
  ypub: 0x049d7cb2,
  zpub: 0x04b24746,
  tpub: 0x043587cf,
  upub: 0x044a5262,
  vpub: 0x045f1cf6,
}

function sha256Bytes(data: Uint8Array): Uint8Array {
  // SubtleCrypto is async; use a tiny sync SHA-256 for checksum only.
  // Prefer Web Crypto when available via a precomputed path is awkward here —
  // use the classic pure-JS SHA-256 below.
  return sha256Sync(data)
}

function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n))
}

function sha256Sync(message: Uint8Array): Uint8Array {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const l = message.length
  const bitLen = l * 8
  const withOne = l + 1
  const total = ((withOne + 8 + 63) & ~63)
  const bytes = new Uint8Array(total)
  bytes.set(message)
  bytes[l] = 0x80
  const view = new DataView(bytes.buffer)
  view.setUint32(total - 4, bitLen >>> 0)
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000))
  const w = new Uint32Array(64)
  for (let i = 0; i < total; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4)
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(7, w[j - 15]) ^ rotr(18, w[j - 15]) ^ (w[j - 15] >>> 3)
      const s1 = rotr(17, w[j - 2]) ^ rotr(19, w[j - 2]) ^ (w[j - 2] >>> 10)
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[j] + w[j]) >>> 0
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0
    H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0
    H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0
    H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0
    H[7] = (H[7] + h) >>> 0
  }
  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i])
  return out
}

function b58Decode(str: string): Uint8Array {
  const bytes: number[] = [0]
  for (const ch of str) {
    const val = B58.indexOf(ch)
    if (val < 0) throw new Error('Invalid base58 character')
    let carry = val
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  let zeros = 0
  for (const ch of str) {
    if (ch === '1') zeros++
    else break
  }
  const out = new Uint8Array(zeros + bytes.length)
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i]
  return out
}

function b58Encode(data: Uint8Array): string {
  const digits = [0]
  for (let bi = 0; bi < data.length; bi++) {
    let carry = data[bi]
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let zeros = 0
  for (let bi = 0; bi < data.length; bi++) {
    if (data[bi] === 0) zeros++
    else break
  }
  let out = '1'.repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]]
  return out
}

function b58CheckDecode(str: string): Uint8Array {
  const raw = b58Decode(str)
  if (raw.length < 5) throw new Error('Invalid base58check payload')
  const payload = raw.slice(0, -4)
  const checksum = raw.slice(-4)
  const hash = sha256Bytes(sha256Bytes(payload))
  for (let i = 0; i < 4; i++) {
    if (hash[i] !== checksum[i]) throw new Error('Invalid base58check checksum')
  }
  return payload
}

function b58CheckEncode(payload: Uint8Array): string {
  const hash = sha256Bytes(sha256Bytes(payload))
  const full = new Uint8Array(payload.length + 4)
  full.set(payload)
  full.set(hash.slice(0, 4), payload.length)
  return b58Encode(full)
}

export type BitcoinExtendedPubPrefix = 'xpub' | 'ypub' | 'zpub' | 'tpub' | 'upub' | 'vpub'

export function bitcoinExtendedPubPrefix(key: string): BitcoinExtendedPubPrefix | null {
  const prefix = extractKey(key).slice(0, 4).toLowerCase()
  return prefix in EXTENDED_PUB_VERSIONS ? (prefix as BitcoinExtendedPubPrefix) : null
}

export function convertBitcoinExtendedPubkey(key: string, target: BitcoinExtendedPubPrefix): string {
  const token = extractKey(key)
  const payload = b58CheckDecode(token)
  if (payload.length < 4) throw new Error('Invalid extended key')
  const version = EXTENDED_PUB_VERSIONS[target]
  if (version == null) throw new Error(`Unsupported target ${target}`)
  const next = new Uint8Array(payload)
  next[0] = (version >>> 24) & 0xff
  next[1] = (version >>> 16) & 0xff
  next[2] = (version >>> 8) & 0xff
  next[3] = version & 0xff
  return b58CheckEncode(next)
}

/** Script-native SLIP-132 form for toggling against standard xpub. */
export function scriptNativeExtendedPrefix(
  scriptType?: string | null,
  derivation?: string | null,
): 'ypub' | 'zpub' | null {
  const path = (derivation || '').trim()
  // Multisig account paths use different SLIP-132 versions; skip toggle there.
  if (path.includes("/48'") || path.startsWith("m/48'")) return null
  if (path.includes("/84'") || path.startsWith("m/84'")) return 'zpub'
  if (path.includes("/49'") || path.startsWith("m/49'")) return 'ypub'
  const script = (scriptType || '').trim().toLowerCase()
  if (script === 'native_segwit' || script === 'p2wpkh') return 'zpub'
  if (script === 'nested_segwit' || script === 'p2sh-p2wpkh') return 'ypub'
  return null
}

export function alternateBitcoinExtendedPubkey(
  key: string,
  scriptType?: string | null,
  derivation?: string | null,
): { label: string; key: string } | null {
  const current = bitcoinExtendedPubPrefix(key)
  if (!current) return null
  const native = scriptNativeExtendedPrefix(scriptType, derivation)
  try {
    // Already SLIP-132 → always offer standard xpub/tpub (even if script meta is missing).
    if (current === 'zpub' || current === 'ypub') {
      const converted = convertBitcoinExtendedPubkey(key, 'xpub')
      return { label: 'XPUB', key: converted }
    }
    if (current === 'vpub' || current === 'upub') {
      const converted = convertBitcoinExtendedPubkey(key, 'tpub')
      return { label: 'TPUB', key: converted }
    }
    // Standard xpub/tpub → script-native form (default zpub/vpub when script unknown).
    if (current === 'xpub' || current === 'tpub') {
      const target = native ?? (current === 'tpub' ? 'zpub' : 'zpub')
      const slipTarget: BitcoinExtendedPubPrefix =
        current === 'tpub' ? (target === 'ypub' ? 'upub' : 'vpub') : target
      const converted = convertBitcoinExtendedPubkey(key, slipTarget)
      return { label: slipTarget.toUpperCase(), key: converted }
    }
  } catch {
    return null
  }
  return null
}

interface BitcoinExportJson {
  xfp?: string
  deriv?: string
  derivation?: string
  xpub?: string
  ypub?: string
  zpub?: string
}

function parseSmPipePayload(raw: string, coin: CoinChain): Partial<ExtendedKeyMetadata> & { key?: string } | null {
  if (!raw.toUpperCase().startsWith('SM|')) return null
  const parts = raw.split('|')
  if (parts.length === 3) {
    return {
      fingerprint: normalizeSmFingerprint(parts[1]),
      key: parts[2]?.trim(),
    }
  }
  if (parts.length >= 4) {
    const deriv = parts[2]?.trim()
    return {
      fingerprint: normalizeSmFingerprint(parts[1]),
      derivation: deriv?.startsWith('m/') ? deriv : undefined,
      key: parts.slice(3).join('|').trim(),
    }
  }
  return null
}

function normalizeSmFingerprint(raw?: string): string {
  if (!raw) return ''
  const cleaned = raw.trim().toUpperCase()
  return cleaned.length === 8 && /^[0-9A-F]+$/.test(cleaned) ? cleaned : ''
}

export function parseExtendedKeyMetadata(raw: string, coin: CoinChain): ExtendedKeyMetadata | null {
  const trimmed = raw.trim()
  let key = extractKeyForCoin(coin, trimmed)
  let explicitDerivation: string | undefined
  let explicitFingerprint: string | undefined

  const sm = parseSmPipePayload(trimmed, coin)
  if (sm) {
    key = sm.key ?? key
    explicitDerivation = sm.derivation
    explicitFingerprint = sm.fingerprint
  } else if (coin === 'bitcoin' && trimmed.startsWith('{')) {
    try {
      const wrapped = JSON.parse(trimmed) as BitcoinExportJson
      key = [wrapped.xpub, wrapped.ypub, wrapped.zpub].find((k) => k?.trim()) ?? key
      const deriv = (wrapped.deriv ?? wrapped.derivation)?.trim()
      if (deriv?.startsWith('m/')) explicitDerivation = deriv
      explicitFingerprint = normalizeSmFingerprint(wrapped.xfp)
    } catch {
      /* not JSON */
    }
  }

  const valid = importKeyValidationError(coin, key)
  if (valid != null) return null

  const accountFromPath = (path: string): number | undefined => {
    // BIP48: m/48'/coin'/account'/script' — account is the third index, not script type.
    const bip48 = path.match(/^m\/48'\/\d+'\/(\d+)'\/\d+'/i)
    if (bip48) {
      const n = Number(bip48[1])
      return Number.isFinite(n) ? n : undefined
    }
    const accountMatch = path.match(/\/(\d+)'\s*$/)
    if (!accountMatch) return undefined
    const n = Number(accountMatch[1])
    return Number.isFinite(n) ? n : undefined
  }

  if (coin === 'kaspa') {
    // Bare kpub has no account — only SM|/JSON derivation is authoritative.
    if (explicitDerivation) {
      return {
        derivation: explicitDerivation,
        fingerprint: explicitFingerprint ?? '',
        account: accountFromPath(explicitDerivation),
        coin,
      }
    }
    return {
      derivation: "m/44'/111111'/0'",
      fingerprint: explicitFingerprint ?? '',
      coin,
    }
  }

  const fromVersion = derivationFromSlip132Version(key)
  if (explicitDerivation) {
    return {
      derivation: explicitDerivation,
      fingerprint: explicitFingerprint ?? '',
      account: accountFromPath(explicitDerivation),
      coin,
    }
  }
  if (fromVersion) {
    return {
      derivation: fromVersion,
      fingerprint: explicitFingerprint ?? '',
      account: accountFromPath(fromVersion),
      coin,
    }
  }
  const scriptGuess = scriptPrefixFromKey(key)
  if (!scriptGuess) {
    return {
      derivation: '',
      fingerprint: explicitFingerprint ?? '',
      coin,
    }
  }
  return {
    derivation: `${scriptGuess}/0'`,
    fingerprint: explicitFingerprint ?? '',
    coin,
  }
}

/** SLIP-132 multisig Ypub/Zpub (child_num = script type) vs singlesig ypub/zpub. */
function derivationFromSlip132Version(key: string): string | null {
  try {
    const payload = b58CheckDecode(extractKey(key))
    if (payload.length < 4) return null
    const v = (payload[0]! << 24) | (payload[1]! << 16) | (payload[2]! << 8) | payload[3]!
    // Ypub — BIP48 P2WSH-P2SH
    if (v === 0x0295b43f) return "m/48'/0'/0'/1'"
    // Zpub — BIP48 P2WSH
    if (v === 0x02aa7ed3) return "m/48'/0'/0'/2'"
    // ypub / zpub / vpub singlesig account prefixes (caller appends /account')
    if (v === 0x049d7cb2) return "m/49'/0'/0'"
    if (v === 0x04b24746) return "m/84'/0'/0'"
    if (v === 0x045f1cf6) return "m/84'/1'/0'"
    if (v === 0x044a5262) return "m/49'/1'/0'"
  } catch {
    /* ignore */
  }
  return null
}

function scriptPrefixFromKey(key: string): string | null {
  // Prefer version bytes so capital-Y Ypub is not mistaken for singlesig ypub.
  const fromVersion = derivationFromSlip132Version(key)
  if (fromVersion) {
    if (fromVersion.startsWith("m/48'")) return fromVersion
    // Singlesig paths already include account 0'.
    return fromVersion.replace(/\/\d+'$/, '') || null
  }
  switch (key.slice(0, 4).toLowerCase()) {
    case 'ypub':
    case 'upub':
      return "m/49'/0'"
    case 'zpub':
    case 'vpub':
      return "m/84'/0'"
    default:
      // Bare xpub/tpub is ambiguous (Legacy BIP44, Taproot BIP86, or Native SegWit).
      // Do not invent m/84' — keep the script type the user already selected.
      return null
  }
}
