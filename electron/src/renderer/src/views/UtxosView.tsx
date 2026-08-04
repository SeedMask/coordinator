import { useEffect, useMemo, useState } from 'react'
import { useApp } from '@renderer/state/AppProvider'
import { utxoCoinAmount, utxoMatchesChain } from '@renderer/api/types'
import {
  groupUtxosByAddress,
  isGroupFullySelected,
  isGroupPartiallySelected,
  type UtxoAddressGroup,
} from '@renderer/utils/utxoHelpers'
import { txExplorerUrl } from '@renderer/utils/blockExplorer'
import { txId, txIdAliases, txLabel } from '@renderer/utils/txHelpers'
import { coinDisplayUnit, usesBitcoinSats } from '@renderer/utils/coinDisplay'
import { GridIcon } from '@renderer/components/icons'

export function UtxosView(): React.JSX.Element {
  const {
    activeWallet,
    utxos,
    selectedChain,
    balanceKasValue,
    balanceFiatText,
    selectedSpendUtxoKeys,
    selectedSpendUtxos,
    toggleAddressGroup,
    selectAllSpendableUtxos,
    clearSpendSelection,
    presentSend,
    refreshActiveWallet,
    mergeAddressBalances,
    isScanning,
    isRefreshing,
    toggleSpendUtxo,
    networkSettings,
    transactions,
    bitcoinDisplayUnit,
    balanceSompi,
  } = useApp()
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null)

  const chainUtxos = useMemo(
    () => utxos.filter((u) => utxoMatchesChain(u, selectedChain)),
    [utxos, selectedChain],
  )
  const receiveGroups = useMemo(
    () => groupUtxosByAddress(chainUtxos.filter((u) => !u.is_change)),
    [chainUtxos],
  )
  const changeGroups = useMemo(
    () => groupUtxosByAddress(chainUtxos.filter((u) => u.is_change)),
    [chainUtxos],
  )
  const hasFundedCoins = receiveGroups.length > 0 || changeGroups.length > 0
  const transactionLabels = useMemo(() => {
    const labels = new Map<string, string>()
    for (const tx of transactions) {
      const label = txLabel(tx)
      if (!label) continue
      for (const alias of txIdAliases(txId(tx))) labels.set(alias, label)
    }
    return labels
  }, [transactions])
  const showSats = usesBitcoinSats(selectedChain, bitcoinDisplayUnit)
  const unit = coinDisplayUnit(selectedChain, bitcoinDisplayUnit)
  const formatAmount = (amountCoins: number): string =>
    showSats
      ? Math.max(0, Math.round(amountCoins * 100_000_000)).toLocaleString('en-US')
      : amountCoins.toFixed(8)
  const refreshing = activeWallet ? isRefreshing(activeWallet.id) : isScanning
  const selected = selectedSpendUtxos()
  const selectionSummary =
    selected.length === 0
      ? 'No coins selected for send'
      : `${selected.length} UTXO${selected.length === 1 ? '' : 's'} selected · ${formatAmount(selected.reduce((s, u) => s + utxoCoinAmount(u), 0))} ${unit}`

  useEffect(() => {
    if (!activeWallet) return
    void mergeAddressBalances()
  }, [activeWallet?.id, chainUtxos.map((u) => `${u.key}:${u.amount}`).join(',')])

  if (!activeWallet) return <p className="muted">No active wallet.</p>

  return (
    <div className="utxos-view">
      <div className="row spread coins-header-row">
        <h2 className="section-title">Coins</h2>
        <div className="coins-header-actions">
          <div className="card coins-manage-tip">
            <strong>Managing your coins</strong>
            <p>
              Each address holds one or more UTXOs — unspent pieces of {unit} you can spend. Click an
              address to expand and pick exact coins, or select whole addresses at once. Use
              <em> Send with selected</em> to spend only what you chose. Change outputs appear in their
              own section and still count toward your balance. Keeping larger UTXOs intact helps
              privacy and fees; combining dusty ones when you send can tidy the set over time.
            </p>
          </div>
          <button type="button" className="btn btn-ghost" disabled={refreshing} onClick={() => void refreshActiveWallet()}>
            Refresh
          </button>
        </div>
      </div>

      {hasFundedCoins ? (
        <>
          <div className="card utxo-balance-hero">
            <div className="muted">Total balance</div>
            <div className="dashboard-hero-balance row" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span className="hero-balance">
                {showSats ? balanceSompi.toLocaleString('en-US') : balanceKasValue.toFixed(8)}
              </span>
              <span className="hero-unit">{unit}</span>
              {balanceFiatText && <span className="hero-fiat">{balanceFiatText}</span>}
            </div>
          </div>

          <div className="utxo-selection-toolbar">
            <div className="row">
              <button type="button" className="link-btn" onClick={selectAllSpendableUtxos}>
                Select all
              </button>
              <button type="button" className="link-btn muted-link" onClick={clearSpendSelection}>
                Clear
              </button>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                className="btn btn-primary"
                disabled={selectedSpendUtxoKeys.size === 0}
                onClick={() => presentSend(true)}
              >
                Send with selected
              </button>
            </div>
            <p className="muted">{selectionSummary}</p>
          </div>

          {receiveGroups.length > 0 && (
            <>
              <h3 className="coins-path-heading">Receive</h3>
              {receiveGroups.map((group) => (
                <CoinsAddressRow
                  key={group.id}
                  group={group}
                  path="Receive"
                  unit={unit}
                  formatAmount={formatAmount}
                  selectedChain={selectedChain}
                  selectedSpendUtxoKeys={selectedSpendUtxoKeys}
                  expandedGroupId={expandedGroupId}
                  setExpandedGroupId={setExpandedGroupId}
                  toggleAddressGroup={toggleAddressGroup}
                  toggleSpendUtxo={toggleSpendUtxo}
                  networkSettings={networkSettings}
                  transactionLabels={transactionLabels}
                />
              ))}
            </>
          )}

          {changeGroups.length > 0 && (
            <>
              <h3 className="coins-path-heading" style={{ marginTop: receiveGroups.length ? 8 : 0 }}>Change</h3>
              {changeGroups.map((group) => (
                <CoinsAddressRow
                  key={group.id}
                  group={group}
                  path="Change"
                  unit={unit}
                  formatAmount={formatAmount}
                  selectedChain={selectedChain}
                  selectedSpendUtxoKeys={selectedSpendUtxoKeys}
                  expandedGroupId={expandedGroupId}
                  setExpandedGroupId={setExpandedGroupId}
                  toggleAddressGroup={toggleAddressGroup}
                  toggleSpendUtxo={toggleSpendUtxo}
                  networkSettings={networkSettings}
                  transactionLabels={transactionLabels}
                />
              ))}
            </>
          )}
        </>
      ) : refreshing ? (
        <p className="muted">Updating balances…</p>
      ) : (
        <div className="card empty-state">
          <div className="empty-state-icon">
            <GridIcon size={44} />
          </div>
          <strong>No balance yet</strong>
          <p className="muted">Refresh after receiving {unit}.</p>
          <button type="button" className="btn btn-primary" onClick={() => void refreshActiveWallet()}>
            Refresh
          </button>
        </div>
      )}
    </div>
  )
}

