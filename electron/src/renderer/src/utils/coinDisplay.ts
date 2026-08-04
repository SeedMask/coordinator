import type { BitcoinDisplayUnit, CoinChain } from '@renderer/api/types'
import { coinUnit } from '@renderer/api/types'
import { coinAmountLabel, formatSendKas, parseSendSompi } from '@renderer/utils/sendAmount'

export function coinDisplayUnit(chain: CoinChain, bitcoinUnit: BitcoinDisplayUnit): string {
  if (chain === 'bitcoin' && bitcoinUnit === 'sats') return 'sats'
  return coinUnit(chain)
}

export function usesBitcoinSats(chain: CoinChain, bitcoinUnit: BitcoinDisplayUnit): boolean {
  return chain === 'bitcoin' && bitcoinUnit === 'sats'
}

/** Format sompi for amount input fields (Send wizard). */
export function formatSompiForDisplay(
  sompi: number,
  chain: CoinChain,
  bitcoinUnit: BitcoinDisplayUnit,
): string {
  if (usesBitcoinSats(chain, bitcoinUnit)) {
    return Math.max(0, Math.round(sompi)).toLocaleString('en-US')
  }
  return formatSendKas(sompi)
}

/** Parse amount field text to sompi. */
export function parseDisplayToSompi(
  raw: string,
  chain: CoinChain,
  bitcoinUnit: BitcoinDisplayUnit,
): number | null {
  if (usesBitcoinSats(chain, bitcoinUnit)) {
    const t = raw.trim().replace(/,/g, '')
    if (!t) return null
    const v = Number(t)
    if (!Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) return null
    return v
  }
  return parseSendSompi(raw)
}

/** Parse display text to coin units (BTC/KAS) for fiat sync / validation. */
export function parseDisplayToCoinAmount(
  raw: string,
  chain: CoinChain,
  bitcoinUnit: BitcoinDisplayUnit,
): number | null {
  const sompi = parseDisplayToSompi(raw, chain, bitcoinUnit)
  if (sompi == null) return null
  return sompi / 100_000_000
}

/** Label for coin-denominated amounts (review rows, fees shown as coin units). */
export function formatCoinUnitsLabel(
  amountCoin: number,
  chain: CoinChain,
  bitcoinUnit: BitcoinDisplayUnit,
): string {
  if (usesBitcoinSats(chain, bitcoinUnit)) {
    return `${Math.max(0, Math.round(amountCoin * 100_000_000)).toLocaleString('en-US')} sats`
  }
  return coinAmountLabel(amountCoin, coinUnit(chain))
}

/** Label from sompi directly. */
export function formatSompiLabel(
  sompi: number,
  chain: CoinChain,
  bitcoinUnit: BitcoinDisplayUnit,
): string {
  return formatCoinUnitsLabel(sompi / 100_000_000, chain, bitcoinUnit)
}
