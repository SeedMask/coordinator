import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '@renderer/state/AppProvider'
import { ExternalLinkIcon } from '@renderer/components/icons'
import { RbfBumpSheet } from '@renderer/components/RbfBumpSheet'
import { bitcoinTxExplorerChoices, openBitcoinExplorer, resolveBitcoinExplorerTxId, txExplorerUrl } from '@renderer/utils/blockExplorer'
import {
  formatTxAmount,
  formatTxClock,
  formatTxConfirmations,
  formatTxDate,
  txCanRbf,
  txConfirmationProgress,
  txId,
  txIsInternalTransfer,
  txIsReceived,
  txLabel,
} from '@renderer/utils/txHelpers'
import { highlightSearchMatch } from '@renderer/utils/highlightSearch'

export function TransactionRow({
  tx,
  onOpenDetails,
  searchQuery,
}: {
  tx: import('@renderer/api/types').WalletTxDTO
  /** Lifted to parent so quiet history polls / key remounts do not close Tx details. */
  onOpenDetails?: (tx: import('@renderer/api/types').WalletTxDTO) => void
  /** Active Dashboard search — matching substrings are highlighted in the row. */
  searchQuery?: string
}): React.JSX.Element {
  const {
    selectedChain,
    setTxLabel,
    networkSettings,
    setStatusMessage,
    api,
    activeWalletId,
    loadTransactions,
    addressBook,
    receiveAddresses,
    utxos,
    bitcoinDisplayUnit,
  } = useApp()
  const [labelDraft, setLabelDraft] = useState('')
  const [editingLabel, setEditingLabel] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showRbf, setShowRbf] = useState(false)
  const [showExplorerMenu, setShowExplorerMenu] = useState(false)
  const [explorerMenuPos, setExplorerMenuPos] = useState<{ top: number; left: number; openUp: boolean } | null>(
    null,
  )
  const explorerMenuRef = useRef<HTMLDivElement | null>(null)
  const explorerTriggerRef = useRef<HTMLButtonElement | null>(null)
  const resolved = txLabel(tx)
  const tid = txId(tx)
  const [displayTid, setDisplayTid] = useState(tid)
  const explorer = txExplorerUrl(displayTid || tid, selectedChain, networkSettings)
  const bitcoinExplorers =
    selectedChain === 'bitcoin'
      ? bitcoinTxExplorerChoices(displayTid || tid, networkSettings?.bitcoin)
      : []
  const confLabel = formatTxConfirmations(tx, selectedChain)
  const confProgress = txConfirmationProgress(tx, selectedChain)
  const awaitingFinality = confProgress != null
  const unconfirmed = confLabel === 'Unconfirmed'
  const fullyConfirmed = confLabel === 'Confirmed'
  const canRbf = txCanRbf(tx, selectedChain)
  const walletAddresses = useMemo(
    () =>
      new Set([
        ...receiveAddresses.map((row) => row.address),
        ...(addressBook?.receive ?? []).map((row) => row.address),
        ...(addressBook?.change ?? []).map((row) => row.address),
        ...utxos.map((utxo) => utxo.address),
      ]),
    [receiveAddresses, addressBook, utxos],
  )
  const sentToSelf = txIsInternalTransfer(tx, walletAddresses, selectedChain)
  const counterpartyPrefix = txIsReceived(tx) ? 'From' : 'To'
  const counterparty =
    tx.counterparty?.trim() || (txIsReceived(tx) ? 'External sender' : 'Recipient unavailable')

  useEffect(() => {
    setDisplayTid(tid)
    if (selectedChain !== 'bitcoin' || !tid) return
    let cancelled = false
    void resolveBitcoinExplorerTxId(tid, networkSettings?.bitcoin).then((canon) => {
      if (!cancelled && canon) setDisplayTid(canon)
    })
    return () => {
      cancelled = true
    }
  }, [tid, selectedChain, networkSettings?.bitcoin])

  useLayoutEffect(() => {
    if (!showExplorerMenu) {
      setExplorerMenuPos(null)
      return
    }
    const trigger = explorerTriggerRef.current
    if (!trigger) return
    const place = (): void => {
      const rect = trigger.getBoundingClientRect()
      const menuWidth = 200
      // Always open upward from Tx ID — rows sit near the bottom of the dashboard
      // and a downward menu gets clipped by the scroll pane / window edge.
      setExplorerMenuPos({
        top: Math.max(8, rect.top - 6),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
        openUp: true,
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [showExplorerMenu])

  useEffect(() => {
    if (!showExplorerMenu) return
    function onDocDown(e: MouseEvent): void {
      const target = e.target as Node
      if (explorerMenuRef.current?.contains(target)) return
      if (explorerTriggerRef.current?.contains(target)) return
      setShowExplorerMenu(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [showExplorerMenu])

  async function saveLabel(): Promise<void> {
    setSaving(true)
    try {
      await setTxLabel(tid, labelDraft)
      setEditingLabel(false)
    } catch (e) {
      setStatusMessage(e instanceof Error ? e.message : 'Could not save label')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="tx-row">
      {editingLabel ? (
        <div className="row tx-row-label-editor">
          <input
            className="field-input"
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            placeholder="Label"
            autoFocus
          />
          <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => void saveLabel()}>
            Save
          </button>
        </div>
      ) : (
        <div className="tx-row-label-line">
          {resolved && (
            <span className="tx-row-label">{highlightSearchMatch(resolved, searchQuery)}</span>
          )}
          <button
            type="button"
            className="tx-row-edit-label"
            onClick={() => {
              setLabelDraft(resolved)
              setEditingLabel(true)
            }}
          >
            {resolved ? 'Edit label' : 'Add label'}
          </button>
        </div>
      )}

      <div className="row spread" style={{ alignItems: 'flex-start' }}>
        <span className={`tx-row-amount${txIsReceived(tx) ? ' inflow' : ' outflow'}`}>
          {(() => {
            const full = formatTxAmount(tx, selectedChain, bitcoinDisplayUnit)
            // Never highlight unit suffixes (KAS / BTC / sats) — only the numeric amount.
            const unitMatch = full.match(/^(.*?)(\s+)(KAS|BTC|sats)$/i)
            if (!unitMatch) return highlightSearchMatch(full, searchQuery)
            const [, amountPart, space, unit] = unitMatch
            return (
              <>
                {highlightSearchMatch(amountPart ?? '', searchQuery)}
                {space}
                {unit}
              </>
            )
          })()}
        </span>
        <div className="tx-row-datetime">
          <div className="tx-row-status-date">
            <div className="tx-row-status-stack">
              {!(awaitingFinality && unconfirmed) && (
                <span className={`tx-row-confirmations${fullyConfirmed ? ' confirmed' : ' pending'}`}>
                  {confLabel}
                </span>
              )}
              {confProgress != null && (
                <div className="tx-conf-pending-row">
                  <span className="tx-conf-pending-label">Pending</span>
                  <div className="tx-conf-bars" aria-hidden>
                    {[1, 2, 3].map((n) => (
                      <span
                        key={n}
                        className={`tx-conf-bar${confProgress >= n ? ' filled' : ' waiting'}`}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
            {formatTxDate(tx) && <span className="tx-row-date">{formatTxDate(tx)}</span>}
          </div>
          {canRbf && (
            <button type="button" className="tx-row-rbf-btn" onClick={() => setShowRbf(true)}>
              RBF — Speed up
            </button>
          )}
          {formatTxClock(tx) && <span className="tx-row-time muted">{formatTxClock(tx)}</span>}
        </div>
      </div>

      <div
        className={`tx-row-counterparty${sentToSelf ? ' sent-to-self' : ''}${searchQuery?.trim() ? ' searching' : ''}`}
      >
        {sentToSelf && <strong>Sent to self</strong>}
        <span>
          {counterpartyPrefix} {highlightSearchMatch(counterparty, searchQuery)}
        </span>
      </div>

      {bitcoinExplorers.length > 0 ? (
        <div className="tx-row-explorer-wrap">
          <button
            type="button"
            className="tx-row-explorer"
            ref={explorerTriggerRef}
            aria-expanded={showExplorerMenu}
            aria-haspopup="menu"
            onClick={() => setShowExplorerMenu((open) => !open)}
          >
            <span>Tx ID</span>
            <code>{highlightSearchMatch(`${(displayTid || tid).slice(0, 16)}…`, searchQuery)}</code>
            <ExternalLinkIcon size={14} />
          </button>
          {showExplorerMenu &&
            explorerMenuPos &&
            createPortal(
              <div
                className="tx-explorer-menu tx-explorer-menu-portal"
                role="menu"
                ref={explorerMenuRef}
                style={{
                  top: explorerMenuPos.top,
                  left: explorerMenuPos.left,
                  transform: 'translateY(-100%)',
                }}
              >
                <div className="tx-explorer-menu-label">Open in</div>
                {bitcoinExplorers.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    className="tx-explorer-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setShowExplorerMenu(false)
                      void openBitcoinExplorer(choice.base, displayTid || tid, networkSettings?.bitcoin)
                    }}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>,
              document.body,
            )}
        </div>
      ) : (
        explorer && (
          <a className="tx-row-explorer" href={explorer} target="_blank" rel="noreferrer">
            <span>Tx ID</span>
            <code>{highlightSearchMatch(`${(displayTid || tid).slice(0, 16)}…`, searchQuery)}</code>
            <ExternalLinkIcon size={14} />
          </a>
        )
      )}

      {tid && api && activeWalletId && onOpenDetails && (
        <button
          type="button"
          className="tx-row-edit-label tx-row-details"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onOpenDetails(tx)
          }}
        >
          Tx details
        </button>
      )}

      {showRbf && api && activeWalletId && (
        <RbfBumpSheet
          tx={tx}
          walletId={activeWalletId}
          api={api}
          onClose={() => setShowRbf(false)}
          onBroadcast={() => {
            setShowRbf(false)
            void loadTransactions()
            setStatusMessage('RBF replacement broadcast')
          }}
        />
      )}
    </div>
  )
}
