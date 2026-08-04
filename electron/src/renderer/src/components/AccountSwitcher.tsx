import { useEffect, useMemo, useRef, useState } from 'react'
import type { WalletDTO } from '@renderer/api/types'
import { AddAccountSheet } from '@renderer/components/AddAccountSheet'
import {
  walletResolvedAccount,
  walletsSharingAccountGroup,
  walletSupportsAddAccount,
} from '@renderer/utils/walletHelpers'
import { useApp } from '@renderer/state/AppProvider'

/**
 * Sparrow-style account control: shows “Account N” on the dashboard hero.
 * Opens a menu of sibling accounts (same fingerprint) + Add Account.
 */
export function AccountSwitcher({ wallet }: { wallet: WalletDTO }): React.JSX.Element | null {
  const { wallets, activateWallet, walletBalances } = useApp()
  const [open, setOpen] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const group = useMemo(() => walletsSharingAccountGroup(wallets, wallet), [wallets, wallet])
  const account = walletResolvedAccount(wallet)
  const canAdd = walletSupportsAddAccount(wallet)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!canAdd && group.length <= 1) {
    return (
      <span className="account-switcher-static" title="BIP44 account index">
        Account {account}
      </span>
    )
  }

  return (
    <>
      <div className="account-switcher" ref={rootRef}>
        <button
          type="button"
          className={`account-switcher-trigger${open ? ' open' : ''}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          Account {account}
          <span className="account-switcher-caret" aria-hidden>
            ▾
          </span>
        </button>
        {open && (
          <div className="account-switcher-menu" role="menu">
            <div className="account-switcher-menu-label">Accounts</div>
            {group.map((w) => {
              const idx = walletResolvedAccount(w)
              const bal = walletBalances[w.id]
              const selected = w.id === wallet.id
              return (
                <button
                  key={w.id}
                  type="button"
                  role="menuitem"
                  className={`account-switcher-item${selected ? ' selected' : ''}`}
                  onClick={() => {
                    setOpen(false)
                    if (!selected) void activateWallet(w.id)
                  }}
                >
                  <span className="account-switcher-item-main">
                    <strong>Account {idx}</strong>
                    <span className="muted">{w.label}</span>
                  </span>
                  {bal && <span className="account-switcher-item-bal muted">{bal}</span>}
                </button>
              )
            })}
            {canAdd && (
              <button
                type="button"
                role="menuitem"
                className="account-switcher-item add"
                onClick={() => {
                  setOpen(false)
                  setShowAdd(true)
                }}
              >
                <strong>Add Account…</strong>
                <span className="muted">Import another BIP44 account</span>
              </button>
            )}
          </div>
        )}
      </div>
      {showAdd && (
        <AddAccountSheet
          sourceWallet={wallet}
          onClose={() => setShowAdd(false)}
          onCreated={() => setShowAdd(false)}
        />
      )}
    </>
  )
}
