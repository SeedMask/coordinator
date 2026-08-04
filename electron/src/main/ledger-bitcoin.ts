/**
 * Ledger Bitcoin: watch-only import + PSBT signing (USB / BLE).
 * Uses the modern Bitcoin app client (`ledger-bitcoin`, CLA 0xe1).
 */
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { promisify } from 'util'
import { AppClient, DefaultWalletPolicy, WalletPolicy } from 'ledger-bitcoin'

import {
  listLedgerBleDevices,
  listLedgerUsbDevices,
  openChosenLedger,
  type LedgerScanProgress,
  type LedgerSignProgress,
} from './ledger-kaspa'
import { findCoordinatorRoot, resolvePython } from './paths'

const execFileAsync = promisify(execFile)

export type BitcoinScriptType = 'native_segwit' | 'nested_segwit' | 'legacy' | 'taproot'
export type BitcoinPolicyType = 'singlesig' | 'multisig'

export type LedgerBitcoinImportResult = {
  kpub: string
  fingerprint: string
  derivation: string
  account: number
  scriptType: BitcoinScriptType
  policyType: BitcoinPolicyType
  label: string
  hardware: 'ledger'
  deviceModel: string
  verifiedReceiveAddressHint: string
}

export type LedgerBitcoinCosigner = {
  xpub: string
  fingerprint?: string
  derivation?: string
  label?: string
}

type HwLink = 'usb' | 'ble'

type LedgerTransport = {
  send: (
    cla: number,
    ins: number,
    p1: number,
    p2: number,
    data?: Buffer,
  ) => Promise<Buffer>
  close: () => Promise<void> | void
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const XPUB_VERSIONS: Record<'xpub' | 'ypub' | 'zpub', Buffer> = {
  xpub: Buffer.from('0488B21E', 'hex'),
  ypub: Buffer.from('049D7CB2', 'hex'),
  zpub: Buffer.from('04B24746', 'hex'),
}

function purposeForScript(scriptType: BitcoinScriptType): number {
  if (scriptType === 'nested_segwit') return 49
  if (scriptType === 'legacy') return 44
  if (scriptType === 'taproot') return 86
  return 84
}

function slip132Prefix(
  scriptType: BitcoinScriptType,
  policy: BitcoinPolicyType,
): 'xpub' | 'ypub' | 'zpub' {
  if (policy === 'multisig' || scriptType === 'taproot' || scriptType === 'legacy') return 'xpub'
  if (scriptType === 'nested_segwit') return 'ypub'
  return 'zpub'
}

function normalizeImportScriptType(raw?: string): BitcoinScriptType {
  if (raw === 'nested_segwit' || raw === 'legacy' || raw === 'taproot') return raw
  return 'native_segwit'
}

function scriptTypeLabel(scriptType: BitcoinScriptType): string {
  if (scriptType === 'native_segwit') return 'Native SegWit'
  if (scriptType === 'nested_segwit') return 'Nested SegWit'
  if (scriptType === 'legacy') return 'Legacy'
  return 'Taproot'
}

function accountPath(
  scriptType: BitcoinScriptType,
  account: number,
  policy: BitcoinPolicyType = 'singlesig',
): string {
  if (policy === 'multisig') {
    if (scriptType === 'legacy') return `m/45'/${account}`
    if (scriptType === 'nested_segwit') return `m/48'/0'/${account}'/1'`
    return `m/48'/0'/${account}'/2'`
  }
  return `m/${purposeForScript(scriptType)}'/0'/${account}'`
}

function pathWithoutM(path: string): string {
  return path.trim().replace(/^m\//i, '')
}

function defaultDescriptorTemplate(scriptType: BitcoinScriptType): string {
  if (scriptType === 'nested_segwit') return 'sh(wpkh(@0/**))'
  if (scriptType === 'legacy') return 'pkh(@0/**)'
  if (scriptType === 'taproot') return 'tr(@0/**)'
  return 'wpkh(@0/**)'
}

function multisigDescriptorTemplate(
  scriptType: BitcoinScriptType,
  required: number,
  total: number,
): string {
  const keys = Array.from({ length: total }, (_, i) => `@${i}/**`).join(',')
  if (scriptType === 'nested_segwit') return `sh(sortedmulti(${required},${keys}))`
  if (scriptType === 'legacy') return `sh(sortedmulti(${required},${keys}))`
  return `wsh(sortedmulti(${required},${keys}))`
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
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]!]!
  return out
}

