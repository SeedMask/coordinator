import { useEffect, useMemo, useRef, useState } from 'react'
import type { APIClient } from '@renderer/api/client'
import type { BitcoinDisplayUnit, CoinChain, DisplayCurrency, WalletTxDTO } from '@renderer/api/types'
import { modelFromApi, TxVisualizeBody } from '@renderer/components/TransactionVisualizeView'
import { formatBalance } from '@renderer/api/types'
import { copyToClipboard } from '@renderer/utils/clipboard'
import { resolveBitcoinExplorerTxId } from '@renderer/utils/blockExplorer'
import { getCachedTxVisualize, setCachedTxVisualize } from '@renderer/utils/txVisualizeCache'
import { txId } from '@renderer/utils/txHelpers'
import { useApp } from '@renderer/state/AppProvider'

const TIP_SAMPLE_MS = 1500
const PAINT_MS = 100
const KASPA_BPS = 10

type DetailModel = NonNullable<ReturnType<typeof modelFromApi>>

function listRowSummary(tx: WalletTxDTO, chain: CoinChain): string {
  const sompi =
    chain === 'bitcoin'
      ? Number(tx.amount_sats ?? tx.amount_sompi ?? Math.round((tx.amount_btc ?? tx.amount_kas ?? 0) * 1e8))
      : Number(tx.amount_sompi ?? Math.round((tx.amount_kas ?? 0) * 1e8))
  const signed = tx.direction === 'sent' ? -Math.abs(sompi) : Math.abs(sompi)
  const text = formatBalance(Math.abs(sompi), chain)
  const prefix = signed < 0 ? '−' : '+'
  const label = tx.label?.trim() || tx.counterparty?.trim()
  return label ? `${prefix}${text} · ${label}` : `${prefix}${text}`
}

function upsertMetadata(
  model: DetailModel,
  updates: Array<{ label: string; value: string }>,
): DetailModel {
  let changed = false
  const next = [...model.metadata]
  for (const upd of updates) {
    const idx = next.findIndex((m) => m.label === upd.label)
    if (idx >= 0) {
      if (next[idx]!.value === upd.value) continue
      next[idx] = { ...next[idx]!, value: upd.value }
      changed = true
    } else {
      next.push({ label: upd.label, value: upd.value })
      changed = true
    }
  }
  if (!changed) return model
  const order = ['Confirmations', 'Timestamp', 'Blue score', 'Block height', 'RBF']
  next.sort((a, b) => {
    const ai = order.indexOf(a.label)
    const bi = order.indexOf(b.label)
    if (ai < 0 && bi < 0) return 0
    if (ai < 0) return 1
    if (bi < 0) return -1
    return ai - bi
  })
  return { ...model, metadata: next }
}

