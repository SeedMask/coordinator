import { useState } from 'react'
import type { DisplayCurrency } from '@renderer/api/types'
import { groupUtxosByAddress, type UtxoAddressGroup } from '@renderer/utils/utxoHelpers'
import { reviewAddressGroupsForSpentCoins } from '@renderer/utils/buildSummary'
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

export function ReceiveAddressMenu({
  choices,
  onSelect,
}: {
  choices: Array<{ index: number; address: string }>
  onSelect: (address: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <details
      className="receive-address-menu"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Use my receive address</summary>
      <div className="receive-address-menu-list">
        {choices.slice(0, 8).map((a) => (
          <button
            key={a.address}
            type="button"
            onClick={() => {
              onSelect(a.address)
              setOpen(false)
            }}
          >
            #{a.index} {a.address}
          </button>
        ))}
      </div>
    </details>
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

export function reviewAddressGroupsForSidebar(
  spentCoins: UtxoDTO[],
  walletUtxos: UtxoDTO[],
): UtxoAddressGroup[] {
  return reviewAddressGroupsForSpentCoins(spentCoins, walletUtxos)
}

export function SelectedCoinsPanel({
  coins,
  unitSymbol,
  title = 'Selected UTXOs',
  subtitle,
  walletUtxos,
}: {
  coins: UtxoDTO[]
  unitSymbol: string
  title?: string
  subtitle?: string
  /** When set (default send), show full address balance for each address used. */
  walletUtxos?: UtxoDTO[]
}): React.JSX.Element {
  const displayGroups = walletUtxos?.length
    ? reviewAddressGroupsForSidebar(coins, walletUtxos)
    : groupUtxosByAddress(coins)
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