function b58decode(str: string): Buffer {
  const bytes = [0]
  for (const ch of str) {
    const val = B58_ALPHABET.indexOf(ch)
    if (val < 0) throw new Error('Invalid base58 character in extended key')
    let carry = val
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  let zeros = 0
  while (zeros < str.length && str[zeros] === '1') zeros += 1
  const out = Buffer.alloc(zeros + bytes.length)
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i]!
  return out
}

function b58checkEncode(payload: Buffer): string {
  const checksum = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4)
  return b58encode(Buffer.concat([payload, checksum]))
}

function b58checkDecode(str: string): Buffer {
  const raw = b58decode(str)
  if (raw.length < 5) throw new Error('Invalid base58check payload')
  const payload = raw.subarray(0, raw.length - 4)
  const checksum = raw.subarray(raw.length - 4)
  const expect = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4)
  if (!checksum.equals(expect)) throw new Error('Invalid extended-key checksum')
  return payload
}

function recodeExtendedKey(key: string, target: 'xpub' | 'ypub' | 'zpub'): string {
  const payload = b58checkDecode(key.trim())
  if (payload.length !== 78) throw new Error('Unexpected extended-key length from Ledger')
  XPUB_VERSIONS[target].copy(payload, 0)
  return b58checkEncode(payload)
}

function toPlainXpub(key: string): string {
  const trimmed = key.trim()
  if (/^xpub/i.test(trimmed)) return trimmed
  return recodeExtendedKey(trimmed, 'xpub')
}

function normalizeBtcAddr(addr: string): string {
  return addr.trim().toLowerCase().replace(/\s+/g, '')
}

function normalizeFingerprint(raw?: string | null): string {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '')
    .slice(0, 8)
}

function isUsableMasterFingerprint(fp: string): boolean {
  return /^[0-9A-F]{8}$/i.test(fp) && !/^0+$/i.test(fp) && !/^F+$/i.test(fp)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function safeCloseTransport(transport: LedgerTransport | null | undefined): Promise<void> {
  if (!transport) return
  try {
    await Promise.resolve(transport.close())
  } catch {
    /* ignore */
  }
}

async function waitForBitcoinApp(
  transport: LedgerTransport,
  onProgress?: (p: { status: string; message: string }) => void,
  link: HwLink = 'usb',
): Promise<AppClient> {
  const deadline = Date.now() + 90_000
  let lastName = ''
  while (Date.now() < deadline) {
    const app = new AppClient(transport as never)
    try {
      const info = await app.getAppAndVersion()
      lastName = info.name || ''
      if (/bitcoin/i.test(lastName)) return app
      onProgress?.({
        status: 'connecting',
        message: `Open the Bitcoin app on Ledger… (currently “${lastName || 'unknown'}”)`,
      })
    } catch {
      onProgress?.({
        status: 'connecting',
        message:
          link === 'ble'
            ? 'Waiting for Bitcoin app over Bluetooth…'
            : 'Waiting for Bitcoin app on Ledger…',
      })
    }
    await sleep(link === 'ble' ? 400 : 500)
  }
  throw new Error(
    lastName
      ? `Timed out waiting for Bitcoin app (last seen “${lastName}”). Open Bitcoin in Ledger Live / on device.`
      : 'Timed out waiting for Bitcoin app. Unlock Ledger and open the Bitcoin app.',
  )
}

async function deriveBtcReceive0FromXpub(
  xpub: string,
  scriptType: BitcoinScriptType,
): Promise<string> {
  const python = resolvePython(findCoordinatorRoot())
  const script = [
    'from embit import script',
    'from embit.bip32 import HDKey',
    'from embit.networks import NETWORKS',
    'import sys',
    'key = HDKey.from_string(sys.argv[1])',
    'child = key.derive("m/0/0")',
    'st = sys.argv[2]',
    'net = NETWORKS["main"]',
    'if st == "legacy":',
    '  addr = script.p2pkh(child).address(net)',
    'elif st == "nested_segwit":',
    '  addr = script.p2sh(script.p2wpkh(child)).address(net)',
    'elif st == "taproot":',
    '  addr = script.p2tr(child).address(net)',
    'else:',
    '  addr = script.p2wpkh(child).address(net)',
    'print(addr)',
  ].join('\n')
  try {
    const { stdout } = await execFileAsync(python, ['-c', script, xpub, scriptType], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    })
    const addr = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
    if (!addr) throw new Error('empty address')
    return addr
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(`Could not derive Bitcoin receive #0 from Ledger xpub: ${detail}`)
  }
}

