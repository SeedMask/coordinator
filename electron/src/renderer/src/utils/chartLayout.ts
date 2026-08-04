import type { AssetBalanceSeries, AssetFlowEvent, AssetHistoryPeriod } from '@renderer/utils/assetHistory'
import {
  balanceSeries,
  ceilBalanceLabel,
  floorBalanceLabel,
  formatBalanceAxis,
} from '@renderer/utils/assetHistory'

export interface Point {
  x: number
  y: number
}

export interface AssetFlowBarFrame {
  event: AssetFlowEvent
  rect: { x: number; y: number; width: number; height: number }
  centerX: number
  anchorY: number
  id: string
}

export interface BalanceTimelineKnot {
  x: number
  balance: number
  date: Date
}

export interface BalanceHoverSample {
  x: number
  balance: number
  date: Date
  isCurrent: boolean
  lineY: number
}

export type ChartHoverFocus =
  | { kind: 'balance'; sample: BalanceHoverSample }
  | { kind: 'transaction'; bar: AssetFlowBarFrame }
  | null

export interface AssetFlowChartLayout {
  plotRect: { x: number; y: number; width: number; height: number }
  balanceRect: { x: number; y: number; width: number; height: number }
  activityRect: { x: number; y: number; width: number; height: number }
  bars: AssetFlowBarFrame[]
  xLabelIndices: number[]
  balanceSeries: AssetBalanceSeries
  balanceMin: number
  balanceMax: number
  balanceTickAmounts: number[]
  balanceLinePoints: Point[]
  balanceFillPoints: Point[]
  balanceKnots: BalanceTimelineKnot[]
  slotWidth: number
  yAxisWidth: number
  barContaining: (point: Point) => AssetFlowBarFrame | undefined
  snappedX: (x: number) => number
  balanceSample: (x: number, snap?: boolean) => BalanceHoverSample | null
  resolveHover: (point: Point) => ChartHoverFocus
  balanceY: (balance: number) => number
  balanceLineY: (x: number) => number
}

function yForBalance(
  balance: number,
  balanceRect: { y: number; height: number },
  balanceMin: number,
  balanceMax: number,
): number {
  const span = Math.max(balanceMax - balanceMin, 0.0000001)
  const ratio = (balance - balanceMin) / span
  return balanceRect.y + balanceRect.height - ratio * balanceRect.height
}

function balanceScale(series: AssetBalanceSeries, useSats = false): { min: number; max: number; ticks: number[] } {
  const allValues = [series.openingBalance, ...series.steps.map((s) => s.balance), series.closingBalance]
  const rawMin = Math.max(0, Math.min(...allValues))
  const rawMax = Math.max(...allValues)
  const labelMin = floorBalanceLabel(Math.max(0, rawMin), useSats)
  const labelMax = ceilBalanceLabel(rawMax, useSats)
  const dataMid = (rawMax + rawMin) / 2
  const minSpan = useSats ? 1 : 0.0000001
  const dataSpan = Math.max(rawMax - rawMin, minSpan)
  const magnitude = Math.max(Math.abs(rawMax), Math.abs(rawMin), minSpan)
  const visualSpan = Math.max(dataSpan * 2.35, magnitude * 0.55, dataSpan + magnitude * 0.18)
  let domainMin = dataMid - visualSpan / 2
  let domainMax = dataMid + visualSpan / 2
  domainMin = Math.max(0, Math.min(domainMin, labelMin))
  domainMax = Math.max(domainMax, labelMax)
  const labelSpan = Math.max(labelMax - labelMin, minSpan)
  const gridLineCount =
    useSats && labelSpan <= 1 ? 2 : useSats && labelSpan < 5000 ? 3 : 5
  const ticks = Array.from({ length: gridLineCount }, (_, index) => {
    const t = index / Math.max(gridLineCount - 1, 1)
    return labelMin + labelSpan * t
  })
  return { min: domainMin, max: domainMax, ticks }
}

function yAxisWidth(tickAmounts: number[], useSats = false): number {
  const labels = tickAmounts.map((amount) => formatBalanceAxis(amount, useSats))
  const maxChars = Math.max(...labels.map((l) => l.length), 4)
  return Math.max(useSats ? 72 : 56, maxChars * 7.2 + 16)
}

