/** Client-side Bitcoin fee / max-send helpers (no network). */

import { utxoAmountSompi } from '@renderer/utils/sendAmount'
import type { UtxoDTO } from '@renderer/api/types'

const VBYTES_OVERHEAD = 11
const VBYTES_PER_INPUT = 68
const VBYTES_PER_OUTPUT = 31
const MIN_RELAY_FEE_SATS = 141
/** Standard P2WPKH dust threshold (sats). */
const DUST_CHANGE_SATS = 546
const DEFAULT_FEERATE_SAT_VB = 1
const MAX_LOCAL_FEERATE_SAT_VB = 500
const MIN_LOCAL_FEERATE_SAT_VB = 0.1

export function clampBitcoinFeerate(feerateSatVb: number): number {
  if (!Number.isFinite(feerateSatVb) || feerateSatVb <= 0) return DEFAULT_FEERATE_SAT_VB
  return Math.min(
    MAX_LOCAL_FEERATE_SAT_VB,
    Math.max(MIN_LOCAL_FEERATE_SAT_VB, Math.round(feerateSatVb * 1000) / 1000),
  )
}

/** Format live sat/vB for the fee tier UI (keeps fractional network quotes). */
export function formatBitcoinFeerate(feerateSatVb: number): string {
  const rate = clampBitcoinFeerate(feerateSatVb)
  if (rate >= 10) return String(Math.round(rate))
  const fixed = rate.toFixed(2).replace(/\.?0+$/, '')
  return fixed || String(rate)
}

export type BitcoinFeeTierId = 'slow' | 'normal' | 'priority'

/** Typical confirmation window for Slow / Normal / Priority (mempool targets). */
export function bitcoinFeeTierEta(tier: BitcoinFeeTierId): string {
  switch (tier) {
    case 'slow':
      return '~1 hour+'
    case 'normal':
      return '~30 minutes'
    case 'priority':
      return '~10 minutes'
  }
}

/** Live network feerates from mempool/esplora (sat/vB). */
export type BitcoinNetworkFeerates = {
  fastest?: number
  halfHour?: number
  hour?: number
  economy?: number
  minimum?: number
  [key: string]: number | undefined
}

/**
 * Map live network fee estimates → Slow / Normal / Priority.
 * Uses quoted rates only — never invents higher tiers than the network reports.
 */
export function resolveBitcoinTierRates(
  rates: BitcoinNetworkFeerates | null | undefined,
): Record<BitcoinFeeTierId, number> {
  // Offline last resort only (shown until live quotes arrive).
  const fallback = { slow: 0.5, normal: 1, priority: 2 }
  if (!rates) return fallback

  const pick = (...keys: string[]): number | null => {
    for (const key of keys) {
      const v = rates[key]
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return clampBitcoinFeerate(v)
    }
    return null
  }

  const hasAny = pick('fastest', 'halfHour', 'hour', 'economy', 'minimum') != null
  if (!hasAny) return fallback

  let priority = pick('fastest', 'halfHour') ?? fallback.priority
  let normal = pick('halfHour', 'hour', 'fastest') ?? fallback.normal
  let slow = pick('economy', 'minimum', 'hour') ?? Math.min(normal, priority)

  // Order only — never bump Priority above the live quote.
  if (slow > normal) slow = normal
  if (normal > priority) normal = priority
  if (slow > normal) slow = normal

  return { slow, normal, priority }
}

export function estimateBitcoinVbytes(inputCount: number, outputCount = 2): number {
  return VBYTES_OVERHEAD + Math.max(1, inputCount) * VBYTES_PER_INPUT + Math.max(1, outputCount) * VBYTES_PER_OUTPUT
}

export function estimateBitcoinFeeSats(inputCount: number, feerateSatVb = DEFAULT_FEERATE_SAT_VB, outputCount = 2): number {
  return Math.max(
    MIN_RELAY_FEE_SATS,
    Math.ceil(clampBitcoinFeerate(feerateSatVb) * estimateBitcoinVbytes(inputCount, outputCount)),
  )
}

/** True when balance cannot fund a change-output tx at the selected feerate (dust / sweep). */
export function bitcoinNeedsLocalFeeEstimate(
  totalSompi: number,
  inputCount: number,
  feerateSatVb = DEFAULT_FEERATE_SAT_VB,
): boolean {
  if (totalSompi <= 0) return false
  const inputs = Math.max(1, inputCount)
  return totalSompi <= estimateBitcoinFeeSats(inputs, feerateSatVb, 2)
}

