import { useEffect, useRef, useState } from 'react'
import { useApp } from '@renderer/state/AppProvider'
import { copyToClipboard } from '@renderer/utils/clipboard'
import type { MultisigCosigner, QRDisplayDensity, WalletDTO } from '@renderer/api/types'
import { extendedKeyLabel, walletCoin } from '@renderer/api/types'
import { WalletKeystoreGlyph } from '@renderer/components/BrandMarks'
import { AnimatedQRView, DenseQRFullscreen } from '@renderer/components/AnimatedQRView'
import { InfoTipButton } from '@renderer/components/settings/SettingsChrome'
import { saveFileWithDialog } from '@renderer/utils/nativeFiles'
import { buildDescriptorPdf, formatKaspaPolicyPdfBody } from '@renderer/utils/descriptorPdf'
import { localExportQrPacks, type ExportQrPack } from '@renderer/utils/clientQr'
import {
  FingerprintField,
  KeystoreDetailPanel,
  KeystoreFieldRow,
  KeystoreTilesRow,
  ExtendedKeyLabelRow,
} from '@renderer/components/KeystoreUI'
import {
  sanitizeFingerprint,
  accountIndexFromDerivation,
  walletHasCompleteMultisigCosigners,
  walletIsIncompleteLegacyMultisig,
  walletIsMultisig,
  walletMultisigCosigners,
  walletMultisigQuorumLabel,
  walletPolicyLabel,
  walletResolvedAccount,
  walletResolvedDerivation,
  walletResolvedFingerprint,
  walletScriptTypeLabel,
  walletKeystoreNatureParts,
  walletKeystoreLabel,
} from '@renderer/utils/walletHelpers'
import {
  alternateBitcoinExtendedPubkey,
  bitcoinExtendedPubPrefix,
  convertBitcoinExtendedPubkey,
  scriptNativeExtendedPrefix,
} from '@renderer/utils/extendedKey'
import { orderedWalletsForChain } from '@renderer/utils/walletOrder'

interface EditableCosigner {
  xpub: string
  label: string
  fingerprint: string
  derivation: string
}

