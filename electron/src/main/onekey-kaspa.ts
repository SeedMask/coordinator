/**
 * OneKey Kaspa: watch-only import + kaspaSignTransaction (USB via node-usb).
 * Uses @onekeyfe/hd-common-connect-sdk in the Electron main process only.
 *
 * Lazy-load the SDK so a missing transitive dep cannot crash app startup.
 *
 * Address policy: SeedMask uses Kaspa Official (untweaked Schnorr / useTweak:false).
 * OneKey App’s default “Kaspa OneKey” wallet is BIP340-tweaked and will show a
 * different receive address at the same path — that is expected, not a SeedMask bug.
 */
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { promisify } from 'util'

import {
  BLUETOOTH_OFF_MESSAGE,
  clearHardwareCancel,
  ensureBluetoothPoweredOn,
  getLastBleScanDiagnostics,
  getOneKeyNobleBleApi,
  installOneKeyBleDesktopApi,
  isHardwareCancelRequested,
  requestHardwareCancel,
} from './onekey-ble-bridge'
import { findCoordinatorRoot, resolvePython } from './paths'

const execFileAsync = promisify(execFile)

type HwLink = 'usb' | 'ble'

export type OneKeyHwLink = HwLink

type UiEventMessage = {
  type?: string
  payload?: {
    existsAttachPinUser?: boolean
    passphraseState?: string
  }
}

