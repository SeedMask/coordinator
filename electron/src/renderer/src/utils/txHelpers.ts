import type { BitcoinDisplayUnit, CoinChain, WalletTxDTO } from '@renderer/api/types'
import { looksLikeBitcoinAddress, looksLikeKaspaAddress } from '@renderer/api/types'
import { formatCoinUnitsLabel } from '@renderer/utils/coinDisplay'

/** Drop obvious cross-chain leakage; do not require counterparty to look like a valid address. */
export function txMatchesChain(tx: WalletTxDTO, chain: CoinChain): boolean {
  const cp = (tx.counterparty ?? '').trim()
  if (!cp) return true
  const looksBitcoin = looksLikeBitcoinAddress(cp)
  const looksKaspa = looksLikeKaspaAddress(cp)
  if (chain === 'bitcoin') return !(looksKaspa && !looksBitcoin)
  return !(looksBitcoin && !looksKaspa)
}

export function filterTransactionsForChain(txs: WalletTxDTO[], chain: CoinChain): WalletTxDTO[] {
  return txs.filter((tx) => txMatchesChain(tx, chain))
}

export function normalizeTxId(id: string): string {
  return (id || '').trim().toLowerCase().replace(/^0x/i, '')
}

/** Byte-reversed txid variant (blockchain.info hash vs Esplora txid). */
export function txIdAliases(id: string): string[] {
  const norm = normalizeTxId(id)
  if (!norm) return []
  if (norm.length !== 64) return [norm]
  const reversed = [...norm.match(/.{2}/g) ?? []].reverse().join('')
  return reversed !== norm ? [norm, reversed] : [norm]
}

export function txId(tx: WalletTxDTO): string {
  return normalizeTxId(tx.transaction_id ?? tx.txid ?? tx.id ?? '')
}

export function dedupeWalletTransactions(txs: WalletTxDTO[], chain: CoinChain): WalletTxDTO[] {
  const aliasToKey = new Map<string, string>()
  const byId = new Map<string, WalletTxDTO>()
  for (const tx of txs) {
    const tid = txId(tx)
    if (!tid) continue
    let key = tid
    for (const alias of txIdAliases(tid)) {
      const existing = aliasToKey.get(alias)
      if (existing) {
        key = existing
        break
      }
    }
    const prev = byId.get(key)
    if (!prev) {
      byId.set(key, tx)
    } else {
      // Prefer newer block time; never let confirmations go backwards (Kaspa live tip races).
      const prevConf = prev.confirmations ?? 0
      const nextConf = tx.confirmations ?? 0
      const newer = txBlockTime(tx) >= txBlockTime(prev) ? tx : prev
      const other = newer === tx ? prev : tx
      const frozenAccepting =
        (prev.accepting_block_blue_score ?? 0) > 0
          ? prev.accepting_block_blue_score
          : (tx.accepting_block_blue_score ?? 0) > 0
            ? tx.accepting_block_blue_score
            : newer.accepting_block_blue_score ?? other.accepting_block_blue_score
      byId.set(key, {
        ...newer,
        confirmations: Math.max(prevConf, nextConf),
        accepting_block_blue_score: frozenAccepting,
      })
    }
    for (const alias of txIdAliases(tid)) {
      aliasToKey.set(alias, key)
    }
  }
  return filterTransactionsForChain(
    Array.from(byId.values())
      .map(normalizeWalletTx)
      .sort((a, b) => txBlockTime(b) - txBlockTime(a)),
    chain,
  )
}

export function normalizeAddressKey(addr: string, chain: CoinChain): string {
  const trimmed = addr.trim()
  if (!trimmed) return ''
  if (chain === 'kaspa') {
    const lower = trimmed.toLowerCase()
    if (lower.startsWith('kaspa:')) {
      return `kaspa:${trimmed.slice(trimmed.indexOf(':') + 1).toLowerCase()}`
    }
    return lower
  }
  return trimmed.toLowerCase()
}

/** Transfer to/from another address in the same wallet (change, self-send) — not external flow. */
export function txIsInternalTransfer(
  tx: WalletTxDTO,
  walletAddresses: ReadonlySet<string>,
  chain: CoinChain,
): boolean {
  const cp = (tx.counterparty ?? '').trim()
  if (!cp) return false
  const cpKey = normalizeAddressKey(cp, chain)
  if (!cpKey) return false
  for (const addr of Array.from(walletAddresses)) {
    if (normalizeAddressKey(addr, chain) === cpKey) return true
  }
  return false
}

export function txAmount(tx: WalletTxDTO): number {
  if (tx.amount_btc != null && tx.amount_btc > 0) return tx.amount_btc
  if (tx.amount_sats != null && tx.amount_sats > 0) return tx.amount_sats / 1e8
  if (tx.amount_sompi != null && tx.amount_sompi > 0) return tx.amount_sompi / 1e8
  if (tx.amount_kas != null && tx.amount_kas > 0) return tx.amount_kas
  const fallback = tx.amount_btc ?? (tx.amount_sats != null ? tx.amount_sats / 1e8 : null) ?? tx.amount_kas ?? 0
  return Math.abs(fallback)
}

