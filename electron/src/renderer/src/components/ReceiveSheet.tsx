import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { AddressDisplay } from '@renderer/components/AddressDisplay'
import { useApp } from '@renderer/state/AppProvider'
import type { AddressRowDTO } from '@renderer/api/types'
import { addressRowBalance, addressRowHasBalance } from '@renderer/utils/utxoHelpers'
import { copyToClipboard } from '@renderer/utils/clipboard'
import { coinDisplayUnit, formatCoinUnitsLabel } from '@renderer/utils/coinDisplay'

function rowIsUsed(row: AddressRowDTO): boolean {
  return row.is_used ?? row.used ?? false
}

function nextReceiveIndex(receive: AddressRowDTO[], bookIndex?: number): number {
  if (bookIndex != null) return bookIndex
  const unused = receive.find((r) => !rowIsUsed(r))
  return unused?.index ?? receive[0]?.index ?? 0
}

export function ReceiveSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { addressBook, selectedChain, setStatusMessage, bitcoinDisplayUnit } = useApp()
  const receiveRows = addressBook?.receive ?? []
  const [selectedIndex, setSelectedIndex] = useState(() =>
    nextReceiveIndex(receiveRows, addressBook?.next_receive_index),
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  const selectedRow = receiveRows.find((r) => r.index === selectedIndex)
  const selectedAddress =
    selectedRow?.address ?? addressBook?.next_receive_address ?? receiveRows[0]?.address ?? ''
  const unit = coinDisplayUnit(selectedChain, bitcoinDisplayUnit)

  useEffect(() => {
    const idx = nextReceiveIndex(receiveRows, addressBook?.next_receive_index)
    if (!receiveRows.some((r) => r.index === selectedIndex)) {
      setSelectedIndex(idx)
    }
  }, [addressBook?.next_receive_index, receiveRows, selectedIndex])

  useEffect(() => {
    if (!selectedAddress) {
      setQrDataUrl(null)
      return
    }
    let cancelled = false
    void QRCode.toDataURL(selectedAddress, {
      width: 300,
      margin: 1,
      errorCorrectionLevel: 'M',
    }).then((url) => {
      if (!cancelled) setQrDataUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [selectedAddress])

  const statusBlock = useMemo(() => {
    if (!selectedRow) return null
    const balance = addressRowHasBalance(selectedRow)
      ? formatCoinUnitsLabel(addressRowBalance(selectedRow, selectedChain), selectedChain, bitcoinDisplayUnit)
      : null
    if (balance) {
      return <span className="muted">{balance}</span>
    }
    if (rowIsUsed(selectedRow)) {
      if (selectedRow.last_used_at && selectedRow.last_used_at > 0) {
        const date = new Date(selectedRow.last_used_at * 1000).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })
        return (
          <span>
            <span className="danger-text">Last time used:</span> <span className="muted">{date}.</span>
          </span>
        )
      }
      return <span className="danger-text">Used</span>
    }
    return <span className="muted">Unused</span>
  }, [selectedRow, selectedChain, bitcoinDisplayUnit])

  async function copyAddress(): Promise<void> {
    if (!selectedAddress) return
    const ok = await copyToClipboard(selectedAddress)
    setStatusMessage(ok ? `Copied receive address #${selectedIndex}` : 'Copy failed')
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-sheet receive-sheet" onClick={(e) => e.stopPropagation()}>
        <h2 className="receive-title">Receive {unit}</h2>

        <div className="receive-picker-row">
          <span className="receive-address-label">Address</span>
          <div className="receive-picker-wrap">
            <button type="button" className="receive-picker-btn" onClick={() => setPickerOpen((v) => !v)}>
              <span className="receive-picker-item-main">
                <span className="receive-picker-index">#{selectedIndex}</span>
                {selectedRow && rowIsUsed(selectedRow) && <span className="danger-text">Used</span>}
              </span>
              <span className="receive-chevron">⌄</span>
            </button>
            {pickerOpen && (
              <div className="receive-picker-menu">
                {receiveRows.map((row) => (
                  <button
                    key={row.index}
                    type="button"
                    className={`receive-picker-item${row.index === selectedIndex ? ' active' : ''}`}
                    onClick={() => {
                      setSelectedIndex(row.index)
                      setPickerOpen(false)
                    }}
                  >
                    <span className="receive-picker-item-main">
                      <span className="receive-picker-index">#{row.index}</span>
                      {addressRowHasBalance(row) && (
                        <span className="muted receive-picker-balance">
                          {formatCoinUnitsLabel(addressRowBalance(row, selectedChain), selectedChain, bitcoinDisplayUnit)}
                        </span>
                      )}
                      {rowIsUsed(row) && <span className="danger-text">Used</span>}
                    </span>
                    {row.index === selectedIndex && <span className="accent-text">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="receive-status">{statusBlock}</div>

        {qrDataUrl && (
          <img src={qrDataUrl} alt="Receive address QR code" className="receive-qr" width={300} height={300} />
        )}

        <code className="receive-address">
          <AddressDisplay address={selectedAddress} />
        </code>

        <div className="receive-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void copyAddress()}>
            Copy address
          </button>
          <button type="button" className="btn btn-primary btn-compact" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

export function AddressReceiveSheet({
  row,
  onClose,
}: {
  row: AddressRowDTO
  onClose: () => void
}): React.JSX.Element {
  const { selectedChain, setStatusMessage, bitcoinDisplayUnit } = useApp()
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const pathLabel = row.is_change ? 'Change' : 'Receive'
  const balance = addressRowHasBalance(row) ? addressRowBalance(row, selectedChain) : null
  const detail =
    balance != null
      ? `Address #${row.index} · ${pathLabel} · ${formatCoinUnitsLabel(balance, selectedChain, bitcoinDisplayUnit)}`
      : `Address #${row.index} · ${pathLabel}`

  useEffect(() => {
    void QRCode.toDataURL(row.address, { width: 280, margin: 1 }).then(setQrDataUrl)
  }, [row.address])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-sheet receive-sheet" onClick={(e) => e.stopPropagation()}>
        <h2 className="receive-title">Receive</h2>
        <p className="muted" style={{ textAlign: 'center' }}>
          {detail}
        </p>
        {qrDataUrl && <img src={qrDataUrl} alt="Address QR code" className="receive-qr" width={280} height={280} />}
        <code className="receive-address">
          <AddressDisplay address={row.address} />
        </code>
        <div className="receive-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              void copyToClipboard(row.address).then((ok) => {
                setStatusMessage(ok ? `Copied address #${row.index}` : 'Copy failed')
              })
            }}
          >
            Copy address
          </button>
          <button type="button" className="btn btn-primary btn-compact" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