type HardwareSdk = {
  init: (settings: Record<string, unknown>) => Promise<unknown>
  dispose?: () => void
  on: (event: string, cb: (message: UiEventMessage) => void) => void
  uiResponse: (response: Record<string, unknown>) => void
  searchDevices: () => Promise<unknown>
  getFeatures: (connectId: string, params?: Record<string, unknown>) => Promise<unknown>
  getPassphraseState?: (connectId: string, params?: Record<string, unknown>) => Promise<unknown>
  kaspaGetAddress: (
    connectId: string,
    deviceId: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>
  btcGetAddress: (
    connectId: string,
    deviceId: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>
  btcGetPublicKey: (
    connectId: string,
    deviceId: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>
  btcSignPsbt: (
    connectId: string,
    deviceId: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>
  kaspaSignTransaction: (
    connectId: string,
    deviceId: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>
}

let hardwareSdk: HardwareSdk | null = null

function loadHardwareSdk(): HardwareSdk {
  if (hardwareSdk) return hardwareSdk
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@onekeyfe/hd-common-connect-sdk') as HardwareSdk & {
    default?: HardwareSdk
  }
  const sdk = mod?.default && typeof mod.default.init === 'function' ? mod.default : mod
  if (!sdk || typeof sdk.init !== 'function') {
    throw new Error('OneKey hardware SDK failed to load')
  }
  hardwareSdk = sdk
  return sdk
}

const KASPA_KPUB_VERSION = Buffer.from('038f332e', 'hex')
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const PIN_ON_DEVICE = '@@ONEKEY_INPUT_PIN_IN_DEVICE'

/** How the UI number maps to a Kaspa path on OneKey. */
export type OneKeyAccountMode = 'onekey-app' | 'bip44'

export type OneKeyKaspaImportResult = {
  kpub: string
  fingerprint: string
  derivation: string
  account: number
  label: string
  hardware: 'onekey'
  deviceModel: string
  verifiedReceiveAddressHint: string
  /** onekey-app = receive index under 0'; bip44 = real BIP44 account N' */
  accountMode: OneKeyAccountMode
  /** Receive index confirmed on device (for scan-limit hints). */
  verifiedReceiveIndex: number
}

export type OneKeyScanProgress = {
  status: 'scanning' | 'connecting' | 'reading' | 'confirm' | 'fingerprint' | 'done' | 'error'
  message: string
}

export type OneKeySignProgress = {
  status: 'scanning' | 'connecting' | 'signing' | 'done' | 'error'
  message: string
}

type UnsignedKaspaV2 = {
  version?: number
  account?: number
  kpub?: string
  tx_version?: number
  lock_time?: number | string
  draft_hash?: string
  inputs?: Array<{
    prev_tx_id?: string
    prev_index?: number
    sequence?: number | string
    sig_op_count?: number | string
    utxo_amount?: number
    sign_chain?: number
    sign_address_index?: number
    utxo_script_hex?: string
    receive_address?: string
  }>
  outputs?: Array<{
    value?: number
    script_hex?: string
    script_version?: number
    is_change?: boolean
    change_address_index?: number
  }>
}

/** Bare x-only (64 hex) → Schnorr P2PK script; leave full scripts unchanged. */
function normalizeKaspaScriptHex(scriptHex: string): string {
  const h = String(scriptHex || '')
    .replace(/^0x/i, '')
    .toLowerCase()
  if (h.length === 64 && !h.startsWith('20')) return `20${h}ac`
  return h
}

type SdkSuccess<T> = { success: true; payload: T }
type SdkFailure = { success: false; payload: { error?: string; code?: string | number } }
type SdkResponse<T> = SdkSuccess<T> | SdkFailure

let sdkReady: Promise<void> | null = null
let sdkLink: HwLink | null = null
let uiHandlersBound = false
let activeProgress: ((p: OneKeyScanProgress | OneKeySignProgress) => void) | undefined
/**
 * Three OneKey unlock modes (do not collapse these):
 * - standard: empty passphrase (normal PIN, e.g. 4 digits)
 * - temporary: passphrase typed on device (My address → arrows → Enter passphrase)
 * - hidden-pin: passphrase attached to PIN (separate hidden PIN, e.g. 6 digits)
 *
 * Unlocked → standard silently. After PIN → SeedMask; Temporary prompts once.
 * After Temporary unlock, hold "Active wallet: Temporary" before Confirm.
 */
let sessionPassphraseState: string | undefined
let sessionUseEmptyPassphrase = false
/** Choice locked before any passphrase SDK call that may prompt the device. */
let lockedPassphraseChoice: OneKeyPassphraseChoice | null = null
/** Shared in-flight app choice so UI_EVENT never opens a second dialog. */
let choiceInFlight: Promise<OneKeyPassphraseChoice> | null = null
/** Device reported attach-PIN capability on the last passphrase request. */
let pendingExistsAttachPinUser = false
/**
 * probe = read active wallet without wiping session.
 * choosing = SeedMask dialog open; do not start device passphrase calls.
 * device = may answer passphrase UI events for the locked choice.
 */
let passphrasePhase: 'idle' | 'probe' | 'choosing' | 'device' | 'ready' = 'idle'
/** True if getFeatures asked for PIN during this connect (session was locked). */
let pinPromptedDuringConnect = false
/** Only answer ui-request_passphrase once per getPassphraseState (avoids double entry). */
let passphraseUiAnswered = false
/** Last resolved wallet mode — shown in progress so it is not overwritten silently. */
let activeWalletLabel: OneKeyPassphraseChoice | null = null
/**
 * Bumped on every clear/beginConnect so a stale SeedMask choice dialog cannot
 * apply Temporary/Hidden to a newer connect (that caused random passphrase prompts).
 */
let passphraseChoiceGeneration = 0

export type OneKeyPassphraseChoice = 'standard' | 'temporary' | 'hidden-pin'

type OneKeyFeatures = {
  device_id?: string
  label?: string
  model?: string
  passphrase_protection?: boolean
  unlocked?: boolean
  unlocked_attach_pin?: boolean
  attach_to_pin_user?: boolean
}

let passphraseChoiceHandler: (() => Promise<OneKeyPassphraseChoice | 'cancel'>) | null = null

export function setOneKeyPassphraseChoiceHandler(
  handler: (() => Promise<OneKeyPassphraseChoice | 'cancel'>) | null,
): void {
  passphraseChoiceHandler = handler
}

function clearPassphraseSession(): void {
  sessionPassphraseState = undefined
  sessionUseEmptyPassphrase = false
  lockedPassphraseChoice = null
  choiceInFlight = null
  pendingExistsAttachPinUser = false
  passphrasePhase = 'idle'
  passphraseUiAnswered = false
  activeWalletLabel = null
  passphraseChoiceGeneration += 1
}

function beginConnectAttempt(): void {
  clearPassphraseSession()
  pinPromptedDuringConnect = false
}

function resetSdkSession(): void {
  try {
    hardwareSdk?.dispose?.()
  } catch {
    /* ignore */
  }
  hardwareSdk = null
  sdkReady = null
  sdkLink = null
  uiHandlersBound = false
  beginConnectAttempt()
}

/** Pass session flags on wallet calls after unlock — same as OneKey App session reuse. */
export function walletSessionParams(): Record<string, unknown> {
  if (sessionPassphraseState) {
    // passphraseState alone — do not set skipPassphraseCheck (re-opens UI and we
    // used to answer "standard") or initSession on every call (clears the session).
    return { passphraseState: sessionPassphraseState }
  }
  // Never return {} — without useEmptyPassphrase the SDK opens REQUEST_PASSPHRASE
  // (device passphrase keyboard) whenever passphrase_protection is on.
  return { useEmptyPassphrase: true }
}

function applyPassphraseStateResult(state: unknown): void {
  if (typeof state === 'string' && state.trim()) {
    sessionPassphraseState = state.trim()
    sessionUseEmptyPassphrase = false
    return
  }
  if (state && typeof state === 'object') {
    const obj = state as { passphraseState?: unknown; payload?: unknown }
    if (typeof obj.passphraseState === 'string' && obj.passphraseState.trim()) {
      sessionPassphraseState = obj.passphraseState.trim()
      sessionUseEmptyPassphrase = false
      return
    }
    if (typeof obj.payload === 'string' && obj.payload.trim()) {
      sessionPassphraseState = obj.payload.trim()
      sessionUseEmptyPassphrase = false
    }
  }
}

function hasUsablePassphraseSession(): boolean {
  return Boolean(sessionPassphraseState || sessionUseEmptyPassphrase)
}

function normalizePassphraseChoice(raw: unknown): OneKeyPassphraseChoice {
  if (raw === 'standard') return 'standard'
  if (raw === 'hidden-pin') return 'hidden-pin'
  if (raw === 'temporary' || raw === 'on-device') return 'temporary'
  // Unknown / empty → standard. Defaulting to temporary opened the device keyboard.
  return 'standard'
}

async function ensureAppPassphraseChoice(): Promise<OneKeyPassphraseChoice> {
  if (lockedPassphraseChoice) return lockedPassphraseChoice
  if (!choiceInFlight) {
    const generation = passphraseChoiceGeneration
    passphrasePhase = 'choosing'
    choiceInFlight = (async () => {
      const raw = passphraseChoiceHandler ? await passphraseChoiceHandler() : 'standard'
      if (generation !== passphraseChoiceGeneration) {
        throw new Error('Cancelled')
      }
      if (raw === 'cancel') {
        requestHardwareCancel()
        throw new Error('Cancelled')
      }
      const choice = normalizePassphraseChoice(raw)
      if (generation !== passphraseChoiceGeneration) {
        throw new Error('Cancelled')
      }
      lockedPassphraseChoice = choice
      sessionUseEmptyPassphrase = choice === 'standard'
      return choice
    })().finally(() => {
      choiceInFlight = null
    })
  }
  return choiceInFlight
}

function respondPassphraseUi(sdk: HardwareSdk, choice: OneKeyPassphraseChoice): void {
  try {
    if (choice === 'standard') {
      sdk.uiResponse({
        type: 'ui-receive_passphrase',
        payload: { value: '', passphraseOnDevice: false, save: true },
      })
      return
    }
    if (choice === 'hidden-pin') {
      // Passphrase attached to PIN → device asks for the hidden PIN (e.g. 6 digits).
      sdk.uiResponse({
        type: 'ui-receive_passphrase',
        payload: {
          value: '',
          passphraseOnDevice: true,
          attachPinOnDevice: true,
          save: true,
        },
      })
      return
    }
    // Temporary passphrase → type on device (same idea as My address → arrows).
    // Never set attachPinOnDevice here — that forces the 6-digit hidden PIN path.
    sdk.uiResponse({
      type: 'ui-receive_passphrase',
      payload: {
        value: '',
        passphraseOnDevice: true,
        attachPinOnDevice: false,
        save: true,
      },
    })
  } catch {
    /* ignore */
  }
}

function devicePromptMessage(choice: OneKeyPassphraseChoice): string {
  if (choice === 'hidden-pin') return 'Enter the hidden PIN on your OneKey…'
  if (choice === 'temporary') return 'Enter the temporary passphrase on your OneKey…'
  return 'Unlocking standard wallet on OneKey…'
}

/** Same-line label for Standard / Temporary / Hidden PIN (never mixed with Confirm…). */
export function activeWalletProgressMessage(choice: OneKeyPassphraseChoice): string {
  if (choice === 'hidden-pin') return 'Active wallet: Hidden PIN'
  if (choice === 'temporary') return 'Active wallet: Temporary'
  return 'Active wallet: Standard'
}

function announceActiveWallet(
  choice: OneKeyPassphraseChoice,
  onProgress?: (p: OneKeyScanProgress) => void,
): void {
  activeWalletLabel = choice
  onProgress?.({ status: 'connecting', message: activeWalletProgressMessage(choice) })
}

export function getOneKeyActiveWalletLabel(): OneKeyPassphraseChoice | null {
  return activeWalletLabel
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function unlockChosenPassphraseMode(
  sdk: HardwareSdk,
  connectId: string,
  choice: OneKeyPassphraseChoice,
  onProgress?: (p: OneKeyScanProgress) => void,
): Promise<void> {
  lockedPassphraseChoice = choice
  passphraseUiAnswered = false

  if (choice === 'standard') {
    // Never enter phase 'device' for Standard — that path can answer on_device.
    sessionPassphraseState = undefined
    sessionUseEmptyPassphrase = true
    passphrasePhase = 'ready'
    announceActiveWallet('standard', onProgress)
    await sleepMs(900)
    return
  }

  // Temporary / Hidden PIN: exactly one on-device entry, then hold Active wallet line.
  passphrasePhase = 'device'
  sessionPassphraseState = undefined
  sessionUseEmptyPassphrase = false
  onProgress?.({ status: 'connecting', message: devicePromptMessage(choice) })
  await callGetPassphraseState(
    sdk,
    connectId,
    { initSession: true },
    choice === 'hidden-pin'
      ? 'OneKey getPassphraseState (hidden-pin)'
      : 'OneKey getPassphraseState (temporary)',
    180000,
  )
  if (!sessionPassphraseState) {
    throw new Error(
      choice === 'hidden-pin'
        ? 'OneKey did not return a hidden-PIN session. Enter the hidden PIN on the device, then try again.'
        : 'OneKey did not return a temporary-passphrase session. Enter the passphrase on the device, then try again.',
    )
  }
  sessionUseEmptyPassphrase = false
  passphrasePhase = 'ready'
  announceActiveWallet(choice, onProgress)
  await sleepMs(1100)
}

async function callGetPassphraseState(
  sdk: HardwareSdk,
  connectId: string,
  params: Record<string, unknown>,
  label: string,
  timeoutMs: number,
): Promise<string | undefined> {
  passphraseUiAnswered = false
  const state = unwrap(
    (await withTimeout(
      sdk.getPassphraseState!(connectId, params) as Promise<SdkResponse<string | undefined>>,
      timeoutMs,
      label,
    )) as SdkResponse<string | undefined>,
    label,
  )
  applyPassphraseStateResult(state)
  return typeof state === 'string' ? state : undefined
}

/**
 * Silent adopt only for an already-unlocked hidden-PIN session.
 */
async function tryAdoptUnlockedHiddenPin(
  sdk: HardwareSdk,
  connectId: string,
  features: OneKeyFeatures,
  onProgress?: (p: OneKeyScanProgress) => void,
): Promise<boolean> {
  if (!features.unlocked || pinPromptedDuringConnect) return false
  if (features.unlocked_attach_pin !== true) return false
  if (typeof sdk.getPassphraseState !== 'function') return false

  lockedPassphraseChoice = 'hidden-pin'
  sessionUseEmptyPassphrase = false
  passphrasePhase = 'device'
  pendingExistsAttachPinUser = true
  onProgress?.({
    status: 'connecting',
    message: 'Using the hidden PIN wallet already unlocked on OneKey…',
  })
  try {
    await callGetPassphraseState(
      sdk,
      connectId,
      { initSession: true },
      'OneKey getPassphraseState (unlocked hidden-pin)',
      60000,
    )
  } catch {
    clearPassphraseSession()
    return false
  }
  if (!hasUsablePassphraseSession()) {
    clearPassphraseSession()
    return false
  }
  passphrasePhase = 'ready'
  return true
}

/**
 * Policy:
 * - requireWalletChoice (Sign): always SeedMask Standard / Temporary / Hidden PIN when
 *   passphrase_protection is on — never auto-assume Standard.
 * - Import / unlocked: Unlocked (no PIN this connect) → standard silently.
 * - After PIN (import): SeedMask choice; Temporary prompts once on device.
 * - Never open on-device passphrase during getFeatures.
 */
async function ensurePassphraseSession(
  sdk: HardwareSdk,
  connectId: string,
  features: OneKeyFeatures,
  onProgress?: (p: OneKeyScanProgress) => void,
  options?: { requireWalletChoice?: boolean },
): Promise<void> {
  if (!features.passphrase_protection) {
    // Still force useEmptyPassphrase on later wallet calls — never leave session empty.
    sessionPassphraseState = undefined
    sessionUseEmptyPassphrase = true
    lockedPassphraseChoice = 'standard'
    passphrasePhase = 'ready'
    return
  }
  if (typeof sdk.getPassphraseState !== 'function') {
    throw new Error('OneKey SDK is missing getPassphraseState')
  }

  pendingExistsAttachPinUser = features.attach_to_pin_user === true

  // Sign (and any requireWalletChoice caller): always ask — do not auto-standard.
  if (options?.requireWalletChoice) {
    onProgress?.({
      status: 'connecting',
      message: 'Choose Standard, Temporary passphrase, or Hidden PIN in SeedMask…',
    })
    const choice = await ensureAppPassphraseChoice()
    await unlockChosenPassphraseMode(sdk, connectId, choice, onProgress)
    return
  }

  if (await tryAdoptUnlockedHiddenPin(sdk, connectId, features, onProgress)) {
    announceActiveWallet('hidden-pin', onProgress)
    await sleepMs(900)
    return
  }

  // Already unlocked on standard PIN path — never call getPassphraseState here
  // (even with useEmptyPassphrase it randomly opened the device passphrase keyboard).
  if (features.unlocked && !pinPromptedDuringConnect && features.unlocked_attach_pin !== true) {
    lockedPassphraseChoice = 'standard'
    sessionPassphraseState = undefined
    sessionUseEmptyPassphrase = true
    passphrasePhase = 'ready'
    announceActiveWallet('standard', onProgress)
    await sleepMs(900)
    return
  }

  // PIN was entered this connect — sessions cleared; ask explicitly.
  onProgress?.({
    status: 'connecting',
    message: 'Choose Standard, Temporary passphrase, or Hidden PIN in SeedMask…',
  })
  const choice = await ensureAppPassphraseChoice()
  await unlockChosenPassphraseMode(sdk, connectId, choice, onProgress)
}

function setActiveProgress(
  onProgress?: (p: OneKeyScanProgress | OneKeySignProgress) => void,
): void {
  activeProgress = onProgress
}

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest()
}

type OneKeyHdNode = {
  depth?: number
  fingerprint?: number
  child_num?: number
  chain_code?: string
  public_key?: string
}

type OneKeyPublicKeyPayload = {
  path?: string
  root_fingerprint?: number
  node?: OneKeyHdNode
  xpub?: string
}

/**
 * Export HD nodes via BatchGetPublickeys (ignoreCoinType).
 * A plain btcGetPublicKey call falls back to GetPublicKey + coin_name Bitcoin,
 * which mis-handles Kaspa paths for account index ≠ 0 on OneKey Pro.
 */
async function getKaspaHdNodes(
  sdk: HardwareSdk,
  connectId: string,
  deviceId: string,
  paths: string[],
): Promise<OneKeyPublicKeyPayload[]> {
  const res = (await sdk.btcGetPublicKey(connectId, deviceId, {
    bundle: paths.map((path) => ({
      path,
      coin: 'btc',
      showOnOneKey: false,
    })),
    ...walletSessionParams(),
  })) as SdkResponse<OneKeyPublicKeyPayload[] | OneKeyPublicKeyPayload>

  const payload = unwrap(res, 'OneKey Kaspa public keys')
  const list = Array.isArray(payload) ? payload : [payload]
  if (list.length !== paths.length) {
    throw new Error(`OneKey returned ${list.length} HD node(s), expected ${paths.length}`)
  }
  return list
}

function b58encode(payload: Buffer): string {
  let zeros = 0
  while (zeros < payload.length && payload[zeros] === 0) zeros += 1
  const digits = [0]
  for (let i = zeros; i < payload.length; i++) {
    let carry = payload[i]!
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = '1'.repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]!]
  return out
}

function b58checkEncode(payload: Buffer): string {
  const checksum = sha256(sha256(payload)).subarray(0, 4)
  return b58encode(Buffer.concat([payload, checksum]))
}

function buildKpub(params: {
  depth: number
  parentFingerprint: Buffer
  childNumber: number
  chainCode: Buffer
  compressed: Buffer
}): string {
  const payload = Buffer.alloc(78)
  KASPA_KPUB_VERSION.copy(payload, 0)
  payload[4] = params.depth
  params.parentFingerprint.copy(payload, 5)
  payload.writeUInt32BE(params.childNumber >>> 0, 9)
  params.chainCode.copy(payload, 13)
  params.compressed.copy(payload, 45)
  return b58checkEncode(payload)
}

export function unwrap<T>(res: SdkResponse<T>, label: string): T {
  if (res?.success) return res.payload
  const err = res?.payload?.error || 'unknown error'
  const code = res?.payload?.code
  throw new Error(code != null ? `${label}: ${err} (${code})` : `${label}: ${err}`)
}

export function normalizeFingerprint(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return (raw >>> 0).toString(16).toUpperCase().padStart(8, '0')
  }
  const s = String(raw ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase()
  if (s.length >= 8) return s.slice(0, 8)
  if (s.length > 0) return s.padStart(8, '0')
  return ''
}

export function hexToBuffer(hex: string, label: string): Buffer {
  const clean = hex.replace(/^0x/i, '').replace(/\s+/g, '')
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error(`Invalid ${label} hex from OneKey`)
  }
  return Buffer.from(clean, 'hex')
}

function compressedFromOneKeyPub(publicKeyHex: string): Buffer {
  const raw = hexToBuffer(publicKeyHex, 'public key')
  if (raw.length === 33 && (raw[0] === 0x02 || raw[0] === 0x03)) return raw
  if (raw.length === 65 && raw[0] === 0x04) {
    const x = raw.subarray(1, 33)
    const yParity = raw[64]! & 1
    return Buffer.concat([Buffer.from([0x02 + yParity]), x])
  }
  if (raw.length === 32) {
    // x-only — assume even y (BIP340); rare for GetPublicKey
    return Buffer.concat([Buffer.from([0x02]), raw])
  }
  throw new Error(`Unexpected OneKey public key length (${raw.length})`)
}

function normalizeKaspaAddr(addr: string): string {
  return addr.trim().toLowerCase().replace(/\s+/g, '')
}

/** Derive receive address at index from kpub (same as SeedMask Addresses tab). */
async function deriveReceiveIndexFromKpub(kpub: string, receiveIndex: number): Promise<string> {
  const python = resolvePython(findCoordinatorRoot())
  const script = [
    'from kaspa import PublicKeyGenerator, NetworkType',
    'import sys',
    'kpub = sys.argv[1]',
    'idx = int(sys.argv[2])',
    'addr = PublicKeyGenerator.from_xpub(kpub).receive_pubkey(idx).to_address(NetworkType.Mainnet)',
    'print(str(addr))',
  ].join('; ')
  try {
    const { stdout } = await execFileAsync(python, ['-c', script, kpub, String(receiveIndex)], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    })
    const addr = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
    if (!addr.startsWith('kaspa:')) {
      throw new Error(`Unexpected address from kpub: ${addr || '(empty)'}`)
    }
    return addr
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(`Could not derive receive address from OneKey kpub: ${detail}`)
  }
}

async function deriveChangeIndexFromKpub(kpub: string, changeIndex: number): Promise<string> {
  const python = resolvePython(findCoordinatorRoot())
  const script = [
    'from kaspa import PublicKeyGenerator, NetworkType',
    'import sys',
    'kpub = sys.argv[1]',
    'idx = int(sys.argv[2])',
    'addr = PublicKeyGenerator.from_xpub(kpub).change_pubkey(idx).to_address(NetworkType.Mainnet)',
    'print(str(addr))',
  ].join('; ')
  try {
    const { stdout } = await execFileAsync(python, ['-c', script, kpub, String(changeIndex)], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    })
    const addr = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
    if (!addr.startsWith('kaspa:')) {
      throw new Error(`Unexpected change address from kpub: ${addr || '(empty)'}`)
    }
    return addr
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(`Could not derive change address from wallet kpub: ${detail}`)
  }
}

