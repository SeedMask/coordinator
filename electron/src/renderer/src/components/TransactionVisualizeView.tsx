import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { APIClient } from '@renderer/api/client'
import type { BuildSummary } from '@renderer/utils/buildSummary'
import type { BitcoinDisplayUnit, CoinChain, DisplayCurrency, TxVisualizeResponse, UtxoDTO } from '@renderer/api/types'
import { coinUnit, utxoCoinAmount } from '@renderer/api/types'
import { fiatPriceService } from '@renderer/services/fiatPriceService'
import {
  applyConfirmedSummaryTense,
  blockTimeSeconds,
  coinFiatLabel,
  formatVisualAmount,
  rewriteVisualCoinText,
  visualUnit,
} from '@renderer/utils/txVisualizeFormat'
import {
  reviewChangeKas,
  reviewInputTotalKas,
  reviewTotalFeeSompi,
  shortAddressLabel,
  summaryAddressLabel,
  type BuildSummary as Summary,
} from '@renderer/utils/buildSummary'
import { copyToClipboard } from '@renderer/utils/clipboard'
import { InfoTipButton } from '@renderer/components/settings/SettingsChrome'
import { isBitcoinHighFee, isKaspaHighFee } from '@renderer/utils/feeWarnings'
import { formatDateAndClock } from '@renderer/utils/dateTimeFormat'
import { useApp } from '@renderer/state/AppProvider'

type OutputKind = 'recipient' | 'change' | 'fee'

interface VisualInput {
  id: string
  label: string
  subtitle?: string | null
  address?: string | null
  amount: number
}

interface VisualOutput {
  id: string
  kind: OutputKind
  label: string
  subtitle?: string | null
  address?: string | null
  amount: number
  isWarning: boolean
}

interface VisualModel {
  chain: CoinChain
  unitSymbol: string
  txid?: string
  txidShort?: string
  blockTime?: number
  inputs: VisualInput[]
  outputs: VisualOutput[]
  summaryLine: string
  summaryFeeLine?: string | null
  balanceLine: string
  rawHex?: string
  rawHexLabel?: string
  rawHexFormat?: string
  metadata: Array<{ label: string; value: string; detail?: string | null; isWarning?: boolean }>
  warnings: Array<{ severity: string; message: string }>
  usesDraftDetail: boolean
}

function useTxUnitPrice(
  chain: CoinChain,
  displayCurrency: DisplayCurrency,
  blockTime?: number,
): number | undefined {
  const blockSec = blockTimeSeconds(blockTime)
  const [unitPrice, setUnitPrice] = useState<number | undefined>(() =>
    blockSec ? undefined : fiatPriceService.price(chain, displayCurrency),
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (blockSec) {
        const when = new Date(blockSec * 1000)
        if (!Number.isFinite(when.getTime())) {
          await fiatPriceService.refreshIfNeeded()
          if (!cancelled) setUnitPrice(fiatPriceService.price(chain, displayCurrency))
          return
        }
        const from = new Date(when.getTime() - 7 * 86_400_000)
        const to = new Date(when.getTime() + 86_400_000)
        const samples = await fiatPriceService.historicalUnitPrices(chain, displayCurrency, from, to)
        const nearest = fiatPriceService.nearestPrice(samples, when)
        if (!cancelled) {
          if (nearest != null) setUnitPrice(nearest)
          else {
            await fiatPriceService.refreshIfNeeded()
            setUnitPrice(fiatPriceService.price(chain, displayCurrency))
          }
        }
        return
      }
      await fiatPriceService.refreshIfNeeded()
      if (!cancelled) setUnitPrice(fiatPriceService.price(chain, displayCurrency))
    })()
    return () => {
      cancelled = true
    }
  }, [blockSec, chain, displayCurrency])

  return unitPrice
}

function rowAmount(row: { amount?: number; amount_sompi?: number }): number {
  if (row.amount != null) return row.amount
  if (row.amount_sompi != null) return row.amount_sompi / 100_000_000
  return 0
}

function isHighFee(fee: number, send: number, chain: CoinChain): boolean {
  if (fee <= 0) return false
  if (chain === 'kaspa') {
    return isKaspaHighFee(Math.round(fee * 100_000_000), Math.round(send * 100_000_000))
  }
  return isBitcoinHighFee(fee, send)
}

