/**
 * OneKey Bitcoin: watch-only import + btcSignPsbt (USB / BLE).
 * Reuses passphrase / device session helpers from onekey-kaspa.ts.
 */
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { promisify } from 'util'

import {
  activeWalletProgressMessage,
  clearHardwareCancel,
  ensureSdk,
  getOneKeyActiveWalletLabel,
  isHardwareCancelRequested,
  normalizeFingerprint,
  pickDevice,
  sleepMs,
  unwrap,
  walletSessionParams,
  type OneKeyHwLink,
  type OneKeyPassphraseChoice,
  type OneKeyScanProgress,
  type OneKeySignProgress,
} from './onekey-kaspa'
import { findCoordinatorRoot, resolvePython } from './paths'

const execFileAsync = promisify(execFile)

export type BitcoinScriptType = 'native_segwit' | 'nested_segwit' | 'legacy' | 'taproot'
export type BitcoinPolicyType = 'singlesig' | 'multisig'

export type OneKeyBitcoinImportResult = {
  kpub: string
  fingerprint: string
  derivation: string
  account: number
  scriptType: BitcoinScriptType
  policyType: BitcoinPolicyType
  label: string
  hardware: 'onekey'
  deviceModel: string
  verifiedReceiveAddressHint: string
}

type SdkSuccess<T> = { success: true; payload: T }
type SdkFailure = { success: false; payload: { error?: string; code?: string | number } }
type SdkResponse<T> = SdkSuccess<T> | SdkFailure

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

/** OneKey InputScriptType for singlesig receive / pub export. */
function oneKeyScriptType(scriptType: BitcoinScriptType, policy: BitcoinPolicyType): string {
  if (policy === 'multisig') {
    // BIP48 → SPENDMULTISIG; legacy multisig (m/45') → SPENDADDRESS
    if (scriptType === 'legacy') return 'SPENDADDRESS'
    return 'SPENDMULTISIG'
  }
  if (scriptType === 'nested_segwit') return 'SPENDP2SHWITNESS'
  if (scriptType === 'legacy') return 'SPENDADDRESS'
  if (scriptType === 'taproot') return 'SPENDTAPROOT'
  return 'SPENDWITNESS'
}

function slip132Prefix(
  scriptType: BitcoinScriptType,
  policy: BitcoinPolicyType,
): 'xpub' | 'ypub' | 'zpub' {
  // Multisig cosigners + BIP86 Taproot use plain xpub (+ derivation / script_type).
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

function receivePath(
  scriptType: BitcoinScriptType,
  account: number,
  index = 0,
  policy: BitcoinPolicyType = 'singlesig',
): string {
  return `${accountPath(scriptType, account, policy)}/0/${index}`
}

function isMultisigBipPath(path: string): boolean {
  return /\/48'|\/45'|^m\/45'/.test(path)
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

/** Recode BIP32 xpub version bytes to zpub/ypub/xpub for SeedMask. */
function recodeExtendedKey(key: string, target: 'xpub' | 'ypub' | 'zpub'): string {
  const payload = b58checkDecode(key.trim())
  if (payload.length !== 78) throw new Error('Unexpected extended-key length from OneKey')
  XPUB_VERSIONS[target].copy(payload, 0)
  return b58checkEncode(payload)
}

/**
 * OneKey Taproot sets xpubSegwit to a tr([xfp/path]xpub/…) descriptor — not base58.
 * Prefer a plain xpub/ypub/zpub; pull one out of a descriptor if needed.
 */
function pickPlainExtendedKey(pub: { xpub?: string; xpubSegwit?: string }): string {
  const candidates = [pub.xpub, pub.xpubSegwit]
  for (const raw of candidates) {
    const s = String(raw || '').trim()
    if (!s) continue
    if (/^[xyztuv]pub[1-9A-HJ-NP-Za-km-z]{20,}$/i.test(s)) return s
    const m = s.match(/([xyztuv]pub[1-9A-HJ-NP-Za-km-z]{20,})/i)
    if (m?.[1]) return m[1]
  }
  throw new Error('OneKey did not return an account xpub for Bitcoin')
}

function normalizeBtcAddr(addr: string): string {
  return addr.trim().toLowerCase().replace(/\s+/g, '')
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
    throw new Error(`Could not derive Bitcoin receive #0 from OneKey xpub: ${detail}`)
  }
}

/**
 * From PSBT + watch-only key: first input BIP32 path and expected address under that key.
 */
async function resolvePsbtVerifyTarget(
  psbtBase64: string,
  kpub: string,
  scriptType: BitcoinScriptType,
): Promise<{ path: string; expectedAddress: string }> {
  const python = resolvePython(findCoordinatorRoot())
  const script = `
from embit import script
from embit.bip32 import HARDENED_INDEX, HDKey
from embit.networks import NETWORKS
from embit.psbt import PSBT
import base64, sys
raw = base64.b64decode(sys.argv[1])
psbt = PSBT(raw)
if not psbt.inputs:
    raise SystemExit("PSBT has no inputs")
inp = psbt.inputs[0]
ders = list((inp.bip32_derivations or {}).values())
if not ders and getattr(inp, "taproot_bip32_derivations", None):
    for _pub, (_leaves, der) in (inp.taproot_bip32_derivations or {}).items():
        ders.append(der)
        break
if not ders:
    raise SystemExit("PSBT input has no BIP32 derivation")
der = ders[0]
nums = list(der.derivation)
parts = []
for n in nums:
    if n & HARDENED_INDEX:
        parts.append("%d'" % (n - HARDENED_INDEX))
    else:
        parts.append(str(n))
path = "m/" + "/".join(parts)
account = HDKey.from_string(sys.argv[2])
if len(nums) < 5:
    raise SystemExit("Unexpected BIP32 path depth")
rel = "m/%d/%d" % (nums[-2] & ~HARDENED_INDEX, nums[-1] & ~HARDENED_INDEX)
child = account.derive(rel)
st = sys.argv[3]
net = NETWORKS["main"]
if st == "legacy":
    addr = script.p2pkh(child).address(net)
elif st == "nested_segwit":
    addr = script.p2sh(script.p2wpkh(child)).address(net)
elif st == "taproot":
    addr = script.p2tr(child).address(net)
else:
    addr = script.p2wpkh(child).address(net)
print(path)
print(addr)
`.trim()
  try {
    const { stdout } = await execFileAsync(python, ['-c', script, psbtBase64, kpub, scriptType], {
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    })
    const lines = stdout
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length < 2) throw new Error('unexpected python output')
    return { path: lines[0]!, expectedAddress: lines[1]! }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(`Could not read BIP32 path from PSBT: ${detail}`)
  }
}

