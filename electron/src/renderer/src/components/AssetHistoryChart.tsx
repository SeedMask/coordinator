import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '@renderer/state/AppProvider'
import type { WalletTxDTO } from '@renderer/api/types'
import { coinUnit, walletCoin } from '@renderer/api/types'
import { fiatPriceService } from '@renderer/services/fiatPriceService'
import { formatFiat } from '@renderer/utils/fiatFormat'
import {
  ASSET_HISTORY_PERIODS,
  type AssetFlowEvent,
  type AssetHistoryPeriod,
  eventDate,
  flowEvents,
  formatBarAxisDate,
  formatBalanceDisplay,
  formatExactDate,
  formatFlowAmount,
  formatHoverDate,
  formatHoverTime,
  coinUnitsForFiat,
  walletTransactionsInPeriod,
  periodStartDate,
  periodSummaryTitle,
} from '@renderer/utils/assetHistory'
import {
  makeAssetFlowChartLayout,
  nearestBalanceKnotIndex,
  type ChartHoverFocus,
} from '@renderer/utils/chartLayout'
import { txAmount, txBlockTime, txId } from '@renderer/utils/txHelpers'

const CHART_HEIGHT = 340

/** Chart-relevant fields only — ignore confirmation paint churn. */
function structuralChartTxs(transactions: WalletTxDTO[]): WalletTxDTO[] {
  return transactions.map((tx) => ({
    id: tx.id,
    transaction_id: tx.transaction_id ?? tx.txid,
    txid: tx.txid,
    direction: tx.direction,
    amount_btc: tx.amount_btc,
    amount_sats: tx.amount_sats,
    amount_kas: tx.amount_kas,
    amount_sompi: tx.amount_sompi,
    block_time: tx.block_time,
    counterparty: tx.counterparty ?? undefined,
  }))
}

function structuralChartSig(transactions: WalletTxDTO[]): string {
  return transactions
    .map((tx) => {
      const id = txId(tx)
      return [
        id,
        (tx.direction ?? '').trim().toLowerCase(),
        String(txAmount(tx)),
        String(txBlockTime(tx)),
        (tx.counterparty ?? '').trim(),
      ].join(':')
    })
    .join('|')
}

