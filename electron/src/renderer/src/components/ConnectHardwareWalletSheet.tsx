import { useEffect, useRef, useState } from 'react'
import type { CoinChain } from '@renderer/api/types'
import { LedgerMark, OneKeyMark, SeedMaskLogoMark } from '@renderer/components/BrandMarks'
import { BluetoothIcon, ImportFileIcon, KeyIcon, QRViewfinderIcon, UsbIcon } from '@renderer/components/icons'
import {
  derivationPath,
  scriptDisplayName,
  type BitcoinPolicyType,
  type BitcoinScriptType,
} from '@renderer/utils/bitcoinWallet'
import { openFileWithDialog } from '@renderer/utils/nativeFiles'

export type OneKeyAccountMode = 'onekey-app' | 'bip44'

export type BitcoinHwScriptType = 'native_segwit' | 'nested_segwit' | 'legacy' | 'taproot'

export type HardwareImportPayload = {
  kpub: string
  fingerprint: string
  derivation: string
  account: number
  label: string
  hardware: 'ledger' | 'onekey'
  deviceModel: string
  verifiedReceiveAddressHint: string
  accountMode?: OneKeyAccountMode
  verifiedReceiveIndex?: number
  /** Bitcoin hardware import */
  scriptType?: BitcoinHwScriptType
  policyType?: BitcoinPolicyType
}

/** @deprecated Use HardwareImportPayload */
export type LedgerImportPayload = HardwareImportPayload & { hardware: 'ledger' }

type HwBrand = 'ledger' | 'onekey'
type HwLink = 'usb' | 'ble'
type Step =
  | 'transport'
  | 'usb-devices'
  | 'ledger-account'
  | 'ledger-bitcoin'
  | 'onekey-mode'
  | 'onekey-account'
  | 'onekey-bitcoin'
  | 'airgap-devices'
  | 'watch-only-device'
  | 'scanning'

const CONNECT_TIP =
  '“Connect” here does not permanently link or control your hardware wallet. It only imports watch-only data (kpub / xpub, fingerprint, derivation) so SeedMask Coordinator can show balances and build unsigned transactions. Some hardware wallets have no air-gapped export for that data. Your private keys never leave the device.'

const KASPA_MULTISIG_BLOCK =
  'Kaspa OneKey/Ledger USB import is singlesig only. For multisig cosigners use Airgapped → SeedMask with Export kpub.'

const ONEKEY_TAPROOT_MULTISIG_BLOCK =
  'Taproot multisig is not supported. Switch Script type to Native SegWit for multisig, or use Taproot with SingleSig.'

const LEDGER_TAPROOT_MULTISIG_BLOCK = ONEKEY_TAPROOT_MULTISIG_BLOCK

const SEEDMASK_FILE_FILTERS = [
  { name: 'SeedMask export', extensions: ['txt', 'json', 'sm', 'ur', 'asc'] },
  { name: 'All files', extensions: ['*'] },
]

function seedMaskExportLabel(chain: CoinChain, multisig: boolean): string {
  if (chain === 'kaspa') {
    return multisig ? 'Scan each cosigner’s Export kpub QR' : 'Scan Export kpub QR'
  }
  return multisig ? 'Scan each cosigner’s Export xpub QR' : 'Scan Export xpub QR'
}

function watchOnlyExportLabel(chain: CoinChain): string {
  return chain === 'kaspa' ? 'Scan kpub QR' : 'Scan xpub QR'
}

function watchOnlyDeviceGuide(chain: CoinChain): string {
  return chain === 'kaspa'
    ? 'Paste, scan, or import the watch-only kpub for this account (same fingerprint as the existing wallet).'
    : 'Paste, scan, or import the matching watch-only xPub for this account (same fingerprint as the existing wallet).'
}

function seedMaskDeviceGuide(chain: CoinChain, multisig: boolean): string {
  const policy = multisig ? 'Multi-sig' : 'Singlesig'
  if (chain === 'kaspa') {
    return (
      'On SeedMask: open Kaspa → Export kPub (QR or microSD), ' +
      `or Kaspa → Connect Software → ${policy} → SeedMask Coordinator.`
    )
  }
  return (
    'On SeedMask: open Bitcoin → Export xPub (QR or microSD). Use matching xPub. ' +
    `Or Bitcoin → Connect Software → ${policy} → SeedMask Coordinator.`
  )
}

function connectStepGuide(opts: {
  step: Step
  chain: CoinChain
  multisig: boolean
  activeBrand: HwBrand
  activeLink: HwLink
  seedMaskOnly: boolean
  watchOnlyOnly: boolean
  showSeedMaskAirgap: boolean
}): string {
  const { step, chain, multisig, activeBrand, activeLink, seedMaskOnly, watchOnlyOnly, showSeedMaskAirgap } = opts
  const coin = chain === 'kaspa' ? 'Kaspa' : 'Bitcoin'
  switch (step) {
    case 'transport':
      return showSeedMaskAirgap
        ? 'USB / Bluetooth for Ledger or OneKey. Airgapped for SeedMask (QR or import file).'
        : 'Choose USB or Bluetooth, then pick your hardware wallet.'
    case 'usb-devices':
      return `Unlock the device and open the ${coin} app, then tap USB or Bluetooth. Close Ledger Live / OneKey App if reconnecting stalls.`
    case 'airgap-devices':
      return seedMaskDeviceGuide(chain, multisig)
    case 'watch-only-device':
      return watchOnlyDeviceGuide(chain)
    case 'ledger-account':
    case 'ledger-bitcoin':
      return activeLink === 'ble'
        ? `Unlock Ledger, open ${coin}, keep Bluetooth on, stay nearby. Confirm on the device when asked.`
        : `Unlock Ledger, open ${coin}, close Ledger Live, then confirm on the device.`
    case 'onekey-mode':
    case 'onekey-account':
    case 'onekey-bitcoin':
      return activeLink === 'ble'
        ? `Unlock OneKey, enable Bluetooth, close the OneKey App, then confirm on the device.`
        : `Unlock OneKey over USB, close the OneKey App / Bridge, then confirm on the device.`
    case 'scanning':
      return activeBrand === 'onekey'
        ? 'Follow prompts on OneKey. Keep the device unlocked.'
        : 'Follow prompts on Ledger. Keep the device unlocked.'
    default:
      if (watchOnlyOnly) return watchOnlyDeviceGuide(chain)
      return seedMaskOnly ? seedMaskDeviceGuide(chain, multisig) : CONNECT_TIP
  }
}

