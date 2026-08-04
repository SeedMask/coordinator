import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { APIClient, APIError, createAPIClient } from '@renderer/api/client'
import type {
  AddressBookResponse,
  AddressDTO,
  AppTheme,
  BalanceResponse,
  BitcoinDisplayUnit,
  BitcoinNetworkSettingsDTO,
  CoinChain,
  DisplayCurrency,
  NetworkSettingsDTO,
  NetworkSettingsEnvelope,
  SidebarSection,
  UtxoDTO,
  WalletDTO,
  WalletTxDTO,
} from '@renderer/api/types'
import { formatBalance, normalizeUtxo, parseBalanceResponse, utxoMatchesChain, walletCoin } from '@renderer/api/types'
import { dedupeWalletTransactions, filterTransactionsForChain, kaspaNeedsLiveConfirmations, normalizeTxId, normalizeWalletTx, txBlockTime, txId } from '@renderer/utils/txHelpers'
import { prefetchWalletTxVisualize } from '@renderer/utils/txVisualizeCache'
import { walletForChain } from '@renderer/utils/walletHelpers'
import { WalletEventStream } from '@renderer/services/walletEventStream'
import { fiatPriceService } from '@renderer/services/fiatPriceService'
import { formatCoinFiat } from '@renderer/utils/fiatFormat'
import { mergeAddressBookWithUtxos } from '@renderer/utils/utxoHelpers'
import { normalizeOutpointKey } from '@renderer/utils/sendAmount'
import { startupError, apiError } from '@renderer/utils/userErrors'
import { appBuildLabel } from '@renderer/utils/appVersion'
import { UserPrefs } from '@renderer/utils/userPrefs'
import { emptySnapshot, loadPersistedSnapshots, persistSnapshotsToDisk, withoutBalances } from '@renderer/state/walletSnapshotStore'
import type { WalletSnapshot } from '@renderer/api/types'
import type { WalletStateResponse, WalletSyncStatus } from '@renderer/api/types'

function balanceResponseMatchesChain(bal: BalanceResponse, chain: CoinChain): boolean {
  const coin = (bal.coin || '').trim().toLowerCase()
  if (!coin || coin !== chain) return false
  if (bal.utxos.length === 0) return true
  const matched = bal.utxos.filter((u) => utxoMatchesChain(u, chain))
  return matched.length === bal.utxos.length
}

function balanceResponseMatchesWallet(
  bal: BalanceResponse,
  walletId: string,
  chain: CoinChain,
  wallets: WalletDTO[],
): boolean {
  const wallet = wallets.find((w) => w.id === walletId)
  if (wallet && walletCoin(wallet) !== chain) return false
  const responseWalletId = (bal.wallet_id || '').trim()
  if (responseWalletId && responseWalletId !== walletId) return false
  const coin = (bal.coin || '').trim().toLowerCase()
  if (coin && coin !== chain) return false
  return balanceResponseMatchesChain(bal, chain)
}

function snapshotDisplayKas(snap: WalletSnapshot, chain: CoinChain): number {
  const localUtxos = snap.utxos.filter((u) => utxoMatchesChain(u, chain))
  const utxoSompi = localUtxos.reduce((sum, u) => sum + u.amount, 0)
  if (utxoSompi > 0) return utxoSompi / 1e8
  if (snap.coin && snap.coin !== chain) return 0
  return 0
}

function snapshotDisplaySompi(snap: WalletSnapshot, chain: CoinChain): number {
  const localUtxos = snap.utxos.filter((u) => utxoMatchesChain(u, chain))
  const utxoSompi = localUtxos.reduce((sum, u) => sum + u.amount, 0)
  if (utxoSompi > 0) return utxoSompi
  return Math.round(snapshotDisplayKas(snap, chain) * 1e8)
}

interface AppContextValue {
  ready: boolean
  walletsBootstrapped: boolean
  error: string | null
  api: APIClient | null
  buildLabel: string
  statusMessage: string
  setStatusMessage: (msg: string) => void
  wallets: WalletDTO[]
  activeWallet: WalletDTO | null
  activeWalletId: string | null
  activeWalletByCoin: Record<string, string>
  walletConfigured: boolean
  walletLabel: string
  walletBalances: Record<string, string>
  selectedChain: CoinChain
  setSelectedChain: (c: CoinChain) => void
  selectWallet: (id: string) => void
  sidebarSelection: SidebarSection
  setSidebarSelection: (s: SidebarSection) => void
  showSendWizard: boolean
  presentSend: (fromCoins?: boolean) => void
  openSendWizard: (fromCoins?: boolean) => void
  closeSendWizard: () => void
  dismissSendWizard: () => void
  isAddingWallet: boolean
  setIsAddingWallet: (v: boolean) => void
  showWelcome: boolean
  markWelcomeSeen: () => void
  showReceiveSheet: boolean
  setShowReceiveSheet: (v: boolean) => void
  utxos: UtxoDTO[]
  selectedSpendUtxoKeys: Set<string>
  sendUsesCustomCoinSelection: boolean
  setSendUsesCustomCoinSelection: (value: boolean) => void
  sendOpenedFromCoins: boolean
  toggleSpendUtxo: (key: string) => void
  selectAllSpendableUtxos: () => void
  clearSpendSelection: () => void
  pruneSpendSelection: (validKeys?: Set<string>) => void
  isCustomSpendSelection: () => boolean
  selectedSpendUtxos: () => UtxoDTO[]
  /** Synchronous spend selection (matches Swift @Published immediate updates after selectAll). */
  orderedSelectedSpendUtxos: () => UtxoDTO[]
  selectedSpendKeyCountSync: () => number
  coinsPaneResetID: string
  transactions: WalletTxDTO[]
  addressBook: AddressBookResponse | null
  receiveAddresses: AddressDTO[]
  balanceSompi: number
  balanceKasValue: number
  balanceText: string
  balanceFiatText: string | null
  isScanning: boolean
  scanDetailMessage: string | null
  isRefreshing: (walletId?: string) => boolean
  isRefreshingChain: (chain: CoinChain) => boolean
  refreshingWalletIds: Set<string>
  appTheme: AppTheme
  setAppTheme: (t: AppTheme) => void
  displayCurrency: DisplayCurrency
  setDisplayCurrency: (c: DisplayCurrency) => void
  chunkAddresses: boolean
  setChunkAddresses: (v: boolean) => void
  bitcoinDisplayUnit: BitcoinDisplayUnit
  setBitcoinDisplayUnit: (u: BitcoinDisplayUnit) => void
  fiatTick: number
  networkSettingsEnvelope: NetworkSettingsEnvelope | null
  networkSettings: NetworkSettingsDTO | null
  networkSettingsSaving: boolean
  loadWallets: () => Promise<WalletDTO[]>
  reloadStatus: () => Promise<void>
  activateWallet: (id: string, hint?: WalletDTO) => Promise<void>
  refreshActiveWallet: () => Promise<void>
  refreshAfterSuccessfulSend: () => Promise<void>
  /** Insert a just-broadcast send at the top of the list immediately (before indexer catch-up). */
  notePendingSend: (tx: {
    transaction_id: string
    amount_kas?: number
    amount_btc?: number
    counterparty?: string
    fee_sompi?: number
  }) => void
  refreshWallet: () => Promise<void>
  refreshAllWallets: (forceFull?: boolean) => Promise<void>
  pollActiveWalletIfIdle: () => Promise<void>
  loadTransactions: (query?: string, opts?: { refresh?: boolean }) => Promise<void>
  /** Quiet ~1s Kaspa confirmation refresh while counts are still settling. */
  refreshKaspaConfirmations: () => Promise<void>
  loadNetworkSettings: () => Promise<void>
  persistNetworkSettings: (s: NetworkSettingsDTO) => Promise<void>
  testBitcoinConnection: (b: BitcoinNetworkSettingsDTO) => Promise<import('@renderer/api/types').BitcoinConnectionTestResponse>
  refreshFiatPrices: () => Promise<void>
  mergeAddressBalances: () => Promise<void>
  persistWalletScanLimit: (limit: number) => Promise<void>
  toggleAddressGroup: (keys: string[]) => void
  setTxLabel: (txid: string, label: string) => Promise<void>
  renamingWalletId: string | null
  setRenamingWalletId: (id: string | null) => void
  draftWalletLabel: string
  setDraftWalletLabel: (s: string) => void
  renameWallet: (id: string, label: string) => Promise<void>
  applyLocalWalletLabel: (id: string, label: string) => void
  beginAddWallet: () => void
  discoverWallet: (walletId: string, wait?: boolean) => Promise<void>
  syncStatusByWallet: Record<string, import('@renderer/api/types').WalletSyncStatus>
  activeSyncStatus: import('@renderer/api/types').WalletSyncStatus | null
}