function visualAddressSortKey(row: { label: string; subtitle?: string | null }): [number, number, string] {
  const text = `${row.label} ${row.subtitle ?? ''}`
  const match = text.match(/\b(Receive|Change)\s*#\s*(-?\d+)/i)
  if (!match) return [2, Number.MAX_SAFE_INTEGER, text]
  const type = match[1].toLowerCase() === 'change' ? 1 : 0
  return [type, Number(match[2]), text]
}

function sortVisualInputs(inputs: VisualInput[]): VisualInput[] {
  return [...inputs].sort((a, b) => {
    const ak = visualAddressSortKey(a)
    const bk = visualAddressSortKey(b)
    return ak[0] - bk[0] || ak[1] - bk[1] || ak[2].localeCompare(bk[2])
  })
}

export function modelFromApi(
  response: TxVisualizeResponse,
  chain: CoinChain,
  usesDraftDetail = true,
  bitcoinDisplayUnit: BitcoinDisplayUnit = 'btc',
): VisualModel {
  const unit = visualUnit(chain, bitcoinDisplayUnit)
  let summaryLine = response.summary_line ?? ''
  let summaryFeeLine = response.summary_fee_line ?? null
  if (!summaryFeeLine && summaryLine.includes(' · Network fee ')) {
    const [sendPart, feePart] = summaryLine.split(' · Network fee ')
    summaryLine = sendPart
    summaryFeeLine = feePart ? `Network fee ${feePart}` : null
  }
  summaryLine = rewriteVisualCoinText(summaryLine, chain, bitcoinDisplayUnit)
  if (summaryFeeLine) summaryFeeLine = rewriteVisualCoinText(summaryFeeLine, chain, bitcoinDisplayUnit)
  let balanceLine = rewriteVisualCoinText(response.balance_line ?? '', chain, bitcoinDisplayUnit)
  if (!usesDraftDetail) {
    summaryLine = applyConfirmedSummaryTense(summaryLine)
    if (summaryFeeLine) summaryFeeLine = applyConfirmedSummaryTense(summaryFeeLine)
    balanceLine = applyConfirmedSummaryTense(balanceLine)
  }
  return {
    chain,
    unitSymbol: unit,
    txid: response.txid,
    txidShort: response.txid_short,
    blockTime: blockTimeSeconds(response.block_time) ?? undefined,
    inputs: sortVisualInputs(
      (response.inputs ?? []).map((row) => ({
        id: row.id,
        label: row.label,
        subtitle: row.subtitle ?? row.address ?? null,
        address: row.address ?? row.subtitle ?? null,
        amount: rowAmount(row),
      })),
    ),
    outputs: (response.outputs ?? []).map((row) => ({
      id: row.id,
      kind: (row.kind === 'change' ? 'change' : row.kind === 'fee' ? 'fee' : 'recipient') as OutputKind,
      label: row.label,
      subtitle: row.subtitle ?? row.address ?? null,
      address: row.address ?? row.subtitle ?? null,
      amount: rowAmount(row),
      isWarning: row.is_warning ?? false,
    })),
    summaryLine,
    summaryFeeLine,
    balanceLine,
    rawHex: response.raw_hex,
    rawHexLabel: response.raw_hex_label,
    rawHexFormat: response.raw_hex_format,
    metadata: (response.metadata ?? []).map((m) => ({
      label: m.label,
      value: m.value,
      detail: m.detail,
      isWarning: m.is_warning,
    })),
    warnings: (response.warnings ?? [])
      .filter((w) => !w.message.toLowerCase().includes('mass/fee calc failed'))
      .map((w) => ({ severity: w.severity ?? 'warning', message: w.message })),
    usesDraftDetail,
  }
}

function fallbackModel(
  summary: BuildSummary,
  coins: UtxoDTO[],
  chain: CoinChain,
  recipientAddress: string,
  bitcoinDisplayUnit: BitcoinDisplayUnit,
): VisualModel {
  const unit = visualUnit(chain, bitcoinDisplayUnit)
  let inputs: VisualInput[] = sortVisualInputs(
    coins.map((u) => ({
      id: u.key,
      label: u.is_change ? `Change #${u.address_index}` : `Receive #${u.address_index}`,
      subtitle: null,
      amount: utxoCoinAmount(u),
    })),
  )
  const inputTotal = reviewInputTotalKas(summary, coins.reduce((s, u) => s + utxoCoinAmount(u), 0))
  if (inputs.length === 0 && inputTotal > 0) {
    inputs = [{ id: 'input-total', label: 'Wallet coin', subtitle: null, amount: inputTotal }]
  }

  const send = Math.max(0, summary.sendKas ?? 0)
  const fee = reviewTotalFeeSompi(summary) / 100_000_000
  const changeAmount = reviewChangeKas(summary) ?? 0
  const recipient = recipientAddress.trim()
  const feeWarning = isHighFee(fee, send, chain)

  const outputs: VisualOutput[] = [
    {
      id: 'recipient',
      kind: 'recipient',
      label: 'Recipient',
      subtitle: recipient ? shortAddressLabel(recipient, chain) : null,
      amount: send,
      isWarning: false,
    },
  ]
  if (changeAmount > 0) {
    outputs.push({
      id: 'change',
      kind: 'change',
      label: summary.changeAddressIndex != null ? `Change #${summary.changeAddressIndex}` : 'Change',
      subtitle: summary.changeAddress ? shortAddressLabel(summary.changeAddress, chain) : null,
      amount: changeAmount,
      isWarning: false,
    })
  }
  outputs.push({
    id: 'fee',
    kind: 'fee',
    label: feeWarning ? 'High fee' : 'Network fee',
    subtitle: 'Paid to miners',
    amount: fee,
    isWarning: feeWarning,
  })

  const sendText = formatVisualAmount(send, chain, bitcoinDisplayUnit)
  const feeText = formatVisualAmount(fee, chain, bitcoinDisplayUnit)
  const summaryLine = recipient
    ? `Send ${sendText} to ${summaryAddressLabel(recipient, chain)}`
    : `Send ${sendText}`
  const summaryFeeLine = `Network fee ${feeText}`

  const inTotal = inputs.reduce((s, i) => s + i.amount, 0)
  const inLabel = formatVisualAmount(inTotal, chain, bitcoinDisplayUnit)
  const sendLabel = formatVisualAmount(send, chain, bitcoinDisplayUnit)
  const feeLabel = formatVisualAmount(fee, chain, bitcoinDisplayUnit)
  const changeLabel = formatVisualAmount(changeAmount, chain, bitcoinDisplayUnit)
  const balanceLine =
    inTotal > 0
      ? `Coins in ${inLabel}  =  recipient ${sendLabel}  +  fee ${feeLabel}${changeAmount > 0 ? `  +  change ${changeLabel}` : ''}`
      : `Recipient ${sendLabel}  +  fee ${feeLabel}`

  return {
    chain,
    unitSymbol: unit,
    inputs,
    outputs,
    summaryLine,
    summaryFeeLine,
    balanceLine,
    metadata: [],
    warnings: feeWarning
      ? [{ severity: 'warning', message: 'Network fee is unusually high' }]
      : [],
    usesDraftDetail: true,
  }
}

function compactFlowSubtitle(raw: string | null | undefined, chain: CoinChain): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.length <= 22) return trimmed
  return shortAddressLabel(trimmed, chain)
}

