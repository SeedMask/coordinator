import type { AppTheme, BitcoinDisplayUnit, CoinChain, DisplayCurrency, TimeFormat } from '@renderer/api/types'

const KEYS = {
  theme: 'seedmask.theme',
  chain: 'seedmask.chain',
  currency: 'seedmask.currency',
  welcome: 'seedmask.hasSeenWelcome',
  chunkAddresses: 'seedmask.chunkAddresses',
  bitcoinDisplayUnit: 'seedmask.bitcoinDisplayUnit',
  timeFormat: 'seedmask.timeFormat',
  walletOrder: 'seedmask.walletOrder',
  walletStripHiddenBalances: 'seedmask.walletStripHiddenBalances',
} as const

type WalletOrderStore = Partial<Record<CoinChain, string[]>>

function readWalletOrderStore(): WalletOrderStore {
  try {
    const raw = localStorage.getItem(KEYS.walletOrder)
    if (!raw) return {}
    return JSON.parse(raw) as WalletOrderStore
  } catch {
    return {}
  }
}

export const UserPrefs = {
  get appTheme(): AppTheme {
    return (localStorage.getItem(KEYS.theme) as AppTheme) || 'dark'
  },
  set appTheme(v: AppTheme) {
    localStorage.setItem(KEYS.theme, v)
  },
  get selectedChain(): CoinChain {
    return (localStorage.getItem(KEYS.chain) as CoinChain) || 'kaspa'
  },
  set selectedChain(v: CoinChain) {
    localStorage.setItem(KEYS.chain, v)
  },
  get displayCurrency(): DisplayCurrency {
    return (localStorage.getItem(KEYS.currency) as DisplayCurrency) || 'USD'
  },
  set displayCurrency(v: DisplayCurrency) {
    localStorage.setItem(KEYS.currency, v)
  },
  get hasSeenWelcome(): boolean {
    return localStorage.getItem(KEYS.welcome) === '1'
  },
  set hasSeenWelcome(v: boolean) {
    localStorage.setItem(KEYS.welcome, v ? '1' : '0')
  },
  get chunkAddresses(): boolean {
    const v = localStorage.getItem(KEYS.chunkAddresses)
    if (v === null) return true
    return v === '1'
  },
  set chunkAddresses(v: boolean) {
    localStorage.setItem(KEYS.chunkAddresses, v ? '1' : '0')
  },
  get bitcoinDisplayUnit(): BitcoinDisplayUnit {
    return (localStorage.getItem(KEYS.bitcoinDisplayUnit) as BitcoinDisplayUnit) || 'btc'
  },
  set bitcoinDisplayUnit(v: BitcoinDisplayUnit) {
    localStorage.setItem(KEYS.bitcoinDisplayUnit, v)
  },
  get timeFormat(): TimeFormat {
    const v = localStorage.getItem(KEYS.timeFormat)
    if (v === '12h' || v === '24h' || v === 'system') return v
    return 'system'
  },
  set timeFormat(v: TimeFormat) {
    localStorage.setItem(KEYS.timeFormat, v)
  },
  walletOrder(chain: CoinChain): string[] {
    const store = readWalletOrderStore()
    return store[chain] ?? []
  },
  setWalletOrder(chain: CoinChain, ids: string[]) {
    const store = readWalletOrderStore()
    store[chain] = ids
    localStorage.setItem(KEYS.walletOrder, JSON.stringify(store))
  },
  get walletStripHiddenBalanceIds(): string[] {
    try {
      const value = JSON.parse(localStorage.getItem(KEYS.walletStripHiddenBalances) || '[]')
      return Array.isArray(value)
        ? value.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : []
    } catch {
      return []
    }
  },
  set walletStripHiddenBalanceIds(ids: string[]) {
    localStorage.setItem(KEYS.walletStripHiddenBalances, JSON.stringify(Array.from(new Set(ids))))
  },
}
