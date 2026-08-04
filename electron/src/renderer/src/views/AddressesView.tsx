import { useEffect, useState } from 'react'
import { useApp } from '@renderer/state/AppProvider'
import type { AddressRowDTO, BitcoinDisplayUnit, CoinChain } from '@renderer/api/types'
import { CopyIcon } from '@renderer/components/icons'
import { copyToClipboard } from '@renderer/utils/clipboard'
import { AddressReceiveSheet } from '@renderer/components/ReceiveSheet'
import { addressRowBalance, addressRowHasBalance } from '@renderer/utils/utxoHelpers'
import { formatCoinUnitsLabel } from '@renderer/utils/coinDisplay'

function rowIsUsed(row: AddressRowDTO): boolean {
  return row.is_used ?? row.used ?? false
}

function formatLastUsed(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

export function AddressesView(): React.JSX.Element {
  const { activeWallet, activeWalletId, addressBook, utxos, mergeAddressBalances, isScanning, isRefreshing } = useApp()
  const [qrRow, setQrRow] = useState<AddressRowDTO | null>(null)
  const refreshing = activeWallet ? isRefreshing(activeWallet.id) : isScanning

  useEffect(() => {
    if (!activeWalletId) return
    void mergeAddressBalances()
  }, [activeWalletId, activeWallet?.scan_limit, utxos.map((u) => `${u.key}:${u.amount}`).join(',')])

  if (!activeWallet) return <p className="muted">No active wallet.</p>

  const book = addressBook
  const hasAddresses = book && (book.receive.length > 0 || book.change.length > 0)

  return (
    <div className="addresses-view">
      <h2 className="section-title">Addresses</h2>
      <p className="muted">Receive and change derivation paths for this watch-only wallet.</p>

      {hasAddresses ? (
        <>
          <AddressSection title="Receive" rows={book.receive} onShowQR={setQrRow} />
          <AddressSection title="Change" rows={book.change} onShowQR={setQrRow} />
        </>
      ) : refreshing ? (
        <p className="muted">Updating balances…</p>
      ) : !activeWalletId ? (
        <p className="muted">Add a watch-only wallet to see addresses.</p>
      ) : (
        <p className="muted">Loading addresses…</p>
      )}

      {qrRow && <AddressReceiveSheet row={qrRow} onClose={() => setQrRow(null)} />}
    </div>
  )
}

function AddressSection({
  title,
  rows,
  onShowQR,
}: {
  title: string
  rows: AddressRowDTO[]
  onShowQR: (row: AddressRowDTO) => void
}): React.JSX.Element {
  const { selectedChain, bitcoinDisplayUnit } = useApp()

  return (
    <div className="card sparrow-card address-section">
      <h3>{title}</h3>
      {rows.map((row) => (
        <AddressRow
          key={`${title}-${row.index}`}
          row={row}
          selectedChain={selectedChain}
          bitcoinDisplayUnit={bitcoinDisplayUnit}
          onShowQR={() => onShowQR(row)}
        />
      ))}
    </div>
  )
}

function AddressRow({
  row,
  selectedChain,
  bitcoinDisplayUnit,
  onShowQR,
}: {
  row: AddressRowDTO
  selectedChain: CoinChain
  bitcoinDisplayUnit: BitcoinDisplayUnit
  onShowQR: () => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [copied, setCopied] = useState(false)
  const hasBalance = addressRowHasBalance(row)
  const used = rowIsUsed(row)
  const balanceLabel = hasBalance
    ? formatCoinUnitsLabel(addressRowBalance(row, selectedChain), selectedChain, bitcoinDisplayUnit)
    : null
  const lastUsedAt = row.last_used_at && row.last_used_at > 0 ? row.last_used_at : 0

  async function copyAddress(): Promise<void> {
    const ok = await copyToClipboard(row.address)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div
      className={`address-row${hovered ? ' hovered' : ''}${used && !hasBalance ? ' used-empty' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button type="button" className="address-row-main" onClick={onShowQR}>
        <span className="address-index">#{row.index}</span>
        <span className="address-text">{row.address}</span>
        {balanceLabel ? (
          <span className="address-balance">{balanceLabel}</span>
        ) : used ? (
          <span className="address-used-meta">
            <span className="danger-text">Used</span>
            {lastUsedAt > 0 ? (
              <span className="muted">Last time used {formatLastUsed(lastUsedAt)}</span>
            ) : null}
          </span>
        ) : null}
      </button>

      <div className="address-row-actions">
        <button
          type="button"
          className={`address-copy-btn${copied ? ' copied' : ''}`}
          onClick={() => void copyAddress()}
        >
          {copied ? <span className="address-copied-label">Copied</span> : <CopyIcon size={14} />}
        </button>
      </div>
    </div>
  )
}
