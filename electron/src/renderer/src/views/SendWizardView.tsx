import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { APIError } from '@renderer/api/client'
import type { QRDisplayDensity, UtxoDTO } from '@renderer/api/types'
import { coinUnit, looksLikeBitcoinAddress, qrDensityLabel, utxoMatchesChain, walletCoin } from '@renderer/api/types'
import { useApp } from '@renderer/state/AppProvider'
import { AnimatedQRView, DenseQRFullscreen, QrTransportControls } from '@renderer/components/AnimatedQRView'
import { AddressDisplay } from '@renderer/components/AddressDisplay'
import { QRScannerSheet } from '@renderer/components/QRScannerSheet'
import { SignedQRScanner } from '@renderer/components/SignedQRScanner'
import { EmptyStateView } from '@renderer/components/EmptyStateView'
import {
  CoinGroupPicker,
  RecipientSelfMenu,
  reviewCoinsSidebarSubtitle,
  reviewFeeTitle,
  SeedMaskFiatField,
  SeedMaskUnitField,
  SelectedCoinsPanel,
} from '@renderer/components/SendUIComponents'
import { ChevronLeftIcon, BluetoothIcon, QRViewfinderIcon, UsbIcon } from '@renderer/components/icons'
import { InfoTipButton } from '@renderer/components/settings/SettingsChrome'
import { TransactionVisualizeView } from '@renderer/components/TransactionVisualizeView'
import { fiatPriceService } from '@renderer/services/fiatPriceService'
import { isKaspaHighFee, kaspaHighFeeReason } from '@renderer/utils/feeWarnings'
import {
  walletAccountGroupKey,
  walletFamilyLabel,
  walletsSharingAccountGroup,
} from '@renderer/utils/walletHelpers'
import {
  coinDisplayUnit,
  formatCoinUnitsLabel,
  formatSompiForDisplay,
  formatSompiLabel,
  parseDisplayToCoinAmount,
  parseDisplayToSompi,
  usesBitcoinSats,
} from '@renderer/utils/coinDisplay'
import { formatCoinFiat } from '@renderer/utils/fiatFormat'
import {
  decodeQrImages,
  isBitcoinSignedPsbt,
  isSignedKaspaTransaction,
  reviewCoinsForSidebar,
  reviewChangeKas,
  reviewFeeNote,
  reviewAddressInputTotalKas,
  reviewInputTotalKas,
  reviewTotalFeeSompi,
  reviewWalletRemainderNote,
  summaryFromResponse,
  totalSelectedSompi,
  usedKeysFromUnsigned,
  type BuildSummary,
} from '@renderer/utils/buildSummary'
import { groupUtxosByAddress } from '@renderer/utils/utxoHelpers'
import { resolveSpendPool } from '@renderer/utils/sendSpendPool'
import {
  coinAmountLabel,
  editableFiatText,
  formatSendKas,
  parseSendAmount,
  parseSendSompi,
  utxoAmountSompi,
} from '@renderer/utils/sendAmount'
import { apiError, feeHint } from '@renderer/utils/userErrors'
import {
  affordableBitcoinFeeSats,
  bitcoinMaxSendFromUtxos,
  bitcoinNeedsLocalFeeEstimate,
  bitcoinSendFeeSummary,
  bitcoinSweepOnlyWallet,
  capBitcoinFeeForCoins,
  bitcoinFeeTierEta,
  estimateBitcoinFeeSats,
  formatBitcoinFeerate,
  resolveBitcoinTierRates,
} from '@renderer/utils/bitcoinSend'
import { isLikelyValidKaspaAddress, normalizeKaspaAddress } from '@renderer/utils/kaspaAddress'
import { readFromClipboard } from '@renderer/utils/clipboard'
import { saveFileWithDialog } from '@renderer/utils/nativeFiles'
import {
  exportDeviceV2,
  exportKaspaHandoffDraft,
  isPsbtBinary,
  kaspaTransactionKind,
  signedJSONString,
} from '@renderer/utils/transactionFileIO'
import { StepDot } from '@renderer/components/StepDot'

const SEND_HELP_NETWORK_FEE =
  'Fee paid to miners for this send. On Toccata, Kaspa relay fees scale with max(compute mass, 2x transaction bytes) at 100 sompi/gram, so simple sends are usually around 0.002 KAS and multi-input transactions can need more. This is separate from any KIP-9 leftover that cannot be returned as change.'

const KASPA_TOCATTA_FALLBACK_RELAY_FEE_SOMPI = 203_600

const LAST_DRAFT_ID_KEY = 'lastDraftId'

type FeeMode = 'network' | 'custom'
type BitcoinFeeTier = 'slow' | 'normal' | 'priority'

const BITCOIN_TIER_DEFAULT_RATE: Record<BitcoinFeeTier, number> = {
  slow: 0.5,
  normal: 1,
  priority: 2,
}
type AmountEditSource = 'coin' | 'fiat' | 'max' | null

const STEP_SEND = 0
const STEP_REVIEW = 1
const STEP_TITLES = ['Send', 'Review & Sign']

function blocksSendContinuation(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('cannot cover the network fee') ||
    m.includes('fee estimate failed') ||
    m.includes('coin metadata') ||
    m.includes('coin data is incomplete')
  )
}

