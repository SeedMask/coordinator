import type { BitcoinNetworkSettingsDTO, KaspaNetworkSettingsDTO, NetworkSettingsDTO } from '@renderer/api/types'

export type BitcoinServerMode = 'public' | 'bitcoin_core' | 'electrum'
export type BitcoinPublicPreset = 'recommended' | 'mempool_space' | 'blockstream'
export type KaspaRpcMode = 'resolver' | 'custom'
export type KaspaHistoryMode = 'public' | 'disabled' | 'custom'

/** Community Kaspa address/history API used when Transaction history is Public. */
export const KASPA_PUBLIC_HISTORY_API = 'https://api.kaspa.org'
export type CoinChainFilter = 'bitcoin' | 'kaspa'

export const BITCOIN_SERVER_MODES: {
  id: BitcoinServerMode
  label: string
  subtitle: string
  icon: 'globe' | 'desktop' | 'lock-shield'
}[] = [
  { id: 'public', label: 'Public server', subtitle: 'Hosted Esplora', icon: 'globe' },
  { id: 'bitcoin_core', label: 'Bitcoin Core', subtitle: 'Your node RPC', icon: 'desktop' },
  { id: 'electrum', label: 'Private Electrum', subtitle: 'Your Electrum server', icon: 'lock-shield' },
]

export const BITCOIN_PUBLIC_PRESETS: {
  id: BitcoinPublicPreset
  label: string
  subtitle: string
  suggested?: boolean
}[] = [
  {
    id: 'recommended',
    label: 'Recommended',
    subtitle: 'Curated defaults with backup servers if one is slow.',
    suggested: true,
  },
  {
    id: 'mempool_space',
    label: 'mempool.space',
    subtitle: 'Use mempool.space only — no other providers.',
  },
  {
    id: 'blockstream',
    label: 'Blockstream',
    subtitle: 'Use Blockstream only — no other providers.',
  },
]

export const KASPA_RPC_MODES: {
  id: KaspaRpcMode
  label: string
  subtitle: string
  suggested?: boolean
}[] = [
  {
    id: 'resolver',
    label: 'Automatic',
    subtitle: 'SeedMask finds a healthy mainnet node for you.',
    suggested: true,
  },
  {
    id: 'custom',
    label: 'Your own node',
    subtitle: 'Use a Kaspa node you host or trust.',
  },
]

export function resolveBitcoinServerMode(raw: string): BitcoinServerMode {
  const m = raw.trim().toLowerCase()
  if (m === 'bitcoin_core' || m === 'core') return 'bitcoin_core'
  if (m === 'electrum' || m === 'private_electrum') return 'electrum'
  return 'public'
}

export function resolveBitcoinPublicPreset(raw: string): BitcoinPublicPreset {
  const m = raw.trim().toLowerCase()
  if (m === 'mempool_space' || m === 'mempool.space') return 'mempool_space'
  if (m === 'blockstream' || m === 'blockstream.info') return 'blockstream'
  return 'recommended'
}

export function isExclusivePublicPreset(preset: BitcoinPublicPreset | string): boolean {
  const id = resolveBitcoinPublicPreset(String(preset || ''))
  return id === 'mempool_space' || id === 'blockstream'
}

export function resolveKaspaRpcMode(kaspa: KaspaNetworkSettingsDTO): KaspaRpcMode {
  return kaspa.rpc_mode.trim().toLowerCase() === 'custom' ? 'custom' : 'resolver'
}

export function resolveKaspaHistoryMode(kaspa: KaspaNetworkSettingsDTO): KaspaHistoryMode {
  const mode = (kaspa.history_mode || '').trim().toLowerCase()
  if (mode === 'disabled' || mode === 'custom' || mode === 'public') return mode
  // Legacy / missing field: own-node defaults to private history; Automatic uses public.
  return resolveKaspaRpcMode(kaspa) === 'custom' ? 'disabled' : 'public'
}

