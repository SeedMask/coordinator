import type { UtxoDTO } from '@renderer/api/types'
import { totalSelectedSompi } from '@renderer/utils/buildSummary'

export interface SpendPool {
  usingCustom: boolean
  utxos: UtxoDTO[]
  keys: string[]
  inputCount: number
  sompiTotal: number
}

/** Resolve which UTXOs feed fee estimate / tx build (matches Swift SendWizardView). */
export function resolveSpendPool(opts: {
  showAdvancedCoinControl: boolean
  sendUsesCustomCoinSelection: boolean
  spendableUtxos: UtxoDTO[]
  orderedSelectedUtxos: UtxoDTO[]
}): SpendPool {
  const usingCustom = opts.showAdvancedCoinControl || opts.sendUsesCustomCoinSelection
  const utxos = usingCustom ? opts.orderedSelectedUtxos : opts.spendableUtxos
  const keys = utxos.map((u) => u.key)
  return {
    usingCustom,
    utxos,
    keys,
    inputCount: Math.max(1, keys.length),
    sompiTotal: totalSelectedSompi(utxos),
  }
}
