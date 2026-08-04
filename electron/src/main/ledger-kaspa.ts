/**
 * Ledger Kaspa: watch-only import + SIGN_TX (USB HID / Bluetooth LE).
 * APDUs match KasVault / hw-app-kaspa / LedgerHQ app-kaspa.
 *
 * Only import node transports in the main process — never pull into the Vite renderer bundle.
 */
import { createHash } from 'crypto'
import TransportNodeHidImport from '@ledgerhq/hw-transport-node-hid'

type TransportNodeHidClass = typeof import('@ledgerhq/hw-transport-node-hid').default
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

type HwLink = 'usb' | 'ble'

/** Noble peripheral objects from @ledgerhq/hw-transport-node-ble listen() — not serializable strings. */
type LedgerBlePeripheral = {
  id: string
  state?: string
  advertisement?: { localName?: string }
}

const ledgerBlePeripherals = new Map<string, LedgerBlePeripheral>()

export function clearLedgerBlePeripheralCache(): void {
  ledgerBlePeripherals.clear()
}

function resolveTransportClass(): TransportNodeHidClass {
  const mod = TransportNodeHidImport as unknown as TransportNodeHidClass & {
    default?: TransportNodeHidClass
  }
  if (typeof mod.list === 'function' && typeof mod.open === 'function') return mod
  if (mod.default && typeof mod.default.list === 'function') return mod.default
  throw new Error('Ledger USB transport failed to load')
}

const TransportNodeHid = resolveTransportClass()

type BleListenObserver = {
  next: (e: {
    type: string
    descriptor?: string | LedgerBlePeripheral
    deviceModel?: { productName?: string }
  }) => void
  error: (e: Error) => void
  complete: () => void
}

type BleTransportClass = {
  listen: (observer: BleListenObserver) => { unsubscribe: () => void }
  open: (deviceOrId: string | LedgerBlePeripheral) => Promise<LedgerTransport>
  setReconnectionConfig?: (
    config: { pairingThreshold: number; delayAfterFirstPairing: number } | null,
  ) => void
}

function resolveBleTransportClass(): BleTransportClass {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@ledgerhq/hw-transport-node-ble') as BleTransportClass & {
    default?: BleTransportClass
    setReconnectionConfig?: BleTransportClass['setReconnectionConfig']
  }
  const t = mod?.default && typeof mod.default.open === 'function' ? mod.default : mod
  if (!t || typeof t.listen !== 'function' || typeof t.open !== 'function') {
    throw new Error('Ledger Bluetooth transport failed to load')
  }
  // Named export (not on the Transport class): import { setReconnectionConfig } ...
  const setReconnectionConfig =
    (typeof mod.setReconnectionConfig === 'function' ? mod.setReconnectionConfig : null) ||
    (typeof t.setReconnectionConfig === 'function' ? t.setReconnectionConfig : null) ||
    // CommonJS interop sometimes nests named exports under .default
    (typeof (mod.default as BleTransportClass | undefined)?.setReconnectionConfig === 'function'
      ? (mod.default as BleTransportClass).setReconnectionConfig
      : null)
  if (setReconnectionConfig) {
    t.setReconnectionConfig = setReconnectionConfig
  }
  return t
}

const LEDGER_VENDOR_ID = 0x2c97
const LEDGER_CLA = 0xe0
const CLA_BTC_NEW = 0xe1
const INS_GET_PUBLIC_KEY = 0x05
const INS_SIGN_TX = 0x06
const INS_BTC_GET_MASTER_FINGERPRINT = 0x05
const P1_NON_CONFIRM = 0x00
const P1_CONFIRM = 0x01
const P1_HEADER = 0x00
const P1_OUTPUTS = 0x01
const P1_INPUTS = 0x02
const P1_NEXT_SIGNATURE = 0x03
const P2_LAST = 0x00
const P2_MORE = 0x80
const BTC_PROTOCOL_VERSION = 1
const KASPA_KPUB_VERSION = Buffer.from('038f332e', 'hex')
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export type LedgerKaspaImportResult = {
  kpub: string
  fingerprint: string
  derivation: string
  account: number
  label: string
  hardware: 'ledger'
  deviceModel: string
  verifiedReceiveAddressHint: string
}

