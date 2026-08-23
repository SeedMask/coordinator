import { normalizeOutpointKey } from '@renderer/utils/sendAmount'

export type CoinChain = 'kaspa' | 'bitcoin'

export type SidebarSection =
  | 'dashboard'
  | 'addresses'
  | 'coins'
  | 'walletSettings'
  | 'systemSettings'

export type AppTheme = 'light' | 'dark' | 'dim'
export type BitcoinDisplayUnit = 'btc' | 'sats'
/** Clock display: follow the OS, or force 12-hour / 24-hour. */
export type TimeFormat = 'system' | '12h' | '24h'

export type DisplayCurrency = 'USD' | 'EUR' | 'GBP' | 'JPY' | 'CAD' | 'CHF' | 'AUD'

export interface MultisigCosigner {
  xpub: string
  label?: string
  fingerprint?: string
  derivation?: string
}

export interface WalletDTO {
  id: string
  label: string
  kpub: string
  account: number
  scan_limit: number
  created_at?: string | null
  last_synced_at?: string | null
  derivation?: string | null
  fingerprint?: string | null
  script_type?: string | null
  policy_type?: string | null
  multisig_m?: number | null
  multisig_n?: number | null
  multisig_cosigners?: MultisigCosigner[] | null
  coin?: string | null
  descriptor?: string | null
  hardware?: string | null
  keystore_label?: string | null
  encrypted?: boolean
  unlocked?: boolean
  /** Optional public reminder shown when unlocking; stored in plaintext. */
  password_hint?: string | null
  cached_balance_sompi?: number
  cached_balance_kas?: number
  sync_status?: WalletSyncStatus
}

export type WalletSyncStatus = 'cached' | 'syncing' | 'live' | 'incomplete'

export interface WalletStateResponse {
  wallet_id: string
  coin: CoinChain
  sync_status: WalletSyncStatus
  balance_sompi: number
  balance_kas: number
  balance_sats?: number
  balance_btc?: number
  utxos: UtxoDTO[]
  transactions: WalletTxDTO[]
  last_hot_at?: string | null
  last_deep_at?: string | null
  changed?: boolean
}

export interface StatusResponse {
  ok: boolean
  version?: string
  build_stamp?: string
  wallets?: WalletDTO[]
  active_wallet_id?: string | null
  active_wallet_by_coin?: Record<string, string>
  network_settings?: NetworkSettingsDTO
}

export interface WalletsListResponse {
  wallets: WalletDTO[]
  active_wallet_id?: string | null
  active_wallet_by_coin?: Record<string, string>
}

export interface WalletSaveResponse {
  ok?: boolean
  wallet?: WalletDTO
}

export interface BalanceResponse {
  balance_sompi: number
  balance_kas: number
  balance_btc?: number
  balance_sats?: number
  coin?: string
  wallet_id?: string
  utxo_count?: number
  utxos: UtxoDTO[]
  changed?: boolean
  sync_status?: WalletSyncStatus
}

export interface UtxoDTO {
  key: string
  address: string
  address_index: number
  transaction_id: string
  output_index: number
  amount: number
  amount_kas?: number
  amount_btc?: number
  is_change?: boolean
  block_daa_score?: number
  is_coinbase?: boolean
  covenant_id?: string | null
  covenantId?: string | null
}

export type QRDisplayDensity = 'animated' | 'static'

export interface WalletSnapshot {
  balanceText: string
  balanceValue: number
  utxos: UtxoDTO[]
  transactions: WalletTxDTO[]
  receiveAddresses: AddressDTO[]
  addressBook?: AddressBookResponse | null
  /** Set after a successful full mainnet discovery scan. */
  mainnetSynced?: boolean
  coin?: CoinChain
}

export interface AddressDTO {
  index: number
  address: string
}

export interface DescriptorParseResponse {
  ok?: boolean
  descriptor?: string
  wallet?: WalletDTO
  label?: string
  coin?: string
  error?: string
}

