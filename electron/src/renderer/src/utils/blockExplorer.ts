import type { BitcoinNetworkSettingsDTO, CoinChain, KaspaNetworkSettingsDTO, NetworkSettingsDTO } from '@renderer/api/types'
import { resolveBitcoinPublicPreset } from '@renderer/utils/networkSettings'
import { txIdAliases } from '@renderer/utils/txHelpers'

const KASPA_TX_EXPLORER_DEFAULT = 'https://kaspa.stream/transactions/{txid}'
const KASPA_ADDRESS_EXPLORER_DEFAULT = 'https://kaspa.stream/addresses/{address}'

export type TxExplorerChoice = { id: string; label: string; url: string; base: string }

function kaspaTxTemplate(kaspa?: KaspaNetworkSettingsDTO | null): string {
  const template = kaspa?.explorer_tx_template?.trim()
  if (!template) return KASPA_TX_EXPLORER_DEFAULT
  const low = template.toLowerCase()
  if (low.includes('kas.fyi') || low.includes('explorer.kaspa.org')) {
    return KASPA_TX_EXPLORER_DEFAULT
  }
  return template
}

function bitcoinSettingsFrom(
  networkSettings?: Pick<NetworkSettingsDTO, 'bitcoin' | 'kaspa'> | BitcoinNetworkSettingsDTO | null,
): BitcoinNetworkSettingsDTO | null | undefined {
  if (!networkSettings) return null
  return 'bitcoin' in networkSettings ? networkSettings.bitcoin : (networkSettings as BitcoinNetworkSettingsDTO)
}

/** Bitcoin explorers offered when opening a Tx ID from the dashboard. */
export function bitcoinTxExplorerChoices(
  txid: string,
  bitcoin?: BitcoinNetworkSettingsDTO | null,
): TxExplorerChoice[] {
  const id = txid.trim()
  if (!id) return []
  const preset = resolveBitcoinPublicPreset(bitcoin?.public_preset || 'recommended')
  const mempool = {
    id: 'mempool',
    label: 'mempool.space',
    base: 'https://mempool.space',
    url: `https://mempool.space/tx/${id}`,
  }
  const blockstream = {
    id: 'blockstream',
    label: 'blockstream.info',
    base: 'https://blockstream.info',
    url: `https://blockstream.info/tx/${id}`,
  }
  if (preset === 'mempool_space') return [mempool]
  if (preset === 'blockstream') return [blockstream]
  return [mempool, blockstream]
}

/**
 * Resolve a txid that explorers recognize.
 * Older blockchain.info imports stored a byte-reversed id — try aliases.
 */
const _resolvedTxIdCache = new Map<string, string>()
const _resolvedTxIdInflight = new Map<string, Promise<string>>()

export async function resolveBitcoinExplorerTxId(
  txid: string,
  bitcoin?: BitcoinNetworkSettingsDTO | null,
): Promise<string> {
  const aliases = txIdAliases(txid)
  const primary = aliases[0] || txid.trim()
  if (!primary) return ''
  if (aliases.length <= 1) return primary

  const cached = _resolvedTxIdCache.get(primary)
  if (cached) return cached
  for (const alias of aliases) {
    const hit = _resolvedTxIdCache.get(alias)
    if (hit) {
      for (const a of aliases) _resolvedTxIdCache.set(a, hit)
      return hit
    }
  }

  const existing = _resolvedTxIdInflight.get(primary)
  if (existing) return existing

  const apiBase = (bitcoin?.esplora_primary || 'https://blockstream.info/api').replace(/\/$/, '')

  const job = (async () => {
    for (const candidate of aliases) {
      try {
        const res = await fetch(`${apiBase}/tx/${candidate}`, {
          signal: AbortSignal.timeout(5_000),
        })
        if (res.ok) {
          for (const a of aliases) _resolvedTxIdCache.set(a, candidate)
          return candidate
        }
      } catch {
        /* try next alias / fall through */
      }
    }
    for (const a of aliases) _resolvedTxIdCache.set(a, primary)
    return primary
  })()

  _resolvedTxIdInflight.set(primary, job)
  try {
    return await job
  } finally {
    _resolvedTxIdInflight.delete(primary)
  }
}

export async function openBitcoinExplorer(
  base: string,
  txid: string,
  bitcoin?: BitcoinNetworkSettingsDTO | null,
): Promise<void> {
  const resolved = await resolveBitcoinExplorerTxId(txid, bitcoin)
  const url = `${base.replace(/\/$/, '')}/tx/${resolved}`
  if (window.seedmask?.openExternal) {
    await window.seedmask.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function txExplorerUrl(
  txid: string,
  chain: CoinChain,
  networkSettings?: Pick<NetworkSettingsDTO, 'bitcoin' | 'kaspa'> | BitcoinNetworkSettingsDTO | null,
): string | null {
  const bitcoin = bitcoinSettingsFrom(networkSettings)
  const kaspa =
    networkSettings && 'kaspa' in networkSettings ? networkSettings.kaspa : undefined

  if (chain === 'bitcoin') {
    const template = bitcoin?.explorer_tx_template?.trim()
    if (template) return template.replace('{txid}', txid)
    const preset = resolveBitcoinPublicPreset(bitcoin?.public_preset || 'recommended')
    if (preset === 'blockstream') return `https://blockstream.info/tx/${txid}`
    return `https://mempool.space/tx/${txid}`
  }
  if (chain === 'kaspa') {
    return kaspaTxTemplate(kaspa).replace('{txid}', txid)
  }
  return null
}

export function addressExplorerUrl(
  address: string,
  chain: CoinChain,
  kaspa?: KaspaNetworkSettingsDTO | null,
  bitcoin?: BitcoinNetworkSettingsDTO | null,
): string | null {
  if (chain === 'kaspa') {
    const template = kaspaTxTemplate(kaspa)
    if (template.includes('/transactions/')) {
      return KASPA_ADDRESS_EXPLORER_DEFAULT.replace('{address}', encodeURIComponent(address))
    }
    return template.replace('{txid}', encodeURIComponent(address))
  }
  if (chain === 'bitcoin') {
    const preset = resolveBitcoinPublicPreset(bitcoin?.public_preset || 'recommended')
    if (preset === 'blockstream') {
      return `https://blockstream.info/address/${encodeURIComponent(address)}`
    }
    return `https://mempool.space/address/${encodeURIComponent(address)}`
  }
  return null
}
