import type { AddressBookResponse, CoinChain, UtxoDTO, WalletSnapshot } from '@renderer/api/types'
import { normalizeUtxo } from '@renderer/api/types'

const STORAGE_KEY = 'seedmask.walletSnapshots.v1'

export function emptySnapshot(): WalletSnapshot {
  return {
    balanceText: '0.00000000',
    balanceValue: 0,
    utxos: [],
    transactions: [],
    receiveAddresses: [],
    addressBook: null,
  }
}

export function withoutBalances(book: AddressBookResponse): AddressBookResponse {
  return {
    ...book,
    receive: book.receive.map((r) => ({ ...r, balance_sompi: 0, balance_kas: 0 })),
    change: book.change.map((r) => ({ ...r, balance_sompi: 0, balance_kas: 0 })),
  }
}

function normalizeStoredUtxos(raw: unknown): UtxoDTO[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((row): row is Record<string, unknown> => row != null && typeof row === 'object')
    .map((row) => normalizeUtxo(row))
}

export function loadPersistedSnapshots(): Record<string, WalletSnapshot> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, WalletSnapshot>
    const out: Record<string, WalletSnapshot> = {}
    for (const [walletId, snap] of Object.entries(parsed)) {
      if (!snap || typeof snap !== 'object') continue
      out[walletId] = {
        balanceText: String(snap.balanceText ?? '0.00000000'),
        balanceValue: Number(snap.balanceValue ?? 0),
        utxos: normalizeStoredUtxos(snap.utxos),
        transactions: Array.isArray(snap.transactions) ? snap.transactions : [],
        receiveAddresses: Array.isArray(snap.receiveAddresses) ? snap.receiveAddresses : [],
        addressBook: snap.addressBook ?? null,
        mainnetSynced: Boolean(snap.mainnetSynced),
        coin: snap.coin === 'bitcoin' || snap.coin === 'kaspa' ? snap.coin : undefined,
      }
    }
    return out
  } catch {
    return {}
  }
}

export function persistSnapshotsToDisk(snapshots: Record<string, WalletSnapshot>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots))
  } catch {
    /* storage full or unavailable */
  }
}
