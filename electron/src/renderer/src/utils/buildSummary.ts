import type { CoinChain, UtxoDTO } from '@renderer/api/types'
import { utxoCoinAmount } from '@renderer/api/types'
import { coinAmountLabel, normalizeOutpointKey, utxoAmountSompi } from '@renderer/utils/sendAmount'
import { groupUtxosByAddress, type UtxoAddressGroup } from '@renderer/utils/utxoHelpers'

export interface BuildSummary {
  toAddress?: string
  sendKas?: number
  sendSompi?: number
  feeSompi?: number
  excessToMinerSompi?: number
  requestedFeeSompi?: number
  changeKas?: number
  changeSompi?: number
  changeAddress?: string
  changeAddressIndex?: number
  inputTotalKas?: number
  inputTotalSompi?: number
  unusedSelectedKas?: number
  unusedSelectedSompi?: number
  fromAddress?: string
  mass?: number
  storageMass?: number
  rbf?: boolean
  inputCount?: number
  usedUtxoKeys?: string[]
  isSweep?: boolean
  psktCount?: number
}

export function summaryFromResponse(raw: Record<string, unknown> | undefined): BuildSummary | null {
  if (!raw) return null
  return {
    toAddress: raw.to_address as string | undefined,
    sendKas: raw.send_kas as number | undefined,
    sendSompi: raw.send_sompi as number | undefined,
    feeSompi: raw.fee_sompi as number | undefined,
    excessToMinerSompi: raw.excess_to_miner_sompi as number | undefined,
    requestedFeeSompi: raw.requested_fee_sompi as number | undefined,
    changeKas: raw.change_kas as number | undefined,
    changeSompi: (raw.change_sompi ?? raw.change_sats) as number | undefined,
    changeAddress: raw.change_address as string | undefined,
    changeAddressIndex: raw.change_address_index as number | undefined,
    inputTotalKas: raw.input_total_kas as number | undefined,
    inputTotalSompi: raw.input_total_sompi as number | undefined,
    unusedSelectedKas: raw.unused_selected_kas as number | undefined,
    unusedSelectedSompi: raw.unused_selected_sompi as number | undefined,
    fromAddress: raw.from_address as string | undefined,
    mass: raw.mass as number | undefined,
    storageMass: raw.storage_mass as number | undefined,
    rbf: raw.rbf as boolean | undefined,
    inputCount: raw.input_count as number | undefined,
    usedUtxoKeys: Array.isArray(raw.used_utxo_keys)
      ? (raw.used_utxo_keys as string[]).map(normalizeOutpointKey)
      : undefined,
    isSweep: raw.is_sweep as boolean | undefined,
    psktCount: raw.pskt_count as number | undefined,
  }
}

export function reviewTotalFeeSompi(summary: BuildSummary): number {
  return summary.feeSompi ?? 0
}

export function reviewChangeKas(summary: BuildSummary): number | null {
  if (summary.changeKas != null && summary.changeKas > 0) return summary.changeKas
  if (summary.changeSompi != null && summary.changeSompi > 0) {
    return summary.changeSompi / 100_000_000
  }
  return null
}

export function reviewInputTotalKas(summary: BuildSummary, fallbackSelected: number): number {
  if (summary.inputTotalKas != null && summary.inputTotalKas > 0) return summary.inputTotalKas
  if (summary.inputTotalSompi != null && summary.inputTotalSompi > 0) {
    return summary.inputTotalSompi / 100_000_000
  }
  return fallbackSelected
}

/** Address groups for coins used in the send (full balance per address when walletUtxos provided). */
export function reviewAddressGroupsForSpentCoins(
  spentCoins: UtxoDTO[],
  walletUtxos: UtxoDTO[],
): UtxoAddressGroup[] {
  const spentGroups = groupUtxosByAddress(spentCoins)
  if (!walletUtxos.length) return spentGroups
  const walletById = new Map(groupUtxosByAddress(walletUtxos).map((g) => [g.id, g]))
  return spentGroups.map((g) => walletById.get(g.id) ?? g)
}

/** Total of UTXOs actually used as inputs (not full address balances). */
export function reviewAddressInputTotalKas(
  summary: BuildSummary,
  spentCoins: UtxoDTO[],
  _walletUtxos: UtxoDTO[],
  fallbackSelected: number,
): number {
  if (spentCoins.length > 0) {
    const selectedTotal = spentCoins.reduce((s, u) => s + utxoCoinAmount(u), 0)
    if (selectedTotal > 0) return selectedTotal
  }
  return reviewInputTotalKas(summary, fallbackSelected)
}

export function reviewUnusedSelectedKas(summary: BuildSummary, totalSelectedKas: number): number {
  if (summary.unusedSelectedKas != null && summary.unusedSelectedKas > 0) return summary.unusedSelectedKas
  if (summary.unusedSelectedSompi != null && summary.unusedSelectedSompi > 0) {
    return summary.unusedSelectedSompi / 100_000_000
  }
  const used = reviewInputTotalKas(summary, totalSelectedKas)
  return Math.max(0, totalSelectedKas - used)
}

export function reviewWalletRemainderNote(
  summary: BuildSummary,
  totalSelectedKas: number,
  unit: string,
): string | null {
  const unused = reviewUnusedSelectedKas(summary, totalSelectedKas)
  if (unused <= 0.00000001) return null
  return `This send doesn't need every selected deposit. ${unused.toFixed(8)} ${unit} stays in your wallet and is not spent in this transaction.`
}

