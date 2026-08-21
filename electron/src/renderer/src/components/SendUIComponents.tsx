import { useState } from 'react'
import type { DisplayCurrency } from '@renderer/api/types'
import { groupUtxosByAddress, type UtxoAddressGroup } from '@renderer/utils/utxoHelpers'
import { coinAmountLabel } from '@renderer/utils/sendAmount'
import type { CoinChain, UtxoDTO } from '@renderer/api/types'
import { coinUnit } from '@renderer/api/types'
import { formatUtxoDepositLine, isGroupFullySelected, isGroupPartiallySelected } from '@renderer/utils/utxoHelpers'

const DISPLAY_CURRENCIES: DisplayCurrency[] = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'CHF', 'AUD']

export function SeedMaskUnitField({
  placeholder,
  value,
  onChange,
  unit,
}: {
  placeholder: string
  value: string
  onChange: (v: string) => void
  unit: string
}): React.JSX.Element {
  return (
    <div className="seed-mask-unit-field">
      <input
        className="seed-mask-unit-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
      />
      <span className="seed-mask-unit-label">{unit}</span>
    </div>
  )
}

export function SeedMaskFiatField({
  placeholder,
  value,
  onChange,
  displayCurrency,
  onCurrencyChange,
}: {
  placeholder: string
  value: string
  onChange: (v: string) => void
  displayCurrency: DisplayCurrency
  onCurrencyChange: (c: DisplayCurrency) => void
}): React.JSX.Element {
  return (
    <div className="seed-mask-unit-field">
      <input
        className="seed-mask-unit-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
      />
      <details className="seed-mask-fiat-picker">
        <summary>
          {displayCurrency}
          <span className="seed-mask-fiat-chevron" aria-hidden>
            ▾
          </span>
        </summary>
        <div className="seed-mask-fiat-menu">
          {DISPLAY_CURRENCIES.map((c) => (
            <button key={c} type="button" onClick={() => onCurrencyChange(c)}>
              {c}
            </button>
          ))}
        </div>
      </details>
    </div>
  )
}