function CoinsAddressRow({
  group,
  path,
  unit,
  formatAmount,
  selectedChain,
  selectedSpendUtxoKeys,
  expandedGroupId,
  setExpandedGroupId,
  toggleAddressGroup,
  toggleSpendUtxo,
  networkSettings,
  transactionLabels,
}: {
  group: UtxoAddressGroup
  path: string
  unit: string
  formatAmount: (amountCoins: number) => string
  selectedChain: ReturnType<typeof useApp>['selectedChain']
  selectedSpendUtxoKeys: Set<string>
  expandedGroupId: string | null
  setExpandedGroupId: (id: string | null) => void
  toggleAddressGroup: (keys: string[]) => void
  toggleSpendUtxo: (key: string) => void
  networkSettings: ReturnType<typeof useApp>['networkSettings']
  transactionLabels: ReadonlyMap<string, string>
}): React.JSX.Element {
  const fullySelected = isGroupFullySelected(group, selectedSpendUtxoKeys)
  const partiallySelected = isGroupPartiallySelected(group, selectedSpendUtxoKeys)
  const open = expandedGroupId === group.id
  const pathLabel = group.addressIndex < 0 ? path : `${path} #${group.addressIndex}`
  const utxoLabel = group.utxos.length === 1 ? '1 UTXO' : `${group.utxos.length} UTXOs`

  function collapse(): void {
    setExpandedGroupId(null)
  }

  function toggleOpen(): void {
    setExpandedGroupId(open ? null : group.id)
  }

  return (
    <div
      className={`utxo-address-row${fullySelected ? ' selected' : ''}${open ? ' open' : ''}`}
      onClick={() => {
        if (open) collapse()
        else toggleOpen()
      }}
    >
      {open && (
        <button
          type="button"
          className="utxo-expand-backdrop"
          aria-label="Close address details"
          onClick={(e) => {
            e.stopPropagation()
            collapse()
          }}
        />
      )}

      <button
        type="button"
        className="utxo-select-btn"
        title={fullySelected ? 'Deselect all UTXOs at this address' : 'Select all UTXOs at this address'}
        onClick={(e) => {
          e.stopPropagation()
          toggleAddressGroup(group.keys)
        }}
      >
        {fullySelected ? '◉' : partiallySelected ? '◑' : '○'}
      </button>

      <div className="utxo-address-body">
        <div className="utxo-address-grid">
          <span className="utxo-address-balance">
            <strong>{formatAmount(group.totalCoins)}</strong> <span className="accent-text">{unit}</span>
          </span>
          <div className="utxo-address-mid">
            <span className="utxo-count-label">{utxoLabel}</span>
            <code className="utxo-address-text" title={group.address}>
              {group.address}
            </code>
          </div>
          <span className="path-badge path-badge-lg">{pathLabel}</span>
          <span className="muted utxo-expand-chevron">{open ? '▴' : '▾'}</span>
        </div>

        {open && (
          <div className="utxo-popover">
            <div className="utxo-popover-toolbar">
              <button
                type="button"
                className="link-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleAddressGroup(group.keys)
                }}
              >
                {fullySelected ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div className="utxo-popover-list">
              {group.utxos.map((utxo) => {
                const selected = selectedSpendUtxoKeys.has(utxo.key)
                const explorer = txExplorerUrl(utxo.transaction_id, selectedChain, networkSettings)
                const rowKey = utxo.key || `${utxo.transaction_id}:${utxo.output_index}`
                const label = txIdAliases(utxo.transaction_id)
                  .map((alias) => transactionLabels.get(alias))
                  .find((value): value is string => Boolean(value))
                return (
                  <button
                    key={rowKey}
                    type="button"
                    className={`compact-utxo-row${selected ? ' selected' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleSpendUtxo(utxo.key || rowKey)
                    }}
                  >
                    <span className="compact-utxo-selector">{selected ? '◉' : '○'}</span>
                    {label && <div className="compact-utxo-label">{label}</div>}
                    <div className="compact-utxo-main">
                      <div className="compact-utxo-amount">
                        <strong>{formatAmount(utxoCoinAmount(utxo))}</strong>{' '}
                        <span className="accent-text">{unit}</span>
                      </div>
                      <div className="row" style={{ gap: 6 }}>
                        <span className="muted">Tx</span>
                        {explorer ? (
                          <a
                            href={explorer}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {utxo.transaction_id.slice(0, 18)}…:{utxo.output_index} ↗
                          </a>
                        ) : (
                          <code>
                            {utxo.transaction_id.slice(0, 18)}…:{utxo.output_index}
                          </code>
                        )}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
