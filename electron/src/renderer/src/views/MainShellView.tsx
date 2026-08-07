import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '@renderer/state/AppProvider'
import type { CoinChain, SidebarSection, WalletDTO } from '@renderer/api/types'
import { walletCoin } from '@renderer/api/types'
import { walletForChain, walletFamilyLabel, walletsForStrip, walletsSharingAccountGroup, walletResolvedAccount } from '@renderer/utils/walletHelpers'
import {
  orderedWalletsForChain,
  persistWalletOrder,
} from '@renderer/utils/walletOrder'
import { ChainLogoMark, SeedMaskLogoMark } from '@renderer/components/BrandMarks'
import { NavIcon } from '@renderer/components/icons'
import { ScanningPulseBar } from '@renderer/components/ScanningPulseBar'
import { WalletStrip } from '@renderer/components/WalletStrip'
import { WalletLockedPanel } from '@renderer/components/WalletLockedPanel'
import { DashboardView } from './DashboardView'
import { AddressesView } from './AddressesView'
import { UtxosView } from './UtxosView'
import { WalletSettingsView } from './WalletSettingsView'
import { SystemSettingsView } from './SystemSettingsView'
import { AddWalletView } from './AddWalletView'
import { SendWizardView } from './SendWizardView'

const NAV: { id: SidebarSection; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'addresses', label: 'Addresses' },
  { id: 'coins', label: 'Coins' },
  { id: 'walletSettings', label: 'Wallet settings' },
]

