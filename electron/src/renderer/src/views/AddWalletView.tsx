import { useCallback, useEffect, useRef, useState } from 'react'
import { APIError } from '@renderer/api/client'
import type { CoinChain, ConnectScriptOption, KpubParseResponse, MultisigCosigner, WalletDTO } from '@renderer/api/types'
import {
  AddWalletTopLayout,
  MainWalletFormCard,
  MultisigCosignersSection,
  MultisigQuorumCard,
  SinglesigKeystoreSection,
  SinglesigPolicyCard,
} from '@renderer/components/MultisigWalletForm'
import {
  ConnectHardwareWalletSheet,
  type HardwareImportPayload,
} from '@renderer/components/ConnectHardwareWalletSheet'
import { QRScannerSheet } from '@renderer/components/QRScannerSheet'
import { WalletMark } from '@renderer/components/BrandMarks'
import { ImportFileIcon } from '@renderer/components/icons'
import { WalletPasswordModal } from '@renderer/components/WalletPasswordModal'
import { InfoTipButton } from '@renderer/components/settings/SettingsChrome'
import { useApp } from '@renderer/state/AppProvider'
import {
  type BitcoinMultisigQuorum,
  type BitcoinPolicyType,
  type BitcoinScriptType,
  type ExtendedKeyMetadata,
  type MultisigCosignerDraft,
  cosignerToPayload,
  DEFAULT_FINGERPRINT,
  derivationPath,
  emptyCosigner,
  importFingerprint,
  isPlaceholderFingerprint,
  isPresetQuorum,
  isValidQuorum,
  normalizeFingerprint,
  resolveImportScriptType,
  scriptFromDerivation,
  pickConnectScriptOption,
  policyFromDerivation,
} from '@renderer/utils/bitcoinWallet'
import {
  extractKey,
  extractKeyForCoin,
  importKeyValidationError,
  parseExtendedKeyMetadata,
} from '@renderer/utils/extendedKey'
import { openFileWithDialog } from '@renderer/utils/nativeFiles'
import { apiError } from '@renderer/utils/userErrors'
import { needsKaspaImportHistoryPrompt } from '@renderer/utils/networkSettings'