export interface DraftExportResponse {
  draft_id: string
  unsigned: unknown
  format?: string
  psbt_base64?: string
  pskt?: Record<string, unknown>
  pskt_hex?: string
  pskb_hex?: string
  pskt_count?: number
  signatures_loaded?: number
  signatures_required?: number
  signing_complete?: boolean
}

export interface TxVisualizeRow {
  id: string
  label: string
  subtitle?: string | null
  address?: string | null
  amount?: number
  amount_sompi?: number
  kind?: string
  is_warning?: boolean
}

export interface TxVisualizeMetadataRow {
  label: string
  value: string
  detail?: string | null
  is_warning?: boolean
}

export interface TxVisualizeWarning {
  severity?: string
  message: string
}

export interface TxVisualizeResponse {
  ok?: boolean
  unit_symbol?: string
  txid?: string
  txid_short?: string
  summary_line?: string
  summary_fee_line?: string
  balance_line?: string
  raw_hex?: string
  raw_hex_label?: string
  raw_hex_format?: string
  inputs?: TxVisualizeRow[]
  outputs?: TxVisualizeRow[]
  metadata?: TxVisualizeMetadataRow[]
  warnings?: TxVisualizeWarning[]
  block_time?: number | null
  confirmations?: number | null
  accepting_block_blue_score?: number | null
}

export interface AddressesResponse {
  addresses: AddressDTO[]
}

export interface TransactionsResponse {
  transactions: WalletTxDTO[]
}

export interface WalletTxDTO {
  id?: string
  txid?: string
  transaction_id?: string
  amount_sompi?: number
  amount_kas?: number
  amount_btc?: number
  amount_sats?: number
  fee_sompi?: number
  fee_sats?: number
  direction?: string
  timestamp?: string | null
  block_time?: number
  label?: string | null
  counterparty?: string | null
  confirmations?: number | null
  block_height?: number | null
  accepting_block_blue_score?: number | null
  rbf?: boolean | null
}

export interface AddressBookResponse {
  receive: AddressRowDTO[]
  change: AddressRowDTO[]
  next_receive_index?: number
  next_receive_address?: string
  next_change_index?: number
  next_change_address?: string
}

export interface AddressRowDTO {
  index: number
  address: string
  derivation?: string
  balance_sompi?: number
  balance_kas?: number
  balance_btc?: number
  balance_sats?: number
  is_change?: boolean
  used?: boolean
  is_used?: boolean
  last_used_at?: number
}

export interface ConnectScriptOption {
  script_type: string
  label?: string
  derivation: string
  xpub: string
}

export interface KpubParseResponse {
  ok?: boolean
  kpub?: string
  coin?: string
  label?: string
  derivation?: string
  fingerprint?: string
  script_type?: string
  policy_type?: string
  multisig_m?: number
  multisig_n?: number
  multisig_cosigners?: MultisigCosigner[]
  account?: number
  format?: string
  script_options?: ConnectScriptOption[]
  error?: string
}

export interface BitcoinNetworkSettingsDTO {
  server_mode: string
  public_preset: string
  bitcoin_core_url?: string
  electrum_url?: string
  core_host: string
  core_port: number
  core_user: string
  core_password: string
  core_use_ssl: boolean
  core_cookie_path: string
  electrum_host: string
  electrum_port: number
  electrum_use_ssl: boolean
  esplora_primary: string
  esplora_fallbacks: string[]
  websocket_url: string
  broadcast_urls: string[]
  fee_recommended_url: string
  explorer_tx_template: string
  enable_legacy_fallbacks: boolean
}

export interface KaspaNetworkSettingsDTO {
  rpc_mode: string
  rpc_url: string
  history_mode?: string
  history_api_base?: string
  explorer_tx_template?: string
}

export interface NetworkSettingsDTO {
  bitcoin: BitcoinNetworkSettingsDTO
  kaspa: KaspaNetworkSettingsDTO
}

export interface NetworkSettingsEnvelope {
  settings: NetworkSettingsDTO
  defaults: NetworkSettingsDTO
}