/** Fee at the selected feerate for 2 outputs, or 1-output sweep — never collapse to flat 141. */
export function affordableBitcoinFeeSats(
  totalSompi: number,
  inputCount: number,
  feerateSatVb = DEFAULT_FEERATE_SAT_VB,
): number {
  const inputs = Math.max(1, inputCount)
  const withChange = estimateBitcoinFeeSats(inputs, feerateSatVb, 2)
  if (totalSompi <= 0) return withChange
  if (totalSompi > withChange) return withChange
  // Not enough for payment + change: still charge the selected feerate on a 1-output sweep.
  return estimateBitcoinFeeSats(inputs, feerateSatVb, 1)
}

export function bitcoinSweepOnlyWallet(
  totalSompi: number,
  inputCount: number,
  feerateSatVb = DEFAULT_FEERATE_SAT_VB,
): boolean {
  return bitcoinNeedsLocalFeeEstimate(totalSompi, inputCount, feerateSatVb)
}

function invalidDustChange(totalSompi: number, sendSompi: number, feeSats: number): boolean {
  const change = totalSompi - sendSompi - feeSats
  return change > 0 && change < DUST_CHANGE_SATS
}

/** Prefer 1-output fee at the selected feerate when change cannot be funded. */
export function bitcoinSweepFeeSats(
  totalSompi: number,
  inputCount: number,
  feerateSatVb = DEFAULT_FEERATE_SAT_VB,
): number {
  return affordableBitcoinFeeSats(totalSompi, inputCount, feerateSatVb)
}

export function capBitcoinFeeForCoins(
  feeSats: number,
  totalSompi: number,
  inputCount: number,
  feerateSatVb = DEFAULT_FEERATE_SAT_VB,
): number {
  if (totalSompi <= 0) return feeSats
  return Math.min(feeSats, affordableBitcoinFeeSats(totalSompi, inputCount, feerateSatVb))
}

export function quickBitcoinMaxSendSompi(
  totalSompi: number,
  inputCount: number,
  feerateSatVb = DEFAULT_FEERATE_SAT_VB,
): number {
  if (totalSompi <= 0) return 0
  for (const outputCount of [2, 1] as const) {
    const fee = estimateBitcoinFeeSats(inputCount, feerateSatVb, outputCount)
    const maxSompi = totalSompi - fee
    if (maxSompi > 0) return maxSompi
  }
  return 0
}

/** Greedy coin selection: how many inputs cover send amount + fee (not every UTXO). */
export function bitcoinFeeInputCount(
  utxos: UtxoDTO[],
  totalSompi: number,
  sendSompi?: number | null,
  feerateSatVb = DEFAULT_FEERATE_SAT_VB,
): number {
  const amounts = utxos.map((u) => utxoAmountSompi(u)).filter((a) => a > 0).sort((a, b) => b - a)
  if (amounts.length === 0) return 1
  const target =
    sendSompi != null && sendSompi > 0
      ? sendSompi
      : Math.max(0, totalSompi - estimateBitcoinFeeSats(1, feerateSatVb))
  let selected = 0
  let sum = 0
  for (const amt of amounts) {
    selected += 1
    sum += amt
    const fee = estimateBitcoinFeeSats(selected, feerateSatVb)
    if (sum >= target + fee) return selected
  }
  return Math.max(1, selected)
}

/** Max send with greedy input selection; tries 2-output then 1-output (sweep) fee. */
export function bitcoinMaxSendFromUtxos(
  utxos: UtxoDTO[],
  feerateSatVb = DEFAULT_FEERATE_SAT_VB,
): { maxSompi: number; inputCount: number; feeSats: number } {
  const amounts = utxos.map((u) => utxoAmountSompi(u)).filter((a) => a > 0).sort((a, b) => b - a)
  if (amounts.length === 0) {
    return { maxSompi: 0, inputCount: 1, feeSats: MIN_RELAY_FEE_SATS }
  }
  let selected = 0
  let sum = 0
  for (const amt of amounts) {
    selected += 1
    sum += amt
    for (const outputCount of [2, 1] as const) {
      let fee =
        outputCount === 1
          ? bitcoinSweepFeeSats(sum, selected, feerateSatVb)
          : estimateBitcoinFeeSats(selected, feerateSatVb, outputCount)
      if (sum > fee) {
        return { maxSompi: sum - fee, inputCount: selected, feeSats: fee }
      }
    }
  }
  const fee = estimateBitcoinFeeSats(Math.max(1, selected), feerateSatVb, 1)
  return { maxSompi: 0, inputCount: Math.max(1, selected), feeSats: fee }
}