/** Own node + private history: prompt on Kaspa import/restore (kpub, Ledger, OneKey, SeedMask). */
export function needsKaspaImportHistoryPrompt(settings: NetworkSettingsDTO | null | undefined): boolean {
  if (!settings) return false
  return resolveKaspaRpcMode(settings.kaspa) === 'custom' && resolveKaspaHistoryMode(settings.kaspa) === 'disabled'
}

export function withKaspaPublicHistory(settings: NetworkSettingsDTO): NetworkSettingsDTO {
  const next = structuredClone(settings)
  next.kaspa.history_mode = 'public'
  next.kaspa.history_api_base = KASPA_PUBLIC_HISTORY_API
  return next
}

export function mempoolSpacePreset(): BitcoinNetworkSettingsDTO {
  return {
    server_mode: 'public',
    public_preset: 'mempool_space',
    core_host: '127.0.0.1',
    core_port: 8332,
    core_user: '',
    core_password: '',
    core_use_ssl: false,
    core_cookie_path: '',
    electrum_host: '127.0.0.1',
    electrum_port: 50002,
    electrum_use_ssl: true,
    esplora_primary: 'https://mempool.space/api',
    esplora_fallbacks: [],
    websocket_url: 'wss://mempool.space/api/v1/ws',
    broadcast_urls: ['https://mempool.space/api/tx'],
    fee_recommended_url: 'https://mempool.space/api/v1/fees/recommended',
    explorer_tx_template: 'https://mempool.space/tx/{txid}',
    enable_legacy_fallbacks: false,
  }
}

export function blockstreamPreset(): BitcoinNetworkSettingsDTO {
  return {
    server_mode: 'public',
    public_preset: 'blockstream',
    core_host: '127.0.0.1',
    core_port: 8332,
    core_user: '',
    core_password: '',
    core_use_ssl: false,
    core_cookie_path: '',
    electrum_host: '127.0.0.1',
    electrum_port: 50002,
    electrum_use_ssl: true,
    esplora_primary: 'https://blockstream.info/api',
    esplora_fallbacks: [],
    // Blockstream has no public mempool WS — watcher falls back to polling.
    websocket_url: '',
    broadcast_urls: ['https://blockstream.info/api/tx'],
    fee_recommended_url: 'https://blockstream.info/api/fee-estimates',
    explorer_tx_template: 'https://blockstream.info/tx/{txid}',
    enable_legacy_fallbacks: false,
  }
}

export function applyPublicPreset(preset: BitcoinPublicPreset, defaults: NetworkSettingsDTO): BitcoinNetworkSettingsDTO {
  let next: BitcoinNetworkSettingsDTO
  switch (preset) {
    case 'recommended':
      next = structuredClone(defaults.bitcoin)
      next.enable_legacy_fallbacks = true
      break
    case 'mempool_space':
      next = mempoolSpacePreset()
      break
    case 'blockstream':
      next = blockstreamPreset()
      break
  }
  next.server_mode = 'public'
  next.public_preset = preset
  next.bitcoin_core_url = ''
  next.electrum_url = ''
  return next
}

