/** Coin amount parse/format without float drift (matches Swift SendWizardView). */

/** Normalize txid:index outpoint keys (matches backend `_norm_txid`). */
export function normalizeOutpointKey(key: string): string {
  const trimmed = key.trim()
  const colon = trimmed.lastIndexOf(':')
  if (colon <= 0) return trimmed.toLowerCase()
  const txid = trimmed.slice(0, colon).trim().toLowerCase().replace(/^0x/i, '')
  const idx = trimmed.slice(colon + 1).trim()
  return `${txid}:${idx}`
}

export function parseSendAmount(raw: string): number | null {
  const t = raw.trim()
  if (!t || t.length > 20) return null
  const v = Number(t)
  if (!Number.isFinite(v) || v <= 0 || v > 21_000_000) return null
  return v
}

export function parseSendSompi(raw: string): number | null {
  const t = raw.trim()
  if (!t) return null
  const parts = t.split('.')
  const whole = Number(parts[0])
  if (!Number.isFinite(whole) || whole < 0) return null
  let frac = 0
  if (parts.length > 1) {
    const fracStr = parts[1].slice(0, 8)
    const padded = fracStr.padEnd(8, '0')
    frac = Number(padded)
    if (!Number.isFinite(frac)) return null
  }
  return whole * 100_000_000 + frac
}

export function formatSendKas(fromSompi: number): string {
  const whole = Math.floor(fromSompi / 100_000_000)
  const frac = fromSompi % 100_000_000
  return `${whole}.${String(frac).padStart(8, '0')}`
}

export function utxoAmountSompi(u: { amount: number; amount_kas?: number; amount_btc?: number }): number {
  if (u.amount > 0) {
    if (u.amount < 1) return Math.max(1, Math.round(u.amount * 100_000_000))
    return Math.round(u.amount)
  }
  const coin = u.amount_btc ?? u.amount_kas
  if (coin != null && coin > 0) return Math.max(0, Math.round(coin * 100_000_000))
  return 0
}

export function editableFiatText(value: number, currency: string): string {
  if (!Number.isFinite(value) || value < 0) return ''
  if (currency === 'JPY') return String(Math.round(value))
  const digits = value >= 100 ? 2 : 4
  return value.toFixed(digits)
}

export function coinAmountLabel(amount: number, unit: string): string {
  return `${amount.toFixed(8)} ${unit}`
}
