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
  const { networkSettings, loadTransactions } = useApp()
  const id = txId(tx)
  const listSummary = useMemo(() => listRowSummary(tx, chain), [tx, chain])
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [txidCopied, setTxidCopied] = useState(false)
  const [displayId, setDisplayId] = useState(id)
  const [model, setModel] = useState<ReturnType<typeof modelFromApi> | null>(() => {
    const cached = getCachedTxVisualize(walletId, id)
    return cached ? modelFromApi(cached, chain, false, bitcoinDisplayUnit) : null
  })
  // Ignore the same pointer/click that opened the sheet so the overlay does not close immediately.
  const ignoreBackdropUntil = useRef(0)
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
        if (!tx.counterparty?.trim()) {
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
  }, [api, bitcoinDisplayUnit, chain, id, walletId, loadTransactions, tx.counterparty])

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