export function MainShellView(): React.JSX.Element {
  const {
    wallets,
    activeWalletId,
    activeWalletByCoin,
    selectedChain,
    setSelectedChain,
    sidebarSelection,
    setSidebarSelection,
    showSendWizard,
    dismissSendWizard,
    isAddingWallet,
    setIsAddingWallet,
    activateWallet,
    walletConfigured,
    isScanning,
    isRefreshing,
    isRefreshingChain,
    walletBalances,
    renamingWalletId,
    setRenamingWalletId,
    renameWallet,
    statusMessage,
    scanDetailMessage,
    buildLabel,
    activeSyncStatus,
    draftWalletLabel,
    setDraftWalletLabel,
    api,
    loadWallets,
    setStatusMessage,
    setShowReceiveSheet,
    lockEncryptedWallet,
    requestWalletUnlock,
    requestChangeWalletPassword,
    requestEncryptWallet,
  } = useApp()

  const [walletOrderIds, setWalletOrderIds] = useState<string[]>([])
  /** Keeps Add Wallet form mounted after "+" so switching wallets doesn't wipe WIP fields. */
  const [addWalletSession, setAddWalletSession] = useState(false)
  /** Remount Dashboard when the user re-selects it so they get the initial view. */
  const [dashboardHomeKey, setDashboardHomeKey] = useState(0)
  /** Remount System settings (back to General) when re-selected from the main sidebar. */
  const [systemSettingsHomeKey, setSystemSettingsHomeKey] = useState(0)
  const contentAreaRef = useRef<HTMLDivElement>(null)
  const prevChainRef = useRef(selectedChain)

  useEffect(() => {
    setWalletOrderIds(orderedWalletsForChain(wallets, selectedChain).map((w) => w.id))
  }, [wallets, selectedChain])

  useEffect(() => {
    if (isAddingWallet) setAddWalletSession(true)
  }, [isAddingWallet])

  useEffect(() => {
    if (prevChainRef.current === selectedChain) return
    prevChainRef.current = selectedChain
    setAddWalletSession(false)
    setDraftWalletLabel('')
  }, [selectedChain, setDraftWalletLabel])

  function endAddWalletSession(): void {
    setIsAddingWallet(false)
    setAddWalletSession(false)
    setDraftWalletLabel('')
  }

  function openAddWallet(): void {
    if (sidebarSelection === 'systemSettings') setSidebarSelection('dashboard')
    setAddWalletSession(true)
    setIsAddingWallet(true)
  }

  async function deleteStripWallet(id: string): Promise<void> {
    if (!api) return
    const wallet = wallets.find((w) => w.id === id)
    const label = wallet?.label?.trim() || 'this wallet'
    if (!window.confirm(`Delete “${label}”? This cannot be undone.`)) return
    const chain = wallet ? walletCoin(wallet) : selectedChain
    try {
      await api.deleteWallet(id)
      if (renamingWalletId === id) setRenamingWalletId(null)
      const remaining = await loadWallets()
      const firstForChain =
        orderedWalletsForChain(remaining, chain)[0] ?? remaining[0]
      if (firstForChain) {
        await activateWallet(firstForChain.id)
        setStatusMessage('Wallet removed')
      } else {
        setStatusMessage('Wallet removed — add a wallet to continue')
      }
    } catch (e) {
      setStatusMessage(e instanceof Error ? e.message : 'Remove failed')
    }
  }

  const chainWallets = useMemo(() => {
    const byId = new Map(
      wallets.filter((w) => walletCoin(w) === selectedChain).map((w) => [w.id, w]),
    )
    const ordered = walletOrderIds
      .map((id) => byId.get(id))
      .filter((w): w is WalletDTO => w != null)
    for (const wallet of Array.from(byId.values())) {
      if (!walletOrderIds.includes(wallet.id)) ordered.push(wallet)
    }
    return ordered
  }, [wallets, selectedChain, walletOrderIds])

  /** One strip chip per fingerprint family — extra BIP44 accounts live under Account N. */
  const stripWallets = useMemo(() => walletsForStrip(chainWallets), [chainWallets])
  const stripOrderIds = useMemo(() => stripWallets.map((w) => w.id), [stripWallets])

  const stripChipPresentation = useMemo(() => {
    const activeId = activeWalletByCoin[selectedChain] ?? activeWalletId ?? undefined
    const map: Record<
      string,
      {
        selected: boolean
        displayLabel: string
        accountIndex?: number
        balanceWalletId: string
        scanningWalletId: string
      }
    > = {}
    for (const anchor of stripWallets) {
      const group = walletsSharingAccountGroup(chainWallets, anchor)
      const activeMember = activeId ? group.find((w) => w.id === activeId) : undefined
      const shown = activeMember ?? anchor
      map[anchor.id] = {
        selected: Boolean(activeMember),
        displayLabel: walletFamilyLabel(anchor, group),
        accountIndex: group.length > 1 ? walletResolvedAccount(shown) : undefined,
        balanceWalletId: shown.id,
        scanningWalletId: shown.id,
      }
    }
    return map
  }, [stripWallets, chainWallets, activeWalletByCoin, activeWalletId, selectedChain])

  function applyWalletOrder(nextStripIds: string[]): void {
    const byId = new Map(chainWallets.map((w) => [w.id, w]))
    const nextFull: WalletDTO[] = []
    const seen = new Set<string>()
    for (const id of nextStripIds) {
      const seed = byId.get(id)
      if (!seed) continue
      for (const member of walletsSharingAccountGroup(chainWallets, seed)) {
        if (seen.has(member.id)) continue
        seen.add(member.id)
        nextFull.push(member)
      }
    }
    for (const wallet of chainWallets) {
      if (seen.has(wallet.id)) continue
      nextFull.push(wallet)
    }
    setWalletOrderIds(nextFull.map((w) => w.id))
    persistWalletOrder(selectedChain, nextFull)
  }

  function selectStripWallet(anchorId: string): void {
    // Pause Add Wallet UI but keep the draft mounted so the user can finish later via the draft chip.
    if (isAddingWallet) {
      setIsAddingWallet(false)
      void activateWallet(anchorId)
      return
    }
    const anchor = chainWallets.find((w) => w.id === anchorId)
    if (!anchor) {
      void activateWallet(anchorId)
      return
    }
    const group = walletsSharingAccountGroup(chainWallets, anchor)
    const activeId = activeWalletByCoin[selectedChain] ?? activeWalletId
    if (activeId && group.some((w) => w.id === activeId)) return
    void activateWallet(anchor.id)
  }

  const activeChainWallet = walletForChain(selectedChain, wallets, activeWalletByCoin, activeWalletId)
  const walletLocked = Boolean(activeChainWallet?.encrypted && !activeChainWallet.unlocked)
  const renamingWallet = renamingWalletId
    ? wallets.find((w) => w.id === renamingWalletId) ?? null
    : null

  function unlockActiveWallet(): void {
    if (!activeChainWallet) return
    void requestWalletUnlock(activeChainWallet.id, activeChainWallet)
  }

  function navigate(section: SidebarSection): void {
    // One shared gate: wallet panes stay blocked until unlock — don't switch into them.
    if (
      walletLocked &&
      (section === 'dashboard' ||
        section === 'addresses' ||
        section === 'coins' ||
        section === 'walletSettings')
    ) {
      unlockActiveWallet()
      return
    }
    if (section === 'dashboard') {
      // Sidebar stays on Dashboard during Send — re-click should return home.
      if (showSendWizard) dismissSendWizard()
      setShowReceiveSheet(false)
      if (sidebarSelection === 'dashboard' || showSendWizard) {
        setDashboardHomeKey((k) => k + 1)
        contentAreaRef.current?.scrollTo({ top: 0, left: 0 })
      }
    } else if (showSendWizard) {
      dismissSendWizard()
    }
    if (section === 'systemSettings') {
      endAddWalletSession()
      if (sidebarSelection === 'systemSettings') {
        setSystemSettingsHomeKey((k) => k + 1)
        contentAreaRef.current?.scrollTo({ top: 0, left: 0 })
      }
    }
    setSidebarSelection(section)
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <SeedMaskLogoMark size={36} />
          <strong className="sidebar-brand-title">SeedMask</strong>
        </div>
        <div className="sidebar-chain-picker">
          <ChainPicker
            value={selectedChain}
            onChange={setSelectedChain}
            isRefreshingChain={isRefreshingChain}
          />
        </div>

        {!isAddingWallet && (
          <>
            <div className="sidebar-divider" />
            <nav className="sidebar-nav">
              {NAV.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`sidebar-nav-btn${
                    !walletLocked && sidebarSelection === item.id ? ' active' : ''
                  }${walletLocked ? ' locked-gate' : ''}`}
                  onClick={() => navigate(item.id)}
                  disabled={!walletConfigured}
                  title={walletLocked ? 'Unlock wallet to open' : undefined}
                >
                  <NavIcon section={item.id} size={20} />
                  {item.label}
                </button>
              ))}
            </nav>
          </>
        )}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className={`sidebar-nav-btn sidebar-system-settings-btn${sidebarSelection === 'systemSettings' ? ' active' : ''}`}
          onClick={() => navigate('systemSettings')}
        >
          <NavIcon section="systemSettings" size={22} />
          System settings
        </button>

        <SidebarStatusFooter
          isScanning={isScanning}
          statusMessage={statusMessage}
          scanDetailMessage={scanDetailMessage}
          buildLabel={buildLabel}
          syncStatus={activeSyncStatus}
        />
      </aside>

      <div className="main-column">
        <WalletStrip
          wallets={stripWallets}
          orderIds={stripOrderIds}
          activeWalletId={activeChainWallet?.id}
          isAddingWallet={isAddingWallet}
          walletBalances={walletBalances}
          isRefreshing={isRefreshing}
          onSelect={selectStripWallet}
          onRename={setRenamingWalletId}
          onDelete={(id) => void deleteStripWallet(id)}
          onLock={(id) => void lockEncryptedWallet(id)}
          onUnlock={(id) => {
            const w = wallets.find((x) => x.id === id)
            void requestWalletUnlock(id, w)
          }}
          onChangePassword={(id) => requestChangeWalletPassword(id)}
          onEncrypt={(id) => requestEncryptWallet(id)}
          onReorder={applyWalletOrder}
          onAdd={openAddWallet}
          onSelectDraft={openAddWallet}
          onRemoveDraft={endAddWalletSession}
          isAddingWalletActive={isAddingWallet}
          showDraftWallet={addWalletSession}
          draftWalletLabel={draftWalletLabel}
          chipPresentation={stripChipPresentation}
        />

        <div
          ref={contentAreaRef}
          className={`content-area${isAddingWallet || showSendWizard || sidebarSelection === 'systemSettings' ? ' flush' : ''}`}
        >          {addWalletSession && (
            <div
              className={isAddingWallet ? 'add-wallet-session active' : 'add-wallet-session'}
              aria-hidden={!isAddingWallet}
              // Keep mounted while drafting so form fields survive switching wallets.
              style={isAddingWallet ? undefined : { display: 'none' }}
            >
              <AddWalletView
                showDeviceGuide={chainWallets.length === 0}
                onDone={endAddWalletSession}
                onCancel={chainWallets.length > 0 ? endAddWalletSession : undefined}
              />
            </div>
          )}
          {!isAddingWallet &&
            (sidebarSelection === 'systemSettings' ? (
              <SystemSettingsView key={systemSettingsHomeKey} />
            ) : walletLocked && activeChainWallet ? (
              <WalletLockedPanel
                walletLabel={activeChainWallet.label}
                onUnlock={unlockActiveWallet}
              />
            ) : showSendWizard ? (
              <SendWizardView onClose={dismissSendWizard} />
            ) : walletConfigured ? (
              <div className="kept-panes">
                <KeptPane active={sidebarSelection === 'dashboard'}>
                  <DashboardView key={dashboardHomeKey} />
                </KeptPane>
                <KeptPane active={sidebarSelection === 'addresses'}>
                  <AddressesView />
                </KeptPane>
                <KeptPane active={sidebarSelection === 'coins'}>
                  <UtxosView />
                </KeptPane>
                <KeptPane active={sidebarSelection === 'walletSettings'}>
                  <WalletSettingsView />
                </KeptPane>
              </div>
            ) : wallets.length > 0 ? (
              <div className="content-loading muted" style={{ padding: 32 }}>
                Loading wallet…
              </div>
            ) : (
              !addWalletSession && <AddWalletView showDeviceGuide onDone={endAddWalletSession} />
            ))}
        </div>
      </div>

      {renamingWallet && (
        <RenameWalletSheet
          initialName={renamingWallet.label}
          onSave={(name) => void renameWallet(renamingWallet.id, name)}
          onCancel={() => setRenamingWalletId(null)}
        />
      )}
    </div>
  )
}

