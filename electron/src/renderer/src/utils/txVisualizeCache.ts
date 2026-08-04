import type { APIClient } from '@renderer/api/client'
import type { TxVisualizeResponse, WalletTxDTO } from '@renderer/api/types'
import { txId, txIdAliases } from '@renderer/utils/txHelpers'

const cache = new Map<string, TxVisualizeResponse>()

export function txVisualizeCacheKey(walletId: string, txid: string): string {
  return `${walletId}:${txid.toLowerCase().replace(/^0x/, '')}`
}

export function getCachedTxVisualize(walletId: string, txid: string): TxVisualizeResponse | undefined {
  for (const alias of txIdAliases(txid)) {
    const hit = cache.get(txVisualizeCacheKey(walletId, alias))
    if (hit) return hit
  }
  return undefined
}

export function setCachedTxVisualize(walletId: string, txid: string, res: TxVisualizeResponse): void {
  for (const alias of txIdAliases(txid)) {
    cache.set(txVisualizeCacheKey(walletId, alias), res)
  }
}

/** Warm tx-details cache after history loads so the sheet opens instantly. */
export async function prefetchWalletTxVisualize(
  api: APIClient,
  walletId: string,
  txs: WalletTxDTO[],
  maxCount = 24,
): Promise<void> {
  const pending = txs
    .slice(0, maxCount)
    .map((tx) => txId(tx))
    .filter((id) => id.length > 0 && !getCachedTxVisualize(walletId, id))

  // Parallel, limited concurrency — old sequential + 120ms sleep made details feel cold.
  const concurrency = 4
  for (let i = 0; i < pending.length; i += concurrency) {
    const batch = pending.slice(i, i + concurrency)
    await Promise.all(
      batch.map(async (id) => {
        try {
          const res = await api.walletTxVisualize(walletId, id)
          setCachedTxVisualize(walletId, id, res)
        } catch {
          /* background prefetch */
        }
      }),
    )
  }
}