export function RecipientSelfMenu({
  ownAddresses,
  otherWallets,
  onSelectAddress,
  resolveWalletAddress,
}: {
  ownAddresses: Array<{ index: number; address: string }>
  otherWallets: Array<{ id: string; name: string }>
  onSelectAddress: (address: string) => void
  resolveWalletAddress: (walletId: string) => Promise<string>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<'root' | 'this' | 'wallets'>('root')
  const [loadingWalletId, setLoadingWalletId] = useState<string | null>(null)
  const [resolveError, setResolveError] = useState<string | null>(null)

  function resetMenu(): void {
    setPane('root')
    setResolveError(null)
    setLoadingWalletId(null)
  }

  async function pickWallet(walletId: string): Promise<void> {
    setResolveError(null)
    setLoadingWalletId(walletId)
    try {
      const address = (await resolveWalletAddress(walletId)).trim()
      if (!address) {
        setResolveError('Could not find a receive address for that wallet')
        return
      }
      onSelectAddress(address)
      setOpen(false)
      resetMenu()
    } catch (e) {
      setResolveError(e instanceof Error ? e.message : 'Could not load wallet address')
    } finally {
      setLoadingWalletId(null)
    }
  }

  const showThisWallet = ownAddresses.length > 0
  const showMyWallets = otherWallets.length > 0

  return (
    <details
      className="receive-address-menu"
      open={open}
      onToggle={(e) => {
        const nextOpen = e.currentTarget.open
        setOpen(nextOpen)
        if (!nextOpen) resetMenu()
      }}
    >
      <summary className="receive-address-menu-summary">
        <span>Send to my address or wallet</span>
        <span className="receive-address-menu-chevron" aria-hidden />
      </summary>
      <div className="receive-address-menu-body">
        {pane === 'root' && (
          <div className="receive-address-menu-section">
            <div className="receive-address-menu-list">
              {showThisWallet && (
                <button type="button" className="receive-address-menu-nav" onClick={() => setPane('this')}>
                  <span className="receive-address-menu-item-label">This wallet</span>
                  <span className="receive-address-menu-item-addr">
                    {ownAddresses.length} receive address{ownAddresses.length === 1 ? '' : 'es'}
                  </span>
                  <span className="receive-address-menu-nav-chevron" aria-hidden />
                </button>
              )}
              {showMyWallets && (
                <button type="button" className="receive-address-menu-nav" onClick={() => setPane('wallets')}>
                  <span className="receive-address-menu-item-label">My wallets</span>
                  <span className="receive-address-menu-item-addr">
                    {otherWallets.length} wallet{otherWallets.length === 1 ? '' : 's'}
                  </span>
                  <span className="receive-address-menu-nav-chevron" aria-hidden />
                </button>
              )}
              {!showThisWallet && !showMyWallets && (
                <p className="muted receive-address-menu-empty">No saved addresses yet</p>
              )}
            </div>
          </div>
        )}

        {pane === 'this' && (
          <div className="receive-address-menu-section">
            <button type="button" className="receive-address-menu-back" onClick={() => setPane('root')}>
              <span className="receive-address-menu-back-chevron" aria-hidden />
              This wallet
            </button>
            <div className="receive-address-menu-list">
              {ownAddresses.slice(0, 8).map((a) => (
                <button
                  key={a.address}
                  type="button"
                  onClick={() => {
                    onSelectAddress(a.address)
                    setOpen(false)
                    resetMenu()
                  }}
                >
                  <span className="receive-address-menu-item-label">Receive #{a.index}</span>
                  <span className="receive-address-menu-item-addr">{a.address}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {pane === 'wallets' && (
          <div className="receive-address-menu-section">
            <button type="button" className="receive-address-menu-back" onClick={() => setPane('root')}>
              <span className="receive-address-menu-back-chevron" aria-hidden />
              My wallets
            </button>
            <div className="receive-address-menu-list">
              {otherWallets.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  disabled={loadingWalletId === w.id}
                  onClick={() => void pickWallet(w.id)}
                >
                  <span className="receive-address-menu-item-label">{w.name}</span>
                  <span className="receive-address-menu-item-addr">
                    {loadingWalletId === w.id ? 'Loading address…' : 'Use receive address'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {resolveError && <p className="receive-address-menu-error">{resolveError}</p>}
      </div>
    </details>
  )
}

/** @deprecated Prefer RecipientSelfMenu */
export function ReceiveAddressMenu({
  choices,
  onSelect,
}: {
  choices: Array<{ index: number; address: string }>
  onSelect: (address: string) => void
}): React.JSX.Element {
  return (
    <RecipientSelfMenu
      ownAddresses={choices}
      otherWallets={[]}
      onSelectAddress={onSelect}
      resolveWalletAddress={async () => ''}
    />
  )
}

function selectionIcon(selected: boolean, partial: boolean): string {
  if (selected) return '●'
  if (partial) return '◐'
  return '○'
}

export function AddressUtxoGroupRowView({
  group,
  selected,
  partial,
  selectable,
  chain,
}: {
  group: UtxoAddressGroup
  selected: boolean
  partial: boolean
  selectable: boolean
  chain: CoinChain
}): React.JSX.Element {
  const unit = coinUnit(chain)
  const kindLabel = group.isChange ? `Change #${group.addressIndex}` : `Receive #${group.addressIndex}`
  const depositLine = formatUtxoDepositLine(group)

  return (
    <div className={`address-utxo-group-row${selected ? ' selected' : partial ? ' partial' : ''}`}>
      {selectable && (
        <span className="address-utxo-group-check" aria-hidden>
          {selectionIcon(selected, partial)}
        </span>
      )}
      <div className="address-utxo-group-body">
        <div className="address-utxo-group-amt">{coinAmountLabel(group.totalCoins, unit)}</div>
        <div className="address-utxo-group-meta">
          <span className="address-utxo-group-kind">{kindLabel}</span>
          {group.utxos.length >= 1 && (
            <span className="muted">
              · {group.utxos.length} UTXO{group.utxos.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <div className="address-utxo-group-addr mono-field">{group.address}</div>
        {depositLine && <div className="address-utxo-group-deposits mono-field">{depositLine}</div>}
      </div>
    </div>
  )
}

export function SelectedCoinsPanel({
  coins,
  unitSymbol,
  title = 'Selected UTXOs',
  subtitle,
  totalAmountLabel,
  totalFiatLabel,
}: {
  coins: UtxoDTO[]
  unitSymbol: string
  title?: string
  subtitle?: string
  /** Sum of coins actually used as inputs (not full address balances). */
  totalAmountLabel?: string | null
  totalFiatLabel?: string | null
}): React.JSX.Element {
  // Always group the spent inputs — not full address balances — so the total matches.
  const displayGroups = groupUtxosByAddress(coins)
  const inputCount = coins.length
  const defaultSubtitle = `${inputCount} UTXO${inputCount === 1 ? '' : 's'} · one transaction`

  return (
    <div className="selected-coins-panel">
      <h4 className="selected-coins-title">{title}</h4>
      <p className="muted selected-coins-subtitle">{subtitle ?? defaultSubtitle}</p>
      {displayGroups.map((group) => (
        <div key={group.id} className="selected-coins-group card">
          <div className="selected-coins-group-label">
            {group.isChange ? `Change #${group.addressIndex}` : `Receive #${group.addressIndex}`}
          </div>
          <div className="selected-coins-utxo-row">
            <span className="mono-field">{coinAmountLabel(group.totalCoins, unitSymbol)}</span>
          </div>
          {group.utxos.length >= 1 && (
            <span className="muted" style={{ fontSize: 12 }}>
              {group.utxos.length} UTXO{group.utxos.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      ))}
      {totalAmountLabel ? (
        <div className="selected-coins-total">
          <span className="selected-coins-total-label">Total amount</span>
          <span className="selected-coins-total-value mono-field">{totalAmountLabel}</span>
          {totalFiatLabel ? <span className="muted selected-coins-total-fiat">{totalFiatLabel}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

export function CoinGroupPicker({
  groups,
  selectedKeys,
  chain,
  onToggleGroup,
  onSelectAll,
  onClear,
}: {
  groups: UtxoAddressGroup[]
  selectedKeys: Set<string>
  chain: CoinChain
  onToggleGroup: (group: UtxoAddressGroup) => void
  onSelectAll: () => void
  onClear: () => void
}): React.JSX.Element {
  return (
    <div className="coin-group-picker">
      <p className="muted" style={{ fontSize: 12 }}>
        Pick which addresses to include. By default the whole wallet is used.
      </p>
      {groups.length > 1 && (
        <div className="row" style={{ marginBottom: 8, gap: 12 }}>
          <button type="button" className="btn btn-ghost link-accent" style={{ padding: '4px 0' }} onClick={onSelectAll}>
            Select all
          </button>
          <button type="button" className="btn btn-ghost muted-btn" style={{ padding: '4px 0' }} onClick={onClear}>
            Clear
          </button>
        </div>
      )}
      {groups.map((group) => (
        <button
          key={group.id}
          type="button"
          className="address-utxo-group-btn"
          onClick={() => onToggleGroup(group)}
        >
          <AddressUtxoGroupRowView
            group={group}
            selected={isGroupFullySelected(group, selectedKeys)}
            partial={isGroupPartiallySelected(group, selectedKeys)}
            selectable
            chain={chain}
          />
        </button>
      ))}
    </div>
  )
}

export function reviewCoinsSidebarSubtitle(
  summary: { usedUtxoKeys?: string[]; inputCount?: number } | null,
  sidebarCount: number,
  orderedCount: number,
  customCoinControl: boolean,
): string {
  const spentCount = summary?.usedUtxoKeys?.length ?? summary?.inputCount ?? sidebarCount
  if (customCoinControl && summary?.usedUtxoKeys?.length && spentCount < orderedCount) {
    return `${spentCount} UTXO${spentCount === 1 ? '' : 's'} spent · ${orderedCount} selected`
  }
  return `${sidebarCount} UTXO${sidebarCount === 1 ? '' : 's'} · one transaction`
}

export function reviewFeeTitle(
  summary: { requestedFeeSompi?: number },
  feeMode: 'network' | 'custom',
  totalFeeSompi: number,
): string {
  if (feeMode === 'custom') {
    const req = summary.requestedFeeSompi
    if (req != null && req > 0 && Math.abs(totalFeeSompi - req) <= 5_000) {
      return 'Network fee (custom)'
    }
    return 'Network fee'
  }
  return 'Network fee'
}