export function AssetHistoryChart(): React.JSX.Element {
  const {
    transactions,
    balanceKasValue,
    balanceSompi,
    selectedChain,
    bitcoinDisplayUnit,
    displayCurrency,
    activeWalletId,
    activeWallet,
    addressBook,
    utxos,
  } = useApp()
  const chartChain = activeWallet ? walletCoin(activeWallet) : selectedChain

  const chartTxSig = useMemo(() => structuralChartSig(transactions), [transactions])
  const chartTxsRef = useRef<WalletTxDTO[]>(structuralChartTxs(transactions))
  const chartTxSigRef = useRef(chartTxSig)
  if (chartTxSigRef.current !== chartTxSig) {
    chartTxSigRef.current = chartTxSig
    chartTxsRef.current = structuralChartTxs(transactions)
  }
  const chartTransactions = chartTxsRef.current

  const stickyAddressesRef = useRef<{ walletId: string | undefined; addrs: Set<string> }>({
    walletId: undefined,
    addrs: new Set(),
  })
  const chartWalletId = activeWalletId ?? undefined
  if (stickyAddressesRef.current.walletId !== chartWalletId) {
    stickyAddressesRef.current = { walletId: chartWalletId, addrs: new Set() }
  }
  const stickyAddresses = stickyAddressesRef.current.addrs
  for (const row of addressBook?.receive ?? []) {
    if (row.address) stickyAddresses.add(row.address)
  }
  for (const row of addressBook?.change ?? []) {
    if (row.address) stickyAddresses.add(row.address)
  }
  for (const u of utxos) {
    if (u.address) stickyAddresses.add(u.address)
  }
  // Stable reference for memo deps: size grows monotonically per wallet.
  const walletAddressCount = stickyAddresses.size
  const walletAddresses = useMemo(() => new Set(stickyAddresses), [chartWalletId, walletAddressCount])

  const [period, setPeriod] = useState<AssetHistoryPeriod>('All')
  const [fiatByTxId, setFiatByTxId] = useState<Record<string, number>>({})
  const [fiatSamples, setFiatSamples] = useState<Array<{ date: Date; price: number }>>([])
  const [hoverFocus, setHoverFocus] = useState<ChartHoverFocus>(null)

  const periodStart = useMemo(() => periodStartDate(period), [period])
  const livePeriodTxs = useMemo(
    () => walletTransactionsInPeriod(chartTransactions, periodStart, chartChain),
    [chartTransactions, chartTxSig, periodStart, chartChain],
  )
  const liveEvents = useMemo(
    () => flowEvents(chartTransactions, periodStart, fiatByTxId, walletAddresses, chartChain),
    [chartTransactions, chartTxSig, periodStart, fiatByTxId, walletAddresses, chartChain],
  )

  const heldChartRef = useRef<{
    walletId: string | undefined
    period: AssetHistoryPeriod
    periodTxs: WalletTxDTO[]
    events: AssetFlowEvent[]
  }>({ walletId: undefined, period: 'All', periodTxs: [], events: [] })

  if (
    heldChartRef.current.walletId !== chartWalletId ||
    heldChartRef.current.period !== period
  ) {
    heldChartRef.current = {
      walletId: chartWalletId,
      period,
      periodTxs: livePeriodTxs,
      events: liveEvents,
    }
  } else if (livePeriodTxs.length > 0 || liveEvents.length > 0) {
    heldChartRef.current.periodTxs = livePeriodTxs
    heldChartRef.current.events = liveEvents
  } else if (chartTransactions.length === 0) {
    // Confirmed empty wallet — do not keep a previous wallet's chart.
    heldChartRef.current.periodTxs = []
    heldChartRef.current.events = []
  }

  const useHeld =
    livePeriodTxs.length === 0 &&
    liveEvents.length === 0 &&
    heldChartRef.current.periodTxs.length > 0
  const periodTxs = useHeld ? heldChartRef.current.periodTxs : livePeriodTxs
  const events = useHeld ? heldChartRef.current.events : liveEvents

  const fiatTaskKey = useMemo(() => {
    return `${chartWalletId ?? ''}-${chartChain}-${displayCurrency}-${period}-${chartTxSig}`
  }, [chartWalletId, chartChain, displayCurrency, period, chartTxSig])

  const useSats = chartChain === 'bitcoin' && bitcoinDisplayUnit === 'sats'
  const unit = useSats ? 'sats' : coinUnit(chartChain)
  const chartBalance = useSats ? balanceSompi : balanceKasValue

  const displayEvents = useMemo(() => {
    if (!useSats) return events
    return events.map((event) => ({ ...event, coinAmount: event.coinAmount * 100_000_000 }))
  }, [events, useSats])

  const flowAmount = (event: AssetFlowEvent): number =>
    useSats ? event.coinAmount * 100_000_000 : event.coinAmount

  const totalInflow = events
    .filter((e) => e.isInflow)
    .reduce((s, e) => s + flowAmount(e), 0)
  const totalOutflow = events
    .filter((e) => !e.isInflow)
    .reduce((s, e) => s + flowAmount(e), 0)
  const netFlow = totalInflow - totalOutflow

  const netFlowText =
    Math.abs(netFlow) < (useSats ? 0.5 : 1e-8)
      ? `±0 ${unit}`
      : `${netFlow > 0 ? '+' : '−'}${formatFlowAmount(netFlow, useSats)} ${unit}`

  useEffect(() => {
    setHoverFocus(null)
  }, [period])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const since = periodStartDate(period)
      const filtered = walletTransactionsInPeriod(chartTransactions, since, chartChain).filter((tx) => {
        const date = eventDate(tx)
        return date != null
      })
      if (!filtered.length) {
        if (!cancelled) {
          setFiatByTxId({})
          setFiatSamples([])
        }
        return
      }
      const dated = filtered
        .map((tx) => ({ tx, date: eventDate(tx) }))
        .filter((row): row is { tx: typeof filtered[number]; date: Date } => row.date != null)
      if (!dated.length) {
        if (!cancelled) {
          setFiatByTxId({})
          setFiatSamples([])
        }
        return
      }
      const from = new Date(Math.min(...dated.map(({ date }) => date.getTime())) - 86400000)
      const to = new Date(Math.max(...dated.map(({ date }) => date.getTime())) + 86400000)
      const samples = await fiatPriceService.historicalUnitPrices(chartChain, displayCurrency, from, to)
      if (cancelled) return
      setFiatSamples(samples)
      const spot = fiatPriceService.price(chartChain, displayCurrency)
      const map: Record<string, number> = {}
      for (const { tx, date } of dated) {
        const id = txId(tx)
        const unitPrice = fiatPriceService.nearestPrice(samples, date) ?? spot
        if (unitPrice != null) {
          map[id] = txAmount(tx) * unitPrice
        }
      }
      if (!cancelled) setFiatByTxId(map)
    })()
    return () => {
      cancelled = true
    }
  }, [fiatTaskKey, period, chartTransactions, chartChain, displayCurrency])

  return (
    <div className="card asset-history-card">
      <div className="asset-history-header">
        <div className="asset-history-header-start">
          <h3 className="section-title" style={{ margin: 0 }}>
            Asset history
          </h3>

          {periodTxs.length > 0 && (
            <div className="asset-history-period-info">
              <span className="muted">{periodSummaryTitle(period)}</span>
              <strong>
                {periodTxs.length === 1 ? '1 Transaction' : `${periodTxs.length} Transactions`}
              </strong>
            </div>
          )}
        </div>

        {events.length > 0 && (
          <div className="asset-history-metrics">
            <Metric title="In" value={`+${formatFlowAmount(totalInflow, useSats)} ${unit}`} tint="inflow" />
            <div className="asset-history-metric-divider" />
            <Metric
              title="Out"
              value={`−${formatFlowAmount(totalOutflow, useSats)} ${unit}`}
              tint="outflow"
              tooltip="Transactions sent to yourself are not included in Out."
            />
            <div className="asset-history-metric-divider" />
            <Metric
              title="Net"
              value={netFlowText}
              tint={Math.abs(netFlow) < 1e-9 ? 'neutral' : netFlow > 0 ? 'inflow' : 'outflow'}
            />
          </div>
        )}

        <div className="asset-history-period-toggle">
          {ASSET_HISTORY_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              className={period === p ? 'active' : ''}
              onClick={() => setPeriod(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {periodTxs.length === 0 ? (
        <div className="asset-history-empty">
          <div className="asset-history-empty-icon">⇅</div>
          <strong>No transactions in this period</strong>
          <span className="muted">Change the period or wait for wallet activity.</span>
        </div>
      ) : events.length === 0 ? (
        <div className="asset-history-empty">
          <div className="asset-history-empty-icon">⇅</div>
          <strong>No external flows in this period</strong>
          <span className="muted">
            {periodTxs.length} on-chain transaction{periodTxs.length === 1 ? '' : 's'} — self-transfers are not shown on the chart.
          </span>
        </div>
      ) : (
        <div className="asset-history-chart-wrap">
          <div className="asset-history-legend">
            <LegendLine label="Balance" />
            <LegendSwatch label="In" tint="inflow" />
            <LegendSwatch label="Out" tint="outflow" />
          </div>
          <ChartPlot
            events={displayEvents}
            period={period}
            unit={unit}
            chartChain={chartChain}
            currentBalance={chartBalance}
            useSats={useSats}
            fiatSamples={fiatSamples}
            hoverFocus={hoverFocus}
            setHoverFocus={setHoverFocus}
            allTransactions={chartTransactions}
            periodStart={periodStart}
          />
        </div>
      )}
    </div>
  )
}

function Metric({
  title,
  value,
  tint,
  tooltip,
}: {
  title: string
  value: string
  tint: 'inflow' | 'outflow' | 'neutral'
  tooltip?: string
}): React.JSX.Element {
  return (
    <div className={`asset-history-metric${tooltip ? ' has-tooltip' : ''}`}>
      <span className="muted">{title}</span>
      <span className={`asset-history-metric-value ${tint}`}>{value}</span>
      {tooltip && <span className="asset-history-metric-hint">{tooltip}</span>}
    </div>
  )
}

function LegendLine({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="legend-item">
      <span className="legend-line" />
      {label}
    </span>
  )
}

function LegendSwatch({ label, tint }: { label: string; tint: 'inflow' | 'outflow' }): React.JSX.Element {
  return (
    <span className="legend-item">
      <span className={`legend-swatch ${tint}`} />
      {label}
    </span>
  )
}

function ChartPlot({
  events,
  period,
  unit,
  chartChain,
  currentBalance,
  useSats,
  fiatSamples,
  hoverFocus,
  setHoverFocus,
  allTransactions,
  periodStart,
}: {
  events: AssetFlowEvent[]
  period: AssetHistoryPeriod
  unit: string
  chartChain: import('@renderer/api/types').CoinChain
  currentBalance: number
  useSats: boolean
  fiatSamples: Array<{ date: Date; price: number }>
  hoverFocus: ChartHoverFocus
  setHoverFocus: (f: ChartHoverFocus) => void
  allTransactions: import('@renderer/api/types').WalletTxDTO[]
  periodStart: Date | null
}): React.JSX.Element {
  const { displayCurrency, sidebarSelection } = useApp()
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 800, height: CHART_HEIGHT })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setSize({ width: Math.max(entry.contentRect.width, 320), height: CHART_HEIGHT })
    })
    ro.observe(el)
    setSize({ width: Math.max(el.clientWidth, 320), height: CHART_HEIGHT })
    return () => ro.disconnect()
  }, [sidebarSelection, events.length])

  const layout = useMemo(
    () => makeAssetFlowChartLayout(size, events, currentBalance, useSats, allTransactions, periodStart, period),
    [size, events, currentBalance, useSats, allTransactions, periodStart, period],
  )

  const pointsToPath = (pts: Array<{ x: number; y: number }>) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')

  const balanceHover = hoverFocus?.kind === 'balance' ? hoverFocus.sample : null
  const txHover = hoverFocus?.kind === 'transaction' ? hoverFocus.bar : null

  return (
    <div
      ref={containerRef}
      className="asset-chart-plot"
      style={{ height: CHART_HEIGHT }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        setHoverFocus(layout.resolveHover({ x: e.clientX - rect.left, y: e.clientY - rect.top }))
      }}
      onMouseLeave={() => setHoverFocus(null)}
    >
      <svg width={size.width} height={size.height} role="img" aria-label="Asset history chart">
        <rect
          x={layout.plotRect.x - 3}
          y={layout.plotRect.y - 3}
          width={layout.plotRect.width + 6}
          height={layout.plotRect.height + 6}
          rx={14}
          className="chart-plot-bg"
        />

        <text
          x={Math.max(12, layout.yAxisWidth - 8)}
          y={Math.max(14, layout.balanceRect.y - 10)}
          textAnchor="start"
          className="chart-axis-unit"
        >
          {unit}
        </text>

        {layout.balanceTickAmounts.map((amount) => {
          const y = layout.balanceY(amount)
          return (
            <g key={amount}>
              <line
                x1={layout.balanceRect.x}
                x2={layout.balanceRect.x + layout.balanceRect.width}
                y1={y}
                y2={y}
                className="chart-grid-line"
              />
              <text
                x={layout.yAxisWidth - 6}
                y={y + 4}
                textAnchor="end"
                className="chart-axis-label"
              >
                {formatBalanceDisplay(amount, useSats)}
              </text>
            </g>
          )
        })}

        {layout.balanceFillPoints.length > 1 && (
          <path d={pointsToPath(layout.balanceFillPoints)} className="chart-balance-fill" />
        )}

        <line
          x1={layout.activityRect.x}
          x2={layout.activityRect.x + layout.activityRect.width}
          y1={layout.activityRect.y - layout.activityRect.height * 0.08}
          y2={layout.activityRect.y - layout.activityRect.height * 0.08}
          className="chart-activity-divider"
        />

        {layout.balanceLinePoints.length > 1 && (
          <path
            d={pointsToPath(layout.balanceLinePoints)}
            className={`chart-balance-line${balanceHover ? ' active' : ''}`}
            fill="none"
          />
        )}

        {!hoverFocus && layout.balanceLinePoints.length > 0 && (
          <circle
            cx={layout.balanceLinePoints[layout.balanceLinePoints.length - 1].x}
            cy={layout.balanceLinePoints[layout.balanceLinePoints.length - 1].y}
            r={3}
            className="chart-balance-marker"
          />
        )}

        {layout.bars.map((bar) => {
          const active = txHover?.id === bar.id
          const anyTxHover = txHover != null
          const balanceActive = balanceHover != null
          const tint = bar.event.isInflow ? 'inflow' : 'outflow'
          const h = Math.max(bar.rect.height, active ? 12 : 10)
          return (
            <rect
              key={bar.id}
              x={bar.rect.x}
              y={bar.rect.y + bar.rect.height - h}
              width={bar.rect.width}
              height={h}
              rx={4}
              className={`chart-bar ${tint}${active ? ' active' : ''}`}
              opacity={anyTxHover ? (active ? 1 : 0.22) : balanceActive ? 0.45 : 0.62}
            />
          )
        })}

        {layout.xLabelIndices.map((index) => {
          if (index >= events.length) return null
          const bar = layout.bars[index]
          const highlighted =
            txHover?.event.index === index ||
            nearestBalanceKnotIndex(balanceHover?.x, layout) === index
          return (
            <text
              key={index}
              x={bar.centerX}
              y={size.height - 10}
              textAnchor="middle"
              className={`chart-x-label${highlighted ? ' active' : ''}`}
            >
              {formatBarAxisDate(events[index].date, period)}
            </text>
          )
        })}

        {balanceHover && (
          <>
            <line
              x1={balanceHover.x}
              x2={balanceHover.x}
              y1={layout.balanceRect.y}
              y2={layout.balanceRect.y + layout.balanceRect.height}
              className="chart-hover-vline"
            />
            <circle
              cx={balanceHover.x}
              cy={balanceHover.lineY}
              r={4}
              className="chart-hover-dot"
            />
          </>
        )}

        {txHover && (
          <line
            x1={txHover.centerX}
            x2={txHover.centerX}
            y1={layout.balanceRect.y}
            y2={layout.balanceRect.y + layout.balanceRect.height}
            className={`chart-tx-vline ${txHover.event.isInflow ? 'inflow' : 'outflow'}`}
          />
        )}
      </svg>

      {balanceHover && (() => {
        const tipW = 220
        // Always above the balance line (same card size/style). Revert to
        // space-based above/below if this covers the peak too often.
        return (
          <ChartTooltip
            x={Math.min(Math.max(balanceHover.x, tipW / 2 + 8), size.width - tipW / 2 - 8)}
            y={balanceHover.lineY}
            width={tipW}
            placement="above"
          >
            <strong>
              {formatBalanceDisplay(balanceHover.balance, useSats)} {unit}
            </strong>
            {(() => {
              const unitPrice =
                fiatPriceService.nearestPrice(fiatSamples, balanceHover.date) ??
                fiatPriceService.price(chartChain, displayCurrency)
              if (unitPrice == null) return null
              return (
                <span className="chart-tooltip-fiat">
                  {formatFiat(coinUnitsForFiat(balanceHover.balance, useSats) * unitPrice, displayCurrency)}
                </span>
              )
            })()}
            <span className="muted chart-tooltip-meta">
              {formatHoverDate(balanceHover.date)} · {formatHoverTime(balanceHover.date)}
            </span>
          </ChartTooltip>
        )
      })()}

      {txHover && (
        <ChartTooltip
          x={Math.min(Math.max(txHover.centerX, 130), size.width - 130)}
          y={txHover.rect.y}
          width={236}
          placement={
            txHover.rect.y - layout.balanceRect.y > 96 ? 'above' : 'below'
          }
          tint={txHover.event.isInflow ? 'inflow' : 'outflow'}
        >
          <div className="row spread chart-tooltip-head">
            <span className={`chart-tooltip-kind ${txHover.event.isInflow ? 'inflow' : 'outflow'}`}>
              {txHover.event.isInflow ? 'Received' : 'Sent'}
            </span>
            <span className="muted">{formatExactDate(txHover.event.date)}</span>
          </div>
          <strong>
            {txHover.event.isInflow ? '+' : '−'}
            {formatBalanceDisplay(txHover.event.coinAmount, useSats)} {unit}
          </strong>
          {txHover.event.fiatAmount != null && (
            <span className="muted">{formatFiat(txHover.event.fiatAmount, displayCurrency)}</span>
          )}
        </ChartTooltip>
      )}
    </div>
  )
}

function ChartTooltip({
  x,
  y,
  width,
  placement = 'above',
  tint,
  children,
}: {
  x: number
  y: number
  width: number
  /** Anchor so the card sits clear of the hover point / balance line. */
  placement?: 'above' | 'below'
  tint?: 'inflow' | 'outflow'
  children: React.ReactNode
}): React.JSX.Element {
  const transform =
    placement === 'below' ? 'translate(-50%, 10px)' : 'translate(-50%, calc(-100% - 10px))'
  return (
    <div
      className={`chart-tooltip${tint ? ` ${tint}` : ''}`}
      style={{ left: x, top: y, width, transform }}
    >
      {children}
    </div>
  )
}
