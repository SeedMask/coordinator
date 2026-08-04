import type { BitcoinDisplayUnit, CoinChain, DisplayCurrency } from '@renderer/api/types'
import { coinDisplayUnit, formatCoinUnitsLabel, usesBitcoinSats } from '@renderer/utils/coinDisplay'
import { formatCoinFiat } from '@renderer/utils/fiatFormat'

export function visualUnit(chain: CoinChain, bitcoinUnit: BitcoinDisplayUnit): string {
  return coinDisplayUnit(chain, bitcoinUnit)
}

export function formatVisualAmount(
  amountCoin: number,
  chain: CoinChain,
  bitcoinUnit: BitcoinDisplayUnit,
): string {
  return formatCoinUnitsLabel(amountCoin, chain, bitcoinUnit)
}

/** Past tense for confirmed tx details only (Review & Sign drafts stay "Send"). */
export function applyConfirmedSummaryTense(text: string): string {
  return text.replace(/^Send /, 'Sent ').replace(/ Send /g, ' Sent ')
}

/** Rewrite backend summary strings when the user prefers sats. */
export function rewriteVisualCoinText(
  text: string,
  chain: CoinChain,
  bitcoinUnit: BitcoinDisplayUnit,
): string {
  if (!usesBitcoinSats(chain, bitcoinUnit)) return text
  const unit = coinDisplayUnit(chain, bitcoinUnit)
  return text
    .replace(/(\d+(?:\.\d+)?)\s*BTC/g, (_, n) => formatCoinUnitsLabel(parseFloat(n), chain, bitcoinUnit))
    .replace(/\bBTC\b/g, unit)
}

export function coinFiatLabel(
  amountCoin: number,
  unitPrice: number | undefined,
  currency: DisplayCurrency,
): string | null {
  if (unitPrice == null || !Number.isFinite(unitPrice)) return null
  return formatCoinFiat(amountCoin, unitPrice, currency)
}

/** Normalize chain timestamps to Unix seconds for fiat lookups. */
export function blockTimeSeconds(raw?: number | null): number | undefined {
  if (!raw || raw <= 0) return undefined
  if (raw > 10_000_000_000) return Math.floor(raw / 1000)
  return raw
}
