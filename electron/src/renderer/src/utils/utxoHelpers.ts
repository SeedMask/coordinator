import type { UtxoDTO } from '@renderer/api/types'
import { looksLikeKaspaAddress, utxoCoinAmount } from '@renderer/api/types'

export interface UtxoAddressGroup {
  id: string
  address: string
  utxos: UtxoDTO[]
  addressIndex: number
  isChange: boolean
  totalSompi: number
  totalCoins: number
  keys: string[]
}

function utxoGroupKey(utxo: UtxoDTO): string {
  if (looksLikeKaspaAddress(utxo.address)) {
    return utxo.address.trim().toLowerCase()
  }
  return utxo.address
}

export function groupUtxosByAddress(utxos: UtxoDTO[]): UtxoAddressGroup[] {
  const map = new Map<string, UtxoDTO[]>()
  for (const u of utxos) {
    const key = utxoGroupKey(u)
    const list = map.get(key) ?? []
    list.push(u)
    map.set(key, list)
  }
  return Array.from(map.entries())
    .map(([address, list]) => {
      const sorted = [...list].sort((a, b) => {
        if (b.amount !== a.amount) return b.amount - a.amount
        const tx = a.transaction_id.localeCompare(b.transaction_id)
        if (tx !== 0) return tx
        return a.output_index - b.output_index
      })
      const totalSompi = sorted.reduce((s, u) => s + u.amount, 0)
      return {
        id: address,
        address,
        utxos: sorted,
        addressIndex: sorted[0]?.address_index ?? 0,
        isChange: sorted[0]?.is_change ?? false,
        totalSompi,
        totalCoins: totalSompi / 1e8,
        keys: sorted.map((u) => u.key),
      }
    })
    .sort((lhs, rhs) => {
      if (lhs.isChange !== rhs.isChange) return lhs.isChange ? 1 : -1
      if (lhs.addressIndex !== rhs.addressIndex) return lhs.addressIndex - rhs.addressIndex
      return lhs.address.localeCompare(rhs.address)
    })
}

export function isGroupFullySelected(group: UtxoAddressGroup, selected: Set<string>): boolean {
  return group.utxos.length > 0 && group.utxos.every((u) => selected.has(u.key))
}

export function isGroupPartiallySelected(group: UtxoAddressGroup, selected: Set<string>): boolean {
  const any = group.utxos.some((u) => selected.has(u.key))
  return any && !isGroupFullySelected(group, selected)
}

export function rowLooksUsed(row: {
  used?: boolean
  is_used?: boolean
  balance_sompi?: number
}): boolean {
  return Boolean(row.is_used) || Boolean(row.used) || (row.balance_sompi ?? 0) > 0
}

/** First unused index in rows; falls back to book hint only when that row is unused. */
export function firstUnusedAddressIndex(
  rows: Array<{ index: number; used?: boolean; is_used?: boolean; balance_sompi?: number; address?: string }>,
  bookIndex?: number,
): { index: number; address: string } | null {
  if (!rows.length) return null
  if (bookIndex != null) {
    const hinted = rows.find((r) => r.index === bookIndex)
    if (hinted && !rowLooksUsed(hinted)) {
      return { index: hinted.index, address: hinted.address ?? '' }
    }
  }
  const unused = rows.find((r) => !rowLooksUsed(r))
  if (unused) return { index: unused.index, address: unused.address ?? '' }
  const last = rows[rows.length - 1]
  return { index: last.index, address: last.address ?? '' }
}

export function mergeAddressBookWithUtxos(
  base: {
    receive: Array<{
      index: number
      address: string
      balance_sompi?: number
      balance_kas?: number
      balance_btc?: number
      used?: boolean
      is_used?: boolean
      last_used_at?: number
    }>
    change: Array<{
      index: number
      address: string
      balance_sompi?: number
      balance_kas?: number
      balance_btc?: number
      used?: boolean
      is_used?: boolean
      last_used_at?: number
    }>
    next_receive_index?: number
    next_receive_address?: string
    next_change_index?: number
    next_change_address?: string
  },
  utxos: UtxoDTO[],
  chain: 'kaspa' | 'bitcoin' = 'kaspa',
): typeof base {
  const byAddr = new Map<string, number>()
  for (const u of utxos) {
    byAddr.set(u.address, (byAddr.get(u.address) ?? 0) + u.amount)
  }
  const overlay = (rows: typeof base.receive) =>
    rows.map((r) => {
      const sompi = byAddr.get(r.address) ?? r.balance_sompi ?? 0
      const coins = sompi / 1e8
      return {
        ...r,
        balance_sompi: sompi,
        balance_kas: chain === 'kaspa' ? coins : r.balance_kas ?? 0,
        balance_btc: chain === 'bitcoin' ? coins : r.balance_btc ?? 0,
        is_used: sompi > 0 || Boolean(r.is_used) || Boolean(r.used),
        used: sompi > 0 || Boolean(r.is_used) || Boolean(r.used),
      }
    })
  const receive = overlay(base.receive)
  const change = overlay(base.change)
  const nextRecv = firstUnusedAddressIndex(receive, base.next_receive_index)
  const nextChg = firstUnusedAddressIndex(change, base.next_change_index)
  return {
    ...base,
    receive,
    change,
    next_receive_index: nextRecv?.index ?? base.next_receive_index,
    next_receive_address: nextRecv?.address || base.next_receive_address,
    next_change_index: nextChg?.index ?? base.next_change_index,
    next_change_address: nextChg?.address || base.next_change_address,
  }
}

export function addressRowBalance(row: { balance_sompi?: number; balance_kas?: number; balance_btc?: number }, chain: 'kaspa' | 'bitcoin'): number {
  if (chain === 'bitcoin') {
    return row.balance_btc ?? (row.balance_sompi ?? 0) / 1e8
  }
  return row.balance_kas ?? (row.balance_sompi ?? 0) / 1e8
}

export function addressRowHasBalance(row: { balance_sompi?: number; balance_kas?: number; balance_btc?: number; balance_sats?: number }): boolean {
  return (row.balance_sompi ?? row.balance_sats ?? 0) > 0 || (row.balance_kas ?? 0) > 0 || (row.balance_btc ?? 0) > 0
}

export function formatUtxoDepositLine(group: UtxoAddressGroup): string | null {
  if (group.utxos.length <= 1) return null
  const parts = group.utxos.map((u) => utxoCoinAmount(u).toFixed(8))
  return `${group.utxos.length} deposits: ${parts.join(' + ')}`
}