async function resolveExpectedSignAddress(
  unsigned: UnsignedKaspaV2,
  input: NonNullable<UnsignedKaspaV2['inputs']>[number],
): Promise<string> {
  const fromInput = String(input.receive_address || '').trim()
  if (fromInput.toLowerCase().startsWith('kaspa:')) return fromInput

  const kpub = String(unsigned.kpub || '').trim()
  if (!kpub) {
    throw new Error(
      'Cannot verify OneKey wallet — rebuild the transaction (missing address/kpub on unsigned tx).',
    )
  }
  const chain = Math.trunc(Number(input.sign_chain ?? 0))
  const index = Math.trunc(Number(input.sign_address_index ?? 0))
  return chain === 0
    ? deriveReceiveIndexFromKpub(kpub, index)
    : deriveChangeIndexFromKpub(kpub, index)
}

/**
 * Confirm the active OneKey passphrase wallet matches this SeedMask wallet before
 * signing — rejects Standard-vs-Hidden (and Temporary) mismatches.
 */
async function assertOneKeyMatchesWallet(
  sdk: HardwareSdk,
  connectId: string,
  deviceId: string,
  path: string,
  expectedAddress: string,
  onProgress?: (p: OneKeySignProgress) => void,
): Promise<void> {
  const expected = normalizeKaspaAddr(expectedAddress)
  if (!expected.includes('kaspa:')) {
    throw new Error('Cannot verify OneKey wallet — missing expected Kaspa address for this transaction')
  }
  onProgress?.({
    status: 'connecting',
    message: 'Checking this OneKey matches the SeedMask wallet…',
  })
  const addr = unwrap(
    (await sdk.kaspaGetAddress(connectId, deviceId, {
      path,
      showOnOneKey: false,
      prefix: 'kaspa',
      scheme: 'schnorr',
      useTweak: false,
      ...walletSessionParams(),
    })) as SdkResponse<{ address?: string }>,
    'OneKey kaspaGetAddress (wallet check)',
  )
  const deviceOfficial = normalizeKaspaAddr(String(addr.address || ''))
  if (!deviceOfficial.includes('kaspa:')) {
    throw new Error('OneKey did not return an address for wallet verification')
  }
  if (deviceOfficial !== expected) {
    const mode = activeWalletLabel || lockedPassphraseChoice || 'selected'
    throw new Error(
      `This OneKey wallet does not match the SeedMask wallet (chose ${mode}).\n` +
        `SeedMask expects: ${expectedAddress}\n` +
        `OneKey returned: ${addr.address}\n` +
        'Pick the same mode used when you imported this wallet (Standard, Temporary, or Hidden PIN).',
    )
  }
}

