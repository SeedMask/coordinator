import type { CoinChain, WalletTxDTO } from '@renderer/api/types'
import {
  dedupeWalletTransactions,
  normalizeWalletTx,
  txAmount,
  txBlockTime,
  txId,
  txIsInternalTransfer,
  txIsReceived,
} from '@renderer/utils/txHelpers'

export type AssetHistoryPeriod = '1W' | '1M' | '3M' | '1Y' | 'All'

export const ASSET_HISTORY_PERIODS: AssetHistoryPeriod[] = ['1W', '1M', '3M', '1Y', 'All']

export interface AssetFlowEvent {
  tx: WalletTxDTO
  index: number
  date: Date
  coinAmount: number
  fiatAmount?: number
  isInflow: boolean
  id: string
}

/** Network fee in whole-coin units (KAS / BTC). 0 when unknown. */
export function txFeeCoin(tx: WalletTxDTO): number {
  const raw = Number(tx.fee_sompi ?? tx.fee_sats ?? 0)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return raw / 1e8
}

export interface AssetBalanceStep {
  eventIndex: number
  balance: number
}

export interface AssetBalanceSeries {
  openingBalance: number
  steps: AssetBalanceStep[]
  closingBalance: number
}

export function periodStartDate(period: AssetHistoryPeriod, now = new Date()): Date | null {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  switch (period) {
    case '1W':
      d.setDate(d.getDate() - 7)
      return d
    case '1M':
      d.setDate(d.getDate() - 30)
      return d
    case '3M':
      d.setDate(d.getDate() - 90)
      return d
    case '1Y':
      d.setDate(d.getDate() - 365)
      return d
    case 'All':
      return null
  }
}

/** True when event date falls inside the selected period (inclusive of period start day). */
export function isInPeriod(event: Date, since: Date | null): boolean {
  if (!since) return true
  return event.getTime() >= since.getTime()
}

export function periodSummaryTitle(period: AssetHistoryPeriod): string {
  switch (period) {
    case '1W':
      return 'Last 7 days'
    case '1M':
      return 'Last 30 days'
    case '3M':
      return 'Last 3 months'
    case '1Y':
      return 'Last 12 months'
    case 'All':
      return 'All time'
  }
}

export function eventDate(tx: WalletTxDTO): Date | null {
  const t = txBlockTime(tx)
  if (t > 0) return new Date(t * 1000)
  return null
}

/** On-chain txs in the selected period — same dedupe rules as the dashboard list. */
export function walletTransactionsInPeriod(
  transactions: WalletTxDTO[],
  since: Date | null,
  chain: CoinChain,
): WalletTxDTO[] {
  const deduped = dedupeWalletTransactions(transactions, chain)
  if (!since) return deduped
  return deduped.filter((tx) => {
    const date = eventDate(tx)
    return date != null && isInPeriod(date, since)
  })
}

export function flowEventId(tx: WalletTxDTO, fallbackIndex: number): string {
  const id = txId(tx)
  if (id) return id
  return `tx-${fallbackIndex}-${txBlockTime(tx)}-${(tx.direction ?? 'u').trim()}`
}

export function flowEvents(
  transactions: WalletTxDTO[],
  since: Date | null,
  fiatByTxId: Record<string, number>,
  walletAddresses: ReadonlySet<string> = new Set(),
  chain: CoinChain = 'kaspa',
): AssetFlowEvent[] {
  const dated = transactions
    .map((tx, index) => ({ tx: normalizeWalletTx(tx), date: eventDate(tx), index }))
    .filter((row): row is { tx: WalletTxDTO; date: Date; index: number } => row.date != null)
  const sorted = dated.sort((a, b) => a.date.getTime() - b.date.getTime())
  const events: AssetFlowEvent[] = []
  const seen = new Set<string>()
  for (const { tx, date, index } of sorted) {
    if (since && !isInPeriod(date, since)) continue
    const id = flowEventId(tx, index)
    if (seen.has(id)) continue
    seen.add(id)
    // Self-transfers stay in the wallet — omit from In / Out / chart bars.
    if (txIsInternalTransfer(tx, walletAddresses, chain)) continue
    events.push({
      tx,
      index: events.length,
      date,
      coinAmount: Math.abs(txAmount(tx)),
      fiatAmount: fiatByTxId[txId(tx) || id],
      isInflow: txIsReceived(tx),
      id,
    })
  }
  return events
}

/** Network fees paid in-period, including self-sends (not shown as Out). */
export function sendFeesInPeriod(
  transactions: WalletTxDTO[],
  since: Date | null,
  chain: CoinChain,
): number {
  return walletTransactionsInPeriod(transactions, since, chain).reduce((sum, tx) => {
    if (txIsReceived(tx)) return sum
    return sum + txFeeCoin(tx)
  }, 0)
}

