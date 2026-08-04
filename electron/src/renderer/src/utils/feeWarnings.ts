/** Post-Toccata Kaspa fee warning helpers (shared by Review & Visualize). */

/** Typical simple P2PK relay after Toccata (~100 sompi/gram). */
export const KASPA_TYPICAL_RELAY_SOMPI = 203_600

/** Warn when fee is this many times the minimum relay. */
export const KASPA_HIGH_FEE_RELAY_MULTIPLIER = 10

/** Warn when feerate (sompi/gram) is at least this (5× Toccata minimum of 100). */
export const KASPA_HIGH_FEERATE_SOMPI_PER_GRAM = 500

export function isKaspaHighFee(
  feeSompi: number,
  sendSompi: number,
  minRelaySompi?: number | null,
): boolean {
  return kaspaHighFeeReason(feeSompi, sendSompi, minRelaySompi) != null
}

export function kaspaHighFeeReason(
  feeSompi: number,
  sendSompi: number,
  minRelaySompi?: number | null,
  feerateSompiPerGram?: number | null,
): string | null {
  if (feeSompi <= 0) return null
  const relay =
    minRelaySompi != null && minRelaySompi > 0 ? minRelaySompi : KASPA_TYPICAL_RELAY_SOMPI
  if (feeSompi >= relay * KASPA_HIGH_FEE_RELAY_MULTIPLIER) {
    return 'This fee is much higher than the network minimum for a transaction of this size.'
  }
  if (sendSompi > 0 && feeSompi / sendSompi >= 0.05) {
    const pct = (feeSompi / sendSompi) * 100
    return `Fee is ${pct.toFixed(1)}% of the send amount.`
  }
  if (feerateSompiPerGram != null && feerateSompiPerGram >= KASPA_HIGH_FEERATE_SOMPI_PER_GRAM) {
    return 'This fee rate is much higher than the usual network minimum.'
  }
  return null
}

export function isBitcoinHighFee(feeBtc: number, sendBtc: number): boolean {
  if (feeBtc <= 0) return false
  const relayBtc = 0.00000141
  if (feeBtc >= relayBtc * 20) return true
  if (sendBtc > 0 && feeBtc / sendBtc >= 0.05) return true
  return false
}