export interface NetworkSettingsSaveResponse {
  ok: boolean
  settings: NetworkSettingsDTO
}

export interface ConnectionTestResponse {
  ok: boolean
  mode: string
  summary: string
  steps: string[]
}

/** @deprecated Prefer ConnectionTestResponse — same shape for Bitcoin and Kaspa. */
export type BitcoinConnectionTestResponse = ConnectionTestResponse

export type KaspaConnectionTestResponse = ConnectionTestResponse

export interface FeeEstimateResponse {
  fee_sompi: number
  fee_kas?: number
  fee_btc?: number
  feerate_sat_vb?: number
  feerates?: Record<string, number>
  send_sompi?: number
  max_send_sompi?: number
  spendable_sompi?: number
  mass?: number
  mass_grams?: number
  storage_mass?: number
  maximum_standard_mass?: number
  excess_to_miner_kas?: number
  send_amount_valid?: boolean
  send_block_reason?: string
  insufficient_funds?: boolean
  message?: string
}

export interface BuildTxResponse {
  ok?: boolean
  draft_id: string
  qr_frames?: string[]
  qr_frames_base64?: string[]
  qr_static?: string
  qr_png_base64?: string
  qr_frame_ms?: number
  qr_display_pixels?: number
  qr_modules_per_frame?: number
  qr_display_mode?: string
  qr_fountain?: boolean
  /** Compact unsigned / PSBT text for local QR encode when frames are omitted. */
  qr_payload_text?: string
  summary?: Record<string, unknown>
  unsigned?: Record<string, unknown>
  error?: string
  is_sweep?: boolean
  pskt_count?: number
  message?: string
  signatures_loaded?: number
  signatures_required?: number
  signing_complete?: boolean
  ready?: Record<string, unknown>
  signed?: Record<string, unknown>
}

export interface FinishResponse {
  ok?: boolean
  complete?: boolean
  message?: string
  signatures_loaded?: number
  signatures_required?: number
  ready?: Record<string, unknown>
  draft_id?: string
}

export interface BroadcastResponse {
  ok?: boolean
  transaction_id?: string
  transaction_ids?: string[]
  explorer?: string
  coin?: string
  message?: string
}

export interface SignedQrIngestResponse {
  complete: boolean
  progress?: number
  message?: string
  payload?: string
}

export interface DescriptorExportResponse {
  descriptor: string
}

export function walletCoin(w: WalletDTO): CoinChain {
  const c = (w.coin ?? '').trim().toLowerCase()
  if (c === 'bitcoin') return 'bitcoin'
  if (c === 'kaspa') return 'kaspa'
  const key = (w.kpub ?? '').trim().toLowerCase()
  if (
    key.startsWith('xpub') ||
    key.startsWith('tpub') ||
    key.startsWith('ypub') ||
    key.startsWith('zpub') ||
    key.startsWith('vpub') ||
    key.startsWith('upub')
  ) {
    return 'bitcoin'
  }
  if ((w.descriptor ?? '').trim() || (w.script_type ?? '').trim()) return 'bitcoin'
  return 'kaspa'
}

export function extendedKeyLabel(coin: CoinChain): string {
  return coin === 'bitcoin' ? 'xpub' : 'kpub'
}

export function formatBalance(sompi: number, coin: CoinChain): string {
  if (coin === 'bitcoin') {
    return (sompi / 1e8).toFixed(8)
  }
  return (sompi / 1e8).toFixed(8)
}

export function coinUnit(coin: CoinChain): string {
  return coin === 'bitcoin' ? 'BTC' : 'KAS'
}