function filterBalanceTicks(
  ticks: number[],
  balanceY: (balance: number) => number,
  minGapPx: number,
): number[] {
  if (ticks.length <= 1) return ticks
  const out: number[] = []
  let lastY = Number.NaN
  for (const amount of ticks) {
    const y = balanceY(amount)
    if (out.length === 0 || Number.isNaN(lastY) || Math.abs(y - lastY) >= minGapPx) {
      out.push(amount)
      lastY = y
    }
  }
  const last = ticks[ticks.length - 1]
  if (last != null && out[out.length - 1] !== last) {
    const y = balanceY(last)
    if (out.length === 0 || Math.abs(y - (lastY ?? y)) >= minGapPx * 0.65) out.push(last)
  }
  return out
}

function buildBalanceLinePoints(
  plotRect: { x: number; width: number },
  balanceRect: { y: number; height: number },
  bars: AssetFlowBarFrame[],
  series: AssetBalanceSeries,
  balanceMin: number,
  balanceMax: number,
): Point[] {
  const y = (balance: number) => yForBalance(balance, balanceRect, balanceMin, balanceMax)
  const endX = plotRect.x + plotRect.width
  if (!bars.length) {
    const lineY = y(series.closingBalance)
    return [
      { x: plotRect.x, y: lineY },
      { x: endX, y: lineY },
    ]
  }
  const points: Point[] = [{ x: plotRect.x, y: y(series.openingBalance) }]
  for (let i = 0; i < bars.length; i++) {
    const step = series.steps[i]
    if (!step) continue
    points.push({ x: bars[i]!.centerX, y: y(step.balance) })
  }
  points.push({ x: endX, y: y(series.closingBalance) })
  return points
}

interface BalanceStepSegment {
  xStart: number
  xEnd: number
  balance: number
  dateStart: Date
  dateEnd: Date
}

function buildBalanceSegments(
  plotRect: { x: number; width: number },
  bars: AssetFlowBarFrame[],
  series: AssetBalanceSeries,
  events: AssetFlowEvent[],
  openingDate: Date,
): BalanceStepSegment[] {
  const endX = plotRect.x + plotRect.width
  const closingDate = events[events.length - 1]?.date ?? openingDate
  if (!bars.length) {
    return [
      {
        xStart: plotRect.x,
        xEnd: endX,
        balance: series.closingBalance,
        dateStart: openingDate,
        dateEnd: closingDate,
      },
    ]
  }
  const segments: BalanceStepSegment[] = [
    {
      xStart: plotRect.x,
      xEnd: bars[0]!.centerX,
      balance: series.openingBalance,
      dateStart: openingDate,
      dateEnd: events[0]!.date,
    },
  ]
  for (let i = 0; i < bars.length; i++) {
    const step = series.steps[i]
    if (!step) continue
    const xStart = bars[i]!.centerX
    const xEnd = i + 1 < bars.length ? bars[i + 1]!.centerX : endX
    const dateStart = events[i]!.date
    const dateEnd = i + 1 < events.length ? events[i + 1]!.date : closingDate
    segments.push({
      xStart,
      xEnd,
      balance: step.balance,
      dateStart,
      dateEnd,
    })
  }
  return segments
}

function buildBalanceKnots(
  plotRect: { x: number; width: number },
  bars: AssetFlowBarFrame[],
  series: AssetBalanceSeries,
  events: AssetFlowEvent[],
  openingDate: Date,
): BalanceTimelineKnot[] {
  const endX = plotRect.x + plotRect.width
  const closingDate = events[events.length - 1]?.date ?? openingDate
  const knots: BalanceTimelineKnot[] = [
    { x: plotRect.x, balance: series.openingBalance, date: openingDate },
  ]
  for (let i = 0; i < bars.length; i++) {
    const step = series.steps[i]
    const event = events[i]
    if (!step || !event) continue
    knots.push({ x: bars[i]!.centerX, balance: step.balance, date: event.date })
  }
  knots.push({ x: endX, balance: series.closingBalance, date: closingDate })
  return knots
}