export function reviewFeeNote(summary: BuildSummary, actualFeeSompi: number, unit: string): string | null {
  const requested = summary.requestedFeeSompi
  if (requested == null || requested <= 0) return null
  if (Math.abs(actualFeeSompi - requested) <= 5_000) return null
  return `You entered ${(requested / 100_000_000).toFixed(8)} ${unit}`
}

export function summaryAddressLabel(address: string, chain: CoinChain): string {
  const trimmed = address.trim()
  if (!trimmed) return 'Recipient'
  if (chain === 'kaspa') return trimmed
  return shortAddressLabel(trimmed, chain)
}

export function shortAddressLabel(address: string, chain: CoinChain): string {
  const trimmed = address.trim()
  if (trimmed.length <= 18) return trimmed || 'Recipient'
  const prefixLen = chain === 'bitcoin' ? 8 : 12
  return `${trimmed.slice(0, prefixLen)}…${trimmed.slice(-8)}`
}

export function isBitcoinSignedPsbt(obj: Record<string, unknown>): boolean {
  if (obj.format === 'bitcoin_psbt') return true
  const b64 = String(obj.psbt_base64 ?? '').trim()
  return b64.length > 0 && obj.inputs == null
}

export function isSignedKaspaTransaction(obj: Record<string, unknown>): boolean {
  const sigs = obj.signatures
  if (Array.isArray(sigs) && sigs.length > 0) return true
  const inputs = obj.inputs
  if (!Array.isArray(inputs) || inputs.length === 0) return false
  return inputs.some((inp) => {
    if (!inp || typeof inp !== 'object') return false
    const script = String((inp as Record<string, unknown>).signature_script ?? '').trim()
    return script.length > 0
  })
}

export function isCompleteSignedTransactionPayload(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return false
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>
    return isBitcoinSignedPsbt(obj) || isSignedKaspaTransaction(obj)
  } catch {
    return false
  }
}

export function decodeQrImages(res: {
  qr_frames?: string[]
  qr_static?: string
  qr_png_base64?: string
  qr_frames_base64?: string[]
}): string[] {
  const b64List = res.qr_frames_base64 ?? res.qr_frames ?? []
  const sources = b64List.length > 0 ? b64List : [res.qr_static ?? res.qr_png_base64 ?? ''].filter(Boolean)
  return sources
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0)
    .map((raw) => (raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`))
}

function utxoOutpointKey(u: UtxoDTO): string {
  if (u.key?.trim()) return normalizeOutpointKey(u.key)
  if (u.transaction_id) {
    return normalizeOutpointKey(`${u.transaction_id}:${u.output_index ?? 0}`)
  }
  return ''
}

function inputKeyFromUnsignedInp(inp: Record<string, unknown>): string | null {
  const txid = String(
    inp.prev_tx_id ?? inp.transaction_id ?? inp.transactionId ?? '',
  )
    .trim()
    .toLowerCase()
    .replace(/^0x/i, '')
  const idx = Number(inp.prev_index ?? inp.output_index ?? inp.index ?? NaN)
  if (!txid || !Number.isFinite(idx)) return null
  return normalizeOutpointKey(`${txid}:${idx}`)
}

/** Extract input outpoint keys from coordinator unsigned JSON when summary omits them. */
export function usedKeysFromUnsigned(unsigned: unknown): string[] | undefined {
  if (!unsigned || typeof unsigned !== 'object') return undefined
  const inputs = (unsigned as { inputs?: unknown[] }).inputs
  if (!Array.isArray(inputs) || inputs.length === 0) return undefined
  const keys: string[] = []
  for (const raw of inputs) {
    if (!raw || typeof raw !== 'object') continue
    const key = inputKeyFromUnsignedInp(raw as Record<string, unknown>)
    if (key) keys.push(key)
  }
  return keys.length > 0 ? keys : undefined
}

export function reviewCoinsForSidebar(
  summary: BuildSummary | null,
  walletUtxos: UtxoDTO[],
  unsigned?: unknown,
): UtxoDTO[] {
  const keys = summary?.usedUtxoKeys ?? usedKeysFromUnsigned(unsigned) ?? []
  if (!keys.length) return []

  const walletByKey = new Map<string, UtxoDTO>()
  for (const u of walletUtxos) {
    const k = utxoOutpointKey(u)
    if (k) walletByKey.set(k, u)
  }

  const amountByKey = new Map<string, number>()
  if (unsigned && typeof unsigned === 'object') {
    const inputs = (unsigned as { inputs?: unknown[] }).inputs
    if (Array.isArray(inputs)) {
      for (const raw of inputs) {
        if (!raw || typeof raw !== 'object') continue
        const inp = raw as Record<string, unknown>
        const key = inputKeyFromUnsignedInp(inp)
        const amountSompi = Number(inp.utxo_amount ?? inp.amount_sompi ?? inp.amount ?? 0)
        if (key && amountSompi > 0) amountByKey.set(key, Math.round(amountSompi))
      }
    }
  }

  const coins: UtxoDTO[] = []
  for (const rawKey of keys) {
    const key = normalizeOutpointKey(rawKey)
    const wallet = walletByKey.get(key)
    if (!wallet) continue
    const amountSompi = amountByKey.get(key)
    if (amountSompi != null && amountSompi > 0) {
      coins.push({
        ...wallet,
        amount: amountSompi,
        amount_kas: amountSompi / 100_000_000,
      })
    } else {
      coins.push(wallet)
    }
  }
  return coins
}

export function formatCoinRow(u: UtxoDTO, unit: string): string {
  return coinAmountLabel(utxoCoinAmount(u), unit)
}

export function totalSelectedSompi(utxos: UtxoDTO[]): number {
  return utxos.reduce((s, u) => s + utxoAmountSompi(u), 0)
}