export function WalletSettingsView(): React.JSX.Element {
  const {
    api,
    activeWallet,
    loadWallets,
    activateWallet,
    requestWalletUnlock,
    setSidebarSelection,
    setStatusMessage,
    applyLocalWalletLabel,
    persistWalletScanLimit,
    applyLocalWalletPatch,
  } = useApp()
  const [editLabel, setEditLabel] = useState('')
  const [editKeystoreLabel, setEditKeystoreLabel] = useState('')
  const [editScanLimit, setEditScanLimit] = useState(30)
  const [scanSaving, setScanSaving] = useState(false)
  const [selectedKeystoreIndex, setSelectedKeystoreIndex] = useState(0)
  const [editSinglesigFingerprint, setEditSinglesigFingerprint] = useState('')
  const [editSinglesigDerivation, setEditSinglesigDerivation] = useState('')
  const [editCosigners, setEditCosigners] = useState<EditableCosigner[]>([])
  const [walletDescriptor, setWalletDescriptor] = useState('')
  const [descriptorError, setDescriptorError] = useState<string | null>(null)
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false)
  const [exportQrTitle, setExportQrTitle] = useState('')
  const [exportQrPayload, setExportQrPayload] = useState('')
  const [exportQrFilename, setExportQrFilename] = useState('wallet-export.json')
  const [exportQrMime, setExportQrMime] = useState('application/json')
  const [exportQrFrames, setExportQrFrames] = useState<string[]>([])
  const [exportQrFrameMs, setExportQrFrameMs] = useState(480)
  const [exportQrDisplaySize, setExportQrDisplaySize] = useState(440)
  const [exportQrDensity, setExportQrDensity] = useState<QRDisplayDensity>('animated')
  const [exportQrAutoPlaying, setExportQrAutoPlaying] = useState(true)
  const [exportQrDenseFullscreen, setExportQrDenseFullscreen] = useState(false)
  const [exportQrError, setExportQrError] = useState<string | null>(null)
  const [exportQrBusy, setExportQrBusy] = useState(false)
  /** Destination’s native encoding — animated mode may temporarily use UR fountain. */
  const [exportQrPreferredEncoding, setExportQrPreferredEncoding] = useState<'ur' | 'plain'>('ur')
  const [exportQrHint, setExportQrHint] = useState('')
  /** Optional alternate payload for “Save file…” (e.g. Electrum: QR=zpub, file=wallet JSON). */
  const [exportQrSavePayload, setExportQrSavePayload] = useState<string | null>(null)
  const [exportQrSaveFilename, setExportQrSaveFilename] = useState<string | null>(null)
  const [exportQrSaveMime, setExportQrSaveMime] = useState<string | null>(null)
  const [exportQrSaveLabel, setExportQrSaveLabel] = useState('Save file…')
  const [exportQrSaveInfoTip, setExportQrSaveInfoTip] = useState<string | null>(null)
  const [exportQrShowInstructions, setExportQrShowInstructions] = useState(false)
  const [exportQrInstructionsOpen, setExportQrInstructionsOpen] = useState(false)
  const [exportQrReady, setExportQrReady] = useState<{ static: boolean; animated: boolean }>({
    static: false,
    animated: false,
  })
  const [exportDestOpen, setExportDestOpen] = useState(false)
  const exportQrSeqRef = useRef(0)
  const exportQrCacheRef = useRef<{
    payload: string
    preferredEncoding: 'ur' | 'plain'
    static?: ExportQrPack
    animated?: ExportQrPack
  }>({ payload: '', preferredEncoding: 'ur' })
  /** Prefetched Export Policy QR packs (compact payload key → frames). */
  const policyQrPrefetchRef = useRef<{
    key: string
    pretty: string
    static?: ExportQrPack
    animated?: ExportQrPack
  } | null>(null)
  const policyQrPrefetchPromiseRef = useRef<Promise<void> | null>(null)
  /** Prefetched watch-only destination packs (encoding:payload → frames). */
  const watchOnlyQrCacheRef = useRef<Map<string, { static?: ExportQrPack; animated: ExportQrPack }>>(
    new Map(),
  )
  const keystoreLabelSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressAutoSave = useRef(false)
  const labelSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scanSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const keystoreSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    syncFromActiveWallet()
  }, [activeWallet?.id])

  useEffect(() => {
    void loadWalletDescriptor()
  }, [activeWallet?.id, activeWallet?.unlocked, api])

  function syncFromActiveWallet(): void {
    suppressAutoSave.current = true
    if (!activeWallet) {
      setEditLabel('')
      setEditKeystoreLabel('')
      setEditScanLimit(30)
      setEditSinglesigFingerprint('')
      setEditSinglesigDerivation('')
      setEditCosigners([])
      suppressAutoSave.current = false
      return
    }
    setEditLabel(activeWallet.label)
    setEditKeystoreLabel(walletKeystoreLabel(activeWallet))
    setEditScanLimit(activeWallet.scan_limit)
    setSelectedKeystoreIndex(0)
    setEditSinglesigFingerprint(walletResolvedFingerprint(activeWallet))
    setEditSinglesigDerivation(walletResolvedDerivation(activeWallet))
    setEditCosigners(
      walletMultisigCosigners(activeWallet).map((c) => ({
        xpub: c.xpub,
        label: c.label?.trim() ?? '',
        fingerprint: c.fingerprint?.trim() ?? '',
        derivation: c.derivation?.trim() ?? '',
      })),
    )
    queueMicrotask(() => {
      suppressAutoSave.current = false
    })
  }

  async function loadWalletDescriptor(): Promise<void> {
    if (!api || !activeWallet || walletCoin(activeWallet) !== 'bitcoin') {
      setWalletDescriptor('')
      setDescriptorError(null)
      return
    }
    if (activeWallet.encrypted && !activeWallet.unlocked) {
      setWalletDescriptor('')
      setDescriptorError(null)
      return
    }
    try {
      const res = await api.walletDescriptor(activeWallet.id)
      setWalletDescriptor(res.descriptor)
      setDescriptorError(null)
    } catch (e) {
      const fallback = activeWallet.descriptor ?? ''
      setWalletDescriptor(fallback)
      setDescriptorError(fallback ? null : e instanceof Error ? e.message : 'Could not load descriptor')
    }
  }

  async function ensureActiveUnlocked(): Promise<boolean> {
    if (!activeWallet) return false
    if (!activeWallet.encrypted || activeWallet.unlocked) return true
    return requestWalletUnlock(activeWallet.id, activeWallet)
  }

  /** Flush wallet-name edits before export so Save files do not keep the old label. */
  async function flushPendingWalletLabel(): Promise<string> {
    const trimmed = editLabel.trim()
    if (!api || !activeWallet || !trimmed) return activeWallet?.label ?? ''
    if (labelSaveTimer.current) {
      clearTimeout(labelSaveTimer.current)
      labelSaveTimer.current = null
    }
    if (trimmed === activeWallet.label) return trimmed
    await api.updateWallet(activeWallet.id, { label: trimmed })
    applyLocalWalletPatch(activeWallet.id, { label: trimmed })
    await loadWallets()
    return trimmed
  }

  useEffect(() => {
    if (suppressAutoSave.current || !api || !activeWallet) return
    if (labelSaveTimer.current) clearTimeout(labelSaveTimer.current)
    labelSaveTimer.current = setTimeout(() => {
      if (suppressAutoSave.current || !api || !activeWallet) return
      const trimmed = editLabel.trim()
      if (!trimmed || trimmed === activeWallet.label) return
      void api.updateWallet(activeWallet.id, { label: trimmed }).then(() => loadWallets())
    }, 450)
    return () => {
      if (labelSaveTimer.current) clearTimeout(labelSaveTimer.current)
    }
  }, [editLabel, api, activeWallet?.id, activeWallet?.label, loadWallets])

  useEffect(() => {
    if (suppressAutoSave.current || !api || !activeWallet) return
    if (walletIsMultisig(activeWallet)) return
    if (keystoreLabelSaveTimer.current) clearTimeout(keystoreLabelSaveTimer.current)
    keystoreLabelSaveTimer.current = setTimeout(() => {
      if (suppressAutoSave.current || !api || !activeWallet) return
      const trimmed = editKeystoreLabel.trim()
      const current = walletKeystoreLabel(activeWallet)
      if (!trimmed || trimmed === current) return
      void api.updateWallet(activeWallet.id, { keystore_label: trimmed }).then(() => loadWallets())
    }, 450)
    return () => {
      if (keystoreLabelSaveTimer.current) clearTimeout(keystoreLabelSaveTimer.current)
    }
  }, [editKeystoreLabel, api, activeWallet?.id, activeWallet, loadWallets])

  useEffect(() => {
    if (suppressAutoSave.current || !api || !activeWallet) return
    if (scanSaveTimer.current) clearTimeout(scanSaveTimer.current)
    scanSaveTimer.current = setTimeout(() => {
      if (suppressAutoSave.current || !activeWallet) return
      if (editScanLimit === activeWallet.scan_limit) return
      void persistScanLimit(editScanLimit)
    }, 500)
    return () => {
      if (scanSaveTimer.current) clearTimeout(scanSaveTimer.current)
    }
  }, [editScanLimit, api, activeWallet?.id, activeWallet?.scan_limit])

  function scheduleKeystoreSave(
    nextFingerprint?: string,
    nextCosigners?: EditableCosigner[],
    nextDerivation?: string,
  ): void {
    if (suppressAutoSave.current || !api || !activeWallet) return
    if (keystoreSaveTimer.current) clearTimeout(keystoreSaveTimer.current)
    keystoreSaveTimer.current = setTimeout(() => {
      void persistKeystoreMetadata(nextFingerprint, nextCosigners, nextDerivation)
    }, 450)
  }

  async function persistScanLimit(limit: number): Promise<void> {
    if (!api || !activeWallet) return
    setScanSaving(true)
    try {
      await persistWalletScanLimit(limit)
      await loadWallets()
    } catch (e) {
      setStatusMessage(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setScanSaving(false)
    }
  }

  async function persistKeystoreMetadata(
    fingerprintOverride?: string,
    cosignersOverride?: EditableCosigner[],
    derivationOverride?: string,
  ): Promise<void> {
    if (!api || !activeWallet) return
    try {
      if (walletIsMultisig(activeWallet)) {
        const cosigners = (cosignersOverride ?? editCosigners).map(
          (draft): MultisigCosigner => ({
            xpub: draft.xpub,
            fingerprint: draft.fingerprint ? sanitizeFingerprint(draft.fingerprint) : undefined,
            derivation: draft.derivation || undefined,
            label: draft.label.trim() || undefined,
          }),
        )
        await api.updateWallet(activeWallet.id, { multisig_cosigners: cosigners })
        await loadWallets()
      } else {
        const fp = sanitizeFingerprint(fingerprintOverride ?? editSinglesigFingerprint)
        const derivation = (derivationOverride ?? editSinglesigDerivation).trim()
        const w = await api.updateWallet(activeWallet.id, {
          fingerprint: fp || undefined,
          derivation: derivation || undefined,
        })
        const account = accountIndexFromDerivation(derivation)
        applyLocalWalletPatch(activeWallet.id, {
          ...w,
          derivation: derivation || w.derivation,
          ...(account != null ? { account } : {}),
        })
      }
    } catch (e) {
      setStatusMessage(e instanceof Error ? e.message : 'Save failed')
    }
  }

  async function exportWallet(): Promise<void> {
    if (!activeWallet) return
    if (!(await ensureActiveUnlocked())) return
    setExportDestOpen(true)
    // Prefetch every destination so Dense + Animated are ready when picked.
    const wallet = activeWallet
    void Promise.all(
      watchOnlyExportDestinations(wallet).map(async (dest) => {
        try {
          const payload = dest.build(wallet)
          if (!payload.trim()) return
          const key = `${dest.encoding}:${payload}`
          if (watchOnlyQrCacheRef.current.has(key)) return
          const packs = await localExportQrPacks(payload, dest.encoding)
          watchOnlyQrCacheRef.current.set(key, packs)
        } catch (e) {
          console.warn('Watch-only QR prefetch failed', dest.id, e)
        }
      }),
    )
  }

  function safeExportName(): string {
    return (editLabel.trim() || activeWallet?.label || 'wallet').replace(/[/:]/g, '-')
  }

  async function showExportQr(
    title: string,
    payload: string,
    filename: string,
    mime: string,
    opts?: {
      density?: QRDisplayDensity
      encoding?: 'ur' | 'plain'
      preferredEncoding?: 'ur' | 'plain'
      hint?: string
      /** If set, Save downloads this instead of the QR payload. */
      savePayload?: string
      saveFilename?: string
      saveMime?: string
      saveLabel?: string
      saveInfoTip?: string
      showInstructions?: boolean
      /** Skip encode if packs already prepared. */
      prebuilt?: { static?: ExportQrPack; animated?: ExportQrPack }
    },
  ): Promise<void> {
    const preferredEncoding = opts?.preferredEncoding ?? opts?.encoding ?? 'ur'
    const requestedDensity = opts?.density ?? 'static'

    const seq = ++exportQrSeqRef.current
    setExportQrError(null)
    setExportQrTitle(title)
    setExportQrPayload(payload)
    setExportQrFilename(filename)
    setExportQrMime(mime)
    setExportQrSavePayload(opts?.savePayload ?? null)
    setExportQrSaveFilename(opts?.saveFilename ?? null)
    setExportQrSaveMime(opts?.saveMime ?? null)
    setExportQrSaveLabel(opts?.saveLabel ?? 'Save file…')
    setExportQrSaveInfoTip(opts?.saveInfoTip ?? null)
    setExportQrPreferredEncoding(preferredEncoding)
    setExportQrHint(opts?.hint ?? '')
    setExportQrShowInstructions(!!opts?.showInstructions)
    setExportQrInstructionsOpen(false)
    setExportQrDisplaySize(440)
    setExportQrDenseFullscreen(false)
    setExportQrFrames([])

    const applyPack = (pack: ExportQrPack, mode: QRDisplayDensity) => {
      if (seq !== exportQrSeqRef.current) return
      setExportQrFrames(pack.frames)
      setExportQrFrameMs(pack.frameMs)
      setExportQrDensity(mode)
      setExportQrAutoPlaying(mode === 'animated' && pack.frames.length > 1)
      setExportQrBusy(false)
    }

    const finishWithPacks = (
      staticPack: ExportQrPack | undefined,
      animatedPack: ExportQrPack | undefined,
      prefer: QRDisplayDensity,
    ) => {
      if (seq !== exportQrSeqRef.current) return
      // Animated is useful when we have a real multipart (or UR) pack — not a Dense duplicate.
      const animatedOk =
        !!animatedPack?.frames.length &&
        (animatedPack.frames.length > 1 ||
          preferredEncoding === 'ur' ||
          !staticPack?.frames.length)
      const staticOk = !!staticPack?.frames.length
      exportQrCacheRef.current = {
        payload,
        preferredEncoding,
        static: staticPack,
        animated: animatedOk ? animatedPack : undefined,
      }
      setExportQrReady({
        static: staticOk,
        animated: animatedOk,
      })
      const useStatic =
        (prefer === 'static' && staticOk) || (!animatedOk && staticOk)
      const pack = useStatic ? staticPack! : animatedPack ?? staticPack
      if (!pack?.frames.length) {
        setExportQrError('Could not build a scannable QR. Use Save file instead.')
        setExportQrBusy(false)
        return
      }
      applyPack(pack, useStatic ? 'static' : 'animated')
    }

    const pre = opts?.prebuilt
    if (pre?.static?.frames.length || pre?.animated?.frames.length) {
      setExportQrBusy(false)
      finishWithPacks(pre.static, pre.animated, requestedDensity)
      return
    }
    const hit = exportQrCacheRef.current
    if (
      hit.payload === payload &&
      hit.preferredEncoding === preferredEncoding &&
      (hit.static?.frames.length || hit.animated?.frames.length)
    ) {
      setExportQrBusy(false)
      finishWithPacks(hit.static, hit.animated, requestedDensity)
      return
    }

    // Join in-flight local prefetch for the same payload.
    if (policyQrPrefetchPromiseRef.current) {
      setExportQrBusy(true)
      await policyQrPrefetchPromiseRef.current
      if (seq !== exportQrSeqRef.current) return
      const pref = policyQrPrefetchRef.current
      if (
        pref?.key === `${preferredEncoding}:${payload}` &&
        (pref.static?.frames.length || pref.animated?.frames.length)
      ) {
        setExportQrBusy(false)
        finishWithPacks(pref.static, pref.animated, requestedDensity)
        return
      }
    }

    setExportQrReady({ static: false, animated: false })
    setExportQrBusy(true)
    exportQrCacheRef.current = { payload, preferredEncoding }

    try {
      // Sparrow-style: BC-UR + QR frames in Electron main — both modes in one local call.
      const packs = await localExportQrPacks(payload, preferredEncoding)
      if (seq !== exportQrSeqRef.current) return
      finishWithPacks(packs.static, packs.animated, requestedDensity)
      policyQrPrefetchRef.current = {
        key: `${preferredEncoding}:${payload}`,
        pretty: opts?.savePayload ?? payload,
        static: packs.static,
        animated: packs.animated,
      }
    } catch (e) {
      if (seq !== exportQrSeqRef.current) return
      const msg = e instanceof Error ? e.message : 'QR export failed'
      setExportQrError(msg)
      setExportQrBusy(false)
      setStatusMessage(msg)
    }
  }

  function toggleExportQrDensity(next?: QRDisplayDensity): void {
    if (!exportQrPayload) return
    const target: QRDisplayDensity =
      next ?? (exportQrDensity === 'animated' ? 'static' : 'animated')
    if (target === exportQrDensity && exportQrFrames.length > 0) return
    const cached = exportQrCacheRef.current[target]
    if (!cached?.frames.length) return
    setExportQrFrames(cached.frames)
    setExportQrFrameMs(cached.frameMs)
    setExportQrDensity(target)
    setExportQrAutoPlaying(target === 'animated' && cached.frames.length > 1)
    setExportQrBusy(false)
    setExportQrError(null)
  }

  function closeExportQr(): void {
    exportQrSeqRef.current += 1
    setExportQrDenseFullscreen(false)
    setExportQrInstructionsOpen(false)
    setExportQrShowInstructions(false)
    setExportQrTitle('')
    setExportQrFrames([])
    setExportQrBusy(false)
    setExportQrReady({ static: false, animated: false })
  }

  async function saveExportQrPayload(): Promise<void> {
    if (exportQrTitle === 'Bitcoin output descriptor' && activeWallet && exportQrPayload) {
      try {
        const pdf = await buildDescriptorPdf(exportQrPayload, activeWallet, editLabel)
        const safeName = safeExportName()
        const saved = await saveFileWithDialog(pdf, `${safeName}-descriptor.pdf`, 'application/pdf')
        setStatusMessage(saved ? 'Descriptor PDF saved' : 'Save cancelled')
      } catch (e) {
        setStatusMessage(e instanceof Error ? e.message : 'PDF save failed')
      }
      return
    }
    const body = exportQrSavePayload ?? exportQrPayload
    if (!body) return
    const filename = exportQrSaveFilename ?? exportQrFilename
    const mime = exportQrSaveMime ?? exportQrMime
    const saved = await saveFileWithDialog(new TextEncoder().encode(body), filename, mime)
    setStatusMessage(saved ? 'Export saved' : 'Save cancelled')
  }

  function seedMaskCompactExport(wallet: WalletDTO): string {
    const fp = (walletResolvedFingerprint(wallet) || '00000000').replace(/^0x/i, '').toLowerCase()
    const deriv = walletResolvedDerivation(wallet) || ''
    const key = wallet.kpub.trim()
    if (deriv.startsWith('m/')) return `SM|${fp}|${deriv}|${key}`
    return `SM|${fp}|${key}`
  }

  /**
   * BlueWallet import: Electrum/Coldcard hardware keystore JSON.
   * BlueWallet applies keystore.label and stores ckcc_xfp for PSBT signing.
   * Do not use this for Electrum File→Open (needs coldcard/passport plugin; QR paste → "Invalid master key").
   */
  function blueWalletExport(wallet: WalletDTO): string {
    const fp = sanitizeFingerprint(walletResolvedFingerprint(wallet))
    if (!fp || /^0+$/i.test(fp)) {
      throw new Error(
        'Airgap signing needs a real master fingerprint. Re-import this wallet from SeedMask (SM|… or Connect).',
      )
    }
    const fpUpper = fp.toUpperCase()
    let path = walletResolvedDerivation(wallet).trim()
    if (!path.startsWith('m/')) {
      path = path ? `m/${path.replace(/^m\//, '')}` : "m/84'/0'/0'"
    }
    const b0 = parseInt(fpUpper.slice(0, 2), 16)
    const b1 = parseInt(fpUpper.slice(2, 4), 16)
    const b2 = parseInt(fpUpper.slice(4, 6), 16)
    const b3 = parseInt(fpUpper.slice(6, 8), 16)
    const ckccXfp = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0
    const xpub = slip132ForElectrum(wallet)
    return JSON.stringify({
      seed_version: 17,
      use_encryption: false,
      wallet_type: 'standard',
      keystore: {
        ckcc_xfp: ckccXfp,
        ckcc_xpub: xpub,
        hw_type: 'passport',
        type: 'hardware',
        label: `SeedMask [${fpUpper}]`,
        derivation: path,
        xpub,
      },
    })
  }

  /** SLIP-132 version bytes Electrum uses to pick address type (zpub→p2wpkh, ypub→p2sh-p2wpkh). */
  function slip132ForElectrum(wallet: WalletDTO): string {
    const path = walletResolvedDerivation(wallet)
    let xpub = wallet.kpub.trim()
    const native = scriptNativeExtendedPrefix(wallet.script_type, path)
    const prefix = bitcoinExtendedPubPrefix(xpub)
    if (native && prefix && (prefix === 'xpub' || prefix === 'tpub')) {
      try {
        xpub = convertBitcoinExtendedPubkey(xpub, native)
      } catch {
        /* keep stored key */
      }
    }
    return xpub
  }

  /**
   * Electrum desktop wallet file (watching-only bip32).
   * Must be saved and opened with File → Open — not pasted into “Use a master key”
   * (that path only accepts a bare xpub/zpub and raises “Invalid master key” for JSON).
   * root_fingerprint keeps SeedMask PSBT signing working.
   */
  function electrumWalletFileExport(wallet: WalletDTO): string {
    const fp = sanitizeFingerprint(walletResolvedFingerprint(wallet))
    if (!fp || /^0+$/i.test(fp)) {
      throw new Error(
        'Airgap signing needs a real master fingerprint. Re-import this wallet from SeedMask (SM|… or Connect).',
      )
    }
    let path = walletResolvedDerivation(wallet).trim()
    if (!path.startsWith('m/')) {
      path = path ? `m/${path.replace(/^m\//, '')}` : "m/84'/0'/0'"
    }
    return JSON.stringify({
      seed_version: 17,
      use_encryption: false,
      wallet_type: 'standard',
      keystore: {
        type: 'bip32',
        xpub: slip132ForElectrum(wallet),
        derivation: path,
        root_fingerprint: fp.toLowerCase(),
      },
    })
  }

  type WatchOnlyExportDest = {
    id: string
    name: string
    detail: string
    encoding: 'ur' | 'plain'
    density: QRDisplayDensity
    filename: string
    mime: string
    hint: string
    build: (wallet: WalletDTO) => string
    /** Alternate file payload (QR stays `build`; Save uses this when set). */
    buildSave?: (wallet: WalletDTO) => string
    saveFilename?: string
    saveMime?: string
  }

  function watchOnlyExportDestinations(wallet: WalletDTO): WatchOnlyExportDest[] {
    const coin = walletCoin(wallet)
    const base = safeExportName()
    const seedmaskDest: WatchOnlyExportDest = {
      id: 'seedmask',
      name: 'SeedMask',
      detail: 'QR = compact SM|… for Add wallet scan. Save = wallet file for Import wallet',
      encoding: 'plain',
      density: 'static',
      filename: `${base}-seedmask.txt`,
      mime: 'text/plain',
      hint:
        'Scan the QR in Add wallet, or Save file for Add wallet → Import wallet (password-protected wallets stay sealed).',
      build: seedMaskCompactExport,
      // Actual Save body is the sealed wallet JSON (fetched in exportToDestination).
      saveFilename: `${base}.seedmask.json`,
      saveMime: 'application/json',
    }
    if (coin === 'kaspa') {
      return [
        {
          id: 'kaspium',
          name: 'Kaspium',
          detail: 'Raw kpub — scan or paste in Kaspium → Import watch-only',
          encoding: 'plain',
          density: 'static',
          filename: `${base}-kaspium-kpub.txt`,
          mime: 'text/plain',
          hint: 'Point Kaspium at this QR. Payload is the bare kpub only.',
          build: (w) => w.kpub.trim(),
        },
        seedmaskDest,
      ]
    }
    return [
      {
        id: 'bluewallet',
        name: 'BlueWallet',
        detail: 'Named SeedMask [xfp] — Electrum JSON with fingerprint for PSBT signing',
        encoding: 'plain',
        density: 'static',
        filename: `${base}-bluewallet.json`,
        mime: 'application/json',
        hint:
          'In BlueWallet: Add wallet → Import wallet → scan. Wallet name will be SeedMask [fingerprint].',
        build: blueWalletExport,
      },
      {
        id: 'sparrow',
        name: 'Sparrow',
        detail: 'Output descriptor (BIP380, includes fingerprint)',
        encoding: 'plain',
        density: 'static',
        filename: `${base}-sparrow-descriptor.txt`,
        mime: 'text/plain',
        hint: 'In Sparrow: File → Import wallet → scan or paste the descriptor.',
        build: (w) => (walletDescriptor || w.descriptor || w.kpub).trim(),
      },
      {
        id: 'electrum',
        name: 'Electrum',
        detail: 'QR = master key (zpub). Phone: enter fingerprint + path after scan. Desktop Save = wallet file',
        encoding: 'plain',
        density: 'static',
        filename: `${base}-electrum-xpub.txt`,
        mime: 'text/plain',
        hint:
          'Phone Electrum: New wallet → Standard → Use a master key → scan this QR. If asked for derivation path and master fingerprint, enter them from SeedMask (e.g. m/84\'/0\'/0\' and the 8-hex fingerprint) — required for SeedMask to sign. Desktop only: Save file… then File → Open the .json.',
        build: (w) => slip132ForElectrum(w),
        buildSave: electrumWalletFileExport,
        saveFilename: `${base}-electrum.json`,
        saveMime: 'application/json',
      },
      seedmaskDest,
    ]
  }

  async function exportToDestination(dest: WatchOnlyExportDest): Promise<void> {
    if (!activeWallet) return
    setExportDestOpen(false)
    let payload = ''
    let savePayload: string | undefined
    try {
      const liveLabel = await flushPendingWalletLabel()
      const walletForExport = { ...activeWallet, label: liveLabel || activeWallet.label }
      payload = dest.build(walletForExport)
      if (dest.id === 'seedmask') {
        if (!api) throw new Error('Backend not ready')
        const blob = await api.exportWallet(activeWallet.id)
        const text = await blob.text()
        // Filename uses the UI name; keep JSON label in sync even if autosave lagged.
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>
          const walletObj = parsed.wallet
          if (walletObj && typeof walletObj === 'object' && !Array.isArray(walletObj) && liveLabel) {
            ;(walletObj as Record<string, unknown>).label = liveLabel
            parsed.wallet = walletObj
            savePayload = `${JSON.stringify(parsed, null, 2)}\n`
          } else {
            savePayload = text
          }
        } catch {
          savePayload = text
        }
      } else if (dest.buildSave) {
        savePayload = dest.buildSave(walletForExport)
      }
    } catch (e) {
      setStatusMessage(e instanceof Error ? e.message : 'Export failed')
      return
    }
    if (!payload.trim()) {
      setStatusMessage('Nothing to export for this destination')
      return
    }
    const cacheKey = `${dest.encoding}:${payload}`
    let pre = watchOnlyQrCacheRef.current.get(cacheKey)
    if (!pre?.animated?.frames.length) {
      try {
        pre = await localExportQrPacks(payload, dest.encoding)
        watchOnlyQrCacheRef.current.set(cacheKey, pre)
      } catch {
        pre = undefined
      }
    }
    await showExportQr(`Export → ${dest.name}`, payload, dest.filename, dest.mime, {
      density: dest.density,
      encoding: dest.encoding,
      preferredEncoding: dest.encoding,
      hint: dest.hint,
      savePayload,
      saveFilename: dest.saveFilename,
      saveMime: dest.saveMime,
      saveLabel: dest.id === 'seedmask' ? 'Save' : undefined,
      saveInfoTip:
        dest.id === 'seedmask'
          ? 'Saves a SeedMask wallet file for Add wallet → Import wallet. If this wallet has a password, the file stays sealed — only SeedMask opens it with that password.'
          : undefined,
      prebuilt: pre,
    })
  }

  function kaspaPolicyExportPayload(wallet: WalletDTO): string {
    const isMultisig = walletIsMultisig(wallet)
    const payload = isMultisig
      ? {
          format: 'kaspa-p2sh',
          coin: 'kaspa',
          name: editLabel.trim() || wallet.label,
          policy: `${wallet.multisig_m || 0}of${wallet.multisig_n || walletMultisigCosigners(wallet).length}`,
          derivation: walletResolvedDerivation(wallet),
          cosigners: walletMultisigCosigners(wallet).map((c, i) => ({
            label: c.label || `Cosigner ${i + 1}`,
            fingerprint: c.fingerprint || undefined,
            derivation: c.derivation || walletResolvedDerivation(wallet),
            kpub: c.xpub,
          })),
        }
      : {
          format: 'seedmask_kaspa_watch_only',
          coin: 'kaspa',
          name: editLabel.trim() || wallet.label,
          policy: 'singlesig',
          derivation: walletResolvedDerivation(wallet),
          fingerprint: walletResolvedFingerprint(wallet) || undefined,
          kpub: wallet.kpub,
        }
    return JSON.stringify(payload, null, 2)
  }

  function bitcoinPolicyExportPayload(wallet: WalletDTO): string {
    const isMultisig = walletIsMultisig(wallet)
    const payload = isMultisig
      ? {
          format: 'bitcoin-multisig',
          coin: 'bitcoin',
          name: editLabel.trim() || wallet.label,
          policy: `${wallet.multisig_m || 0}of${wallet.multisig_n || walletMultisigCosigners(wallet).length}`,
          script_type: wallet.script_type || undefined,
          derivation: walletResolvedDerivation(wallet),
          descriptor: walletDescriptor || wallet.descriptor || undefined,
          cosigners: walletMultisigCosigners(wallet).map((c, i) => ({
            label: c.label || `Cosigner ${i + 1}`,
            fingerprint: c.fingerprint || undefined,
            derivation: c.derivation || walletResolvedDerivation(wallet),
            xpub: c.xpub,
          })),
        }
      : {
          format: 'seedmask_bitcoin_watch_only',
          coin: 'bitcoin',
          name: editLabel.trim() || wallet.label,
          policy: 'singlesig',
          script_type: wallet.script_type || undefined,
          derivation: walletResolvedDerivation(wallet),
          fingerprint: walletResolvedFingerprint(wallet) || undefined,
          xpub: wallet.kpub,
          descriptor: walletDescriptor || wallet.descriptor || undefined,
        }
    return JSON.stringify(payload, null, 2)
  }

  function compactJson(pretty: string): string {
    try {
      return JSON.stringify(JSON.parse(pretty))
    } catch {
      return pretty
    }
  }

  function policyExportPretty(wallet: WalletDTO): string {
    return walletCoin(wallet) === 'kaspa'
      ? kaspaPolicyExportPayload(wallet)
      : bitcoinPolicyExportPayload(wallet)
  }

  async function ensurePolicyQrPrefetch(): Promise<void> {
    if (!activeWallet) return
    const pretty = policyExportPretty(activeWallet)
    const compact = compactJson(pretty)
    const key = `ur:${compact}`
    const hit = policyQrPrefetchRef.current
    if (hit?.key === key && hit.animated?.frames.length) return
    if (policyQrPrefetchPromiseRef.current) {
      await policyQrPrefetchPromiseRef.current
      if (policyQrPrefetchRef.current?.key === key && policyQrPrefetchRef.current.animated?.frames.length) {
        return
      }
    }
    const run = (async () => {
      try {
        const packs = await localExportQrPacks(compact, 'ur')
        policyQrPrefetchRef.current = {
          key,
          pretty,
          static: packs.static,
          animated: packs.animated,
        }
      } catch (e) {
        console.warn('Export Policy QR prefetch failed', e)
        if (policyQrPrefetchRef.current?.key === key) policyQrPrefetchRef.current = null
      }
    })()
    policyQrPrefetchPromiseRef.current = run.finally(() => {
      if (policyQrPrefetchPromiseRef.current === run) policyQrPrefetchPromiseRef.current = null
    })
    await run
  }

  useEffect(() => {
    if (!activeWallet) {
      policyQrPrefetchRef.current = null
      watchOnlyQrCacheRef.current.clear()
      return
    }
    void ensurePolicyQrPrefetch()
    // Prefetch when wallet identity / policy inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional deps for policy payload
  }, [
    activeWallet?.id,
    editLabel,
    walletDescriptor,
    editSinglesigFingerprint,
    editCosigners,
    activeWallet?.multisig_m,
    activeWallet?.multisig_n,
    activeWallet?.kpub,
    activeWallet?.script_type,
  ])

  async function exportKaspaPolicyQr(): Promise<void> {
    if (!activeWallet) return
    const multisig = walletIsMultisig(activeWallet)
    const pretty = kaspaPolicyExportPayload(activeWallet)
    const compact = compactJson(pretty)
    void ensurePolicyQrPrefetch()
    const preKey = `ur:${compact}`
    const pre = policyQrPrefetchRef.current?.key === preKey ? policyQrPrefetchRef.current : null
    await showExportQr(
      multisig ? 'Kaspa multisig policy' : 'Kaspa watch-only',
      compact,
      `${safeExportName()}-kaspa-policy.json`,
      'application/json',
      {
        encoding: 'ur',
        preferredEncoding: 'ur',
        density: pre?.static?.frames.length ? 'static' : 'animated',
        hint: multisig ? 'Scan on SeedMask to register this multisig policy.' : 'Scan or save this wallet policy JSON.',
        showInstructions: multisig,
        savePayload: pretty,
        prebuilt: pre?.animated?.frames.length
          ? { static: pre.static, animated: pre.animated }
          : undefined,
      },
    )
  }

  async function exportBitcoinPolicyQr(): Promise<void> {
    if (!activeWallet) return
    const multisig = walletIsMultisig(activeWallet)
    const pretty = bitcoinPolicyExportPayload(activeWallet)
    const compact = compactJson(pretty)
    void ensurePolicyQrPrefetch()
    const preKey = `ur:${compact}`
    const pre = policyQrPrefetchRef.current?.key === preKey ? policyQrPrefetchRef.current : null
    await showExportQr(
      multisig ? 'Bitcoin multisig policy' : 'Bitcoin watch-only',
      compact,
      `${safeExportName()}-bitcoin-policy.json`,
      'application/json',
      {
        encoding: 'ur',
        preferredEncoding: 'ur',
        density: pre?.static?.frames.length ? 'static' : 'animated',
        hint: multisig ? 'Scan on SeedMask to register this multisig policy.' : 'Scan or save this wallet policy JSON.',
        showInstructions: multisig,
        savePayload: pretty,
        prebuilt: pre?.animated?.frames.length
          ? { static: pre.static, animated: pre.animated }
          : undefined,
      },
    )
  }

  async function exportPolicyQr(): Promise<void> {
    if (!activeWallet) return
    if (walletCoin(activeWallet) === 'kaspa') await exportKaspaPolicyQr()
    else await exportBitcoinPolicyQr()
  }

  async function removeWallet(): Promise<void> {
    if (!api || !activeWallet) return
    const removedId = activeWallet.id
    const chain = walletCoin(activeWallet)
    try {
      await api.deleteWallet(removedId)
      const remaining = await loadWallets()
      const firstForChain =
        orderedWalletsForChain(remaining, chain)[0] ?? remaining[0]
      setSidebarSelection('dashboard')
      setShowRemoveConfirm(false)
      if (firstForChain) {
        await activateWallet(firstForChain.id)
        setStatusMessage('Wallet removed')
      } else {
        setStatusMessage('Wallet removed — add a wallet to continue')
      }
    } catch (e) {
      setStatusMessage(e instanceof Error ? e.message : 'Remove failed')
    }
  }

  async function copyText(text: string, message: string): Promise<void> {
    const ok = await copyToClipboard(text)
    setStatusMessage(ok ? message : 'Copy failed — select the text and copy manually')
  }

  async function saveDescriptorFile(): Promise<void> {
    if (!activeWallet || !walletDescriptor) {
      setStatusMessage('Descriptor not loaded yet')
      return
    }
    const safeName = (editLabel.trim() || 'wallet').replace(/\//g, '-')
    try {
      const pdf = await buildDescriptorPdf(walletDescriptor, activeWallet, editLabel)
      const saved = await saveFileWithDialog(pdf, `${safeName}-descriptor.pdf`, 'application/pdf')
      setStatusMessage(saved ? 'Descriptor PDF saved' : 'Save cancelled')
    } catch (e) {
      setStatusMessage(e instanceof Error ? e.message : 'PDF save failed')
    }
  }

  /** Kaspa (and other non-descriptor chains): printable watch-only PDF in the descriptor slot. */
  async function saveWatchOnlyPdfFile(): Promise<void> {
    if (!activeWallet) return
    const safeName = (editLabel.trim() || 'wallet').replace(/\//g, '-')
    const coin = walletCoin(activeWallet)
    try {
      if (coin === 'kaspa') {
        // Full policy JSON in the QR (re-import); clean summary printed above.
        const policyJson = kaspaPolicyExportPayload(activeWallet)
        const qrPayload = JSON.stringify(JSON.parse(policyJson))
        const pdf = await buildDescriptorPdf(qrPayload, activeWallet, editLabel, {
          title: 'Backup PDF',
          keyLabel: 'Kpub',
          bodyText: formatKaspaPolicyPdfBody(policyJson),
          bodyFont: 'Helv',
        })
        const saved = await saveFileWithDialog(pdf, `${safeName}-backup.pdf`, 'application/pdf')
        setStatusMessage(saved ? 'Backup PDF saved' : 'Save cancelled')
        return
      }
      const payload = walletIsMultisig(activeWallet)
        ? bitcoinPolicyExportPayload(activeWallet)
        : seedMaskCompactExport(activeWallet)
      const pdf = await buildDescriptorPdf(payload, activeWallet, editLabel, {
        title: 'Backup PDF',
        keyLabel: 'Xpub',
      })
      const saved = await saveFileWithDialog(pdf, `${safeName}-backup.pdf`, 'application/pdf')
      setStatusMessage(saved ? 'Backup PDF saved' : 'Save cancelled')
    } catch (e) {
      setStatusMessage(e instanceof Error ? e.message : 'PDF save failed')
    }
  }

  async function showDescriptorQr(): Promise<void> {
    if (!walletDescriptor) {
      setStatusMessage('Descriptor not loaded yet')
      return
    }
    await showExportQr('Bitcoin output descriptor', walletDescriptor, `${safeExportName()}-descriptor.pdf`, 'application/pdf', {
      encoding: 'plain',
      preferredEncoding: 'plain',
      density: 'static',
      hint: 'Scan or save this BIP380 output descriptor. Save file… writes a PDF with QR + wallet details.',
    })
  }

  if (!activeWallet) {
    return (
      <div className="wallet-settings-page">
        <h2 className="section-title">Wallet settings</h2>
        <div className="card">
          <p className="muted">No active wallet — add or select a wallet from the sidebar.</p>
        </div>
        <div className="card">
          <h3>Security</h3>
          <p className="muted">This Mac stores extended public keys only — never your seed.</p>
        </div>
      </div>
    )
  }

  const coin = walletCoin(activeWallet)

  return (
    <div className="wallet-settings-page">
      <h2 className="section-title">Wallet settings</h2>

      <div className="wallet-settings-grid">
        <div className="card sparrow-card wallet-settings-header-card">
          <div className="wallet-settings-header-row">
            <div className="wallet-settings-header-fields">
              <label className="field-label">Wallet name</label>
              <input
                className="seed-mask-field"
                value={editLabel}
                placeholder="Name"
                onChange={(e) => {
                  setEditLabel(e.target.value)
                  if (activeWallet) applyLocalWalletLabel(activeWallet.id, e.target.value)
                }}
              />
            </div>
          </div>
          <div className="wallet-settings-badges">
            <span className="wallet-badge wallet-badge-chain">{coin === 'bitcoin' ? 'Bitcoin' : 'Kaspa'}</span>
            <span className="wallet-badge">{walletPolicyLabel(activeWallet)}</span>
            {walletScriptTypeLabel(activeWallet) && (
              <span className="wallet-badge">{walletScriptTypeLabel(activeWallet)}</span>
            )}
            <span className="muted">Watch-only · {extendedKeyLabel(coin)}</span>
          </div>
          <div className="wallet-settings-header-actions">
            <span className="wallet-settings-export-action">
              <button type="button" className="btn btn-ghost" onClick={() => void exportWallet()}>
                Export watch-only wallet
              </button>
              <InfoTipButton text="QR or file for another app — BlueWallet, Sparrow, Electrum, or SeedMask. For SeedMask: scan the QR in Add wallet, or Save file for Import wallet (password stays sealed)." />
            </span>
          </div>
        </div>

        <div className="card sparrow-card wallet-settings-sync-card">
          <h3 className="wallet-settings-card-title">Mainnet sync</h3>
          <p className="muted">
            How many receive and change addresses to list in Addresses. Balance sync also looks ahead
            past this depth (BIP44 gap) so coins on higher indices still appear. Use up to 100 if older
            history is missing.
          </p>
          <div className="row spread" style={{ marginTop: 12 }}>
            <span>Scan depth</span>
            <span className="wallet-scan-depth-value">
              {scanSaving && <span className="muted">Saving… </span>}
              {editScanLimit} addresses
            </span>
          </div>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={editScanLimit}
            onChange={(e) => setEditScanLimit(Number(e.target.value))}
            style={{ width: '100%', marginTop: 10 }}
          />
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Higher depth lists more addresses and can find older history, but refreshes take longer.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="row spread">
          <div>
            <h3 className="wallet-policy-heading">
              <span>Wallet policy</span>
              <WalletKeystoreGlyph keyCount={walletIsMultisig(activeWallet) ? 2 : 1} iconSize={22} />
            </h3>
            <p className="muted">Derived from your imported watch-only key.</p>
          </div>
          {(coin === 'kaspa' || coin === 'bitcoin') && (
            <span className="wallet-settings-export-action">
              <button type="button" className="btn btn-ghost" onClick={() => void exportPolicyQr()}>
                Export Policy
              </button>
              <InfoTipButton text="Multisig: scan on SeedMask to register the policy. Singlesig: fuller wallet JSON for backup or import." />
            </span>
          )}
        </div>

        <div className="wallet-meta-row">
          <MetaChip title="Chain" value={coin === 'bitcoin' ? 'Bitcoin' : 'Kaspa'} />
          {walletIsMultisig(activeWallet) ? (
            <>
              <MetaChip title="Policy" value="Multisig" />
              {walletMultisigQuorumLabel(activeWallet) && (
                <MetaChip title="Signatures" value={walletMultisigQuorumLabel(activeWallet)} />
              )}
            </>
          ) : (
            <MetaChip title="Policy" value={walletPolicyLabel(activeWallet)} />
          )}
          {walletScriptTypeLabel(activeWallet) && (
            <MetaChip title="Script" value={walletScriptTypeLabel(activeWallet)} />
          )}
          <MetaChip title="Account" value={`#${walletResolvedAccount(activeWallet)}`} mono />
          <MetaChip title="Derivation" value={walletResolvedDerivation(activeWallet)} mono />
          {!walletIsMultisig(activeWallet) && walletResolvedFingerprint(activeWallet) && (
            <MetaChip title="Fingerprint" value={walletResolvedFingerprint(activeWallet)} mono />
          )}
        </div>
      </div>

      <div className="card">
        {walletIsMultisig(activeWallet) ? (
          <MultisigKeystoreSection
            wallet={activeWallet}
            editCosigners={editCosigners}
            selectedIndex={selectedKeystoreIndex}
            onSelectIndex={setSelectedKeystoreIndex}
            onCosignersChange={(next) => {
              setEditCosigners(next)
              scheduleKeystoreSave(undefined, next)
            }}
            onCopy={copyText}
          />
        ) : (
          <SinglesigKeystoreSection
            wallet={activeWallet}
            editKeystoreLabel={editKeystoreLabel}
            onKeystoreLabelChange={setEditKeystoreLabel}
            fingerprint={editSinglesigFingerprint}
            onFingerprintChange={(value) => {
              const sanitized = sanitizeFingerprint(value)
              setEditSinglesigFingerprint(sanitized)
              scheduleKeystoreSave(sanitized)
            }}
            derivation={editSinglesigDerivation}
            onDerivationChange={(value) => {
              setEditSinglesigDerivation(value)
              const account = accountIndexFromDerivation(value)
              applyLocalWalletPatch(activeWallet.id, {
                derivation: value,
                ...(account != null ? { account } : {}),
              })
              scheduleKeystoreSave(undefined, undefined, value)
            }}
            onCopy={copyText}
          />
        )}
      </div>

      {coin === 'bitcoin' && (
        <div className="card">
          <h3>Output descriptor</h3>
          <p className="muted">Sparrow-compatible descriptor for this watch-only wallet. Copy to import elsewhere.</p>
          {descriptorError && <p className="wallet-settings-error">{descriptorError}</p>}
          {!walletDescriptor ? (
            <p className="muted">Loading descriptor…</p>
          ) : (
            <>
              <pre className="wallet-descriptor">{walletDescriptor}</pre>
              <div className="row">
                <button type="button" className="btn btn-ghost" onClick={() => void copyText(walletDescriptor, 'Descriptor copied')}>
                  Copy descriptor
                </button>
                <button type="button" className="btn btn-ghost" onClick={saveDescriptorFile}>
                  Save descriptor…
                </button>
                <button
                  type="button"
                  className="btn btn-ghost wallet-settings-qr-icon-btn"
                  title="Show descriptor QR"
                  aria-label="Show descriptor QR"
                  onClick={() => void showDescriptorQr()}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 4h6v6H4V4Zm2 2v2h2V6H6Zm8-2h6v6h-6V4Zm2 2v2h2V6h-2ZM4 14h6v6H4v-6Zm2 2v2h2v-2H6Zm8-2h2v2h-2v-2Zm4 0h2v2h-2v-2Zm-4 4h2v2h-2v-2Zm4 0h2v2h-2v-2Zm-1-2h2v2h-2v-2Z" />
                  </svg>
                </button>
              </div>
            </>
          )}
          {activeWallet.descriptor && activeWallet.descriptor !== walletDescriptor && (
            <>
              <p className="field-label" style={{ marginTop: 16 }}>
                Imported descriptor
              </p>
              <pre className="wallet-descriptor">{activeWallet.descriptor}</pre>
            </>
          )}
        </div>
      )}

      {coin === 'kaspa' && (
        <div className="card">
          <h3>Backup PDF</h3>
          <p className="muted">
            Kaspa has no BIP380 output descriptors. Save a printable backup PDF of this wallet&apos;s public
            definition (QR carries the full JSON; details list each kpub). Separate from Export watch-only /
            Export Policy, which are for importing into apps or SeedMask.
          </p>
          <div className="row">
            <button type="button" className="btn btn-ghost" onClick={() => void saveWatchOnlyPdfFile()}>
              Save PDF…
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h3>Security</h3>
        <p className="muted">This Mac stores extended public keys only — never your seed.</p>
      </div>

      <div className="card wallet-danger-card">
        <h3>Remove wallet</h3>
        <p className="muted">
          Deletes watch-only data from this Mac. On-chain funds are not affected.
        </p>
        <button type="button" className="btn btn-danger" onClick={() => setShowRemoveConfirm(true)}>
          Remove wallet from this Mac
        </button>
      </div>

      {showRemoveConfirm && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowRemoveConfirm(false)}>
          <div className="modal-card" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Remove this wallet?</h3>
            <p className="muted">
              Clears this wallet&apos;s {extendedKeyLabel(coin)} from this Mac. Funds stay on-chain — re-import anytime.
            </p>
            <div className="row spread" style={{ marginTop: 16 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setShowRemoveConfirm(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  setShowRemoveConfirm(false)
                  void removeWallet()
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {exportDestOpen && activeWallet && (
        <div className="modal-backdrop" role="presentation" onClick={() => setExportDestOpen(false)}>
          <div className="modal-card elevated-card export-dest-sheet" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Export watch-only wallet</h3>
            <p className="muted">Choose the app that will scan this QR — each expects a different payload.</p>
            <div className="export-dest-list">
              {watchOnlyExportDestinations(activeWallet).map((dest) => (
                <button
                  key={dest.id}
                  type="button"
                  className="export-dest-option"
                  onClick={() => void exportToDestination(dest)}
                >
                  <strong>{dest.name}</strong>
                  <span className="muted">{dest.detail}</span>
                </button>
              ))}
            </div>
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setExportDestOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {exportQrTitle && (
        <div className="modal-backdrop" role="presentation" onClick={closeExportQr}>
          <div className="modal-card wallet-export-qr-modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="wallet-export-qr-head">
              <h3>{exportQrTitle}</h3>
              <button
                type="button"
                className="btn btn-ghost wallet-export-qr-close"
                aria-label="Close"
                onClick={closeExportQr}
              >
                ×
              </button>
            </div>
            <p className="muted">
              {exportQrHint ||
                (exportQrPreferredEncoding === 'plain'
                  ? 'Scan this QR, or save the same payload as a file. Tap the QR for full screen.'
                  : 'Scan this animated or dense QR on SeedMask, or save as a file. Tap the QR for full screen.')}
            </p>
            {exportQrBusy && <p className="muted">Preparing QR…</p>}
            {exportQrError && <p className="wallet-settings-error">{exportQrError}</p>}
            {exportQrFrames.length > 0 && (
              <>
                <AnimatedQRView
                  frames={exportQrFrames}
                  frameIntervalMs={exportQrFrameMs}
                  maxDisplaySize={exportQrDisplaySize}
                  isStatic={exportQrDensity === 'static' || exportQrFrames.length <= 1}
                  allowFullscreen
                  isPlaying={exportQrAutoPlaying}
                  onPlayingChange={setExportQrAutoPlaying}
                  onFullscreen={() => {
                    // Defer so the opening click cannot hit the new overlay and shrink/dismiss it.
                    window.setTimeout(() => setExportQrDenseFullscreen(true), 0)
                  }}
                  footer={
                    exportQrDensity === 'animated' && exportQrFrames.length > 1 ? (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => setExportQrAutoPlaying((p) => !p)}
                      >
                        {exportQrAutoPlaying ? 'Pause' : 'Start'}
                      </button>
                    ) : undefined
                  }
                />
                <div className="wallet-export-qr-density" role="group" aria-label="QR density">
                  <button
                    type="button"
                    className={`btn btn-ghost${exportQrDensity === 'static' ? ' active' : ''}`}
                    disabled={!exportQrReady.static}
                    onClick={() => toggleExportQrDensity('static')}
                  >
                    Dense
                  </button>
                  <button
                    type="button"
                    className={`btn btn-ghost${exportQrDensity === 'animated' ? ' active' : ''}`}
                    disabled={!exportQrReady.animated}
                    title={
                      !exportQrReady.animated
                        ? 'Animated QR is not available for this payload (use Dense or Save file).'
                        : undefined
                    }
                    onClick={() => toggleExportQrDensity('animated')}
                  >
                    Animated
                  </button>
                </div>
              </>
            )}
            <div className="row spread" style={{ marginTop: 16 }}>
              {exportQrShowInstructions ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setExportQrInstructionsOpen(true)}
                >
                  Instructions
                </button>
              ) : (
                <span />
              )}
              <span className="wallet-settings-export-action">
                <button type="button" className="btn btn-ghost" onClick={() => void saveExportQrPayload()}>
                  {exportQrSaveLabel}
                </button>
                {exportQrSaveInfoTip && <InfoTipButton text={exportQrSaveInfoTip} />}
              </span>
            </div>
          </div>
        </div>
      )}
      {exportQrInstructionsOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setExportQrInstructionsOpen(false)}
        >
          <div className="modal-card" role="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="wallet-export-qr-head">
              <h3>Instructions</h3>
              <button
                type="button"
                className="btn btn-ghost wallet-export-qr-close"
                aria-label="Close"
                onClick={() => setExportQrInstructionsOpen(false)}
              >
                ×
              </button>
            </div>
            <ol className="wallet-export-instructions">
              <li>Unlock SeedMask.</li>
              <li>Open multisig / policy registration on the device.</li>
              <li>Scan this QR (use Animated if Dense is hard to read).</li>
              <li>Confirm the policy on SeedMask.</li>
            </ol>
          </div>
        </div>
      )}
      {exportQrDenseFullscreen && exportQrFrames.length > 0 && (
        <DenseQRFullscreen
          frames={exportQrFrames}
          frameIntervalMs={exportQrFrameMs}
          isStatic={exportQrDensity === 'static' || exportQrFrames.length <= 1}
          isPlaying={exportQrAutoPlaying}
          onClose={() => setExportQrDenseFullscreen(false)}
        />
      )}
    </div>
  )
}

function MetaChip({ title, value, mono }: { title: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="wallet-meta-chip">
      <span className="wallet-meta-chip-title">{title}</span>
      <span className={`wallet-meta-chip-value${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  )
}

function KeystoreNatureCaption({ wallet }: { wallet: WalletDTO }): React.JSX.Element {
  const { name, mode } = walletKeystoreNatureParts(wallet)
  return (
    <div className="keystore-nature-caption">
      <p className="keystore-nature-name">{name}</p>
      {mode ? <p className="keystore-nature-mode">{mode}</p> : null}
    </div>
  )
}

function SinglesigKeystoreSection({
  wallet,
  editKeystoreLabel,
  onKeystoreLabelChange,
  fingerprint,
  onFingerprintChange,
  derivation,
  onDerivationChange,
  onCopy,
}: {
  wallet: WalletDTO
  editKeystoreLabel: string
  onKeystoreLabelChange: (value: string) => void
  fingerprint: string
  onFingerprintChange: (value: string) => void
  derivation: string
  onDerivationChange: (value: string) => void
  onCopy: (text: string, message: string) => void | Promise<void>
}): React.JSX.Element {
  const coin = walletCoin(wallet)
  const displayLabel = editKeystoreLabel.trim() || walletKeystoreLabel(wallet)
  const filled = !!wallet.kpub.trim()
  const [showNativeFormat, setShowNativeFormat] = useState(false)
  const altKey =
    coin === 'bitcoin'
      ? alternateBitcoinExtendedPubkey(wallet.kpub, wallet.script_type, derivation || walletResolvedDerivation(wallet))
      : null
  const displayExtendedKey = showNativeFormat && altKey ? altKey.key : wallet.kpub
  const displayExtendedLabel =
    showNativeFormat && altKey
      ? altKey.label
      : bitcoinExtendedPubPrefix(wallet.kpub)?.toUpperCase() ?? extendedKeyLabel(coin)

  return (
    <div className="wallet-keystore-section">
      <div className="keystore-section-header">
        <h3>Keystores</h3>
      </div>
      <KeystoreNatureCaption wallet={wallet} />
      <KeystoreTilesRow
        labels={[displayLabel || 'Keystore']}
        fingerprints={[fingerprint]}
        filled={[filled]}
        selectedIndex={0}
        onSelect={() => {}}
        hardwareKinds={[wallet.hardware]}
      />
      <KeystoreDetailPanel>
        <p className="keystore-detail-title">{displayLabel || 'Keystore'}</p>
        <KeystoreFieldRow title="Label" value={editKeystoreLabel} prominent onChange={onKeystoreLabelChange} />
        <FingerprintField
          title="Fingerprint"
          value={fingerprint}
          placeholder="8 hex chars"
          onChange={onFingerprintChange}
        />
        <KeystoreFieldRow
          title="Derivation"
          value={derivation}
          mono
          prominent
          fieldSize="derivation"
          placeholder={coin === 'bitcoin' ? "m/84'/0'/0'" : "m/44'/111111'/0'"}
          onChange={onDerivationChange}
        />
        <label className="keystore-field prominent">
          <ExtendedKeyLabelRow
            coin={coin}
            keyValue={wallet.kpub}
            scriptType={wallet.script_type}
            derivation={derivation || walletResolvedDerivation(wallet)}
            showAlternate={showNativeFormat}
            onToggle={() => setShowNativeFormat((v) => !v)}
          />
          <pre className="keystore-extended-key-value">{displayExtendedKey}</pre>
          <button
            type="button"
            className="copy-extended-key-btn"
            onClick={() => void onCopy(displayExtendedKey, `${displayExtendedLabel} copied`)}
          >
            Copy {displayExtendedLabel}
          </button>
        </label>
      </KeystoreDetailPanel>
    </div>
  )
}

function MultisigKeystoreSection({
  wallet,
  editCosigners,
  selectedIndex,
  onSelectIndex,
  onCosignersChange,
  onCopy,
}: {
  wallet: WalletDTO
  editCosigners: EditableCosigner[]
  selectedIndex: number
  onSelectIndex: (index: number) => void
  onCosignersChange: (next: EditableCosigner[]) => void
  onCopy: (text: string, message: string) => void | Promise<void>
}): React.JSX.Element {
  const coin = walletCoin(wallet)
  const keyLabel = coin === 'kaspa' ? 'kpub' : 'xpub'
  const safeIndex = Math.min(selectedIndex, Math.max(editCosigners.length - 1, 0))
  const cosigner = editCosigners[safeIndex]
  const labels = editCosigners.map((c, i) => c.label.trim() || `Cosigner ${i + 1}`)
  const fingerprints = editCosigners.map((c) => c.fingerprint)
  const filled = editCosigners.map((c) => !!c.xpub.trim())
  const [showNativeFormat, setShowNativeFormat] = useState(false)
  const derivation = cosigner?.derivation || walletResolvedDerivation(wallet)
  const altKey =
    coin === 'bitcoin' && cosigner?.xpub
      ? alternateBitcoinExtendedPubkey(cosigner.xpub, wallet.script_type, derivation)
      : null
  const displayExtendedKey = showNativeFormat && altKey ? altKey.key : cosigner?.xpub || ''
  const displayExtendedLabel =
    showNativeFormat && altKey
      ? altKey.label
      : bitcoinExtendedPubPrefix(cosigner?.xpub || '')?.toUpperCase() ?? (keyLabel === 'kpub' ? 'Kpub' : 'Xpub')

  useEffect(() => {
    setShowNativeFormat(false)
  }, [safeIndex])

  if (walletIsIncompleteLegacyMultisig(wallet)) {
    return (
      <div className="wallet-keystore-section">
        <p className="wallet-settings-error">
          This wallet was saved with only cosigner 1&apos;s {keyLabel} (older coordinator build). Addresses will not match until you re-import.
        </p>
        <pre className="wallet-descriptor">Stored {keyLabel} (cosigner 1 only): {wallet.kpub}</pre>
      </div>
    )
  }

  if (!walletHasCompleteMultisigCosigners(wallet) && editCosigners.length === 0) {
    return (
      <div className="wallet-keystore-section">
        <p className="wallet-settings-error">
          Cosigner {keyLabel}s are missing. Remove this wallet and re-import with all cosigner keystores.
        </p>
      </div>
    )
  }

  return (
    <div className="wallet-keystore-section">
      <div className="keystore-section-header">
        <h3>Keystores</h3>
      </div>
      <KeystoreNatureCaption wallet={wallet} />
      <KeystoreTilesRow
        labels={labels}
        fingerprints={fingerprints}
        filled={filled}
        selectedIndex={safeIndex}
        onSelect={onSelectIndex}
        hardwareKinds={editCosigners.map(() => wallet.hardware)}
      />
      {cosigner && (
        <KeystoreDetailPanel>
          <p className="keystore-detail-title">{labels[safeIndex]}</p>
          <KeystoreFieldRow
            title="Label"
            value={cosigner.label}
            prominent
            onChange={(label) => {
              const next = [...editCosigners]
              next[safeIndex] = { ...next[safeIndex], label }
              onCosignersChange(next)
            }}
          />
          <FingerprintField
            title="Fingerprint"
            value={cosigner.fingerprint}
            placeholder="8 hex chars"
            onChange={(value) => {
              const next = [...editCosigners]
              next[safeIndex] = { ...next[safeIndex], fingerprint: sanitizeFingerprint(value) }
              onCosignersChange(next)
            }}
          />
          <KeystoreFieldRow
            title="Derivation"
            value={cosigner.derivation || walletResolvedDerivation(wallet)}
            mono
            prominent
            fieldSize="derivation"
            onChange={(derivationValue) => {
              const next = [...editCosigners]
              next[safeIndex] = { ...next[safeIndex], derivation: derivationValue }
              onCosignersChange(next)
            }}
          />
          <label className="keystore-field prominent">
            <ExtendedKeyLabelRow
              coin={coin}
              keyValue={cosigner.xpub}
              scriptType={wallet.script_type}
              derivation={derivation}
              showAlternate={showNativeFormat}
              onToggle={() => setShowNativeFormat((v) => !v)}
              fallbackLabel={keyLabel === 'kpub' ? 'Kpub' : 'Xpub'}
            />
            <pre className="keystore-extended-key-value">{displayExtendedKey || '—'}</pre>
            {cosigner.xpub && (
              <button
                type="button"
                className="copy-extended-key-btn"
                onClick={() => void onCopy(displayExtendedKey, `${displayExtendedLabel} copied`)}
              >
                Copy {displayExtendedLabel}
              </button>
            )}
          </label>
        </KeystoreDetailPanel>
      )}
    </div>
  )
}