export function txIsReceived(tx: WalletTxDTO): boolean {
  const dir = (tx.direction ?? '').trim().toLowerCase()
  if (dir === 'received' || dir === 'receive' || dir === 'in' || dir === 'incoming') return true
  if (dir === 'sent' || dir === 'send' || dir === 'out' || dir === 'outgoing') return false
  return false
}

/** Normalize API / cached rows so chart + list agree on direction and positive magnitudes. */
export function normalizeWalletTx(tx: WalletTxDTO): WalletTxDTO {
  const dir = (tx.direction ?? '').trim().toLowerCase()
  let direction = tx.direction
  if (dir === 'received' || dir === 'receive' || dir === 'in' || dir === 'incoming') {
    direction = 'received'
  } else if (dir === 'sent' || dir === 'send' || dir === 'out' || dir === 'outgoing') {
    direction = 'sent'
  }
  const normalized: WalletTxDTO = { ...tx, direction }
  const amount = txAmount(normalized)
  if (amount > 0) {
    normalized.amount_btc = amount
    normalized.amount_sats = Math.round(amount * 1e8)
    normalized.amount_kas = amount
    normalized.amount_sompi = Math.round(amount * 1e8)
  }
  return normalized
}

export function txBlockTime(tx: WalletTxDTO): number {
  if (tx.block_time != null && tx.block_time > 0) return tx.block_time
  if (tx.timestamp) {
    const trimmed = tx.timestamp.trim()
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed)
      if (n > 0) return n > 1_000_000_000_000 ? Math.floor(n / 1000) : n
    }
    const ms = Date.parse(trimmed)
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000)
  }
  return 0
}

export function txLabel(tx: WalletTxDTO): string {
  return tx.label?.trim() ?? ''
}

const TX_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

export function formatTxDate(tx: WalletTxDTO): string {
  const t = txBlockTime(tx)
  if (t <= 0) return 'Pending'
  const d = new Date(t * 1000)
  return `${d.getDate()}. ${TX_MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

export function formatTxClock(tx: WalletTxDTO): string {
  const t = txBlockTime(tx)
  if (t <= 0) return ''
  const d = new Date(t * 1000)
  const hours = d.getHours().toString().padStart(2, '0')
  const minutes = d.getMinutes().toString().padStart(2, '0')
  return `${hours}:${minutes}`
}

export function formatTxTime(tx: WalletTxDTO): string {
  const date = formatTxDate(tx)
  const clock = formatTxClock(tx)
  if (!date) return ''
  return clock ? `${date}, ${clock}` : date
}

export function formatTxAmount(
  tx: WalletTxDTO,
  chain: CoinChain,
  bitcoinUnit: BitcoinDisplayUnit = 'btc',
): string {
  const sign = txIsReceived(tx) ? '+' : '-'
  return `${sign}${formatCoinUnitsLabel(txAmount(tx), chain, bitcoinUnit)}`
}

export function formatTxConfirmations(tx: WalletTxDTO, chain: CoinChain): string {
  const conf = tx.confirmations ?? 0
  const hasBlockTime = txBlockTime(tx) > 0
  if (chain === 'kaspa') {
    // conf=0 is pending (just broadcast or not yet accepted) — even if we stamped a local time for sorting.
    if (conf <= 0) return 'Unconfirmed'
    if (conf >= 200) return 'Confirmed'
    if (conf === 1) return '1 confirmation'
    return `${conf} confirmations`
  }
  // Bitcoin: use real tip−height depth only. Mined with unknown tip → Confirmed.
  if (conf <= 0 && !hasBlockTime && !(tx.block_height && tx.block_height > 0)) return 'Unconfirmed'
  if (conf <= 0) return 'Confirmed'
  if (conf === 1) return '1 confirmation'
  if (conf < 3) return `${conf} confirmations`
  // ≥3: keep showing the real depth in the row status would be noisy; "Confirmed" is fine on the list.
  return 'Confirmed'
}

/** True while Kaspa confirmation depth is still climbing toward "Confirmed" (≥200). */
export function kaspaNeedsLiveConfirmations(transactions: WalletTxDTO[]): boolean {
  return transactions.some((tx) => {
    const conf = tx.confirmations ?? 0
    if (conf <= 0) return true
    return conf > 0 && conf < 200
  })
}

/** Confirmations counted toward the 3-bar pending indicator (Bitcoin only). */
export function txConfirmationProgress(tx: WalletTxDTO, chain: CoinChain): number | null {
  if (chain !== 'bitcoin') return null
  const conf = tx.confirmations ?? 0
  const hasBlockTime = txBlockTime(tx) > 0
  const hasHeight = (tx.block_height ?? 0) > 0
  if (conf >= 3 || ((conf <= 0) && (hasBlockTime || hasHeight))) return null
  if (conf <= 0 && !hasBlockTime && !hasHeight) return 0
  return Math.min(2, Math.max(0, conf))
}

export function txCanRbf(tx: WalletTxDTO, chain: CoinChain): boolean {
  if (chain !== 'bitcoin') return false
  if (txIsReceived(tx)) return false
  if ((tx.confirmations ?? 0) > 0 || txBlockTime(tx) > 0 || (tx.block_height ?? 0) > 0) return false
  return tx.rbf === true
}