export function applyBitcoinServerMode(mode: BitcoinServerMode, draft: NetworkSettingsDTO, defaults: NetworkSettingsDTO): NetworkSettingsDTO {
  const next = structuredClone(draft)
  next.bitcoin.server_mode = mode === 'public' ? 'public' : mode === 'bitcoin_core' ? 'bitcoin_core' : 'electrum'
  switch (mode) {
    case 'public':
      next.bitcoin = applyPublicPreset(resolveBitcoinPublicPreset(next.bitcoin.public_preset), defaults)
      break
    case 'bitcoin_core':
      next.bitcoin.electrum_url = ''
      next.bitcoin.core_use_ssl = false
      if (!next.bitcoin.core_host.trim()) next.bitcoin.core_host = '127.0.0.1'
      if (next.bitcoin.core_port < 1) next.bitcoin.core_port = 8332
      if (!next.bitcoin.core_cookie_path && !next.bitcoin.core_user) {
        next.bitcoin.core_cookie_path = '~/Library/Application Support/Bitcoin'
      }
      break
    case 'electrum':
      next.bitcoin.bitcoin_core_url = ''
      if (!next.bitcoin.electrum_host.trim()) next.bitcoin.electrum_host = '127.0.0.1'
      if (next.bitcoin.electrum_port < 1) next.bitcoin.electrum_port = 50002
      if (!next.bitcoin.electrum_use_ssl && next.bitcoin.electrum_port === 8332) {
        next.bitcoin.electrum_use_ssl = true
      }
      break
  }
  return next
}

export function applyKaspaMode(mode: KaspaRpcMode, draft: NetworkSettingsDTO): NetworkSettingsDTO {
  const next = structuredClone(draft)
  const previousMode = resolveKaspaRpcMode(next.kaspa)
  next.kaspa.rpc_mode = mode === 'custom' ? 'custom' : 'resolver'
  if (mode === 'resolver') {
    next.kaspa.rpc_url = ''
    next.kaspa.history_mode = 'public'
  } else if (previousMode !== 'custom' && resolveKaspaHistoryMode(next.kaspa) === 'public') {
    // Own-node users expect no address queries to third parties unless they opt in.
    next.kaspa.history_mode = 'disabled'
  }
  return next
}

/** Fill missing Bitcoin endpoint fields before save/test (avoids backend 422). */
export function completeBitcoinSettings(
  draft: BitcoinNetworkSettingsDTO,
  defaults: BitcoinNetworkSettingsDTO,
): BitcoinNetworkSettingsDTO {
  const preset = resolveBitcoinPublicPreset(draft.public_preset || defaults.public_preset)
  // Exclusive presets must not inherit Recommended's cross-provider URLs.
  if (preset === 'mempool_space') {
    const base = mempoolSpacePreset()
    return {
      ...base,
      core_host: draft.core_host || base.core_host,
      core_port: draft.core_port || base.core_port,
      core_user: draft.core_user ?? '',
      core_password: draft.core_password ?? '',
      core_cookie_path: draft.core_cookie_path ?? '',
      electrum_host: draft.electrum_host || base.electrum_host,
      electrum_port: draft.electrum_port || base.electrum_port,
      electrum_use_ssl: draft.electrum_use_ssl ?? true,
    }
  }
  if (preset === 'blockstream') {
    const base = blockstreamPreset()
    return {
      ...base,
      core_host: draft.core_host || base.core_host,
      core_port: draft.core_port || base.core_port,
      core_user: draft.core_user ?? '',
      core_password: draft.core_password ?? '',
      core_cookie_path: draft.core_cookie_path ?? '',
      electrum_host: draft.electrum_host || base.electrum_host,
      electrum_port: draft.electrum_port || base.electrum_port,
      electrum_use_ssl: draft.electrum_use_ssl ?? true,
    }
  }

  const merged: BitcoinNetworkSettingsDTO = { ...defaults, ...draft }
  if (!merged.esplora_primary?.trim()) merged.esplora_primary = defaults.esplora_primary
  if (!merged.websocket_url?.trim()) merged.websocket_url = defaults.websocket_url
  if (!merged.fee_recommended_url?.trim()) merged.fee_recommended_url = defaults.fee_recommended_url
  if (!merged.explorer_tx_template?.trim()) merged.explorer_tx_template = defaults.explorer_tx_template
  if (!merged.esplora_fallbacks?.length) merged.esplora_fallbacks = [...defaults.esplora_fallbacks]
  if (!merged.broadcast_urls?.length) merged.broadcast_urls = [...defaults.broadcast_urls]
  if (merged.enable_legacy_fallbacks == null) merged.enable_legacy_fallbacks = true
  merged.public_preset = 'recommended'
  return merged
}