function bindUiHandlers(sdk: HardwareSdk): void {
  if (uiHandlersBound) return
  uiHandlersBound = true
  sdk.on('UI_EVENT', (message: UiEventMessage) => {
    const type = String(message?.type || '')
    if (type === 'ui-request_pin') {
      pinPromptedDuringConnect = true
      activeProgress?.({
        status: 'connecting',
        message: 'Enter PIN on your OneKey device…',
      } as OneKeyScanProgress)
      try {
        sdk.uiResponse({ type: 'ui-receive_pin', payload: PIN_ON_DEVICE })
      } catch {
        /* ignore */
      }
      return
    }
    if (type === 'ui-request_passphrase') {
      pendingExistsAttachPinUser = Boolean(message?.payload?.existsAttachPinUser)

      // Only Temporary / Hidden PIN unlock may open the on-device keyboard — once.
      const allowOnDevice =
        passphrasePhase === 'device' &&
        lockedPassphraseChoice != null &&
        lockedPassphraseChoice !== 'standard' &&
        !passphraseUiAnswered

      if (allowOnDevice) {
        passphraseUiAnswered = true
        activeProgress?.({
          status: 'connecting',
          message: devicePromptMessage(lockedPassphraseChoice!),
        } as OneKeyScanProgress)
        respondPassphraseUi(sdk, lockedPassphraseChoice!)
        return
      }

      // Temporary/hidden session already established — do not empty-ack (would switch wallet).
      if (passphrasePhase === 'ready' && sessionPassphraseState) {
        return
      }

      // Standard, choosing, idle, ready-standard: empty host ack only.
      respondPassphraseUi(sdk, 'standard')
      return
    }
    if (type === 'ui-request_passphrase_on_device') {
      // Progress only — answering again caused a 2nd/3rd passphrase entry.
      if (lockedPassphraseChoice && lockedPassphraseChoice !== 'standard') {
        activeProgress?.({
          status: 'connecting',
          message: devicePromptMessage(lockedPassphraseChoice),
        } as OneKeyScanProgress)
      }
      return
    }
    if (type === 'ui-button') {
      activeProgress?.({
        status: 'confirm',
        message: 'Confirm on your OneKey device…',
      } as OneKeyScanProgress)
    }
  })
}

