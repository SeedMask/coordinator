import { memo, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WalletDTO } from '@renderer/api/types'
import { WalletKeystoreGlyph } from '@renderer/components/BrandMarks'
import { walletIsMultisig } from '@renderer/utils/walletHelpers'

type MenuPos = { top: number; left: number }

function ChipActionMenu({
  pos,
  items,
  onClose,
}: {
  pos: MenuPos
  items: { label: string; danger?: boolean; onSelect: () => void }[]
  onClose: () => void
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onPointer = (e: PointerEvent): void => {
      if (menuRef.current?.contains(e.target as Node)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer, true)
    }
  }, [onClose])

  return createPortal(
    <div
      className="tx-explorer-menu tx-explorer-menu-portal wallet-strip-chip-menu"
      role="menu"
      ref={menuRef}
      style={{ top: pos.top, left: pos.left }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={`tx-explorer-menu-item${item.danger ? ' danger' : ''}`}
          role="menuitem"
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}

function menuPosFromEvent(e: React.MouseEvent): MenuPos {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return { top: rect.bottom + 6, left: rect.left }
}

export const WalletStripChipView = memo(function WalletStripChipView({
  wallet,
  selected,
  scanning,
  dragging,
  balance,
  displayLabel,
  accountIndex,
  balanceHidden,
  onRename,
  onToggleBalance,
  onDelete,
  onSuppressSelect,
  onPointerDown,
}: {
  wallet: WalletDTO
  selected: boolean
  scanning: boolean
  dragging?: boolean
  balance?: string
  /** Family name when this chip represents multiple BIP44 accounts. */
  displayLabel?: string
  accountIndex?: number
  balanceHidden: boolean
  onRename: () => void
  onToggleBalance: () => void
  onDelete: () => void
  /** Cancel a pending single-click activate (used when opening the action menu). */
  onSuppressSelect?: () => void
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  const label = displayLabel?.trim() || wallet.label || 'Wallet'
  const multisig = walletIsMultisig(wallet)
  const titleExtra = accountIndex != null ? ` · Account ${accountIndex}` : ''
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null)

  function openMenu(e: React.MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    onSuppressSelect?.()
    setMenuPos(menuPosFromEvent(e))
  }

  return (
    <>
      <button
        type="button"
        className={`wallet-strip-chip${selected ? ' active' : ''}${dragging ? ' dragging' : ''}${menuPos ? ' menu-target' : ''}`}
        onContextMenu={openMenu}
        onDoubleClick={openMenu}
        onPointerDown={onPointerDown}
        title={`${label}${titleExtra} — drag to reorder · double-click for options`}
      >
        <WalletKeystoreGlyph keyCount={multisig ? 2 : 1} iconSize={24} />
        <span className={`wallet-strip-label${multisig ? ' multisig' : ''}${selected ? ' selected' : ''}`}>
          {label}
        </span>
        {accountIndex != null && accountIndex > 0 && (
          <span className="wallet-strip-account-badge">#{accountIndex}</span>
        )}
        {balance && <span className="wallet-strip-balance">{balance}</span>}
        {scanning && <span className="wallet-strip-spinner" aria-label="Scanning" />}
      </button>
      {menuPos && (
        <ChipActionMenu
          pos={menuPos}
          onClose={() => setMenuPos(null)}
          items={[
            { label: 'Rename', onSelect: onRename },
            { label: balanceHidden ? 'Show balance' : 'Hide balance', onSelect: onToggleBalance },
            { label: 'Delete', danger: true, onSelect: onDelete },
          ]}
        />
      )}
    </>
  )
})

/** In-progress “new wallet” chip — same rectangle as a real wallet, stays in the strip while drafting. */
export const DraftWalletStripChip = memo(function DraftWalletStripChip({
  label,
  selected,
  onSelect,
  onRemove,
}: {
  label: string
  selected: boolean
  onSelect: () => void
  onRemove: () => void
}): React.JSX.Element {
  const display = label.trim() || 'New wallet'
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null)

  function openMenu(e: React.MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    setMenuPos(menuPosFromEvent(e))
  }

  return (
    <>
      <button
        type="button"
        className={`wallet-strip-chip wallet-strip-chip-draft${selected ? ' active' : ''}${menuPos ? ' menu-target' : ''}`}
        onClick={onSelect}
        onContextMenu={openMenu}
        onDoubleClick={openMenu}
        title={`${display} — continue adding · double-click to remove`}
      >
        <WalletKeystoreGlyph keyCount={1} iconSize={24} />
        <span className={`wallet-strip-label${selected ? ' selected' : ''}`}>{display}</span>
      </button>
      {menuPos && (
        <ChipActionMenu
          pos={menuPos}
          onClose={() => setMenuPos(null)}
          items={[{ label: 'Remove', danger: true, onSelect: onRemove }]}
        />
      )}
    </>
  )
})