/** Normalize API/cache UTXO rows so sompi `amount` and `key` are always valid for fee/build. */
export function normalizeUtxo(raw: Record<string, unknown>): UtxoDTO {
  const amountKas = raw.amount_kas as number | undefined
  const amountBtc = raw.amount_btc as number | undefined
  const coinAmt = amountBtc ?? amountKas
  let amount = Number(raw.amount ?? 0)
  if (coinAmt != null && coinAmt > 0) {
    amount = Math.max(1, Math.round(coinAmt * 100_000_000))
  } else if (!Number.isFinite(amount) || amount <= 0) {
    amount = 0
  } else if (amount > 0 && amount < 1) {
    // Legacy rows stored coin units (BTC/KAS) in `amount` instead of sompi.
    amount = Math.max(1, Math.round(amount * 100_000_000))
  } else {
    amount = Math.round(amount)
  }
  const transactionId = String(raw.transaction_id ?? raw.transactionId ?? '')
    .trim()
    .toLowerCase()
    .replace(/^0x/i, '')
  const outputIndex = Number(raw.output_index ?? raw.outputIndex ?? 0)
  const rawKey = String(raw.key ?? (transactionId ? `${transactionId}:${outputIndex}` : ''))
  const key = rawKey ? normalizeOutpointKey(rawKey) : ''
  const covenantId = (raw.covenant_id ?? raw.covenantId) as string | null | undefined
  return {
    key,
    address: String(raw.address ?? ''),
    address_index: Number(raw.address_index ?? raw.addressIndex ?? 0),
    transaction_id: transactionId,
    output_index: outputIndex,
    amount,
    amount_kas: amountKas ?? (amount > 0 ? amount / 100_000_000 : undefined),
    amount_btc: amountBtc,
    is_change: Boolean(raw.is_change ?? raw.isChange ?? false),
    block_daa_score: Number(raw.block_daa_score ?? raw.blockDaaScore ?? 0),
    is_coinbase: Boolean(raw.is_coinbase ?? raw.isCoinbase ?? false),
    covenant_id: covenantId ?? null,
    covenantId: covenantId ?? null,
  }
}

export function parseBalanceResponse(raw: Record<string, unknown>): BalanceResponse {
  const coin = raw.coin as string | undefined
  const balanceSompi =
    (raw.balance_sompi as number | undefined) ??
    (raw.balance_sats as number | undefined) ??
    0
  let balanceKas: number
  if (coin === 'bitcoin') {
    balanceKas =
      (raw.balance_btc as number | undefined) ??
      balanceSompi / 100_000_000
  } else {
    balanceKas =
      (raw.balance_kas as number | undefined) ??
      balanceSompi / 100_000_000
  }
  const rawUtxos = (raw.utxos as Array<Record<string, unknown>> | undefined) ?? []
  return {
    balance_sompi: balanceSompi,
    balance_kas: balanceKas,
    balance_btc: raw.balance_btc as number | undefined,
    balance_sats: raw.balance_sats as number | undefined,
    coin,
    wallet_id: raw.wallet_id as string | undefined,
    sync_status: raw.sync_status as WalletSyncStatus | undefined,
    utxos: rawUtxos.map(normalizeUtxo),
    changed: raw.changed as boolean | undefined,
  }
}

export function utxoCoinAmount(u: UtxoDTO): number {
  if (u.amount > 0) {
    if (u.amount < 1) return u.amount
    return u.amount / 100_000_000
  }
  if (u.amount_btc != null) return u.amount_btc
  if (u.amount_kas != null) return u.amount_kas
  return 0
}

export function looksLikeBitcoinAddress(address: string): boolean {
  const a = address.trim().toLowerCase()
  return a.startsWith('bc1') || a.startsWith('tb1') || a.startsWith('1') || a.startsWith('3')
}

export function looksLikeKaspaAddress(address: string): boolean {
  const a = address.trim().toLowerCase()
  if (a.startsWith('kaspa:')) return true
  if (a.includes(':')) return false
  const first = a[0]
  return first != null && 'qpzry9'.includes(first)
}

export function utxoMatchesChain(u: UtxoDTO, chain: CoinChain): boolean {
  return chain === 'bitcoin' ? looksLikeBitcoinAddress(u.address) : looksLikeKaspaAddress(u.address)
}

export function qrDensityLabel(mode: QRDisplayDensity): string {
  return mode === 'animated' ? 'Animated' : 'Dense'
}
