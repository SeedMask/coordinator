import type { CoinChain, MultisigCosigner } from '@renderer/api/types'

export type BitcoinPolicyType = 'singlesig' | 'multisig'

export type BitcoinScriptType = 'native_segwit' | 'nested_segwit' | 'legacy' | 'taproot'

export const BITCOIN_POLICY_OPTIONS: { value: BitcoinPolicyType; label: string }[] = [
  { value: 'singlesig', label: 'SingleSig' },
  { value: 'multisig', label: 'MultiSig' },
]

export const ALL_SCRIPT_OPTIONS: { value: BitcoinScriptType; label: string; detail: string }[] = [
  { value: 'native_segwit', label: 'Native SegWit', detail: 'P2WPKH' },
  { value: 'nested_segwit', label: 'Nested SegWit', detail: 'P2SH-P2WPKH' },
  { value: 'legacy', label: 'Legacy', detail: 'P2PKH' },
  { value: 'taproot', label: 'Taproot', detail: 'P2TR' },
]

export const MULTISIG_SCRIPT_OPTIONS = ALL_SCRIPT_OPTIONS.filter((o) => o.value !== 'taproot')

export type KaspaScriptType = 'p2pk' | 'p2sh'

export function kaspaScriptForPolicy(policy: BitcoinPolicyType): KaspaScriptType {
  return policy === 'multisig' ? 'p2sh' : 'p2pk'
}

export function kaspaScriptOptionsForPolicy(
  policy: BitcoinPolicyType,
): { value: KaspaScriptType; label: string; detail: string }[] {
  if (policy === 'multisig') return [{ value: 'p2sh', label: 'Native P2SH', detail: 'P2SH' }]
  return [{ value: 'p2pk', label: 'P2PK', detail: 'Schnorr' }]
}

export function kaspaScriptDisplayName(script: KaspaScriptType | string): string {
  const key = (script || '').trim().toLowerCase()
  if (key === 'p2sh') return 'Native P2SH'
  return 'P2PK'
}

export const DEFAULT_COSIGNER_DERIVATION = "m/48'/0'/0'/2'"
export const DEFAULT_FINGERPRINT = '00000000'
export const MAX_COSIGNERS = 15

export interface BitcoinMultisigQuorum {
  required: number
  total: number
}

export interface MultisigCosignerDraft {
  id: string
  label: string
  fingerprint: string
  derivation: string
  xpub: string
}

export interface ExtendedKeyMetadata {
  derivation: string
  fingerprint: string
  /** Set only when the paste includes an explicit derivation/account (SM| / JSON). Bare keys omit this. */
  account?: number
  coin: CoinChain
}

export const QUORUM_PRESETS: BitcoinMultisigQuorum[] = [
  { required: 2, total: 3 },
  { required: 2, total: 4 },
  { required: 3, total: 5 },
]

export function policyDisplayName(policy: BitcoinPolicyType): string {
  return policy === 'multisig' ? 'MultiSig' : 'SingleSig'
}

export function scriptDisplayName(script: BitcoinScriptType | string): string {
  const opt = ALL_SCRIPT_OPTIONS.find((o) => o.value === script)
  if (opt) return opt.label
  const raw = String(script || '').trim()
  if (!raw) return ''
  return raw
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
    .replace(/\bSegwit\b/g, 'SegWit')
}

export function quorumDisplayLabel(q: BitcoinMultisigQuorum): string {
  return `${q.required} of ${q.total}`
}

export function isValidQuorum(q: BitcoinMultisigQuorum): boolean {
  return q.required >= 1 && q.required <= MAX_COSIGNERS && q.total >= q.required && q.total <= MAX_COSIGNERS
}

export function scriptOptionsForPolicy(policy: BitcoinPolicyType): typeof ALL_SCRIPT_OPTIONS {
  return policy === 'multisig' ? MULTISIG_SCRIPT_OPTIONS : ALL_SCRIPT_OPTIONS
}

export function derivationPath(
  script: BitcoinScriptType,
  policy: BitcoinPolicyType,
  account = 0,
): string {
  const purpose: Record<BitcoinScriptType, string> = {
    native_segwit: '84',
    nested_segwit: '49',
    legacy: '44',
    taproot: '86',
  }
  if (policy === 'singlesig') {
    return `m/${purpose[script]}'/0'/${account}'`
  }
  switch (script) {
    case 'native_segwit':
    case 'taproot':
      return `m/48'/0'/${account}'/2'`
    case 'nested_segwit':
      return `m/48'/0'/${account}'/1'`
    case 'legacy':
      return `m/45'/${account}`
    default:
      return DEFAULT_COSIGNER_DERIVATION
  }
}

export function scriptFromDerivation(derivation: string): BitcoinScriptType | null {
  const path = derivation.toLowerCase()
  if (path.includes("/86'") || path.startsWith("m/86'")) return 'taproot'
  if (path.includes("/49'") || path.startsWith("m/49'")) return 'nested_segwit'
  if (path.includes("/44'") || path.startsWith("m/44'")) return 'legacy'
  if (path.includes("/84'") || path.startsWith("m/84'")) return 'native_segwit'
  if (path.includes("/48'")) {
    if (path.includes("/2'")) return 'native_segwit'
    if (path.includes("/1'")) return 'nested_segwit'
  }
  if (path.includes("/45'") || path.startsWith("m/45'")) return 'legacy'
  return null
}

export function policyFromDerivation(derivation: string): BitcoinPolicyType {
  const path = derivation.toLowerCase()
  if (path.includes("/48'") || path.includes("/45'")) return 'multisig'
  return 'singlesig'
}