export type WalletSyncMode = 'hot' | 'discover' | 'deep'

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const [walletsBootstrapped, setWalletsBootstrapped] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [api, setApi] = useState<APIClient | null>(null)
  const [buildLabel] = useState(() => appBuildLabel())
  const [statusMessage, setStatusMessage] = useState('Starting…')
  const [wallets, setWallets] = useState<WalletDTO[]>([])
  const [activeWalletId, setActiveWalletId] = useState<string | null>(null)
  const [activeWalletByCoin, setActiveWalletByCoin] = useState<Record<string, string>>({})
  const [walletBalances, setWalletBalances] = useState<Record<string, string>>({})
  const [selectedChain, setSelectedChainState] = useState<CoinChain>(() => UserPrefs.selectedChain)
  const [sidebarSelection, setSidebarSelection] = useState<SidebarSection>('dashboard')
  const [showSendWizard, setShowSendWizard] = useState(false)
  const [sendUsesCustomCoinSelection, setSendUsesCustomCoinSelection] = useState(false)
  const [sendOpenedFromCoins, setSendOpenedFromCoins] = useState(false)
  const [isAddingWallet, setIsAddingWallet] = useState(false)
  const [showWelcome, setShowWelcome] = useState(() => !UserPrefs.hasSeenWelcome)
  const [showReceiveSheet, setShowReceiveSheet] = useState(false)
  const [utxos, setUtxos] = useState<UtxoDTO[]>([])
  const [selectedSpendUtxoKeys, setSelectedSpendUtxoKeys] = useState<Set<string>>(new Set())
  const [coinsPaneResetID, setCoinsPaneResetID] = useState(() => crypto.randomUUID())
  const [transactions, setTransactions] = useState<WalletTxDTO[]>([])
  const [addressBook, setAddressBook] = useState<AddressBookResponse | null>(null)
  const [receiveAddresses, setReceiveAddresses] = useState<AddressDTO[]>([])
  const [balanceKasValue, setBalanceKasValue] = useState(0)
  const [mainnetFullScanIds, setMainnetFullScanIds] = useState<Set<string>>(new Set())
  const [refreshingWalletIds, setRefreshingWalletIds] = useState<Set<string>>(new Set())
  const [pollingWalletIds, setPollingWalletIds] = useState<Set<string>>(new Set())
  const [liveStreamWalletIds, setLiveStreamWalletIds] = useState<Set<string>>(new Set())
  const [pushStreamActive, setPushStreamActive] = useState(false)
  const [appTheme, setAppThemeState] = useState<AppTheme>(() => UserPrefs.appTheme)
  const [displayCurrency, setDisplayCurrencyState] = useState<DisplayCurrency>(() => UserPrefs.displayCurrency)
  const [chunkAddresses, setChunkAddressesState] = useState(() => UserPrefs.chunkAddresses)
  const [bitcoinDisplayUnit, setBitcoinDisplayUnitState] = useState(() => UserPrefs.bitcoinDisplayUnit)
  const [networkSettingsEnvelope, setNetworkSettingsEnvelope] = useState<NetworkSettingsEnvelope | null>(null)
  const [networkSettingsSaving, setNetworkSettingsSaving] = useState(false)
  const [renamingWalletId, setRenamingWalletId] = useState<string | null>(null)
  const [draftWalletLabel, setDraftWalletLabel] = useState('')
  const [fiatTick, setFiatTick] = useState(0)
  const [scanDetailMessage, setScanDetailMessage] = useState<string | null>(null)
  const [syncStatusByWallet, setSyncStatusByWallet] = useState<Record<string, WalletSyncStatus>>({})

  const snapshotsRef = useRef<Record<string, WalletSnapshot>>(loadPersistedSnapshots())
  const persistSnapshotsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const addressBooksRef = useRef<Record<string, AddressBookResponse>>({})
  const operationGenRef = useRef(0)
  /** Per-wallet history load generation — drop stale overlapping responses. */
  const txLoadGenRef = useRef<Record<string, number>>({})
  const eventStreamsRef = useRef<Map<string, WalletEventStream>>(new Map())
  const liveStreamWalletsRef = useRef<Set<string>>(new Set())
  const didStartupScanRef = useRef(false)
  const startupScanInProgressRef = useRef(false)
  const sessionMainnetSyncedRef = useRef<Set<string>>(new Set())
  const networkWasOfflineRef = useRef(!navigator.onLine)
  const apiRef = useRef<APIClient | null>(null)
  const selectedChainRef = useRef(selectedChain)
  const activeWalletIdRef = useRef(activeWalletId)
  const balanceKasValueRef = useRef(balanceKasValue)
  const showWelcomeRef = useRef(showWelcome)
  const bootstrappedRef = useRef(false)
  const walletsRef = useRef(wallets)
  const activeWalletByCoinRef = useRef(activeWalletByCoin)
  const utxosRef = useRef<UtxoDTO[]>([])
  const selectedSpendUtxoKeysRef = useRef<Set<string>>(new Set())
  const refreshingWalletIdsRef = useRef<Set<string>>(new Set())
  const mainnetFullScanIdsRef = useRef<Set<string>>(new Set())
  const pollingWalletIdsRef = useRef<Set<string>>(new Set())
  const syncStatusByWalletRef = useRef(syncStatusByWallet)
  const syncStartedAtRef = useRef<Record<string, number>>({})
  const kaspaNetworkTipRef = useRef<{ tip: number; atMs: number } | null>(null)
  const kaspaPaintTipRef = useRef<{ tip: number; atMs: number } | null>(null)
  const kaspaTipInFlightRef = useRef(false)
  const kaspaTipSeqRef = useRef(0)
  const kaspaLastConfBumpAtRef = useRef(0)
  apiRef.current = api
  selectedChainRef.current = selectedChain
  activeWalletIdRef.current = activeWalletId
  balanceKasValueRef.current = balanceKasValue
  showWelcomeRef.current = showWelcome
  walletsRef.current = wallets
  activeWalletByCoinRef.current = activeWalletByCoin
  utxosRef.current = utxos
  selectedSpendUtxoKeysRef.current = selectedSpendUtxoKeys
  syncStatusByWalletRef.current = syncStatusByWallet

  const activeWallet = useMemo(
    () => walletForChain(selectedChain, wallets, activeWalletByCoin, activeWalletId) ?? null,
    [wallets, activeWalletId, activeWalletByCoin, selectedChain],
  )

  const balanceText = useMemo(() => {
    const chain = activeWallet ? walletCoin(activeWallet) : selectedChain
    return formatBalance(Math.round(balanceKasValue * 1e8), chain)
  }, [balanceKasValue, activeWallet, selectedChain])
  const balanceSompi = useMemo(() => Math.round(balanceKasValue * 1e8), [balanceKasValue])

  const walletConfigured = activeWallet != null
  const walletLabel = activeWallet?.label ?? 'SeedMask'
  const networkSettings = networkSettingsEnvelope?.settings ?? null
  const isScanning = useMemo(
    () =>
      wallets.some(
        (w) => walletCoin(w) === selectedChain && mainnetFullScanIds.has(w.id),
      ),
    [wallets, selectedChain, mainnetFullScanIds],
  )

  const activeSyncStatus = useMemo((): WalletSyncStatus | null => {
    if (!activeWallet) return null
    const raw = syncStatusByWallet[activeWallet.id] ?? activeWallet.sync_status ?? 'cached'
    return visibleSyncStatus(activeWallet.id, raw)
  }, [activeWallet, syncStatusByWallet])

  const balanceFiatText = useMemo(() => {
    void fiatTick
    if (balanceKasValue <= 0 || !activeWallet) return null
    const fiatChain = walletCoin(activeWallet)
    const unit = fiatPriceService.price(fiatChain, displayCurrency)
    if (unit == null) return null
    return formatCoinFiat(balanceKasValue, unit, displayCurrency)
  }, [balanceKasValue, activeWallet, displayCurrency, fiatTick])

  const setAppTheme = useCallback((t: AppTheme) => {
    setAppThemeState(t)
    UserPrefs.appTheme = t
    document.documentElement.dataset.theme = t
  }, [])

  const setDisplayCurrency = useCallback((c: DisplayCurrency) => {
    setDisplayCurrencyState(c)
    UserPrefs.displayCurrency = c
  }, [])

  const setChunkAddresses = useCallback((v: boolean) => {
    setChunkAddressesState(v)
    UserPrefs.chunkAddresses = v
  }, [])

  const setBitcoinDisplayUnit = useCallback((u: BitcoinDisplayUnit) => {
    setBitcoinDisplayUnitState(u)
    UserPrefs.bitcoinDisplayUnit = u
  }, [])

  function schedulePersistSnapshots(): void {
    if (persistSnapshotsTimerRef.current) clearTimeout(persistSnapshotsTimerRef.current)
    persistSnapshotsTimerRef.current = setTimeout(() => {
      persistSnapshotsToDisk(snapshotsRef.current)
    }, 400)
  }

  function touchSnapshot(_walletId: string): void {
    schedulePersistSnapshots()
  }

  function walletForChainRef(chain: CoinChain = selectedChainRef.current): WalletDTO | undefined {
    return walletForChain(
      chain,
      walletsRef.current,
      activeWalletByCoinRef.current,
      activeWalletIdRef.current,
    )
  }

  function syncActiveWalletForChain(chain: CoinChain = selectedChainRef.current): string | null {
    const wallet = walletForChainRef(chain)
    if (!wallet) return null
    if (activeWalletIdRef.current !== wallet.id) {
      activeWalletIdRef.current = wallet.id
      setActiveWalletId(wallet.id)
    }
    return wallet.id
  }

  function sanitizeSnapshotForWallet(walletId: string, chain: CoinChain): void {
    const snap = snapshotsRef.current[walletId]
    if (!snap) return
    const chainUtxos = snap.utxos.filter((u) => utxoMatchesChain(u, chain))
    const seenKeys = new Set<string>()
    const deduped: typeof chainUtxos = []
    for (const u of chainUtxos) {
      const key = u.key || `${u.transaction_id}:${u.output_index}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      deduped.push(u)
    }
    snap.utxos = deduped
    const utxoSompi = deduped.reduce((sum, u) => sum + u.amount, 0)
    if (snap.coin && snap.coin !== chain) {
      snap.mainnetSynced = false
      snap.transactions = filterTransactionsForChain(snap.transactions.map(normalizeWalletTx), chain)
    }
    if (utxoSompi > 0) {
      snap.balanceValue = utxoSompi / 1e8
      snap.balanceText = formatBalance(utxoSompi, chain)
    } else {
      snap.balanceValue = 0
      snap.balanceText = formatBalance(0, chain)
    }
    snap.coin = chain
    snapshotsRef.current[walletId] = snap
  }

  function setWalletSyncStatus(
    walletId: string,
    status: WalletSyncStatus,
    opts?: { force?: boolean },
  ): void {
    const prev = syncStatusByWalletRef.current[walletId]
    // Ignore brief hot-refresh syncing pulses when already live (prevents Live↔Syncing flicker).
    if (status === 'syncing' && prev === 'live' && !opts?.force) {
      return
    }
    if (status === 'syncing') {
      syncStartedAtRef.current[walletId] = Date.now()
    } else {
      delete syncStartedAtRef.current[walletId]
    }
    if (prev === status) {
      if (isViewingWallet(walletId)) updateScanStatusMessage()
      return
    }
    setSyncStatusByWallet((prevMap) => {
      const next = { ...prevMap, [walletId]: status }
      syncStatusByWalletRef.current = next
      return next
    })
    if (isViewingWallet(walletId)) {
      updateScanStatusMessage()
    }
  }

  function visibleSyncStatus(walletId: string, status: WalletSyncStatus): WalletSyncStatus {
    if (status !== 'syncing') return status
    const started = syncStartedAtRef.current[walletId] ?? 0
    if (!started || Date.now() - started > 20_000) {
      const snap = snapshotsRef.current[walletId]
      return snap?.mainnetSynced ? 'live' : 'cached'
    }
    return status
  }

  function applyWalletState(state: WalletStateResponse, publishUi = true): void {
    const walletId = state.wallet_id
    const wallet = walletsRef.current.find((w) => w.id === walletId)
    const chain = wallet ? walletCoin(wallet) : (state.coin as CoinChain)
    if (!walletRecordMatchesChain(walletId, chain)) return
    const filteredUtxos = state.utxos
      .filter((u) => utxoMatchesChain(u, chain))
      .map((u) => normalizeUtxo(u as unknown as Record<string, unknown>))
    const sompi = filteredUtxos.reduce((sum, u) => sum + u.amount, 0)
    const kas = sompi / 1e8
    const snap = snapshotsRef.current[walletId] ?? emptySnapshot()
    snap.balanceValue = kas
    snap.balanceText = formatBalance(sompi, chain)
    snap.utxos = filteredUtxos
    snap.coin = chain
    snap.mainnetSynced = state.sync_status === 'live'
    if (state.transactions?.length) {
      snap.transactions = state.transactions.map(normalizeWalletTx)
    }
    snapshotsRef.current[walletId] = snap
    publishWalletBalanceLabel(walletId, chain, sompi)
    setWalletSyncStatus(walletId, state.sync_status)
    schedulePersistSnapshots()
    if (!publishUi || !isViewingWallet(walletId)) return
    publishBalanceToUi(walletId, chain, kas)
    setUtxos(filteredUtxos)
    if (state.transactions?.length) {
      setTransactions(snapshotTransactionsForWallet(walletId, chain))
    }
    pruneSpendSelection(new Set(filteredUtxos.map((u) => u.key)))
  }

  async function loadWalletStateFromBackend(walletId: string, publishUi = true): Promise<void> {
    const client = apiRef.current
    if (!client) return
    try {
      const state = await client.walletState(walletId)
      applyWalletState(state, publishUi)
    } catch {
      restoreSnapshot(walletId, walletChainForId(walletId, selectedChainRef.current))
    }
  }

  async function requestBackgroundSync(
    walletId: string,
    mode: WalletSyncMode = 'hot',
    wait = false,
    opts?: { userInitiated?: boolean },
  ): Promise<void> {
    const client = apiRef.current
    if (!client) return
    const chain = walletChainForId(walletId, selectedChainRef.current)
    const prev = syncStatusByWalletRef.current[walletId] ?? 'cached'
    const userInitiated = opts?.userInitiated === true
    // Background hot refresh while already live stays quiet (avoids Live↔Syncing flicker).
    // User-initiated Refresh must always show progress / failure.
    const quietHot =
      !userInitiated && mode === 'hot' && (prev === 'live' || visibleSyncStatus(walletId, prev) === 'live')
    if (!quietHot) {
      setWalletSyncStatus(walletId, 'syncing', { force: true })
    }
    if (userInitiated && isViewingWallet(walletId)) {
      const next = new Set(refreshingWalletIdsRef.current).add(walletId)
      refreshingWalletIdsRef.current = next
      setRefreshingWalletIds(next)
      setStatusMessage(chain === 'kaspa' ? 'Refreshing Kaspa…' : 'Refreshing Bitcoin…')
    }
    let failed = false
    try {
      const result = await client.requestSync(walletId, mode, wait)
      if (wait && result && 'balance_sompi' in result) {
        await loadWalletStateFromBackend(walletId, isViewingWallet(walletId))
      } else if (!wait) {
        window.setTimeout(() => {
          void loadWalletStateFromBackend(walletId, isViewingWallet(walletId))
        }, 2500)
      }
    } catch {
      failed = true
      if (isViewingWallet(walletId)) {
        setStatusMessage('Sync failed · showing cached balance')
        setWalletSyncStatus(walletId, 'cached')
      }
    } finally {
      if (userInitiated) {
        const next = new Set(refreshingWalletIdsRef.current)
        next.delete(walletId)
        refreshingWalletIdsRef.current = next
        setRefreshingWalletIds(next)
      }
      if (!wait) return
      if (failed) {
        // Keep cached / failure status — do not restore Live after a failed user refresh.
        updateScanStatusMessage()
        return
      }
      const snap = snapshotsRef.current[walletId]
      const status: WalletSyncStatus = snap?.mainnetSynced
        ? 'live'
        : syncStatusByWalletRef.current[walletId] === 'incomplete'
          ? 'incomplete'
          : 'cached'
      setWalletSyncStatus(walletId, status)
      updateScanStatusMessage()
    }
  }

  function isViewingWallet(walletId: string): boolean {
    const wallet = walletsRef.current.find((w) => w.id === walletId)
    if (!wallet) return false
    const chain = selectedChainRef.current
    if (walletCoin(wallet) !== chain) return false
    return walletForChainRef(chain)?.id === walletId
  }

  function snapshotTransactionsForWallet(walletId: string, chain: CoinChain): WalletTxDTO[] {
    const snap = snapshotsRef.current[walletId] ?? emptySnapshot()
    return dedupeWalletTransactions(snap.transactions.map(normalizeWalletTx), chain)
  }

  function walletChainForId(walletId: string, fallback: CoinChain): CoinChain {
    const wallet = walletsRef.current.find((w) => w.id === walletId)
    return wallet ? walletCoin(wallet) : fallback
  }

  function shouldPublishWalletUi(walletId: string): boolean {
    return isViewingWallet(walletId)
  }

  function publishSnapshotToUi(walletId: string): void {
    if (!shouldPublishWalletUi(walletId)) return
    const wallet = walletsRef.current.find((w) => w.id === walletId)
    const chain = wallet ? walletCoin(wallet) : selectedChainRef.current
    const snap = snapshotsRef.current[walletId] ?? emptySnapshot()
    publishBalanceToUi(walletId, chain, snapshotDisplayKas(snap, chain))
    setUtxos(
      snap.utxos
        .filter((u) => utxoMatchesChain(u, chain))
        .map((u) => normalizeUtxo(u as unknown as Record<string, unknown>)),
    )
    setTransactions(snapshotTransactionsForWallet(walletId, chain))
    const book = addressBooksRef.current[walletId] ?? snap.addressBook
    if (book) {
      setAddressBook(book)
      setReceiveAddresses(book.receive.map((r) => ({ index: r.index, address: r.address })))
    }
  }

  function persistActiveSnapshot(): void {
    if (!activeWalletId) return
    const wallet = walletsRef.current.find((w) => w.id === activeWalletId)
    const chain = wallet ? walletCoin(wallet) : selectedChainRef.current
    const snap = snapshotsRef.current[activeWalletId] ?? emptySnapshot()
    const chainUtxos = utxos.filter((u) => utxoMatchesChain(u, chain))
    const utxoSompi = chainUtxos.reduce((sum, u) => sum + u.amount, 0)
    if (chainUtxos.length > 0) {
      snap.balanceValue = utxoSompi / 1e8
      snap.balanceText = formatBalance(utxoSompi, chain)
    } else {
      snap.balanceValue = 0
      snap.balanceText = formatBalance(0, chain)
    }
    snap.coin = chain
    snap.utxos = chainUtxos
    snap.transactions = filterTransactionsForChain(transactions, chain)
    snap.receiveAddresses = receiveAddresses
    const book = addressBooksRef.current[activeWalletId] ?? addressBook
    snap.addressBook = book ? withoutBalances(book) : null
    snapshotsRef.current[activeWalletId] = snap
    schedulePersistSnapshots()
  }

  function publishAddressBook(walletId: string, book: AddressBookResponse | null): void {
    if (!book) {
      if (walletId === activeWalletIdRef.current) setAddressBook(null)
      return
    }
    addressBooksRef.current[walletId] = book
    if (walletId === activeWalletIdRef.current) {
      setAddressBook(book)
      setReceiveAddresses(book.receive.map((r) => ({ index: r.index, address: r.address })))
    }
    const snap = snapshotsRef.current[walletId] ?? emptySnapshot()
    snap.addressBook = withoutBalances(book)
    snapshotsRef.current[walletId] = snap
    schedulePersistSnapshots()
  }

  function restoreSnapshot(walletId: string, chain: CoinChain): void {
    if (!walletRecordMatchesChain(walletId, chain)) return
    const snap = snapshotsRef.current[walletId] ?? emptySnapshot()
    let book = addressBooksRef.current[walletId] ?? snap.addressBook
    const localUtxos = snap.utxos.filter((u) => utxoMatchesChain(u, chain))
    if (snap.coin && snap.coin !== chain && localUtxos.length === 0) {
      setBalanceKasValue(0)
      setUtxos([])
      setTransactions([])
      setAddressBook(null)
      setReceiveAddresses([])
      return
    }
    if (book && localUtxos.length) {
      book = mergeAddressBookWithUtxos(book, localUtxos, chain)
      addressBooksRef.current[walletId] = book
    }
    setAddressBook(book ?? null)
    const utxoSompi = localUtxos.reduce((sum, u) => sum + u.amount, 0)
    const displayKas = utxoSompi > 0 ? utxoSompi / 1e8 : 0
    setBalanceKasValue(displayKas)
    if (utxoSompi > 0) {
      publishWalletBalanceLabel(walletId, chain, utxoSompi)
    } else if (snap.balanceText) {
      publishWalletBalanceLabel(walletId, chain, 0)
    }
    setUtxos(snap.utxos.filter((u) => utxoMatchesChain(u, chain)).map((u) => normalizeUtxo(u as unknown as Record<string, unknown>)))
    setTransactions(snapshotTransactionsForWallet(walletId, chain))
    if (book?.receive?.length) {
      setReceiveAddresses(book.receive.map((r) => ({ index: r.index, address: r.address })))
    } else {
      setReceiveAddresses(snap.receiveAddresses)
    }
  }

  function walletDataChanged(bal: BalanceResponse, walletId: string, chain: CoinChain): boolean {
    const filtered = bal.utxos.filter((u) => utxoMatchesChain(u, chain))
    const snap = snapshotsRef.current[walletId] ?? emptySnapshot()
    const isCurrent = activeWalletIdRef.current === walletId && selectedChainRef.current === chain
    const priorUtxos = isCurrent
      ? utxosRef.current.filter((u) => utxoMatchesChain(u, chain))
      : snap.utxos.filter((u) => utxoMatchesChain(u, chain))
    const utxoSompi = filtered.reduce((sum, u) => sum + u.amount, 0)
    const priorSompi = priorUtxos.reduce((sum, u) => sum + u.amount, 0)

    if (priorSompi !== utxoSompi) return true
    if (priorUtxos.length !== filtered.length) return true

    const priorByKey = new Map(priorUtxos.map((u) => [u.key, u.amount]))
    for (const u of filtered) {
      if (priorByKey.get(u.key) !== u.amount) return true
    }
    return false
  }

  function resetWalletNavigation(): void {
    setSidebarSelection('dashboard')
    setShowSendWizard(false)
    setShowReceiveSheet(false)
    setSelectedSpendUtxoKeys(new Set())
    selectedSpendUtxoKeysRef.current = new Set()
    setSendUsesCustomCoinSelection(false)
    setSendOpenedFromCoins(false)
  }

  function walletNeedsAutoDiscover(wallet: WalletDTO): boolean {
    const st = syncStatusByWalletRef.current[wallet.id] ?? wallet.sync_status ?? 'cached'
    return st === 'cached' || st === 'incomplete'
  }

  function applyLocalWallet(w: WalletDTO): void {
    const chain = walletCoin(w)
    setIsAddingWallet(false)
    sanitizeSnapshotForWallet(w.id, chain)
    activeWalletIdRef.current = w.id
    setActiveWalletId(w.id)
    activeWalletByCoinRef.current = { ...activeWalletByCoinRef.current, [chain]: w.id }
    setActiveWalletByCoin((prev) => ({ ...prev, [chain]: w.id }))
    restoreSnapshot(w.id, chain)
    void refreshFiatPrices()
    void loadWalletStateFromBackend(w.id, true)
    void ensureAddresses(w.id)
    ensureActiveWalletLiveStream()
    if (!startupScanInProgressRef.current) {
      const mode = walletNeedsAutoDiscover(w) ? 'discover' : 'hot'
      void requestBackgroundSync(w.id, mode, false)
    }
  }

  function applyChainContextForWallets(
    targetChain: CoinChain,
    walletList: WalletDTO[],
    byCoin: Record<string, string>,
  ): void {
    const wid = byCoin[targetChain]
    const wallet = (wid ? walletList.find((w) => w.id === wid) : undefined)
      ?? walletList.find((w) => walletCoin(w) === targetChain)
    if (wallet) {
      applyLocalWallet(wallet)
      return
    }
    setActiveWalletId(null)
    setUtxos([])
    setTransactions([])
    setBalanceKasValue(0)
    setAddressBook(null)
    setReceiveAddresses([])
    if (!showWelcomeRef.current && walletList.filter((w) => walletCoin(w) === targetChain).length === 0) {
      setIsAddingWallet(true)
    } else {
      setIsAddingWallet(false)
    }
  }

  const syncChainContext = useCallback(
    async (
      targetChain: CoinChain = selectedChainRef.current,
      preload?: { wallets: WalletDTO[]; activeWalletByCoin: Record<string, string> },
    ) => {
      const client = apiRef.current
      if (!client) return walletsRef.current
      if (preload) {
        walletsRef.current = preload.wallets
        activeWalletByCoinRef.current = preload.activeWalletByCoin
        setWallets(preload.wallets)
        setActiveWalletByCoin(preload.activeWalletByCoin)
        applyChainContextForWallets(targetChain, preload.wallets, preload.activeWalletByCoin)
        return preload.wallets
      }
      const res = await client.listWallets()
      const byCoin = res.active_wallet_by_coin ?? {}
      walletsRef.current = res.wallets
      activeWalletByCoinRef.current = byCoin
      setWallets(res.wallets)
      if (res.active_wallet_by_coin) {
        setActiveWalletByCoin(byCoin)
      }
      applyChainContextForWallets(targetChain, res.wallets, byCoin)
      return res.wallets
    },
    [],
  )

  const setSelectedChain = useCallback((chain: CoinChain) => {
    if (chain === selectedChainRef.current) return
    operationGenRef.current += 1
    persistActiveSnapshot()
    resetWalletNavigation()
    selectedChainRef.current = chain
    setSelectedChainState(chain)
    UserPrefs.selectedChain = chain
    document.documentElement.dataset.chain = chain
    setIsAddingWallet(false)
    setBalanceKasValue(0)
    setTransactions([])
    setUtxos([])
    const wid = activeWalletByCoinRef.current[chain]
    const wallet = wid
      ? walletsRef.current.find((w) => w.id === wid)
      : walletsRef.current.find((w) => walletCoin(w) === chain)
    if (wallet) {
      applyLocalWallet(wallet)
    } else {
      void syncChainContext(chain)
    }
    updateScanStatusMessage()
  }, [syncChainContext])

  async function hydrateCachedBalance(walletId: string, chain: CoinChain): Promise<void> {
    const client = apiRef.current
    if (!client) return
    const snap = snapshotsRef.current[walletId] ?? emptySnapshot()
    const chainUtxos = snap.utxos.filter((u) => utxoMatchesChain(u, chain))
    const needsFetch = chainUtxos.length === 0 && snap.balanceValue <= 0
    if (!needsFetch && snap.balanceText) return
    try {
      const bal = await client.balance(walletId)
      if (bal.balance_sompi > 0 || bal.utxos.length > 0 || needsFetch) {
        applyBalance(bal, walletId, chain, true)
      }
    } catch {
      /* cached snapshot already restored */
    }
  }

  function reconcileBalance(
    bal: BalanceResponse,
    filtered: UtxoDTO[],
    chain: CoinChain,
    walletId?: string,
  ): { sompi: number; kas: number } {
    const utxoSompi = filtered.reduce((sum, u) => sum + u.amount, 0)
    if (filtered.length > 0) {
      return { sompi: utxoSompi, kas: utxoSompi / 1e8 }
    }
    if (!balanceResponseMatchesChain(bal, chain)) {
      return { sompi: 0, kas: 0 }
    }
    return { sompi: bal.balance_sompi, kas: bal.balance_kas }
  }

  function publishWalletBalanceLabel(walletId: string, chain: CoinChain, sompi: number): void {
    const text = formatBalance(sompi, chain)
    setWalletBalances((prev) => ({ ...prev, [walletId]: text }))
  }

  function applyBalance(bal: BalanceResponse, walletId: string, chain: CoinChain, silent = false): void {
    if (!balanceResponseMatchesWallet(bal, walletId, chain, walletsRef.current)) return
    if (!walletRecordMatchesChain(walletId, chain)) return
    const snap = snapshotsRef.current[walletId] ?? emptySnapshot()
    const filtered = bal.utxos
      .filter((u) => utxoMatchesChain(u, chain))
      .map((u) => normalizeUtxo(u as unknown as Record<string, unknown>))
    const prior = snapshotDisplayKas(snap, chain)
    if (shouldRetainCachedBalance(bal, filtered, prior, silent, 'hot')) {
      if (!silent && isViewingWallet(walletId)) {
        setStatusMessage('Network error · showing last known balance')
      }
      if (isViewingWallet(walletId) && prior > 0) {
        publishBalanceToUi(walletId, chain, prior)
      }
      return
    }
    const reconciled = reconcileBalance(bal, filtered, chain, walletId)
    commitWalletBalance(walletId, chain, reconciled, filtered)
    markSessionHotSynced(walletId)

    if (!isViewingWallet(walletId)) return
    publishBalanceToUi(walletId, chain, reconciled.kas)
    setUtxos(filtered)
    pruneSpendSelection(new Set(filtered.map((u) => u.key)))
  }

  const pruneSpendSelection = useCallback((validKeys?: Set<string>): void => {
    const validList = validKeys ? Array.from(validKeys) : utxosRef.current.map((u) => u.key)
    const validNorm = new Set(validList.map(normalizeOutpointKey))
    setSelectedSpendUtxoKeys((prev) => {
      const next = new Set<string>()
      for (const k of Array.from(prev)) {
        const norm = normalizeOutpointKey(k)
        if (!validNorm.has(norm)) continue
        const canonical = validList.find((v) => normalizeOutpointKey(v) === norm) ?? k
        next.add(canonical)
      }
      selectedSpendUtxoKeysRef.current = next
      return next
    })
  }, [])

  function walletMainnetSynced(walletId: string, chain: CoinChain): boolean {
    const snap = snapshotsRef.current[walletId] ?? emptySnapshot()
    if (!snap.mainnetSynced) return false
    if (snap.coin && snap.coin !== chain) return false
    return true
  }

  function walletScannedThisSession(walletId: string): boolean {
    return sessionMainnetSyncedRef.current.has(walletId)
  }

  function markSessionHotSynced(walletId: string): void {
    sessionMainnetSyncedRef.current.add(walletId)
  }

  function pushUtxoCacheToBackend(_walletId: string, _chain: CoinChain, _utxos: UtxoDTO[]): void {
    /* backend owns wallet state */
  }

  function markMainnetSynced(walletId: string, chain: CoinChain): void {
    sessionMainnetSyncedRef.current.add(walletId)
    const snap = snapshotsRef.current[walletId] ?? emptySnapshot()
    snap.mainnetSynced = true
    snap.coin = chain
    snapshotsRef.current[walletId] = snap
    schedulePersistSnapshots()
  }

  function invalidateMainnetSync(walletId?: string): void {
    if (walletId) {
      sessionMainnetSyncedRef.current.delete(walletId)
      const snap = snapshotsRef.current[walletId]
      if (snap) {
        snap.mainnetSynced = false
        snapshotsRef.current[walletId] = snap
        schedulePersistSnapshots()
      }
      return
    }
    sessionMainnetSyncedRef.current.clear()
    for (const id of Object.keys(snapshotsRef.current)) {
      snapshotsRef.current[id]!.mainnetSynced = false
    }
    schedulePersistSnapshots()
  }

  function walletRecordMatchesChain(walletId: string, chain: CoinChain): boolean {
    const w = walletsRef.current.find((x) => x.id === walletId)
    return !w || walletCoin(w) === chain
  }

  function walletHasReliableBalanceCache(walletId: string, chain: CoinChain): boolean {
    return walletMainnetSynced(walletId, chain)
  }

  function resolveChainRefreshPlan(
    chain: CoinChain,
    opts: { isFocus: boolean; forceRescan?: boolean; walletId: string },
  ): { syncMode: WalletSyncMode; silent: boolean } {
    if (opts.forceRescan === true) {
      return { syncMode: 'deep', silent: !opts.isFocus }
    }
    return { syncMode: 'hot', silent: !opts.isFocus }
  }

  function walletHasLiveCache(walletId: string): boolean {
    const snap = snapshotsRef.current[walletId] ?? emptySnapshot()
    return (
      snap.utxos.length > 0 ||
      snap.balanceValue > 0 ||
      snap.transactions.length > 0 ||
      Boolean(snap.balanceText)
    )
  }

  function commitWalletBalance(
    walletId: string,
    chain: CoinChain,
    reconciled: { sompi: number; kas: number },
    filteredUtxos: UtxoDTO[],
  ): void {
    if (!walletRecordMatchesChain(walletId, chain)) return
    const wallet = walletsRef.current.find((w) => w.id === walletId)
    if (!wallet || walletCoin(wallet) !== chain) return
    const safeUtxos = filteredUtxos.filter((u) => utxoMatchesChain(u, chain))
    const snap = snapshotsRef.current[walletId] ?? emptySnapshot()
    snap.balanceText = formatBalance(reconciled.sompi, chain)
    snap.balanceValue = reconciled.kas
    snap.utxos = safeUtxos.map((u) => normalizeUtxo(u as unknown as Record<string, unknown>))
    snap.coin = chain
    snapshotsRef.current[walletId] = snap
    publishWalletBalanceLabel(walletId, chain, reconciled.sompi)
    schedulePersistSnapshots()
    pushUtxoCacheToBackend(walletId, chain, safeUtxos)
  }

  function shouldRetainCachedBalance(
    bal: BalanceResponse,
    filteredUtxos: UtxoDTO[],
    priorBalance: number,
    silent: boolean,
    syncMode: WalletSyncMode,
  ): boolean {
    const mode = syncMode === 'deep' ? 'full' : 'watch'
    const emptyResponse =
      filteredUtxos.length === 0 && bal.balance_sompi <= 0 && bal.balance_kas <= 0
    // Only retain the last known balance when an empty reply looks like a failed
    // probe (unchanged fingerprint). A real spend/sweep sets changed=true and
    // must be allowed to reach 0.
    const suspiciousEmpty =
      priorBalance > 0 && emptyResponse && bal.changed === false
    const emptyWatch = mode === 'watch' && suspiciousEmpty
    const emptyFull = mode === 'full' && suspiciousEmpty
    if (!silent) return emptyWatch || emptyFull
    if (priorBalance <= 0) return false
    if (bal.balance_kas > 0 || filteredUtxos.length > 0) return false
    return bal.changed === false
  }

  function updateScanStatusMessage(): void {
    const chain = selectedChainRef.current
    const chainLabel = chain === 'kaspa' ? 'Kaspa' : 'Bitcoin'
    const scanningIds = walletsRef.current.filter(
      (w) => walletCoin(w) === chain && mainnetFullScanIdsRef.current.has(w.id),
    )
    if (scanningIds.length > 0) {
      setStatusMessage(
        scanningIds.length > 1
          ? `Scanning ${chainLabel} mainnet · ${scanningIds.length} wallets…`
          : `Scanning ${chainLabel} mainnet…`,
      )
      return
    }
    const refreshingIds = walletsRef.current.filter(
      (w) => walletCoin(w) === chain && refreshingWalletIdsRef.current.has(w.id),
    )
    if (refreshingIds.length > 0) {
      setStatusMessage(chain === 'kaspa' ? 'Refreshing Kaspa…' : 'Refreshing Bitcoin…')
      return
    }
    const active = walletForChainRef(chain)
    const syncSt = active
      ? visibleSyncStatus(active.id, syncStatusByWalletRef.current[active.id] ?? active.sync_status ?? 'cached')
      : null
    if (syncSt === 'syncing') {
      setStatusMessage(chain === 'kaspa' ? 'Syncing Kaspa mainnet…' : 'Syncing Bitcoin mainnet…')
      return
    }
    if (syncSt === 'cached') {
      setStatusMessage(chain === 'kaspa' ? 'Cached · Kaspa mainnet' : 'Cached · Bitcoin mainnet')
      return
    }
    if (syncSt === 'incomplete') {
      setStatusMessage(
        chain === 'kaspa' ? 'Incomplete scan · Kaspa mainnet' : 'Incomplete scan · Bitcoin mainnet',
      )
      return
    }
    setStatusMessage(chain === 'kaspa' ? 'Live · Kaspa mainnet' : 'Live · Bitcoin mainnet')
  }

  function publishBalanceToUi(walletId: string, chain: CoinChain, nextBalance: number): void {
    if (!walletRecordMatchesChain(walletId, chain)) return
    if (selectedChainRef.current !== chain) return
    if (!isViewingWallet(walletId)) return
    const wallet = walletsRef.current.find((w) => w.id === walletId)
    if (!wallet || walletCoin(wallet) !== chain) return
    setBalanceKasValue(nextBalance)
  }

  function mergeWalletTransactions(
    cached: WalletTxDTO[],
    incoming: WalletTxDTO[],
    chain: CoinChain,
  ): WalletTxDTO[] {
    return dedupeWalletTransactions([...cached, ...incoming], chain)
  }

  async function loadTransactionsFor(
    walletId: string,
    query?: string,
    opts?: { quiet?: boolean; refresh?: boolean },
  ): Promise<void> {
    const client = apiRef.current
    if (!client) return
    if (!walletsRef.current.some((w) => w.id === walletId)) return
    const chain = walletChainForId(walletId, selectedChainRef.current)
    const snap = snapshotsRef.current[walletId] ?? emptySnapshot()
    const cached = filterTransactionsForChain(snap.transactions, chain)
    const loadGen = (txLoadGenRef.current[walletId] ?? 0) + 1
    txLoadGenRef.current[walletId] = loadGen
    if (!opts?.quiet && shouldPublishWalletUi(walletId) && cached.length > 0) {
      setTransactions(cached)
    }
    try {
      const res = await client.transactions(walletId, query, { refresh: opts?.refresh })
      if (txLoadGenRef.current[walletId] !== loadGen) return
      const incoming = filterTransactionsForChain(
        res.transactions.map(normalizeWalletTx),
        chain,
      )
      const merged = query?.trim()
        ? mergeWalletTransactions(cached, incoming, chain)
        : dedupeWalletTransactions(
            // Keep local confirmation progress when a slower quiet poll returns an older tip.
            incoming.length > 0 ? [...cached, ...incoming] : cached,
            chain,
          )
      if (merged.length > 0 || cached.length === 0) {
        snap.transactions = merged
        snapshotsRef.current[walletId] = snap
        if (!opts?.quiet) schedulePersistSnapshots()
      }
      if (shouldPublishWalletUi(walletId)) {
        setTransactions(snapshotTransactionsForWallet(walletId, chain))
      }
      if (!opts?.quiet && merged.length > 0 && refreshingWalletIdsRef.current.size === 0) {
        void prefetchWalletTxVisualize(client, walletId, merged)
      }
    } catch {
      if (txLoadGenRef.current[walletId] !== loadGen) return
      if (!opts?.quiet && shouldPublishWalletUi(walletId) && cached.length > 0) {
        setTransactions(cached)
      }
    }
  }

  async function ensureAddresses(walletId: string): Promise<void> {
    if (!api) return
    const wallet = walletsRef.current.find((w) => w.id === walletId)
    const chain = wallet ? walletCoin(wallet) : 'kaspa'
    const cached = addressBooksRef.current[walletId]
    if (cached) {
      const missingChange = chain === 'bitcoin' && cached.change.length === 0
      if (!missingChange) return
      delete addressBooksRef.current[walletId]
    }
    try {
      const book = withoutBalances(await api.addressBook(walletId, false))
      addressBooksRef.current[walletId] = book
      const snap = snapshotsRef.current[walletId] ?? emptySnapshot()
      snap.addressBook = book
      snapshotsRef.current[walletId] = snap
      return
    } catch {
      /* fall through */
    }
    if (chain !== 'kaspa') return
    try {
      const addrs = (await api.addresses(walletId)).addresses
      if (!addrs.length) return
      const book: AddressBookResponse = {
        receive: addrs.map((a) => ({
          index: a.index,
          address: a.address,
          is_change: false,
          balance_sompi: 0,
          balance_kas: 0,
        })),
        change: [],
        next_receive_index: addrs[0]?.index ?? 0,
        next_receive_address: addrs[0]?.address ?? '',
      }
      addressBooksRef.current[walletId] = book
      if (walletId === activeWalletIdRef.current) {
        publishAddressBook(walletId, book)
      }
    } catch {
      /* ignore */
    }
  }

  async function mergeAddressBalancesForWallet(walletId: string): Promise<void> {
    if (!api) return
    await ensureAddresses(walletId)
    const wallet = walletsRef.current.find((w) => w.id === walletId)
    const chain = wallet ? walletCoin(wallet) : 'kaspa'
    let base = addressBooksRef.current[walletId]
    if (!base) {
      try {
        base = withoutBalances(await api.addressBook(walletId, false))
        addressBooksRef.current[walletId] = base
      } catch {
        return
      }
    }
    const localUtxos = (
      isViewingWallet(walletId)
        ? utxosRef.current
        : snapshotsRef.current[walletId]?.utxos ?? []
    ).filter((u) => utxoMatchesChain(u, chain))
    const merged = localUtxos.length ? mergeAddressBookWithUtxos(base, localUtxos, chain) : base
    publishAddressBook(walletId, merged)
  }

  function clearScanDetail(): void {
    setScanDetailMessage(null)
  }

  const updateConnectedStatusMessage = useCallback(() => {
    updateScanStatusMessage()
  }, [])


  function updateLiveStreamState(): void {
    setLiveStreamWalletIds(new Set(liveStreamWalletsRef.current))
    setPushStreamActive(liveStreamWalletsRef.current.size > 0)
  }

  function stopAllEventStreams(): void {
    for (const stream of Array.from(eventStreamsRef.current.values())) {
      stream.stop(false)
    }
    eventStreamsRef.current.clear()
    liveStreamWalletsRef.current.clear()
    updateLiveStreamState()
  }

  async function handleLiveBalancePush(walletId: string, raw: Record<string, unknown>): Promise<void> {
    if (raw.type === 'state') {
      applyWalletState(raw as unknown as WalletStateResponse, isViewingWallet(walletId))
      if (isViewingWallet(walletId)) {
        setFiatTick((t) => t + 1)
        void refreshFiatPrices()
      }
      return
    }
    const bal = parseBalanceResponse(raw)
    const w = walletsRef.current.find((x) => x.id === walletId)
    const chain = w ? walletCoin(w) : selectedChainRef.current
    if (!walletRecordMatchesChain(walletId, chain)) return
    if (!balanceResponseMatchesWallet(bal, walletId, chain, walletsRef.current)) return
    const viewing = isViewingWallet(walletId)
    const changed = walletDataChanged(bal, walletId, chain)
    applyBalance(bal, walletId, chain, true)
    if (!changed && !viewing) return
    await mergeAddressBalancesForWallet(walletId)
    if (!viewing) return
    publishSnapshotToUi(walletId)
    if (changed) {
      void loadTransactionsFor(walletId)
      setFiatTick((t) => t + 1)
      void refreshFiatPrices()
    }
    if (chain === 'kaspa' && apiRef.current) {
      try {
        const res = await apiRef.current.addresses(walletId)
        setReceiveAddresses(res.addresses)
      } catch {
        /* ignore */
      }
    }
  }

  function ensureActiveWalletLiveStream(): void {
    const client = apiRef.current
    const activeId = activeWalletIdRef.current
    if (!client || !activeId) {
      stopAllEventStreams()
      return
    }

    for (const [id, stream] of Array.from(eventStreamsRef.current.entries())) {
      if (id !== activeId) {
        stream.stop(false)
        eventStreamsRef.current.delete(id)
        liveStreamWalletsRef.current.delete(id)
      }
    }
    updateLiveStreamState()

    if (eventStreamsRef.current.has(activeId)) return

    const stream = new WalletEventStream()
    eventStreamsRef.current.set(activeId, stream)
    stream.start(
      activeId,
      client.serverBaseURL,
      () => {
        liveStreamWalletsRef.current.add(activeId)
        updateLiveStreamState()
      },
      (raw) => {
        void handleLiveBalancePush(activeId, raw as unknown as Record<string, unknown>)
      },
      () => {
        liveStreamWalletsRef.current.delete(activeId)
        updateLiveStreamState()
      },
    )
  }

  const refreshWalletInternal = useCallback(
    async (
      walletId: string,
      chain: CoinChain,
      gen: number,
      silent: boolean,
      forceFull: boolean | WalletSyncMode = 'hot',
    ): Promise<void> => {
      const client = apiRef.current
      if (!client) return
      if (!walletRecordMatchesChain(walletId, chain)) return
      const syncMode: WalletSyncMode =
        forceFull === true ? 'deep' : forceFull === false ? 'hot' : forceFull
      const trackFullScanUi = syncMode === 'discover' || syncMode === 'deep'
      if (trackFullScanUi) {
        mainnetFullScanIdsRef.current.add(walletId)
        setMainnetFullScanIds(new Set(mainnetFullScanIdsRef.current))
        updateScanStatusMessage()
      }
      if (silent) {
        if (pollingWalletIdsRef.current.has(walletId)) return
        pollingWalletIdsRef.current.add(walletId)
        setPollingWalletIds(new Set(pollingWalletIdsRef.current))
      } else {
        const next = new Set(refreshingWalletIdsRef.current).add(walletId)
        refreshingWalletIdsRef.current = next
        setRefreshingWalletIds(next)
        const viewing = isViewingWallet(walletId)
        if (viewing) {
          if (syncMode === 'hot') {
            clearScanDetail()
            setStatusMessage(chain === 'kaspa' ? 'Refreshing Kaspa…' : 'Refreshing Bitcoin…')
          } else if (syncMode === 'discover') {
            clearScanDetail()
            setScanDetailMessage('Checking mainnet for your first addresses…')
            setStatusMessage(chain === 'kaspa' ? 'Discovering Kaspa funds…' : 'Discovering Bitcoin funds…')
          } else {
            setScanDetailMessage(
              'Discovering used addresses across your wallet. This can take a few minutes for wallets with lots of activity.',
            )
            setStatusMessage(chain === 'kaspa' ? 'Scanning Kaspa mainnet…' : 'Scanning Bitcoin mainnet…')
          }
        } else if (next.size > 1) {
          updateScanStatusMessage()
        }
      }
      try {
        const walletChain = walletChainForId(walletId, chain)
        const onProgress = (message: string): void => {
          if (!silent && isViewingWallet(walletId)) setScanDetailMessage(message)
        }
        const bal =
          syncMode === 'hot'
            ? await client.refreshWatch(walletId)
            : syncMode === 'discover'
              ? await client.refreshDiscover(walletId, onProgress)
              : await client.refresh(walletId, onProgress)
        if (!balanceResponseMatchesWallet(bal, walletId, walletChain, walletsRef.current)) return
        const viewing = isViewingWallet(walletId)
        const changed = bal.changed !== false
        const dataChanged = viewing ? walletDataChanged(bal, walletId, walletChain) : true
        const snap = snapshotsRef.current[walletId] ?? emptySnapshot()
        const filteredUtxos = bal.utxos
          .filter((u) => utxoMatchesChain(u, walletChain))
          .map((u) => normalizeUtxo(u as unknown as Record<string, unknown>))
        const priorBalance = snapshotDisplayKas(snap, walletChain)
        const retainBalance = shouldRetainCachedBalance(bal, filteredUtxos, priorBalance, silent, syncMode)
        const staleGeneration = gen !== operationGenRef.current
        const shouldCommit = !retainBalance && (!staleGeneration || !silent)
        if (shouldCommit) {
          const reconciled = reconcileBalance(bal, filteredUtxos, walletChain, walletId)
          commitWalletBalance(walletId, walletChain, reconciled, filteredUtxos)
          if (syncMode === 'hot' || syncMode === 'discover') markSessionHotSynced(walletId)
          if (syncMode === 'deep') markMainnetSynced(walletId, walletChain)
          if (bal.sync_status) {
            setWalletSyncStatus(walletId, bal.sync_status)
          } else if (syncMode === 'hot' || syncMode === 'discover') {
            setWalletSyncStatus(walletId, 'live')
          }
          void mergeAddressBalancesForWallet(walletId)
          if (viewing) {
            publishBalanceToUi(walletId, walletChain, reconciled.kas)
            setUtxos(filteredUtxos)
            pruneSpendSelection(new Set(filteredUtxos.map((u) => u.key)))
          }
        } else if (viewing && priorBalance > 0 && !staleGeneration) {
          publishBalanceToUi(walletId, walletChain, priorBalance)
        }
        if (staleGeneration && silent) return
        const historyIsBackground = syncMode !== 'deep'
        const shouldReloadHistory =
          syncMode === 'deep' ||
          (syncMode === 'discover' && !silent) ||
          (syncMode === 'hot' && viewing && (changed || dataChanged || snap.transactions.length === 0))
        const publishAfterReload = (): void => {
          if (!isViewingWallet(walletId)) return
          publishSnapshotToUi(walletId)
          if (changed || dataChanged) setFiatTick((t) => t + 1)
        }
        if (shouldReloadHistory) {
          if (!silent && viewing && syncMode === 'deep') {
            setScanDetailMessage('Loading transaction history…')
          }
          const reloadWork = async (): Promise<void> => {
            await loadTransactionsFor(walletId, undefined, {
              refresh: true,
              quiet: silent,
            })
            await mergeAddressBalancesForWallet(walletId)
            publishAfterReload()
          }
          if (silent || historyIsBackground) void reloadWork()
          else await reloadWork()
        } else if (changed || dataChanged) {
          if (silent) {
            void mergeAddressBalancesForWallet(walletId).then(publishAfterReload)
          } else {
            await mergeAddressBalancesForWallet(walletId)
            publishAfterReload()
          }
        } else if (!silent && viewing) {
          publishSnapshotToUi(walletId)
        }
      } catch (e) {
        if (!silent && activeWalletIdRef.current === walletId) {
          await hydrateCachedBalance(walletId, chain)
          const cached = snapshotDisplayKas(snapshotsRef.current[walletId] ?? emptySnapshot(), chain)
          if (cached > 0) {
            setStatusMessage('Showing cached balance · scan failed')
          } else {
            setStatusMessage(e instanceof APIError ? apiError(e.status ?? 0, e.message) : 'Scan failed')
          }
        }
        throw e
      } finally {
        if (trackFullScanUi) {
          mainnetFullScanIdsRef.current.delete(walletId)
          setMainnetFullScanIds(new Set(mainnetFullScanIdsRef.current))
          if (mainnetFullScanIdsRef.current.size === 0) {
            clearScanDetail()
          }
          updateScanStatusMessage()
        }
        if (silent) {
          pollingWalletIdsRef.current.delete(walletId)
          setPollingWalletIds(new Set(pollingWalletIdsRef.current))
        } else {
          const next = new Set(refreshingWalletIdsRef.current)
          next.delete(walletId)
          refreshingWalletIdsRef.current = next
          setRefreshingWalletIds(next)
          if (isViewingWallet(walletId)) {
            publishSnapshotToUi(walletId)
          }
          updateScanStatusMessage()
        }
      }
    },
    [updateConnectedStatusMessage],
  )

  const loadWallets = useCallback(async (): Promise<WalletDTO[]> => {
    return (await syncChainContext()) ?? walletsRef.current
  }, [syncChainContext])

  const refreshChainWallets = useCallback(
    async (
      chain: CoinChain,
      options?: { focusWalletId?: string; forceRescan?: boolean },
    ): Promise<void> => {
      const chainWallets = walletsRef.current.filter((w) => walletCoin(w) === chain)
      if (chainWallets.length === 0) return
      const gen = operationGenRef.current
      const focusId = options?.focusWalletId ?? activeWalletIdRef.current ?? undefined
      const multi = chainWallets.length > 1
      if (multi && focusId) {
        setStatusMessage('Syncing with mainnet…')
      }
      await Promise.all(
        chainWallets.map((wallet) => {
          const walletChain = walletCoin(wallet)
          const isFocus = wallet.id === focusId
          const { syncMode, silent } = resolveChainRefreshPlan(walletChain, {
            isFocus,
            forceRescan: options?.forceRescan,
            walletId: wallet.id,
          })
          if (syncMode === 'deep' && isFocus && isViewingWallet(wallet.id) && walletChain === 'bitcoin') {
            setScanDetailMessage(
              'Discovering used addresses across your wallet. This can take a few minutes for wallets with lots of activity.',
            )
          }
          return refreshWalletInternal(wallet.id, walletChain, gen, silent, syncMode).catch(() => undefined)
        }),
      )
      if (multi) updateConnectedStatusMessage()
    },
    [refreshWalletInternal, updateConnectedStatusMessage],
  )

  const scheduleBackgroundSync = useCallback(async (currentWallets: WalletDTO[]): Promise<void> => {
    if (!apiRef.current || currentWallets.length === 0) return
    void fiatPriceService.refresh().then(() => setFiatTick((t) => t + 1))
    const activeId = activeWalletIdRef.current
    const activeChain = selectedChainRef.current
    for (const w of currentWallets) {
      const chain = walletCoin(w)
      const isActive = w.id === activeId && chain === activeChain
      const st = syncStatusByWalletRef.current[w.id] ?? w.sync_status ?? 'cached'
      if (st === 'cached' || st === 'incomplete') {
        void requestBackgroundSync(w.id, 'discover', false)
      } else if (isActive || st !== 'live') {
        void requestBackgroundSync(w.id, 'hot', false)
      }
    }
    updateScanStatusMessage()
  }, [updateScanStatusMessage])

  async function hotScanChainBatch(chain: CoinChain, pending: WalletDTO[], gen: number): Promise<void> {
    const activeId = activeWalletIdRef.current
    const activeChain = selectedChainRef.current
    const chainPending = pending.filter(
      (w) =>
        walletCoin(w) === chain &&
        !walletScannedThisSession(w.id) &&
        !(w.id === activeId && chain === activeChain),
    )
    if (chainPending.length === 0) return
    const concurrency = chain === 'bitcoin' ? 2 : 3
    for (let i = 0; i < chainPending.length; i += concurrency) {
      const batch = chainPending.slice(i, i + concurrency)
      await Promise.all(
        batch.map((wallet) =>
          refreshWalletInternal(wallet.id, chain, gen, true, 'hot').catch(() => undefined),
        ),
      )
    }
  }

  async function deepScanChainBatch(chain: CoinChain, wallets: WalletDTO[], gen: number): Promise<void> {
    const chainPending = wallets.filter(
      (w) => walletCoin(w) === chain && !walletMainnetSynced(w.id, chain),
    )
    if (chainPending.length === 0) return
    const concurrency = chain === 'bitcoin' ? 1 : 2
    for (let i = 0; i < chainPending.length; i += concurrency) {
      const batch = chainPending.slice(i, i + concurrency)
      await Promise.all(
        batch.map((wallet) =>
          refreshWalletInternal(wallet.id, chain, gen, true, 'deep').catch(() => undefined),
        ),
      )
    }
  }

  const reloadStatus = useCallback(async () => {
    const client = apiRef.current
    if (!client) return
    try {
      const st = await client.status()
      const walletsList = st.wallets ?? []
      setWallets(walletsList)
      const byCoin = st.active_wallet_by_coin ?? {}
      if (Object.keys(byCoin).length === 0 && st.active_wallet_id) {
        byCoin.kaspa = st.active_wallet_id
      }
      setActiveWalletByCoin(byCoin)
      if (st.network_settings) {
        setNetworkSettingsEnvelope((prev) => ({
          settings: st.network_settings!,
          defaults: prev?.defaults ?? st.network_settings!,
        }))
      }
      await syncChainContext(selectedChainRef.current, { wallets: walletsList, activeWalletByCoin: byCoin })
      const statusMap: Record<string, WalletSyncStatus> = {}
      for (const w of walletsList) {
        sanitizeSnapshotForWallet(w.id, walletCoin(w))
        const chain = walletCoin(w)
        if (w.sync_status) {
          statusMap[w.id] = w.sync_status
        }
        const sompi =
          w.cached_balance_sompi != null && w.cached_balance_sompi > 0
            ? w.cached_balance_sompi
            : snapshotDisplaySompi(snapshotsRef.current[w.id] ?? emptySnapshot(), chain)
        if (sompi > 0) {
          setWalletBalances((prev) => ({
            ...prev,
            [w.id]: formatBalance(sompi, chain),
          }))
        }
      }
      setSyncStatusByWallet(statusMap)
      syncStatusByWalletRef.current = statusMap
      const wid = activeWalletIdRef.current
      if (wid) {
        const activeW = walletsList.find((w) => w.id === wid)
        const chain = activeW ? walletCoin(activeW) : selectedChainRef.current
        void loadWalletStateFromBackend(wid, true).then(() => {
          void ensureAddresses(wid).then(() => mergeAddressBalancesForWallet(wid))
        })
      }
      const chain = selectedChainRef.current
      const hasActiveWallet = Boolean(
        activeWalletIdRef.current &&
          walletsList.some((w) => w.id === activeWalletIdRef.current && walletCoin(w) === chain),
      )
      if (!hasActiveWallet && !showWelcomeRef.current && !walletsList.some((w) => walletCoin(w) === chain)) {
        setIsAddingWallet(true)
      } else if (walletsList.some((w) => walletCoin(w) === chain)) {
        setIsAddingWallet(false)
      }
      if (!didStartupScanRef.current && walletsList.length > 0) {
        didStartupScanRef.current = true
        void scheduleBackgroundSync(walletsList)
      }
    } finally {
      setWalletsBootstrapped(true)
    }
  }, [syncChainContext, scheduleBackgroundSync])

  const selectWallet = useCallback(
    (id: string, hint?: WalletDTO) => {
      const w =
        hint ??
        wallets.find((x) => x.id === id) ??
        walletsRef.current.find((x) => x.id === id)
      if (!w) return
      const chain = walletCoin(w)
      setIsAddingWallet(false)
      activeWalletByCoinRef.current = { ...activeWalletByCoinRef.current, [chain]: w.id }
      setActiveWalletByCoin((prev) => ({ ...prev, [chain]: w.id }))
      if (chain !== selectedChainRef.current) {
        setSelectedChain(chain)
        return
      }
      if (activeWalletId !== id) {
        operationGenRef.current += 1
        persistActiveSnapshot()
        resetWalletNavigation()
      }
      applyLocalWallet(w)
      void api?.activateWallet(id)
    },
    [wallets, activeWalletId, api, setSelectedChain],
  )

  const activateWallet = useCallback(async (id: string, hint?: WalletDTO) => {
    selectWallet(id, hint)
  }, [selectWallet])

  const refreshFiatPrices = useCallback(async () => {
    await fiatPriceService.refresh()
    setFiatTick((t) => t + 1)
  }, [])

  const discoverWallet = useCallback(async (walletId: string, wait = false): Promise<void> => {
    invalidateMainnetSync(walletId)
    setWalletSyncStatus(walletId, 'syncing', { force: true })
    if (isViewingWallet(walletId)) {
      const w = walletsRef.current.find((x) => x.id === walletId)
      const chain = w ? walletCoin(w) : selectedChainRef.current
      setScanDetailMessage('Discovering used addresses on mainnet…')
      setStatusMessage(chain === 'kaspa' ? 'Discovering Kaspa funds…' : 'Discovering Bitcoin funds…')
    }
    await requestBackgroundSync(walletId, 'discover', wait)
    await loadWalletStateFromBackend(walletId, isViewingWallet(walletId))
    if (isViewingWallet(walletId)) {
      setFiatTick((t) => t + 1)
      clearScanDetail()
      updateScanStatusMessage()
    }
    void requestBackgroundSync(walletId, 'deep', false)
  }, [])

  const refreshActiveWallet = useCallback(async () => {
    const chain = selectedChainRef.current
    const wallet = walletForChainRef(chain)
    if (!wallet) return
    const walletId = syncActiveWalletForChain(chain) ?? wallet.id
    try {
      await Promise.all([
        requestBackgroundSync(walletId, 'hot', true, { userInitiated: true }),
        ensureAddresses(walletId),
        refreshFiatPrices(),
      ])
      await loadWalletStateFromBackend(walletId, isViewingWallet(walletId))
      await mergeAddressBalancesForWallet(walletId)
      if (isViewingWallet(walletId)) {
        setFiatTick((t) => t + 1)
      }
    } catch {
      await loadWalletStateFromBackend(walletId, isViewingWallet(walletId))
    }
  }, [refreshFiatPrices])

  const refreshAllWallets = useCallback(async (forceFullRescan = false): Promise<void> => {
    const list = walletsRef.current
    if (list.length === 0) return
    if (forceFullRescan) invalidateMainnetSync()
    updateScanStatusMessage()
    await Promise.all(
      list.map((wallet) => {
        const mode: WalletSyncMode = forceFullRescan ? 'deep' : 'hot'
        return requestBackgroundSync(wallet.id, mode, false)
      }),
    )
    updateScanStatusMessage()
  }, [updateScanStatusMessage])

  const refreshAfterSuccessfulSend = useCallback(async () => {
    if (!activeWallet) return
    const chain = walletCoin(activeWallet)
    setStatusMessage('Updating balance…')
    await requestBackgroundSync(activeWallet.id, 'hot', true)
    await loadWalletStateFromBackend(activeWallet.id, true)
    await ensureAddresses(activeWallet.id)
    await mergeAddressBalancesForWallet(activeWallet.id)
    // Force history refresh so the just-broadcast tx appears (cache alone can lag).
    await loadTransactionsFor(activeWallet.id, undefined, { refresh: true })
    setFiatTick((t) => t + 1)
    setStatusMessage(chain === 'kaspa' ? 'Live · Kaspa mainnet' : 'Live · Bitcoin mainnet')
  }, [activeWallet])

  const notePendingSend = useCallback(
    (tx: {
      transaction_id: string
      amount_kas?: number
      amount_btc?: number
      counterparty?: string
      fee_sompi?: number
    }) => {
      const wallet = activeWallet
      if (!wallet) return
      const tid = (tx.transaction_id || '').trim().toLowerCase().replace(/^0x/i, '')
      if (!tid) return
      const chain = walletCoin(wallet)
      const amount = Number(tx.amount_kas ?? tx.amount_btc ?? 0) || 0
      const pending: WalletTxDTO = {
        transaction_id: tid,
        direction: 'sent',
        amount_kas: amount,
        amount_btc: amount,
        amount_sats: Math.round(amount * 1e8),
        amount_sompi: Math.round(amount * 1e8),
        block_time: Math.floor(Date.now() / 1000),
        counterparty: tx.counterparty || '',
        confirmations: 0,
        fee_sompi: tx.fee_sompi,
        fee_sats: tx.fee_sompi,
      }
      const snap = snapshotsRef.current[wallet.id] ?? emptySnapshot()
      snap.transactions = dedupeWalletTransactions([pending, ...snap.transactions], chain)
      snapshotsRef.current[wallet.id] = snap
      if (shouldPublishWalletUi(wallet.id)) {
        setTransactions(snapshotTransactionsForWallet(wallet.id, chain))
      }
      schedulePersistSnapshots()
    },
    [activeWallet],
  )

  const pollActiveWalletIfIdle = useCallback(async () => {
    if (!activeWallet) return
    if (liveStreamWalletsRef.current.has(activeWallet.id)) return
    if (refreshingWalletIdsRef.current.has(activeWallet.id)) return
    if (pollingWalletIdsRef.current.has(activeWallet.id)) return
    if (
      visibleSyncStatus(
        activeWallet.id,
        syncStatusByWalletRef.current[activeWallet.id] ?? activeWallet.sync_status ?? 'cached',
      ) === 'syncing'
    ) {
      return
    }
    await requestBackgroundSync(activeWallet.id, 'hot', false)
  }, [activeWallet])

  const applyLocalWalletLabel = useCallback((id: string, label: string) => {
    setWallets((prev) => prev.map((w) => (w.id === id ? { ...w, label } : w)))
  }, [])

  const loadTransactions = useCallback(async (query?: string, opts?: { refresh?: boolean }) => {
    const chain = selectedChainRef.current
    const wallet = walletForChainRef(chain)
    if (!wallet) return
    syncActiveWalletForChain(chain)
    await loadTransactionsFor(wallet.id, query, { refresh: opts?.refresh })
  }, [])

  /**
   * Live Kaspa depth ? tip ? accepting at ~10 BPS.
   *
   * One continuous paint clock:
   * - runs forward at 10 BPS between tip samples
   * - snaps UP immediately when network tip is ahead (no catch-up delay)
   * - never resets/re-bases when network tip is behind (that caused freeze?jump glitches)
   */
  const kaspaPaintTipNow = useCallback(() => {
    const BPS = 10
    const paint = kaspaPaintTipRef.current
    const net = kaspaNetworkTipRef.current
    if (paint && paint.tip > 0) {
      const running = paint.tip + ((Date.now() - paint.atMs) / 1000) * BPS
      return Math.max(running, net?.tip ?? 0)
    }
    return net?.tip ?? 0
  }, [])

  const applyLiveKaspaConfirmations = useCallback(() => {
    const tipNow = Math.floor(kaspaPaintTipNow() + 1e-9)
    if (tipNow <= 0) return
    const walletId = activeWalletIdRef.current
    if (!walletId) return
    const snap = snapshotsRef.current[walletId]
    if (!snap?.transactions?.length) return

    let changed = false
    const next = snap.transactions.map((tx) => {
      const accepting = tx.accepting_block_blue_score ?? 0
      const prev = tx.confirmations ?? 0
      if (prev >= 200) return tx
      if (accepting <= 0) return tx
      if (tipNow < accepting) return tx
      const conf = Math.min(200, Math.max(1, tipNow - accepting))
      if (conf <= prev) return tx
      changed = true
      return { ...tx, confirmations: conf }
    })
    if (!changed) return
    kaspaLastConfBumpAtRef.current = Date.now()
    snap.transactions = next
    snapshotsRef.current[walletId] = snap
    if (shouldPublishWalletUi(walletId)) {
      setTransactions(snapshotTransactionsForWallet(walletId, 'kaspa'))
    }
  }, [kaspaPaintTipNow])

  const noteKaspaNetworkTip = useCallback((tipBlue: number, _cacheAgeMs = 0) => {
    if (tipBlue <= 0) return
    const now = Date.now()
    const net = kaspaNetworkTipRef.current
    if (net && tipBlue < net.tip) return // ignore stale lower samples

    kaspaNetworkTipRef.current = { tip: tipBlue, atMs: now }

    const paint = kaspaPaintTipRef.current
    if (!paint) {
      kaspaPaintTipRef.current = { tip: tipBlue, atMs: now }
      return
    }
    const running = paint.tip + ((now - paint.atMs) / 1000) * 10
    if (tipBlue > running) {
      // Network jumped ahead of the paint clock · snap immediately.
      kaspaPaintTipRef.current = { tip: tipBlue, atMs: now }
    }
    // If network is behind/equal, leave the paint clock alone (keeps smooth ~10 BPS).
  }, [])

  const refreshKaspaConfirmations = useCallback(async () => {
    const chain = selectedChainRef.current
    if (chain !== 'kaspa') return
    const wallet = walletForChainRef(chain)
    if (!wallet) return
    const client = apiRef.current
    if (!client) return
    try {
      const res = await client.kaspaConfirmations(wallet.id)
      noteKaspaNetworkTip(Number(res.tip_blue) || 0, Number(res.cache_age_ms) || 0)
      const tipNow = Math.floor(kaspaPaintTipNow())
      const snap = snapshotsRef.current[wallet.id] ?? emptySnapshot()
      if (!snap.transactions.length && !(res.updates?.length > 0)) return
      const byId = new Map(
        (res.updates || []).map((u) => [normalizeTxId(u.transaction_id), u] as const),
      )
      let metaChanged = false
      const next = snap.transactions.map((tx) => {
        const tid = txId(tx)
        const u = tid ? byId.get(tid) : undefined
        if (!u) return tx
        const prevAccept = tx.accepting_block_blue_score ?? 0
        const nextAccept = Number(u.accepting_block_blue_score) || 0
        // Only adopt accepting blue from indexer · never overwrite a known value.
        const accepting = prevAccept > 0 ? prevAccept : nextAccept > 0 ? nextAccept : prevAccept
        const blockTime = Math.max(txBlockTime(tx), Number(u.block_time) || 0) || tx.block_time
        const prevConf = tx.confirmations ?? 0
        let conf = prevConf
        if (accepting > 0 && tipNow >= accepting) {
          conf = Math.max(prevConf, Math.min(200, Math.max(1, tipNow - accepting)))
        } else if (prevConf <= 0 && (Number(u.confirmations) > 0 || accepting > 0)) {
          conf = Math.max(1, Number(u.confirmations) || 1)
        }
        if (
          accepting === (tx.accepting_block_blue_score ?? 0) &&
          blockTime === tx.block_time &&
          conf === prevConf
        ) {
          return tx
        }
        metaChanged = true
        return {
          ...tx,
          accepting_block_blue_score: accepting > 0 ? accepting : tx.accepting_block_blue_score,
          block_time: blockTime,
          confirmations: conf,
        }
      })
      if (metaChanged) {
        snap.transactions = next
        snapshotsRef.current[wallet.id] = snap
        if (shouldPublishWalletUi(wallet.id)) {
          setTransactions(snapshotTransactionsForWallet(wallet.id, 'kaspa'))
        }
      }
      applyLiveKaspaConfirmations()
    } catch {
      /* keep last known counts */
    }
  }, [applyLiveKaspaConfirmations, noteKaspaNetworkTip, kaspaPaintTipNow])

  const refreshKaspaTip = useCallback(async () => {
    const chain = selectedChainRef.current
    if (chain !== 'kaspa') return
    const client = apiRef.current
    if (!client) return
    const seq = ++kaspaTipSeqRef.current
    kaspaTipInFlightRef.current = true
    try {
      const res = await client.kaspaTipBlue()
      if (seq !== kaspaTipSeqRef.current) return
      noteKaspaNetworkTip(Number(res.tip_blue) || 0, Number(res.cache_age_ms) || 0)
      applyLiveKaspaConfirmations()
    } catch {
      /* ignore */
    } finally {
      if (seq === kaspaTipSeqRef.current) kaspaTipInFlightRef.current = false
    }
  }, [applyLiveKaspaConfirmations, noteKaspaNetworkTip])

  useEffect(() => {
    if (selectedChain !== 'kaspa') return
    const id = window.setInterval(() => {
      applyLiveKaspaConfirmations()
      // If labels stop climbing while txs still need live depth, nudge a tip refresh.
      const walletId = activeWalletIdRef.current
      if (!walletId) return
      const snap = snapshotsRef.current[walletId]
      if (!snap?.transactions?.length) return
      const climbing = snap.transactions.some((tx) => {
        const conf = tx.confirmations ?? 0
        const accepting = tx.accepting_block_blue_score ?? 0
        return accepting > 0 && conf > 0 && conf < 200
      })
      if (!climbing) return
      if (Date.now() - kaspaLastConfBumpAtRef.current < 280) return
      void refreshKaspaTip()
    }, 50)
    return () => window.clearInterval(id)
  }, [selectedChain, activeWalletId, applyLiveKaspaConfirmations, refreshKaspaTip])

  const needsKaspaConfPoll = selectedChain === 'kaspa' && kaspaNeedsLiveConfirmations(transactions)
  const needsKaspaHydrate = useMemo(() => {
    if (!needsKaspaConfPoll) return false
    return transactions.some((tx) => {
      const conf = tx.confirmations ?? 0
      if (conf >= 200) return false
      return conf <= 0 || !(tx.accepting_block_blue_score && tx.accepting_block_blue_score > 0)
    })
  }, [needsKaspaConfPoll, transactions])

  useEffect(() => {
    if (!needsKaspaConfPoll || !activeWalletId) return
    kaspaLastConfBumpAtRef.current = Date.now()
    void refreshKaspaTip()
    void refreshKaspaConfirmations()
    const tipId = window.setInterval(() => {
      void refreshKaspaTip()
    }, 80)
    const hydrateId = window.setInterval(
      () => {
        void refreshKaspaConfirmations()
      },
      needsKaspaHydrate ? 400 : 5000,
    )
    return () => {
      window.clearInterval(tipId)
      window.clearInterval(hydrateId)
    }
  }, [
    needsKaspaConfPoll,
    needsKaspaHydrate,
    activeWalletId,
    refreshKaspaTip,
    refreshKaspaConfirmations,
  ])

  const loadNetworkSettings = useCallback(async () => {
    if (!api) return
    const env = await api.networkSettings()
    setNetworkSettingsEnvelope(env)
  }, [api])

  const persistNetworkSettings = useCallback(
    async (s: NetworkSettingsDTO) => {
      if (!api) return
      setNetworkSettingsSaving(true)
      try {
        const saved = await api.updateNetworkSettings(s)
        setNetworkSettingsEnvelope((prev) => {
          if (!prev) return { settings: saved.settings, defaults: saved.settings }
          return { settings: saved.settings, defaults: prev.defaults }
        })
        setStatusMessage('Network settings saved')
        invalidateMainnetSync()
        queueMicrotask(() => {
          stopAllEventStreams()
          ensureActiveWalletLiveStream()
        })
      } finally {
        setNetworkSettingsSaving(false)
      }
    },
    [api],
  )

  const testBitcoinConnection = useCallback(
    async (b: BitcoinNetworkSettingsDTO) => {
      if (!api) throw new Error('Not ready')
      return api.testBitcoinConnection(b)
    },
    [api],
  )

  const mergeAddressBalances = useCallback(async () => {
    if (!activeWallet) return
    await mergeAddressBalancesForWallet(activeWallet.id)
  }, [activeWallet])

  const persistWalletScanLimit = useCallback(
    async (limit: number) => {
      if (!api || !activeWalletId) return
      const wid = activeWalletId
      const w = await api.updateWallet(wid, { scan_limit: limit })
      setWallets((prev) => prev.map((x) => (x.id === wid ? w : x)))
      delete addressBooksRef.current[wid]
      const snap = snapshotsRef.current[wid] ?? emptySnapshot()
      snap.addressBook = null
      snap.mainnetSynced = false
      snapshotsRef.current[wid] = snap
      invalidateMainnetSync(wid)
      if (wid === activeWalletIdRef.current) {
        setAddressBook(null)
      }
      await mergeAddressBalancesForWallet(wid)
    },
    [api, activeWalletId],
  )

  const toggleAddressGroup = useCallback((keys: string[]) => {
    setSelectedSpendUtxoKeys((prev) => {
      const next = new Set(prev)
      const allSelected = keys.length > 0 && keys.every((k) => next.has(k))
      if (allSelected) keys.forEach((k) => next.delete(k))
      else keys.forEach((k) => next.add(k))
      return next
    })
  }, [])

  const setTxLabel = useCallback(
    async (txid: string, label: string) => {
      if (!api || !activeWallet) return
      await api.setTxLabel(activeWallet.id, txid, label)
      await loadTransactionsFor(activeWallet.id)
    },
    [api, activeWallet],
  )

  const toggleSpendUtxo = useCallback((key: string) => {
    setSelectedSpendUtxoKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      selectedSpendUtxoKeysRef.current = next
      return next
    })
  }, [])

  const selectAllSpendableUtxos = useCallback(() => {
    const keys = new Set(
      utxosRef.current
        .filter((u) => utxoMatchesChain(u, selectedChainRef.current))
        .map((u) => u.key),
    )
    selectedSpendUtxoKeysRef.current = keys
    setSelectedSpendUtxoKeys(keys)
  }, [])

  const clearSpendSelection = useCallback(() => {
    const keys = new Set<string>()
    selectedSpendUtxoKeysRef.current = keys
    setSelectedSpendUtxoKeys(keys)
  }, [])

  const orderedSelectedSpendUtxos = useCallback((): UtxoDTO[] => {
    const keys = selectedSpendUtxoKeysRef.current
    return utxosRef.current.filter(
      (u) => utxoMatchesChain(u, selectedChainRef.current) && keys.has(u.key),
    )
  }, [])

  const selectedSpendKeyCountSync = useCallback((): number => {
    return selectedSpendUtxoKeysRef.current.size
  }, [])

  const isCustomSpendSelection = useCallback(() => {
    const spendable = new Set(utxos.filter((u) => utxoMatchesChain(u, selectedChain)).map((u) => u.key))
    if (spendable.size === 0 || selectedSpendUtxoKeys.size === 0) return false
    if (selectedSpendUtxoKeys.size !== spendable.size) return true
    for (const k of Array.from(selectedSpendUtxoKeys)) {
      if (!spendable.has(k)) return true
    }
    return false
  }, [utxos, selectedChain, selectedSpendUtxoKeys])

  const selectedSpendUtxos = useCallback(
    () => utxos.filter((u) => utxoMatchesChain(u, selectedChain) && selectedSpendUtxoKeys.has(u.key)),
    [utxos, selectedChain, selectedSpendUtxoKeys],
  )

  const presentSend = useCallback(
    (fromCoins = false) => {
      syncActiveWalletForChain(selectedChainRef.current)
      setSendOpenedFromCoins(fromCoins)
      const selectedCount = selectedSpendUtxoKeysRef.current.size
      if (fromCoins && selectedCount > 0) {
        setSendUsesCustomCoinSelection(true)
      } else {
        setSendUsesCustomCoinSelection(false)
        selectAllSpendableUtxos()
      }
      setSidebarSelection('dashboard')
      setShowSendWizard(true)
    },
    [selectAllSpendableUtxos],
  )

  const dismissSendWizard = useCallback(() => {
    setShowSendWizard(false)
    setSidebarSelection('dashboard')
    setSendUsesCustomCoinSelection(false)
    if (sendOpenedFromCoins) setCoinsPaneResetID(crypto.randomUUID())
    clearSpendSelection()
    setSendOpenedFromCoins(false)
  }, [sendOpenedFromCoins, clearSpendSelection])

  const markWelcomeSeen = useCallback(() => {
    UserPrefs.hasSeenWelcome = true
    setShowWelcome(false)
    if (wallets.filter((w) => walletCoin(w) === selectedChain).length === 0) {
      setIsAddingWallet(true)
    }
  }, [wallets, selectedChain])

  const beginAddWallet = useCallback(() => {
    setIsAddingWallet(true)
    setSidebarSelection('dashboard')
  }, [])

  const renameWallet = useCallback(
    async (id: string, label: string) => {
      if (!api) return
      const trimmed = label.trim()
      if (!trimmed) return
      const w = await api.updateWallet(id, { label: trimmed })
      setWallets((prev) => prev.map((wallet) => (wallet.id === id ? w : wallet)))
      setRenamingWalletId(null)
      setDraftWalletLabel(trimmed)
      setStatusMessage('Wallet renamed')
    },
    [api],
  )

  const isRefreshing = useCallback(
    (walletId?: string) => {
      if (walletId) {
        return mainnetFullScanIds.has(walletId) || refreshingWalletIds.has(walletId)
      }
      return mainnetFullScanIds.size > 0 || refreshingWalletIds.size > 0
    },
    [mainnetFullScanIds, refreshingWalletIds],
  )

  const isRefreshingChain = useCallback(
    (chain: CoinChain) =>
      wallets.some(
        (w) =>
          walletCoin(w) === chain &&
          (mainnetFullScanIds.has(w.id) || refreshingWalletIds.has(w.id)),
      ),
    [wallets, mainnetFullScanIds, refreshingWalletIds],
  )

  const refreshWallet = refreshActiveWallet

  useEffect(() => {
    document.documentElement.dataset.theme = appTheme
    document.documentElement.dataset.chain = selectedChain
  }, [appTheme, selectedChain])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setStatusMessage('Starting coordinator backend…')
        const client = await createAPIClient()
        if (cancelled) return
        apiRef.current = client
        setApi(client)
      } catch (e) {
        if (!cancelled) {
          setError(startupError(e))
          setStatusMessage('Could not start')
        }
      }
    })()
    return () => {
      cancelled = true
      persistActiveSnapshot()
      stopAllEventStreams()
    }
  }, [])

  useEffect(() => {
    setReady(true)
  }, [])

  useEffect(() => {
    if (!api || bootstrappedRef.current) return
    bootstrappedRef.current = true
    setStatusMessage('Loading wallets…')
    void reloadStatus().catch((e) => {
      setWalletsBootstrapped(true)
      setStatusMessage(e instanceof Error ? e.message : 'Could not load wallets')
    })
    void loadNetworkSettings()
    void refreshFiatPrices()
  }, [api, reloadStatus, loadNetworkSettings, refreshFiatPrices])

  useEffect(() => {
    const onFocus = (): void => {
      void pollActiveWalletIfIdle()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [pollActiveWalletIfIdle])

  useEffect(() => {
    if (!api) return
    ensureActiveWalletLiveStream()
  }, [api, activeWalletId])

  useEffect(() => {
    if (!api) return
    void refreshFiatPrices()
    const id = window.setInterval(() => {
      void refreshFiatPrices()
    }, 60_000)
    return () => window.clearInterval(id)
  }, [api, refreshFiatPrices])

  useEffect(() => {
    if (!api) return
    const onOnline = (): void => {
      if (!networkWasOfflineRef.current) return
      networkWasOfflineRef.current = false
      invalidateMainnetSync()
      const list = walletsRef.current
      if (list.length > 0) {
        void scheduleBackgroundSync(list)
      }
    }
    const onOffline = (): void => {
      networkWasOfflineRef.current = true
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [api, scheduleBackgroundSync])

  const value: AppContextValue = {
    ready,
    walletsBootstrapped,
    error,
    api,
    buildLabel,
    statusMessage,
    setStatusMessage,
    wallets,
    activeWallet,
    activeWalletId,
    activeWalletByCoin,
    walletConfigured,
    walletLabel,
    walletBalances,
    selectedChain,
    setSelectedChain,
    selectWallet,
    sidebarSelection,
    setSidebarSelection,
    showSendWizard,
    presentSend,
    openSendWizard: presentSend,
    closeSendWizard: dismissSendWizard,
    dismissSendWizard,
    isAddingWallet,
    setIsAddingWallet,
    showWelcome,
    markWelcomeSeen,
    showReceiveSheet,
    setShowReceiveSheet,
    utxos,
    selectedSpendUtxoKeys,
    sendUsesCustomCoinSelection,
    setSendUsesCustomCoinSelection,
    sendOpenedFromCoins,
    toggleSpendUtxo,
    selectAllSpendableUtxos,
    clearSpendSelection,
    pruneSpendSelection,
    isCustomSpendSelection,
    selectedSpendUtxos,
    orderedSelectedSpendUtxos,
    selectedSpendKeyCountSync,
    coinsPaneResetID,
    transactions,
    addressBook,
    receiveAddresses,
    balanceSompi,
    balanceKasValue,
    balanceText,
    balanceFiatText,
    isScanning,
    scanDetailMessage,
    isRefreshing,
    isRefreshingChain,
    refreshingWalletIds,
    appTheme,
    setAppTheme,
    displayCurrency,
    setDisplayCurrency,
    chunkAddresses,
    setChunkAddresses,
    bitcoinDisplayUnit,
    setBitcoinDisplayUnit,
    fiatTick,
    networkSettingsEnvelope,
    networkSettings,
    networkSettingsSaving,
    loadWallets,
    reloadStatus,
    activateWallet,
    refreshActiveWallet,
    discoverWallet,
    refreshAllWallets,
    refreshAfterSuccessfulSend,
    notePendingSend,
    refreshWallet,
    pollActiveWalletIfIdle,
    loadTransactions,
    refreshKaspaConfirmations,
    loadNetworkSettings,
    persistNetworkSettings,
    testBitcoinConnection,
    refreshFiatPrices,
    mergeAddressBalances,
    persistWalletScanLimit,
    toggleAddressGroup,
    setTxLabel,
    renamingWalletId,
    setRenamingWalletId,
    draftWalletLabel,
    setDraftWalletLabel,
    renameWallet,
    applyLocalWalletLabel,
    beginAddWallet,
    syncStatusByWallet,
    activeSyncStatus,
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp outside AppProvider')
  return ctx
}