function deviceLabel(product: string): string {
  return product || 'OneKey'
}

function isUsableMasterFingerprint(fp: string): boolean {
  return /^[0-9A-F]{8}$/i.test(fp) && !/^0+$/i.test(fp) && !/^F+$/i.test(fp)
}

type PubKeyPayload = {
  xpub?: string
  xpubSegwit?: string
  root_fingerprint?: number
  rootFingerprint?: number
  node?: { fingerprint?: number }
}

async function resolveMasterFingerprint(
  sdk: {
    btcGetPublicKey: (
      connectId: string,
      deviceId: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>
  },
  connectId: string,
  deviceId: string,
  pub: PubKeyPayload,
): Promise<string> {
  const candidates = [
    normalizeFingerprint(pub.root_fingerprint),
    normalizeFingerprint(pub.rootFingerprint),
  ]
  for (const fp of candidates) {
    if (fp && isUsableMasterFingerprint(fp)) return fp.toUpperCase()
  }

  // BIP48 / some firmware builds omit root XFP on the cosigner path — probe a standard account.
  try {
    const probe = unwrap(
      (await sdk.btcGetPublicKey(connectId, deviceId, {
        path: "m/84'/0'/0'",
        coin: 'btc',
        showOnOneKey: false,
        scriptType: 'SPENDWITNESS',
        ...walletSessionParams(),
      })) as SdkResponse<PubKeyPayload>,
      'OneKey btcGetPublicKey (fingerprint)',
    )
    const fp =
      normalizeFingerprint(probe.root_fingerprint) || normalizeFingerprint(probe.rootFingerprint)
    if (fp && isUsableMasterFingerprint(fp)) return fp.toUpperCase()
  } catch {
    /* fall through */
  }

  return ''
}

export async function importBitcoinWatchOnlyFromOneKey(options?: {
  account?: number
  scriptType?: BitcoinScriptType
  policyType?: BitcoinPolicyType
  devicePath?: string
  link?: OneKeyHwLink
  onProgress?: (p: OneKeyScanProgress) => void
}): Promise<OneKeyBitcoinImportResult> {
  const scriptType = normalizeImportScriptType(options?.scriptType)
  const policyType: BitcoinPolicyType = options?.policyType === 'multisig' ? 'multisig' : 'singlesig'
  if (policyType === 'multisig' && scriptType === 'taproot') {
    throw new Error('Taproot multisig is not supported — use Native SegWit multisig, or Taproot singlesig')
  }
  const account = Math.max(0, Math.min(0x7fffffff, options?.account ?? 0))
  const link: OneKeyHwLink = options?.link === 'ble' ? 'ble' : 'usb'
  const progress = options?.onProgress
  const derivation = accountPath(scriptType, account, policyType)
  const recvPath = receivePath(scriptType, account, 0, policyType)
  const okScript = oneKeyScriptType(scriptType, policyType)

  progress?.({
    status: 'scanning',
    message: link === 'ble' ? 'Scanning for OneKey over Bluetooth…' : 'Looking for OneKey devices…',
  })

  try {
    clearHardwareCancel()
    await ensureSdk(progress as ((p: OneKeyScanProgress | OneKeySignProgress) => void) | undefined, link)
    if (isHardwareCancelRequested()) throw new Error('Cancelled')
    progress?.({
      status: 'connecting',
      message:
        link === 'ble'
          ? 'Connecting to OneKey over Bluetooth… Confirm any prompt on the device.'
          : 'Connecting to OneKey…',
    })
    const device = await pickDevice(
      options?.devicePath,
      link,
      progress as ((p: OneKeyScanProgress) => void) | undefined,
      {
        requireWalletChoice: true,
      },
    )
    const { sdk } = device
    if (device.activeWallet) {
      progress?.({
        status: 'connecting',
        message: activeWalletProgressMessage(device.activeWallet),
      })
      await sleepMs(1000)
    }
    progress?.({ status: 'connecting', message: `Connected to ${device.product}` })

    const scriptLabel = scriptTypeLabel(scriptType)
    const policyLabel = policyType === 'multisig' ? 'multisig' : 'singlesig'

    let deviceAddress = ''
    if (policyType === 'singlesig') {
      progress?.({
        status: 'confirm',
        message: `Confirm Bitcoin ${scriptLabel} receive #0 on OneKey (${recvPath})…`,
      })
      const addr = unwrap(
        (await sdk.btcGetAddress(device.connectId, device.deviceId, {
          path: recvPath,
          coin: 'btc',
          showOnOneKey: true,
          scriptType: okScript,
          ...walletSessionParams(),
        })) as SdkResponse<{ address?: string }>,
        'OneKey btcGetAddress',
      )
      deviceAddress = String(addr.address || '').trim()
      if (!deviceAddress) {
        throw new Error('OneKey did not return a Bitcoin receive address — update firmware and try again')
      }
    } else {
      progress?.({
        status: 'confirm',
        message: `Confirm Bitcoin ${scriptLabel} multisig cosigner key on OneKey (${derivation})…`,
      })
    }

    progress?.({
      status: 'reading',
      message: `Reading OneKey account key (${derivation})…`,
    })
    const pub = unwrap(
      (await sdk.btcGetPublicKey(device.connectId, device.deviceId, {
        path: derivation,
        coin: 'btc',
        showOnOneKey: policyType === 'multisig',
        scriptType: okScript,
        ...walletSessionParams(),
      })) as SdkResponse<{
        xpub?: string
        xpubSegwit?: string
        root_fingerprint?: number
        node?: { fingerprint?: number }
      }>,
      'OneKey btcGetPublicKey',
    )

    const rawXpub = pickPlainExtendedKey(pub)
    const kpub = recodeExtendedKey(rawXpub, slip132Prefix(scriptType, policyType))

    if (policyType === 'singlesig') {
      const derived = await deriveBtcReceive0FromXpub(kpub, scriptType)
      if (normalizeBtcAddr(derived) !== normalizeBtcAddr(deviceAddress)) {
        throw new Error(
          `Address mismatch for OneKey Bitcoin account ${account}.\n` +
            `Device: ${deviceAddress}\n` +
            `SeedMask: ${derived}\n` +
            `Path: ${recvPath}`,
        )
      }
    }

    const fingerprint = await resolveMasterFingerprint(sdk, device.connectId, device.deviceId, pub)
    if (!fingerprint) {
      throw new Error('OneKey did not return a master fingerprint for Bitcoin')
    }

    progress?.({
      status: 'done',
      message: `OneKey Bitcoin ${scriptLabel} ${policyLabel} account ${account} ready`,
    })

    return {
      kpub,
      fingerprint,
      derivation,
      account,
      scriptType,
      policyType,
      label:
        account === 0
          ? `OneKey ${scriptLabel}${policyType === 'multisig' ? ' MS' : ''}`
          : `OneKey ${scriptLabel}${policyType === 'multisig' ? ' MS' : ''} ${account}`,
      hardware: 'onekey',
      deviceModel: deviceLabel(device.product),
      verifiedReceiveAddressHint:
        policyType === 'multisig'
          ? `${scriptLabel} multisig cosigner @ ${derivation}`
          : `${scriptLabel} receive #0: ${deviceAddress}`,
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    progress?.({ status: 'error', message })
    throw e instanceof Error ? e : new Error(message)
  }
}

export async function signBitcoinPsbtWithOneKey(options: {
  psbtBase64: string
  kpub?: string
  scriptType?: BitcoinScriptType
  devicePath?: string
  link?: OneKeyHwLink
  onProgress?: (p: OneKeySignProgress) => void
}): Promise<{ format: 'bitcoin_psbt'; psbt_base64: string }> {
  const psbtBase64 = String(options.psbtBase64 || '').trim()
  if (!psbtBase64) throw new Error('Missing PSBT for OneKey Bitcoin signing')
  const link: OneKeyHwLink = options.link === 'ble' ? 'ble' : 'usb'
  const scriptType = normalizeImportScriptType(options.scriptType)
  const kpub = String(options.kpub || '').trim()

  clearHardwareCancel()
  options.onProgress?.({
    status: 'scanning',
    message: link === 'ble' ? 'Scanning for OneKey over Bluetooth…' : 'Looking for OneKey…',
  })

  try {
    await ensureSdk(
      options.onProgress as ((p: OneKeyScanProgress | OneKeySignProgress) => void) | undefined,
      link,
    )
    if (isHardwareCancelRequested()) throw new Error('Cancelled')
    const device = await pickDevice(
      options.devicePath,
      link,
      options.onProgress as ((p: OneKeyScanProgress) => void) | undefined,
      {
        requireWalletChoice: true,
      },
    )
    const { sdk } = device
    options.onProgress?.({
      status: 'connecting',
      message: `Connecting to ${device.product}…`,
    })

    if (kpub) {
      const { path, expectedAddress } = await resolvePsbtVerifyTarget(psbtBase64, kpub, scriptType)
      if (!isMultisigBipPath(path)) {
        options.onProgress?.({
          status: 'connecting',
          message: 'Checking this OneKey matches the SeedMask wallet…',
        })
        const addr = unwrap(
          (await sdk.btcGetAddress(device.connectId, device.deviceId, {
            path,
            coin: 'btc',
            showOnOneKey: false,
            scriptType: oneKeyScriptType(scriptType, 'singlesig'),
            ...walletSessionParams(),
          })) as SdkResponse<{ address?: string }>,
          'OneKey btcGetAddress (wallet check)',
        )
        const deviceAddress = String(addr.address || '').trim()
        if (!deviceAddress) {
          throw new Error('OneKey did not return an address for wallet verification')
        }
        if (normalizeBtcAddr(deviceAddress) !== normalizeBtcAddr(expectedAddress)) {
          const mode: OneKeyPassphraseChoice | string =
            getOneKeyActiveWalletLabel() || 'selected'
          throw new Error(
            `This OneKey wallet does not match the SeedMask wallet (chose ${mode}).\n` +
              `SeedMask expects: ${expectedAddress}\n` +
              `OneKey returned: ${deviceAddress}\n` +
              'Pick the same mode used when you imported this wallet (Standard, Temporary, or Hidden PIN).',
          )
        }
      }
    }

    options.onProgress?.({
      status: 'signing',
      message: 'Confirm the Bitcoin transaction on your OneKey…',
    })

    let psbtHex: string
    try {
      psbtHex = Buffer.from(psbtBase64, 'base64').toString('hex')
    } catch {
      throw new Error('Invalid PSBT base64')
    }
    if (!psbtHex || psbtHex.length % 2 !== 0) {
      throw new Error('Invalid PSBT encoding')
    }

    const signed = unwrap(
      (await sdk.btcSignPsbt(device.connectId, device.deviceId, {
        psbt: psbtHex,
        coin: 'btc',
        ...walletSessionParams(),
      })) as SdkResponse<{ psbt?: string }>,
      'OneKey btcSignPsbt',
    )
    const signedHex = String(signed.psbt || '')
      .replace(/^0x/i, '')
      .toLowerCase()
    if (!signedHex || signedHex.length % 2 !== 0) {
      throw new Error('OneKey did not return a signed PSBT')
    }
    const signedBase64 = Buffer.from(signedHex, 'hex').toString('base64')
    options.onProgress?.({ status: 'done', message: 'Signed on OneKey' })
    return { format: 'bitcoin_psbt', psbt_base64: signedBase64 }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const hint =
      /firmware|version|4\.9|3\.10/i.test(message)
        ? `${message}\nOneKey Bitcoin PSBT signing needs Pro ≥ 4.9.3 or Classic 1S ≥ 3.10.1.`
        : message
    options.onProgress?.({ status: 'error', message: hint })
    throw e instanceof Error ? new Error(hint) : new Error(hint)
  }
}