function KeptPane({ active, children }: { active: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={`kept-pane${active ? ' active' : ''}`} aria-hidden={!active}>
      {children}
    </div>
  )
}

function RenameWalletSheet({
  initialName,
  onSave,
  onCancel,
}: {
  initialName: string
  onSave: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = useState(initialName)

  useEffect(() => {
    setName(initialName)
  }, [initialName])

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div className="modal-card rename-wallet-sheet elevated-card" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Rename wallet</h3>
        <input
          className="seed-mask-field"
          value={name}
          placeholder="Wallet name"
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const trimmed = name.trim()
              if (trimmed) onSave(trimmed)
            }
          }}
        />
        <div className="row spread" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-compact"
            disabled={!name.trim()}
            onClick={() => onSave(name.trim())}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function SidebarStatusFooter({
  isScanning,
  statusMessage,
  scanDetailMessage,
  buildLabel,
  syncStatus,
}: {
  isScanning: boolean
  statusMessage: string
  scanDetailMessage: string | null
  buildLabel: string
  syncStatus: import('@renderer/api/types').WalletSyncStatus | null
}): React.JSX.Element | null {
  if (!statusMessage) return null

  const live = syncStatus === 'live'
  const cached = syncStatus === 'cached' || syncStatus === 'incomplete'

  return (
    <div className={`sidebar-status-footer${isScanning ? ' scanning' : ''}`}>
      <div className="sidebar-status-footer-body">
        <div className="sidebar-status-footer-main">
          {isScanning ? (
            <span className="sidebar-scan-spinner" aria-hidden />
          ) : (
            <span
              className={`sidebar-online-dot${live ? ' live' : cached ? ' cached' : ''}`}
              aria-hidden
            />
          )}
          <div className="sidebar-status-footer-text">
            <span className={isScanning ? 'sidebar-status-primary scanning' : 'sidebar-status-primary'}>
              {statusMessage}
            </span>
            {isScanning && scanDetailMessage && (
              <span className="sidebar-status-detail">{scanDetailMessage}</span>
            )}
          </div>
        </div>
        {buildLabel && <span className="sidebar-status-build">{buildLabel}</span>}
      </div>
      {isScanning && <ScanningPulseBar />}
    </div>
  )
}

function ChainPicker({
  value,
  onChange,
  isRefreshingChain,
}: {
  value: CoinChain
  onChange: (c: CoinChain) => void
  isRefreshingChain: (chain: CoinChain) => boolean
}): React.JSX.Element {
  return (
    <div className="chain-picker-row">
      {(['kaspa', 'bitcoin'] as CoinChain[]).map((c) => {
        const active = value === c
        const chainScanning = isRefreshingChain(c)
        return (
          <button
            key={c}
            type="button"
            className={`chain-picker-tile${active ? ' active' : ''}`}
            data-chain={c}
            onClick={() => onChange(c)}
            title={`Show ${c === 'kaspa' ? 'Kaspa' : 'Bitcoin'} wallets`}
          >
            <span className="chain-picker-logo-wrap">
              <ChainLogoMark chain={c} size={38} selected={active} />
              {chainScanning && <span className="chain-picker-spinner" aria-label="Scanning" />}
            </span>
            <span className="chain-picker-label">{c === 'kaspa' ? 'Kaspa' : 'Bitcoin'}</span>
            {chainScanning && <span className="chain-picker-scan-label">Scanning…</span>}
          </button>
        )
      })}
    </div>
  )
}
