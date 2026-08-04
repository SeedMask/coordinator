import type {
  AddressBookResponse,
  AddressDTO,
  BalanceResponse,
  BitcoinConnectionTestResponse,
  BitcoinNetworkSettingsDTO,
  BroadcastResponse,
  BuildTxResponse,
  CoinChain,
  DescriptorExportResponse,
  DescriptorParseResponse,
  DraftExportResponse,
  FeeEstimateResponse,
  FinishResponse,
  KpubParseResponse,
  MultisigCosigner,
  NetworkSettingsDTO,
  NetworkSettingsEnvelope,
  NetworkSettingsSaveResponse,
  QRDisplayDensity,
  SignedQrIngestResponse,
  StatusResponse,
  TransactionsResponse,
  TxVisualizeResponse,
  UtxoDTO,
  WalletDTO,
  WalletSaveResponse,
  WalletsListResponse,
} from './types'
import { parseBalanceResponse } from './types'
import { utxoAmountSompi } from '@renderer/utils/sendAmount'
import {
  bitcoinDraftEnvelope,
  isPsbtBinary,
  unwrapUnsignedImport,
  bytesToBase64,
} from '@renderer/utils/transactionFileIO'

export class APIError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'APIError'
  }
}

export class APIClient {
  readonly serverBaseURL: string
  private inflight = 0
  /** Interactive ops must not queue behind long wallet scans. */
  private readonly maxInflight = 32
  private readonly waitQueue: Array<() => void> = []

  constructor(port = 18765) {
    this.serverBaseURL = `http://127.0.0.1:${port}`
  }