function InfoHint({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <span className="hw-info-hint">
      <button
        type="button"
        className="hw-info-btn"
        aria-label={title}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        i
      </button>
      {open && (
        <div className="hw-info-popover" role="tooltip">
          <strong>{title}</strong>
          <p>{children}</p>
        </div>
      )}
    </span>
  )
}

function toHwScriptType(script: BitcoinScriptType | undefined): BitcoinHwScriptType | null {
  if (
    script === 'nested_segwit' ||
    script === 'legacy' ||
    script === 'native_segwit' ||
    script === 'taproot'
  ) {
    return script
  }
  return null
}

export function ConnectHardwareWalletSheet({
  chain,
  multisig = false,
  scriptType = 'native_segwit',
  initialAccount,
  restrictToBrand,
  seedMaskOnly = false,
  watchOnlyOnly = false,
  onClose,
  onLedgerImported,
  onHardwareImported,
  onChooseSeedMask,
  onSeedMaskFile,
  onChooseWatchOnly,
  onWatchOnlyFile,
}: {
  chain: CoinChain
  /** Kaspa USB hardware remains singlesig-only; Bitcoin Ledger/OneKey support multisig cosigners. */
  multisig?: boolean
  /** Script type already chosen on Add Wallet — shown read-only for Bitcoin hardware. */
  scriptType?: BitcoinScriptType
  /** Prefill BIP44 account index (Sparrow Add Account → hardware import). */
  initialAccount?: number
  /** Add Account for an existing Ledger/OneKey wallet — only that brand, no airgap/xpub. */
  restrictToBrand?: HwBrand
  /** Add Account for SeedMask — only the Airgapped SeedMask card (same as import). */
  seedMaskOnly?: boolean
  /** Add Account for a generic watch-only wallet — Watch-only card (same style as hardware). */
  watchOnlyOnly?: boolean
  onClose: () => void
  /** @deprecated Prefer onHardwareImported */
  onLedgerImported?: (payload: HardwareImportPayload) => void
  onHardwareImported?: (payload: HardwareImportPayload) => void
  /** When omitted, Airgapped → SeedMask is hidden. */
  onChooseSeedMask?: () => void
  /** Import SeedMask export text from a file (microSD copy, saved QR payload, etc.). */
  onSeedMaskFile?: (payload: string) => void
  /** Add Account watch-only — open QR scanner. */
  onChooseWatchOnly?: () => void
  /** Add Account watch-only — import pasted/file payload. */
  onWatchOnlyFile?: (payload: string) => void
}): React.JSX.Element {
  const policyType: BitcoinPolicyType = multisig ? 'multisig' : 'singlesig'
  const btcScriptType = toHwScriptType(scriptType)
  const oneKeyMultisigAllowed = chain === 'bitcoin' && multisig
  const ledgerMultisigAllowed = chain === 'bitcoin' && multisig
  const ledgerUsbBlocked = multisig && chain !== 'bitcoin'
  const oneKeyUsbBlocked = multisig && chain !== 'bitcoin'
  const brandLocked = restrictToBrand != null
  const showSeedMaskAirgap =
    (typeof onChooseSeedMask === 'function' || typeof onSeedMaskFile === 'function') &&
    (!brandLocked || seedMaskOnly) &&
    !watchOnlyOnly

  const [step, setStep] = useState<Step>(
    watchOnlyOnly
      ? 'watch-only-device'
      : seedMaskOnly
        ? 'airgap-devices'
        : brandLocked
          ? 'usb-devices'
          : 'transport',
  )
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [fileBusy, setFileBusy] = useState(false)
  const [accountText, setAccountText] = useState(
    initialAccount != null && Number.isFinite(initialAccount) ? String(Math.max(0, Math.floor(initialAccount))) : '0',
  )
  const [activeBrand, setActiveBrand] = useState<HwBrand>(restrictToBrand ?? 'ledger')
  const [activeLink, setActiveLink] = useState<HwLink>('usb')
  const [oneKeyMode, setOneKeyMode] = useState<OneKeyAccountMode | null>(null)
  const [showBtOffPrompt, setShowBtOffPrompt] = useState(false)
  const [btPromptKind, setBtPromptKind] = useState<'off' | 'unauthorized'>('off')
  const [pendingBleBrand, setPendingBleBrand] = useState<HwBrand | null>(null)
  function applyBluetoothGate(check: { ok: boolean; state?: string; error?: string } | undefined | null): boolean {
    if (!check || check.ok) return true
    const unauthorized =
      check.state === 'unauthorized' || /Privacy & Security → Bluetooth|unauthorized/i.test(check.error || '')
    setBtPromptKind(unauthorized ? 'unauthorized' : 'off')
    setShowBtOffPrompt(true)
    return false
  }

  function setAccountDefaultsFor(brand: HwBrand, mode: OneKeyAccountMode | null): void {
    if (initialAccount != null && Number.isFinite(initialAccount)) {
      setAccountText(String(Math.max(0, Math.floor(initialAccount))))
      return
    }
    if (brand === 'onekey' && chain === 'kaspa') {
      setAccountText(mode === 'bip44' ? '0' : '1')
    } else {
      setAccountText('0')
    }
  }

  function btcAccountIndex(): number {
    const n = Number.parseInt(accountText.trim(), 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }

  function btcPathPreview(): string {
    if (!btcScriptType) return '—'
    return derivationPath(btcScriptType, policyType, btcAccountIndex())
  }

  function btcScriptLabel(): string {
    return scriptDisplayName(scriptType) || 'Native SegWit'
  }

  async function requestClose(): Promise<void> {
    if (busy) {
      try {
        await window.seedmask?.cancelHardwareConnect?.()
      } catch {
        /* ignore */
      }
    }
    onClose()
  }

  async function pickSeedMaskFile(): Promise<void> {
    if (!onSeedMaskFile || fileBusy) return
    setError(null)
    setFileBusy(true)
    try {
      const buf = await openFileWithDialog(SEEDMASK_FILE_FILTERS)
      if (!buf) return
      const text = new TextDecoder().decode(buf).trim()
      if (!text) {
        setError('That file is empty. Export again from SeedMask (QR or microSD).')
        return
      }
      if (!seedMaskOnly) onClose()
      onSeedMaskFile(text)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read file')
    } finally {
      setFileBusy(false)
    }
  }

  async function pickWatchOnlyFile(): Promise<void> {
    if (!onWatchOnlyFile || fileBusy) return
    setError(null)
    setFileBusy(true)
    try {
      const buf = await openFileWithDialog(SEEDMASK_FILE_FILTERS)
      if (!buf) return
      const text = new TextDecoder().decode(buf).trim()
      if (!text) {
        setError(chain === 'kaspa' ? 'That file is empty. Provide a kpub export.' : 'That file is empty. Provide an xPub export.')
        return
      }
      onWatchOnlyFile(text)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read file')
    } finally {
      setFileBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function deliverFlowImport(payload: HardwareImportPayload): void {
    if (onHardwareImported) onHardwareImported(payload)
    else onLedgerImported?.(payload)
  }

  /**
   * Ledger / OneKey BIP44: 0-based account index.
   * OneKey App mode: 1-based Account # from the OneKey App.
   */
  function parsedAccountForImport(brand: HwBrand): number {
    const n = Number.parseInt(accountText.trim(), 10)
    if (brand === 'onekey' && chain === 'kaspa' && oneKeyMode === 'onekey-app') {
      if (!Number.isFinite(n) || n < 1) {
        throw new Error('OneKey App account must be ≥ 1 (same number as in the OneKey App)')
      }
      return Math.min(n, 0x7fffffff)
    }
    if (!Number.isFinite(n) || n < 0) throw new Error('Account must be a number ≥ 0')
    return Math.min(n, 0x7fffffff)
  }

  function oneKeyUiAccount(): number {
    const n = Number.parseInt(accountText.trim(), 10)
    if (oneKeyMode === 'bip44') return Number.isFinite(n) && n >= 0 ? n : 0
    return Number.isFinite(n) && n >= 1 ? n : 1
  }

  function oneKeyPathPreview(): string {
    if (oneKeyMode === 'bip44') {
      return `m/44'/111111'/${oneKeyUiAccount()}'`
    }
    const receiveIndex = Math.max(0, oneKeyUiAccount() - 1)
    return `m/44'/111111'/0'/0/${receiveIndex}`
  }

  async function chooseBrandLink(brand: HwBrand, link: HwLink): Promise<void> {
    if (brand === 'ledger' && multisig && chain !== 'bitcoin') {
      setError(KASPA_MULTISIG_BLOCK)
      return
    }
    if (brand === 'onekey' && multisig && chain !== 'bitcoin') {
      setError(KASPA_MULTISIG_BLOCK)
      return
    }
    if (chain === 'bitcoin' && brand === 'ledger' && multisig && scriptType === 'taproot') {
      setError(LEDGER_TAPROOT_MULTISIG_BLOCK)
      return
    }
    if (chain === 'bitcoin' && brand === 'onekey' && multisig && scriptType === 'taproot') {
      setError(ONEKEY_TAPROOT_MULTISIG_BLOCK)
      return
    }
    if (chain === 'bitcoin' && (brand === 'onekey' || brand === 'ledger') && !btcScriptType) {
      setError(`Unsupported Bitcoin script type for ${brand === 'onekey' ? 'OneKey' : 'Ledger'}.`)
      return
    }
    if (chain !== 'kaspa' && chain !== 'bitcoin') {
      setError('Hardware import supports Kaspa and Bitcoin only.')
      return
    }
    setError(null)
    if (link === 'ble') {
      const check = await window.seedmask?.ensureBluetoothOn?.()
      if (!applyBluetoothGate(check)) {
        setPendingBleBrand(brand)
        return
      }
    }
    setShowBtOffPrompt(false)
    setPendingBleBrand(null)
    setActiveBrand(brand)
    setActiveLink(link)
    setOneKeyMode(null)
    if (brand === 'onekey') {
      if (chain === 'bitcoin') {
        setAccountDefaultsFor('onekey', 'bip44')
        setStep('onekey-bitcoin')
      } else {
        setStep('onekey-mode')
      }
    } else if (chain === 'bitcoin') {
      setAccountDefaultsFor('ledger', null)
      setStep('ledger-bitcoin')
    } else {
      setAccountDefaultsFor('ledger', null)
      setStep('ledger-account')
    }
  }

  function chooseOneKeyMode(mode: OneKeyAccountMode): void {
    setOneKeyMode(mode)
    setAccountDefaultsFor('onekey', mode)
    setError(null)
    setStep('onekey-account')
  }

  async function retryBluetoothPrompt(): Promise<void> {
    const brand = pendingBleBrand
    if (!brand) {
      setShowBtOffPrompt(false)
      return
    }
    const check = await window.seedmask?.ensureBluetoothOn?.()
    if (!applyBluetoothGate(check)) return
    setShowBtOffPrompt(false)
    setPendingBleBrand(null)
    setActiveBrand(brand)
    setActiveLink('ble')
    setOneKeyMode(null)
    if (brand === 'onekey') {
      if (chain === 'bitcoin') {
        setAccountDefaultsFor('onekey', 'bip44')
        setStep('onekey-bitcoin')
      } else {
        setStep('onekey-mode')
      }
    } else if (chain === 'bitcoin') {
      setAccountDefaultsFor('ledger', null)
      setStep('ledger-bitcoin')
    } else {
      setAccountDefaultsFor('ledger', null)
      setStep('ledger-account')
    }
  }

  async function startDeviceScan(brand: HwBrand, link: HwLink): Promise<void> {
    if (brand === 'ledger' && multisig && chain !== 'bitcoin') {
      setError(KASPA_MULTISIG_BLOCK)
      return
    }
    if (brand === 'onekey' && multisig && chain !== 'bitcoin') {
      setError(KASPA_MULTISIG_BLOCK)
      return
    }
    if (chain === 'bitcoin' && brand === 'ledger' && multisig && scriptType === 'taproot') {
      setError(LEDGER_TAPROOT_MULTISIG_BLOCK)
      return
    }
    if (chain === 'bitcoin' && brand === 'onekey' && multisig && scriptType === 'taproot') {
      setError(ONEKEY_TAPROOT_MULTISIG_BLOCK)
      return
    }
    if (chain === 'bitcoin' && (brand === 'onekey' || brand === 'ledger') && !btcScriptType) {
      setError(`Unsupported Bitcoin script type for ${brand === 'onekey' ? 'OneKey' : 'Ledger'}.`)
      return
    }
    if (chain !== 'kaspa' && chain !== 'bitcoin') {
      setError('Hardware import supports Kaspa and Bitcoin only.')
      return
    }
    if (brand === 'ledger' && chain === 'kaspa' && !window.seedmask?.importLedgerKaspa) {
      setError('Hardware wallet APIs are unavailable in this build.')
      return
    }
    if (brand === 'ledger' && chain === 'bitcoin' && !window.seedmask?.importLedgerBitcoin) {
      setError('Ledger Bitcoin APIs are unavailable in this build.')
      return
    }
    if (brand === 'onekey' && chain === 'kaspa' && !window.seedmask?.importOneKeyKaspa) {
      setError('OneKey APIs are unavailable in this build.')
      return
    }
    if (brand === 'onekey' && chain === 'bitcoin' && !window.seedmask?.importOneKeyBitcoin) {
      setError('OneKey Bitcoin APIs are unavailable in this build.')
      return
    }
    if (brand === 'onekey' && chain === 'kaspa' && !oneKeyMode) {
      setError('Choose how you want to import from OneKey.')
      setStep('onekey-mode')
      return
    }
    let account = 0
    try {
      account = parsedAccountForImport(brand)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid account')
      return
    }
    setActiveBrand(brand)
    setActiveLink(link)
    setStep('scanning')
    setBusy(true)
    setError(null)
    const brandName = brand === 'onekey' ? 'OneKey' : 'Ledger'
    if (link === 'ble') {
      const check = await window.seedmask?.ensureBluetoothOn?.()
      if (!applyBluetoothGate(check)) {
        setBusy(false)
        setPendingBleBrand(brand)
        setStep('usb-devices')
        return
      }
    }
    setStatus(
      link === 'ble' ? `Scanning for ${brandName} over Bluetooth…` : `Scanning for ${brandName}…`,
    )
    const stopProgress =
      brand === 'onekey'
        ? window.seedmask.onOneKeyImportProgress?.((p) => {
            if (p?.message) setStatus(p.message)
          })
        : window.seedmask.onLedgerImportProgress?.((p) => {
            if (p?.message) setStatus(p.message)
          })
    try {
      if (brand === 'onekey' && chain === 'bitcoin') {
        const listed = await window.seedmask.listOneKeyDevices({ link })
        if (!listed.ok) {
          if (/^cancelled$/i.test(listed.error || '')) return
          throw new Error(
            listed.error ||
              (link === 'ble'
                ? 'Could not scan Bluetooth for OneKey. Turn Bluetooth on and close the OneKey App.'
                : 'Could not scan USB for OneKey. Quit the app fully and reopen after rebuilding, and close the OneKey App / Bridge.'),
          )
        }
        if (!listed.devices.length) {
          throw new Error(
            link === 'ble'
              ? 'No OneKey found over Bluetooth. Unlock it, enable Bluetooth, stay nearby, then try again. Close the OneKey App if it is open.'
              : 'No OneKey found. Plug in via USB, unlock it, then try again. Close the OneKey App and OneKey Bridge if they are open.',
          )
        }
        setStatus(
          multisig
            ? `Found ${listed.devices[0]!.product}. Confirm Bitcoin ${btcScriptLabel()} multisig cosigner…`
            : `Found ${listed.devices[0]!.product}. Confirm Bitcoin ${btcScriptLabel()} receive #0…`,
        )
        const res = await window.seedmask.importOneKeyBitcoin({
          devicePath: listed.devices[0]!.path,
          account,
          scriptType: btcScriptType!,
          policyType,
          link,
        })
        if (!res.ok || !res.result) {
          if (/^cancelled$/i.test(res.error || '')) return
          throw new Error(res.error || 'OneKey Bitcoin import failed')
        }
        setStatus('OneKey connected')
        deliverFlowImport({
          ...res.result,
          scriptType: res.result.scriptType,
          policyType: res.result.policyType ?? policyType,
        })
      } else if (brand === 'onekey') {
        const listed = await window.seedmask.listOneKeyDevices({ link })
        if (!listed.ok) {
          if (/^cancelled$/i.test(listed.error || '')) return
          throw new Error(
            listed.error ||
              (link === 'ble'
                ? 'Could not scan Bluetooth for OneKey. Turn Bluetooth on and close the OneKey App.'
                : 'Could not scan USB for OneKey. Quit the app fully and reopen after rebuilding, and close the OneKey App / Bridge.'),
          )
        }
        if (!listed.devices.length) {
          throw new Error(
            link === 'ble'
              ? 'No OneKey found over Bluetooth. Unlock it, enable Bluetooth, stay nearby, then try again. Close the OneKey App if it is open.'
              : 'No OneKey found. Plug in via USB, unlock it, then try again. Close the OneKey App and OneKey Bridge if they are open.',
          )
        }
        const mode = oneKeyMode || 'onekey-app'
        setStatus(
          mode === 'onekey-app'
            ? `Found ${listed.devices[0]!.product}. Confirm OneKey App Account #${oneKeyUiAccount()}…`
            : `Found ${listed.devices[0]!.product}. Confirm Standard account ${oneKeyUiAccount()} receive #0…`,
        )
        const res = await window.seedmask.importOneKeyKaspa({
          devicePath: listed.devices[0]!.path,
          account,
          accountMode: mode,
          link,
        })
        if (!res.ok || !res.result) {
          if (/^cancelled$/i.test(res.error || '')) return
          throw new Error(res.error || 'OneKey import failed')
        }
        setStatus('OneKey connected')
        deliverFlowImport(res.result)
      } else if (brand === 'ledger' && chain === 'bitcoin') {
        const listed = await window.seedmask.listLedgerDevices({ link })
        if (!listed.ok) {
          if (/^cancelled$/i.test(listed.error || '')) return
          throw new Error(
            listed.error ||
              (link === 'ble'
                ? 'Could not scan Bluetooth for Ledger. Turn Bluetooth on and close Ledger Live.'
                : 'Could not scan USB for Ledger. Quit the app fully and reopen after rebuilding, and close Ledger Live.'),
          )
        }
        if (!listed.devices.length) {
          throw new Error(
            link === 'ble'
              ? 'No Ledger found over Bluetooth. Unlock it, open the Bitcoin app, stay nearby, then try again. Close Ledger Live if it is open.'
              : 'No Ledger found. Plug in via USB, unlock it, open the Bitcoin app, then try again. Close Ledger Live if it is open.',
          )
        }
        setStatus(
          multisig
            ? `Found ${listed.devices[0]!.product}. Confirm Bitcoin ${btcScriptLabel()} multisig cosigner…`
            : `Found ${listed.devices[0]!.product}. Confirm Bitcoin ${btcScriptLabel()} receive #0…`,
        )
        const res = await window.seedmask.importLedgerBitcoin({
          devicePath: listed.devices[0]!.path,
          account,
          scriptType: btcScriptType!,
          policyType,
          link,
        })
        if (!res.ok || !res.result) {
          if (/^cancelled$/i.test(res.error || '')) return
          throw new Error(res.error || 'Ledger Bitcoin import failed')
        }
        setStatus('Ledger connected')
        deliverFlowImport({
          ...res.result,
          scriptType: res.result.scriptType,
          policyType: res.result.policyType ?? policyType,
        })
      } else {
        const listed = await window.seedmask.listLedgerDevices({ link })
        if (!listed.ok) {
          if (/^cancelled$/i.test(listed.error || '')) return
          throw new Error(
            listed.error ||
              (link === 'ble'
                ? 'Could not scan Bluetooth for Ledger. Turn Bluetooth on and close Ledger Live.'
                : 'Could not scan USB for Ledger. Quit the app fully and reopen after rebuilding, and close Ledger Live.'),
          )
        }
        if (!listed.devices.length) {
          throw new Error(
            link === 'ble'
              ? 'No Ledger found over Bluetooth. Unlock it, open the Kaspa app, stay nearby, then try again. Close Ledger Live if it is open.'
              : 'No Ledger found. Plug in via USB, unlock it, open the Kaspa app, then try again. Close Ledger Live if it is open.',
          )
        }
        setStatus(`Found ${listed.devices[0]!.product}. Confirm receive address #0 on Ledger…`)
        const res = await window.seedmask.importLedgerKaspa({
          devicePath: listed.devices[0]!.path,
          account,
          link,
        })
        if (!res.ok || !res.result) {
          if (/^cancelled$/i.test(res.error || '')) return
          throw new Error(res.error || 'Ledger import failed')
        }
        setStatus('Ledger connected')
        deliverFlowImport(res.result)
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : `${brand === 'onekey' ? 'OneKey' : 'Ledger'} import failed`
      if (/^cancelled$/i.test(message)) return
      setError(message)
      if (brand === 'onekey' && chain === 'bitcoin') setStep('onekey-bitcoin')
      else if (brand === 'ledger' && chain === 'bitcoin') setStep('ledger-bitcoin')
      else if (brand === 'onekey') setStep('onekey-account')
      else setStep('ledger-account')
    } finally {
      stopProgress?.()
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop hw-connect-backdrop" role="presentation" onClick={() => void requestClose()}>
      <div
        className="modal-card hw-connect-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hw-connect-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hw-connect-head">
          <div>
            <h3 id="hw-connect-title">Connect hardware wallet</h3>
            <p className="muted">Watch-only import — keys stay on the device</p>
          </div>
          <button type="button" className="btn btn-ghost hw-connect-close" onClick={() => void requestClose()}>
            {busy ? 'Cancel' : 'Close'}
          </button>
        </div>

        {showBtOffPrompt && (
          <div className="hw-bt-off-prompt" role="alertdialog" aria-labelledby="hw-bt-off-title">
            <BluetoothIcon size={28} />
            <h4 id="hw-bt-off-title">
              {btPromptKind === 'unauthorized' ? 'Allow Bluetooth access' : 'Turn on Bluetooth'}
            </h4>
            <p className="muted">
              {btPromptKind === 'unauthorized'
                ? 'macOS blocked Bluetooth for SeedMask. Open System Settings → Privacy & Security → Bluetooth, enable SeedMask Coordinator, then tap Try again.'
                : 'Bluetooth is off. Turn it on, then tap Try again.'}
            </p>
            <div className="hw-bt-off-actions">
              <button type="button" className="btn btn-primary" onClick={() => void retryBluetoothPrompt()}>
                Try again
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setShowBtOffPrompt(false)
                  setPendingBleBrand(null)
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {step === 'transport' && !brandLocked && (
          <div className="hw-connect-options">
            <button type="button" className="hw-connect-option" onClick={() => setStep('usb-devices')}>
              <strong>Via USB / Bluetooth</strong>
              <span className="muted">Ledger, OneKey, and similar plugged-in or nearby signers</span>
            </button>
            {showSeedMaskAirgap && (
              <button type="button" className="hw-connect-option" onClick={() => setStep('airgap-devices')}>
                <strong>Airgapped</strong>
                <span className="muted">QR or import file — offline SeedMask export</span>
              </button>
            )}
          </div>
        )}

        {step === 'usb-devices' && (
          <div className="hw-connect-options">
            <button
              type="button"
              className="btn btn-ghost hw-connect-back"
              onClick={() => (brandLocked ? void requestClose() : setStep('transport'))}
            >
              ← Back
            </button>

            {(!restrictToBrand || restrictToBrand === 'ledger') && (
              <div className={`hw-connect-device-row${busy || ledgerUsbBlocked ? ' disabled' : ''}`}>
                <div className="hw-connect-device-main">
                  <LedgerMark size={28} className="hw-connect-device-logo" />
                  <div className="hw-connect-device-copy">
                    <strong>Ledger</strong>
                    <span className="muted">
                      {ledgerUsbBlocked
                        ? 'Not available for Kaspa multisig cosigners'
                        : ledgerMultisigAllowed
                          ? 'Nano, Flex, Stax — Bitcoin multisig cosigner'
                          : chain === 'bitcoin'
                            ? 'Nano, Flex, Stax — Bitcoin'
                            : 'Nano, Flex, Stax — Kaspa singlesig'}
                    </span>
                  </div>
                </div>
                {!ledgerUsbBlocked && (
                  <div className="hw-connect-link-btns">
                    <button
                      type="button"
                      className="hw-connect-link-btn hw-link-usb"
                      disabled={busy}
                      title="Connect via USB"
                      aria-label="Connect Ledger via USB"
                      onClick={() => void chooseBrandLink('ledger', 'usb')}
                    >
                      <UsbIcon size={24} />
                    </button>
                    <button
                      type="button"
                      className="hw-connect-link-btn hw-link-bluetooth"
                      disabled={busy}
                      title="Connect via Bluetooth"
                      aria-label="Connect Ledger via Bluetooth"
                      onClick={() => void chooseBrandLink('ledger', 'ble')}
                    >
                      <BluetoothIcon size={24} />
                    </button>
                  </div>
                )}
              </div>
            )}

            {(!restrictToBrand || restrictToBrand === 'onekey') && (
              <div className={`hw-connect-device-row${busy || oneKeyUsbBlocked ? ' disabled' : ''}`}>
                <div className="hw-connect-device-main">
                  <OneKeyMark size={28} className="hw-connect-device-logo" />
                  <div className="hw-connect-device-copy">
                    <strong>OneKey</strong>
                    <span className="muted">
                      {oneKeyUsbBlocked
                        ? 'Not available for Kaspa multisig cosigners'
                        : oneKeyMultisigAllowed
                          ? 'Classic, Mini, Pro, Touch — Bitcoin multisig cosigner'
                          : chain === 'bitcoin'
                            ? 'Classic, Mini, Pro, Touch — Bitcoin'
                            : 'Classic, Mini, Pro, Touch — Kaspa singlesig'}
                    </span>
                  </div>
                </div>
                {!oneKeyUsbBlocked && (
                  <div className="hw-connect-link-btns">
                    <button
                      type="button"
                      className="hw-connect-link-btn hw-link-usb"
                      disabled={busy}
                      title="Connect via USB"
                      aria-label="Connect OneKey via USB"
                      onClick={() => void chooseBrandLink('onekey', 'usb')}
                    >
                      <UsbIcon size={24} />
                    </button>
                    <button
                      type="button"
                      className="hw-connect-link-btn hw-link-bluetooth"
                      disabled={busy}
                      title="Connect via Bluetooth"
                      aria-label="Connect OneKey via Bluetooth"
                      onClick={() => void chooseBrandLink('onekey', 'ble')}
                    >
                      <BluetoothIcon size={24} />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {step === 'onekey-mode' && (
          <div className="hw-connect-options">
            <button type="button" className="btn btn-ghost hw-connect-back" onClick={() => setStep('usb-devices')}>
              ← Back
            </button>
            <div className="hw-connect-account-brand">
              <OneKeyMark size={22} />
              <span>
                OneKey · {activeLink === 'ble' ? 'Bluetooth' : 'USB'}
              </span>
            </div>
            <p className="muted hw-connect-account-hint">How should SeedMask treat this OneKey wallet?</p>

            <button type="button" className="hw-connect-option hw-mode-option" onClick={() => chooseOneKeyMode('onekey-app')}>
              <span className="hw-mode-option-title">
                <strong>OneKey App accounts</strong>
                <InfoHint title="OneKey App accounts">
                  Matches your Kaspa accounts in the OneKey App. Best if you want the same funds visible in both
                  apps.
                </InfoHint>
              </span>
              <span className="muted">
                Use this if you already have Kaspa in the OneKey App and want SeedMask to show the same wallets.
              </span>
              <span className="muted">
                In the OneKey App, “Account #1”, “Account #2”, etc. are separate receive addresses under one main
                wallet, not fully separate accounts. SeedMask will follow that same layout, so what you see here
                matches what you see in the OneKey App.
              </span>
            </button>

            <button type="button" className="hw-connect-option hw-mode-option" onClick={() => chooseOneKeyMode('bip44')}>
              <span className="hw-mode-option-title">
                <strong>Standard accounts (BIP44)</strong>
                <InfoHint title="Standard accounts">
                  Separate wallets by account number (like Ledger). Best for multiple independent wallets in
                  SeedMask. May not match the OneKey App’s account list.
                </InfoHint>
              </span>
              <span className="muted">
                Use this if you want separate wallets in SeedMask — like Ledger does — each with its own account
                number.
              </span>
              <span className="muted">
                Account 0, 1, 2… are truly separate. Better if you want more than one independent OneKey wallet
                here. Note: these may not show up under the same “Account #” list in the OneKey App.
              </span>
            </button>
          </div>
        )}

        {step === 'ledger-account' && (
          <div className="hw-connect-options">
            <button type="button" className="btn btn-ghost hw-connect-back" onClick={() => setStep('usb-devices')}>
              ← Back
            </button>
            <div className="hw-connect-account-brand">
              <LedgerMark size={22} />
              <span>
                Ledger · {activeLink === 'ble' ? 'Bluetooth' : 'USB'}
              </span>
            </div>
            <label className="hw-connect-account-field">
              <span className="keystore-field-label">Account index</span>
              <input
                className="field-input mono"
                inputMode="numeric"
                value={accountText}
                onChange={(e) => setAccountText(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="0"
              />
              <span className="muted hw-connect-account-hint">
                Path m/44&apos;/111111&apos;/{accountText || '0'}&apos; — use 0 unless you created another account
                on Ledger/KasVault.
              </span>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void startDeviceScan('ledger', activeLink)}
            >
              Connect Ledger
            </button>
            <p className="muted hw-connect-account-hint">
              {activeLink === 'ble'
                ? 'Unlock Ledger, open Kaspa, keep Bluetooth on and stay nearby. Close Ledger Live. After Kaspa you’ll switch to Bitcoin briefly for the master fingerprint.'
                : '1) Kaspa app — confirm receive #0 and export kpub. 2) Open Bitcoin once for the master fingerprint (same as Sparrow). Ledger Live closed.'}
            </p>
          </div>
        )}

        {step === 'onekey-account' && (
          <div className="hw-connect-options">
            <button type="button" className="btn btn-ghost hw-connect-back" onClick={() => setStep('onekey-mode')}>
              ← Back
            </button>
            <div className="hw-connect-account-brand">
              <OneKeyMark size={22} />
              <span>
                OneKey · {activeLink === 'ble' ? 'Bluetooth' : 'USB'} ·{' '}
                {oneKeyMode === 'bip44' ? 'Standard accounts' : 'OneKey App accounts'}
              </span>
            </div>
            <label className="hw-connect-account-field">
              <span className="keystore-field-label">
                {oneKeyMode === 'bip44' ? 'Account index' : 'OneKey App account #'}
              </span>
              <input
                className="field-input mono"
                inputMode="numeric"
                value={accountText}
                onChange={(e) => setAccountText(e.target.value.replace(/[^\d]/g, ''))}
                placeholder={oneKeyMode === 'bip44' ? '0' : '1'}
              />
              <span className="muted hw-connect-account-hint">
                {oneKeyMode === 'bip44'
                  ? `Path ${oneKeyPathPreview()} — use 0 for the first standard account.`
                  : `Same # as in the OneKey App. Account #${oneKeyUiAccount()} → ${oneKeyPathPreview()} (= SeedMask Receive #${Math.max(0, oneKeyUiAccount() - 1)}).`}
              </span>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void startDeviceScan('onekey', activeLink)}
            >
              Connect OneKey
            </button>
            <p className="muted hw-connect-account-hint">
              Use a Kaspa Official wallet (not the default “Kaspa OneKey”, which is BIP340-tweaked).
              {activeLink === 'ble'
                ? ' Unlock OneKey, enable Bluetooth, close the OneKey App, connect only from SeedMask.'
                : ' Unlock OneKey over USB, close the OneKey App / Bridge, then confirm on the device.'}
            </p>
          </div>
        )}

        {step === 'ledger-bitcoin' && (
          <div className="hw-connect-options">
            <button type="button" className="btn btn-ghost hw-connect-back" onClick={() => setStep('usb-devices')}>
              ← Back
            </button>
            <div className="hw-connect-account-brand">
              <LedgerMark size={22} />
              <span>
                Ledger · Bitcoin · {multisig ? 'Multisig' : 'SingleSig'} ·{' '}
                {activeLink === 'ble' ? 'Bluetooth' : 'USB'}
              </span>
            </div>
            <div className="hw-connect-option hw-mode-option is-selected" style={{ cursor: 'default' }}>
              <strong>{btcScriptLabel()}</strong>
              <span className="muted">
                From Add Wallet · path {btcPathPreview()}
                {multisig ? ' (cosigner xpub)' : ''}
              </span>
            </div>
            <p className="muted hw-connect-account-hint">
              Change script type on Add Wallet if this is not the account you want to import.
            </p>
            <label className="hw-connect-account-field">
              <span className="keystore-field-label">Account index</span>
              <input
                className="field-input mono"
                inputMode="numeric"
                value={accountText}
                onChange={(e) => setAccountText(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="0"
              />
              <span className="muted hw-connect-account-hint">
                Path {btcPathPreview()} — use 0 unless you created another account on Ledger.
              </span>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !btcScriptType}
              onClick={() => void startDeviceScan('ledger', activeLink)}
            >
              Connect Ledger
            </button>
            <p className="muted hw-connect-account-hint">
              {activeLink === 'ble'
                ? 'Unlock Ledger, open the Bitcoin app, keep Bluetooth on and stay nearby. Close Ledger Live.'
                : 'Unlock Ledger, open the Bitcoin app, close Ledger Live, then confirm on the device.'}
            </p>
          </div>
        )}

        {step === 'onekey-bitcoin' && (
          <div className="hw-connect-options">
            <button type="button" className="btn btn-ghost hw-connect-back" onClick={() => setStep('usb-devices')}>
              ← Back
            </button>
            <div className="hw-connect-account-brand">
              <OneKeyMark size={22} />
              <span>
                OneKey · Bitcoin · {multisig ? 'Multisig' : 'SingleSig'} ·{' '}
                {activeLink === 'ble' ? 'Bluetooth' : 'USB'}
              </span>
            </div>
            <div className="hw-connect-option hw-mode-option is-selected" style={{ cursor: 'default' }}>
              <strong>{btcScriptLabel()}</strong>
              <span className="muted">
                From Add Wallet · path {btcPathPreview()}
                {multisig ? ' (cosigner xpub)' : ''}
              </span>
            </div>
            <p className="muted hw-connect-account-hint">
              Change script type on Add Wallet if this is not the account you want to import.
            </p>
            <label className="hw-connect-account-field">
              <span className="keystore-field-label">Account index</span>
              <input
                className="field-input mono"
                inputMode="numeric"
                value={accountText}
                onChange={(e) => setAccountText(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="0"
              />
              <span className="muted hw-connect-account-hint">
                Path {btcPathPreview()} — use 0 unless you created another account on OneKey.
              </span>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !btcScriptType}
              onClick={() => void startDeviceScan('onekey', activeLink)}
            >
              Connect OneKey
            </button>
            <p className="muted hw-connect-account-hint">
              {multisig
                ? activeLink === 'ble'
                  ? 'Unlock OneKey, enable Bluetooth, close the OneKey App, then confirm the cosigner account key on the device.'
                  : 'Unlock OneKey over USB, close the OneKey App / Bridge, then confirm the cosigner account key on the device.'
                : activeLink === 'ble'
                  ? 'Unlock OneKey, enable Bluetooth, close the OneKey App, then confirm receive #0 on the device.'
                  : 'Unlock OneKey over USB, close the OneKey App / Bridge, then confirm receive #0 on the device.'}
            </p>
          </div>
        )}

        {step === 'airgap-devices' && showSeedMaskAirgap && (
          <div className="hw-connect-options">
            <button
              type="button"
              className="btn btn-ghost hw-connect-back"
              onClick={() => (seedMaskOnly ? void requestClose() : setStep('transport'))}
            >
              ← Back
            </button>
            <div className="hw-connect-device-row">
              <div className="hw-connect-device-main">
                <SeedMaskLogoMark size={40} className="hw-connect-device-logo" />
                <div className="hw-connect-device-copy">
                  <strong>SeedMask</strong>
                  <span className="muted">{seedMaskExportLabel(chain, multisig)}</span>
                </div>
              </div>
              <div className="hw-connect-link-btns">
                {typeof onChooseSeedMask === 'function' && (
                  <button
                    type="button"
                    className="hw-connect-link-btn hw-link-qr"
                    title="Scan SeedMask QR"
                    aria-label="Scan SeedMask QR"
                    disabled={fileBusy}
                    onClick={() => {
                      // Add Wallet: close sheet then open scanner. Add Account SeedMask: keep parent step, open scanner.
                      if (!seedMaskOnly) onClose()
                      onChooseSeedMask()
                    }}
                  >
                    <QRViewfinderIcon size={24} />
                  </button>
                )}
                {typeof onSeedMaskFile === 'function' && (
                  <button
                    type="button"
                    className="hw-connect-link-btn hw-link-file hw-link-file-labeled"
                    title="Import file from microSD, USB, or disk"
                    aria-label="Import file"
                    disabled={fileBusy}
                    onClick={() => void pickSeedMaskFile()}
                  >
                    <ImportFileIcon size={20} />
                    <span>Import file</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {step === 'watch-only-device' && watchOnlyOnly && (
          <div className="hw-connect-options">
            <button type="button" className="btn btn-ghost hw-connect-back" onClick={() => void requestClose()}>
              ← Back
            </button>
            <div className="hw-connect-device-row">
              <div className="hw-connect-device-main">
                <KeyIcon size={36} className="hw-connect-device-logo" />
                <div className="hw-connect-device-copy">
                  <strong>Watch-only wallet</strong>
                  <span className="muted">{watchOnlyExportLabel(chain)}</span>
                </div>
              </div>
              <div className="hw-connect-link-btns">
                {typeof onChooseWatchOnly === 'function' && (
                  <button
                    type="button"
                    className="hw-connect-link-btn hw-link-qr"
                    title={chain === 'kaspa' ? 'Scan kpub QR' : 'Scan xpub QR'}
                    aria-label={chain === 'kaspa' ? 'Scan kpub QR' : 'Scan xpub QR'}
                    disabled={fileBusy}
                    onClick={() => onChooseWatchOnly()}
                  >
                    <QRViewfinderIcon size={24} />
                  </button>
                )}
                {typeof onWatchOnlyFile === 'function' && (
                  <button
                    type="button"
                    className="hw-connect-link-btn hw-link-file hw-link-file-labeled"
                    title="Import file from disk or USB"
                    aria-label="Import file"
                    disabled={fileBusy}
                    onClick={() => void pickWatchOnlyFile()}
                  >
                    <ImportFileIcon size={20} />
                    <span>Import file</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {step === 'scanning' && (
          <div className="hw-connect-scanning">
            <span className="spinner" aria-hidden />
            <p>{status || 'Working…'}</p>
            <p className="muted">
              {activeBrand === 'onekey'
                ? activeLink === 'ble'
                  ? 'Keep OneKey unlocked and nearby. Follow prompts on the device.'
                  : 'Follow prompts on your OneKey. Close the OneKey App / Bridge if reconnecting stalls.'
                : activeLink === 'ble'
                  ? 'Keep Ledger unlocked and nearby. After Kaspa, open Bitcoin when asked — Bluetooth reconnects for the fingerprint.'
                  : 'Kaspa first, then open Bitcoin when asked. Close Ledger Live if reconnecting stalls.'}
            </p>
          </div>
        )}

        {error && <p className="hw-connect-error">{error}</p>}
        <p className="hw-connect-footnote muted">
          {connectStepGuide({
            step,
            chain,
            multisig,
            activeBrand,
            activeLink,
            seedMaskOnly,
            watchOnlyOnly,
            showSeedMaskAirgap,
          })}
        </p>
      </div>
    </div>
  )
}

export function ConnectHardwareWalletRow({
  onClick,
  compact = false,
}: {
  onClick: () => void
  compact?: boolean
}): React.JSX.Element {
  return (
    <div className={`hw-connect-row${compact ? ' compact' : ''}`}>
      <button type="button" className={`hw-connect-trigger${compact ? ' chip' : ''}`} onClick={onClick}>
        <span className="hw-connect-trigger-icon" aria-hidden>
          <UsbIcon size={16} />
        </span>
        Connect hardware wallet
      </button>
      <HwConnectInfoTip />
    </div>
  )
}

function HwConnectInfoTip(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function place(): void {
      const el = btnRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const width = Math.min(360, window.innerWidth - 24)
      let left = r.left + r.width / 2
      left = Math.max(12 + width / 2, Math.min(left, window.innerWidth - 12 - width / 2))
      const below = r.bottom + 8
      const spaceBelow = window.innerHeight - below
      const top = spaceBelow < 120 ? Math.max(12, r.top - 8) : below
      setPos({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent): void {
      const t = e.target as Node | null
      if (btnRef.current?.contains(t)) return
      const tip = document.getElementById('hw-connect-info-tip')
      if (tip?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <span className="info-tip-wrap hw-connect-info-wrap">
      <button
        ref={btnRef}
        type="button"
        className="info-tip-btn"
        aria-label="About connect hardware wallet"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        i
      </button>
      {open && pos ? (
        <span
          id="hw-connect-info-tip"
          className="info-tip-popover info-tip-popover-fixed hw-connect-tip"
          role="tooltip"
          style={{
            top: pos.top,
            left: pos.left,
            maxWidth: Math.min(360, window.innerWidth - 24),
            transform:
              pos.top < (btnRef.current?.getBoundingClientRect().top ?? 0)
                ? 'translate(-50%, -100%)'
                : 'translate(-50%, 0)',
          }}
        >
          {CONNECT_TIP}
        </span>
      ) : null}
    </span>
  )
}