function yOnPolylineAtX(x: number, points: Point[]): number {
  if (points.length === 0) return 0
  if (x <= points[0]!.x) return points[0]!.y
  const last = points[points.length - 1]!
  if (x >= last.x) return last.y
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    if (x >= a.x && x <= b.x) {
      const span = b.x - a.x
      const t = span <= 0 ? 0 : (x - a.x) / span
      return a.y + t * (b.y - a.y)
    }
  }
  return last.y
}

function sampleStepBalanceAtX(
  x: number,
  segments: BalanceStepSegment[],
  plotRight: number,
  balanceLinePoints: Point[],
): BalanceHoverSample | null {
  if (!segments.length) return null
  const clampedX = Math.max(segments[0]!.xStart, Math.min(plotRight, x))
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!
    if (clampedX + 0.001 < seg.xStart) continue
    if (clampedX > seg.xEnd + 0.001 && i < segments.length - 1) continue
    return {
      x: clampedX,
      balance: seg.balance,
      // Balance is flat between verticals — anchor tooltip to the tx that set this level.
      date: seg.dateStart,
      isCurrent: Math.abs(clampedX - plotRight) < 1.5,
      lineY: yOnPolylineAtX(clampedX, balanceLinePoints),
    }
  }
  const first = segments[0]!
  return {
    x: clampedX,
    balance: first.balance,
    date: first.dateStart,
    isCurrent: false,
    lineY: yOnPolylineAtX(clampedX, balanceLinePoints),
  }
}

function buildBalanceFillPoints(linePoints: Point[], floorY: number): Point[] {
  if (!linePoints.length) return []
  const first = linePoints[0]
  const last = linePoints[linePoints.length - 1]
  return [...linePoints, { x: last.x, y: floorY }, { x: first.x, y: floorY }]
}