export function FlowDiagram({
  model,
  displayCurrency,
  bitcoinDisplayUnit,
  unitPrice,
  draftMode = false,
}: {
  model: VisualModel
  displayCurrency: DisplayCurrency
  bitcoinDisplayUnit: BitcoinDisplayUnit
  unitPrice?: number
  draftMode?: boolean
}): React.JSX.Element {
  const inputDirection = draftMode ? 'Send from' : 'Sent from'
  const wrapRef = useRef<HTMLDivElement>(null)
  const hubRef = useRef<HTMLDivElement>(null)
  const [paths, setPaths] = useState<Array<{ d: string; warning?: boolean }>>([])
  const [svgSize, setSvgSize] = useState({ w: 720, h: 220 })
  const spotPrice = unitPrice ?? fiatPriceService.price(model.chain, displayCurrency)

  const remeasure = useCallback(() => {
    const wrap = wrapRef.current
    const hub = hubRef.current
    if (!wrap || !hub) return

    const wr = wrap.getBoundingClientRect()
    if (wr.width <= 0 || wr.height <= 0) return
    setSvgSize({ w: wr.width, h: wr.height })

    const hubRect = hub.getBoundingClientRect()
    const hubLeft = hubRect.left - wr.left
    const hubRight = hubRect.right - wr.left
    const hubY = hubRect.top + hubRect.height / 2 - wr.top

    const next: Array<{ d: string; warning?: boolean }> = []

    for (const input of model.inputs) {
      const el = wrap.querySelector(`[data-flow-id="${input.id}"]`) as HTMLElement | null
      if (!el) continue
      const r = el.getBoundingClientRect()
      const x1 = r.right - wr.left
      const y1 = r.top + r.height / 2 - wr.top
      const x2 = hubLeft
      const y2 = hubY
      const cx = (x1 + x2) / 2
      next.push({ d: `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}` })
    }

    for (const output of model.outputs) {
      const el = wrap.querySelector(`[data-flow-id="${output.id}"]`) as HTMLElement | null
      if (!el) continue
      const r = el.getBoundingClientRect()
      const x1 = hubRight
      const y1 = hubY
      const x2 = r.left - wr.left
      const y2 = r.top + r.height / 2 - wr.top
      const cx = (x1 + x2) / 2
      next.push({
        d: `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`,
        warning: output.isWarning,
      })
    }

    setPaths(next)
  }, [model.inputs, model.outputs])

  useLayoutEffect(() => {
    remeasure()
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => remeasure())
    ro.observe(wrap)
    Array.from(wrap.querySelectorAll('[data-flow-id]')).forEach((el) => ro.observe(el))
    if (hubRef.current) ro.observe(hubRef.current)
    return () => ro.disconnect()
  }, [remeasure])

  useEffect(() => {
    const t = window.setTimeout(remeasure, 0)
    return () => window.clearTimeout(t)
  }, [remeasure, model.summaryLine, model.inputs.length, model.outputs.length])

  return (
    <div ref={wrapRef} className="tx-flow-diagram">
      <svg
        className="tx-flow-lines"
        width={svgSize.w}
        height={svgSize.h}
        viewBox={`0 0 ${svgSize.w} ${svgSize.h}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        {paths.map((path, index) => (
          <path key={index} className={path.warning ? 'warning' : undefined} d={path.d} />
        ))}
      </svg>
      <div className="tx-flow-columns">
        <div className="tx-flow-col tx-flow-inputs">
          {model.inputs.map((input) => (
            <FlowNode
              key={input.id}
              flowId={input.id}
              title={input.label}
              directionLabel={inputDirection}
              subtitle={compactFlowSubtitle(input.subtitle, model.chain)}
              amount={input.amount}
              chain={model.chain}
              bitcoinDisplayUnit={bitcoinDisplayUnit}
              align="right"
              kind="input"
              fiat={coinFiatLabel(input.amount, spotPrice, displayCurrency)}
            />
          ))}
        </div>
        <div className="tx-flow-hub">
          <div ref={hubRef} className="tx-flow-hub-inner">
            <span className="tx-flow-hub-pulse" aria-hidden />
            <span>Transaction</span>
          </div>
        </div>
        <div className="tx-flow-col tx-flow-outputs">
          {model.outputs.map((output) => (
            <FlowNode
              key={output.id}
              flowId={output.id}
              title={output.label}
              directionLabel={output.kind === 'fee' ? undefined : 'Send to'}
              subtitle={compactFlowSubtitle(output.subtitle, model.chain)}
              amount={output.amount}
              chain={model.chain}
              bitcoinDisplayUnit={bitcoinDisplayUnit}
              align="left"
              warning={output.isWarning}
              fiat={coinFiatLabel(output.amount, spotPrice, displayCurrency)}
              kind={output.kind}
              infoTip={feeOutputTip(output.label)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function FlowNode({
  flowId,
  title,
  directionLabel,
  subtitle,
  amount,
  chain,
  bitcoinDisplayUnit,
  align,
  warning = false,
  fiat,
  kind,
  infoTip,
}: {
  flowId: string
  title: string
  directionLabel?: string
  subtitle?: string | null
  amount: number
  chain: CoinChain
  bitcoinDisplayUnit: BitcoinDisplayUnit
  align: 'left' | 'right'
  warning?: boolean
  fiat?: string | null
  kind: OutputKind | 'input'
  infoTip?: string | null
}): React.JSX.Element {
  return (
    <div
      data-flow-id={flowId}
      className={`tx-flow-node tx-flow-node-${align}${warning ? ' tx-flow-node-warn' : ''}`}
    >
      <div className="tx-flow-node-icon" data-kind={kind} aria-hidden>
        {flowIcon(kind)}
      </div>
      <div className="tx-flow-node-copy">
        <div className="tx-flow-node-title-row">
          <div className="tx-flow-node-title">
            {directionLabel && <span className="tx-flow-direction">{directionLabel}</span>}
            <span className={typeof title === 'string' && /\b(Receive|Change)\s*#/i.test(title) ? 'tx-flow-path-label' : undefined}>
              {title}
            </span>
          </div>
          {infoTip && <InfoTipButton text={infoTip} />}
        </div>
        {subtitle && <div className="tx-flow-node-sub tx-flow-node-address">{subtitle}</div>}
        <div className="tx-flow-node-amt">{formatVisualAmount(amount, chain, bitcoinDisplayUnit)}</div>
        {fiat && <div className="tx-flow-node-fiat">{fiat}</div>}
      </div>
    </div>
  )
}

function flowIcon(kind: OutputKind | 'input'): React.JSX.Element {
  if (kind === 'recipient') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm1 5v5.1l2.1-2.1 1.4 1.4L12 17l-4.5-4.6L8.9 11l2.1 2.1V8h2Z" />
      </svg>
    )
  }
  if (kind === 'change') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="8.25" />
        <path d="M9 12h5.75a2.75 2.75 0 1 0 0-5.5H13" />
        <path d="M13 9.25 15.5 12 13 14.75" />
      </svg>
    )
  }
  if (kind === 'fee') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M12.8 2.7c.6 2.9-.5 4.3-1.9 5.8-1.2 1.3-2.7 2.8-2.7 5.4 0 2.2 1.4 4.1 3.3 4.8-.6-1.1-.5-2.5.5-3.8.7-.9 1.7-1.6 1.7-3.2 2.1 1.5 3.2 3.1 3.2 5.2 1.3-1 2.1-2.6 2.1-4.5 0-3.6-2.4-5.8-4-7.2-.9-.8-1.6-1.4-2.2-2.5Z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 5a7 7 0 0 0-5.9 3.2L4.4 6.5 3 7.9l3.8 3.8 3.8-3.8-1.4-1.4-1.5 1.5A5 5 0 1 1 7 12H5a7 7 0 1 0 7-7Z" />
    </svg>
  )
}

function WarningGlyph({ danger }: { danger: boolean }): React.JSX.Element {
  return danger ? (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M1 21h22L12 2 1 21Zm12-3h-2v-2h2v2Zm0-4h-2v-4h2v4Z" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 9h2v6h-2v-6Zm0-4h2v2h-2V7Z" />
    </svg>
  )
}

function metadataTipForLabel(label: string): string | null {
  switch (label) {
    case 'Minimum relay fee':
      return 'The smallest fee Kaspa nodes will accept to relay this transaction. On Toccata it scales with transaction mass at 100 sompi/gram, so heavier transactions need a higher minimum.'
    case 'KIP-9 storage mass':
      return 'KIP-9 measure of how much UTXO-set space this transaction adds. It must stay within network limits.'
    case 'Transaction mass':
      return 'Total transaction weight under KIP-9. The minimum relay fee scales with this value.'
    case 'Feerate':
      return 'Fee per unit of transaction weight — sompi/gram on Kaspa, sat/vB on Bitcoin. Higher values mean miners prioritize your transaction sooner.'
    case 'Virtual size':
      return 'Estimated Bitcoin transaction size in virtual bytes (vB). Miners price fees per vB, so larger transactions cost more at the same feerate.'
    case 'RBF':
      return 'Replace-By-Fee: Enabled means the transaction can be fee-bumped while unconfirmed. Disabled means it is not marked for replacement.'
    case 'Confirmations':
      return 'How many blocks have settled on top of this transaction. More confirmations means stronger settlement. On Kaspa this grows from the accepting block’s blue score.'
    case 'Block height':
      return 'The block number this transaction was included in.'
    case 'Blue score':
      return 'Blue score of the accepting chain block — Kaspa’s settlement milestone (similar to Bitcoin’s block height). Confirmations grow as the network tip advances past this value.'
    case 'Timestamp':
      return 'When this transaction was mined, in UTC.'
    default:
      return null
  }
}

function feeOutputTip(label: string): string | null {
  if (label.toLowerCase().includes('excess')) {
    return 'Leftover coin that KIP-9 rules cannot return as change. It is added to what miners receive, separate from the network fee line.'
  }
  if (label.toLowerCase().includes('high fee')) {
    return 'This fee is much higher than the network minimum for a transaction of this size.'
  }
  if (label.toLowerCase().includes('fee')) {
    return 'Fee paid to miners to include this transaction.'
  }
  return null
}

const TXID_TIP =
  'Transaction ID of this unsigned draft. It is deterministic from the transaction contents and will match after signing, before broadcast.'

function CopyAddressButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="tx-visualize-copy-btn"
      onClick={() => {
        void copyToClipboard(text).then((ok) => {
          if (ok) {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }
        })
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function TxIoRow({
  label,
  directionLabel,
  address,
  amount,
  chain,
  bitcoinDisplayUnit,
  displayCurrency,
  unitPrice,
}: {
  label: string
  directionLabel: string
  address?: string | null
  amount: number
  chain: CoinChain
  bitcoinDisplayUnit: BitcoinDisplayUnit
  displayCurrency: DisplayCurrency
  unitPrice?: number
}): React.JSX.Element {
  const fiat = coinFiatLabel(amount, unitPrice, displayCurrency)
  return (
    <div className="tx-visualize-io-card">
      <div className="tx-visualize-io-head">
        <span className="field-label">
          <span className="tx-io-direction">{directionLabel}</span>{' '}
          <span className={typeof label === 'string' && /\b(Receive|Change)\s*#/i.test(label) ? 'tx-flow-path-label' : undefined}>
            {label}
          </span>
        </span>
        {address && <CopyAddressButton text={address} />}
      </div>
      <div className="tx-visualize-io-amount">{formatVisualAmount(amount, chain, bitcoinDisplayUnit)}</div>
      {fiat && <div className="tx-visualize-io-fiat">{fiat}</div>}
      {address && <code className="tx-visualize-io-address">{address}</code>}
    </div>
  )
}

export function TxVisualizeBody({
  model,
  displayCurrency,
  bitcoinDisplayUnit,
  showIoLists = false,
}: {
  model: VisualModel
  displayCurrency: DisplayCurrency
  bitcoinDisplayUnit: BitcoinDisplayUnit
  showIoLists?: boolean
}): React.JSX.Element {
  const { timeFormat } = useApp()
  const unitPrice = useTxUnitPrice(model.chain, displayCurrency, model.blockTime)

  return (
    <>
      {showIoLists && model.metadata.length > 0 && (
        <>
          <p className="tx-visualize-section-label">On-chain</p>
          <div className="tx-visualize-metadata">
            {model.metadata.map((row) => (
              <div key={row.label} className={`tx-visualize-meta-card${row.isWarning ? ' warn' : ''}`}>
                <div className="tx-visualize-meta-label">
                  <span className="field-label">{row.label}</span>
                  {metadataTipForLabel(row.label) && (
                    <InfoTipButton text={metadataTipForLabel(row.label)!} />
                  )}
                </div>
                <div>
                  {row.label === 'Timestamp' && model.blockTime
                    ? formatDateAndClock(new Date(model.blockTime * 1000), timeFormat)
                    : row.value}
                </div>
                {row.detail && <div className="muted" style={{ fontSize: 11 }}>{row.detail}</div>}
              </div>
            ))}
          </div>
        </>
      )}

      <p className="tx-visualize-section-label">Flow</p>
      <FlowDiagram
        model={model}
        displayCurrency={displayCurrency}
        bitcoinDisplayUnit={bitcoinDisplayUnit}
        unitPrice={unitPrice}
        draftMode={model.usesDraftDetail}
      />

      {showIoLists && (
        <>
          <p className="tx-visualize-section-label">Inputs ({model.inputs.length}) · Sent from</p>
          <div className="tx-visualize-io-list">
            {model.inputs.map((input) => (
              <TxIoRow
                key={input.id}
                label={input.label}
                directionLabel="Sent from"
                address={input.address ?? input.subtitle}
                amount={input.amount}
                chain={model.chain}
                bitcoinDisplayUnit={bitcoinDisplayUnit}
                displayCurrency={displayCurrency}
                unitPrice={unitPrice}
              />
            ))}
          </div>

          <p className="tx-visualize-section-label">
            Outputs ({model.outputs.filter((o) => o.kind !== 'fee').length}) · Send to
          </p>
          <div className="tx-visualize-io-list">
            {model.outputs
              .filter((output) => output.kind !== 'fee')
              .map((output) => (
                <TxIoRow
                  key={output.id}
                  label={output.label}
                  directionLabel="Send to"
                  address={output.address ?? output.subtitle}
                  amount={output.amount}
                  chain={model.chain}
                  bitcoinDisplayUnit={bitcoinDisplayUnit}
                  displayCurrency={displayCurrency}
                  unitPrice={unitPrice}
                />
              ))}
          </div>
        </>
      )}

      <p className="tx-visualize-section-label">Summary</p>
      <div className="tx-visualize-summary">
        <p className="tx-visualize-summary-line">{model.summaryLine}</p>
        {model.summaryFeeLine && <p className="tx-visualize-summary-fee">{model.summaryFeeLine}</p>}
        {(() => {
          const recipientOutputs = model.outputs.filter((o) => o.kind === 'recipient' && o.amount > 0)
          const primaryAmount =
            recipientOutputs.length > 0
              ? recipientOutputs.reduce((sum, o) => sum + o.amount, 0)
              : 0
          const fee = model.outputs.find((o) => o.kind === 'fee')
          const sendFiat =
            primaryAmount > 0 ? coinFiatLabel(primaryAmount, unitPrice, displayCurrency) : null
          const feeFiat = fee ? coinFiatLabel(fee.amount, unitPrice, displayCurrency) : null
          if (!sendFiat && !feeFiat) return null
          const amountLabel = model.summaryLine.startsWith('Received') ? 'Received' : 'Sent'
          return (
            <div className="tx-visualize-summary-fiat">
              {sendFiat && (
                <div>
                  {amountLabel} ≈ {sendFiat}
                </div>
              )}
              {feeFiat && <div>Fee ≈ {feeFiat}</div>}
            </div>
          )
        })()}
        <code className="tx-visualize-summary-balance">{model.balanceLine}</code>
      </div>
    </>
  )
}

export function TransactionVisualizeView({
  draftId,
  walletId,
  chain,
  displayCurrency,
  bitcoinDisplayUnit,
  api,
  fallbackSummary,
  fallbackInputs,
  recipientAddress,
  onDismiss,
}: {
  draftId: string
  walletId: string | null
  chain: CoinChain
  displayCurrency: DisplayCurrency
  bitcoinDisplayUnit: BitcoinDisplayUnit
  api: APIClient
  fallbackSummary: Summary
  fallbackInputs: UtxoDTO[]
  recipientAddress: string
  onDismiss: () => void
}): React.JSX.Element {
  const fallback = useMemo(
    () => fallbackModel(fallbackSummary, fallbackInputs, chain, recipientAddress, bitcoinDisplayUnit),
    [fallbackSummary, fallbackInputs, chain, recipientAddress, bitcoinDisplayUnit],
  )
  const [model, setModel] = useState<VisualModel | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [txidCopied, setTxidCopied] = useState(false)
  const [hexCopied, setHexCopied] = useState(false)
  const { timeFormat } = useApp()

  const active = model ?? fallback

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoadingDetail(true)
      setLoadError(null)
      if (!draftId) {
        setModel(null)
        setLoadingDetail(false)
        return
      }
      try {
        const res = await api.draftVisualize(draftId, walletId ?? undefined)
        if (!cancelled) setModel(modelFromApi(res, chain, true, bitcoinDisplayUnit))
      } catch (e) {
        if (!cancelled) {
          setLoadError(`Showing summary only — ${e instanceof Error ? e.message : 'load failed'}`)
          setModel(null)
        }
      } finally {
        if (!cancelled) setLoadingDetail(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, chain, draftId, walletId, bitcoinDisplayUnit])

  return (
    <div className="modal-overlay" onClick={onDismiss} role="presentation">
      <div className="tx-visualize-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="tx-visualize-header">
          <div>
            <h3 className="tx-visualize-title">Transaction</h3>
            <div className="tx-visualize-badges">
              <span className="tx-visualize-badge">{chain === 'bitcoin' ? 'Bitcoin' : 'Kaspa'}</span>
              {active.usesDraftDetail && <span className="tx-visualize-badge tx-visualize-badge-accent">Exact draft</span>}
              {loadingDetail && <span className="tx-visualize-badge muted">Updating…</span>}
            </div>
            {active.txid && (
              <div className="tx-visualize-txid">
                <div className="tx-visualize-txid-row">
                  <span className="tx-visualize-txid-label">
                    TxID
                    <InfoTipButton text={TXID_TIP} />
                  </span>
                  <button
                    type="button"
                    className="tx-visualize-copy-btn"
                    onClick={() => {
                      void copyToClipboard(active.txid!).then((ok) => {
                        if (ok) {
                          setTxidCopied(true)
                          setTimeout(() => setTxidCopied(false), 1500)
                        }
                      })
                    }}
                  >
                    {txidCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <code className="tx-visualize-txid-code">{active.txid}</code>
              </div>
            )}
          </div>
          <button type="button" className="tx-visualize-done" onClick={onDismiss}>
            Done
          </button>
        </div>

        <div className="tx-visualize-content">
            {loadError && (
              <p className="tx-visualize-load-error">{loadError}</p>
            )}

            <TxVisualizeBody
              model={active}
              displayCurrency={displayCurrency}
              bitcoinDisplayUnit={bitcoinDisplayUnit}
            />

            {active.warnings.length > 0 && (
              <>
                <p className="tx-visualize-section-label">Warnings</p>
                {active.warnings.map((w) => (
                  <div key={w.message} className={`tx-visualize-warning${w.severity === 'danger' ? ' tx-visualize-warning-danger' : ''}`}>
                    <span className="tx-visualize-warning-icon" aria-hidden>
                      <WarningGlyph danger={w.severity === 'danger'} />
                    </span>
                    <span>{w.message}</span>
                  </div>
                ))}
              </>
            )}

            {active.metadata.length > 0 && active.usesDraftDetail && (
              <>
                <p className="tx-visualize-section-label">Details</p>
                <div className="tx-visualize-metadata">
                  {active.metadata.map((row) => (
                    <div key={row.label} className={`tx-visualize-meta-card${row.isWarning ? ' warn' : ''}`}>
                      <div className="tx-visualize-meta-label">
                        <span className="field-label">{row.label}</span>
                        {metadataTipForLabel(row.label) && (
                          <InfoTipButton text={metadataTipForLabel(row.label)!} />
                        )}
                      </div>
                      <div>
                        {row.label === 'Timestamp' && active.blockTime
                          ? formatDateAndClock(new Date(active.blockTime * 1000), timeFormat)
                          : row.value}
                      </div>
                      {row.detail && <div className="muted" style={{ fontSize: 11 }}>{row.detail}</div>}
                    </div>
                  ))}
                </div>
              </>
            )}

            {active.rawHex && (
              <>
                <p className="tx-visualize-section-label">{active.rawHexLabel ?? 'Raw data'}</p>
                <div className="tx-visualize-raw">
                <div className="tx-visualize-raw-header">
                  <span>{active.rawHex.length} characters</span>
                    <button
                      type="button"
                    className="tx-visualize-copy-btn"
                      onClick={() => {
                        void copyToClipboard(active.rawHex!).then((ok) => {
                          if (ok) {
                            setHexCopied(true)
                            setTimeout(() => setHexCopied(false), 1500)
                          }
                        })
                      }}
                    >
                      {hexCopied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <pre className="tx-visualize-raw-pre">{active.rawHex.slice(0, 4000)}</pre>
                </div>
              </>
            )}
          </div>
      </div>
    </div>
  )
}