export function balanceSeries(
  events: AssetFlowEvent[],
  currentBalance: number,
  allTransactions: WalletTxDTO[] = [],
  periodStart: Date | null = null,
  walletAddresses: ReadonlySet<string> = new Set(),
  chain: CoinChain = 'kaspa',
): AssetBalanceSeries {
  const closing = Math.max(0, currentBalance)

  // Self-send fees are not on chart events but still leave the wallet.
  const internalFees: Array<{ time: number; fee: number }> = []
  for (const tx of allTransactions) {
    const date = eventDate(tx)
    if (!date || (periodStart && !isInPeriod(date, periodStart))) continue
    if (txIsReceived(tx)) continue
    if (!txIsInternalTransfer(tx, walletAddresses, chain)) continue
    const fee = txFeeCoin(tx)
    if (fee > 0) internalFees.push({ time: date.getTime(), fee })
  }
  internalFees.sort((a, b) => a.time - b.time)

  const externalNet = events.reduce((partial, event) => {
    const flow = event.isInflow ? event.coinAmount : -event.coinAmount
    const fee = event.isInflow ? 0 : txFeeCoin(event.tx)
    return partial + flow - fee
  }, 0)
  const internalFeeTotal = internalFees.reduce((s, row) => s + row.fee, 0)
  const periodNet = externalNet - internalFeeTotal
  const opening = periodStart === null ? 0 : Math.max(0, closing - periodNet)

  let running = opening
  let feeIdx = 0
  const steps: AssetBalanceStep[] = []
  for (const event of events) {
    const t = event.date.getTime()
    while (feeIdx < internalFees.length && internalFees[feeIdx]!.time <= t) {
      running = Math.max(0, running - internalFees[feeIdx]!.fee)
      feeIdx += 1
    }
    const fee = event.isInflow ? 0 : txFeeCoin(event.tx)
    running = Math.max(0, running + (event.isInflow ? event.coinAmount : -event.coinAmount) - fee)
    steps.push({ eventIndex: event.index, balance: running })
  }
  while (feeIdx < internalFees.length) {
    running = Math.max(0, running - internalFees[feeIdx]!.fee)
    feeIdx += 1
  }
  if (steps.length > 0) {
    steps[steps.length - 1] = {
      eventIndex: steps[steps.length - 1]!.eventIndex,
      balance: running,
    }
  }

  if (steps.length > 0 && Math.abs(steps[steps.length - 1]!.balance - closing) > 1e-10) {
    steps[steps.length - 1] = {
      eventIndex: steps[steps.length - 1]!.eventIndex,
      balance: closing,
    }
  }

  return { openingBalance: opening, steps, closingBalance: closing }
}

/** Full-precision flow amount for In / Out / Net headers (8 dp for BTC/KAS). */
export function formatFlowAmount(value: number, useSats = false): string {
  const abs = Math.abs(value)
  if (useSats) return Math.round(abs).toLocaleString('en-US')
  return formatBalanceDisplay(abs, false)
}

export function formatBalanceAxis(value: number, useSats = false): string {
  return formatBalanceDisplay(value, useSats)
}

export function formatBalanceDisplay(value: number, useSats = false): string {
  if (useSats) {
    return Math.max(0, Math.round(value)).toLocaleString('en-US')
  }
  let text = value.toFixed(8)
  if (text.includes('.')) {
    while (text.endsWith('0')) text = text.slice(0, -1)
    if (text.endsWith('.')) text = text.slice(0, -1)
  }
  return text
}

export function floorBalanceLabel(value: number, useSats = false): number {
  if (useSats) {
    if (value <= 0) return 0
    return Math.floor(value)
  }
  if (value <= 0) return 0
  if (value >= 1) return Math.floor(value)
  if (value >= 0.01) return Math.floor(value * 100) / 100
  return Math.floor(value * 1_000_000) / 1_000_000
}

export function ceilBalanceLabel(value: number, useSats = false): number {
  if (useSats) {
    if (value <= 0) return 0
    return Math.ceil(value)
  }
  if (value <= 0) return 0
  if (value >= 1) return Math.ceil(value)
  if (value >= 0.01) return Math.ceil(value * 100) / 100
  return Math.ceil(value * 1_000_000) / 1_000_000
}

export function formatCompactCoin(value: number): string {
  if (value >= 100) return value.toFixed(2)
  if (value >= 1) return value.toFixed(4)
  return value.toFixed(6)
}

export function formatAxisDate(date: Date, period: AssetHistoryPeriod): string {
  const opts: Intl.DateTimeFormatOptions =
    period === 'All'
      ? { month: 'short', year: '2-digit' }
      : period === '3M' || period === '1Y'
        ? { month: 'short', day: 'numeric' }
        : { day: 'numeric', month: 'short' }
  return date.toLocaleDateString(undefined, opts)
}

/** Per-transaction bar label — always includes day so All-time txs stay distinguishable. */
export function formatBarAxisDate(date: Date, period: AssetHistoryPeriod): string {
  if (period === 'All' || period === '1Y') {
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' })
  }
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function formatHoverDate(date: Date): string {
  return date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

export function formatHoverTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { timeStyle: 'short' })
}

export function formatExactDate(date: Date): string {
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Convert chart coin amount to BTC/KAS units for fiat pricing (sats → BTC). */
export function coinUnitsForFiat(amount: number, useSats: boolean): number {
  return useSats ? amount / 100_000_000 : amount
}