export function makeAssetFlowChartLayout(
  size: { width: number; height: number },
  events: AssetFlowEvent[],
  currentBalance: number,
  useSats = false,
  allTransactions: import('@renderer/api/types').WalletTxDTO[] = [],
  periodStart: Date | null = null,
  period: AssetHistoryPeriod = '1M',
): AssetFlowChartLayout {
  const series = balanceSeries(events, currentBalance, allTransactions, periodStart)
  const { min: balanceMin, max: balanceMax, ticks: rawBalanceTicks } = balanceScale(series, useSats)
  const provisionalAxisW = yAxisWidth(rawBalanceTicks, useSats)
  const leading = provisionalAxisW + 12
  const trailing = 12
  const top = 16
  const bottom = 26
  const plotRect = {
    x: leading,
    y: top,
    width: Math.max(size.width - leading - trailing, 1),
    height: Math.max(size.height - top - bottom, 1),
  }
  const bandGap = 10
  const activityHeight = Math.min(Math.max(plotRect.height * 0.2, 48), plotRect.height * 0.26)
  const balanceHeight = plotRect.height - activityHeight - bandGap
  const balanceRect = { x: plotRect.x, y: plotRect.y, width: plotRect.width, height: balanceHeight }
  const activityRect = {
    x: plotRect.x,
    y: balanceRect.y + balanceRect.height + bandGap,
    width: plotRect.width,
    height: activityHeight,
  }
  const balanceY = (balance: number) => yForBalance(balance, balanceRect, balanceMin, balanceMax)
  const balanceTickAmounts = filterBalanceTicks(rawBalanceTicks, balanceY, 32)
  const axisW = yAxisWidth(balanceTickAmounts, useSats)
  const maxAmount = events.reduce((m, e) => Math.max(m, e.coinAmount), 0)
  const count = Math.max(events.length, 1)
  const slotWidth = plotRect.width / count
  const barWidth = Math.min(24, Math.max(7, slotWidth * 0.56))
  const bars: AssetFlowBarFrame[] = events.map((event) => {
    const centerX = plotRect.x + slotWidth * (event.index + 0.5)
    const ratio = maxAmount > 0 ? event.coinAmount / maxAmount : 0
    const bandSpan = activityRect.height * 0.88
    const rawHeight = ratio * bandSpan
    const height = event.coinAmount > 0 ? Math.max(rawHeight, 10) : 0
    const rect = {
      x: centerX - barWidth / 2,
      y: activityRect.y + activityRect.height - height,
      width: barWidth,
      height,
    }
    return {
      event,
      rect,
      centerX,
      anchorY: rect.y,
      id: event.id,
    }
  })
  const balanceLinePoints = buildBalanceLinePoints(plotRect, balanceRect, bars, series, balanceMin, balanceMax)
  const balanceFillPoints = buildBalanceFillPoints(balanceLinePoints, balanceRect.y + balanceRect.height)
  const openingDate = events[0]?.date ? new Date(events[0].date.getTime() - 1000) : new Date()
  const plotRight = plotRect.x + plotRect.width
  const balanceSegments = buildBalanceSegments(plotRect, bars, series, events, openingDate)
  const balanceKnots = buildBalanceKnots(plotRect, bars, series, events, openingDate)
  const labelCap = period === 'All' ? Math.min(events.length, 12) : 6
  const labelCount = Math.min(labelCap, Math.max(events.length, 1))
  let xLabelIndices: number[]
  if (!events.length) {
    xLabelIndices = []
  } else if (events.length <= labelCount) {
    xLabelIndices = events.map((_, i) => i)
  } else {
    const step = Math.max(1, Math.floor(events.length / labelCount))
    xLabelIndices = []
    for (let i = 0; i < events.length; i += step) xLabelIndices.push(i)
    if (xLabelIndices[xLabelIndices.length - 1] !== events.length - 1) {
      xLabelIndices.push(events.length - 1)
    }
  }

  const barContaining = (point: Point): AssetFlowBarFrame | undefined =>
    bars.find((bar) => {
      const r = bar.rect
      return (
        point.x >= r.x - 4 &&
        point.x <= r.x + r.width + 4 &&
        point.y >= r.y - 4 &&
        point.y <= r.y + r.height + 4
      )
    })

  const snappedX = (x: number): number => {
    if (!bars.length) return x
    let nearest = bars[0]
    let best = Math.abs(nearest.centerX - x)
    for (const bar of bars) {
      const d = Math.abs(bar.centerX - x)
      if (d < best) {
        nearest = bar
        best = d
      }
    }
    if (best <= slotWidth * 0.38) return nearest.centerX
    return x
  }

  const balanceLineY = (x: number): number => yOnPolylineAtX(x, balanceLinePoints)

  const balanceSample = (x: number, snap = true): BalanceHoverSample | null => {
    if (x < plotRect.x || x > plotRight || !balanceSegments.length) return null
    const sampleX = snap ? snappedX(x) : Math.max(plotRect.x, Math.min(plotRight, x))
    return sampleStepBalanceAtX(sampleX, balanceSegments, plotRight, balanceLinePoints)
  }

  const resolveHover = (point: Point): ChartHoverFocus => {
    const inPlot =
      point.x >= plotRect.x &&
      point.x <= plotRight &&
      point.y >= plotRect.y - 6 &&
      point.y <= plotRect.y + plotRect.height + 6
    if (!inPlot) return null

    const inBalanceBand =
      point.y >= balanceRect.y && point.y <= balanceRect.y + balanceRect.height
    const inActivityBand =
      point.y >= activityRect.y && point.y <= activityRect.y + activityRect.height

    if (inBalanceBand) {
      const sample = balanceSample(point.x, false)
      if (sample) return { kind: 'balance', sample }
      return null
    }

    if (inActivityBand) {
      const bar = barContaining(point)
      if (bar) return { kind: 'transaction', bar }
    }

    return null
  }

  return {
    plotRect,
    balanceRect,
    activityRect,
    bars,
    xLabelIndices,
    balanceSeries: series,
    balanceMin,
    balanceMax,
    balanceTickAmounts,
    balanceLinePoints,
    balanceFillPoints,
    balanceKnots,
    slotWidth,
    yAxisWidth: axisW,
    barContaining,
    snappedX,
    balanceSample,
    resolveHover,
    balanceY,
    balanceLineY,
  }
}

export function nearestBalanceKnotIndex(
  x: number | undefined,
  layout: AssetFlowChartLayout,
): number | undefined {
  if (x == null) return undefined
  const knot = [...layout.balanceKnots].reverse().find((k) => k.x <= x + 0.001)
  if (!knot) return undefined
  const bar = layout.bars.find((b) => Math.abs(b.centerX - knot.x) < 1)
  return bar?.event.index
}