async function applyPartialSigsToPsbt(
  psbtBase64: string,
  partials: Array<{ index: number; pubkeyHex: string; signatureHex: string }>,
): Promise<string> {
  const python = resolvePython(findCoordinatorRoot())
  const script = `
from embit.psbt import PSBT
from embit import ec
import base64, json, sys
psbt = PSBT(base64.b64decode(sys.argv[1]))
for item in json.loads(sys.argv[2]):
    i = int(item["index"])
    pub = ec.PublicKey.parse(bytes.fromhex(item["pubkeyHex"]))
    sig = bytes.fromhex(item["signatureHex"])
    if i < 0 or i >= len(psbt.inputs):
        raise SystemExit(f"Bad input index {i}")
    psbt.inputs[i].partial_sigs[pub] = sig
print(base64.b64encode(psbt.serialize()).decode())
`.trim()
  const { stdout } = await execFileAsync(
    python,
    ['-c', script, psbtBase64, JSON.stringify(partials)],
    { timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
  )
  const out = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
  if (!out) throw new Error('Failed to merge Ledger signatures into PSBT')
  return out
}

function keyOriginInfo(fingerprint: string, derivation: string, xpub: string): string {
  const fp = normalizeFingerprint(fingerprint)
  if (!isUsableMasterFingerprint(fp)) {
    throw new Error('Missing master fingerprint for Ledger Bitcoin key')
  }
  return `[${fp.toLowerCase()}/${pathWithoutM(derivation)}]${toPlainXpub(xpub)}`
}

function buildSinglesigPolicy(
  scriptType: BitcoinScriptType,
  fingerprint: string,
  derivation: string,
  xpub: string,
): DefaultWalletPolicy {
  return new DefaultWalletPolicy(
    defaultDescriptorTemplate(scriptType) as never,
    keyOriginInfo(fingerprint, derivation, xpub),
  )
}

export async function importBitcoinWatchOnlyFromLedger(options?: {
  account?: number
  scriptType?: BitcoinScriptType
  policyType?: BitcoinPolicyType
  devicePath?: string
  link?: HwLink
  onProgress?: (p: LedgerScanProgress) => void
}): Promise<LedgerBitcoinImportResult> {
  const scriptType = normalizeImportScriptType(options?.scriptType)
  const policyType: BitcoinPolicyType = options?.policyType === 'multisig' ? 'multisig' : 'singlesig'
  if (policyType === 'multisig' && scriptType === 'taproot') {
    throw new Error('Taproot multisig is not supported — use Native SegWit multisig, or Taproot singlesig')
  }
  const account = Math.max(0, Math.min(0x7fffffff, options?.account ?? 0))
  const link: HwLink = options?.link === 'ble' ? 'ble' : 'usb'
  const progress = options?.onProgress
  const derivation = accountPath(scriptType, account, policyType)
  const scriptLabel = scriptTypeLabel(scriptType)
  const policyLabel = policyType === 'multisig' ? 'multisig' : 'singlesig'

  progress?.({
    status: 'scanning',
    message: link === 'ble' ? 'Scanning for Ledger over Bluetooth…' : 'Looking for Ledger devices…',
  })

  let transport: LedgerTransport | null = null
  try {
    if (link === 'usb') {
      const devices = await listLedgerUsbDevices()
      if (!devices.length) {
        throw new Error(
          'No Ledger found. Plug in via USB, unlock it, open the Bitcoin app, then try again. Close Ledger Live if it is open.',
        )
      }
    } else {
      const devices = await listLedgerBleDevices({ clearCache: false, stopOnFirst: true })
      if (!devices.length) {
        throw new Error(
          'No Ledger found over Bluetooth. Unlock it, enable Bluetooth, open the Bitcoin app, stay nearby, then try again. Close Ledger Live if it is open.',
        )
      }
    }

    progress?.({ status: 'connecting', message: 'Connecting to Ledger…' })
    const opened = await openChosenLedger(options?.devicePath, link)
    transport = opened.transport
    progress?.({ status: 'connecting', message: `Connected to ${opened.product}` })

    const app = await waitForBitcoinApp(
      transport,
      progress as ((p: { status: string; message: string }) => void) | undefined,
      link,
    )

    progress?.({ status: 'fingerprint', message: 'Reading master fingerprint…' })
    const fingerprint = normalizeFingerprint(await app.getMasterFingerprint())
    if (!isUsableMasterFingerprint(fingerprint)) {
      throw new Error('Ledger did not return a master fingerprint for Bitcoin')
    }

    // Multisig / unusual paths need on-device confirmation (display=true).
    const displayXpub = policyType === 'multisig'
    progress?.({
      status: displayXpub ? 'confirm' : 'reading',
      message: displayXpub
        ? `Confirm Bitcoin ${scriptLabel} multisig cosigner key on Ledger (${derivation})…`
        : `Reading Ledger account key (${derivation})…`,
    })
    const rawXpub = await app.getExtendedPubkey(derivation, displayXpub)
    const kpub = recodeExtendedKey(rawXpub, slip132Prefix(scriptType, policyType))

    let verifiedHint = `${scriptLabel} multisig cosigner @ ${derivation}`
    if (policyType === 'singlesig') {
      progress?.({
        status: 'confirm',
        message: `Confirm Bitcoin ${scriptLabel} receive #0 on Ledger…`,
      })
      const policy = buildSinglesigPolicy(scriptType, fingerprint, derivation, rawXpub)
      const deviceAddress = await app.getWalletAddress(policy, null, 0, 0, true)
      const derived = await deriveBtcReceive0FromXpub(kpub, scriptType)
      if (normalizeBtcAddr(derived) !== normalizeBtcAddr(deviceAddress)) {
        throw new Error(
          `Address mismatch for Ledger Bitcoin account ${account}.\n` +
            `Device: ${deviceAddress}\n` +
            `SeedMask: ${derived}\n` +
            `Path: ${derivation}/0/0`,
        )
      }
      verifiedHint = `${scriptLabel} receive #0: ${deviceAddress}`
    }

    progress?.({
      status: 'done',
      message: `Ledger Bitcoin ${scriptLabel} ${policyLabel} account ${account} ready`,
    })

    return {
      kpub,
      fingerprint: fingerprint.toUpperCase(),
      derivation,
      account,
      scriptType,
      policyType,
      label:
        account === 0
          ? `Ledger ${scriptLabel}${policyType === 'multisig' ? ' MS' : ''}`
          : `Ledger ${scriptLabel}${policyType === 'multisig' ? ' MS' : ''} ${account}`,
      hardware: 'ledger',
      deviceModel: opened.product || 'Ledger',
      verifiedReceiveAddressHint: verifiedHint,
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    progress?.({ status: 'error', message })
    throw e instanceof Error ? e : new Error(message)
  } finally {
    await safeCloseTransport(transport)
  }
}

export async function signBitcoinPsbtWithLedger(options: {
  psbtBase64: string
  kpub?: string
  scriptType?: BitcoinScriptType
  derivation?: string
  fingerprint?: string
  /** Multisig: full cosigner set + quorum for WalletPolicy registration. */
  multisig?: {
    required: number
    total: number
    cosigners: LedgerBitcoinCosigner[]
  }
  devicePath?: string
  link?: HwLink
  onProgress?: (p: LedgerSignProgress) => void
}): Promise<{ format: 'bitcoin_psbt'; psbt_base64: string }> {
  const psbtBase64 = String(options.psbtBase64 || '').trim()
  if (!psbtBase64) throw new Error('Missing PSBT for Ledger Bitcoin signing')
  const link: HwLink = options.link === 'ble' ? 'ble' : 'usb'
  const scriptType = normalizeImportScriptType(options.scriptType)
  const kpub = String(options.kpub || '').trim()
  const progress = options.onProgress

  progress?.({
    status: 'scanning',
    message: link === 'ble' ? 'Scanning for Ledger over Bluetooth…' : 'Looking for Ledger…',
  })

  let transport: LedgerTransport | null = null
  try {
    const opened = await openChosenLedger(options.devicePath, link)
    transport = opened.transport
    progress?.({ status: 'connecting', message: `Connecting to ${opened.product}…` })
    const app = await waitForBitcoinApp(
      transport,
      progress as ((p: { status: string; message: string }) => void) | undefined,
      link,
    )

    const fingerprint =
      normalizeFingerprint(options.fingerprint) ||
      normalizeFingerprint(await app.getMasterFingerprint())
    if (!isUsableMasterFingerprint(fingerprint)) {
      throw new Error('Ledger did not return a master fingerprint for signing')
    }

    const ms = options.multisig
    let walletPolicy: DefaultWalletPolicy | WalletPolicy
    let walletHmac: Buffer | null = null

    if (ms && ms.cosigners.length >= 2 && ms.required >= 1) {
      const total = Math.max(ms.total, ms.cosigners.length)
      const required = Math.min(ms.required, total)
      const keys = ms.cosigners.slice(0, total).map((c, i) => {
        const deriv = (c.derivation || options.derivation || accountPath(scriptType, 0, 'multisig')).trim()
        const fp = normalizeFingerprint(c.fingerprint) || (i === 0 ? fingerprint : '')
        if (!isUsableMasterFingerprint(fp)) {
          throw new Error(
            `Cosigner ${i + 1} needs a master fingerprint for Ledger multisig signing`,
          )
        }
        if (!c.xpub?.trim()) throw new Error(`Cosigner ${i + 1} is missing an xpub`)
        return keyOriginInfo(fp, deriv, c.xpub)
      })
      walletPolicy = new WalletPolicy(
        'SeedMask',
        multisigDescriptorTemplate(scriptType, required, keys.length),
        keys,
      )
      progress?.({
        status: 'signing',
        message: 'Register / confirm the multisig policy on Ledger, then approve the transaction…',
      })
      const [, hmac] = await app.registerWallet(walletPolicy)
      walletHmac = hmac
    } else {
      if (!kpub) throw new Error('Missing watch-only key for Ledger Bitcoin signing')
      const derivation =
        (options.derivation || '').trim() || accountPath(scriptType, 0, 'singlesig')
      walletPolicy = buildSinglesigPolicy(scriptType, fingerprint, derivation, kpub)
      progress?.({
        status: 'signing',
        message: 'Confirm the Bitcoin transaction on your Ledger…',
      })
    }

    const partials = await app.signPsbt(psbtBase64, walletPolicy, walletHmac)
    if (!partials.length) {
      throw new Error('Ledger returned no signatures — check the Bitcoin app and try again')
    }

    const merged = await applyPartialSigsToPsbt(
      psbtBase64,
      partials.map(([index, partial]) => ({
        index,
        pubkeyHex: partial.pubkey.toString('hex'),
        signatureHex: partial.signature.toString('hex'),
      })),
    )

    progress?.({ status: 'done', message: 'Signed on Ledger' })
    return { format: 'bitcoin_psbt', psbt_base64: merged }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    progress?.({ status: 'error', message })
    throw e instanceof Error ? e : new Error(message)
  } finally {
    await safeCloseTransport(transport)
  }
}