export function sanitizedForSave(settings: NetworkSettingsDTO, savedSnapshot: NetworkSettingsDTO | null): NetworkSettingsDTO {
  const next = structuredClone(settings)
  if (resolveBitcoinServerMode(next.bitcoin.server_mode) === 'bitcoin_core') {
    next.bitcoin.core_use_ssl = false
  }
  if (
    resolveKaspaRpcMode(next.kaspa) === 'custom' &&
    !next.kaspa.rpc_url.trim()
  ) {
    if (savedSnapshot) {
      next.kaspa = { ...savedSnapshot.kaspa }
    } else {
      next.kaspa.rpc_mode = 'resolver'
      next.kaspa.rpc_url = ''
    }
  }
  return next
}

export function splitNetworkLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function friendlyHost(urlString: string, fallback: string): string {
  const trimmed = urlString.trim()
  if (!trimmed) return fallback
  try {
    return new URL(trimmed).host || trimmed
  } catch {
    return trimmed
  }
}

export function bitcoinHubLabel(bitcoin: BitcoinNetworkSettingsDTO): string {
  switch (resolveBitcoinServerMode(bitcoin.server_mode)) {
    case 'public':
      return BITCOIN_PUBLIC_PRESETS.find((p) => p.id === resolveBitcoinPublicPreset(bitcoin.public_preset))?.label ?? 'Recommended'
    case 'bitcoin_core':
      return 'Bitcoin Core'
    case 'electrum':
      return 'Private Electrum'
  }
}

export function bitcoinHubDetail(bitcoin: BitcoinNetworkSettingsDTO): string {
  switch (resolveBitcoinServerMode(bitcoin.server_mode)) {
    case 'public':
      return friendlyHost(bitcoin.esplora_primary, 'Public server')
    case 'bitcoin_core':
      return coreEndpointLabel(bitcoin)
    case 'electrum':
      return electrumEndpointLabel(bitcoin)
  }
}

export function kaspaHubDetail(kaspa: KaspaNetworkSettingsDTO): string {
  if (resolveKaspaRpcMode(kaspa) === 'custom') {
    const node = kaspa.rpc_url.trim() ? friendlyHost(kaspa.rpc_url, 'Custom node') : 'Own node'
    const history = resolveKaspaHistoryMode(kaspa)
    if (history === 'disabled') return `${node} · history off`
    if (history === 'public') return `${node} · public history`
    const api = (kaspa.history_api_base || '').trim()
    return api ? `${node} · ${friendlyHost(api, 'private history')}` : `${node} · private history`
  }
  return 'Live balance · history from kaspa.org'
}

function coreEndpointLabel(bitcoin: BitcoinNetworkSettingsDTO): string {
  const host = bitcoin.core_host.trim() || '127.0.0.1'
  const scheme = bitcoin.core_use_ssl ? 'https' : 'http'
  return `${scheme}://${host}:${bitcoin.core_port}`
}

function electrumEndpointLabel(bitcoin: BitcoinNetworkSettingsDTO): string {
  const host = bitcoin.electrum_host.trim() || '127.0.0.1'
  const scheme = bitcoin.electrum_use_ssl ? 'ssl' : 'tcp'
  return `${scheme}://${host}:${bitcoin.electrum_port}`
}

export function saveErrorForChain(error: string | null, chain: CoinChainFilter): string | null {
  if (!error) return null
  const lower = error.toLowerCase()
  if (chain === 'bitcoin') {
    if (lower.includes('kaspa') && !lower.includes('bitcoin')) return null
    return error
  }
  if (lower.includes('bitcoin') && !lower.includes('kaspa')) return null
  return error
}

export function settingsEqual(a: NetworkSettingsDTO | null, b: NetworkSettingsDTO | null): boolean {
  if (!a || !b) return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}