function balanceOnlyFeeSummary(
  effectiveTotal: number,
  feerateSatVb: number,
): { maxSompi: number; inputCount: number; feeSats: number } | null {
  const inputCount = 1
  for (const outputCount of [2, 1] as const) {
    const feeSats =
      outputCount === 1
        ? bitcoinSweepFeeSats(effectiveTotal, inputCount, feerateSatVb)
        : estimateBitcoinFeeSats(inputCount, feerateSatVb, outputCount)
    const maxSompi = Math.max(0, effectiveTotal - feeSats)
    if (maxSompi > 0) return { maxSompi, inputCount, feeSats }
  }
  return null
}

/** Local fee / max-send for Send wizard (handles empty UTXO list + partial amounts). */
export function bitcoinSendFeeSummary(
  utxos: UtxoDTO[],
  totalSompiFallback: number,
  feerateSatVb = DEFAULT_FEERATE_SAT_VB,
  sendSompi?: number | null,
  customFeeSats?: number | null,
): { maxSompi: number; inputCount: number; feeSats: number } | null {
  const spendable = utxos.filter((u) => utxoAmountSompi(u) > 0)
  const totalFromUtxos = spendable.reduce((sum, u) => sum + utxoAmountSompi(u), 0)
  const effectiveTotal = Math.max(totalFromUtxos, totalSompiFallback)
  if (effectiveTotal <= 0) return null

  if (customFeeSats != null && customFeeSats > 0) {
    const feeSats = Math.max(MIN_RELAY_FEE_SATS, Math.round(customFeeSats))
    const inputCount = Math.max(1, spendable.length)
    if (feeSats > effectiveTotal) return null
    const maxSompi = Math.max(0, effectiveTotal - feeSats)
    if (sendSompi != null && sendSompi > 0) {
      if (sendSompi + feeSats > effectiveTotal) return null
      if (invalidDustChange(effectiveTotal, sendSompi, feeSats)) return null
    }
    return { maxSompi, inputCount, feeSats }
  }

  if (sendSompi != null && sendSompi > 0) {
    if (spendable.length > 0) {
      const selectedTotal = spendable.reduce((sum, u) => sum + utxoAmountSompi(u), 0)
      const inputCount = bitcoinFeeInputCount(spendable, effectiveTotal, sendSompi, feerateSatVb)
      const sweepFee = bitcoinSweepFeeSats(selectedTotal, inputCount, feerateSatVb)
      const maxSweepSompi = Math.max(0, selectedTotal - sweepFee)

      // Full sweep (1 output).
      if (sendSompi <= maxSweepSompi && sendSompi + sweepFee >= selectedTotal - 1) {
        return { maxSompi: maxSweepSompi, inputCount, feeSats: sweepFee }
      }

      if (bitcoinSweepOnlyWallet(selectedTotal, inputCount, feerateSatVb) && sendSompi < maxSweepSompi) {
        return null
      }

      let feeSats = estimateBitcoinFeeSats(inputCount, feerateSatVb)
      feeSats = capBitcoinFeeForCoins(feeSats, selectedTotal, inputCount, feerateSatVb)
      if (invalidDustChange(selectedTotal, sendSompi, feeSats)) return null
      if (sendSompi + feeSats <= selectedTotal) {
        return {
          maxSompi: Math.max(0, selectedTotal - feeSats),
          inputCount,
          feeSats,
        }
      }
    } else if (sendSompi + estimateBitcoinFeeSats(1, feerateSatVb) <= effectiveTotal) {
      return balanceOnlyFeeSummary(effectiveTotal, feerateSatVb)
    }
    return null
  }

  if (spendable.length > 0) {
    const result = bitcoinMaxSendFromUtxos(spendable, feerateSatVb)
    if (result.maxSompi > 0) return result
  }

  return balanceOnlyFeeSummary(effectiveTotal, feerateSatVb)
}

/** Last-resort fee when UTXO metadata is incomplete but wallet balance is known. */
export function bitcoinFallbackFeeSummary(
  totalSompi: number,
  feerateSatVb = DEFAULT_FEERATE_SAT_VB,
): { maxSompi: number; inputCount: number; feeSats: number } | null {
  if (totalSompi <= 0) return null
  return balanceOnlyFeeSummary(totalSompi, feerateSatVb)
}