export async function ensureSdk(
  onProgress?: (p: OneKeyScanProgress | OneKeySignProgress) => void,
  link: HwLink = 'usb',
): Promise<HardwareSdk> {
  setActiveProgress(onProgress)
  if (sdkLink && sdkLink !== link) {
    resetSdkSession()
  }
  const sdk = loadHardwareSdk()
  bindUiHandlers(sdk)
  if (!sdkReady) {
    sdkReady = (async () => {
      if (link === 'ble') {
        installOneKeyBleDesktopApi()
        const power = await ensureBluetoothPoweredOn()
        if (!power.ok) {
          throw new Error(
            power.error ||
              (power.state === 'unsupported'
                ? 'Bluetooth LE is not supported on this Mac.'
                : BLUETOOTH_OFF_MESSAGE),
          )
        }
      }
      const ok = await sdk.init({
        env: link === 'ble' ? 'desktop-web-ble' : 'node-usb',
        debug: false,
        fetchConfig: true,
      })
      if (ok === false) {
        throw new Error(
          link === 'ble'
            ? 'OneKey Bluetooth transport failed to initialize.'
            : 'OneKey USB transport failed to initialize.',
        )
      }
      sdkLink = link
    })().catch((e) => {
      sdkReady = null
      sdkLink = null
      throw e
    })
  }
  await sdkReady
  return sdk
}

