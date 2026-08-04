import type { CoinChain, MultisigCosigner, WalletDTO } from '@renderer/api/types'
import { walletCoin } from '@renderer/api/types'
import {
  derivationPath,
  policyFromDerivation,
  scriptDisplayName,
  scriptFromDerivation,
} from '@renderer/utils/bitcoinWallet'

/** Resolve the wallet that should be active for a chain tab (never cross-chain via activeWalletId). */
export function walletForChain(
  chain: CoinChain,
  wallets: WalletDTO[],
  activeWalletByCoin: Record<string, string>,
  _activeWalletId: string | null = null,
): WalletDTO | undefined {
  const preferredId = activeWalletByCoin[chain]
  if (preferredId) {
    const byId = wallets.find((w) => w.id === preferredId)
    if (byId && walletCoin(byId) === chain) return byId
  }
  return wallets.find((w) => walletCoin(w) === chain)
}

export function sanitizeFingerprint(value: string): string {
  return value.replace(/[^0-9a-fA-F]/g, '').slice(0, 8).toLowerCase()
}

export function walletIsMultisig(wallet: WalletDTO): boolean {
  if (wallet.policy_type === 'multiSig' || wallet.policy_type === 'multisig') return true
  if ((wallet.multisig_n ?? 0) > 0) return true
  if (wallet.multisig_cosigners?.length) return true
  return false
}

export function walletMultisigCosigners(wallet: WalletDTO): MultisigCosigner[] {
  return wallet.multisig_cosigners ?? []
}

export function walletMultisigQuorumLabel(wallet: WalletDTO): string {
  const m = wallet.multisig_m
  const n = wallet.multisig_n
  if (m && n && m > 0 && n > 0) return `${m}-of-${n}`
  return ''
}

export function walletHasCompleteMultisigCosigners(wallet: WalletDTO): boolean {
  if (!walletIsMultisig(wallet)) return false
  const n = wallet.multisig_n ?? 0
  const cosigners = walletMultisigCosigners(wallet)
  return n > 0 && cosigners.length === n && cosigners.every((c) => c.xpub.trim())
}

export function walletIsIncompleteLegacyMultisig(wallet: WalletDTO): boolean {
  return (
    walletIsMultisig(wallet) &&
    walletMultisigCosigners(wallet).length === 0 &&
    !wallet.policy_type &&
    (wallet.multisig_n ?? 0) === 0
  )
}

export function walletPolicyLabel(wallet: WalletDTO): string {
  if (walletIsMultisig(wallet)) {
    const quorum = walletMultisigQuorumLabel(wallet)
    return quorum || 'MultiSig'
  }
  if (walletCoin(wallet) === 'bitcoin') {
    const policy = (wallet.policy_type || '').trim().toLowerCase()
    if (policy === 'singlesig' || policy === 'single_sig') return 'SingleSig'
    if (policy === 'multisig' || policy === 'multi_sig') return 'MultiSig'
    if (wallet.script_type?.trim()) return scriptDisplayName(wallet.script_type)
    return 'SingleSig'
  }
  return 'SingleSig'
}

export function kaspaDerivationPath(account = 0): string {
  return `m/44'/111111'/${account}'`
}

export function kaspaMultisigDerivationPath(account = 0): string {
  return `m/45'/111111'/${account}'`
}

export function walletResolvedDerivation(wallet: WalletDTO): string {
  const account = walletResolvedAccount(wallet)
  return (
    wallet.derivation?.trim() ||
    (walletCoin(wallet) === 'bitcoin'
      ? "m/84'/0'/0'"
      : walletIsMultisig(wallet)
        ? kaspaMultisigDerivationPath(account)
        : kaspaDerivationPath(account))
  )
}

export function walletResolvedFingerprint(wallet: WalletDTO): string {
  return wallet.fingerprint?.trim() ?? ''
}

export function walletResolvedAccount(wallet: WalletDTO): number {
  return wallet.account ?? 0
}