export function AddWalletView({
  onDone,
  onCancel,
  showDeviceGuide = false,
}: {
  onDone: () => void
  onCancel?: () => void
  showDeviceGuide?: boolean
}): React.JSX.Element {
  const {
    api,
    selectedChain,
    wallets,
    loadWallets,
    activateWallet,
    setStatusMessage,
    discoverWallet,
    draftWalletLabel,
    setDraftWalletLabel,
    networkSettings,
    setKaspaImportHistoryPromptWalletId,
  } = useApp()

  const [walletName, setWalletName] = useState(draftWalletLabel)
  const [duplicateOneKeyNotice, setDuplicateOneKeyNotice] = useState<{
    walletLabel: string
    receiveNote: string
  } | null>(null)
  const [kpubRaw, setKpubRaw] = useState('')
  const [scanLimit, setScanLimit] = useState(30)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [encryptPromptOpen, setEncryptPromptOpen] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [pendingImport, setPendingImport] = useState<{
    payload: Record<string, unknown>
    label: string
    hint: string
  } | null>(null)
  const [importPasswordError, setImportPasswordError] = useState<string | null>(null)
  const [encryptError, setEncryptError] = useState<string | null>(null)
  const [showScanner, setShowScanner] = useState(false)
  const [walletMeta, setWalletMeta] = useState<ExtendedKeyMetadata | null>(null)
  const [capturedFingerprint, setCapturedFingerprint] = useState<string | null>(null)
  const [capturedDerivation, setCapturedDerivation] = useState<string | null>(null)
  const [masterFingerprint, setMasterFingerprint] = useState(DEFAULT_FINGERPRINT)
  const [bitcoinPolicyType, setBitcoinPolicyType] = useState<BitcoinPolicyType>('singlesig')
  const [bitcoinScriptType, setBitcoinScriptType] = useState<BitcoinScriptType>('native_segwit')
  const [multisigQuorum, setMultisigQuorum] = useState<BitcoinMultisigQuorum>({ required: 2, total: 3 })
  const [multisigCosigners, setMultisigCosigners] = useState<MultisigCosignerDraft[]>([])
  const [selectedCosignerIndex, setSelectedCosignerIndex] = useState(0)
  const [useCustomQuorum, setUseCustomQuorum] = useState(false)
  const [scanCosignerIndex, setScanCosignerIndex] = useState<number | null>(null)
  const [lastScanPayload, setLastScanPayload] = useState('')
  const [singlesigKeystore, setSinglesigKeystore] = useState<MultisigCosignerDraft>(() => ({
    ...emptyCosigner(1),
    label: 'Keystore',
    derivation: '',
  }))
  const [descriptorRaw, setDescriptorRaw] = useState('')
  const [descriptorParseOK, setDescriptorParseOK] = useState(false)
  const [descriptorParseError, setDescriptorParseError] = useState<string | null>(null)
  const [showHardwareConnect, setShowHardwareConnect] = useState(false)
  const [hardwareSource, setHardwareSource] = useState<'' | 'ledger' | 'onekey' | 'seedmask'>('')
  const hardwareSourceRef = useRef<'' | 'ledger' | 'onekey' | 'seedmask'>('')
  const [connectScriptOptions, setConnectScriptOptions] = useState<ConnectScriptOption[]>([])

  const lockImportMetaRef = useRef(false)
  const hardwareImportLockRef = useRef(false)
  const policyBeforeDescriptorRef = useRef<BitcoinPolicyType | null>(null)
  const descriptorParseGenRef = useRef(0)

  function setHardwareSourceTracked(next: '' | 'ledger' | 'onekey' | 'seedmask'): void {
    hardwareSourceRef.current = next
    setHardwareSource(next)
  }

  function markSeedMaskHardwareFromParse(parsed: { format?: string } | null | undefined, raw?: string): void {
    const fmt = (parsed?.format || '').trim().toLowerCase()
    if (fmt === 'seedmask_connect' || fmt === 'seedmask_export') {
      setHardwareSourceTracked('seedmask')
      hardwareImportLockRef.current = true
      return
    }
    if ((raw || '').trim().toUpperCase().startsWith('SM|')) {
      setHardwareSourceTracked('seedmask')
      hardwareImportLockRef.current = true
    }
  }

  const isMultisigImport = bitcoinPolicyType === 'multisig'
  const descriptorText = descriptorRaw.trim()
  const hasValidDescriptor =
    selectedChain === 'bitcoin' && descriptorText.length > 0 && descriptorParseOK && !descriptorParseError

  function accountIndexFromDerivation(path: string | null | undefined): number | null {
    if (!path) return null
    const trimmed = path.trim()
    // Receive path under account 0' (OneKey App style) — BIP44 account is 0, not the receive index.
    if (/m\/44'\/111111'\/0'\/0\/\d+\s*$/i.test(trimmed)) return 0
    const m = trimmed.match(/\/(\d+)'\s*$/)
    if (!m) return null
    const n = Number(m[1])
    return Number.isFinite(n) ? n : null
  }

  function kaspaDerivationPath(account = walletMeta?.account ?? 0): string {
    return `m/44'/111111'/${account}'`
  }

  function kaspaMultisigDerivationPath(account = walletMeta?.account ?? 0): string {
    return `m/45'/111111'/${account}'`
  }

  function defaultMultisigDerivation(account = walletMeta?.account ?? 0): string {
    return selectedChain === 'kaspa'
      ? kaspaMultisigDerivationPath(account)
      : derivationPath(bitcoinScriptType, 'multisig', account)
  }

  const subtitle =
    selectedChain === 'bitcoin'
      ? bitcoinPolicyType === 'multisig'
        ? 'Watch-only · add each cosigner xpub'
        : 'Watch-only · paste or scan xpub'
      : bitcoinPolicyType === 'multisig'
        ? 'Watch-only · add each cosigner kpub'
        : 'Watch-only · paste or scan kpub'

  const displayedDerivation = useCallback((): string => {
    if (selectedChain === 'bitcoin') {
      if (capturedDerivation) return capturedDerivation
      const account = walletMeta?.account ?? 0
      return derivationPath(bitcoinScriptType, bitcoinPolicyType, account)
    }
    if (bitcoinPolicyType === 'multisig') return kaspaMultisigDerivationPath(walletMeta?.account ?? 0)
    // Prefer path from hardware/scan import — bare kpubs have no account path embedded.
    return (
      capturedDerivation ||
      singlesigKeystore.derivation.trim() ||
      walletMeta?.derivation ||
      kaspaDerivationPath(walletMeta?.account ?? 0)
    )
  }, [
    selectedChain,
    capturedDerivation,
    singlesigKeystore.derivation,
    walletMeta,
    bitcoinScriptType,
    bitcoinPolicyType,
  ])

  const resolvedImportDerivation = useCallback((): string | undefined => {
    if (selectedChain === 'bitcoin') {
      if (capturedDerivation) return capturedDerivation
      const account = walletMeta?.account ?? 0
      return derivationPath(bitcoinScriptType, bitcoinPolicyType, account)
    }
    if (bitcoinPolicyType === 'multisig') return kaspaMultisigDerivationPath(walletMeta?.account ?? 0)
    return (
      capturedDerivation ||
      singlesigKeystore.derivation.trim() ||
      walletMeta?.derivation ||
      kaspaDerivationPath(walletMeta?.account ?? 0)
    )
  }, [
    selectedChain,
    capturedDerivation,
    singlesigKeystore.derivation,
    walletMeta,
    bitcoinScriptType,
    bitcoinPolicyType,
  ])

  const resolvedImportFingerprint = useCallback((): string | undefined => {
    return (
      normalizeFingerprint(singlesigKeystore.fingerprint) ??
      normalizeFingerprint(masterFingerprint) ??
      (capturedFingerprint || undefined) ??
      (walletMeta?.fingerprint || undefined)
    )
  }, [singlesigKeystore.fingerprint, masterFingerprint, capturedFingerprint, walletMeta])

  const extendedKeyValidationError = importKeyValidationError(
    selectedChain,
    extractKeyForCoin(selectedChain, kpubRaw),
  )

  const multisigCosignersComplete =
    multisigCosigners.length === multisigQuorum.total &&
    multisigCosigners.every((c) => importKeyValidationError(selectedChain, extractKeyForCoin(selectedChain, c.xpub)) == null)

  const multisigFingerprintsReady =
    selectedChain !== 'bitcoin' ||
    !isMultisigImport ||
    multisigCosigners.every((c) => {
      const fp = normalizeFingerprint(c.fingerprint)
      return fp != null && !isPlaceholderFingerprint(fp)
    })

  const bitcoinFingerprintReady =
    selectedChain !== 'bitcoin' ||
    isMultisigImport ||
    (resolvedImportFingerprint() != null && !isPlaceholderFingerprint(resolvedImportFingerprint()))

  const canAdd = hasValidDescriptor
    ? true
    : walletName.trim().length > 0 &&
      (isMultisigImport
        ? isValidQuorum(multisigQuorum) && multisigCosignersComplete && multisigFingerprintsReady
        : extendedKeyValidationError == null && bitcoinFingerprintReady)

  const scanSheetTitle =
    selectedChain === 'bitcoin'
      ? scanCosignerIndex != null
        ? `Scan cosigner ${scanCosignerIndex + 1}`
        : 'Scan SeedMask export'
      : scanCosignerIndex != null
        ? `Scan cosigner ${scanCosignerIndex + 1}`
        : 'Scan SeedMask export'

  const scanSheetHint =
    selectedChain === 'bitcoin'
      ? 'Scan Connect Software → SeedMask Coordinator (animated) or Export xpub (SM|…).'
      : 'Scan Connect Software → SeedMask Coordinator (animated) or Export kpub (SM|…).'

  function updateDerivationsForScriptAndPolicy(
    script: BitcoinScriptType,
    policy: BitcoinPolicyType,
    account = walletMeta?.account ?? 0,
  ): void {
    if (lockImportMetaRef.current || selectedChain !== 'bitcoin') return
    const path = derivationPath(script, policy, account)
    if (policy === 'multisig') {
      setMultisigCosigners((prev) => prev.map((c) => ({ ...c, derivation: path })))
    } else {
      setSinglesigKeystore((k) => ({ ...k, derivation: path }))
    }
    setCapturedDerivation(null)
  }

  function applyScriptType(script: BitcoinScriptType): void {
    setBitcoinScriptType(script)
    const fromConnect = connectScriptOptions.find((o) => o.script_type === script)
    if (fromConnect?.xpub) {
      const key = extractKeyForCoin(selectedChain, fromConnect.xpub)
      const deriv = fromConnect.derivation || ''
      setCapturedDerivation(deriv || null)
      if (bitcoinPolicyType === 'multisig') {
        setMultisigCosigners((prev) => {
          if (!prev[selectedCosignerIndex]) return prev
          const next = [...prev]
          next[selectedCosignerIndex] = {
            ...next[selectedCosignerIndex],
            xpub: key,
            derivation: deriv || next[selectedCosignerIndex].derivation,
          }
          return next
        })
        if (selectedCosignerIndex === 0) setKpubRaw(key)
      } else {
        setKpubRaw(key)
        setSinglesigKeystore((k) => ({
          ...k,
          xpub: key,
          derivation: deriv || k.derivation,
        }))
        setWalletMeta((prev) =>
          prev
            ? {
                ...prev,
                derivation: deriv || prev.derivation,
              }
            : prev,
        )
      }
      hardwareImportLockRef.current = true
      setHardwareSourceTracked(hardwareSourceRef.current || 'seedmask')
      return
    }
    updateDerivationsForScriptAndPolicy(script, bitcoinPolicyType)
  }

  function applyConnectScriptBundle(parsed: KpubParseResponse): void {
    const options = parsed.script_options?.filter((o) => o.xpub?.trim()) ?? []
    setConnectScriptOptions(options)
    markSeedMaskHardwareFromParse(parsed)
    if (options.length > 0) {
      setHardwareSourceTracked('seedmask')
      hardwareImportLockRef.current = true
    }
  }

  function syncSinglesigKeystoreFromForm(): void {
    setSinglesigKeystore((k) => {
      let derivation = k.derivation
      if (selectedChain === 'bitcoin') {
        if (!derivation.trim()) {
          derivation = derivationPath(bitcoinScriptType, 'singlesig', walletMeta?.account ?? 0)
        }
      } else if (!derivation.trim()) {
        const metaDeriv = walletMeta?.derivation?.trim()
        derivation = metaDeriv || kaspaDerivationPath(walletMeta?.account ?? 0)
      } else if (selectedChain === 'kaspa' && derivation.startsWith("m/48'/0'")) {
        derivation = kaspaDerivationPath(walletMeta?.account ?? 0)
      }
      return {
        ...k,
        xpub: kpubRaw,
        fingerprint: masterFingerprint,
        label: k.label.trim() || 'Keystore',
        derivation,
      }
    })
  }
  function syncCosignerSlots(quorum: BitcoinMultisigQuorum): void {
    const deriv = defaultMultisigDerivation()
    setMultisigCosigners((prev) => {
      let next = [...prev]
      while (next.length < quorum.total) {
        next.push(emptyCosigner(next.length + 1, deriv))
      }
      if (next.length > quorum.total) next = next.slice(0, quorum.total)
      return next.map((c) => (selectedChain === 'kaspa' || !c.derivation ? { ...c, derivation: deriv } : c))
    })
  }

  function clampSelectedCosignerIndex(count: number): void {
    setSelectedCosignerIndex((i) => (count === 0 ? 0 : i >= count ? count - 1 : i))
  }

  function applyImportMeta(
    meta: {
      derivation?: string
      fingerprint?: string
      scriptType?: string | null
      key?: string | null
      multisigM?: number | null
      multisigN?: number | null
      multisigCosigners?: MultisigCosigner[] | null
      walletName?: string | null
    },
    fromScan = false,
  ): void {
    if (hasValidDescriptor) return
    // ingestScan holds the lock so refreshWalletMeta cannot race; still apply scan meta.
    if (lockImportMetaRef.current && !fromScan) return
    const { derivation = '', fingerprint = '', scriptType, key, multisigM, multisigN, multisigCosigners: cosigners, walletName: parsedName } = meta

    if (fromScan && derivation) setCapturedDerivation(derivation)
    const policy = derivation ? policyFromDerivation(derivation) : bitcoinPolicyType
    if (policy !== 'multisig' && derivation) {
      setSinglesigKeystore((k) => ({ ...k, derivation }))
    }

    // SM|xfp|…|kpub/xpub — apply for Kaspa and Bitcoin (UI field + createWallet).
    const fp = normalizeFingerprint(fingerprint)
    if (fp && !isPlaceholderFingerprint(fp)) {
      setMasterFingerprint(fp)
      setCapturedFingerprint(fp)
      if (policy !== 'multisig') setSinglesigKeystore((k) => ({ ...k, fingerprint: fp }))
    }

    if (selectedChain === 'bitcoin') {
      if (derivation) setBitcoinPolicyType(policy)
      const importedKey = extractKey(key || kpubRaw)
      const script = resolveImportScriptType({
        scriptType,
        derivation,
        key: importedKey,
      })
      // Bare xpub/tpub must not override an explicit UI choice (e.g. Taproot).
      if (script) {
        const prefix = importedKey.slice(0, 4).toLowerCase()
        const ambiguousXpub = prefix === 'xpub' || prefix === 'tpub'
        const pathConfident = !!(derivation && scriptFromDerivation(derivation))
        if (!ambiguousXpub || pathConfident || scriptType) {
          setBitcoinScriptType(policy === 'multisig' && script === 'taproot' ? 'native_segwit' : script)
        }
      }
      if (multisigM && multisigN && multisigM > 0 && multisigN > 0) {
        const q = { required: multisigM, total: multisigN }
        if (isValidQuorum(q)) {
          setMultisigQuorum(q)
          setUseCustomQuorum(!isPresetQuorum(q))
        }
      }
      if (cosigners?.length) {
        setBitcoinPolicyType('multisig')
        applyMultisigCosigners(cosigners, multisigM, multisigN)
      }
      if (parsedName && !walletName.trim()) setWalletName(parsedName)
    }
  }

  function applyMultisigCosigners(cosigners: MultisigCosigner[], m?: number | null, n?: number | null): void {
    let quorum = multisigQuorum
    if (m && n && m > 0 && n > 0 && isValidQuorum({ required: m, total: n })) {
      quorum = { required: m, total: n }
      setMultisigQuorum(quorum)
    } else if (cosigners.length === 1) {
      quorum = { required: 1, total: 1 }
      setMultisigQuorum(quorum)
    } else if (cosigners.length >= 2) {
      quorum = { required: 2, total: cosigners.length }
      setMultisigQuorum(quorum)
    }
    setUseCustomQuorum(!isPresetQuorum(quorum))
    const deriv = defaultMultisigDerivation()
    const drafts = Array.from({ length: quorum.total }, (_, i) => emptyCosigner(i + 1, deriv))
    cosigners.slice(0, quorum.total).forEach((c, idx) => {
      drafts[idx] = {
        ...drafts[idx],
        xpub: c.xpub,
        fingerprint: normalizeFingerprint(c.fingerprint) ?? drafts[idx].fingerprint,
        label: c.label?.trim() || drafts[idx].label,
        derivation: c.derivation?.trim() || deriv,
      }
    })
    setMultisigCosigners(drafts)
    setSelectedCosignerIndex(0)
    if (cosigners[0]) {
      setKpubRaw(cosigners[0].xpub)
      const fp = normalizeFingerprint(cosigners[0].fingerprint)
      if (fp) setMasterFingerprint(fp)
    }
  }

  function applyParsedImport(parsed: KpubParseResponse, fromScan = false): void {
    if (!parsed.kpub) return
    const keyErr = importKeyValidationError(selectedChain, parsed.kpub)
    if (keyErr) {
      setErrorMessage(keyErr)
      return
    }
    applyConnectScriptBundle(parsed)
    markSeedMaskHardwareFromParse(parsed)

    const options = parsed.script_options?.filter((o) => o.xpub?.trim()) ?? []
    // Multi-script SeedMask/Sparrow connect QR: honor the script type the user already picked
    // (Taproot → bip86), instead of always taking Native SegWit from the bundle default.
    const picked =
      selectedChain === 'bitcoin' && options.length > 0
        ? pickConnectScriptOption(options, bitcoinScriptType, bitcoinPolicyType)
        : null

    let kpub = picked?.xpub || parsed.kpub
    let derivation = picked?.derivation || parsed.derivation || ''
    let scriptType = picked?.script_type || parsed.script_type || null
    let policy: BitcoinPolicyType =
      parsed.policy_type === 'multisig' || parsed.policy_type === 'singlesig'
        ? parsed.policy_type
        : bitcoinPolicyType

    if (picked) {
      scriptType = picked.script_type
      // Keep the user's policy when the bundle is a full singlesig multi-script export.
      if (parsed.policy_type === 'singlesig' || parsed.policy_type === 'multisig') {
        policy = parsed.policy_type
      } else if (derivation) {
        policy = policyFromDerivation(derivation)
      }
    }

    const asMultisig = policy === 'multisig'
    setBitcoinPolicyType(policy)
    if (scriptType === 'native_segwit' || scriptType === 'nested_segwit' || scriptType === 'legacy' || scriptType === 'taproot') {
      if (!(asMultisig && scriptType === 'taproot')) {
        setBitcoinScriptType(scriptType)
      }
    }

    setKpubRaw(kpub)
    const fp = normalizeFingerprint(parsed.fingerprint)
    if (asMultisig) {
      setMultisigCosigners((prev) => {
        const next = prev.length ? [...prev] : [emptyCosigner(1, derivation || defaultMultisigDerivation())]
        const idx = Math.min(selectedCosignerIndex, next.length - 1)
        next[idx] = {
          ...next[idx],
          xpub: kpub,
          fingerprint: fp && !isPlaceholderFingerprint(fp) ? fp : next[idx].fingerprint,
          derivation: derivation.trim() || next[idx].derivation,
        }
        return next
      })
    } else {
      setSinglesigKeystore((k) => ({
        ...k,
        xpub: kpub,
        fingerprint: fp && !isPlaceholderFingerprint(fp) ? fp : k.fingerprint,
        derivation: derivation.trim() || k.derivation,
      }))
    }
    if (derivation.trim()) setCapturedDerivation(derivation.trim())
    setWalletMeta({
      derivation: derivation || '',
      fingerprint: parsed.fingerprint ?? '',
      account: parsed.account ?? 0,
      coin: (parsed.coin as CoinChain) ?? selectedChain,
    })
    applyImportMeta(
      {
        derivation: derivation || undefined,
        fingerprint: parsed.fingerprint,
        scriptType,
        key: kpub,
        multisigM: parsed.multisig_m,
        multisigN: parsed.multisig_n,
        multisigCosigners: parsed.multisig_cosigners,
        walletName: parsed.label,
      },
      fromScan,
    )
  }

  const refreshWalletMeta = useCallback(async () => {
    if (!api || hasValidDescriptor) return
    // Hardware / QR import already set derivation + account. Bare kpubs default to
    // account #0 — do not wipe a locked import (e.g. OneKey account #1+).
    if (lockImportMetaRef.current || hardwareImportLockRef.current) return
    const raw = kpubRaw.trim()
    const scan = lastScanPayload.trim()
    const scanUsable =
      scan.length > 0 &&
      importKeyValidationError(selectedChain, extractKeyForCoin(selectedChain, scan)) == null
    const candidates: string[] = []
    if (!raw) {
      if (scanUsable) candidates.push(scan)
    } else if (!scan || scan === raw || !scanUsable) {
      candidates.push(raw)
    } else {
      candidates.push(scan, raw)
    }

    if (extendedKeyValidationError) {
      setWalletMeta(null)
      return
    }

    for (const text of candidates) {
      if (!text) continue
      if (lockImportMetaRef.current) return
      const local = parseExtendedKeyMetadata(text, selectedChain)
      if (local) {
        // Bare kpubs carry no account — keep path from hardware/QR when we have one.
        const accountFromCaptured = accountIndexFromDerivation(capturedDerivation)
        setWalletMeta(
          capturedDerivation
            ? {
                ...local,
                derivation: capturedDerivation,
                account: accountFromCaptured ?? local.account,
              }
            : local,
        )
        applyImportMeta(
          {
            derivation: capturedDerivation || local.derivation,
            fingerprint: local.fingerprint,
            key: text,
          },
          lastScanPayload.length > 0,
        )
        return
      }
      try {
        const parsed = await api.parseKpub(text, selectedChain)
        if (lockImportMetaRef.current) return
        if (!parsed.kpub || importKeyValidationError(selectedChain, parsed.kpub)) continue
        const accountFromCaptured = accountIndexFromDerivation(capturedDerivation)
        setWalletMeta({
          derivation: capturedDerivation || parsed.derivation || '',
          fingerprint: parsed.fingerprint ?? '',
          account: accountFromCaptured ?? parsed.account ?? 0,
          coin: selectedChain,
        })
        applyImportMeta(
          {
            derivation: capturedDerivation || parsed.derivation,
            fingerprint: parsed.fingerprint,
            scriptType: parsed.script_type,
            key: parsed.kpub,
            multisigM: parsed.multisig_m,
            multisigN: parsed.multisig_n,
            multisigCosigners: parsed.multisig_cosigners,
            walletName: parsed.label,
          },
          lastScanPayload.length > 0,
        )
        return
      } catch {
        /* try next candidate */
      }
    }
    if (!lockImportMetaRef.current && !hardwareImportLockRef.current) setWalletMeta(null)
  }, [
    api,
    hasValidDescriptor,
    kpubRaw,
    lastScanPayload,
    selectedChain,
    extendedKeyValidationError,
    capturedDerivation,
  ])

  async function ingestScan(payload: string): Promise<void> {
    if (!api) return
    setErrorMessage(null)
    setLastScanPayload(payload)
    lockImportMetaRef.current = true
    try {
      const parsed = await api.parseKpub(payload, selectedChain)
      if (!parsed.kpub) throw new Error('Could not parse watch-only key')
      const keyErr = importKeyValidationError(selectedChain, parsed.kpub)
      if (keyErr) {
        setErrorMessage(keyErr)
        return
      }
      markSeedMaskHardwareFromParse(parsed, payload)
      applyParsedImport(parsed, true)
      setStatusMessage(selectedChain === 'bitcoin' ? 'xpub captured' : 'kpub captured')
    } catch (e) {
      const local = parseExtendedKeyMetadata(payload, selectedChain)
      if (local) {
        const key = extractKeyForCoin(selectedChain, payload)
        const keyErr = importKeyValidationError(selectedChain, key)
        if (keyErr) {
          setErrorMessage(keyErr)
          return
        }
        markSeedMaskHardwareFromParse(null, payload)
        setKpubRaw(key)
        if (!isMultisigImport) {
          const fp = normalizeFingerprint(local.fingerprint)
          setSinglesigKeystore((k) => ({
            ...k,
            xpub: key,
            fingerprint: fp && !isPlaceholderFingerprint(fp) ? fp : k.fingerprint,
          }))
        }
        setWalletMeta(local)
        applyImportMeta({ derivation: local.derivation, fingerprint: local.fingerprint, key }, true)
        setStatusMessage(selectedChain === 'bitcoin' ? 'xpub captured' : 'kpub captured')
        return
      }
      const key = extractKeyForCoin(selectedChain, payload)
      if (importKeyValidationError(selectedChain, key) == null) {
        setKpubRaw(key)
        if (!isMultisigImport) setSinglesigKeystore((k) => ({ ...k, xpub: key }))
        await refreshWalletMeta()
        setStatusMessage(selectedChain === 'bitcoin' ? 'xpub captured' : 'kpub captured')
      } else {
        setErrorMessage(
          selectedChain === 'kaspa'
            ? 'Expected a Kaspa kpub — scan Export kpub from SeedMask, not a Bitcoin xpub/zpub on screen.'
            : formatError(e),
        )
      }
    } finally {
      lockImportMetaRef.current = false
    }
  }

  async function ingestCosignerScan(index: number, payload: string): Promise<void> {
    if (!api) return
    setErrorMessage(null)
    setLastScanPayload(payload)
    lockImportMetaRef.current = true
    try {
      const parsed = await api.parseKpub(payload, selectedChain)
      if (parsed.multisig_cosigners && parsed.multisig_cosigners.length > 0) {
        setBitcoinPolicyType('multisig')
        applyImportMeta(
          {
            derivation: parsed.derivation,
            fingerprint: parsed.fingerprint,
            scriptType: parsed.script_type,
            key: parsed.kpub,
            multisigM: parsed.multisig_m,
            multisigN: parsed.multisig_n,
            multisigCosigners: parsed.multisig_cosigners,
            walletName: parsed.label,
          },
          true,
        )
        setStatusMessage('Multisig policy captured')
        return
      }
      if (!parsed.kpub) throw new Error(`Could not parse ${selectedChain === 'kaspa' ? 'kpub' : 'xpub'}`)
      setMultisigCosigners((prev) => {
        if (!prev[index]) return prev
        const next = [...prev]
        next[index] = {
          ...next[index],
          xpub: parsed.kpub!,
          fingerprint: normalizeFingerprint(parsed.fingerprint) ?? next[index].fingerprint,
          derivation: parsed.derivation?.trim() || next[index].derivation,
        }
        return next
      })
      if (index === 0) setKpubRaw(parsed.kpub)
      setSelectedCosignerIndex(index)
      applyImportMeta(
        {
          derivation: parsed.derivation,
          fingerprint: parsed.fingerprint,
          scriptType: parsed.script_type,
          key: parsed.kpub,
        },
        true,
      )
      setStatusMessage(`Cosigner ${index + 1} ${selectedChain === 'kaspa' ? 'kpub' : 'xpub'} captured`)
    } catch (e) {
      const local = parseExtendedKeyMetadata(payload, selectedChain)
      if (local) {
        const key = extractKeyForCoin(selectedChain, payload)
        setMultisigCosigners((prev) => {
          if (!prev[index]) return prev
          const next = [...prev]
          next[index] = {
            ...next[index],
            xpub: key,
            fingerprint: normalizeFingerprint(local.fingerprint) ?? next[index].fingerprint,
            derivation: local.derivation || next[index].derivation,
          }
          return next
        })
        if (index === 0) setKpubRaw(key)
        applyImportMeta({ derivation: local.derivation, fingerprint: local.fingerprint, key }, true)
        setStatusMessage(`Cosigner ${index + 1} ${selectedChain === 'kaspa' ? 'kpub' : 'xpub'} captured`)
        return
      }
      const key = extractKeyForCoin(selectedChain, payload)
      if (importKeyValidationError(selectedChain, key) == null) {
        setMultisigCosigners((prev) => {
          if (!prev[index]) return prev
          const next = [...prev]
          next[index] = { ...next[index], xpub: key }
          return next
        })
        if (index === 0) setKpubRaw(key)
        setStatusMessage(`Cosigner ${index + 1} ${selectedChain === 'kaspa' ? 'kpub' : 'xpub'} captured`)
      } else {
        setErrorMessage(formatError(e))
      }
    } finally {
      lockImportMetaRef.current = false
    }
  }

  function applyDescriptorWallet(wallet: WalletDTO): void {
    lockImportMetaRef.current = true
    setKpubRaw(wallet.kpub)
    setSinglesigKeystore((k) => ({
      ...k,
      xpub: wallet.kpub,
      fingerprint: importFingerprint(wallet.fingerprint),
      derivation: wallet.derivation ?? k.derivation,
    }))
    const policy = (wallet.policy_type as BitcoinPolicyType) ?? policyFromDerivation(wallet.derivation ?? '')
    setBitcoinPolicyType(policy)
    const script = resolveImportScriptType({
      scriptType: wallet.script_type,
      derivation: wallet.derivation,
      key: wallet.kpub,
    })
    if (script) setBitcoinScriptType(script)
    if (wallet.multisig_m && wallet.multisig_n) {
      setMultisigQuorum({ required: wallet.multisig_m, total: wallet.multisig_n })
      setUseCustomQuorum(!isPresetQuorum({ required: wallet.multisig_m, total: wallet.multisig_n }))
    }
    if (wallet.multisig_cosigners?.length) {
      const deriv = derivationPath(
        (wallet.script_type as BitcoinScriptType) ?? 'native_segwit',
        'multisig',
        wallet.account,
      )
      setMultisigCosigners(
        wallet.multisig_cosigners.map((c, i) => ({
          id: crypto.randomUUID(),
          label: c.label?.trim() || `Cosigner ${i + 1}`,
          fingerprint: importFingerprint(c.fingerprint),
          derivation: c.derivation?.trim() || deriv,
          xpub: c.xpub,
        })),
      )
    }
    setMasterFingerprint(importFingerprint(wallet.fingerprint))
    if (!walletName.trim()) {
      const label = wallet.label.trim()
      if (label && label !== 'Descriptor wallet') setWalletName(label)
    }
    if (wallet.derivation) {
      setCapturedDerivation(wallet.derivation)
      setSinglesigKeystore((k) => ({ ...k, derivation: wallet.derivation! }))
    }
    setWalletMeta(parseExtendedKeyMetadata(wallet.kpub, 'bitcoin'))
    if (policy === 'multisig') {
      syncCosignerSlots({
        required: wallet.multisig_m ?? 2,
        total: wallet.multisig_n ?? 3,
      })
      setSelectedCosignerIndex(0)
    }
    lockImportMetaRef.current = false
  }

  function clearDescriptorImportState(): void {
    setDescriptorParseOK(false)
    setDescriptorParseError(null)
    if (policyBeforeDescriptorRef.current) {
      lockImportMetaRef.current = true
      setBitcoinPolicyType(policyBeforeDescriptorRef.current)
      lockImportMetaRef.current = false
      policyBeforeDescriptorRef.current = null
    }
  }

  useEffect(() => {
    if (!walletName && draftWalletLabel) setWalletName(draftWalletLabel)
    if (isMultisigImport && !isValidQuorum(multisigQuorum)) {
      setMultisigQuorum({ required: 2, total: 3 })
      setUseCustomQuorum(false)
    }
    syncSinglesigKeystoreFromForm()
    if (isMultisigImport) syncCosignerSlots(multisigQuorum)
    void refreshWalletMeta()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setDraftWalletLabel(walletName)
  }, [walletName, setDraftWalletLabel])

  useEffect(() => {
    setSinglesigKeystore((k) => ({ ...k, xpub: kpubRaw }))
    void refreshWalletMeta()
  }, [kpubRaw, refreshWalletMeta])

  useEffect(() => {
    resetImportedKeyState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChain])

  useEffect(() => {
    if (!lockImportMetaRef.current) {
      setSinglesigKeystore((k) => ({ ...k, fingerprint: masterFingerprint }))
    }
  }, [masterFingerprint])

  useEffect(() => {
    if (bitcoinPolicyType === 'multisig') {
      if (bitcoinScriptType === 'taproot') setBitcoinScriptType('native_segwit')
      // Slot count must follow M-of-N even after a hardware import lock.
      syncCosignerSlots(multisigQuorum)
      clampSelectedCosignerIndex(multisigCosigners.length || multisigQuorum.total)
    } else if (!lockImportMetaRef.current && !hardwareImportLockRef.current) {
      if (selectedChain === 'bitcoin') {
        updateDerivationsForScriptAndPolicy(bitcoinScriptType, 'singlesig', walletMeta?.account ?? 0)
      } else if (selectedChain === 'kaspa') {
        if (!capturedDerivation) {
          setSinglesigKeystore((k) => ({ ...k, derivation: kaspaDerivationPath(walletMeta?.account ?? 0) }))
        }
      }
    }
    if (!hardwareImportLockRef.current) {
      setCapturedDerivation(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bitcoinPolicyType])

  useEffect(() => {
    if (lockImportMetaRef.current) return
    if (multisigQuorum.total < multisigQuorum.required) {
      setMultisigQuorum((q) => ({ ...q, total: q.required }))
    }
  }, [multisigQuorum.required])

  useEffect(() => {
    // Keep keystore tiles matched to N. Do not gate on import locks — those only protect
    // derivation/fingerprint from being overwritten by parse/meta effects.
    syncCosignerSlots(multisigQuorum)
    clampSelectedCosignerIndex(multisigQuorum.total)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multisigQuorum.total])

  useEffect(() => {
    if (lockImportMetaRef.current || selectedChain !== 'bitcoin') return
    updateDerivationsForScriptAndPolicy(
      bitcoinScriptType,
      bitcoinPolicyType,
      walletMeta?.account ?? 0,
    )
  }, [bitcoinScriptType, bitcoinPolicyType, selectedChain, walletMeta?.account])

  useEffect(() => {
    if (lockImportMetaRef.current) return
    if (isMultisigImport || selectedChain !== 'kaspa' || !walletMeta?.derivation) return
    // Don't clobber a hardware-imported path with the bare-kpub default (account #0).
    if (capturedDerivation) return
    setSinglesigKeystore((k) => ({ ...k, derivation: walletMeta.derivation }))
  }, [walletMeta, selectedChain, isMultisigImport, capturedDerivation])

  useEffect(() => {
    if (selectedChain !== 'bitcoin') {
      clearDescriptorImportState()
      return
    }
    if (descriptorText && policyBeforeDescriptorRef.current == null) {
      policyBeforeDescriptorRef.current = bitcoinPolicyType
    }
    if (!descriptorText) {
      clearDescriptorImportState()
      return
    }
    descriptorParseGenRef.current += 1
    const gen = descriptorParseGenRef.current
    const timer = setTimeout(() => {
      void parseDescriptorImport(descriptorText, gen)
    }, 400)
    return () => clearTimeout(timer)
  }, [descriptorRaw, selectedChain, walletName, api])

  async function parseDescriptorImport(text: string, generation: number): Promise<void> {
    if (generation !== descriptorParseGenRef.current) return
    if (!api) {
      setDescriptorParseOK(false)
      setDescriptorParseError('Connecting to coordinator…')
      return
    }
    try {
      const parsed = await api.parseDescriptor(text, walletName.trim() || 'Descriptor wallet')
      if (generation !== descriptorParseGenRef.current || descriptorRaw.trim() !== text) return
      if (!parsed.wallet) throw new Error('Invalid descriptor response')
      setDescriptorParseOK(true)
      setDescriptorParseError(null)
      applyDescriptorWallet(parsed.wallet)
    } catch (e) {
      if (generation !== descriptorParseGenRef.current || descriptorRaw.trim() !== text) return
      setDescriptorParseOK(false)
      setDescriptorParseError(formatError(e))
    }
  }

  function resetImportedKeyState(): void {
    lockImportMetaRef.current = false
    hardwareImportLockRef.current = false
    setKpubRaw('')
    setLastScanPayload('')
    setWalletMeta(null)
    setCapturedFingerprint(null)
    setCapturedDerivation(null)
    setErrorMessage(null)
    setHardwareSourceTracked('')
    setConnectScriptOptions([])
    setSinglesigKeystore({ ...emptyCosigner(1), label: 'Keystore', derivation: '' })
    setDescriptorRaw('')
    setDescriptorParseOK(false)
    setDescriptorParseError(null)
    policyBeforeDescriptorRef.current = null
  }

  async function finishImportedWallet(wallet: WalletDTO): Promise<void> {
    await loadWallets()
    await activateWallet(wallet.id, wallet)
    hardwareImportLockRef.current = false
    lockImportMetaRef.current = false
    setStatusMessage('Wallet added')
    if (selectedChain === 'kaspa' && needsKaspaImportHistoryPrompt(networkSettings)) {
      setKaspaImportHistoryPromptWalletId(wallet.id)
      onDone()
      return
    }
    void discoverWallet(wallet.id)
    onDone()
  }

  async function addWallet(): Promise<void> {
    if (!api) {
      setErrorMessage('Coordinator not ready — wait a moment and try again')
      return
    }
    setErrorMessage(null)

    if (hasValidDescriptor) {
      if (!descriptorText || !descriptorParseOK) {
        setErrorMessage('Enter a valid output descriptor')
        return
      }
      setEncryptError(null)
      setEncryptPromptOpen(true)
      return
    }

    if (isMultisigImport && !multisigCosignersComplete) {
      setErrorMessage(`Add all ${multisigQuorum.total} cosigner xpubs`)
      return
    }
    if (extendedKeyValidationError) {
      setErrorMessage(extendedKeyValidationError)
      return
    }
    if (selectedChain === 'bitcoin' && !hasValidDescriptor) {
      if (isMultisigImport) {
        const missing = multisigCosigners.findIndex((c) => {
          const fp = normalizeFingerprint(c.fingerprint)
          return fp == null || isPlaceholderFingerprint(fp)
        })
        if (missing >= 0) {
          setErrorMessage(
            `Cosigner ${missing + 1} needs a real master fingerprint — connect OneKey again or scan an SM|xfp|…|xpub export.`,
          )
          return
        }
      } else if (isPlaceholderFingerprint(resolvedImportFingerprint())) {
        setErrorMessage(
          'Bitcoin needs a real master fingerprint — scan the SeedMask watch-only QR (SM|xfp|m/84\'/0\'/0\'|zpub…) or paste a descriptor.',
        )
        return
      }
    }

    setEncryptError(null)
    setEncryptPromptOpen(true)
  }

  async function confirmAddWallet(password: string, _newPassword?: string, hint?: string): Promise<void> {
    if (!api) return
    setEncryptError(null)
    setBusy(true)
    try {
      const passwordHint = password.trim() ? (hint || '').trim() || undefined : undefined
      if (hasValidDescriptor) {
        const label = walletName.trim() || 'Imported wallet'
        const wallet = await api.createWalletFromDescriptor(
          descriptorText,
          label,
          scanLimit,
          true,
          password.trim() || undefined,
          passwordHint,
        )
        setEncryptPromptOpen(false)
        await finishImportedWallet(wallet)
        return
      }

      const primaryKey = isMultisigImport
        ? extractKeyForCoin(selectedChain, multisigCosigners[0]?.xpub ?? '')
        : extractKeyForCoin(selectedChain, kpubRaw)
      const wallet = await api.createWallet({
        kpub: primaryKey,
        label: walletName.trim(),
        scan_limit: scanLimit,
        coin: selectedChain,
        derivation: resolvedImportDerivation(),
        fingerprint: isMultisigImport
          ? normalizeFingerprint(multisigCosigners[0]?.fingerprint) ?? undefined
          : resolvedImportFingerprint(),
        script_type:
          selectedChain === 'bitcoin' ? bitcoinScriptType : isMultisigImport ? 'p2sh' : 'p2pk',
        policy_type: bitcoinPolicyType,
        multisig_m: isMultisigImport ? multisigQuorum.required : undefined,
        multisig_n: isMultisigImport ? multisigQuorum.total : undefined,
        multisig_cosigners: isMultisigImport ? multisigCosigners.map(cosignerToPayload) : undefined,
        account: walletMeta?.account ?? 0,
        hardware: hardwareSourceRef.current || hardwareSource || undefined,
        keystore_label: isMultisigImport
          ? undefined
          : singlesigKeystore.label.trim() || undefined,
        activate: true,
        password: password.trim() || undefined,
        password_hint: passwordHint,
      })
      setEncryptPromptOpen(false)
      await finishImportedWallet(wallet)
    } catch (e) {
      setEncryptError(formatError(e))
    } finally {
      setBusy(false)
    }
  }

  function handleScan(payload: string): void {
    setShowScanner(false)
    const index = scanCosignerIndex
    setScanCosignerIndex(null)
    if (index != null) void ingestCosignerScan(index, payload)
    else void ingestScan(payload)
  }

  function applyHardwareImport(payload: HardwareImportPayload): void {
    const brand = payload.hardware === 'onekey' ? 'onekey' : 'ledger'
    const brandLabel = brand === 'onekey' ? 'OneKey' : 'Ledger'

    if (isMultisigImport) {
      if (selectedChain !== 'bitcoin' || (brand !== 'onekey' && brand !== 'ledger')) {
        setErrorMessage(
          selectedChain === 'bitcoin'
            ? 'Only OneKey or Ledger USB/BLE is supported for Bitcoin multisig cosigners. Use Airgapped → SeedMask for other devices.'
            : 'USB hardware Kaspa is singlesig only. For multisig, use Airgapped → SeedMask Export kpub.',
        )
        setShowHardwareConnect(false)
        return
      }
      const index = selectedCosignerIndex
      setShowHardwareConnect(false)
      setHardwareSourceTracked(brand)
      setErrorMessage(null)
      // Protect derivation from script-type rewrite; do not block M-of-N slot sync.
      hardwareImportLockRef.current = true
      lockImportMetaRef.current = false
      const fp = normalizeFingerprint(payload.fingerprint)
      if (fp && !isPlaceholderFingerprint(fp)) {
        setCapturedFingerprint(fp)
        if (index === 0) setMasterFingerprint(fp)
      }
      setMultisigCosigners((prev) => {
        if (!prev[index]) return prev
        const next = [...prev]
        next[index] = {
          ...next[index],
          xpub: payload.kpub,
          fingerprint: fp && !isPlaceholderFingerprint(fp) ? fp : next[index].fingerprint,
          derivation: payload.derivation,
          label: next[index].label?.trim() || payload.label || `Cosigner ${index + 1}`,
        }
        return next
      })
      if (index === 0) setKpubRaw(payload.kpub)
      setSelectedCosignerIndex(index)
      if (
        payload.scriptType === 'native_segwit' ||
        payload.scriptType === 'nested_segwit' ||
        payload.scriptType === 'legacy' ||
        payload.scriptType === 'taproot'
      ) {
        setBitcoinScriptType(payload.scriptType)
      }
      setStatusMessage(
        `Cosigner ${index + 1}: ${brandLabel} connected (${payload.deviceModel}) · ${
          payload.verifiedReceiveAddressHint || payload.derivation
        }`,
      )
      return
    }

    const incomingKey = extractKeyForCoin(selectedChain, payload.kpub).trim()
    // OneKey App accounts all share one kpub (BIP44 account 0'). A second import is the same wallet.
    if (
      brand === 'onekey' &&
      selectedChain === 'kaspa' &&
      (payload.accountMode ?? 'onekey-app') === 'onekey-app' &&
      incomingKey
    ) {
      const existing = wallets.find(
        (w) =>
          (w.coin || 'kaspa') === 'kaspa' &&
          extractKeyForCoin('kaspa', w.kpub || '').trim() === incomingKey,
      )
      if (existing) {
        setShowHardwareConnect(false)
        setErrorMessage(null)
        const receiveNote =
          payload.verifiedReceiveIndex != null
            ? `The address you confirmed is Receive #${payload.verifiedReceiveIndex} inside that wallet.`
            : 'Extra OneKey App “accounts” are just more receive addresses under that same wallet.'
        setDuplicateOneKeyNotice({
          walletLabel: existing.label?.trim() || 'OneKey',
          receiveNote,
        })
        return
      }
    }
    setShowHardwareConnect(false)
    setHardwareSourceTracked(brand)
    setErrorMessage(null)
    // Keep hardware path until wallet is added or form is reset — bare kpub parse assumes account #0.
    hardwareImportLockRef.current = true
    lockImportMetaRef.current = true
    setCapturedFingerprint(payload.fingerprint)
    setCapturedDerivation(payload.derivation)
    setMasterFingerprint(payload.fingerprint)
    if (
      selectedChain === 'bitcoin' &&
      (payload.scriptType === 'native_segwit' ||
        payload.scriptType === 'nested_segwit' ||
        payload.scriptType === 'legacy' ||
        payload.scriptType === 'taproot')
    ) {
      setBitcoinScriptType(payload.scriptType)
    }
    setWalletMeta({
      derivation: payload.derivation,
      fingerprint: payload.fingerprint,
      account: payload.account,
      coin: selectedChain,
    })
    setSinglesigKeystore((k) => ({
      ...k,
      xpub: payload.kpub,
      fingerprint: payload.fingerprint,
      derivation: payload.derivation,
      label: payload.label || brandLabel,
    }))
    setKpubRaw(payload.kpub)
    if (payload.verifiedReceiveIndex != null && payload.verifiedReceiveIndex + 1 > scanLimit) {
      setScanLimit(Math.min(200, payload.verifiedReceiveIndex + 5))
    }
    if (!walletName.trim() || walletName.trim() === draftWalletLabel) {
      setWalletName(payload.label || brandLabel)
    }
    const btcScriptNote =
      selectedChain === 'bitcoin' && payload.scriptType
        ? ` · ${payload.scriptType.replace(/_/g, ' ')}.`
        : ''
    setStatusMessage(
      `${brandLabel} connected (${payload.deviceModel}) · ${payload.verifiedReceiveAddressHint || 'address confirmed'}` +
        btcScriptNote +
        (brand === 'onekey' && selectedChain === 'kaspa'
          ? payload.accountMode === 'bip44'
            ? ' · Standard BIP44 account imported.'
            : ' · Open Addresses and check that Receive # (not only #0). Kaspa Official only — not “Kaspa OneKey”.'
          : ''),
    )
  }

  function openSeedMaskAirgapImport(): void {
    setHardwareSourceTracked('seedmask')
    setScanCosignerIndex(isMultisigImport ? selectedCosignerIndex : null)
    setShowScanner(true)
  }

  function walletPayloadFromImport(data: Record<string, unknown>): Record<string, unknown> | null {
    const nested = data.wallet
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>
    }
    const list = data.wallets
    if (Array.isArray(list) && list[0] && typeof list[0] === 'object') {
      return list[0] as Record<string, unknown>
    }
    if (data.encrypted_blob || data.kpub || data.id) return data
    return null
  }

  function importLooksSealed(wallet: Record<string, unknown>): boolean {
    return Boolean(wallet.encrypted) || (wallet.encrypted_blob != null && typeof wallet.encrypted_blob === 'object')
  }

  async function finishImportWallet(
    payload: Record<string, unknown>,
    password?: string,
  ): Promise<void> {
    if (!api) return
    setImportBusy(true)
    setImportPasswordError(null)
    try {
      const res = await api.importWallet(payload, {
        activate: true,
        password: password?.trim() || undefined,
      })
      const imported = res.wallet
      await loadWallets()
      if (imported?.id) {
        await activateWallet(imported.id, imported)
      }
      setPendingImport(null)
      setStatusMessage(`Imported “${imported?.label || 'wallet'}”`)
      const importedId = imported?.id
      if (
        importedId &&
        selectedChain === 'kaspa' &&
        needsKaspaImportHistoryPrompt(networkSettings)
      ) {
        setKaspaImportHistoryPromptWalletId(importedId)
      }
      onDone()
    } catch (e) {
      const msg = formatError(e)
      if (pendingImport) {
        setImportPasswordError(msg)
      } else {
        setErrorMessage(msg)
        setStatusMessage(msg)
      }
    } finally {
      setImportBusy(false)
    }
  }

  async function beginImportWallet(): Promise<void> {
    if (busy || importBusy) return
    setErrorMessage(null)
    setImportPasswordError(null)
    const buf = await openFileWithDialog(
      [
        { name: 'SeedMask wallet', extensions: ['json', 'seedmask'] },
        { name: 'JSON', extensions: ['json'] },
      ],
      {
        title: 'Import SeedMask wallet',
        message: 'Choose a wallet file from ~/.seedmask-coordinator',
      },
    )
    if (!buf) return
    let data: Record<string, unknown>
    try {
      const text = new TextDecoder().decode(buf)
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Export must be a JSON object')
      }
      data = parsed as Record<string, unknown>
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Invalid wallet file'
      setErrorMessage(msg)
      setStatusMessage(msg)
      return
    }
    const wallet = walletPayloadFromImport(data)
    if (!wallet) {
      setErrorMessage('Not a SeedMask wallet file')
      setStatusMessage('Not a SeedMask wallet file')
      return
    }
    if (importLooksSealed(wallet)) {
      setPendingImport({
        payload: data,
        label: String(wallet.label || 'Imported wallet'),
        hint: String(wallet.password_hint || ''),
      })
      return
    }
    await finishImportWallet(data)
  }

  const mainForm = (
    <MainWalletFormCard
      chain={selectedChain}
      walletName={walletName}
      onWalletNameChange={setWalletName}
      policyType={bitcoinPolicyType}
      onPolicyTypeChange={setBitcoinPolicyType}
      scriptType={bitcoinScriptType}
      onScriptTypeChange={applyScriptType}
      errorMessage={errorMessage}
      busy={busy}
    />
  )

  return (
    <div className="add-wallet-view">
      <div className="add-wallet-header">
        <div className="add-wallet-header-main">
          <WalletMark label={walletName || '+'} size={36} draft />
          <div>
            <h2 className="section-title add-wallet-title">New wallet</h2>
            <p className="muted add-wallet-subtitle">{subtitle}</p>
          </div>
        </div>
        <span className="add-wallet-import-action">
          <button
            type="button"
            className="hw-connect-trigger chip"
            disabled={busy || importBusy}
            onClick={() => void beginImportWallet()}
          >
            <span className="hw-connect-trigger-icon" aria-hidden>
              <ImportFileIcon size={16} />
            </span>
            Import wallet
          </button>
          <InfoTipButton text="Opens a SeedMask wallet file (Export → SeedMask → Save). Enter the password if the file is locked." />
        </span>
        {selectedChain === 'bitcoin' && (
          <div className="descriptor-inline-field">
            <div className="descriptor-label-row">
              <span className="field-label">Descriptor</span>
              <span className="descriptor-optional">Optional</span>
            </div>
            <input
              className="field-input descriptor-input mono"
              value={descriptorRaw}
              placeholder="wpkh(…)#… or wsh(sortedmulti(…))#…"
              onChange={(e) => setDescriptorRaw(e.target.value)}
            />
            {descriptorParseError && <p className="descriptor-error">{descriptorParseError}</p>}
          </div>
        )}
      </div>

      {isMultisigImport ? (
        <>
          <AddWalletTopLayout
            chain={selectedChain}
            showDeviceGuide={showDeviceGuide}
            mainForm={mainForm}
            sideCard={
              <MultisigQuorumCard
                chain={selectedChain}
                quorum={multisigQuorum}
                useCustomQuorum={useCustomQuorum}
                scriptType={bitcoinScriptType}
                onSelectPreset={(q) => {
                  setUseCustomQuorum(false)
                  setMultisigQuorum(q)
                  syncCosignerSlots(q)
                  clampSelectedCosignerIndex(q.total)
                }}
                onSelectCustom={() => {
                  setUseCustomQuorum(true)
                  const next =
                    multisigQuorum.total < multisigQuorum.required
                      ? { ...multisigQuorum, total: multisigQuorum.required }
                      : multisigQuorum
                  setMultisigQuorum(next)
                  syncCosignerSlots(next)
                  clampSelectedCosignerIndex(next.total)
                }}
                onQuorumChange={(q) => {
                  const next = q.total < q.required ? { ...q, total: q.required } : q
                  setMultisigQuorum(next)
                  syncCosignerSlots(next)
                  clampSelectedCosignerIndex(next.total)
                }}
              />
            }
          />
          <MultisigCosignersSection
            cosigners={multisigCosigners}
            selectedIndex={selectedCosignerIndex}
            onSelectIndex={setSelectedCosignerIndex}
            onCosignerChange={(i, c) => {
              setMultisigCosigners((prev) => {
                const next = [...prev]
                next[i] = c
                return next
              })
              if (i === 0) setKpubRaw(c.xpub)
            }}
            chain={selectedChain}
            scriptType={bitcoinScriptType}
            defaultDerivation={defaultMultisigDerivation()}
            onScanCosigner={(i) => {
              setScanCosignerIndex(i)
              setShowScanner(true)
            }}
            onConnectHardware={() => setShowHardwareConnect(true)}
          />
        </>
      ) : (
        <>
          <AddWalletTopLayout
            chain={selectedChain}
            showDeviceGuide={showDeviceGuide}
            mainForm={mainForm}
            sideCard={
              <SinglesigPolicyCard
                chain={selectedChain}
                policyType={bitcoinPolicyType}
                scriptType={bitcoinScriptType}
                derivation={displayedDerivation()}
              />
            }
          />
          <SinglesigKeystoreSection
            chain={selectedChain}
            keystore={singlesigKeystore}
            displayedDerivation={displayedDerivation()}
            scriptType={bitcoinScriptType}
            hardware={
              hardwareSource === 'ledger' || hardwareSource === 'onekey' || hardwareSource === 'seedmask'
                ? hardwareSource
                : ''
            }
            onKeystoreChange={(k) => {
              setSinglesigKeystore(k)
              setKpubRaw(k.xpub)
              setMasterFingerprint(k.fingerprint)
            }}
            onScan={() => {
              setScanCosignerIndex(null)
              setShowScanner(true)
            }}
            onConnectHardware={() => setShowHardwareConnect(true)}
          />
        </>
      )}

      <div className="row add-wallet-actions">
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canAdd || busy}
          onClick={() => void addWallet()}
        >
          {busy ? 'Adding…' : 'Add wallet'}
        </button>
      </div>

      {encryptPromptOpen && (
        <WalletPasswordModal
          mode="encrypt"
          walletLabel={walletName.trim() || undefined}
          busy={busy}
          error={encryptError}
          onCancel={() => {
            if (busy) return
            setEncryptPromptOpen(false)
            setEncryptError(null)
          }}
          onConfirm={(password, _newPassword, hint) => void confirmAddWallet(password, undefined, hint)}
        />
      )}

      {pendingImport && (
        <WalletPasswordModal
          mode="unlock"
          walletLabel={pendingImport.label}
          passwordHint={pendingImport.hint || null}
          busy={importBusy}
          error={importPasswordError}
          onCancel={() => {
            if (importBusy) return
            setPendingImport(null)
            setImportPasswordError(null)
          }}
          onConfirm={(password) => void finishImportWallet(pendingImport.payload, password)}
        />
      )}

      {duplicateOneKeyNotice && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setDuplicateOneKeyNotice(null)}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="onekey-dup-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="onekey-dup-title">This OneKey wallet is already added</h3>
            <p className="muted" style={{ marginTop: 8, lineHeight: 1.45 }}>
              “{duplicateOneKeyNotice.walletLabel}” is already in SeedMask. With{' '}
              <strong>OneKey App accounts</strong>, every Account # still shares one wallet key — importing
              again won’t create a separate wallet.
            </p>
            <p className="muted" style={{ marginTop: 8, lineHeight: 1.45 }}>
              {duplicateOneKeyNotice.receiveNote} Open that wallet → <strong>Wallet settings</strong> → raise
              the address scan limit (or scan for more addresses) so SeedMask can find those receive
              addresses.
            </p>
            <p className="muted" style={{ marginTop: 8, lineHeight: 1.45 }}>
              Need a truly separate OneKey wallet here? Choose <strong>Standard accounts (BIP44)</strong> when
              connecting, with a different account index.
            </p>
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-primary" onClick={() => setDuplicateOneKeyNotice(null)}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {showHardwareConnect && (
        <ConnectHardwareWalletSheet
          chain={selectedChain}
          multisig={isMultisigImport}
          scriptType={bitcoinScriptType}
          onClose={() => setShowHardwareConnect(false)}
          onHardwareImported={applyHardwareImport}
          onChooseSeedMask={openSeedMaskAirgapImport}
          onSeedMaskFile={(text) => {
            setHardwareSourceTracked('seedmask')
            setScanCosignerIndex(isMultisigImport ? selectedCosignerIndex : null)
            if (isMultisigImport) void ingestCosignerScan(selectedCosignerIndex, text)
            else void ingestScan(text)
          }}
        />
      )}

      {showScanner && (
        <QRScannerSheet
          title={scanSheetTitle}
          hint={scanSheetHint}
          api={api}
          assembleAnimatedUr
          onScan={handleScan}
          onCancel={() => {
            setScanCosignerIndex(null)
            setShowScanner(false)
          }}
        />
      )}
    </div>
  )
}

function formatError(e: unknown): string {
  if (e instanceof APIError) return apiError(e.status ?? 0, e.message)
  return e instanceof Error ? e.message : 'Import failed'
}