function deviceLabel(deviceType: string | undefined, name: string | undefined): string {
  const t = (deviceType || '').trim()
  const n = (name || '').trim()
  if (n && t) return `${n} (${t})`
  return n || t || 'OneKey'
}

export async function listOneKeyUsbDevices(): Promise<
  Array<{ path: string; product: string; vendorId: number; productId: number }>
> {
  const sdk = await ensureSdk(undefined, 'usb')
  const res = unwrap(
    (await sdk.searchDevices()) as SdkResponse<
      Array<{
        connectId?: string | null
        name?: string
        deviceType?: string
        deviceId?: string | null
        commType?: string
      }>
    >,
    'OneKey searchDevices',
  )
  return (res || [])
    .filter((d) => d.connectId)
    .filter((d) => {
      const comm = String(d.commType || '').toLowerCase()
      // Prefer USB; allow unknown/missing (node-usb searches USB).
      return !comm || comm.includes('usb') || comm === 'webusb'
    })
    .map((d, index) => ({
      path: String(d.connectId),
      product: deviceLabel(d.deviceType, d.name) || `OneKey ${index + 1}`,
      vendorId: 0x1209,
      productId: 0,
    }))
}

export async function listOneKeyBleDevices(): Promise<
  Array<{ path: string; product: string; vendorId: number; productId: number }>
> {
  const power = await ensureBluetoothPoweredOn()
  if (!power.ok) {
    throw new Error(
      power.error ||
        (power.state === 'unsupported'
          ? 'Bluetooth LE is not supported on this Mac.'
          : BLUETOOTH_OFF_MESSAGE),
    )
  }
  const ble = getOneKeyNobleBleApi()
  const devices = await ble.enumerate()
  if (!devices.length) {
    const diag = getLastBleScanDiagnostics()
    const seenHint =
      diag.seen === 0
        ? ' SeedMask saw zero Bluetooth advertisements — check System Settings → Privacy & Security → Bluetooth and allow SeedMask Coordinator (close OneKey App too).'
        : ` Bluetooth saw ${diag.seen} advertisement(s)${diag.names.length ? ` (${diag.names.join(', ')})` : ''}, but none looked like a OneKey.`
    throw new Error(
      'No OneKey found over Bluetooth. Unlock the OneKey Pro, open Bluetooth / pairing on the device, stay nearby, then try again.' +
        seenHint +
        ' Do not pair it from macOS Bluetooth settings — connect only from SeedMask. If it already shows under System Settings → Bluetooth, Forget Device, then retry here.',
    )
  }
  return devices.map((d, index) => ({
    path: d.id,
    product: d.name || `OneKey ${index + 1}`,
    vendorId: 0x1209,
    productId: 0,
  }))
}