/** Stable key for Sparrow-style account family (one strip chip, many BIP44 accounts). */
export function walletAccountGroupKey(wallet: WalletDTO): string {
  const chain = walletCoin(wallet)
  const script = (wallet.script_type || '').trim().toLowerCase() || '_'

  // Singlesig: same master fingerprint + script = BIP44 account family.
  // Never group with multisig just because a cosigner shares this fingerprint.
  if (!walletIsMultisig(wallet)) {
    const fp = sanitizeFingerprint(walletResolvedFingerprint(wallet))
    if (fp.length < 8) return `id:${wallet.id}`
    return `ss|${chain}|${fp}|${script}`
  }

  // Multisig (Sparrow): accounts live inside one setup — same quorum + same cosigner
  // set. A keystore reused in a *different* multisig wallet is a separate wallet, not
  // Account N of this one.
  const cosigners = walletMultisigCosigners(wallet)
  const m = wallet.multisig_m ?? 0
  const n = wallet.multisig_n ?? cosigners.length
  const cosignerParts = cosigners
    .map((c) => {
      const cfp = sanitizeFingerprint(c.fingerprint || '')
      if (cfp.length >= 8) return `fp:${cfp}`
      const xpub = (c.xpub || '').trim()
      return xpub ? `x:${xpub.slice(0, 48)}` : ''
    })
    .filter(Boolean)
    .sort()
  if (cosignerParts.length === 0) return `id:${wallet.id}`
  return `ms|${chain}|${m}of${n}|${script}|${cosignerParts.join(',')}`
}

/**
 * Sparrow-style account groups:
 * - Singlesig: same master fingerprint + coin + script
 * - Multisig: same quorum + same cosigner set (not merely one shared fingerprint)
 */
export function walletsSharingAccountGroup(
  wallets: WalletDTO[],
  wallet: WalletDTO,
): WalletDTO[] {
  const key = walletAccountGroupKey(wallet)
  return wallets
    .filter((w) => walletAccountGroupKey(w) === key)
    .sort((a, b) => walletResolvedAccount(a) - walletResolvedAccount(b) || a.label.localeCompare(b.label))
}

/** One strip entry per account family — active member if in group, else lowest account index. */
export function walletStripRepresentative(
  group: WalletDTO[],
  activeWalletId: string | undefined | null,
): WalletDTO {
  if (group.length === 0) throw new Error('empty account group')
  const active = activeWalletId ? group.find((w) => w.id === activeWalletId) : undefined
  if (active) return active
  return group[0]!
}

/** Stable strip chip identity: lowest account index in the family (does not change when switching accounts). */
export function walletStripAnchor(group: WalletDTO[]): WalletDTO {
  if (group.length === 0) throw new Error('empty account group')
  return group[0]!
}

/**
 * Wallets shown in the strip: one chip per fingerprint family (siblings live under Account N).
 * Chip ids are stable anchors so switching Account N does not spawn a new strip wallet.
 */
export function walletsForStrip(ordered: WalletDTO[]): WalletDTO[] {
  const seen = new Set<string>()
  const out: WalletDTO[] = []
  for (const wallet of ordered) {
    const key = walletAccountGroupKey(wallet)
    if (seen.has(key)) continue
    seen.add(key)
    const group = walletsSharingAccountGroup(ordered, wallet)
    out.push(walletStripAnchor(group))
  }
  return out
}

/** Strip / family display name — drop trailing “(Account N)” from any member. */
export function walletFamilyLabel(wallet: WalletDTO, group?: WalletDTO[]): string {
  const members = group && group.length > 0 ? group : [wallet]
  const primary = [...members].sort(
    (a, b) => walletResolvedAccount(a) - walletResolvedAccount(b) || a.label.localeCompare(b.label),
  )[0]!
  return primary.label.replace(/\s*\(Account\s+\d+\)\s*$/i, '').trim() || primary.label || 'Wallet'
}

/** USB hardware brand stored on the wallet (`ledger` / `onekey`), if any. */
export function walletUsbHardwareBrand(wallet: WalletDTO): 'ledger' | 'onekey' | null {
  const hw = (wallet.hardware || '').trim().toLowerCase()
  if (hw === 'ledger' || hw === 'onekey') return hw
  return null
}

/**
 * How sibling accounts must be imported for this wallet (same source as the original).
 * - ledger / onekey → connect that device only
 * - seedmask → SeedMask airgap QR / paste only
 * - watch → generic xpub / watch-only paste only
 */
export type WalletAccountImportKind = 'ledger' | 'onekey' | 'seedmask' | 'watch'

export function walletAccountImportKind(wallet: WalletDTO): WalletAccountImportKind {
  const hw = (wallet.hardware || '').trim().toLowerCase()
  if (hw === 'ledger' || hw === 'onekey' || hw === 'seedmask') return hw
  return 'watch'
}