  async waitForHealthy(retries = 240, intervalMs = 200): Promise<void> {
    let lastErr: unknown
    for (let i = 0; i < retries; i++) {
      try {
        await this.pingStatus(4_000)
        return
      } catch (e) {
        lastErr = e
        await sleep(intervalMs)
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new APIError('Coordinator backend is still starting. Wait a moment and try again.')
  }

  /** Lightweight reachability check — bypasses concurrency limits. */
  async pingStatus(timeoutMs = 4_000): Promise<StatusResponse> {
    return this.requestInner<StatusResponse>('/api/status', { method: 'GET', timeoutMs })
  }

  async status(): Promise<StatusResponse> {
    return this.pingStatus(15_000)
  }

  async listWallets(): Promise<WalletsListResponse> {
    return this.get('/api/wallets')
  }

  async createWallet(body: {
    kpub: string
    label: string
    scan_limit?: number
    coin: CoinChain
    derivation?: string
    fingerprint?: string
    script_type?: string
    policy_type?: string
    multisig_m?: number
    multisig_n?: number
    multisig_cosigners?: MultisigCosigner[]
    activate?: boolean
    account?: number
    hardware?: string
    keystore_label?: string
  }): Promise<WalletDTO> {
    const res = await this.post<WalletSaveResponse>('/api/wallets', {
      scan_limit: 30,
      activate: true,
      account: 0,
      ...body,
    })
    if (!res.wallet) throw new APIError('Missing wallet in response')
    return res.wallet
  }

  async updateWallet(
    id: string,
    body: {
      label?: string
      scan_limit?: number
      fingerprint?: string
      hardware?: string
      keystore_label?: string
      multisig_cosigners?: MultisigCosigner[]
    },
  ): Promise<WalletDTO> {
    const res = await this.put<WalletSaveResponse>(`/api/wallets/${id}`, body)
    if (!res.wallet) throw new APIError('Missing wallet in response')
    return res.wallet
  }

  async deleteWallet(id: string): Promise<void> {
    await this.request(`/api/wallets/${id}`, { method: 'DELETE' })
  }

  async activateWallet(id: string): Promise<WalletDTO> {
    const res = await this.post<WalletSaveResponse>(`/api/wallets/${id}/activate`, {})
    if (!res.wallet) throw new APIError('Missing wallet in response')
    return res.wallet
  }

  async parseDescriptor(descriptor: string, label = 'Descriptor wallet'): Promise<DescriptorParseResponse> {
    return this.post('/api/descriptor/parse', { descriptor, label, activate: false })
  }

  async createWalletFromDescriptor(
    descriptor: string,
    label: string,
    scanLimit = 30,
    activate = true,
  ): Promise<WalletDTO> {
    const res = await this.post<WalletSaveResponse>('/api/wallets/descriptor', {
      descriptor,
      label,
      scan_limit: scanLimit,
      activate,
    })
    if (!res.wallet) throw new APIError('Missing wallet in response')
    return res.wallet
  }

  async addresses(walletId: string): Promise<{ addresses: AddressDTO[] }> {
    return this.get(`/api/wallets/${walletId}/addresses`)
  }

  async parseKpub(text: string, coin?: CoinChain): Promise<KpubParseResponse> {
    return this.post('/api/kpub/parse', { text, coin })
  }

  async draftExport(draftId: string, walletId?: string): Promise<DraftExportResponse> {
    const q = walletId ? `?wallet_id=${encodeURIComponent(walletId)}` : ''
    return this.get(`/api/tx/draft/${draftId}${q}`)
  }

  async draftVisualize(draftId: string, walletId?: string): Promise<TxVisualizeResponse> {
    const q = walletId ? `?wallet_id=${encodeURIComponent(walletId)}` : ''
    return this.get(`/api/tx/draft/${draftId}/visualize${q}`)
  }

  async walletTxVisualize(walletId: string, txid: string): Promise<TxVisualizeResponse> {
    const encoded = encodeURIComponent(txid)
    return this.request<TxVisualizeResponse>(
      `/api/wallets/${walletId}/transactions/${encoded}/visualize`,
      { method: 'GET', timeoutMs: 45_000 },
    )
  }

  async importTxFile(fileData: ArrayBuffer, qrDisplayMode: QRDisplayDensity = 'animated'): Promise<BuildTxResponse> {
    const bytes = new Uint8Array(fileData)
    let unsigned: unknown
    if (isPsbtBinary(bytes)) {
      unsigned = bitcoinDraftEnvelope(bytesToBase64(bytes))
    } else {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
      unsigned = unwrapUnsignedImport(parsed)
    }
    return this.importTx(unsigned, qrDisplayMode)
  }

  feeUtxoPayload(utxos: UtxoDTO[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = []
    for (const u of utxos) {
      const amount = utxoAmountSompi(u)
      if (amount <= 0 || !u.address?.trim()) continue
      let txid = String(u.transaction_id ?? '').trim()
      let outputIndex = Number(u.output_index ?? 0)
      if (!txid && u.key) {
        const colon = u.key.lastIndexOf(':')
        if (colon > 0) {
          txid = u.key.slice(0, colon).trim()
          outputIndex = Number(u.key.slice(colon + 1)) || 0
        }
      }
      if (!txid) continue
      const normalizedTxid = txid.toLowerCase().replace(/^0x/i, '')
      const key = u.key?.trim() ? u.key : `${normalizedTxid}:${outputIndex}`
      out.push({
        key,
        address: u.address,
        address_index: u.address_index,
        transaction_id: normalizedTxid,
        output_index: outputIndex,
        amount,
        is_change: u.is_change ?? false,
        block_daa_score: u.block_daa_score ?? 0,
        is_coinbase: u.is_coinbase ?? false,
      })
    }
    return out
  }

  async feeEstimate(params: {
    utxoAmountSompi?: number
    walletId?: string
    coin?: CoinChain
    inputCount?: number
    feerateSatVb?: number
    sendSompi?: number
    toAddress?: string
    utxos?: UtxoDTO[]
    outputCount?: number
    refineMax?: boolean
    priorityFeeSompi?: number
    requestedFeeSompi?: number
  }): Promise<FeeEstimateResponse> {
    const body: Record<string, unknown> = { output_count: params.outputCount ?? 2 }
    if (params.coin) body.coin = params.coin
    if (params.walletId) body.wallet_id = params.walletId
    if (params.utxoAmountSompi != null) body.utxo_amount_sompi = params.utxoAmountSompi
    if (params.utxos?.length) body.utxos = this.feeUtxoPayload(params.utxos)
    if (params.inputCount != null) body.input_count = params.inputCount
    if (params.feerateSatVb != null) body.feerate_sat_vb = params.feerateSatVb
    if (params.sendSompi != null) body.send_sompi = params.sendSompi
    if (params.toAddress) body.to_address = params.toAddress
    if (params.refineMax) body.refine_max = true
    if (params.priorityFeeSompi != null) body.priority_fee_sompi = params.priorityFeeSompi
    if (params.requestedFeeSompi != null) body.requested_fee_sompi = params.requestedFeeSompi
    return this.post('/api/fee/estimate', body)
  }

  async buildTx(params: {
    utxoKeys: string[]
    toAddress: string
    sendKas?: number
    feeSompi: number
    walletId?: string
    qrDisplayMode?: QRDisplayDensity
    rbf?: boolean
    useGenerator?: boolean
    utxos?: UtxoDTO[]
    sendSompi?: number
    customFee?: boolean
  }): Promise<BuildTxResponse> {
    const keys = params.utxoKeys.filter((k) => k.length > 0)
    const snapshots = params.utxos?.length ? this.feeUtxoPayload(params.utxos) : null
    const body: Record<string, unknown> = {
      to_address: params.toAddress,
      fee_sompi: params.feeSompi,
      qr_display_mode: params.qrDisplayMode ?? 'animated',
      wallet_id: params.walletId,
      rbf: params.rbf ?? false,
      use_generator: (params.useGenerator ?? false) || keys.length > 1,
      custom_fee: params.customFee ?? false,
    }
    if (snapshots) {
      body.utxos = snapshots
    } else if (keys.length === 1) {
      body.utxo_key = keys[0]
    } else if (keys.length > 1) {
      body.utxo_keys = keys
    }
    if (params.sendSompi != null) {
      body.send_sompi = params.sendSompi
    } else if (params.sendKas != null) {
      body.send_kas = params.sendKas
    }
    return this.post('/api/tx/build', body, 300_000)
  }

  async rbfBump(params: {
    txid: string
    walletId?: string
    feeSompi?: number
    feerateSatVb?: number
    qrDisplayMode?: QRDisplayDensity
  }): Promise<BuildTxResponse> {
    const body: Record<string, unknown> = {
      txid: params.txid,
      qr_display_mode: params.qrDisplayMode ?? 'animated',
    }
    if (params.walletId) body.wallet_id = params.walletId
    if (params.feeSompi != null) body.fee_sompi = params.feeSompi
    if (params.feerateSatVb != null) body.feerate_sat_vb = params.feerateSatVb
    return this.post('/api/tx/rbf-bump', body, 300_000)
  }

  async refresh(walletId: string, onProgress?: (message: string) => void): Promise<BalanceResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 300_000)
    try {
      const res = await fetch(`${this.serverBaseURL}/api/wallets/${walletId}/refresh/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: '{}',
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const text = await res.text()
        let detail = text
        try {
          detail = JSON.parse(text).detail ?? text
        } catch {
          /* raw */
        }
        throw new APIError(typeof detail === 'string' ? detail : JSON.stringify(detail), res.status)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let eventName = ''
      let complete: Record<string, unknown> | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventName = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            const payload = line.slice(6)
            if (eventName === 'progress') {
              try {
                const parsed = JSON.parse(payload) as { message?: string }
                if (parsed.message) onProgress?.(parsed.message)
              } catch {
                /* ignore */
              }
            } else if (eventName === 'complete') {
              complete = JSON.parse(payload) as Record<string, unknown>
            } else if (eventName === 'error') {
              let message = payload
              try {
                message = JSON.parse(payload).message ?? payload
              } catch {
                /* raw */
              }
              throw new APIError(String(message))
            }
            eventName = ''
          }
        }
      }

      if (!complete) throw new APIError('Refresh ended without a result')
      return parseBalanceResponse(complete)
    } finally {
      clearTimeout(timer)
    }
  }

  async refreshDiscover(walletId: string, onProgress?: (message: string) => void): Promise<BalanceResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 90_000)
    try {
      const res = await fetch(`${this.serverBaseURL}/api/wallets/${walletId}/refresh/discover/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: '{}',
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const text = await res.text()
        let detail = text
        try {
          detail = JSON.parse(text).detail ?? text
        } catch {
          /* raw */
        }
        throw new APIError(typeof detail === 'string' ? detail : JSON.stringify(detail), res.status)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let eventName = ''
      let complete: Record<string, unknown> | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventName = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            const payload = line.slice(6)
            if (eventName === 'progress') {
              try {
                const parsed = JSON.parse(payload) as { message?: string }
                if (parsed.message) onProgress?.(parsed.message)
              } catch {
                /* ignore */
              }
            } else if (eventName === 'complete') {
              complete = JSON.parse(payload) as Record<string, unknown>
            } else if (eventName === 'error') {
              let message = payload
              try {
                message = JSON.parse(payload).message ?? payload
              } catch {
                /* raw */
              }
              throw new APIError(String(message))
            }
            eventName = ''
          }
        }
      }

      if (!complete) throw new APIError('Discovery scan ended without a result')
      return parseBalanceResponse(complete)
    } finally {
      clearTimeout(timer)
    }
  }

  async refreshWatch(walletId: string): Promise<BalanceResponse> {
    const raw = await this.request<Record<string, unknown>>(
      `/api/wallets/${walletId}/refresh/watch`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeoutMs: 30_000 },
    )
    return parseBalanceResponse(raw)
  }

  async walletState(walletId: string, includeTransactions = true): Promise<import('@renderer/api/types').WalletStateResponse> {
    const q = includeTransactions ? '' : '?include_transactions=false'
    return this.get(`/api/wallets/${walletId}/state${q}`)
  }

  async requestSync(
    walletId: string,
    mode: 'hot' | 'discover' | 'deep' = 'hot',
    wait = false,
  ): Promise<{ ok: boolean; queued?: boolean } | BalanceResponse> {
    const raw = await this.request<Record<string, unknown>>(
      `/api/wallets/${walletId}/sync?mode=${encodeURIComponent(mode)}&wait=${wait ? 'true' : 'false'}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeoutMs: wait ? 300_000 : 15_000 },
    )
    if (wait && raw.balance_sompi != null) {
      return parseBalanceResponse(raw)
    }
    return raw as { ok: boolean; queued?: boolean }
  }

  async pushUtxoCache(_walletId: string, _utxos: UtxoDTO[], _coin: CoinChain): Promise<void> {
    /* backend owns wallet state */
  }

  async balance(walletId: string): Promise<BalanceResponse> {
    const raw = await this.get<Record<string, unknown>>(`/api/wallets/${walletId}/balance`)
    return parseBalanceResponse(raw)
  }

  async addressBook(walletId: string, includeBalances = true): Promise<AddressBookResponse> {
    const q = includeBalances ? '' : '?balances=false'
    return this.get(`/api/wallets/${walletId}/addresses/detailed${q}`)
  }

  async transactions(
    walletId: string,
    query?: string,
    opts?: { refresh?: boolean },
  ): Promise<TransactionsResponse> {
    const params = new URLSearchParams()
    if (query?.trim()) params.set('q', query.trim())
    if (opts?.refresh) params.set('refresh', 'true')
    const q = params.toString() ? `?${params.toString()}` : ''
    return this.request<TransactionsResponse>(`/api/wallets/${walletId}/transactions${q}`, {
      method: 'GET',
      timeoutMs: 60_000,
    })
  }

  async kaspaConfirmations(walletId: string): Promise<{
    tip_blue: number
    bps: number
    server_time_ms: number
    cache_age_ms?: number
    updates: Array<{
      transaction_id: string
      confirmations: number
      accepting_block_blue_score?: number | null
      block_time?: number | null
    }>
  }> {
    return this.request(`/api/wallets/${walletId}/kaspa-confirmations`, {
      method: 'GET',
      timeoutMs: 12_000,
    })
  }

  async kaspaTipBlue(): Promise<{
    tip_blue: number
    bps: number
    server_time_ms: number
    cache_age_ms?: number
  }> {
    return this.request(`/api/kaspa/tip-blue`, {
      method: 'GET',
      timeoutMs: 2_000,
    })
  }

  async setTxLabel(walletId: string, txid: string, label: string): Promise<void> {
    await this.put(`/api/wallets/${walletId}/labels/tx/${txid}`, { label })
  }

  async networkSettings(): Promise<NetworkSettingsEnvelope> {
    return this.get('/api/settings/network')
  }

  async updateNetworkSettings(settings: NetworkSettingsDTO): Promise<NetworkSettingsSaveResponse> {
    return this.put('/api/settings/network', settings)
  }

  async testBitcoinConnection(bitcoin: BitcoinNetworkSettingsDTO): Promise<BitcoinConnectionTestResponse> {
    return this.post('/api/settings/network/test-bitcoin', bitcoin, 12_000)
  }

  async exportWallet(walletId: string): Promise<Blob> {
    const res = await fetch(`${this.serverBaseURL}/api/wallets/${walletId}/export`)
    if (!res.ok) throw new APIError(await res.text(), res.status)
    return res.blob()
  }

  async walletDescriptor(walletId: string): Promise<DescriptorExportResponse> {
    return this.get(`/api/wallets/${walletId}/descriptor`)
  }

  async qrText(
    text: string,
    qrDisplayMode: QRDisplayDensity = 'animated',
    encoding: 'ur' | 'plain' = 'ur',
  ): Promise<BuildTxResponse> {
    return this.post('/api/qr/text', {
      text,
      qr_display_mode: qrDisplayMode,
      encoding,
    })
  }

  /** BC-UR part strings for Dense + Animated (no PNG) — renderer draws QRs locally. */
  async qrTextParts(text: string): Promise<{
    static_part: string | null
    animated_parts: string[]
    qr_frame_ms?: number
    qr_static_available?: boolean
  }> {
    return this.post('/api/qr/text-parts', { text, encoding: 'ur' })
  }

  async validateAddress(text: string, coin?: CoinChain): Promise<string> {
    const res = await this.post<{ address: string }>('/api/address/validate', { text, coin })
    return res.address
  }

  async finishTx(
    draftId: string,
    signed: Record<string, unknown> | string,
    psktIndex = 0,
  ): Promise<FinishResponse> {
    const obj = typeof signed === 'string' ? (JSON.parse(signed) as Record<string, unknown>) : signed
    return this.post('/api/tx/finish', { draft_id: draftId, signed: obj, pskt_index: psktIndex }, 300_000)
  }

  async broadcast(
    draftId: string,
    signed: Record<string, unknown> | string,
    psktIndex = 0,
  ): Promise<BroadcastResponse> {
    const obj = typeof signed === 'string' ? (JSON.parse(signed) as Record<string, unknown>) : signed
    return this.post('/api/tx/broadcast', { draft_id: draftId, signed: obj, pskt_index: psktIndex }, 300_000)
  }

  async resetSignedQrAssembly(): Promise<void> {
    await this.post('/api/tx/signed-qr/reset', {})
  }

  async ingestSignedQrFrame(text: string): Promise<SignedQrIngestResponse> {
    return this.post('/api/tx/signed-qr/ingest', { text })
  }

  async importTx(unsigned: unknown, qrDisplayMode = 'animated'): Promise<BuildTxResponse> {
    return this.post('/api/tx/import', { unsigned, qr_display_mode: qrDisplayMode }, 300_000)
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' })
  }

  private async post<T>(path: string, body: unknown, timeoutMs = 120_000): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs,
    })
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  private isFastPath(path: string): boolean {
    if (path.startsWith('/api/settings/')) return true
    if (path === '/api/status') return true
    if (path.includes('/refresh/watch')) return true
    if (path.includes('/refresh/discover')) return true
    if (path.includes('/refresh/stream')) return true
    if (path.startsWith('/api/tx/')) return true
    if (path.startsWith('/api/fee/')) return true
    if (path.includes('/transactions')) return true
    if (path.includes('/visualize')) return true
    if (path.endsWith('/balance')) return true
    if (path.endsWith('/utxos/cache')) return true
    if (path.includes('/addresses')) return true
    if (path.includes('/activate')) return true
    if (path.endsWith('/state')) return true
    if (path === '/api/wallets') return true
    return false
  }

  private async acquireSlot(): Promise<void> {
    if (this.inflight < this.maxInflight) {
      this.inflight++
      return
    }
    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve)
    })
    this.inflight++
  }

  private releaseSlot(): void {
    this.inflight = Math.max(0, this.inflight - 1)
    const next = this.waitQueue.shift()
    if (next) next()
  }

  private async request<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number },
    attempt = 0,
  ): Promise<T> {
    const fast = this.isFastPath(path)
    if (!fast) await this.acquireSlot()
    try {
      return await this.requestInner<T>(path, init, attempt)
    } finally {
      if (!fast) this.releaseSlot()
    }
  }

  private coordinatorUnreachableMessage(): string {
    return 'Could not reach the coordinator — the app may still be starting or busy scanning wallets. Wait a moment and try again.'
  }

  private async confirmReachable(): Promise<boolean> {
    try {
      await this.pingStatus(2_500)
      return true
    } catch {
      return false
    }
  }

  private async requestInner<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number },
    attempt = 0,
  ): Promise<T> {
    const maxAttempts = path === '/api/status' ? 10 : 8
    const { timeoutMs = 120_000, ...fetchInit } = init
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let res: Response
      try {
        res = await fetch(`${this.serverBaseURL}${path}`, { ...fetchInit, signal: controller.signal })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const retryable =
          msg.includes('Failed to fetch') ||
          msg.includes('NetworkError') ||
          msg.includes('aborted') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('Connection refused')
        if (retryable && attempt < maxAttempts - 1) {
          const delay = path === '/api/status' ? 100 + 80 * attempt : 250 + 300 * attempt
          await sleep(delay)
          return this.requestInner<T>(path, init, attempt + 1)
        }
        if (retryable) {
          if (path !== '/api/status' && (await this.confirmReachable())) {
            await sleep(200)
            return this.requestInner<T>(path, init, 0)
          }
          throw new APIError(this.coordinatorUnreachableMessage(), 0)
        }
        throw e
      }
      const text = await res.text()
      if (!res.ok) {
        const retryableStatus = res.status === 502 || res.status === 503 || res.status === 429
        if (retryableStatus && attempt < maxAttempts - 1) {
          await sleep(450 * (attempt + 1))
          return this.requestInner<T>(path, init, attempt + 1)
        }
        let detail = text
        try {
          detail = JSON.parse(text).detail ?? text
        } catch {
          /* raw */
        }
        throw new APIError(typeof detail === 'string' ? detail : JSON.stringify(detail), res.status)
      }
      if (!text) return {} as T
      return JSON.parse(text) as T
    } finally {
      clearTimeout(timer)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function createAPIClient(): Promise<APIClient> {
  const ready = await window.seedmask?.waitBackendReady?.()
  if (ready && !ready.ok) {
    throw new APIError(ready.error ?? 'Coordinator backend could not start')
  }
  const port = (await window.seedmask?.getBackendPort()) ?? 18765
  const client = new APIClient(port)
  await client.waitForHealthy(60, 200)
  return client
}