export { ensureBluetoothPoweredOn, requestHardwareCancel, clearHardwareCancel, isHardwareCancelRequested }

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out (${Math.round(ms / 1000)}s)`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

export async function pickDevice(
  devicePath?: string,
  link: HwLink = 'usb',
  onProgress?: (p: OneKeyScanProgress) => void,
  opts?: { requireWalletChoice?: boolean },
): Promise<{
  connectId: string
  deviceId: string
  product: string
  sdk: HardwareSdk
  activeWallet: OneKeyPassphraseChoice | null
}> {
  if (isHardwareCancelRequested()) throw new Error('Cancelled')
  const sdk = await ensureSdk(onProgress, link)
  let chosen: { path: string; product: string }

  if (link === 'ble') {
    const ble = getOneKeyNobleBleApi()
    if (devicePath) {
      let known = await ble.getDevice(devicePath)
      if (!known) {
        onProgress?.({ status: 'scanning', message: 'Re-scanning for OneKey over Bluetooth…' })
        await listOneKeyBleDevices()
        known = await ble.getDevice(devicePath)
      }
      if (!known) {
        throw new Error(
          'OneKey Bluetooth device was lost. Unlock it, enable Bluetooth on the device, stay nearby, and try again.',
        )
      }
      chosen = { path: devicePath, product: known.name }
    } else {
      const listed = await listOneKeyBleDevices()
      chosen = { path: listed[0]!.path, product: listed[0]!.product }
    }
    onProgress?.({
      status: 'connecting',
      message: `Connecting to ${chosen.product}… Confirm any prompt on OneKey.`,
    })
  } else {
    const listed = await listOneKeyUsbDevices()
    if (!listed.length) {
      throw new Error(
        'No OneKey found. Plug in via USB, unlock it, then try again. Close the OneKey App and OneKey Bridge if they are open.',
      )
    }
    const hit = (devicePath ? listed.find((d) => d.path === devicePath) : undefined) || listed[0]!
    chosen = { path: hit.path, product: hit.product }
  }

  if (isHardwareCancelRequested()) throw new Error('Cancelled')
  beginConnectAttempt()
  // useEmptyPassphrase so Initialize never opens the passphrase keyboard "for no reason".
  const features = unwrap(
    (await withTimeout(
      sdk.getFeatures(chosen.path, { useEmptyPassphrase: true }) as Promise<
        SdkResponse<OneKeyFeatures>
      >,
      link === 'ble' ? 45000 : 30000,
      'OneKey getFeatures',
    )) as SdkResponse<OneKeyFeatures>,
    'OneKey getFeatures',
  )
  const deviceId = String(features.device_id || '').trim()
  if (!deviceId) throw new Error('OneKey did not return a device_id — unlock the device and try again')
  await ensurePassphraseSession(sdk, chosen.path, features, onProgress, {
    requireWalletChoice: opts?.requireWalletChoice === true,
  })
  return {
    connectId: chosen.path,
    deviceId,
    product: chosen.product,
    sdk,
    activeWallet: activeWalletLabel,
  }
}

export async function importKaspaWatchOnlyFromOneKey(options?: {
  /**
   * accountMode=onekey-app: OneKey App “Account #N” (1-based) → receive index N-1 under 0'.
   * accountMode=bip44: BIP44 account index (0-based) → m/44'/111111'/N'.
   */
  account?: number
  accountMode?: OneKeyAccountMode
  devicePath?: string
  link?: HwLink
  onProgress?: (p: OneKeyScanProgress) => void
}): Promise<OneKeyKaspaImportResult> {
  const accountMode: OneKeyAccountMode = options?.accountMode === 'bip44' ? 'bip44' : 'onekey-app'
  const link: HwLink = options?.link === 'ble' ? 'ble' : 'usb'
  const progress = options?.onProgress

  let bip44Account = 0
  let receiveIndex = 0
  let oneKeyAccountLabel = 1
  if (accountMode === 'onekey-app') {
    oneKeyAccountLabel = Math.max(1, Math.min(0x7fffffff, options?.account ?? 1))
    receiveIndex = oneKeyAccountLabel - 1
    bip44Account = 0
  } else {
    bip44Account = Math.max(0, Math.min(0x7fffffff, options?.account ?? 0))
    receiveIndex = 0
  }

  progress?.({
    status: 'scanning',
    message: link === 'ble' ? 'Scanning for OneKey over Bluetooth…' : 'Looking for OneKey devices…',
  })

  try {
    clearHardwareCancel()
    await ensureSdk(progress, link)
    if (isHardwareCancelRequested()) throw new Error('Cancelled')
    progress?.({
      status: 'connecting',
      message:
        link === 'ble'
          ? 'Connecting to OneKey over Bluetooth… Confirm any prompt on the device.'
          : 'Connecting to OneKey…',
    })
    const device = await pickDevice(options?.devicePath, link, progress)
    const { sdk } = device
    // Hold Active wallet line one more beat (esp. Temporary after passphrase entry).
    if (device.activeWallet) {
      progress?.({
        status: 'connecting',
        message: activeWalletProgressMessage(device.activeWallet),
      })
      await sleepMs(1000)
    }
    progress?.({ status: 'connecting', message: `Connected to ${device.product}` })

    const accountPath = `m/44'/111111'/${bip44Account}'`
    const receivePath = `m/44'/111111'/${bip44Account}'/0/${receiveIndex}`
    progress?.({
      status: 'confirm',
      message:
        accountMode === 'onekey-app'
          ? `Confirm OneKey App Account #${oneKeyAccountLabel} (Kaspa Official: ${receivePath}). ` +
            'Use Kaspa Official — not the default “Kaspa OneKey” (tweaked).'
          : `Confirm Standard account ${bip44Account} receive #0 (Kaspa Official: ${receivePath}). ` +
            'Use Kaspa Official — not the default “Kaspa OneKey” (tweaked).',
    })
    // useTweak:false = Kaspa Official (raw BIP32 Schnorr). Default “Kaspa OneKey” is tweaked.
    const addr = unwrap(
      (await sdk.kaspaGetAddress(device.connectId, device.deviceId, {
        path: receivePath,
        showOnOneKey: true,
        prefix: 'kaspa',
        scheme: 'schnorr',
        useTweak: false,
        ...walletSessionParams(),
      })) as SdkResponse<{ address?: string }>,
      'OneKey kaspaGetAddress',
    )
    const deviceOfficial = String(addr.address || '').trim()
    if (!deviceOfficial.startsWith('kaspa:')) {
      throw new Error('OneKey did not return a Kaspa Official receive address — update firmware and try again')
    }

    progress?.({
      status: 'reading',
      message: `Reading OneKey kpub (${accountPath})…`,
    })
    const [accountPub] = await getKaspaHdNodes(sdk, device.connectId, device.deviceId, [accountPath])

    const node = accountPub.node
    if (!node?.public_key || !node.chain_code) {
      throw new Error('OneKey did not return a public key / chain code for the Kaspa account path')
    }
    const compressed = compressedFromOneKeyPub(node.public_key)
    const chainCode = hexToBuffer(node.chain_code, 'chain code')
    if (chainCode.length !== 32) throw new Error('Expected 32-byte chain code from OneKey')

    const parentFpNum = Number(node.fingerprint ?? 0) >>> 0
    const parentFingerprint = Buffer.alloc(4)
    parentFingerprint.writeUInt32BE(parentFpNum)

    const kpub = buildKpub({
      depth: 3,
      parentFingerprint,
      childNumber: (bip44Account + 0x80000000) >>> 0,
      chainCode,
      compressed,
    })

    const derived = await deriveReceiveIndexFromKpub(kpub, receiveIndex)
    if (normalizeKaspaAddr(derived) !== normalizeKaspaAddr(deviceOfficial)) {
      throw new Error(
        `Address mismatch for OneKey${accountMode === 'onekey-app' ? ` Account #${oneKeyAccountLabel}` : ` account ${bip44Account}`}.\n` +
          `Device (Official): ${deviceOfficial}\n` +
          `SeedMask: ${derived}\n` +
          `Path: ${receivePath}\n` +
          `Make sure this is Kaspa Official (not “Kaspa OneKey”).`,
      )
    }

    let fingerprint = normalizeFingerprint(accountPub.root_fingerprint)
    if (!fingerprint) {
      fingerprint = normalizeFingerprint(parentFpNum)
    }

    // Always store the account-level path/kpub — never a single receive path as the wallet root.
    const derivation = accountPath
    const label =
      accountMode === 'onekey-app'
        ? oneKeyAccountLabel === 1
          ? 'OneKey'
          : `OneKey Account #${oneKeyAccountLabel}`
        : bip44Account === 0
          ? 'OneKey'
          : `OneKey account ${bip44Account}`

    progress?.({
      status: 'done',
      message:
        accountMode === 'onekey-app'
          ? `OneKey App Account #${oneKeyAccountLabel} = SeedMask Receive #${receiveIndex}`
          : `OneKey Standard account ${bip44Account} ready`,
    })
    return {
      kpub,
      fingerprint,
      derivation,
      account: bip44Account,
      label,
      hardware: 'onekey',
      deviceModel: device.product,
      accountMode,
      verifiedReceiveIndex: receiveIndex,
      verifiedReceiveAddressHint:
        accountMode === 'onekey-app'
          ? `OneKey App Account #${oneKeyAccountLabel} = SeedMask Receive #${receiveIndex}: ${deviceOfficial}`
          : `Standard account ${bip44Account} receive #0: ${deviceOfficial}`,
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    progress?.({ status: 'error', message })
    throw e instanceof Error ? e : new Error(message)
  }
}