/** Default singlesig keystore device label from how the key was imported. */
export function defaultKeystoreLabel(wallet: WalletDTO): string {
  const kind = walletAccountImportKind(wallet)
  if (kind === 'ledger') return 'Ledger'
  if (kind === 'onekey') return 'OneKey'
  if (kind === 'seedmask') return 'SeedMask'
  return 'Keystore'
}

export function walletKeystoreLabel(wallet: WalletDTO): string {
  const stored = (wallet.keystore_label || '').trim()
  if (stored) return stored
  return defaultKeystoreLabel(wallet)
}

/** Caption above keystore tiles in Wallet settings (by how the key was imported). */
export function walletKeystoreNatureParts(wallet: WalletDTO): { name: string; mode: string | null } {
  const kind = walletAccountImportKind(wallet)
  const connected = '(Connected device)'
  if (kind === 'seedmask') return { name: 'SeedMask', mode: '(Airgapped)' }
  if (kind === 'watch') return { name: 'Watch-only', mode: null }
  if (kind === 'ledger') return { name: 'Ledger', mode: connected }
  if (kind === 'onekey') return { name: 'OneKey', mode: connected }
  return { name: 'Watch-only', mode: null }
}

/** @deprecated Prefer walletKeystoreNatureParts for layout. */
export function walletKeystoreNatureCaption(wallet: WalletDTO): string {
  const { name, mode } = walletKeystoreNatureParts(wallet)
  return mode ? `${name} ${mode}` : name
}

/** Sparrow disables Add Account for legacy P2SH multisig (`m/45'`); BIP48 / Kaspa accounts are OK. */
export function walletSupportsAddAccount(wallet: WalletDTO): boolean {
  if (walletIsMultisig(wallet)) {
    // Need a complete cosigner set to define “this” multisig family (Sparrow: accounts
    // stay inside one wallet setup — not every wallet that reuses a cosigner).
    const cosigners = walletMultisigCosigners(wallet)
    const n = wallet.multisig_n ?? 0
    if (n <= 0 || cosigners.length < n) return false
    if (!cosigners.every((c) => sanitizeFingerprint(c.fingerprint || '').length >= 8 || (c.xpub || '').trim())) {
      return false
    }
    if (walletCoin(wallet) === 'kaspa') return true
    const der = walletResolvedDerivation(wallet).toLowerCase()
    if (der.includes("/45'") && !der.includes("/48'")) return false
    return true
  }
  const fp = sanitizeFingerprint(walletResolvedFingerprint(wallet))
  return fp.length >= 8
}

/** Derivation for another BIP44/BIP48 account under the same script/policy as `wallet`. */
export function derivationForSiblingAccount(wallet: WalletDTO, account: number): string {
  const chain = walletCoin(wallet)
  const idx = Math.max(0, Math.floor(account))
  if (chain === 'kaspa') {
    return walletIsMultisig(wallet) ? kaspaMultisigDerivationPath(idx) : kaspaDerivationPath(idx)
  }
  const der = walletResolvedDerivation(wallet)
  const policy = policyFromDerivation(der)
  const script = scriptFromDerivation(der) ?? 'native_segwit'
  return derivationPath(script, policy, idx)
}

/** Unused account indices 0–9 (Sparrow Add Account range), plus current. */
export function unusedAccountIndices(group: WalletDTO[], maxAccount = 9): number[] {
  const used = new Set(group.map((w) => walletResolvedAccount(w)))
  const out: number[] = []
  for (let i = 0; i <= maxAccount; i++) {
    if (!used.has(i)) out.push(i)
  }
  return out
}

export function walletScriptTypeLabel(wallet: WalletDTO): string {
  if (walletCoin(wallet) === 'kaspa') {
    if (walletIsMultisig(wallet)) return 'Native P2SH'
    const raw = (wallet.script_type || '').trim().toLowerCase()
    if (!raw || raw === 'p2pk' || raw === 'schnorr' || raw === 'native') return 'P2PK'
    if (raw === 'p2sh') return 'Native P2SH'
    return wallet.script_type!.trim()
  }
  const raw = wallet.script_type?.trim() ?? ''
  if (!raw) return ''
  return scriptDisplayName(raw)
}

export const DEFAULT_COSIGNER_DERIVATION = "m/48'/0'/0'/2'"
