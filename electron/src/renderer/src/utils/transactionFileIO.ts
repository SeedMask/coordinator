import { isBitcoinSignedPsbt, isSignedKaspaTransaction } from '@renderer/utils/buildSummary'

export type KaspaTransactionKind = 'unsigned' | 'signed' | 'unknown'

export const PSBT_MAGIC = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff])

export function isPsbtBinary(data: Uint8Array): boolean {
  return data.length >= PSBT_MAGIC.length && PSBT_MAGIC.every((b, i) => data[i] === b)
}

export function kaspaTransactionKind(data: Uint8Array): KaspaTransactionKind {
  try {
    const text = new TextDecoder().decode(data)
    const obj = JSON.parse(text) as Record<string, unknown>
    const root = obj
    const unsigned = (obj.unsigned as Record<string, unknown> | undefined) ?? obj
    if (unsigned.signatures != null && unsigned.inputs == null) return 'signed'
    if (root.signatures != null && root.inputs == null) return 'signed'
    const inputs = unsigned.inputs
    if (Array.isArray(inputs)) {
      if (
        inputs.some((inp) => {
          if (!inp || typeof inp !== 'object') return false
          const script = String((inp as Record<string, unknown>).signature_script ?? '').trim()
          return script.length > 0
        })
      ) {
        return 'signed'
      }
      return 'unsigned'
    }
  } catch {
    /* binary or invalid */
  }
  return 'unknown'
}

export function signedJSONString(data: Uint8Array): string {
  const text = new TextDecoder().decode(data).trim()
  if (text.startsWith('{')) {
    if (kaspaTransactionKind(data) === 'signed') return text
    try {
      const obj = JSON.parse(text) as Record<string, unknown>
      const inputs = obj.inputs
      if (
        Array.isArray(inputs) &&
        inputs.length > 0 &&
        inputs.some((inp) => {
          if (!inp || typeof inp !== 'object') return false
          return String((inp as Record<string, unknown>).signature_script ?? '').trim().length > 0
        })
      ) {
        return text
      }
      if (isBitcoinSignedPsbt(obj)) return text
    } catch {
      /* fall through */
    }
  }
  const b64 = bytesToBase64(data)
  return JSON.stringify({ format: 'bitcoin_psbt', psbt_base64: b64 })
}

/** Flat JSON v2 for SeedMask microSD / Sign screen (device reads ≤4 KB; no PSKT wrapper). */
export function exportDeviceV2(forUnsigned: Record<string, unknown>): Uint8Array {
  const v2 = { ...forUnsigned }
  if (v2.version == null) v2.version = 2
  return new TextEncoder().encode(JSON.stringify(sortObjectKeys(v2)))
}

export function unwrapUnsignedImport(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed
  const dict = parsed as Record<string, unknown>
  if (dict.inputs == null && dict.unsigned != null) return dict.unsigned
  return parsed
}

export function bitcoinDraftEnvelope(psbtBase64: string): Record<string, unknown> {
  return {
    format: 'seedpass_psbt_draft_v1',
    coin: 'bitcoin',
    psbt_base64: psbtBase64,
    psbts: [psbtBase64],
  }
}

function sortObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortObjectKeys)
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    out[key] = sortObjectKeys(record[key])
  }
  return out
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}
