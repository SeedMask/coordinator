import type { CoinChain, WalletDTO } from '@renderer/api/types'
import { walletCoin } from '@renderer/api/types'
import { UserPrefs } from '@renderer/utils/userPrefs'

export function orderedWalletsForChain(wallets: WalletDTO[], chain: CoinChain): WalletDTO[] {
  const chainWallets = wallets.filter((w) => walletCoin(w) === chain)
  const saved = UserPrefs.walletOrder(chain)
  if (!saved.length) return chainWallets

  const byId = new Map(chainWallets.map((w) => [w.id, w]))
  const ordered: WalletDTO[] = []
  for (const id of saved) {
    const wallet = byId.get(id)
    if (wallet) {
      ordered.push(wallet)
      byId.delete(id)
    }
  }
  for (const wallet of chainWallets) {
    if (byId.has(wallet.id)) ordered.push(wallet)
  }
  return ordered
}

export function persistWalletOrder(chain: CoinChain, ordered: WalletDTO[]): void {
  UserPrefs.setWalletOrder(
    chain,
    ordered.map((w) => w.id),
  )
}

export function moveWalletInOrder(ids: string[], fromId: string, toId: string): string[] {
  if (fromId === toId) return ids
  const from = ids.indexOf(fromId)
  const to = ids.indexOf(toId)
  if (from < 0 || to < 0) return ids
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, fromId)
  return next
}

export function insertWalletOrder(
  ids: string[],
  dragId: string,
  targetId: string,
  before: boolean,
): string[] {
  if (dragId === targetId) return ids
  const without = ids.filter((id) => id !== dragId)
  const targetIndex = without.indexOf(targetId)
  if (targetIndex < 0) return ids
  const insertAt = before ? targetIndex : targetIndex + 1
  return [...without.slice(0, insertAt), dragId, ...without.slice(insertAt)]
}

export function previewWalletOrder(
  ids: string[],
  dragId: string | null,
  overId: string | null,
  before: boolean,
): string[] {
  if (!dragId || !overId) return ids
  return insertWalletOrder(ids, dragId, overId, before)
}