export type LedgerScanProgress = {
  status: 'scanning' | 'connecting' | 'reading' | 'confirm' | 'fingerprint' | 'done' | 'error'
  message: string
}

export type LedgerSignProgress = {
  status: 'scanning' | 'connecting' | 'signing' | 'done' | 'error'
  message: string
}

type UnsignedKaspaV2 = {
  version?: number
  account?: number
  tx_version?: number
  draft_hash?: string
  inputs?: Array<{
    prev_tx_id?: string
    prev_index?: number
    utxo_amount?: number
    sign_chain?: number
    sign_address_index?: number
    utxo_script_hex?: string
  }>
  outputs?: Array<{
    value?: number
    script_hex?: string
    is_change?: boolean
    change_address_index?: number
  }>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest()
}

function hash160(data: Buffer): Buffer {
  return createHash('ripemd160').update(sha256(data)).digest()
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

function stripStatus(reply: Buffer): Buffer {
  if (
    reply.length >= 2 &&
    reply[reply.length - 2] === 0x90 &&
    reply[reply.length - 1] === 0x00
  ) {
    return reply.subarray(0, reply.length - 2)
  }
  return reply
}

function pathToBuffer(path: string): Buffer {
  const parts = path
    .replace(/^m\//i, '')
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      const hardened = seg.endsWith("'") || seg.endsWith('h') || seg.endsWith('H')
      const n = parseInt(seg.replace(/['hH]$/, ''), 10)
      if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid BIP32 path segment: ${seg}`)
      return (hardened ? n + 0x80000000 : n) >>> 0
    })
  const buf = Buffer.alloc(1 + parts.length * 4)
  buf.writeUInt8(parts.length, 0)
  parts.forEach((num, i) => buf.writeUInt32BE(num, 1 + i * 4))
  return buf
}

function compressPublicKey(uncompressed: Buffer): Buffer {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error('Unexpected Ledger public key encoding')
  }
  const x = uncompressed.subarray(1, 33)
  const yParity = uncompressed[64]! & 1
  return Buffer.concat([Buffer.from([0x02 + yParity]), x])
}

function parsePublicKeyReply(reply: Buffer): { compressed: Buffer; chainCode: Buffer; xOnly: Buffer } {
  if (reply.length < 1 + 65 + 1 + 32) {
    throw new Error('Ledger returned an incomplete public key')
  }
  const pkLen = reply[0]!
  if (pkLen !== 65) throw new Error('Expected 65-byte uncompressed public key from Ledger')
  const uncompressed = reply.subarray(1, 66)
  const ccLen = reply[66]!
  if (ccLen !== 32) throw new Error('Expected 32-byte chain code from Ledger')
  const chainCode = reply.subarray(67, 99)
  const compressed = compressPublicKey(uncompressed)
  return { compressed, chainCode, xOnly: uncompressed.subarray(1, 33) }
}

function fingerprintOf(compressed: Buffer): Buffer {
  return hash160(compressed).subarray(0, 4)
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

function toBigEndianU64Hex(value: number): string {
  let base = '0000000000000000'
  base += Math.trunc(value).toString(16)
  return base.slice(-16)
}

async function getAppAndVersion(
  transport: LedgerTransport,
): Promise<{ name: string; version: string }> {
  const r = stripStatus(await transport.send(0xb0, 0x01, 0x00, 0x00))
  let i = 0
  const format = r[i++]
  if (format !== 1) throw new Error('Unsupported Ledger status format — unlock the device and try again')
  const nameLen = r[i++]!
  const name = r.subarray(i, i + nameLen).toString('ascii')
  i += nameLen
  const versionLen = r[i++]!
  const version = r.subarray(i, i + versionLen).toString('ascii')
  return { name, version }
}

async function ensureKaspaApp(transport: LedgerTransport): Promise<void> {
  const app = await getAppAndVersion(transport)
  if (/kaspa/i.test(app.name)) return
  throw new Error(`Open the Kaspa app on your Ledger (currently “${app.name}”), then try again.`)
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out (${ms}ms)`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function safeCloseTransport(transport: LedgerTransport | null | undefined): Promise<void> {
  if (!transport) return
  try {
    await withTimeout(Promise.resolve(transport.close()), 2000, 'Ledger close')
  } catch {
    /* ignore */
  }
}

/**
 * BIP32 master fingerprint (same value Sparrow / SeedMask show).
 *
 * Prefer reusing `existingTransport` after quitting Kaspa — on Bluetooth, a full
 * close+rescan is the long wait. Only reopen when the link drops.
 */
async function readMasterFingerprintFromBitcoin(
  onProgress?: (p: LedgerScanProgress) => void,
  link: HwLink = 'usb',
  devicePath?: string,
  existingTransport?: LedgerTransport | null,
): Promise<string> {
  const isBle = link === 'ble'
  onProgress?.({
    status: 'fingerprint',
    message: isBle
      ? 'Open the Bitcoin app on Ledger — keep the device nearby.'
      : 'Open the Bitcoin app on Ledger now (master fingerprint — same as Sparrow).',
  })

  const TransportBle = isBle ? resolveBleTransportClass() : null
  TransportBle?.setReconnectionConfig?.(null)

  const deadline = Date.now() + 90_000
  const openTimeoutMs = isBle ? 6_000 : 8_000
  let lastSeen = ''
  let lastErr = ''
  let transport: LedgerTransport | null = existingTransport ?? null
  let openedPath = devicePath
  let ownedTransport = !existingTransport

  try {
    while (Date.now() < deadline) {
      try {
        if (!transport) {
          ownedTransport = true
          const opened = await withTimeout(
            openChosenLedger(openedPath, link, { blePreferCache: true }),
            openTimeoutMs,
            'Ledger reopen',
          )
          transport = opened.transport
          openedPath = opened.path
        }

        const app = await withTimeout(getAppAndVersion(transport), isBle ? 1800 : 2500, 'app name')
        lastSeen = app.name
        onProgress?.({
          status: 'fingerprint',
          message: /bitcoin/i.test(app.name)
            ? 'Bitcoin open — reading master fingerprint…'
            : `Waiting for Bitcoin app… (currently “${app.name}”)`,
        })

        if (!/bitcoin/i.test(app.name)) {
          // App still switching — keep the link (USB) or re-probe quickly (BLE).
          await sleep(isBle ? 250 : 400)
          continue
        }

        const attempts: Array<() => Promise<Buffer>> = [
          async () =>
            stripStatus(
              await transport!.send(
                CLA_BTC_NEW,
                INS_BTC_GET_MASTER_FINGERPRINT,
                0x00,
                BTC_PROTOCOL_VERSION,
                Buffer.alloc(0),
              ),
            ),
          async () =>
            stripStatus(
              await transport!.send(
                CLA_BTC_NEW,
                INS_BTC_GET_MASTER_FINGERPRINT,
                0x00,
                0x00,
                Buffer.alloc(0),
              ),
            ),
        ]
        for (const attempt of attempts) {
          try {
            const reply = await withTimeout(attempt(), 3500, 'master fingerprint')
            if (reply.length >= 4) {
              return reply.subarray(0, 4).toString('hex').toUpperCase()
            }
            lastErr = `short response (${reply.length} bytes)`
          } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e)
          }
        }
        throw new Error(
          `Bitcoin is open but master fingerprint failed (${lastErr || 'unknown'}). Update the Bitcoin app in Ledger Live.`,
        )
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
        if (/Bitcoin is open but master fingerprint failed/i.test(lastErr)) throw e
        await safeCloseTransport(transport)
        transport = null
        ownedTransport = true
        onProgress?.({
          status: 'fingerprint',
          message: isBle
            ? `Waiting for Bitcoin over Bluetooth… (${lastSeen ? `last “${lastSeen}”, ` : ''}reconnecting — open Bitcoin)`
            : `Waiting for Bitcoin app… (${lastSeen ? `last “${lastSeen}”, ` : ''}reconnecting)`,
        })
        await sleep(isBle ? 400 : 500)
      }
    }
  } finally {
    if (ownedTransport || transport) {
      await safeCloseTransport(transport)
    }
    TransportBle?.setReconnectionConfig?.({
      pairingThreshold: 1000,
      delayAfterFirstPairing: 4000,
    })
  }

  throw new Error(
    `Timed out waiting for the Bitcoin app` +
      (lastSeen ? ` (last seen: “${lastSeen}”)` : '') +
      `. Quit Ledger Live, open Bitcoin on the device, then try again` +
      (lastErr ? ` (${lastErr})` : '') +
      '.',
  )
}

async function getPublicKeyAt(
  transport: LedgerTransport,
  path: string,
  display = false,
): Promise<{ compressed: Buffer; chainCode: Buffer; xOnly: Buffer }> {
  const reply = stripStatus(
    await transport.send(
      LEDGER_CLA,
      INS_GET_PUBLIC_KEY,
      display ? P1_CONFIRM : P1_NON_CONFIRM,
      0x00,
      pathToBuffer(path),
    ),
  )
  return parsePublicKeyReply(reply)
}

export async function listLedgerUsbDevices(): Promise<
  Array<{ path: string; product: string; vendorId: number; productId: number }>
> {
  let raw: unknown
  try {
    raw = await TransportNodeHid.list()
  } catch (e) {
    throw new Error(`Could not scan USB for Ledger: ${e instanceof Error ? e.message : String(e)}`)
  }
  const paths = Array.isArray(raw)
    ? raw.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : []
  return paths.map((path, index) => ({
    path,
    product: paths.length === 1 ? 'Ledger' : `Ledger ${index + 1}`,
    vendorId: LEDGER_VENDOR_ID,
    productId: 0,
  }))
}

export async function listLedgerBleDevices(options?: {
  clearCache?: boolean
  timeoutMs?: number
  /** Stop as soon as one Ledger is found (much faster for connect UX). */
  stopOnFirst?: boolean
}): Promise<Array<{ path: string; product: string; vendorId: number; productId: number }>> {
  const TransportBle = resolveBleTransportClass()
  if (options?.clearCache !== false) ledgerBlePeripherals.clear()
  const found = new Map<string, { path: string; product: string; vendorId: number; productId: number }>()
  for (const [id, peripheral] of ledgerBlePeripherals) {
    found.set(id, {
      path: id,
      product: peripheral.advertisement?.localName || 'Ledger',
      vendorId: LEDGER_VENDOR_ID,
      productId: 0,
    })
  }
  if (options?.stopOnFirst && found.size > 0) {
    return [...found.values()]
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let earlyTimer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) return
      settled = true
      if (earlyTimer) clearTimeout(earlyTimer)
      try {
        sub.unsubscribe()
      } catch {
        /* ignore */
      }
      resolve()
    }
    const sub = TransportBle.listen({
      next: (e) => {
        if (e.type !== 'add' || !e.descriptor || typeof e.descriptor === 'string') return
        const peripheral = e.descriptor
        const id = String(peripheral.id || '').trim()
        if (!id) return
        ledgerBlePeripherals.set(id, peripheral)
        const name =
          e.deviceModel?.productName ||
          peripheral.advertisement?.localName ||
          'Ledger'
        found.set(id, {
          path: id,
          product: name,
          vendorId: LEDGER_VENDOR_ID,
          productId: 0,
        })
        // Brief settle so the advertisement name can populate, then stop.
        if (options?.stopOnFirst !== false && found.size >= 1 && !earlyTimer) {
          earlyTimer = setTimeout(finish, 350)
        }
      },
      error: (err) => {
        if (settled) return
        settled = true
        if (earlyTimer) clearTimeout(earlyTimer)
        try {
          sub.unsubscribe()
        } catch {
          /* ignore */
        }
        reject(
          new Error(
            `Could not scan Bluetooth for Ledger: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
      },
      complete: finish,
    })
    setTimeout(finish, options?.timeoutMs ?? 5000)
  })
  return [...found.values()]
}

export async function openChosenLedger(
  devicePath?: string,
  link: HwLink = 'usb',
  opts?: { blePreferCache?: boolean },
): Promise<{
  transport: LedgerTransport
  product: string
  path: string
}> {
  if (link === 'ble') {
    const TransportBle = resolveBleTransportClass()
    // Pairing reconnect (~4s disconnect+wait) makes every BLE open feel stuck.
    TransportBle.setReconnectionConfig?.(null)

    const openPeripheral = async (
      id: string,
      product: string,
    ): Promise<{ transport: LedgerTransport; product: string; path: string }> => {
      const peripheral = ledgerBlePeripherals.get(id)
      if (!peripheral) {
        throw new Error(
          'Ledger Bluetooth session expired — scan again, then connect immediately while the device is nearby.',
        )
      }
      const transport = await TransportBle.open(peripheral)
      return { transport, product, path: id }
    }

    // Reuse peripheral from the preceding listLedgerDevices scan — skip a second 5s scan.
    if (devicePath && ledgerBlePeripherals.has(devicePath)) {
      try {
        return await openPeripheral(devicePath, ledgerBlePeripherals.get(devicePath)?.advertisement?.localName || 'Ledger')
      } catch {
        if (!opts?.blePreferCache) {
          /* fall through to rescan */
        } else {
          /* fingerprint poll: try soft rescan */
        }
      }
    }

    const devices = await listLedgerBleDevices({
      clearCache: false,
      timeoutMs: opts?.blePreferCache ? 1600 : 5000,
      stopOnFirst: true,
    })
    if (!devices.length) {
      throw new Error(
        'No Ledger found over Bluetooth. Unlock it, enable Bluetooth, open the Kaspa app, stay nearby, then try again. Close Ledger Live if it is open.',
      )
    }
    const chosen =
      (devicePath ? devices.find((d) => d.path === devicePath) : undefined) || devices[0]!
    return openPeripheral(chosen.path, chosen.product)
  }

  const devices = await listLedgerUsbDevices()
  if (!devices.length) {
    throw new Error(
      'No Ledger found. Plug in via USB, unlock it, open the Kaspa app, then try again. Close Ledger Live if it is open.',
    )
  }
  // After an app switch the HID path often changes — fall back to the first Ledger.
  const chosen =
    (devicePath ? devices.find((d) => d.path === devicePath) : undefined) || devices[0]!
  const transport = (await TransportNodeHid.open(chosen.path)) as LedgerTransport
  return { transport, product: chosen.product, path: chosen.path }
}

export async function importKaspaWatchOnlyFromLedger(options?: {
  account?: number
  devicePath?: string
  link?: HwLink
  onProgress?: (p: LedgerScanProgress) => void
}): Promise<LedgerKaspaImportResult> {
  const account = Math.max(0, Math.min(0x7fffffff, options?.account ?? 0))
  const link: HwLink = options?.link === 'ble' ? 'ble' : 'usb'
  const progress = options?.onProgress
  progress?.({
    status: 'scanning',
    message: link === 'ble' ? 'Scanning for Ledger over Bluetooth…' : 'Looking for Ledger devices…',
  })

  let transport: LedgerTransport | null = null
  const TransportBle = link === 'ble' ? resolveBleTransportClass() : null
  // Pairing reconnect (~4s) makes BLE feel stuck — disable for the whole import.
  TransportBle?.setReconnectionConfig?.(null)

  try {
    const opened = await openChosenLedger(options?.devicePath, link)
    transport = opened.transport
    progress?.({ status: 'connecting', message: `Connected to ${opened.product}` })
    await ensureKaspaApp(transport)

    progress?.({
      status: 'confirm',
      message: 'Confirm receive address #0 on your Ledger…',
    })
    // On-device address confirmation (P1_CONFIRM) for m/44'/111111'/account'/0/0
    await getPublicKeyAt(transport, `44'/111111'/${account}'/0/0`, true)

    progress?.({ status: 'reading', message: 'Reading watch-only key from Kaspa app…' })
    const coinTypeKey = await getPublicKeyAt(transport, "44'/111111'", false)
    const accountKey = await getPublicKeyAt(transport, `44'/111111'/${account}'`, false)
    // BIP32 parent fingerprint inside the kpub serialization (coin-type key).
    const bip32ParentFp = fingerprintOf(coinTypeKey.compressed)
    const kpub = buildKpub({
      depth: 3,
      parentFingerprint: bip32ParentFp,
      childNumber: (account + 0x80000000) >>> 0,
      chainCode: accountKey.chainCode,
      compressed: accountKey.compressed,
    })

    // Leave Kaspa so the device returns to the dashboard, then wait for Bitcoin.
    try {
      await withTimeout(transport.send(0xb0, 0xa7, 0x00, 0x00), 1500, 'quit Kaspa')
    } catch {
      /* ignore */
    }
    // BLE almost always drops when Kaspa quits — don't burn seconds probing a dead link.
    // Soft-rescan once so the next Bitcoin open is ready while the user switches apps.
    let fingerprintTransport: LedgerTransport | null = transport
    if (link === 'ble') {
      await safeCloseTransport(transport)
      transport = null
      fingerprintTransport = null
      progress?.({
        status: 'fingerprint',
        message: 'Open the Bitcoin app on Ledger — preparing Bluetooth…',
      })
      try {
        await listLedgerBleDevices({ clearCache: false, timeoutMs: 1600, stopOnFirst: true })
      } catch {
        /* open path will scan again */
      }
    }
    progress?.({
      status: 'fingerprint',
      message:
        link === 'ble'
          ? 'Open the Bitcoin app on Ledger — keep the device nearby.'
          : 'Open the Bitcoin app on Ledger for the master fingerprint…',
    })
    const fingerprint = await readMasterFingerprintFromBitcoin(
      progress,
      link,
      opened.path,
      fingerprintTransport,
    )
    transport = null
    const derivation = `m/44'/111111'/${account}'`

    progress?.({ status: 'done', message: 'Ledger connected' })
    return {
      kpub,
      fingerprint,
      derivation,
      account,
      label: account === 0 ? 'Ledger' : `Ledger account ${account}`,
      hardware: 'ledger',
      deviceModel: opened.product,
      verifiedReceiveAddressHint: 'Confirmed receive #0 on device',
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    progress?.({ status: 'error', message })
    throw e instanceof Error ? e : new Error(message)
  } finally {
    await safeCloseTransport(transport)
    TransportBle?.setReconnectionConfig?.({
      pairingThreshold: 1000,
      delayAfterFirstPairing: 4000,
    })
  }
}

function serializeSignHeader(params: {
  version: number
  outputLen: number
  inputLen: number
  changeAddressType: number
  changeAddressIndex: number
  accountHardened: number
}): Buffer {
  const versionBuf = Buffer.alloc(2)
  versionBuf.writeUInt16BE(params.version & 0xffff)
  const outputLenBuf = Buffer.from([params.outputLen & 0xff])
  const inputLenBuf = Buffer.from([params.inputLen & 0xff])
  const changeTypeBuf = Buffer.from([params.changeAddressType & 0xff])
  const changeIndexBuf = Buffer.alloc(4)
  changeIndexBuf.writeUInt32BE(params.changeAddressIndex >>> 0)
  const accountBuf = Buffer.alloc(4)
  accountBuf.writeUInt32BE(params.accountHardened >>> 0)
  return Buffer.concat([
    versionBuf,
    outputLenBuf,
    inputLenBuf,
    changeTypeBuf,
    changeIndexBuf,
    accountBuf,
  ])
}

function serializeSignOutput(value: number, scriptHex: string): Buffer {
  const script = Buffer.from(scriptHex.replace(/^0x/i, ''), 'hex')
  if (script.length !== 34 && script.length !== 35) {
    throw new Error(`Ledger Kaspa expects 34/35-byte script public key, got ${script.length}`)
  }
  return Buffer.concat([Buffer.from(toBigEndianU64Hex(value), 'hex'), script])
}

function serializeSignInput(params: {
  value: number
  prevTxId: string
  addressType: number
  addressIndex: number
  outpointIndex: number
}): Buffer {
  const valueBuf = Buffer.from(toBigEndianU64Hex(params.value), 'hex')
  const prev = Buffer.from(params.prevTxId.replace(/^0x/i, ''), 'hex')
  if (prev.length !== 32) throw new Error('Invalid prev_tx_id for Ledger signing')
  const addressTypeBuf = Buffer.from([params.addressType & 0xff])
  const addressIndexBuf = Buffer.alloc(4)
  addressIndexBuf.writeUInt32BE(params.addressIndex >>> 0)
  const outpointIndexBuf = Buffer.from([params.outpointIndex & 0xff])
  return Buffer.concat([valueBuf, prev, addressTypeBuf, addressIndexBuf, outpointIndexBuf])
}

/**
 * Sign a SeedMask unsigned v2 Kaspa tx on Ledger; returns SeedMask-compatible signed JSON.
 */
export async function signKaspaUnsignedWithLedger(options: {
  unsigned: UnsignedKaspaV2
  devicePath?: string
  link?: HwLink
  onProgress?: (p: LedgerSignProgress) => void
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
  if (outputs.length > 2) {
    throw new Error('Ledger Kaspa supports at most 2 outputs per transaction')
  }

  const account = Math.max(0, Math.trunc(Number(unsigned.account ?? 0)))
  const accountHardened = (account + 0x80000000) >>> 0
  const changeOut = outputs.find((o) => o.is_change) ?? (outputs.length > 1 ? outputs[1] : undefined)
  const changeAddressType = 1
  const changeAddressIndex = Math.max(
    0,
    Math.trunc(Number(changeOut?.change_address_index ?? 0)),
  )
  const link: HwLink = options.link === 'ble' ? 'ble' : 'usb'

  options.onProgress?.({
    status: 'scanning',
    message: link === 'ble' ? 'Scanning for Ledger over Bluetooth…' : 'Looking for Ledger…',
  })
  let transport: LedgerTransport | null = null
  try {
    const opened = await openChosenLedger(options.devicePath, link)
    transport = opened.transport
    options.onProgress?.({
      status: 'connecting',
      message: `Connecting to ${opened.product}…`,
    })
    await ensureKaspaApp(transport)

    options.onProgress?.({
      status: 'signing',
      message: 'Confirm the transaction on your Ledger…',
    })

    const header = serializeSignHeader({
      version: Math.trunc(Number(unsigned.tx_version ?? 0)),
      outputLen: outputs.length,
      inputLen: inputs.length,
      changeAddressType: changeOut ? changeAddressType : 0,
      changeAddressIndex: changeOut ? changeAddressIndex : 0,
      accountHardened,
    })
    await transport.send(LEDGER_CLA, INS_SIGN_TX, P1_HEADER, P2_MORE, header)

    for (const output of outputs) {
      const value = Number(output.value ?? 0)
      const scriptHex = String(output.script_hex ?? '')
      await transport.send(
        LEDGER_CLA,
        INS_SIGN_TX,
        P1_OUTPUTS,
        P2_MORE,
        serializeSignOutput(value, scriptHex),
      )
    }

    let signatureBuffer: Buffer | null = null
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!
      const p2 = i >= inputs.length - 1 ? P2_LAST : P2_MORE
      const payload = serializeSignInput({
        value: Number(input.utxo_amount ?? 0),
        prevTxId: String(input.prev_tx_id ?? ''),
        addressType: Math.trunc(Number(input.sign_chain ?? 0)),
        addressIndex: Math.trunc(Number(input.sign_address_index ?? 0)),
        outpointIndex: Math.trunc(Number(input.prev_index ?? 0)),
      })
      signatureBuffer = stripStatus(
        await transport.send(LEDGER_CLA, INS_SIGN_TX, P1_INPUTS, p2, payload),
      )
    }

    const signatures: Array<{ input_index: number; sig_hex: string }> = []
    while (signatureBuffer && signatureBuffer.length >= 3) {
      const hasMore = signatureBuffer[0]!
      const inputIndex = signatureBuffer[1]!
      const sigLen = signatureBuffer[2]!
      const sigBuf = signatureBuffer.subarray(3, 3 + sigLen)
      if (sigLen !== 64) {
        throw new Error(`Expected 64-byte Ledger signature, got ${sigLen} for input ${inputIndex}`)
      }
      signatures.push({ input_index: inputIndex, sig_hex: Buffer.from(sigBuf).toString('hex') })
      if (!hasMore) break
      signatureBuffer = stripStatus(
        await transport.send(LEDGER_CLA, INS_SIGN_TX, P1_NEXT_SIGNATURE, P2_LAST, Buffer.alloc(0)),
      )
    }

    if (signatures.length !== inputs.length) {
      throw new Error(
        `Ledger returned ${signatures.length} signature(s) but the transaction has ${inputs.length} input(s)`,
      )
    }

    options.onProgress?.({ status: 'done', message: 'Signed on Ledger' })
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
  } finally {
    try {
      await transport?.close()
    } catch {
      /* ignore */
    }
  }
}