export function SendWizardView({ onClose }: { onClose: () => void }): React.JSX.Element {
  const {
    api,
    activeWallet,
    activeWalletId,
    wallets,
    selectedChain,
    bitcoinDisplayUnit,
    utxos,
    selectedSpendUtxoKeys,
    sendUsesCustomCoinSelection,
    setSendUsesCustomCoinSelection,
    sendOpenedFromCoins,
    selectAllSpendableUtxos,
    clearSpendSelection,
    pruneSpendSelection,
    toggleSpendUtxo,
    orderedSelectedSpendUtxos,
    selectedSpendKeyCountSync,
    addressBook,
    receiveAddresses,
  displayCurrency,
  setDisplayCurrency,
  setStatusMessage,
  refreshAfterSuccessfulSend,
  notePendingSend,
  refreshFiatPrices,
  fiatTick,
    networkSettings,
  } = useApp()

  const [step, setStep] = useState(STEP_SEND)
  const [showPayeeScanner, setShowPayeeScanner] = useState(false)
  const [toAddress, setToAddress] = useState('')
  const [sendKAS, setSendKAS] = useState('')
  const [sendFiatText, setSendFiatText] = useState('')
  const [addressError, setAddressError] = useState<string | null>(null)
  const [qrFrames, setQrFrames] = useState<string[]>([])
  const [qrFrameMs, setQrFrameMs] = useState(480)
  const [qrDisplaySize, setQrDisplaySize] = useState(440)
  const [qrModulesPerFrame, setQrModulesPerFrame] = useState<number | null>(null)
  const [draftId, setDraftId] = useState('')
  const [reviewInputUtxos, setReviewInputUtxos] = useState<UtxoDTO[]>([])
  const [buildSummary, setBuildSummary] = useState<BuildSummary | null>(null)
  const [signedJSON, setSignedJSON] = useState('')
  const [signedBroadcastReady, setSignedBroadcastReady] = useState(false)
  const [signatureProgressCount, setSignatureProgressCount] = useState(0)
  const [signedValidationMessage, setSignedValidationMessage] = useState<string | null>(null)
  const [showScanner, setShowScanner] = useState(false)
  const [busy, setBusy] = useState(false)
  const [validatingPayee, setValidatingPayee] = useState(false)
  const [feeEstimating, setFeeEstimating] = useState(false)
  const [reviewBuildKey, setReviewBuildKey] = useState(0)
  const [broadcastTxid, setBroadcastTxid] = useState<string | null>(null)
  const [broadcastTxids, setBroadcastTxids] = useState<string[]>([])
  const [buildError, setBuildError] = useState<string | null>(null)
  const [qrDensity, setQrDensity] = useState<QRDisplayDensity>('animated')
  const [qrAutoPlaying, setQrAutoPlaying] = useState(true)
  const [denseQrFullscreen, setDenseQrFullscreen] = useState(false)
  const [feeMode, setFeeMode] = useState<FeeMode>('network')
  const [customFeeKAS, setCustomFeeKAS] = useState('')
  const [networkFeeSompi, setNetworkFeeSompi] = useState(
    selectedChain === 'bitcoin' ? 141 : KASPA_TOCATTA_FALLBACK_RELAY_FEE_SOMPI,
  )
  const [networkFeeKas, setNetworkFeeKas] = useState(
    selectedChain === 'bitcoin' ? 0.00000141 : KASPA_TOCATTA_FALLBACK_RELAY_FEE_SOMPI / 100_000_000,
  )
  const [feeLoadError, setFeeLoadError] = useState<string | null>(null)
  const [densityLabelFlash, setDensityLabelFlash] = useState<string | null>(null)
  const [enableRbf, setEnableRbf] = useState(true)
  const [feerateSatVb, setFeerateSatVb] = useState(1)
  const [bitcoinFeeTier, setBitcoinFeeTier] = useState<BitcoinFeeTier>('normal')
  const [bitcoinFeerates, setBitcoinFeerates] = useState<Record<string, number> | null>(null)
  const [kaspaMass, setKaspaMass] = useState<number | null>(null)
  const [kaspaStorageMass, setKaspaStorageMass] = useState<number | null>(null)
  const [kaspaExcessToMinerKas, setKaspaExcessToMinerKas] = useState<number | null>(null)
  const [kaspaMaxMass, setKaspaMaxMass] = useState(100_000)
  const [apiMaxSendSompi, setApiMaxSendSompi] = useState<number | null>(null)
  const [maxAmountRefining, setMaxAmountRefining] = useState(false)
  const [showTransactionVisualize, setShowTransactionVisualize] = useState(false)
  const [showAdvancedCoinControl, setShowAdvancedCoinControl] = useState(
    sendUsesCustomCoinSelection || sendOpenedFromCoins,
  )
  const [showAdvancedFees, setShowAdvancedFees] = useState(false)
  const [amountEditSource, setAmountEditSource] = useState<AmountEditSource>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [narrowLayout, setNarrowLayout] = useState(false)
  const [ledgerUnsigned, setLedgerUnsigned] = useState<unknown>(null)
  const [ledgerSigning, setLedgerSigning] = useState(false)
  const [hwSignLink, setHwSignLink] = useState<'usb' | 'ble'>('usb')

  const suppressAmountSideEffects = useRef(false)
  const feeLoadGeneration = useRef(0)
  const densityFlashGeneration = useRef(0)
  const buildTransactionRef = useRef<
    (density: QRDisplayDensity, allowAnimatedFallback?: boolean) => Promise<boolean>
  >(async () => false)
  const qrDensityRef = useRef<QRDisplayDensity>('animated')
  const loadDraftInputRef = useRef<HTMLInputElement>(null)
  const loadSignedInputRef = useRef<HTMLInputElement>(null)
  const draftIdRef = useRef(draftId)
  const layoutRef = useRef<HTMLDivElement>(null)
  const sendKASRef = useRef(sendKAS)
  const toAddressRef = useRef(toAddress)
  const feeDebounceRef = useRef<number | null>(null)
  const loadNetworkFeeRef = useRef<(refineMax?: boolean) => Promise<number | null>>(async () => null)
  const networkFeeSompiRef = useRef(networkFeeSompi)
  const apiMaxSendSompiRef = useRef<number | null>(null)
  const reviewBuildStartedRef = useRef(0)
  const skipReviewAutoBuildRef = useRef(false)
  const suppressDraftInvalidationRef = useRef(false)
  const explicitDenseQrRef = useRef(false)
  const selectedChainRef = useRef(selectedChain)
  const amountEditSourceRef = useRef<AmountEditSource>(null)
  const prevChainRef = useRef(selectedChain)
  const draftInvalidationReadyRef = useRef(false)

  sendKASRef.current = sendKAS
  toAddressRef.current = toAddress
  networkFeeSompiRef.current = networkFeeSompi
  apiMaxSendSompiRef.current = apiMaxSendSompi
  selectedChainRef.current = selectedChain
  amountEditSourceRef.current = amountEditSource
  draftIdRef.current = draftId

  useEffect(() => {
    if (!draftInvalidationReadyRef.current) {
      draftInvalidationReadyRef.current = true
      return
    }
    // Only invalidate while editing on Send. Never wipe an imported/built Review QR
    // just because fee state synced from the loaded draft.
    if (step !== STEP_SEND) return
    if (suppressDraftInvalidationRef.current) return
    if (!draftIdRef.current) return
    setDraftId('')
    setQrFrames([])
    setQrModulesPerFrame(null)
    setSignedJSON('')
    setSignedBroadcastReady(false)
    setSignatureProgressCount(0)
    setSignedValidationMessage(null)
    setStatusMessage('Transaction changed — rebuild the signing QR')
  }, [toAddress, sendKAS, feeMode, customFeeKAS, networkFeeSompi, selectedChain, activeWalletId, step, setStatusMessage])

  const sendChain = activeWallet ? walletCoin(activeWallet) : selectedChain
  const isBitcoinSend = sendChain === 'bitcoin'
  const showSats = usesBitcoinSats(sendChain, bitcoinDisplayUnit)
  const unit = coinDisplayUnit(sendChain, bitcoinDisplayUnit)

  const spendableUtxos = useMemo(
    () => utxos.filter((u) => utxoMatchesChain(u, sendChain)),
    [utxos, sendChain],
  )

  const spendableAddressGroups = useMemo(() => groupUtxosByAddress(spendableUtxos), [spendableUtxos])

  const selectedAddressGroupCount = useMemo(
    () => spendableAddressGroups.filter((g) => g.utxos.every((u) => selectedSpendUtxoKeys.has(u.key))).length,
    [spendableAddressGroups, selectedSpendUtxoKeys],
  )

  const orderedSelectedUtxos = useMemo(
    () => spendableUtxos.filter((u) => selectedSpendUtxoKeys.has(u.key)),
    [spendableUtxos, selectedSpendUtxoKeys],
  )

  const spendPool = useMemo(
    () =>
      resolveSpendPool({
        showAdvancedCoinControl,
        sendUsesCustomCoinSelection,
        spendableUtxos,
        orderedSelectedUtxos,
      }),
    [showAdvancedCoinControl, sendUsesCustomCoinSelection, spendableUtxos, orderedSelectedUtxos],
  )

  const spendUtxos = spendPool.utxos
  const totalSelectedSompiValue = spendPool.sompiTotal

  const preserveSpendSelection =
    sendOpenedFromCoins || sendUsesCustomCoinSelection || showAdvancedCoinControl

  const ensureWalletCoinsSelected = useCallback(() => {
    /* Default sends use the full spendable pool via resolveSpendPool — no UI select-all. */
  }, [])
  const totalSelectedKas = totalSelectedSompiValue / 100_000_000

  const payeeReceiveChoices = useMemo(() => {
    if (addressBook?.receive?.length) {
      return addressBook.receive.map((r) => ({ index: r.index, address: r.address }))
    }
    return receiveAddresses
  }, [addressBook, receiveAddresses])

  const otherSameChainWallets = useMemo(() => {
    const sameChain = wallets.filter((w) => walletCoin(w) === sendChain)
    const active = sameChain.find((w) => w.id === activeWalletId)
    const activeGroupKey = active ? walletAccountGroupKey(active) : null
    const seen = new Set<string>()
    const out: Array<{ id: string; name: string }> = []
    for (const wallet of sameChain) {
      const groupKey = walletAccountGroupKey(wallet)
      if (activeGroupKey && groupKey === activeGroupKey) continue
      if (seen.has(groupKey)) continue
      seen.add(groupKey)
      const group = walletsSharingAccountGroup(sameChain, wallet)
      out.push({
        id: wallet.id,
        name: walletFamilyLabel(wallet, group),
      })
    }
    return out
  }, [wallets, sendChain, activeWalletId])

  const effectiveFeeSompi = useMemo((): number | null => {
    if (feeMode === 'network') return networkFeeSompi
    const kas = Number(customFeeKAS.trim())
    if (!Number.isFinite(kas) || kas <= 0) return null
    return Math.max(1, Math.round(kas * 100_000_000))
  }, [feeMode, networkFeeSompi, customFeeKAS])

  const minNetworkFeeSompi = effectiveFeeSompi ?? networkFeeSompi

  const bitcoinCustomFeeSats =
    isBitcoinSend && feeMode === 'custom' && effectiveFeeSompi != null && effectiveFeeSompi > 0
      ? effectiveFeeSompi
      : null

  const bitcoinTierRates = useMemo(
    () => resolveBitcoinTierRates(bitcoinFeerates) ?? BITCOIN_TIER_DEFAULT_RATE,
    [bitcoinFeerates],
  )

  const effectiveMaxSendSompi = useMemo(() => {
    if (apiMaxSendSompi != null && apiMaxSendSompi > 0) return apiMaxSendSompi
    if (bitcoinCustomFeeSats != null) {
      const summary = bitcoinSendFeeSummary(
        spendUtxos,
        totalSelectedSompiValue,
        feerateSatVb,
        null,
        bitcoinCustomFeeSats,
      )
      if (summary?.maxSompi != null && summary.maxSompi > 0) return summary.maxSompi
      return Math.max(0, totalSelectedSompiValue - bitcoinCustomFeeSats)
    }
    return Math.max(0, totalSelectedSompiValue - minNetworkFeeSompi)
  }, [
    apiMaxSendSompi,
    bitcoinCustomFeeSats,
    spendUtxos,
    totalSelectedSompiValue,
    feerateSatVb,
    minNetworkFeeSompi,
  ])
  const maxSendableDisplay = showSats ? effectiveMaxSendSompi : effectiveMaxSendSompi / 100_000_000

  const displayedNetworkFeeKas =
    feeMode === 'network' ? networkFeeKas : effectiveFeeSompi != null ? effectiveFeeSompi / 100_000_000 : null

  const parsedSendKas = parseDisplayToCoinAmount(sendKAS, sendChain, bitcoinDisplayUnit)

  const balanceTooLowForFee = useMemo(() => {
    if (totalSelectedSompiValue <= 0) return false
    if (isBitcoinSend) {
      const inputCount = Math.max(1, spendUtxos.length)
      const affordable = affordableBitcoinFeeSats(totalSelectedSompiValue, inputCount, feerateSatVb)
      return totalSelectedSompiValue <= affordable
    }
    if (minNetworkFeeSompi <= 0) return false
    return totalSelectedSompiValue <= minNetworkFeeSompi
  }, [totalSelectedSompiValue, minNetworkFeeSompi, isBitcoinSend, spendUtxos.length, feerateSatVb])

  const coinFiatLine = useCallback(
    (amount: number): string | null => {
      const price = fiatPriceService.price(sendChain, displayCurrency)
      if (price == null) return null
      return formatCoinFiat(amount, price, displayCurrency)
    },
    [sendChain, displayCurrency],
  )

  const selectedBalanceFiatText =
    totalSelectedKas > 0 ? coinFiatLine(totalSelectedKas) : null

  const totalIncludingFeeKas = useMemo(() => {
    const sendSompi = parseDisplayToSompi(sendKAS, sendChain, bitcoinDisplayUnit)
    if (sendSompi == null || sendSompi <= 0) return null
    const feeSompi = effectiveFeeSompi ?? networkFeeSompi
    if (feeSompi == null || feeSompi <= 0) return null
    const totalSompi = sendSompi + feeSompi
    if (totalSompi > totalSelectedSompiValue) return null
    if (isBitcoinSend) {
      const inputCount = Math.max(1, spendUtxos.length)
      if (
        bitcoinSweepOnlyWallet(totalSelectedSompiValue, inputCount, feerateSatVb) &&
        sendSompi < effectiveMaxSendSompi
      ) {
        return null
      }
      const summary = bitcoinSendFeeSummary(
        spendUtxos,
        totalSelectedSompiValue,
        feerateSatVb,
        sendSompi,
        bitcoinCustomFeeSats,
      )
      if (summary == null) return null
      return (sendSompi + summary.feeSats) / 100_000_000
    }
    return totalSompi / 100_000_000
  }, [
    sendKAS,
    sendChain,
    bitcoinDisplayUnit,
    effectiveFeeSompi,
    networkFeeSompi,
    totalSelectedSompiValue,
    isBitcoinSend,
    spendUtxos,
    feerateSatVb,
    effectiveMaxSendSompi,
    bitcoinCustomFeeSats,
  ])

  const amountPlusFeeError = useMemo((): string | null => {
    if (feeLoadError && blocksSendContinuation(feeLoadError)) return feeLoadError
    if (balanceTooLowForFee) {
      const feeLabel = showSats
        ? `${Math.round(minNetworkFeeSompi).toLocaleString('en-US')} ${unit}`
        : `${(minNetworkFeeSompi / 100_000_000).toFixed(8)} ${unit}`
      return `Selected coins are too small for the network fee (~${feeLabel}). Add more funds or pick a larger coin.`
    }
    if (parsedSendKas == null) return null
    const sendSompi = parseDisplayToSompi(sendKAS, sendChain, bitcoinDisplayUnit) ?? 0
    if (sendSompi <= 0) return null
    if (isBitcoinSend) {
      const inputCount = Math.max(1, spendUtxos.length)
      const maxSweep = bitcoinMaxSendFromUtxos(spendUtxos, feerateSatVb).maxSompi
      if (bitcoinSweepOnlyWallet(totalSelectedSompiValue, inputCount, feerateSatVb) && sendSompi < maxSweep) {
        const maxLabel = showSats
          ? `${Math.round(maxSweep).toLocaleString('en-US')} ${unit}`
          : `${(maxSweep / 100_000_000).toFixed(8)} ${unit}`
        return `Balance is too small for a partial send — use Max (${maxLabel}) to sweep the whole coin`
      }
      const summary = bitcoinSendFeeSummary(
        spendUtxos,
        totalSelectedSompiValue,
        feerateSatVb,
        sendSompi,
        bitcoinCustomFeeSats,
      )
      if (summary == null && sendSompi > 0) {
        const maxLabel = showSats
          ? `${Math.round(effectiveMaxSendSompi).toLocaleString('en-US')} ${unit}`
          : `${maxSendableDisplay.toFixed(8)} ${unit}`
        return `Amount cannot be sent with these coins — max recipient is ${maxLabel}`
      }
    }
    if (sendSompi > effectiveMaxSendSompi) {
      const maxLabel = showSats
        ? `${Math.round(effectiveMaxSendSompi).toLocaleString('en-US')} ${unit}`
        : `${maxSendableDisplay.toFixed(8)} ${unit}`
      return `Amount exceeds max sendable — max recipient is ${maxLabel}`
    }
    return null
  }, [
    feeLoadError,
    balanceTooLowForFee,
    parsedSendKas,
    sendKAS,
    effectiveMaxSendSompi,
    maxSendableDisplay,
    showSats,
    unit,
    sendChain,
    bitcoinDisplayUnit,
    isBitcoinSend,
    minNetworkFeeSompi,
    totalSelectedSompiValue,
    spendUtxos,
    feerateSatVb,
    bitcoinCustomFeeSats,
  ])

  const payeeStepValid = useMemo(() => {
    if (!toAddress || balanceTooLowForFee || minNetworkFeeSompi <= 0) return false
    if (feeLoadError && blocksSendContinuation(feeLoadError)) return false
    if (parsedSendKas == null) return false
    const sendSompi = parseDisplayToSompi(sendKAS, sendChain, bitcoinDisplayUnit) ?? 0
    if (sendSompi <= 0) return false
    if (isBitcoinSend) {
      const summary = bitcoinSendFeeSummary(
        spendUtxos,
        totalSelectedSompiValue,
        feerateSatVb,
        sendSompi,
        bitcoinCustomFeeSats,
      )
      return summary != null
    }
    return sendSompi <= effectiveMaxSendSompi
  }, [
    toAddress,
    balanceTooLowForFee,
    minNetworkFeeSompi,
    feeLoadError,
    parsedSendKas,
    sendKAS,
    sendChain,
    bitcoinDisplayUnit,
    isBitcoinSend,
    totalSelectedSompiValue,
    effectiveMaxSendSompi,
    spendUtxos,
    feerateSatVb,
    bitcoinCustomFeeSats,
  ])

  const sendContinueHint = useMemo(() => {
    if (!toAddress.trim()) return 'Enter a recipient address to continue.'
    if (parsedSendKas == null || parsedSendKas <= 0) return 'Enter an amount to send.'
    if (balanceTooLowForFee) return 'Selected coins cannot cover the network fee.'
    if (feeLoadError && blocksSendContinuation(feeLoadError)) return feeLoadError
    return 'Check amount and fee, then try again.'
  }, [toAddress, parsedSendKas, balanceTooLowForFee, feeLoadError])

  const resetFeeState = useCallback((chain: typeof selectedChain) => {
    const defaultFee = chain === 'bitcoin' ? 141 : KASPA_TOCATTA_FALLBACK_RELAY_FEE_SOMPI
    networkFeeSompiRef.current = defaultFee
    setNetworkFeeSompi(defaultFee)
    setNetworkFeeKas(chain === 'bitcoin' ? 0.00000141 : defaultFee / 100_000_000)
    setFeerateSatVb(1)
    setBitcoinFeeTier('normal')
    setBitcoinFeerates(null)
    apiMaxSendSompiRef.current = null
    setApiMaxSendSompi(null)
    setFeeLoadError(null)
    setKaspaMass(null)
    setKaspaStorageMass(null)
    setKaspaExcessToMinerKas(null)
  }, [])

  const footerCanContinue = spendableUtxos.length > 0 && payeeStepValid

  const applyBitcoinFeeState = useCallback(
    (feeSats: number, maxSompi?: number | null) => {
      const fee = Math.max(1, Math.round(feeSats))
      if (fee !== networkFeeSompiRef.current) {
        networkFeeSompiRef.current = fee
        setNetworkFeeSompi(fee)
        setNetworkFeeKas(fee / 100_000_000)
      }
      if (maxSompi != null && maxSompi > 0 && maxSompi !== apiMaxSendSompiRef.current) {
        apiMaxSendSompiRef.current = maxSompi
        setApiMaxSendSompi(maxSompi)
      }
    },
    [],
  )

  const spendUtxosRef = useRef(spendUtxos)
  spendUtxosRef.current = spendUtxos

  const syncFiatFromCoinText = useCallback(
    (raw?: string) => {
      const kas = parseDisplayToCoinAmount(raw ?? sendKASRef.current, sendChain, bitcoinDisplayUnit)
      const price = fiatPriceService.price(sendChain, displayCurrency)
      if (kas == null || price == null || price <= 0) {
        setSendFiatText('')
        return
      }
      setSendFiatText(editableFiatText(kas * price, displayCurrency))
    },
    [sendChain, bitcoinDisplayUnit, displayCurrency],
  )

  const adjustSendSompiForFee = useCallback(
    (targetSompi: number, keepMaxIntent = false) => {
      if (targetSompi <= 0) return false
      const formatted = formatSompiForDisplay(targetSompi, sendChain, bitcoinDisplayUnit)
      suppressAmountSideEffects.current = true
      if (keepMaxIntent || amountEditSourceRef.current === 'max') {
        amountEditSourceRef.current = 'max'
        setAmountEditSource('max')
      }
      sendKASRef.current = formatted
      setSendKAS(formatted)
      syncFiatFromCoinText(formatted)
      window.setTimeout(() => {
        suppressAmountSideEffects.current = false
      }, 0)
      return true
    },
    [syncFiatFromCoinText, sendChain, bitcoinDisplayUnit],
  )

  const applyFeeEstimate = useCallback(
    (
      est: import('@renderer/api/types').FeeEstimateResponse,
      ctx?: { selectedSompi: number; inputCount: number },
    ) => {
      const minFee = isBitcoinSend ? 141 : 1
      const pool = spendUtxosRef.current
      const selectedSompi = ctx?.selectedSompi ?? totalSelectedSompi(pool)
      const inputCount = ctx?.inputCount ?? Math.max(1, pool.length)
      const rate = est.feerate_sat_vb ?? feerateSatVb
      let feeSompi = Math.max(Math.round(est.fee_sompi), minFee)
      if (isBitcoinSend) {
        feeSompi = capBitcoinFeeForCoins(
          feeSompi,
          selectedSompi > 0 ? selectedSompi : utxoAmountSompi(pool[0] ?? { amount: 0 }),
          inputCount,
          rate,
        )
      }
      applyBitcoinFeeState(feeSompi)
      let maxVal = est.max_send_sompi ?? est.spendable_sompi ?? null
      if (isBitcoinSend && selectedSompi > 0 && feeSompi < est.fee_sompi) {
        const local = bitcoinMaxSendFromUtxos(pool, rate)
        if (local.maxSompi > 0) maxVal = local.maxSompi
      }
      apiMaxSendSompiRef.current = maxVal
      setApiMaxSendSompi(maxVal)
      if (est.feerate_sat_vb != null && (!isBitcoinSend || feeMode !== 'network')) {
        setFeerateSatVb(est.feerate_sat_vb)
      }
      if (est.feerates) setBitcoinFeerates(est.feerates)
      setKaspaMass(est.mass ?? est.mass_grams ?? null)
      setKaspaStorageMass(est.storage_mass ?? null)
      if (est.maximum_standard_mass != null) setKaspaMaxMass(est.maximum_standard_mass)
      setKaspaExcessToMinerKas(est.excess_to_miner_kas ?? null)
      if (!isBitcoinSend && est.send_amount_valid === false) {
        const currentSend = parseSendSompi(sendKASRef.current) ?? 0
        const feeSompi = Math.max(Math.round(est.fee_sompi ?? est.network_fee_sompi ?? 0), 1)
        const adjustedSend =
          est.send_sompi != null && est.send_sompi > 0
            ? est.send_sompi
            : est.max_send_sompi != null && est.max_send_sompi > 0
              ? est.max_send_sompi
              : Math.max(0, selectedSompi - feeSompi)
        if (adjustedSend > 0 && currentSend > adjustedSend) {
          adjustSendSompiForFee(
            adjustedSend,
            amountEditSourceRef.current === 'max',
          )
          applyBitcoinFeeState(feeSompi, adjustedSend)
          apiMaxSendSompiRef.current = est.max_send_sompi ?? adjustedSend
          setApiMaxSendSompi(est.max_send_sompi ?? adjustedSend)
          setFeeLoadError(null)
          return
        }
      }
      if (est.send_amount_valid === false && est.send_block_reason) {
        setFeeLoadError(feeHint(est.send_block_reason))
      } else if (est.insufficient_funds) {
        if (selectedSompi > feeSompi) {
          const fallbackMax = est.max_send_sompi ?? Math.max(0, selectedSompi - feeSompi)
          apiMaxSendSompiRef.current = fallbackMax
          setApiMaxSendSompi(fallbackMax)
          if (!isBitcoinSend) {
            const currentSend = parseSendSompi(sendKASRef.current) ?? 0
            if (currentSend > fallbackMax && fallbackMax > 0) {
              adjustSendSompiForFee(
                fallbackMax,
                amountEditSourceRef.current === 'max',
              )
            }
          }
          setFeeLoadError(null)
        } else if (isBitcoinSend) {
          const local = bitcoinMaxSendFromUtxos(pool, rate)
          if (local.maxSompi > 0) {
            applyBitcoinFeeState(local.feeSats, local.maxSompi)
            setFeeLoadError(null)
          } else {
            apiMaxSendSompiRef.current = 0
            setApiMaxSendSompi(0)
            setFeeLoadError('Selected coins cannot cover the network fee')
          }
        } else {
          apiMaxSendSompiRef.current = 0
          setApiMaxSendSompi(0)
          setFeeLoadError('Selected coins cannot cover the network fee')
        }
      } else {
        setFeeLoadError(null)
      }
    },
    [isBitcoinSend, feerateSatVb, applyBitcoinFeeState, feeMode, adjustSendSompiForFee],
  )

  const applyLocalBitcoinFee = useCallback(
    (selected: UtxoDTO[], refineMax = false, sendSompi?: number | null): number | null => {
      const selectedSompi = totalSelectedSompi(selected)
      if (selectedSompi <= 0) return null
      const inputCount = Math.max(1, selected.length)
      const needsLocal = bitcoinNeedsLocalFeeEstimate(selectedSompi, inputCount, feerateSatVb)
      if (!refineMax && !needsLocal && (sendSompi == null || sendSompi <= 0)) return null

      if (sendSompi != null && sendSompi > 0) {
        const summary = bitcoinSendFeeSummary(selected, selectedSompi, feerateSatVb, sendSompi)
        if (summary) {
          applyBitcoinFeeState(summary.feeSats, summary.maxSompi)
          setFeeLoadError(null)
          return summary.maxSompi
        }
        return null
      }

      const local = bitcoinMaxSendFromUtxos(selected, feerateSatVb)
      if (local.maxSompi > 0) {
        applyBitcoinFeeState(local.feeSats, local.maxSompi)
        setFeeLoadError(null)
        return local.maxSompi
      }
      const feeSompi = affordableBitcoinFeeSats(selectedSompi, inputCount, feerateSatVb)
      applyBitcoinFeeState(feeSompi, Math.max(0, selectedSompi - feeSompi))
      setFeeLoadError(
        selectedSompi <= feeSompi ? 'Selected coins cannot cover the network fee' : null,
      )
      return Math.max(0, selectedSompi - feeSompi)
    },
    [feerateSatVb, applyBitcoinFeeState],
  )

  const loadNetworkFee = useCallback(
    async (refineMax = false): Promise<number | null> => {
      if (!api || !activeWalletId) return null
      if (isBitcoinSend && amountEditSourceRef.current === 'max' && !refineMax) {
        return applyLocalBitcoinFee(spendUtxosRef.current, true)
      }
      if (!isBitcoinSend && amountEditSourceRef.current === 'max' && !refineMax) {
        return apiMaxSendSompiRef.current
      }
      const generation = feeLoadGeneration.current + 1
      feeLoadGeneration.current = generation
      if (refineMax) setFeeEstimating(true)

      let selected: UtxoDTO[] = []
      try {
      selected = spendUtxosRef.current
      if (selected.length === 0) return null

      const selectedSompi = totalSelectedSompi(selected)
      const sompi = selectedSompi > 0 ? selectedSompi : utxoAmountSompi(selected[0]!)
      const inputCount = Math.max(1, selected.length)
      const bitcoinSendProbe =
        isBitcoinSend && !refineMax
          ? parseDisplayToSompi(sendKASRef.current, sendChain, bitcoinDisplayUnit)
          : null

      if (isBitcoinSend && feeMode === 'custom' && effectiveFeeSompi != null && effectiveFeeSompi > 0) {
        const summary = bitcoinSendFeeSummary(
          selected,
          selectedSompi,
          feerateSatVb,
          bitcoinSendProbe,
          effectiveFeeSompi,
        )
        if (summary) {
          applyBitcoinFeeState(summary.feeSats, summary.maxSompi)
          setFeeLoadError(null)
          return summary.maxSompi
        }
        setFeeLoadError('Selected coins cannot cover the custom network fee')
        return null
      }

      if (isBitcoinSend) {
        const localMax = applyLocalBitcoinFee(selected, refineMax, bitcoinSendProbe)
        if (localMax != null) return localMax
        if (bitcoinNeedsLocalFeeEstimate(selectedSompi, inputCount, feerateSatVb)) {
          const forced = applyLocalBitcoinFee(selected, true, bitcoinSendProbe)
          if (forced != null) return forced
          const sweep = bitcoinMaxSendFromUtxos(selected, feerateSatVb)
          applyBitcoinFeeState(sweep.feeSats, sweep.maxSompi > 0 ? sweep.maxSompi : null)
          return sweep.maxSompi > 0 ? sweep.maxSompi : null
        }
      }

      const kaspaSendProbe = !isBitcoinSend && !refineMax ? parseSendSompi(sendKASRef.current) : null
      const kaspaCustomFeeProbe =
        !isBitcoinSend && feeMode === 'custom' ? effectiveFeeSompi : null

      if (!isBitcoinSend && feeMode === 'custom' && kaspaCustomFeeProbe != null && kaspaCustomFeeProbe > 0) {
        const fee = Math.round(kaspaCustomFeeProbe)
        const minRelay = KASPA_TOCATTA_FALLBACK_RELAY_FEE_SOMPI
        if (fee < minRelay) {
          applyBitcoinFeeState(fee, null)
          setFeeLoadError(`Minimum Kaspa network fee is ${(minRelay / 100_000_000).toFixed(8)} KAS`)
          return null
        }
        const sendProbe = kaspaSendProbe ?? 0
        if (sendProbe > 0 && sendProbe + fee > selectedSompi) {
          const fallbackMax = Math.max(0, selectedSompi - fee)
          adjustSendSompiForFee(
            fallbackMax,
            amountEditSourceRef.current === 'max',
          )
          applyBitcoinFeeState(fee, fallbackMax > 0 ? fallbackMax : null)
          apiMaxSendSompiRef.current = fallbackMax
          setApiMaxSendSompi(fallbackMax)
          setFeeLoadError(null)
        }
      }

      const kaspaSendForApi = !isBitcoinSend
        ? refineMax
          ? undefined
          : parseSendSompi(sendKASRef.current) ?? undefined
        : undefined

      const bitcoinOutputCount =
        isBitcoinSend && selectedSompi > 0
          ? selectedSompi <= estimateBitcoinFeeSats(Math.max(1, selected.length), feerateSatVb, 2)
            ? 1
            : 2
          : 2

        const est = await api.feeEstimate({
          utxoAmountSompi: sompi,
          walletId: activeWalletId,
          coin: sendChain,
          inputCount: Math.max(1, selected.length),
          feerateSatVb: isBitcoinSend ? feerateSatVb : undefined,
          outputCount: isBitcoinSend ? bitcoinOutputCount : undefined,
          sendSompi: kaspaSendForApi ?? kaspaSendProbe ?? undefined,
          toAddress: toAddressRef.current.trim() || undefined,
          utxos: isBitcoinSend ? undefined : selected,
          refineMax: refineMax || undefined,
          requestedFeeSompi: kaspaCustomFeeProbe ?? undefined,
        })
        if (generation !== feeLoadGeneration.current) return null
        if (isBitcoinSend && est.insufficient_funds && selected.length > 0) {
          try {
            const retry = await api.feeEstimate({
              utxoAmountSompi: sompi,
              walletId: activeWalletId,
              coin: sendChain,
              inputCount: Math.max(1, selected.length),
              feerateSatVb,
              outputCount: 1,
            })
            if (generation === feeLoadGeneration.current && !retry.insufficient_funds) {
              applyFeeEstimate(retry, { selectedSompi, inputCount })
              return apiMaxSendSompiRef.current
            }
          } catch {
            /* use primary estimate */
          }
        }
        applyFeeEstimate(est, { selectedSompi, inputCount })
        return apiMaxSendSompiRef.current
      } catch (e) {
        if (generation !== feeLoadGeneration.current) return null
        if (isBitcoinSend && selected.length > 0) {
          const localMax = applyLocalBitcoinFee(selected, true)
          if (localMax != null) {
            setStatusMessage('Using local fee estimate while network syncs')
            return localMax
          }
        }
        const msg = e instanceof Error ? e.message : 'Fee estimate failed'
        setFeeLoadError(msg)
        resetFeeState(sendChain)
        apiMaxSendSompiRef.current = null
        setApiMaxSendSompi(null)
        setStatusMessage(msg)
        return null
      } finally {
        if (generation === feeLoadGeneration.current && refineMax) {
          setFeeEstimating(false)
        }
      }
    },
    [
      api,
      activeWalletId,
      showAdvancedCoinControl,
      sendUsesCustomCoinSelection,
      sendOpenedFromCoins,
      preserveSpendSelection,
      isBitcoinSend,
      feeMode,
      effectiveFeeSompi,
      feerateSatVb,
      sendChain,
      applyFeeEstimate,
      resetFeeState,
      setStatusMessage,
      applyLocalBitcoinFee,
      bitcoinDisplayUnit,
      adjustSendSompiForFee,
    ],
  )

  loadNetworkFeeRef.current = loadNetworkFee

  const kaspaMassDetailLine = useMemo(() => {
    if (isBitcoinSend || kaspaMass == null) return null
    if (kaspaStorageMass != null) {
      return `Transaction mass ${kaspaMass} · KIP-9 storage ${kaspaStorageMass} (limit ${kaspaMaxMass})`
    }
    return `Transaction mass ${kaspaMass} (limit ${kaspaMaxMass})`
  }, [isBitcoinSend, kaspaMass, kaspaStorageMass, kaspaMaxMass])

  const syncFiatFromCoin = useCallback(() => {
    syncFiatFromCoinText()
  }, [syncFiatFromCoinText])

  const scheduleLoadNetworkFee = useCallback((refineMax = false) => {
    if (suppressAmountSideEffects.current) return
    if (amountEditSourceRef.current === 'max' && !refineMax) return
    if (feeDebounceRef.current) clearTimeout(feeDebounceRef.current)
    const delay = refineMax ? 0 : 300
    feeDebounceRef.current = window.setTimeout(() => {
      feeDebounceRef.current = null
      void loadNetworkFeeRef.current(refineMax)
    }, delay)
  }, [])

  const handleSendKasChange = useCallback(
    (value: string) => {
      sendKASRef.current = value
      setSendKAS(value)
      if (step !== STEP_SEND || maxAmountRefining || suppressAmountSideEffects.current) return
      if (amountEditSource === 'fiat') {
        setAmountEditSource(null)
        scheduleLoadNetworkFee(false)
        return
      }
      if (amountEditSource === 'max') {
        setAmountEditSource(null)
      }
      setAmountEditSource('coin')
      syncFiatFromCoinText(value)
      scheduleLoadNetworkFee(false)
      void refreshFiatPrices().then(() => syncFiatFromCoinText(value))
    },
    [
      step,
      maxAmountRefining,
      amountEditSource,
      syncFiatFromCoinText,
      scheduleLoadNetworkFee,
      refreshFiatPrices,
    ],
  )

  const handleSendFiatChange = useCallback(
    (value: string) => {
      setSendFiatText(value)
      if (step !== STEP_SEND || maxAmountRefining || suppressAmountSideEffects.current) return
      if (amountEditSource === 'coin' || amountEditSource === 'max') {
        setAmountEditSource(null)
        return
      }
      setAmountEditSource('fiat')
      const raw = value.trim().replace(',', '.')
      if (!raw) return
      const fiat = Number(raw)
      const price = fiatPriceService.price(sendChain, displayCurrency)
      if (!Number.isFinite(fiat) || fiat <= 0 || price == null || price <= 0) return
      const nextSend = formatSompiForDisplay(
        Math.max(1, Math.round((fiat / price) * 100_000_000)),
        sendChain,
        bitcoinDisplayUnit,
      )
      sendKASRef.current = nextSend
      setSendKAS(nextSend)
      scheduleLoadNetworkFee(false)
    },
    [step, maxAmountRefining, amountEditSource, sendChain, displayCurrency, scheduleLoadNetworkFee, bitcoinDisplayUnit],
  )

  const applyMaxRecipientForCurrentFee = useCallback(
    (maxSompi?: number) => {
      const resolved = maxSompi ?? effectiveMaxSendSompi
      if (resolved <= 0) return
      const formatted = formatSompiForDisplay(resolved, sendChain, bitcoinDisplayUnit)
      amountEditSourceRef.current = 'max'
      setAmountEditSource('max')
      sendKASRef.current = formatted
      setSendKAS(formatted)
      syncFiatFromCoinText(formatted)
      setFeeLoadError(null)
    },
    [effectiveMaxSendSompi, syncFiatFromCoinText, sendChain, bitcoinDisplayUnit],
  )

  const applyMaxAmount = useCallback(async () => {
    suppressAmountSideEffects.current = true
    amountEditSourceRef.current = 'max'
    try {
      const pool = spendUtxosRef.current
      const totalSompi = totalSelectedSompi(pool)
      if (totalSompi <= 0) {
        setFeeLoadError('No spendable coins — refresh wallet and try again')
        return
      }

      if (isBitcoinSend) {
        setMaxAmountRefining(true)
        const customSats =
          feeMode === 'custom' && effectiveFeeSompi != null && effectiveFeeSompi > 0
            ? effectiveFeeSompi
            : null
        if (customSats != null) {
          const maxSompi = Math.max(0, totalSompi - customSats)
          applyBitcoinFeeState(customSats, maxSompi > 0 ? maxSompi : null)
          if (maxSompi <= 0) {
            setFeeLoadError('Selected coins cannot cover the custom network fee')
            return
          }
          applyMaxRecipientForCurrentFee(maxSompi)
          setFeeLoadError(null)
          return
        }
        const result = bitcoinMaxSendFromUtxos(pool, feerateSatVb)
        applyBitcoinFeeState(result.feeSats, result.maxSompi > 0 ? result.maxSompi : null)
        if (result.maxSompi <= 0) {
          setFeeLoadError('Selected coins cannot cover the network fee')
          return
        }
        applyMaxRecipientForCurrentFee(result.maxSompi)
        setFeeLoadError(null)
        return
      }

      if (feeDebounceRef.current) {
        clearTimeout(feeDebounceRef.current)
        feeDebounceRef.current = null
      }
      feeLoadGeneration.current += 1
      setMaxAmountRefining(true)
      setAmountEditSource('max')

      // Custom fee Max = balance − fee (same as serious wallets / coordinators).
      if (feeMode === 'custom' && effectiveFeeSompi != null && effectiveFeeSompi > 0) {
        const localMax = Math.max(0, totalSompi - Math.round(effectiveFeeSompi))
        applyBitcoinFeeState(Math.round(effectiveFeeSompi), localMax > 0 ? localMax : null)
        apiMaxSendSompiRef.current = localMax
        setApiMaxSendSompi(localMax)
        if (localMax <= 0) {
          setFeeLoadError('Selected coins cannot cover the custom network fee')
          return
        }
        applyMaxRecipientForCurrentFee(localMax)
        setFeeLoadError(null)
        // Background refine — keep arithmetic max unless API reports a hard failure.
        if (api && activeWalletId) {
          void loadNetworkFee(true).then((refined) => {
            if (refined != null && refined > 0 && amountEditSourceRef.current === 'max') {
              const fee = Math.round(effectiveFeeSompi)
              const arithmetic = Math.max(0, totalSelectedSompi(spendUtxosRef.current) - fee)
              const next = Math.max(refined, arithmetic)
              if (next !== parseSendSompi(sendKASRef.current)) {
                applyMaxRecipientForCurrentFee(next)
              }
            }
          })
        }
        return
      }

      if (!api || !activeWalletId) {
        setFeeLoadError('Fee estimate unavailable — try again')
        return
      }
      const refined = await loadNetworkFee(true)
      if (refined != null && refined > 0) {
        applyMaxRecipientForCurrentFee(refined)
        setFeeLoadError(null)
      } else if (apiMaxSendSompiRef.current == null || apiMaxSendSompiRef.current <= 0) {
        setFeeLoadError('Selected coins cannot cover the network fee')
      }
    } catch (e) {
      setFeeLoadError(e instanceof Error ? e.message : 'Max amount failed')
    } finally {
      setMaxAmountRefining(false)
      suppressAmountSideEffects.current = false
    }
  }, [
    preserveSpendSelection,
    isBitcoinSend,
    feerateSatVb,
    loadNetworkFee,
    applyMaxRecipientForCurrentFee,
    api,
    activeWalletId,
    applyBitcoinFeeState,
    feeMode,
    effectiveFeeSompi,
  ])

  const spendableUtxosRef = useRef(spendableUtxos)
  spendableUtxosRef.current = spendableUtxos

  const hardwareKind = (activeWallet?.hardware || '').trim().toLowerCase()
  const isLedgerWallet = hardwareKind === 'ledger'
  const isOneKeyWallet = hardwareKind === 'onekey'
  const isUsbHardwareWallet = isLedgerWallet || isOneKeyWallet
  const usbHardwareLabel = isOneKeyWallet ? 'OneKey' : 'Ledger'

  const applyBuildResponse = useCallback(
    (res: import('@renderer/api/types').BuildTxResponse, density: QRDisplayDensity) => {
      setDraftId(res.draft_id)
      setLedgerUnsigned(res.unsigned ?? null)
      const built = summaryFromResponse(res.summary)
      if (built && (!built.usedUtxoKeys?.length)) {
        const fromUnsigned = usedKeysFromUnsigned(res.unsigned)
        if (fromUnsigned?.length) built.usedUtxoKeys = fromUnsigned
      }
      setBuildSummary(built)
      let reviewCoins = reviewCoinsForSidebar(built, spendableUtxosRef.current, res.unsigned)
      // Bitcoin drafts historically omitted outpoint keys — fall back to the spend pool used to build.
      if (reviewCoins.length === 0 && isBitcoinSend && spendUtxosRef.current.length > 0) {
        reviewCoins = spendUtxosRef.current
      }
      setReviewInputUtxos(reviewCoins)
      if (built?.feeSompi != null && built.feeSompi > 0) {
        applyBitcoinFeeState(built.feeSompi)
      }
      const actualDensity: QRDisplayDensity = res.qr_display_mode === 'static' ? 'static' : 'animated'
      setQrDensity(actualDensity)
      qrDensityRef.current = actualDensity
      setQrFrameMs(res.qr_frame_ms ?? 480)
      if (res.qr_display_pixels && res.qr_display_pixels > 0) {
        setQrDisplaySize(Math.min(560, Math.max(420, res.qr_display_pixels)))
      }
      setQrModulesPerFrame(res.qr_modules_per_frame ?? null)
      const frames = decodeQrImages(res)
      setQrFrames(frames)

      const sigLoaded = Math.max(0, Number(res.signatures_loaded ?? 0))
      const sigRequired = Math.max(0, Number(res.signatures_required ?? 0))
      const signingComplete = Boolean(res.signing_complete)

      if (signingComplete) {
        setSignedBroadcastReady(true)
        setSignatureProgressCount(sigRequired > 0 ? sigRequired : Math.max(1, sigLoaded))
        const ready = (res.ready ?? res.signed) as Record<string, unknown> | undefined
        if (ready && typeof ready === 'object') {
          setSignedJSON(JSON.stringify(ready))
        }
        setSignedValidationMessage(res.message || 'Fully signed — ready to broadcast')
        setBuildError(null)
        setStatusMessage(res.message || 'Fully signed transaction loaded — tap Broadcast when ready')
      } else {
        setSignedBroadcastReady(false)
        setSignedJSON('')
        setSignatureProgressCount(sigLoaded)
        setSignedValidationMessage(
          sigLoaded > 0
            ? res.message || `Partial signatures loaded (${sigLoaded}/${sigRequired || '?'}). Sign next cosigner on SeedMask.`
            : null,
        )
        if (frames.length === 0) {
          setBuildError('Backend returned no QR image data')
        } else if (actualDensity === 'static' && (res.qr_fountain || frames.length > 1)) {
          setBuildError('Static mode failed — backend returned multipart. Restart the coordinator backend and try again.')
        } else {
          setBuildError(null)
        }
        const isStaticQr = actualDensity === 'static' && frames.length === 1 && !res.qr_fountain
        setQrAutoPlaying(actualDensity === 'animated' && frames.length > 1)
        const hw = (activeWallet?.hardware || '').trim().toLowerCase()
        const usbHw = hw === 'ledger' || hw === 'onekey'
        const usbLabel = hw === 'onekey' ? 'OneKey' : 'Ledger'
        setStatusMessage(
          res.message
            ? res.message
            : usbHw
              ? `Transaction ready — sign with ${usbLabel}`
              : isStaticQr
                ? 'Dense QR ready — tap for full screen, then scan on SeedMask'
                : frames.length > 1
                  ? 'Animated QR ready — scan on SeedMask'
                  : 'QR ready — scan on SeedMask',
        )
      }
      if (res.draft_id) {
        try {
          localStorage.setItem(LAST_DRAFT_ID_KEY, res.draft_id)
        } catch {
          /* ignore storage errors */
        }
      }
    },
    [setStatusMessage, applyBitcoinFeeState, isBitcoinSend, activeWallet?.hardware],
  )

  const buildTransaction = useCallback(
    async (density: QRDisplayDensity, allowAnimatedFallback = true): Promise<boolean> => {
      if (!api || !activeWalletId) return false
      setBusy(true)
      setBuildError(null)
      setQrFrames([])
      const qrDisplayMode: QRDisplayDensity =
        !isBitcoinSend && !explicitDenseQrRef.current ? 'animated' : density
      try {
        setStatusMessage('Building unsigned transaction…')
        const feeSompi =
          feeMode === 'custom'
            ? (effectiveFeeSompi ?? networkFeeSompiRef.current)
            : networkFeeSompiRef.current
        if (feeSompi == null || feeSompi <= 0) {
          setBuildError('Invalid fee')
          return false
        }
        const sendSompi = isBitcoinSend
          ? parseDisplayToSompi(sendKASRef.current, sendChain, bitcoinDisplayUnit)
          : parseSendSompi(sendKASRef.current)
        if (sendSompi == null || sendSompi <= 0) {
          setBuildError('Invalid amount')
          setStatusMessage('Invalid amount')
          return false
        }
        const pool = spendUtxosRef.current
        const keys = pool.map((u) => u.key).filter((k) => k.length > 0)
        if (keys.length === 0) {
          setBuildError('Select a coin')
          return false
        }
        const res = await api.buildTx({
          utxoKeys: keys,
          toAddress,
          sendKas: 0,
          feeSompi,
          walletId: activeWalletId,
          qrDisplayMode,
          rbf: isBitcoinSend && enableRbf,
          useGenerator: !isBitcoinSend,
          utxos: pool,
          sendSompi,
          customFee: !isBitcoinSend && feeMode === 'custom',
        })
        applyBuildResponse(res, qrDisplayMode)
        return true
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Build failed'
        const staticTooLarge = /too large for static|static qr needs/i.test(msg.toLowerCase())
        if (allowAnimatedFallback && staticTooLarge && qrDisplayMode !== 'animated') {
          explicitDenseQrRef.current = false
          setQrDensity('animated')
          qrDensityRef.current = 'animated'
          setStatusMessage('Transaction too large for dense QR — using animated QR…')
          setBusy(false)
          return buildTransactionRef.current('animated', false)
        }
        setBuildError(msg)
        setStatusMessage(msg)
        reviewBuildStartedRef.current = 0
        return false
      } finally {
        setBusy(false)
      }
    },
    [
      api,
      activeWalletId,
      feeMode,
      effectiveFeeSompi,
      isBitcoinSend,
      sendChain,
      bitcoinDisplayUnit,
      orderedSelectedSpendUtxos,
      spendUtxos,
      toAddress,
      isBitcoinSend,
      enableRbf,
      applyBuildResponse,
      setStatusMessage,
    ],
  )

  buildTransactionRef.current = buildTransaction
  qrDensityRef.current = qrDensity

  const applySignedPayload = useCallback(
    async (payload: string) => {
      const trimmed = payload.trim()
      if (!trimmed) return
      if (!draftId) {
        const msg =
          'Build or load an unsigned transaction on the Send screen first, then load the signed transaction from SeedMask.'
        setBuildError(msg)
        setSignedValidationMessage(msg)
        setSignedBroadcastReady(false)
        setSignatureProgressCount(0)
        setStatusMessage(msg)
        return
      }
      setBusy(true)
      setSignedBroadcastReady(false)
      setSignatureProgressCount(0)
      setSignedValidationMessage(null)
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>
        if (isBitcoinSignedPsbt(obj)) {
          const b64 = String(obj.psbt_base64 ?? '').trim()
          if (!b64) throw new Error('Signed PSBT is missing psbt_base64')
        } else if (!isSignedKaspaTransaction(obj)) {
          throw new Error('Not a signed Kaspa transaction')
        }
        const res = await api!.finishTx(draftId, trimmed, 0)
        if (res.complete === false) {
          const msg = res.message || 'Partial signature saved — load the next cosigner signature'
          setSignedBroadcastReady(false)
          setSignatureProgressCount(Math.max(0, Number(res.signatures_loaded ?? 0)))
          setSignedValidationMessage(msg)
          setBuildError(null)
          setStatusMessage(msg)
          if (signedJSON !== trimmed) setSignedJSON('')
          return
        }
        setSignedBroadcastReady(true)
        setSignatureProgressCount(0)
        setSignedValidationMessage('Signed transaction matches — ready to broadcast')
        setBuildError(null)
        setStatusMessage('Signed transaction verified — tap Broadcast')
        const ready = res.ready
        if (ready && typeof ready === 'object') {
          if (typeof ready.psbt_base64 === 'string' && ready.psbt_base64.trim()) {
            setSignedJSON(JSON.stringify({ format: 'bitcoin_psbt', psbt_base64: ready.psbt_base64 }))
          } else if (Array.isArray(ready.inputs)) {
            setSignedJSON(JSON.stringify(ready))
          } else if (signedJSON !== trimmed) {
            setSignedJSON(trimmed)
          }
        } else if (signedJSON !== trimmed) {
          setSignedJSON(trimmed)
        }
      } catch (e) {
        if (signedJSON !== trimmed) setSignedJSON(trimmed)
        setSignedBroadcastReady(false)
        setSignatureProgressCount(0)
        const msg = e instanceof APIError ? apiError(e.status ?? 400, e.message) : e instanceof Error ? e.message : 'Invalid signed JSON'
        setSignedValidationMessage(msg)
        setBuildError(msg)
        setStatusMessage(msg)
      } finally {
        setBusy(false)
      }
    },
    [api, draftId, signedJSON, setStatusMessage],
  )

  const signWithUsbHardware = useCallback(
    async (link: 'usb' | 'ble' = hwSignLink) => {
      const label = isOneKeyWallet ? 'OneKey' : 'Ledger'
      if (!draftId) {
        setBuildError(`Build the transaction first, then sign with ${label}.`)
        return
      }
      if (isBitcoinSend && isLedgerWallet && !window.seedmask?.signLedgerBitcoin) {
        setBuildError('Ledger Bitcoin signing is unavailable in this build.')
        return
      }
      if (isOneKeyWallet && isBitcoinSend && !window.seedmask?.signOneKeyBitcoin) {
        setBuildError('OneKey Bitcoin signing is unavailable in this build.')
        return
      }
      if (isOneKeyWallet && !isBitcoinSend && !window.seedmask?.signOneKeyKaspa) {
        setBuildError('OneKey signing is unavailable in this build.')
        return
      }
      if (isLedgerWallet && !isBitcoinSend && !window.seedmask?.signLedgerKaspa) {
        setBuildError('Ledger signing is unavailable in this build.')
        return
      }
      setHwSignLink(link)
      setLedgerSigning(true)
      setBusy(true)
      setBuildError(null)
      setSignedValidationMessage(null)
      try {
        setStatusMessage(
          link === 'ble'
            ? `Sign on your ${label} over Bluetooth…`
            : `Sign the transaction on your ${label}…`,
        )
        let res: { ok: boolean; result?: unknown; error?: string }
        if (isBitcoinSend && (isOneKeyWallet || isLedgerWallet)) {
          if (!api || !activeWalletId) throw new Error(`Could not load PSBT for ${label}`)
          const exported = await api.draftExport(draftId, activeWalletId)
          const psbtBase64 = String(exported.psbt_base64 ?? '').trim()
          if (!psbtBase64) throw new Error(`Could not load unsigned PSBT for ${label}`)
          const scriptRaw = (activeWallet?.script_type || '').trim().toLowerCase()
          const scriptType =
            scriptRaw === 'nested_segwit' || scriptRaw === 'legacy' || scriptRaw === 'taproot'
              ? (scriptRaw as 'nested_segwit' | 'legacy' | 'taproot')
              : 'native_segwit'
          if (isOneKeyWallet) {
            res = await window.seedmask.signOneKeyBitcoin({
              psbtBase64,
              kpub: activeWallet?.kpub?.trim() || undefined,
              scriptType,
              link,
            })
          } else {
            const cosigners = (activeWallet?.multisig_cosigners || [])
              .filter((c) => !!c?.xpub?.trim())
              .map((c) => ({
                xpub: c.xpub.trim(),
                fingerprint: c.fingerprint || undefined,
                derivation: c.derivation || activeWallet?.derivation || undefined,
                label: c.label || undefined,
              }))
            const multisig =
              (activeWallet?.multisig_m ?? 0) > 0 && cosigners.length >= 2
                ? {
                    required: activeWallet!.multisig_m!,
                    total: activeWallet!.multisig_n || cosigners.length,
                    cosigners,
                  }
                : undefined
            res = await window.seedmask.signLedgerBitcoin({
              psbtBase64,
              kpub: activeWallet?.kpub?.trim() || undefined,
              scriptType,
              derivation: activeWallet?.derivation || undefined,
              fingerprint: activeWallet?.fingerprint || undefined,
              multisig,
              link,
            })
          }
        } else {
          let unsigned = ledgerUnsigned
          if (!unsigned && api && activeWalletId) {
            const exported = await api.draftExport(draftId, activeWalletId)
            unsigned = exported.unsigned
            setLedgerUnsigned(unsigned ?? null)
          }
          if (!unsigned) throw new Error(`Could not load unsigned transaction for ${label}`)
          if (
            isOneKeyWallet &&
            typeof unsigned === 'object' &&
            unsigned &&
            !(unsigned as { kpub?: string }).kpub?.trim() &&
            activeWallet?.kpub?.trim()
          ) {
            ;(unsigned as { kpub?: string }).kpub = activeWallet.kpub.trim()
          }
          res = isOneKeyWallet
            ? await window.seedmask.signOneKeyKaspa({ unsigned, link })
            : await window.seedmask.signLedgerKaspa({ unsigned, link })
        }
        if (!res.ok || !res.result) {
          const err = res.error || `${label} signing failed`
          if (/^cancelled$/i.test(err)) {
            setBuildError(null)
            setStatusMessage('Signing cancelled — tap Sign again to retry')
            return
          }
          throw new Error(err)
        }
        const payload = JSON.stringify(res.result)
        setSignedJSON(payload)
        await applySignedPayload(payload)
        setStatusMessage(`Signed with ${label} — ready to broadcast`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : `${label} signing failed`
        if (/^cancelled$/i.test(msg)) {
          setBuildError(null)
          setStatusMessage('Signing cancelled — tap Sign again to retry')
        } else {
          setBuildError(msg)
          setStatusMessage(msg)
        }
      } finally {
        setLedgerSigning(false)
        setBusy(false)
      }
    },
    [
      draftId,
      ledgerUnsigned,
      api,
      activeWalletId,
      applySignedPayload,
      setStatusMessage,
      isOneKeyWallet,
      isLedgerWallet,
      isBitcoinSend,
      hwSignLink,
      activeWallet?.kpub,
      activeWallet?.script_type,
      activeWallet?.derivation,
      activeWallet?.fingerprint,
      activeWallet?.multisig_m,
      activeWallet?.multisig_n,
      activeWallet?.multisig_cosigners,
    ],
  )

  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const broadcastCloseTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (broadcastCloseTimerRef.current != null) {
        window.clearTimeout(broadcastCloseTimerRef.current)
        broadcastCloseTimerRef.current = null
      }
    }
  }, [])

  const broadcast = useCallback(async () => {
    if (!api || !draftId || !signedJSON.trim()) return
    setBusy(true)
    try {
      setStatusMessage('Broadcasting…')
      const res = await api.broadcast(draftId, signedJSON, 0)
      const txid = res.transaction_id ?? res.transaction_ids?.[0] ?? ''
      setBroadcastTxid(txid || 'ok')
      setBroadcastTxids([])
      setStatusMessage(txid ? `Sent ${txid}` : 'Broadcast complete')
      if (txid) {
        notePendingSend({
          transaction_id: txid,
          amount_kas: buildSummary?.sendKas,
          counterparty: buildSummary?.toAddress ?? toAddress,
          fee_sompi: buildSummary?.feeSompi,
        })
      }
      // Auto-return to dashboard after a brief Done flash (do not tie this to
      // parent re-renders during history refresh — that was resetting the timer).
      if (broadcastCloseTimerRef.current != null) {
        window.clearTimeout(broadcastCloseTimerRef.current)
      }
      broadcastCloseTimerRef.current = window.setTimeout(() => {
        broadcastCloseTimerRef.current = null
        onCloseRef.current()
      }, 1000)
      await refreshAfterSuccessfulSend()
    } catch (e) {
      const msg = e instanceof APIError ? apiError(e.status ?? 400, e.message) : e instanceof Error ? e.message : 'Broadcast failed'
      setBuildError(msg)
      setStatusMessage(msg)
    } finally {
      setBusy(false)
    }
  }, [api, draftId, signedJSON, setStatusMessage, refreshAfterSuccessfulSend, notePendingSend, buildSummary, toAddress])

  const broadcastDone = Boolean(broadcastTxid || broadcastTxids.length > 0)

  const advanceToReview = useCallback((preview?: BuildSummary | null) => {
    setBuildSummary(preview ?? null)
    setReviewInputUtxos([])
    setQrFrames([])
    setBuildError(null)
    setSignedJSON('')
    setSignedBroadcastReady(false)
    setSignatureProgressCount(0)
    setSignedValidationMessage(null)
    setQrDensity('animated')
    qrDensityRef.current = 'animated'
    explicitDenseQrRef.current = false
    setQrAutoPlaying(true)
    reviewBuildStartedRef.current = 0
    setReviewBuildKey((k) => k + 1)
    setStep(STEP_REVIEW)
  }, [])

  const validateAndContinue = useCallback(async () => {
    setAddressError(null)
    if (!payeeStepValid) {
      setAddressError(sendContinueHint)
      setStatusMessage(sendContinueHint)
      return
    }
    if (!api) return

    let normalized = toAddress.trim()
    if (isBitcoinSend) {
      if (!looksLikeBitcoinAddress(normalized)) {
        setAddressError('Enter a valid Bitcoin mainnet address (bc1…, 1…, or 3…)')
        return
      }
      setToAddress(normalized)
      setAddressError(null)
      setFeeLoadError(null)
      const sendSompi = parseDisplayToSompi(sendKASRef.current, sendChain, bitcoinDisplayUnit)
      if (sendSompi == null || sendSompi <= 0) {
        setStatusMessage('Enter a valid amount')
        return
      }
      if (networkFeeSompiRef.current <= 0) {
        void loadNetworkFee(false).then(() => {
          if (networkFeeSompiRef.current <= 0) {
            setFeeLoadError('Could not estimate network fee')
            return
          }
          advanceToReview()
        })
        return
      }
      advanceToReview()
      return
    }

    normalized = normalizeKaspaAddress(normalized)
    if (!isLikelyValidKaspaAddress(normalized)) {
      setAddressError('Enter a valid Kaspa address (kaspa:…)')
      return
    }

    setToAddress(normalized)
    setAddressError(null)
    setFeeLoadError(null)
    const sendSompi = parseSendSompi(sendKASRef.current)
    if (sendSompi == null || sendSompi <= 0) {
      setStatusMessage('Enter a valid amount')
      return
    }
    if (feeDebounceRef.current) {
      clearTimeout(feeDebounceRef.current)
      feeDebounceRef.current = null
    }
    // Use the debounced fee already shown on Send; Review builds asynchronously.
    if (networkFeeSompiRef.current <= 0) {
      void loadNetworkFee(false)
    }
    const feeSompi = feeMode === 'custom'
      ? (effectiveFeeSompi ?? networkFeeSompiRef.current)
      : networkFeeSompiRef.current
    advanceToReview({
      toAddress: normalized,
      sendSompi,
      sendKas: sendSompi / 100_000_000,
      feeSompi: feeSompi > 0 ? feeSompi : undefined,
    })
  }, [
    payeeStepValid,
    sendContinueHint,
    api,
    toAddress,
    selectedChain,
    isBitcoinSend,
    sendChain,
    bitcoinDisplayUnit,
    loadNetworkFee,
    advanceToReview,
    setStatusMessage,
    feeMode,
    effectiveFeeSompi,
  ])

  const toggleQrDensity = useCallback(() => {
    const newValue: QRDisplayDensity = qrDensity === 'animated' ? 'static' : 'animated'
    explicitDenseQrRef.current = newValue === 'static'
    setQrDensity(newValue)
    setDensityLabelFlash(qrDensityLabel(newValue))
    densityFlashGeneration.current += 1
    const gen = densityFlashGeneration.current
    setTimeout(() => {
      if (densityFlashGeneration.current === gen) setDensityLabelFlash(null)
    }, 1500)
    if (step === STEP_REVIEW && buildSummary && !busy) {
      // Loaded handoff drafts often have empty Send form fields — don't rebuild from form.
      if (!toAddressRef.current.trim() || !sendKASRef.current.trim()) {
        setStatusMessage(
          newValue === 'static'
            ? 'Dense QR mode selected — rebuild from Send if frames look wrong'
            : 'Animated QR mode selected — rebuild from Send if frames look wrong',
        )
        return
      }
      reviewBuildStartedRef.current = 0
      void buildTransaction(newValue)
    }
  }, [qrDensity, step, buildSummary, busy, buildTransaction, setStatusMessage])

  const resetFlow = useCallback(() => {
    setStep(STEP_SEND)
    setShowAdvancedCoinControl(false)
    setShowAdvancedFees(false)
    setBroadcastTxid(null)
    setBroadcastTxids([])
    setSignedJSON('')
    setSignedBroadcastReady(false)
    setSignatureProgressCount(0)
    setSignedValidationMessage(null)
    setQrFrames([])
    setQrModulesPerFrame(null)
    setQrDisplaySize(440)
    setBuildSummary(null)
    setBuildError(null)
    setShowScanner(false)
    setDraftId('')
    setQrDensity('animated')
    qrDensityRef.current = 'animated'
    explicitDenseQrRef.current = false
    setQrAutoPlaying(true)
    ensureWalletCoinsSelected()
  }, [selectAllSpendableUtxos, ensureWalletCoinsSelected])

  const saveUnsignedTransaction = useCallback(async () => {
    if (!api || !draftId || !activeWalletId) {
      setStatusMessage('Build or load a transaction first')
      return
    }
    const sigNeedFromWallet =
      (activeWallet?.multisig_m ?? 0) > 0 ? Math.max(1, activeWallet?.multisig_m ?? 1) : 1
    try {
      const exportRes = await api.draftExport(draftId, activeWalletId)
      if (isBitcoinSend) {
        const b64 = exportRes.psbt_base64?.trim()
        if (!b64) {
          setStatusMessage('Could not read PSBT — rebuild the transaction')
          return
        }
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        const saved = await saveFileWithDialog(bytes, 'btc-tx.psbt', 'application/octet-stream')
        const sigLoaded = Math.max(
          signatureProgressCount,
          Number(exportRes.signatures_loaded ?? 0),
        )
        const sigNeed = Math.max(sigNeedFromWallet, Number(exportRes.signatures_required ?? 0), 1)
        const partial = sigLoaded > 0 && sigLoaded < sigNeed && !exportRes.signing_complete
        setStatusMessage(
          saved
            ? partial
              ? `Partial PSBT saved (${sigLoaded}/${sigNeed})`
              : 'PSBT saved'
            : 'Save cancelled',
        )
        return
      }
      const unsigned = exportRes.unsigned as Record<string, unknown>
      if (unsigned.kpub == null && activeWallet?.kpub?.trim()) {
        unsigned.kpub = activeWallet.kpub.trim()
      }
      if (!unsigned.kpub) {
        setStatusMessage('Cannot save — rebuild tx (wallet kpub missing)')
        return
      }
      // Prefer full draft envelope so the next cosigner can Load transaction with partials.
      if (exportRes.pskt_hex || exportRes.pskt || exportRes.format === 'seedpass_pskt_draft_v1') {
        const sigLoaded = Math.max(
          signatureProgressCount,
          Number(exportRes.signatures_loaded ?? 0),
        )
        const sigNeed = Math.max(sigNeedFromWallet, Number(exportRes.signatures_required ?? 0), 1)
        const envelope: Record<string, unknown> = {
          format: 'seedpass_pskt_draft_v1',
          unsigned,
          pskt: exportRes.pskt,
          pskt_hex: exportRes.pskt_hex,
          pskb_hex: exportRes.pskb_hex,
          pskt_count: exportRes.pskt_count,
          signatures_loaded: sigLoaded,
          signatures_required: sigNeed,
          draft_id: draftId,
        }
        if (buildSummary) {
          envelope.summary = {
            to_address: buildSummary.toAddress,
            send_kas: buildSummary.sendKas,
            fee_sompi: buildSummary.feeSompi,
            from_address: buildSummary.fromAddress,
            input_count: buildSummary.inputCount,
          }
        }
        const data = exportKaspaHandoffDraft(envelope)
        const saved = await saveFileWithDialog(data, 'seedmask-tx.json', 'application/json')
        const partial = sigLoaded > 0 && sigLoaded < sigNeed
        setStatusMessage(
          saved
            ? partial
              ? `Partial transaction saved (${sigLoaded}/${sigNeed})`
              : 'Transaction saved'
            : 'Save cancelled',
        )
        return
      }
      const data = exportDeviceV2(unsigned)
      const saved = await saveFileWithDialog(data, 'seedmask-unsigned-tx.json', 'application/json')
      setStatusMessage(saved ? 'Transaction saved' : 'Save cancelled')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Save failed'
      setBuildError(msg)
      setStatusMessage(msg)
    }
  }, [
    api,
    draftId,
    activeWalletId,
    isBitcoinSend,
    activeWallet,
    setStatusMessage,
    signatureProgressCount,
    buildSummary,
  ])

  const loadTransactionDraftFromFile = useCallback(
    async (file: File) => {
      if (!api) return
      const buf = await file.arrayBuffer()
      const bytes = new Uint8Array(buf)
      setBusy(true)
      setBuildError(null)
      try {
        const kind = isPsbtBinary(bytes) ? 'psbt' : kaspaTransactionKind(bytes)
        setStatusMessage(
          kind === 'signed'
            ? 'Loading signed transaction…'
            : kind === 'partial'
              ? 'Loading partial transaction…'
              : 'Loading transaction…',
        )
        // Prevent Review auto-rebuild + draft-invalidation from wiping imported QR.
        skipReviewAutoBuildRef.current = true
        suppressDraftInvalidationRef.current = true
        if (reviewBuildKey === 0) {
          setReviewBuildKey(1)
          reviewBuildStartedRef.current = 1
        } else {
          reviewBuildStartedRef.current = reviewBuildKey
        }
        const res = await api.importTxFile(buf, qrDensity)
        applyBuildResponse(res, qrDensity)
        setStep(STEP_REVIEW)
        // Keep suppression until after fee/summary state commits.
        window.setTimeout(() => {
          suppressDraftInvalidationRef.current = false
        }, 500)
        if (!res.signing_complete && !res.message) {
          setStatusMessage('Transaction loaded — sign on SeedMask, then load the signed transaction')
        }
      } catch (e) {
        skipReviewAutoBuildRef.current = false
        suppressDraftInvalidationRef.current = false
        const msg = e instanceof Error ? e.message : 'Load failed'
        setBuildError(msg)
        setStatusMessage(msg)
      } finally {
        setBusy(false)
      }
    },
    [api, qrDensity, applyBuildResponse, setStatusMessage, reviewBuildKey],
  )

  const loadSignedTransactionFromFile = useCallback(
    async (file: File) => {
      if (!draftId) {
        setStatusMessage('Load the transaction first (or build the send in this wizard)')
        return
      }
      try {
        const buf = await file.arrayBuffer()
        const json = signedJSONString(new Uint8Array(buf))
        setSignedJSON(json)
        await applySignedPayload(json)
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not read signed transaction file'
        setBuildError(msg)
        setStatusMessage(msg)
      }
    },
    [draftId, applySignedPayload, setStatusMessage],
  )

  useEffect(() => {
    resetFeeState(selectedChain)
    setShowAdvancedCoinControl(sendUsesCustomCoinSelection || sendOpenedFromCoins)
    void loadNetworkFee()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- mount only

  useEffect(() => {
    if (prevChainRef.current === selectedChain) return
    prevChainRef.current = selectedChain
    setToAddress('')
    setSendKAS('')
    setSendFiatText('')
    setAddressError(null)
    clearSpendSelection()
    setShowAdvancedCoinControl(false)
    setShowAdvancedFees(false)
    setStep(STEP_SEND)
    resetFeeState(selectedChain)
    ensureWalletCoinsSelected()
    void loadNetworkFee()
  }, [selectedChain]) // eslint-disable-line react-hooks/exhaustive-deps -- chain switch

  useEffect(() => {
    pruneSpendSelection()
    ensureWalletCoinsSelected()
    if (step === STEP_SEND) scheduleLoadNetworkFee(false)
  }, [utxos.length]) // eslint-disable-line react-hooks/exhaustive-deps -- Swift: onChange(utxos.count)

  useEffect(() => {
    if (showAdvancedCoinControl) {
      setSendUsesCustomCoinSelection(true)
    } else if (!sendOpenedFromCoins) {
      setSendUsesCustomCoinSelection(false)
    }
  }, [showAdvancedCoinControl, sendOpenedFromCoins, setSendUsesCustomCoinSelection])

  useEffect(() => {
    if (step === STEP_SEND) {
      if (!preserveSpendSelection) {
        ensureWalletCoinsSelected()
      }
      void refreshFiatPrices().then(() => {
        syncFiatFromCoinText()
        void loadNetworkFeeRef.current(false)
      })
    }
  }, [step]) // eslint-disable-line react-hooks/exhaustive-deps -- step transitions

  useEffect(() => {
    if (feeMode === 'custom' && !customFeeKAS.trim()) {
      setCustomFeeKAS(networkFeeKas.toFixed(8))
      return
    }
    if (step !== STEP_SEND) return
    if (feeMode === 'network') {
      scheduleLoadNetworkFee(amountEditSourceRef.current === 'max')
      return
    }
    scheduleLoadNetworkFee(amountEditSourceRef.current === 'max')
  }, [feeMode]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isBitcoinSend || feeMode !== 'network') return
    setFeerateSatVb(bitcoinTierRates[bitcoinFeeTier])
  }, [isBitcoinSend, feeMode, bitcoinFeeTier, bitcoinTierRates])

  useEffect(() => {
    if (step !== STEP_SEND || !isBitcoinSend || feeMode !== 'network') return
    const keepMax = amountEditSourceRef.current === 'max'
    scheduleLoadNetworkFee(keepMax)
    if (keepMax) {
      const pool = spendUtxosRef.current
      const totalSompi = totalSelectedSompi(pool)
      if (totalSompi > 0) {
        const result = bitcoinMaxSendFromUtxos(pool, feerateSatVb)
        if (result.maxSompi > 0) {
          applyBitcoinFeeState(result.feeSats, result.maxSompi)
          applyMaxRecipientForCurrentFee(result.maxSompi)
        }
      }
    }
  }, [feerateSatVb, step, isBitcoinSend, feeMode, scheduleLoadNetworkFee, applyBitcoinFeeState, applyMaxRecipientForCurrentFee])

  useEffect(() => {
    if (step !== STEP_SEND || amountEditSource === 'fiat') return
    syncFiatFromCoinText()
  }, [displayCurrency, fiatTick]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (step !== STEP_SEND) return
    scheduleLoadNetworkFee(false)
  }, [selectedSpendUtxoKeys, step, scheduleLoadNetworkFee])

  useEffect(() => {
    if (step !== STEP_SEND || isBitcoinSend) return
    const sendSompi = parseSendSompi(sendKAS)
    if (sendSompi == null || sendSompi <= 0) return
    scheduleLoadNetworkFee(false)
  }, [sendKAS, step, isBitcoinSend, scheduleLoadNetworkFee])

  useEffect(() => {
    if (step !== STEP_SEND || !toAddress.trim()) return
    scheduleLoadNetworkFee(false)
  }, [toAddress, step, scheduleLoadNetworkFee])

  useEffect(() => {
    if (step !== STEP_SEND || feeMode !== 'custom') return
    const keepMax = amountEditSource === 'max' || amountEditSourceRef.current === 'max'
    if (keepMax && effectiveFeeSompi != null && effectiveFeeSompi > 0) {
      const totalSompi = totalSelectedSompi(spendUtxosRef.current)
      const localMax = Math.max(0, totalSompi - Math.round(effectiveFeeSompi))
      applyBitcoinFeeState(Math.round(effectiveFeeSompi), localMax > 0 ? localMax : null)
      apiMaxSendSompiRef.current = localMax
      setApiMaxSendSompi(localMax)
      if (localMax > 0) {
        applyMaxRecipientForCurrentFee(localMax)
      }
    }
    scheduleLoadNetworkFee(keepMax)
  }, [
    customFeeKAS,
    feeMode,
    step,
    amountEditSource,
    effectiveFeeSompi,
    scheduleLoadNetworkFee,
    applyBitcoinFeeState,
    applyMaxRecipientForCurrentFee,
  ])

  // Swift reviewStep `.task`: build once when review appears (always animated for Kaspa).
  useEffect(() => {
    if (step !== STEP_REVIEW || reviewBuildKey === 0) return
    if (skipReviewAutoBuildRef.current) {
      skipReviewAutoBuildRef.current = false
      reviewBuildStartedRef.current = reviewBuildKey
      return
    }
    if (reviewBuildStartedRef.current === reviewBuildKey) return
    if (broadcastTxid || broadcastTxids.length > 0) return
    reviewBuildStartedRef.current = reviewBuildKey
    explicitDenseQrRef.current = false
    setQrDensity('animated')
    qrDensityRef.current = 'animated'
    void buildTransactionRef.current('animated')
  }, [step, reviewBuildKey, broadcastTxid, broadcastTxids.length])

  useEffect(() => {
    return () => {
      if (feeDebounceRef.current) clearTimeout(feeDebounceRef.current)
    }
  }, [])

  useEffect(() => {
    const el = layoutRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrowLayout(el.clientWidth < 1060))
    ro.observe(el)
    setNarrowLayout(el.clientWidth < 1060)
    return () => ro.disconnect()
  }, [])

  const requiredSignatureCount =
    (activeWallet?.multisig_m ?? 0) > 0
      ? Math.max(1, activeWallet?.multisig_m ?? 1)
      : 1
  const loadedSignatureCount = signedBroadcastReady
    ? requiredSignatureCount
    : Math.min(requiredSignatureCount, Math.max(0, signatureProgressCount))

  const reviewFooterTitle = busy ? 'Building…' : 'Broadcast'
  // Only light up after a fully verified / fully signed payload — never for partial or invalid loads.
  const reviewFooterEnabled = !busy && signedBroadcastReady
  const reviewFooterAction = async (): Promise<void> => {
    if (!signedBroadcastReady) return
    await broadcast()
  }

  const sidebarCoins = reviewInputUtxos.length > 0
    ? reviewInputUtxos
    : reviewCoinsForSidebar(buildSummary, spendableUtxos)
  const showCoinsSidebar =
    showAdvancedCoinControl ||
    sidebarCoins.length > 0 ||
    (step === STEP_REVIEW && !broadcastTxid && broadcastTxids.length === 0)

  if (!activeWallet) return <p className="muted">No active wallet.</p>

  return (
    <div className="send-wizard" ref={layoutRef}>
      {!broadcastDone && (
      <div className="send-wizard-top">
        <button type="button" className="send-wizard-back" onClick={onClose}>
          <ChevronLeftIcon />
          Dashboard
        </button>
        <div className="send-wizard-steps">
          {STEP_TITLES.map((title, i) => (
            <StepDot key={title} index={i} current={step} title={title} />
          ))}
        </div>
      </div>
      )}

      {broadcastDone ? (
        <div className="send-review-scroll">
          <div className="card">{renderReviewStep()}</div>
        </div>
      ) : step === STEP_SEND ? (
        <div className="send-step-scroll">
          {spendableUtxos.length === 0 ? (
            <EmptyStateView
              icon={<span aria-hidden style={{ fontSize: 44, opacity: 0.7 }}>!</span>}
              title="No funds to send"
              message={`Refresh the wallet after you receive ${unit}.`}
              action={
                <button type="button" className="btn btn-primary" onClick={onClose}>
                  Back to dashboard
                </button>
              }
            />
          ) : (
            <div className={`send-step-layout${narrowLayout ? ' narrow' : ''}`}>
              <div className="send-form-col">
                <div className="card send-form-card">{renderSendForm()}</div>
              </div>
              <div className="send-checkout-sidebar card">{renderCheckoutSidebar()}</div>
            </div>
          )}
        </div>
      ) : (
        <div className="send-review-scroll">
          <div className="card">{renderReviewStep()}</div>
        </div>
      )}

      {!broadcastDone && (
      <div className="send-wizard-footer">
        {step > 0 && (
          <button type="button" className="btn btn-ghost" onClick={() => setStep(STEP_SEND)}>
            Back
          </button>
        )}
        <div style={{ flex: 1 }} />
        {step >= STEP_REVIEW ? (
          <button
            type="button"
            className="btn btn-primary send-footer-primary"
            disabled={!reviewFooterEnabled || busy}
            onClick={() => void reviewFooterAction()}
          >
            {reviewFooterTitle}
          </button>
        ) : null}
      </div>
      )}

      {denseQrFullscreen && qrFrames[0] && (
        <DenseQRFullscreen image={qrFrames[0]} onClose={() => setDenseQrFullscreen(false)} />
      )}
      {showPayeeScanner && (
        <QRScannerSheet
          title="Scan recipient address"
          hint="Point your camera at a Kaspa or Bitcoin address QR code."
          onScan={(payload) => {
            setShowPayeeScanner(false)
            setToAddress(payload.trim())
            setAddressError(null)
          }}
          onCancel={() => setShowPayeeScanner(false)}
        />
      )}
      {showScanner && api && (
        <SignedQRScanner
          api={api}
          onComplete={(payload) => {
            setShowScanner(false)
            setSignedJSON(payload)
            void applySignedPayload(payload)
          }}
          onCancel={() => setShowScanner(false)}
        />
      )}
      {showTransactionVisualize && buildSummary && api && (
        <TransactionVisualizeView
          draftId={draftId}
          walletId={activeWalletId}
          chain={selectedChain}
          displayCurrency={displayCurrency}
          bitcoinDisplayUnit={bitcoinDisplayUnit}
          api={api}
          fallbackSummary={buildSummary}
          fallbackInputs={sidebarCoins}
          recipientAddress={buildSummary.toAddress ?? toAddress}
          onDismiss={() => setShowTransactionVisualize(false)}
        />
      )}

      <input
        ref={loadDraftInputRef}
        type="file"
        hidden
        accept=".json,.psbt,application/json"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void loadTransactionDraftFromFile(f)
          e.target.value = ''
        }}
      />
      <input
        ref={loadSignedInputRef}
        type="file"
        hidden
        accept=".json,.psbt,application/json"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void loadSignedTransactionFromFile(f)
          e.target.value = ''
        }}
      />
    </div>
  )

  function renderSendForm(): React.JSX.Element {
    const payeePlaceholder = isBitcoinSend ? 'bc1… or 1… or 3…' : 'kaspa:qq… (full mainnet address)'
    const fiatPlaceholder = displayCurrency === 'JPY' ? '0' : '0.00'

    return (
      <>
        <div className="send-balance-hero">
          <h3 className="send-balance-title">
            <span>Wallet</span> <span className="send-balance-title-accent">Balance</span>
          </h3>
          <div className="send-balance-row">
            <span className="send-balance-amt">{totalSelectedKas.toFixed(8)}</span>
            <span className="send-balance-unit">{unit}</span>
            {selectedBalanceFiatText && <span className="send-balance-fiat">{selectedBalanceFiatText}</span>}
          </div>
          <p className="muted send-balance-subtitle">{payeeSelectedBalanceSubtitle()}</p>
        </div>

        <h3 className="section-title send-payto-title">Pay to</h3>
        <label className="field-label">Recipient address</label>
        <div className="field-with-trailing">
          <input
            className="seed-mask-field mono-field"
            value={toAddress}
            onChange={(e) => {
              setToAddress(e.target.value)
              setAddressError(null)
            }}
            placeholder={payeePlaceholder}
          />
          <button
            type="button"
            className="field-trailing-btn"
            title="Scan recipient address QR"
            onClick={() => setShowPayeeScanner(true)}
          >
            <QRViewfinderIcon />
          </button>
        </div>
        {(payeeReceiveChoices.length > 0 || otherSameChainWallets.length > 0) && (
          <RecipientSelfMenu
            ownAddresses={payeeReceiveChoices}
            otherWallets={otherSameChainWallets}
            onSelectAddress={(address) => {
              setToAddress(address)
              setAddressError(null)
            }}
            resolveWalletAddress={async (walletId) => {
              if (!api) return ''
              try {
                const book = await api.addressBook(walletId, false)
                const next = (book.next_receive_address || '').trim()
                if (next) return next
                const first = book.receive?.[0]?.address?.trim()
                if (first) return first
              } catch {
                /* fall through */
              }
              const addrs = (await api.addresses(walletId)).addresses
              return (addrs[0]?.address || '').trim()
            }}
          />
        )}
        <p className="muted send-address-hint">
          {isBitcoinSend
            ? 'Paste a Bitcoin mainnet address, or choose one of your wallets above.'
            : 'Paste a full kaspa:… address, or choose one of your wallets above.'}
        </p>
        {addressError && <p style={{ color: 'var(--danger)' }}>{addressError}</p>}

        <div className="row spread" style={{ marginTop: 20 }}>
          <label className="field-label" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            Recipient receives
          </label>
          <button
            type="button"
            className="send-max-btn"
            disabled={maxAmountRefining}
            onClick={() => void applyMaxAmount()}
          >
            {maxAmountRefining ? 'Max…' : 'Max'}
          </button>
        </div>
        <div className="send-amount-fields">
          <SeedMaskUnitField
            placeholder="0.00000000"
            value={sendKAS}
            onChange={handleSendKasChange}
            unit={unit}
          />
          <SeedMaskFiatField
            placeholder={fiatPlaceholder}
            value={sendFiatText}
            onChange={handleSendFiatChange}
            displayCurrency={displayCurrency}
            onCurrencyChange={setDisplayCurrency}
          />
        </div>

        <div style={{ marginTop: 20 }}>
          <div className="row spread">
            <span className="field-label" style={{ margin: 0, fontWeight: 600 }}>
              Network fee
              {!isBitcoinSend && (
                <span title={SEND_HELP_NETWORK_FEE} style={{ marginLeft: 4, cursor: 'help' }}>
                  ⓘ
                </span>
              )}
            </span>
            <div className="fee-mode-toggle">
              <button
                type="button"
                className={`fee-mode-btn${feeMode === 'network' ? ' active' : ''}`}
                onClick={() => setFeeMode('network')}
              >
                Network
              </button>
              <button
                type="button"
                className={`fee-mode-btn${feeMode === 'custom' ? ' active' : ''}`}
                onClick={() => {
                  setFeeMode('custom')
                  if (!customFeeKAS.trim()) setCustomFeeKAS(networkFeeKas.toFixed(8))
                }}
              >
                Custom
              </button>
            </div>
          </div>
          {feeMode === 'custom' && (
            <div style={{ maxWidth: 280, marginTop: 8 }}>
              <SeedMaskUnitField
                placeholder="0.00000000"
                value={customFeeKAS}
                onChange={setCustomFeeKAS}
                unit={unit}
              />
            </div>
          )}
          {isBitcoinSend && feeMode === 'network' && (
            <>
              <div className="bitcoin-fee-tiers" style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                {(['slow', 'normal', 'priority'] as const).map((tier) => {
                  const rate = bitcoinTierRates[tier]
                  const inputCount = Math.max(1, spendUtxos.length)
                  const estSats = affordableBitcoinFeeSats(
                    totalSelectedSompiValue,
                    inputCount,
                    rate,
                  )
                  return (
                    <button
                      key={tier}
                      type="button"
                      className={`fee-mode-btn${bitcoinFeeTier === tier ? ' active' : ''}`}
                      style={{
                        flex: 1,
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 2,
                        padding: '8px 6px',
                      }}
                      onClick={() => setBitcoinFeeTier(tier)}
                    >
                      <span>{tier === 'slow' ? 'Slow' : tier === 'normal' ? 'Normal' : 'Priority'}</span>
                      <span className="muted" style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
                        ~{formatBitcoinFeerate(rate)} sat/vB
                      </span>
                      <span className="muted" style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
                        ~{estSats} sats
                      </span>
                    </button>
                  )
                })}
              </div>
              <div className="bitcoin-fee-tier-eta">
                <span>Usually confirms in {bitcoinFeeTierEta(bitcoinFeeTier)}</span>
              </div>
            </>
          )}
          {feeLoadError && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{feeLoadError}</p>}
          {displayedNetworkFeeKas != null && (
            <div className="send-form-info-row" style={{ marginTop: 8 }}>
              <div className="send-form-info-row-body">
                <span className="send-form-info-row-value">
                  {showSats
                    ? formatSompiLabel(
                        feeMode === 'custom' && effectiveFeeSompi != null
                          ? effectiveFeeSompi
                          : networkFeeSompi,
                        sendChain,
                        bitcoinDisplayUnit,
                      )
                    : formatCoinUnitsLabel(displayedNetworkFeeKas ?? 0, sendChain, bitcoinDisplayUnit)}
                </span>
                {!isBitcoinSend && feeMode === 'network' && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    Depends on inputs, change, and transaction mass
                  </span>
                )}
                {coinFiatLine(displayedNetworkFeeKas) && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {coinFiatLine(displayedNetworkFeeKas)}
                  </span>
                )}
              </div>
            </div>
          )}
          {isBitcoinSend && (
            <div className="settings-toggle-row send-rbf-toggle" style={{ marginTop: 10, marginBottom: 0 }}>
              <span style={{ fontSize: 14 }}>Replace-by-fee (RBF)</span>
              <input
                type="checkbox"
                className="settings-switch"
                checked={enableRbf}
                onChange={(e) => setEnableRbf(e.target.checked)}
              />
            </div>
          )}
        </div>

        {amountPlusFeeError && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{amountPlusFeeError}</p>}

        <details
          className="send-disclosure"
          style={{ marginTop: 16 }}
          open={showAdvancedFees}
          onToggle={(e) => setShowAdvancedFees(e.currentTarget.open)}
        >
          <summary className="send-disclosure-summary">
            <span>Advanced options</span>
            <span className="send-disclosure-chevron" aria-hidden />
          </summary>
          <div className="send-disclosure-body">
            {!isBitcoinSend && kaspaMassDetailLine && (
              <div className="send-kaspa-mass-card">
                <strong>Transaction mass & KIP-9</strong>
                <div style={{ fontFamily: 'ui-monospace, monospace' }}>{kaspaMassDetailLine}</div>
              </div>
            )}
            <details
              className="send-disclosure send-disclosure-nested"
              open={showAdvancedCoinControl}
              onToggle={(e) => {
                setShowAdvancedCoinControl(e.currentTarget.open)
              }}
            >
              <summary className="send-disclosure-summary">
                <span>Choose coins to spend</span>
                <span className="send-disclosure-chevron" aria-hidden />
              </summary>
              <div className="send-disclosure-body">
                <CoinGroupPicker
                  groups={spendableAddressGroups}
                  selectedKeys={selectedSpendUtxoKeys}
                  chain={selectedChain}
                  onSelectAll={() => {
                    setSendUsesCustomCoinSelection(false)
                    selectAllSpendableUtxos()
                    void loadNetworkFee()
                  }}
                  onClear={() => {
                    setSendUsesCustomCoinSelection(true)
                    clearSpendSelection()
                  }}
                  onToggleGroup={(group) => {
                    setSendUsesCustomCoinSelection(true)
                    const fullySelected = group.keys.every((k) => selectedSpendUtxoKeys.has(k))
                    if (fullySelected) group.keys.forEach((k) => toggleSpendUtxo(k))
                    else group.keys.forEach((k) => {
                      if (!selectedSpendUtxoKeys.has(k)) toggleSpendUtxo(k)
                    })
                    void loadNetworkFee()
                  }}
                />
              </div>
            </details>
            <div className="send-load-tx">
              <button
                type="button"
                className="send-load-tx-btn"
                disabled={busy}
                onClick={() => loadDraftInputRef.current?.click()}
              >
                Load transaction
              </button>
              <p className="muted send-load-tx-hint">
                Load an unsigned, partial, or fully signed PSBT/PSKT file. Next cosigner uses this too.
              </p>
            </div>
          </div>
        </details>
      </>
    )
  }

  function renderCheckoutSidebar(): React.JSX.Element {
    return (
      <>
        <h4 style={{ margin: '0 0 4px' }}>Total</h4>
        <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
          Including fee
        </p>
        {totalIncludingFeeKas != null ? (
          <>
            <div className="send-balance-row">
              <span style={{ fontSize: 24, fontWeight: 600 }}>{totalIncludingFeeKas.toFixed(8)}</span>
              <span className="send-balance-unit">{unit}</span>
            </div>
            {coinFiatLine(totalIncludingFeeKas) && (
              <p className="muted">{coinFiatLine(totalIncludingFeeKas)}</p>
            )}
          </>
        ) : (
          <p className="muted">—</p>
        )}
        {!footerCanContinue && !busy && !validatingPayee && (
          <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
            {sendContinueHint}
          </p>
        )}
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: 16, width: '100%' }}
          disabled={!footerCanContinue || busy || validatingPayee}
          onClick={() => void validateAndContinue()}
        >
          {validatingPayee ? 'Checking…' : 'Review & sign'}
        </button>
      </>
    )
  }

  function renderReviewStep(): React.JSX.Element {
    if (broadcastTxid || broadcastTxids.length > 0) {
      return (
        <div className="send-broadcast-done" role="status" aria-live="polite">
          <div className="send-broadcast-done-check" aria-hidden>
            ✓
          </div>
          <h3 className="send-broadcast-done-title">Done</h3>
        </div>
      )
    }

    return (
      <>
        <h2 className="send-review-heading">Review & sign</h2>
        <div className={`send-review-layout${showCoinsSidebar ? ' with-sidebar' : ''}`}>
        {showCoinsSidebar && (
          <aside className="send-review-coins card">
            {busy ? (
              <>
                <h4>Coins to sign</h4>
                <p className="muted">Building transaction…</p>
              </>
            ) : sidebarCoins.length === 0 ? (
              <>
                <h4>Coins to sign</h4>
                <p className="muted">
                  {buildError
                    ? 'Could not determine UTXOs for this transaction.'
                    : buildSummary?.inputCount
                      ? `${buildSummary.inputCount} UTXO${buildSummary.inputCount === 1 ? '' : 's'} in this transaction.`
                      : 'Waiting for transaction details…'}
                </p>
              </>
            ) : (
              <SelectedCoinsPanel
                coins={sidebarCoins}
                unitSymbol={unit}
                walletUtxos={showAdvancedCoinControl ? undefined : spendableUtxos}
                title="Coins to sign"
                subtitle={reviewCoinsSidebarSubtitle(
                  buildSummary,
                  sidebarCoins.length,
                  orderedSelectedUtxos.length,
                  showAdvancedCoinControl,
                )}
              />
            )}
          </aside>
        )}
        <div className="send-review-main">
          {renderReviewSummary()}
          {busy && (
            <p className="muted">
              {ledgerSigning
                ? `Waiting for ${usbHardwareLabel}…`
                : isUsbHardwareWallet
                  ? `Preparing transaction for ${usbHardwareLabel}…`
                  : 'Preparing transaction for SeedMask…'}
            </p>
          )}
          {buildError && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{buildError}</p>}
          {isUsbHardwareWallet && draftId && !signedBroadcastReady ? (
            <div className="ledger-sign-panel" style={{ marginTop: 16 }}>
              <div className="hw-sign-actions">
                <div className="hw-sign-title-block">
                  <h4 style={{ margin: 0 }}>Sign with {usbHardwareLabel}</h4>
                  <p className="muted" style={{ margin: '6px 0 0' }}>
                    {isOneKeyWallet
                      ? isBitcoinSend
                        ? 'Choose USB or Bluetooth, unlock your OneKey, then confirm the Bitcoin PSBT on the device. Close the OneKey App / Bridge.'
                        : 'Choose USB or Bluetooth, unlock your OneKey, then confirm on the device. Close the OneKey App / Bridge.'
                      : isBitcoinSend
                        ? 'Choose USB or Bluetooth, unlock your Ledger, open the Bitcoin app, then confirm the PSBT on the device. Close Ledger Live.'
                        : 'Choose USB or Bluetooth, unlock your Ledger, open the Kaspa app, then confirm on the device.'}
                  </p>
                </div>
                <div className="hw-connect-link-btns" role="group" aria-label="Connection type">
                  <button
                    type="button"
                    className={`hw-connect-link-btn hw-link-usb${hwSignLink === 'usb' ? ' is-selected' : ''}`}
                    disabled={
                      busy ||
                      ledgerSigning ||
                      !(ledgerUnsigned || (isBitcoinSend && (isOneKeyWallet || isLedgerWallet) && draftId))
                    }
                    title="Sign via USB"
                    aria-label={`Sign with ${usbHardwareLabel} via USB`}
                    aria-pressed={hwSignLink === 'usb'}
                    onClick={() => {
                      setHwSignLink('usb')
                      void signWithUsbHardware('usb')
                    }}
                  >
                    <UsbIcon size={22} />
                  </button>
                  <button
                    type="button"
                    className={`hw-connect-link-btn hw-link-bluetooth${hwSignLink === 'ble' ? ' is-selected' : ''}`}
                    disabled={
                      busy ||
                      ledgerSigning ||
                      !(ledgerUnsigned || (isBitcoinSend && (isOneKeyWallet || isLedgerWallet) && draftId))
                    }
                    title="Sign via Bluetooth"
                    aria-label={`Sign with ${usbHardwareLabel} via Bluetooth`}
                    aria-pressed={hwSignLink === 'ble'}
                    onClick={() => {
                      setHwSignLink('ble')
                      void signWithUsbHardware('ble')
                    }}
                  >
                    <BluetoothIcon size={22} />
                  </button>
                </div>
              </div>
              {ledgerSigning ? (
                <p className="muted" style={{ margin: '10px 0 0' }}>
                  Signing on {usbHardwareLabel}…
                </p>
              ) : null}
            </div>
          ) : null}
          {!isUsbHardwareWallet && qrFrames.length > 0 && !signedBroadcastReady ? (
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <h4>Scan on SeedMask</h4>
              <AnimatedQRView
                frames={qrFrames}
                frameIntervalMs={qrFrameMs}
                maxDisplaySize={qrDisplaySize}
                isStatic={qrDensity === 'static' || qrFrames.length <= 1}
                allowDenseFullscreen
                isPlaying={qrAutoPlaying}
                onPlayingChange={setQrAutoPlaying}
                onDenseFullscreen={() => setDenseQrFullscreen(true)}
                footer={
                  <QrTransportControls
                    qrDensity={qrDensity}
                    densityLabelFlash={densityLabelFlash}
                    frameCount={qrFrames.length}
                    isPlaying={qrAutoPlaying}
                    onTogglePlaying={() => setQrAutoPlaying((p) => !p)}
                    onToggleDensity={toggleQrDensity}
                  />
                }
              />
            </div>
          ) : !isUsbHardwareWallet && signedBroadcastReady && buildSummary && !busy ? (
            <p className="muted" style={{ marginTop: 16, fontSize: 13 }}>
              Fully signed — tap <strong>Broadcast</strong> when you are ready.
            </p>
          ) : !isUsbHardwareWallet && buildSummary && !busy && !buildError && !signedBroadcastReady ? (
            <p style={{ color: 'var(--danger)', fontSize: 13 }}>
              QR could not be rendered — tap Back and try again.
            </p>
          ) : null}

          {renderSignPanel()}
        </div>
      </div>
      </>
    )
  }

  function renderReviewSummary(): React.JSX.Element | null {
    if (!buildSummary) return null
    const s = buildSummary
    const totalFeeSompi = reviewTotalFeeSompi(s)
    const feeKas = totalFeeSompi / 100_000_000
    const spentAddressTotalKas = reviewAddressInputTotalKas(
      s,
      sidebarCoins,
      spendableUtxos,
      totalSelectedKas,
    )
    const actualInputKas = reviewInputTotalKas(s, totalSelectedKas)
    const remainder = reviewWalletRemainderNote(s, totalSelectedKas, unit)

    return (
      <div className="send-review-summary">
        {!showAdvancedCoinControl && (buildSummary?.inputCount ?? sidebarCoins.length) <= 1 && (
          <p style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 14 }}>
            {isUsbHardwareWallet
              ? `Confirm once on ${usbHardwareLabel}, then broadcast here`
              : 'Sign once on SeedMask, then load the signed transaction here'}
          </p>
        )}
        <div className="row spread send-review-heading-row">
          <strong>What you&apos;re sending</strong>
          <button
            type="button"
            className="btn btn-ghost send-review-visualize-btn"
            onClick={() => setShowTransactionVisualize(true)}
          >
            Visualize
          </button>
        </div>
        <InfoRow title="To" value={s.toAddress ?? toAddress} mono />
        {s.sendKas != null && s.sendKas > 0 && (
          <InfoRow title="Recipient receives" value={formatCoinUnitsLabel(s.sendKas ?? 0, sendChain, bitcoinDisplayUnit)} fiat={coinFiatLine(s.sendKas)} />
        )}
        {totalFeeSompi > 0 && (
          <InfoRow
            title={reviewFeeTitle(s, feeMode, totalFeeSompi)}
            value={formatCoinUnitsLabel(feeKas, sendChain, bitcoinDisplayUnit)}
            fiat={coinFiatLine(feeKas)}
            note={reviewFeeNote(s, totalFeeSompi, unit) ?? undefined}
            highFeeBadge={
              sendChain === 'kaspa' &&
              isKaspaHighFee(totalFeeSompi, Math.round((s.sendKas ?? 0) * 100_000_000))
                ? kaspaHighFeeReason(totalFeeSompi, Math.round((s.sendKas ?? 0) * 100_000_000))
                : null
            }
          />
        )}
        {s.excessToMinerSompi != null &&
          s.excessToMinerSompi > 0 &&
          (reviewChangeKas(s) ?? 0) <= 0 &&
          feeMode === 'network' && (
            <InfoRow
              title="Extra to miners"
              value={formatCoinUnitsLabel(s.excessToMinerSompi / 100_000_000, sendChain, bitcoinDisplayUnit)}
              fiat={coinFiatLine(s.excessToMinerSompi / 100_000_000)}
              note="Leftover from this send — not returned as change."
            />
          )}
        {reviewChangeKas(s) != null && reviewChangeKas(s)! > 0 && (
          <>
            <InfoRow
              title="Returned to you"
              value={formatCoinUnitsLabel(reviewChangeKas(s)!, sendChain, bitcoinDisplayUnit)}
              fiat={coinFiatLine(reviewChangeKas(s)!)}
              note={s.changeAddressIndex != null ? `Change address #${s.changeAddressIndex}` : undefined}
            />
            {s.changeAddress && <InfoRow title="Return address" value={s.changeAddress} mono />}
          </>
        )}
        {(actualInputKas > 0 || spentAddressTotalKas > 0) && (
          <InfoRow
            title="Total amount"
            value={formatCoinUnitsLabel(
              actualInputKas > 0 ? actualInputKas : spentAddressTotalKas,
              sendChain,
              bitcoinDisplayUnit,
            )}
            fiat={coinFiatLine(actualInputKas > 0 ? actualInputKas : spentAddressTotalKas)}
          />
        )}
        {remainder && (
          <div className="send-friendly-note">
            <span aria-hidden>ⓘ</span>
            <span>{remainder}</span>
          </div>
        )}
        {showAdvancedCoinControl && buildSummary && (
          <>
            {buildSummary.fromAddress && <InfoRow title="From" value={buildSummary.fromAddress} mono />}
            {buildSummary.mass != null && <InfoRow title="Transaction mass" value={String(buildSummary.mass)} />}
            {buildSummary.storageMass != null && (
              <InfoRow title="Storage mass" value={String(buildSummary.storageMass)} />
            )}
            {buildSummary.rbf === true && <InfoRow title="RBF" value="Enabled" />}
            {buildSummary.inputCount != null && buildSummary.inputCount > 1 && (
              <InfoRow title="Inputs" value={String(buildSummary.inputCount)} />
            )}
          </>
        )}
      </div>
    )
  }

  function renderSignPanel(): React.JSX.Element {
    if (isUsbHardwareWallet) {
      return (
        <div className="send-sign-panel">
          <div className="send-sign-header">
            <div className="send-sign-title-block">
              <h4>Signatures</h4>
              <p className="muted">
                {signedBroadcastReady
                  ? `${usbHardwareLabel} signature loaded — ready to broadcast`
                  : `Sign on ${usbHardwareLabel} above`}
              </p>
            </div>
          </div>
          {signedValidationMessage && (
            <p style={{ color: signedBroadcastReady ? 'var(--success)' : 'var(--danger)', fontSize: 13 }}>
              {signedValidationMessage}
            </p>
          )}
        </div>
      )
    }
    const signatureLabel = `${requiredSignatureCount} signature${requiredSignatureCount === 1 ? '' : 's'} needed`
    return (
      <div className="send-sign-panel">
        <div className="send-sign-header">
          <div className="send-sign-title-block">
            <h4>Signatures</h4>
            <p className="muted">{signatureLabel}</p>
            <div className="send-sign-rectangles" aria-label={`${loadedSignatureCount} of ${requiredSignatureCount} signatures loaded`}>
              {Array.from({ length: requiredSignatureCount }, (_, i) => {
                const filled = i < loadedSignatureCount
                return (
                  <span
                    key={i}
                    className={`send-sign-rectangle${filled ? ' filled' : ''}`}
                    title={`Signature ${i + 1}${filled ? ' loaded' : ' needed'}`}
                  />
                )
              })}
            </div>
          </div>
        </div>
        {draftId === '' && (
          <p className="muted" style={{ fontSize: 12 }}>
            Load the unsigned transaction first, then load or scan the signed transaction from SeedMask.
          </p>
        )}
        <div className="send-sign-actions">
          <button
            type="button"
            className="btn btn-ghost btn-compact send-sign-scan-btn"
            disabled={!draftId}
            onClick={() => setShowScanner(true)}
          >
            Scan signed QR
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-compact send-sign-scan-btn"
            disabled={!draftId}
            onClick={() => loadSignedInputRef.current?.click()}
          >
            Load signed transaction
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-compact send-sign-scan-btn"
            disabled={!buildSummary || busy}
            onClick={() => void saveUnsignedTransaction()}
          >
            Save transaction
          </button>
        </div>
        <details open={pasteOpen} onToggle={(e) => setPasteOpen(e.currentTarget.open)} style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>Or paste signed JSON</summary>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ marginTop: 8 }}
            disabled={!draftId}
            onClick={() => {
              void readFromClipboard().then((text) => {
                if (!text) return
                setSignedJSON(text)
                void applySignedPayload(text)
              })
            }}
          >
            Paste from clipboard
          </button>
          <textarea
            className="field-input"
            rows={4}
            style={{ marginTop: 8, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
            value={signedJSON}
            onChange={(e) => {
              setSignedJSON(e.target.value)
              setSignedBroadcastReady(false)
            }}
          />
          {signedJSON.trim() && !signedBroadcastReady && (
            <button
              type="button"
              className="btn btn-ghost"
              style={{ marginTop: 8 }}
              onClick={() => void applySignedPayload(signedJSON)}
            >
              Check signed transaction
            </button>
          )}
        </details>
        {signedValidationMessage && (
          <p style={{ color: signedBroadcastReady ? 'var(--success)' : 'var(--danger)', fontSize: 13 }}>
            {signedValidationMessage}
          </p>
        )}
      </div>
    )
  }

  function payeeSelectedBalanceSubtitle(): string {
    if (showAdvancedCoinControl || sendOpenedFromCoins) {
      const addrs = selectedAddressGroupCount
      if (addrs === spendableAddressGroups.length) return 'Custom selection · all wallet addresses'
      if (addrs === 1) return 'Custom selection · 1 address'
      return `Custom selection · ${addrs} addresses`
    }
    const selected = selectedSpendUtxoKeys.size
    const allSpendableSelected =
      spendableUtxos.length > 0 && spendableUtxos.every((u) => selectedSpendUtxoKeys.has(u.key))
    if (allSpendableSelected) {
      if (selected > 1) return `Sending from your full wallet · ${selected} UTXOs`
      if (selected === 1) return 'Sending from your full wallet · 1 UTXO'
      return 'Sending from your full wallet balance'
    }
    if (selected === 1) return '1 UTXO selected'
    if (selected > 1) return `${selected} UTXOs selected`
    return 'Available to send'
  }
}

function InfoRow({
  title,
  value,
  fiat,
  note,
  mono,
  highFeeBadge,
}: {
  title: string
  value: string
  fiat?: string | null
  note?: string
  mono?: boolean
  highFeeBadge?: string | null
}): React.JSX.Element {
  return (
    <div className="send-info-row">
      <span className="send-info-row-title muted">{title}</span>
      <div className="send-info-row-value">
        <div
          className="send-info-row-amount-line"
          style={{ fontFamily: mono ? 'ui-monospace, monospace' : undefined, fontSize: mono ? 12 : 14, wordBreak: 'break-all' }}
        >
          {mono ? <AddressDisplay address={value} /> : value}
          {highFeeBadge && (
            <span className="send-high-fee-badge">
              High fee
              <InfoTipButton text={highFeeBadge} />
            </span>
          )}
        </div>
        {fiat && <span className="send-info-row-fiat muted">{fiat}</span>}
        {note && <span className="send-info-row-note muted">{note}</span>}
      </div>
    </div>
  )
}
