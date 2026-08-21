import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '@renderer/state/AppProvider'
import type { WalletTxDTO } from '@renderer/api/types'
import { coinUnit } from '@renderer/api/types'
import {
  walletIsMultisig,
  walletMultisigQuorumLabel,
  walletResolvedDerivation,
  walletResolvedFingerprint,
} from '@renderer/utils/walletHelpers'
import { AssetHistoryChart } from '@renderer/components/AssetHistoryChart'
import { AccountSwitcher } from '@renderer/components/AccountSwitcher'
import { ReceiveSheet } from '@renderer/components/ReceiveSheet'
import { ScanActivityBanner } from '@renderer/components/ScanActivityBanner'
import { SyncStatusBadge } from '@renderer/components/SyncStatusBadge'
import { TransactionRow } from '@renderer/components/TransactionRow'
import { WalletTxDetailSheet } from '@renderer/components/WalletTxDetailSheet'
import { ArrowDownLeftIcon, ArrowUpRightIcon, RefreshIcon } from '@renderer/components/icons'
import { txId } from '@renderer/utils/txHelpers'

const TX_PAGE_SIZE = 20
const UTXO_HISTORY_REFRESH_DEBOUNCE_MS = 500

export function DashboardView(): React.JSX.Element {
  const {
    activeWallet,
    walletLabel,
    balanceText,
    balanceSompi,
    balanceKasValue,
    balanceFiatText,
    selectedChain,
    bitcoinDisplayUnit,
    setBitcoinDisplayUnit,
    transactions,
    utxos,
    showReceiveSheet,
    setShowReceiveSheet,
    presentSend,
    refreshActiveWallet,
    refreshFiatPrices,
    mergeAddressBalances,
    loadTransactions,
    isScanning,
    isRefreshing,
    activeSyncStatus,
    scanDetailMessage,
    statusMessage,
    api,
    activeWalletId,
    displayCurrency,
  } = useApp()
  const [txSearch, setTxSearch] = useState('')
  const [txPage, setTxPage] = useState(1)
  const [showAllTxs, setShowAllTxs] = useState(false)
  const [detailTx, setDetailTx] = useState<WalletTxDTO | null>(null)
  const loudRefreshing = isScanning || (activeWallet ? isRefreshing(activeWallet.id) : false)
  /** Sorted so order-only UTXO reshuffles do not trigger history refresh. */
  const utxoKeySig = useMemo(
    () =>
      utxos
        .map((u) => u.key)
        .filter(Boolean)
        .sort()
        .join(','),
    [utxos],
  )
  const utxoRefreshSkipRef = useRef<{ walletId: string | undefined; sawEmpty: boolean }>({
    walletId: undefined,
    sawEmpty: true,
  })

  useEffect(() => {
    setDetailTx(null)
  }, [activeWalletId])

  useEffect(() => {
    if (!activeWallet) return
    void loadTransactions()
  }, [activeWallet?.id, selectedChain, loadTransactions])

  useEffect(() => {
    if (!activeWallet) return
    const walletId = activeWallet.id
    // New wallet: skip empty→filled mount transition (AppProvider already loads history).
    if (utxoRefreshSkipRef.current.walletId !== walletId) {
      utxoRefreshSkipRef.current = { walletId, sawEmpty: utxoKeySig.length === 0 }
      if (utxoKeySig.length === 0) return
      // First non-empty set for this wallet — AppProvider sync covers it.
      utxoRefreshSkipRef.current.sawEmpty = false
      return
    }
    if (utxoKeySig.length === 0) {
      utxoRefreshSkipRef.current.sawEmpty = true
      return
    }
    if (utxoRefreshSkipRef.current.sawEmpty) {
      utxoRefreshSkipRef.current.sawEmpty = false
      return
    }
    const timer = window.setTimeout(() => {
      void loadTransactions(undefined, { refresh: true })
    }, UTXO_HISTORY_REFRESH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [activeWallet?.id, utxoKeySig, loadTransactions])

  useEffect(() => {
    void refreshFiatPrices()
  }, [selectedChain, refreshFiatPrices])

  useEffect(() => {
    setTxPage(1)
    setShowAllTxs(false)
  }, [activeWallet?.id, selectedChain, txSearch])

  const filteredTransactions = useMemo(() => {
    const needle = txSearch.trim().toLowerCase()
    if (!needle) return transactions
    return transactions.filter((tx) => {
      const hay = [
        tx.transaction_id,
        tx.txid,
        tx.id,
        tx.counterparty,
        tx.direction,
        tx.label,
        tx.amount_kas,
        tx.amount_btc,
        tx.amount_sompi,
        tx.amount_sats,
      ]
        .map((v) => String(v ?? '').toLowerCase())
        .join(' ')
      return hay.includes(needle)
    })
  }, [transactions, txSearch])

  const txPageCount = Math.max(1, Math.ceil(filteredTransactions.length / TX_PAGE_SIZE))
  const pagedTransactions = useMemo(() => {
    if (showAllTxs) return filteredTransactions
    const start = (txPage - 1) * TX_PAGE_SIZE
    return filteredTransactions.slice(start, start + TX_PAGE_SIZE)
  }, [showAllTxs, filteredTransactions, txPage])

  useEffect(() => {
    if (txPage > txPageCount) setTxPage(txPageCount)
  }, [txPage, txPageCount])

  if (!activeWallet) {
    return <p className="muted">No wallet for this chain — add one or switch chain.</p>
  }

  const unit = coinUnit(selectedChain)
  const chainLabel = selectedChain === 'kaspa' ? 'Kaspa' : 'Bitcoin'
  const isBitcoin = selectedChain === 'bitcoin'
  const showSats = isBitcoin && bitcoinDisplayUnit === 'sats'
  const heroBalance = showSats ? balanceSompi.toLocaleString('en-US') : balanceText
  const heroUnit = showSats ? 'sats' : unit
  const alternateUnitValue = isBitcoin
    ? showSats
      ? `${balanceKasValue.toFixed(8)} BTC`
      : `${balanceSompi.toLocaleString('en-US')} sats`
    : null

  function toggleBitcoinUnit(): void {
    if (!isBitcoin) return
    setBitcoinDisplayUnit(showSats ? 'btc' : 'sats')
  }

  async function refresh(): Promise<void> {
    await Promise.all([refreshActiveWallet(), refreshFiatPrices()])
  }

  async function openReceive(): Promise<void> {
    await mergeAddressBalances()
    setShowReceiveSheet(true)
  }

  return (
    <div className="dashboard-view">
      {loudRefreshing && (
        <ScanActivityBanner
          title={`Syncing ${chainLabel} mainnet`}
          detail={
            scanDetailMessage ??
            (statusMessage.includes('Scanning')
              ? 'Discovering used addresses across your wallet. This can take a few minutes for wallets with lots of activity.'
              : `Refreshing balances, coins, and recent transactions for your ${chainLabel} wallet.`)
          }
        />
      )}

      <div className={`dashboard-hero elevated-card${loudRefreshing ? ' refreshing' : ''}`}>
        <div className="dashboard-hero-top">
          <div className="dashboard-hero-title">
            <span>{walletLabel}</span>
            <span className="accent-text">Balance</span>
            <SyncStatusBadge status={activeSyncStatus} />
          </div>
          <AccountSwitcher wallet={activeWallet} />
        </div>
        <div className="dashboard-hero-balance row" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span className="hero-balance-wrap">
            <span className="hero-balance">{heroBalance}</span>
            {loudRefreshing && <span className="hero-balance-spinner" aria-hidden />}
          </span>
          {isBitcoin ? (
            <span className="hero-unit-wrap">
              <button
                type="button"
                className="hero-unit hero-unit-toggle"
                onClick={(e) => {
                  toggleBitcoinUnit()
                  e.currentTarget.blur()
                }}
              >
                {heroUnit}
              </button>
              {alternateUnitValue && <span className="hero-unit-tip">{alternateUnitValue}</span>}
            </span>
          ) : (
            <span className="hero-unit">{heroUnit}</span>
          )}
          {balanceFiatText && <span className="hero-fiat">{balanceFiatText}</span>}
          <button
            type="button"
            className="dashboard-refresh-btn"
            disabled={loudRefreshing}
            title="Refresh from mainnet"
            onClick={() => void refresh()}
          >
            <RefreshIcon spinning={loudRefreshing} />
          </button>
        </div>
        <WalletIdentityLine wallet={activeWallet} />
      </div>

      <div className="dashboard-actions row">
        <button type="button" className="dashboard-action filled" onClick={() => presentSend(false)}>
          <span className="dashboard-action-icon">
            <ArrowUpRightIcon size={17} />
          </span>
          <span>
            <strong>Send</strong>
            <small>Send coins</small>
          </span>
        </button>
        <button type="button" className="dashboard-action filled" onClick={() => void openReceive()}>
          <span className="dashboard-action-icon">
            <ArrowDownLeftIcon size={17} />
          </span>
          <span>
            <strong>Receive</strong>
            <small>Deposit address</small>
          </span>
        </button>
      </div>

      <AssetHistoryChart />

      <section className="dashboard-transactions">
        <div className="dashboard-transactions-header">
          <h3 className="section-title">Transactions</h3>
          <p className="muted dashboard-transactions-subtitle">
            On-chain sends and receives for this wallet.
          </p>
        </div>
        <div className="row" style={{ marginBottom: 12 }}>
          <input
            className="field-input"
            placeholder="Search tx, label, or address"
            value={txSearch}
            onChange={(e) => setTxSearch(e.target.value)}
          />
          {txSearch && (
            <button type="button" className="btn btn-ghost" onClick={() => setTxSearch('')}>
              Clear
            </button>
          )}
        </div>

        {transactions.length === 0 ? (
          <p className="muted">No transactions yet.</p>
        ) : filteredTransactions.length === 0 ? (
          <p className="muted">No transactions match “{txSearch.trim()}”.</p>
        ) : (
          <>
            <p className="muted tx-count-label">
              {showAllTxs
                ? `${filteredTransactions.length} on-chain transaction${filteredTransactions.length === 1 ? '' : 's'}${txSearch.trim() ? ' matching search' : ''}`
                : `Showing ${(txPage - 1) * TX_PAGE_SIZE + 1}–${Math.min(txPage * TX_PAGE_SIZE, filteredTransactions.length)} of ${filteredTransactions.length}${txSearch.trim() ? ' matching search' : ''}`}
            </p>
            <div className="tx-list">
              {pagedTransactions.map((tx, index) => (
                <div key={txId(tx) || `${txPage}-${index}`}>
                  {index > 0 && <hr className="tx-divider" />}
                  <TransactionRow tx={tx} onOpenDetails={setDetailTx} searchQuery={txSearch} />
                </div>
              ))}
            </div>
            {filteredTransactions.length > TX_PAGE_SIZE && (
              <div className="tx-pagination" role="navigation" aria-label="Transaction pages">
                {!showAllTxs &&
                  Array.from({ length: txPageCount }, (_, i) => i + 1).map((page) => (
                    <button
                      key={page}
                      type="button"
                      className={`tx-page-btn${page === txPage ? ' active' : ''}`}
                      onClick={() => setTxPage(page)}
                    >
                      {page}
                    </button>
                  ))}
                <button
                  type="button"
                  className={`tx-page-btn tx-page-see-all${showAllTxs ? ' active' : ''}`}
                  onClick={() => {
                    if (showAllTxs) {
                      setShowAllTxs(false)
                      setTxPage(1)
                    } else {
                      setShowAllTxs(true)
                    }
                  }}
                >
                  {showAllTxs ? 'Paginate' : 'See all'}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {showReceiveSheet && <ReceiveSheet onClose={() => setShowReceiveSheet(false)} />}

      {detailTx && api && activeWalletId && (
        <WalletTxDetailSheet
          tx={detailTx}
          walletId={activeWalletId}
          chain={selectedChain}
          displayCurrency={displayCurrency}
          bitcoinDisplayUnit={bitcoinDisplayUnit}
          api={api}
          onClose={() => setDetailTx(null)}
        />
      )}
    </div>
  )
}

function WalletIdentityLine({ wallet }: { wallet: NonNullable<ReturnType<typeof useApp>['activeWallet']> }): React.JSX.Element | null {
  const derivation = walletResolvedDerivation(wallet)
  const identity = walletIsMultisig(wallet)
    ? (() => {
        const quorum = walletMultisigQuorumLabel(wallet)
        return quorum ? `${quorum} Multisig` : 'Multisig'
      })()
    : walletResolvedFingerprint(wallet) || '—'

  return (
    <div className="wallet-identity-line">
      <span className="wallet-identity-derivation">{derivation}</span>
      <span className={`wallet-identity-badge${walletIsMultisig(wallet) ? ' multisig' : ''}`}>
        {walletIsMultisig(wallet) ? identity : `Fingerprint ${identity}`}
      </span>
    </div>
  )
}