function metadataNumber(model: DetailModel | null, label: string): number {
  const raw = model?.metadata.find((m) => m.label === label)?.value ?? ''
  const n = Number(String(raw).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function formatConf(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString('en-US')
}

export function WalletTxDetailSheet({
  tx,
  walletId,
  chain,
  displayCurrency,
  bitcoinDisplayUnit,
  api,
  onClose,
}: {
  tx: WalletTxDTO
  walletId: string
  chain: CoinChain
  displayCurrency: DisplayCurrency
  bitcoinDisplayUnit: BitcoinDisplayUnit
  api: APIClient
  onClose: () => void
}): React.JSX.Element {
  const { networkSettings, loadTransactions, transactions } = useApp()
  const id = txId(tx)
  // Prefer the live dashboard row — AppProvider keeps confirmations climbing there.
  const liveTx = useMemo(() => {
    const match = transactions.find((row) => txId(row) === id)
    return match ?? tx
  }, [transactions, id, tx])

  const listSummary = useMemo(() => listRowSummary(liveTx, chain), [liveTx, chain])
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [txidCopied, setTxidCopied] = useState(false)
  const [displayId, setDisplayId] = useState(id)
  const [model, setModel] = useState<DetailModel | null>(() => {
    const cached = getCachedTxVisualize(walletId, id)
    return cached ? modelFromApi(cached, chain, false, bitcoinDisplayUnit) : null
  })
  const ignoreBackdropUntil = useRef(0)
  const modelRef = useRef(model)
  modelRef.current = model
  const liveTxRef = useRef(liveTx)
  liveTxRef.current = liveTx

  useEffect(() => {
    ignoreBackdropUntil.current = Date.now() + 400
  }, [id, walletId])

  useEffect(() => {
    setTxidCopied(false)
    setDisplayId(id)
    if (chain !== 'bitcoin' || !id) return
    let cancelled = false
    void resolveBitcoinExplorerTxId(id, networkSettings?.bitcoin).then((canon) => {
      if (!cancelled && canon) setDisplayId(canon)
    })
    return () => {
      cancelled = true
    }
  }, [id, chain, networkSettings?.bitcoin])

  useEffect(() => {
    let cancelled = false
    const cached = getCachedTxVisualize(walletId, id)
    if (cached) {
      setModel(modelFromApi(cached, chain, false, bitcoinDisplayUnit))
      setRefreshing(false)
    } else {
      setRefreshing(true)
    }
    setError(null)

    void (async () => {
      try {
        const res = await api.walletTxVisualize(walletId, id)
        if (cancelled) return
        setCachedTxVisualize(walletId, id, res)
        setModel(modelFromApi(res, chain, false, bitcoinDisplayUnit))
        if (!liveTx.counterparty?.trim()) {
          void loadTransactions()
        }
      } catch (e) {
        if (!cancelled && !cached) {
          setError(e instanceof Error ? e.message : 'Could not load transaction details')
        }
      } finally {
        if (!cancelled) setRefreshing(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [api, bitcoinDisplayUnit, chain, id, walletId, loadTransactions, liveTx.counterparty])

  // Keep the On-chain Confirmations row in sync with the live wallet row (dashboard paint).
  useEffect(() => {
    if (chain !== 'kaspa') return
    const conf = Math.max(0, Math.floor(Number(liveTx.confirmations) || 0))
    const accepting = Math.max(0, Math.floor(Number(liveTx.accepting_block_blue_score) || 0))
    if (conf <= 0 && accepting <= 0) return
    setModel((prev) => {
      if (!prev) return prev
      const cur = metadataNumber(prev, 'Confirmations')
      const patches: Array<{ label: string; value: string }> = []
      // Never pull the live detail count backwards (dashboard soft-caps around 200).
      if (conf > cur) patches.push({ label: 'Confirmations', value: formatConf(conf) })
      if (accepting > 0) patches.push({ label: 'Blue score', value: formatConf(accepting) })
      return patches.length ? upsertMetadata(prev, patches) : prev
    })
  }, [chain, liveTx.confirmations, liveTx.accepting_block_blue_score])

  // While details are open, keep climbing with tip − blue score (no soft cap).
  useEffect(() => {
    if (!id || chain !== 'kaspa') return
    let cancelled = false
    let inFlight = false
    const paintRef = { tip: 0, atMs: 0 }
    const acceptingRef = { score: 0 }

    const paintTipNow = (): number => {
      if (paintRef.tip <= 0) return 0
      return paintRef.tip + ((Date.now() - paintRef.atMs) / 1000) * KASPA_BPS
    }

    const noteTip = (tipBlue: number): void => {
      if (tipBlue <= 0) return
      const now = Date.now()
      const running = paintRef.tip > 0 ? paintTipNow() : 0
      if (paintRef.tip <= 0 || tipBlue > running) {
        paintRef.tip = tipBlue
        paintRef.atMs = now
      }
    }

    const resolveAccepting = (): number => {
      const live = liveTxRef.current
      const fromLive = Math.max(0, Number(live.accepting_block_blue_score) || 0)
      const fromMeta = metadataNumber(modelRef.current, 'Blue score')
      acceptingRef.score = Math.max(acceptingRef.score, fromLive, fromMeta)
      return acceptingRef.score
    }

    const writeConfirmations = (conf: number, accepting: number): void => {
      const next = Math.max(1, Math.floor(conf))
      setModel((prev) => {
        if (!prev) return prev
        const cur = metadataNumber(prev, 'Confirmations')
        if (next <= cur) {
          if (accepting > 0 && metadataNumber(prev, 'Blue score') <= 0) {
            return upsertMetadata(prev, [{ label: 'Blue score', value: formatConf(accepting) }])
          }
          return prev
        }
        const patches: Array<{ label: string; value: string }> = [
          { label: 'Confirmations', value: formatConf(next) },
        ]
        if (accepting > 0) patches.push({ label: 'Blue score', value: formatConf(accepting) })
        return upsertMetadata(prev, patches)
      })
    }

    const paint = (): void => {
      if (cancelled) return
      const accepting = resolveAccepting()
      if (accepting <= 0) return
      if (paintRef.tip <= 0) {
        const known = Math.max(0, Number(liveTxRef.current.confirmations) || 0)
        if (known > 0) noteTip(accepting + known)
      }
      if (paintRef.tip <= 0) return
      const tipNow = Math.floor(paintTipNow() + 1e-9)
      if (tipNow < accepting) return
      writeConfirmations(tipNow - accepting, accepting)
    }

    const sample = async (): Promise<void> => {
      if (cancelled || inFlight) return
      inFlight = true
      try {
        const tipRes = await api.kaspaTipBlue()
        if (cancelled) return
        noteTip(Number(tipRes.tip_blue) || 0)

        if (resolveAccepting() <= 0) {
          const res = await api.kaspaConfirmations(walletId)
          if (cancelled) return
          noteTip(Number(res.tip_blue) || 0)
          const update = (res.updates || []).find(
            (u) => txId({ transaction_id: u.transaction_id }) === id,
          )
          const accepting = Number(update?.accepting_block_blue_score) || 0
          if (accepting > 0) acceptingRef.score = accepting
          const conf = Number(update?.confirmations) || 0
          if (accepting > 0 && conf > 0) noteTip(Math.max(paintTipNow(), accepting + conf))
        } else {
          const known = Math.max(0, Number(liveTxRef.current.confirmations) || 0)
          const accepting = resolveAccepting()
          if (accepting > 0 && known > 0) noteTip(Math.max(paintTipNow(), accepting + known))
        }
        paint()
      } catch {
        paint()
      } finally {
        inFlight = false
      }
    }

    const paintTimer = window.setInterval(paint, PAINT_MS)
    const sampleTimer = window.setInterval(() => {
      void sample()
    }, TIP_SAMPLE_MS)
    void sample()

    return () => {
      cancelled = true
      window.clearInterval(paintTimer)
      window.clearInterval(sampleTimer)
    }
  }, [api, chain, id, walletId])

  // Bitcoin: refresh Confirmations while the sheet is open.
  useEffect(() => {
    if (!id || chain !== 'bitcoin') return
    let cancelled = false
    let inFlight = false

    const tick = async (): Promise<void> => {
      if (cancelled || inFlight) return
      inFlight = true
      try {
        const res = await api.walletTxVisualize(walletId, id)
        if (cancelled) return
        const confRow = (res.metadata ?? []).find((m) => m.label === 'Confirmations')
        const n = Number(String(confRow?.value ?? '').replace(/,/g, ''))
        if (!Number.isFinite(n) || n <= 0) return
        setModel((prev) =>
          prev ? upsertMetadata(prev, [{ label: 'Confirmations', value: formatConf(n) }]) : prev,
        )
      } catch {
        /* keep last known */
      } finally {
        inFlight = false
      }
    }

    const timer = window.setInterval(() => {
      void tick()
    }, TIP_SAMPLE_MS)
    void tick()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [api, chain, id, walletId])

  function closeFromBackdrop(): void {
    if (Date.now() < ignoreBackdropUntil.current) return
    onClose()
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeFromBackdrop()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeFromBackdrop()
      }}
      role="presentation"
    >
      <div className="tx-visualize-sheet" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        <div className="tx-visualize-header">
          <div>
            <h3 className="tx-visualize-title">Transaction details</h3>
            <div className="tx-visualize-badges">
              <span className="tx-visualize-badge">{chain === 'bitcoin' ? 'Bitcoin' : 'Kaspa'}</span>
              {refreshing && !model && <span className="tx-visualize-badge muted">Loading…</span>}
            </div>
            {displayId && (
              <div className="tx-visualize-txid">
                <div className="tx-visualize-txid-row">
                  <span className="tx-visualize-txid-label">TxID</span>
                  <button
                    type="button"
                    className="tx-visualize-copy-btn"
                    onClick={() => {
                      void copyToClipboard(displayId).then((ok) => {
                        if (ok) {
                          setTxidCopied(true)
                          window.setTimeout(() => setTxidCopied(false), 1500)
                        }
                      })
                    }}
                  >
                    {txidCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <code className="tx-visualize-txid-code" tabIndex={0}>
                  {displayId}
                </code>
              </div>
            )}
          </div>
          <button type="button" className="tx-visualize-done" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="tx-visualize-content">
          {error && <p className="tx-visualize-load-error">{error}</p>}
          {!model && (
            <p className="tx-visualize-summary-line" style={{ marginBottom: 12 }}>
              {listSummary}
            </p>
          )}
          {model && (
            <TxVisualizeBody
              model={model}
              displayCurrency={displayCurrency}
              bitcoinDisplayUnit={bitcoinDisplayUnit}
              showIoLists
            />
          )}
          {!model && refreshing && <p className="tx-visualize-loading muted">Loading full transaction…</p>}
        </div>
      </div>
    </div>
  )
}