export function scriptFromXpubKey(xpubKey: string, derivation?: string | null): BitcoinScriptType | null {
  if (derivation) {
    const fromPath = scriptFromDerivation(derivation)
    if (fromPath) return fromPath
  }
  switch (xpubKey.slice(0, 4).toLowerCase()) {
    case 'zpub':
    case 'vpub':
      return 'native_segwit'
    case 'ypub':
    case 'upub':
      return 'nested_segwit'
    case 'xpub':
    case 'tpub':
      // Ambiguous (legacy BIP44, BIP86 Taproot, or BIP48 cosigner). Don't auto-switch.
      return null
    default:
      return null
  }
}

/** Confident script type for imports — never force Legacy from a bare xpub/tpub. */
export function resolveImportScriptType(
  opts: {
    scriptType?: string | null
    derivation?: string | null
    key?: string | null
  },
): BitcoinScriptType | null {
  const key = (opts.key || '').trim()
  const prefix = key.slice(0, 4).toLowerCase()
  const ambiguousXpub = prefix === 'xpub' || prefix === 'tpub'
  const fromPrefixOnly = key
    ? scriptFromXpubKey(key, null)
    : null
  if (fromPrefixOnly) return fromPrefixOnly

  const fromPath = opts.derivation ? scriptFromDerivation(opts.derivation) : null
  if (fromPath) {
    // Old parsers mapped bare xpub → m/44' + legacy. Treat that as ambiguous.
    if (ambiguousXpub && fromPath === 'legacy') return null
    return fromPath
  }

  const st = (opts.scriptType || '').trim().toLowerCase()
  if (st === 'native_segwit' || st === 'nested_segwit' || st === 'taproot' || st === 'legacy') {
    if (ambiguousXpub && st === 'legacy') return null
    return st as BitcoinScriptType
  }
  return null
}

/** Whether a connect-bundle derivation belongs to multisig (BIP48/45) vs singlesig. */
export function derivationLooksMultisig(derivation?: string | null): boolean {
  const path = (derivation || '').toLowerCase()
  return path.includes("/48'") || path.includes("/45'")
}

/**
 * Pick the SeedMask Connect / Sparrow multi-script option that matches the UI
 * selection (e.g. Taproot singlesig → bip86), instead of always taking Native SegWit.
 */
export function pickConnectScriptOption(
  options: Array<{
    script_type?: string | null
    derivation?: string | null
    xpub?: string | null
    label?: string | null
  }>,
  script: BitcoinScriptType,
  policy: BitcoinPolicyType,
): { script_type: BitcoinScriptType; derivation: string; xpub: string; label: string } | null {
  const usable = options
    .map((o) => {
      const st = (o.script_type || '').trim().toLowerCase()
      const xpub = (o.xpub || '').trim()
      if (!xpub) return null
      if (st !== 'native_segwit' && st !== 'nested_segwit' && st !== 'legacy' && st !== 'taproot') {
        return null
      }
      return {
        script_type: st as BitcoinScriptType,
        derivation: (o.derivation || '').trim(),
        xpub,
        label: (o.label || '').trim() || st,
      }
    })
    .filter((o): o is NonNullable<typeof o> => o != null)

  if (usable.length === 0) return null

  const wantMs = policy === 'multisig'
  const matching = usable.filter((o) => {
    if (o.script_type !== script) return false
    // Taproot is singlesig-only in our UI.
    if (script === 'taproot') return !derivationLooksMultisig(o.derivation)
    const looksMs = derivationLooksMultisig(o.derivation)
    return wantMs ? looksMs || !o.derivation : !looksMs
  })
  if (matching[0]) return matching[0]

  // Same script type, any policy affinity (e.g. native_segwit bip84 vs bip48).
  const sameScript = usable.filter((o) => o.script_type === script)
  if (sameScript.length === 1) return sameScript[0]
  if (sameScript.length > 1) {
    const byPolicy = sameScript.find((o) =>
      wantMs ? derivationLooksMultisig(o.derivation) : !derivationLooksMultisig(o.derivation),
    )
    if (byPolicy) return byPolicy
  }
  return null
}

export function emptyCosigner(index: number, derivation = DEFAULT_COSIGNER_DERIVATION): MultisigCosignerDraft {
  return {
    id: crypto.randomUUID(),
    label: index > 0 ? `Cosigner ${index}` : 'Cosigner 1',
    fingerprint: DEFAULT_FINGERPRINT,
    derivation: derivation || DEFAULT_COSIGNER_DERIVATION,
    xpub: '',
  }
}

export function cosignerToPayload(c: MultisigCosignerDraft): MultisigCosigner {
  return {
    xpub: c.xpub,
    fingerprint: c.fingerprint || undefined,
    derivation: c.derivation || undefined,
    label: c.label || undefined,
  }
}

export function sanitizeFingerprint(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '')
    .slice(0, 8)
}

export function normalizeFingerprint(raw?: string | null): string | null {
  if (!raw) return null
  const cleaned = sanitizeFingerprint(raw)
  return cleaned.length === 8 ? cleaned : null
}

const PLACEHOLDER_FINGERPRINTS = new Set(['00000000', 'FFFFFFFF'])

export function isPlaceholderFingerprint(raw?: string | null): boolean {
  const fp = normalizeFingerprint(raw)
  return fp != null && PLACEHOLDER_FINGERPRINTS.has(fp)
}

export function importFingerprint(raw?: string | null): string {
  return normalizeFingerprint(raw) ?? DEFAULT_FINGERPRINT
}

export function isPresetQuorum(q: BitcoinMultisigQuorum): boolean {
  return QUORUM_PRESETS.some((p) => p.required === q.required && p.total === q.total)
}
