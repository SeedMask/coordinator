import type { DisplayCurrency } from '@renderer/api/types'

const SYMBOLS: Record<DisplayCurrency, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CAD: 'CA$',
  CHF: 'CHF ',
  AUD: 'A$',
}

export function currencySymbol(c: DisplayCurrency): string {
  return SYMBOLS[c]
}

export function formatFiat(fiatValue: number, currency: DisplayCurrency): string {
  if (!Number.isFinite(fiatValue) || fiatValue < 0) return ''
  const symbol = currencySymbol(currency)
  if (currency === 'JPY') return `${symbol}${Math.round(fiatValue)}`
  const digits = fiatValue >= 100 ? 2 : fiatValue >= 1 ? 2 : 4
  return `${symbol}${fiatValue.toFixed(digits)}`
}

export function formatCoinFiat(coinAmount: number, unitPrice: number, currency: DisplayCurrency): string {
  return formatFiat(coinAmount * unitPrice, currency)
}