export async function signKaspaUnsignedWithOneKey(options: {
  unsigned: UnsignedKaspaV2
  devicePath?: string
  link?: HwLink
  onProgress?: (p: OneKeySignProgress) => void
}): Promise<{
  version: number
  network: string
  account: number
  draft_hash?: string
  signatures: Array<{ input_index: number; sig_hex: string }>
}> {
  const unsigned = options.unsigned
  const inputs = unsigned.inputs ?? []
  const outputs = unsigned.outputs ?? []
  if (!inputs.length) throw new Error('Unsigned transaction has no inputs')
  if (!outputs.length) throw new Error('Unsigned transaction has no outputs')

  const account = Math.max(0, Math.trunc(Number(unsigned.account ?? 0)))
  const link: HwLink = options.link === 'ble' ? 'ble' : 'usb'
  // Always clear sticky cancel from a previous Cancel / dialog dismiss so retry works.
  clearHardwareCancel()
  options.onProgress?.({
    status: 'scanning',
    message: link === 'ble' ? 'Scanning for OneKey over Bluetooth…' : 'Looking for OneKey…',
  })

  try {
    await ensureSdk(options.onProgress, link)
    if (isHardwareCancelRequested()) throw new Error('Cancelled')
    const device = await pickDevice(options.devicePath, link, options.onProgress, {
      requireWalletChoice: true,
    })
    const { sdk } = device
    options.onProgress?.({
      status: 'connecting',
      message: `Connecting to ${device.product}…`,
    })

    const firstInput = inputs[0]!
    const verifyPath = `m/44'/111111'/${account}'/${Math.trunc(Number(firstInput.sign_chain ?? 0))}/${Math.trunc(Number(firstInput.sign_address_index ?? 0))}`
    const expectedAddress = await resolveExpectedSignAddress(unsigned, firstInput)
    await assertOneKeyMatchesWallet(
      sdk,
      device.connectId,
      device.deviceId,
      verifyPath,
      expectedAddress,
      options.onProgress,
    )

    const sdkInputs = inputs.map((input) => {
      const chain = Math.trunc(Number(input.sign_chain ?? 0))
      const index = Math.trunc(Number(input.sign_address_index ?? 0))
      const path = `m/44'/111111'/${account}'/${chain}/${index}`
      const sigOpCount = Math.max(1, Math.trunc(Number(input.sig_op_count ?? 1)))
      return {
        path,
        prevTxId: String(input.prev_tx_id ?? '').replace(/^0x/i, '').toLowerCase(),
        outputIndex: Math.trunc(Number(input.prev_index ?? 0)),
        sequenceNumber: String(Math.trunc(Number(input.sequence ?? 0))),
        sigOpCount,
        output: {
          satoshis: String(Math.trunc(Number(input.utxo_amount ?? 0))),
          script: normalizeKaspaScriptHex(String(input.utxo_script_hex ?? '')),
        },
      }
    })

    // OneKey Kaspa firmware: confirm_blind_sign (address + View Data) once per unique
    // spending path, then Slide to Sign. BIP44 wallets often spend from several
    // receive/change addresses → more confirms than a single OneKey App account.
    const uniquePaths = new Set(sdkInputs.map((i) => i.path)).size
    options.onProgress?.({
      status: 'signing',
      message:
        uniquePaths <= 1
          ? 'On OneKey: confirm the spending address, view data, then Slide to Sign…'
          : `On OneKey: confirm each of ${uniquePaths} spending addresses (address + data each), then Slide to Sign…`,
    })

    const sdkOutputs = outputs.map((output) => ({
      satoshis: String(Math.trunc(Number(output.value ?? 0))),
      script: normalizeKaspaScriptHex(String(output.script_hex ?? '')),
      scriptVersion: Math.trunc(Number(output.script_version ?? 0)),
    }))

    const signed = unwrap(
      (await sdk.kaspaSignTransaction(device.connectId, device.deviceId, {
        version: Math.trunc(Number(unsigned.tx_version ?? 0)),
        inputs: sdkInputs,
        outputs: sdkOutputs,
        lockTime: String(Math.trunc(Number(unsigned.lock_time ?? 0))),
        sigHashType: 1, // Kaspa SIGHASH_ALL (not Bitcoin FORKID)
        sigOpCount: Math.max(1, Math.trunc(Number(inputs[0]?.sig_op_count ?? 1))),
        scheme: 'schnorr',
        prefix: 'kaspa',
        // Must match SeedMask untweaked Schnorr P2PK (bip340_sign_internal on device).
        useTweak: false,
        ...walletSessionParams(),
      })) as SdkResponse<Array<{ index?: number; signature?: string }>>,
      'OneKey kaspaSignTransaction',
    )

    const signatures = (signed || []).map((s) => {
      const sigHex = String(s.signature ?? '')
        .replace(/^0x/i, '')
        .toLowerCase()
      if (sigHex.length !== 128) {
        throw new Error(
          `Expected 64-byte OneKey signature (128 hex chars), got ${sigHex.length / 2} bytes for input ${s.index}`,
        )
      }
      return {
        input_index: Math.trunc(Number(s.index ?? 0)),
        sig_hex: sigHex,
      }
    })

    if (signatures.length !== inputs.length) {
      throw new Error(
        `OneKey returned ${signatures.length} signature(s) but the transaction has ${inputs.length} input(s)`,
      )
    }

    options.onProgress?.({ status: 'done', message: 'Signed on OneKey' })
    return {
      version: Math.trunc(Number(unsigned.version ?? 2)),
      network: 'mainnet',
      account,
      draft_hash: unsigned.draft_hash,
      signatures: signatures.sort((a, b) => a.input_index - b.input_index),
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    options.onProgress?.({ status: 'error', message })
    throw e instanceof Error ? e : new Error(message)
  }
}
