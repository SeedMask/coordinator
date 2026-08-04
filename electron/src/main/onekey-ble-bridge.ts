/**
 * Noble BLE API for OneKey desktop-web-ble transport (main process).
 * Exposes `window.desktopApi.nobleBle` expected by ElectronBleTransport.
 *
 * Connect/UUID logic mirrors `@onekeyfe/hd-transport-electron` noble-ble-handler:
 * - characteristic match via uuid[4:8] === '0002' / '0003' (macOS short UUIDs)
 * - force disconnect/reconnect before GATT discovery
 * - open scan with allowDuplicates so localName arrives in scan responses
 */
import {
  isOnekeyDevice,
  ONEKEY_SERVICE_UUID,
} from '@onekeyfe/hd-shared'

type BleCharacteristic = {
  uuid: string
  writeAsync: (data: Buffer, withoutResponse: boolean) => Promise<void>
  subscribeAsync: () => Promise<void>
  unsubscribeAsync: () => Promise<void>
  on: (event: 'data', cb: (data: Buffer) => void) => void
  removeListener: (event: 'data', cb: (data: Buffer) => void) => void
}

type Peripheral = {
  id: string
  uuid: string
  address: string
  state?: string
  advertisement?: { localName?: string; serviceUuids?: string[] }
  connectAsync: () => Promise<void>
  disconnectAsync: () => Promise<void>
  discoverSomeServicesAndCharacteristicsAsync: (
    serviceUuids: string[],
    characteristicUuids: string[],
  ) => Promise<{ characteristics: BleCharacteristic[] }>
  discoverAllServicesAndCharacteristicsAsync?: () => Promise<{
    characteristics: BleCharacteristic[]
  }>
  removeAllListeners?: (event?: string) => void
  once: (event: string, cb: (...args: unknown[]) => void) => void
  removeListener?: (event: string, cb: (...args: unknown[]) => void) => void
}

type NobleModule = {
  state: string
  waitForPoweredOnAsync?: (timeoutMs?: number) => Promise<void>
  startScanningAsync: (serviceUuids: string[], allowDuplicates: boolean) => Promise<void>
  stopScanningAsync: () => Promise<void>
  on: (event: 'discover' | 'stateChange', listener: (...args: unknown[]) => void) => void
  removeListener: (event: 'discover' | 'stateChange', listener: (...args: unknown[]) => void) => void
}

export type NobleBleAPI = {
  enumerate: () => Promise<Array<{ id: string; name: string }>>
  getDevice: (uuid: string) => Promise<{ id: string; name: string } | null>
  connect: (uuid: string) => Promise<void>
  disconnect: (uuid: string) => Promise<void>
  subscribe: (uuid: string) => Promise<void>
  unsubscribe: (uuid: string) => Promise<void>
  write: (uuid: string, data: string) => Promise<void>
  onNotification: (callback: (deviceId: string, data: string) => void) => () => void
  onDeviceDisconnected: (callback: (device: { id: string; name: string }) => void) => () => void
  checkAvailability: () => Promise<{
    available: boolean
    state: string
    unsupported: boolean
    initialized: boolean
  }>
}

const SCAN_SERVICE_MS = 6000
const SCAN_OPEN_MS = 10000
const BLE_PACKET_SIZE = 192
const WRITE_DELAY_MS = 5
const NORMALIZED_SERVICE = '0001'
const NORMALIZED_WRITE = '0002'
const NORMALIZED_NOTIFY = '0003'

const discovered = new Map<string, { peripheral: Peripheral; name: string }>()
const connected = new Map<
  string,
  {
    peripheral: Peripheral
    name: string
    writeChar: BleCharacteristic
    notifyChar: BleCharacteristic
    onData?: (data: Buffer) => void
  }
>()

const notificationListeners = new Set<(deviceId: string, data: string) => void>()
const disconnectListeners = new Set<(device: { id: string; name: string }) => void>()

let nobleMod: NobleModule | null = null
let api: NobleBleAPI | null = null
let lastScanSeen = 0
let lastScanNames: string[] = []

export const BLUETOOTH_OFF_MESSAGE =
  'Bluetooth is turned off. Turn Bluetooth on, then try again.'

export const BLUETOOTH_UNAUTHORIZED_MESSAGE =
  'macOS has not allowed Bluetooth for SeedMask Coordinator. Open System Settings → Privacy & Security → Bluetooth, enable SeedMask Coordinator, then try again. If it is missing from the list, quit SeedMask fully and reopen it once (or run: npm run run:app).'

let cancelRequested = false

export function requestHardwareCancel(): void {
  cancelRequested = true
  void forceStopBle().catch(() => {})
}

export function clearHardwareCancel(): void {
  cancelRequested = false
}

export function isHardwareCancelRequested(): boolean {
  return cancelRequested
}

async function forceStopBle(): Promise<void> {
  try {
    const noble = nobleMod
    if (noble) {
      try {
        await noble.stopScanningAsync()
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  const entries = [...connected.entries()]
  for (const [id, conn] of entries) {
    try {
      if (conn.onData) conn.notifyChar.removeListener('data', conn.onData)
      await conn.notifyChar.unsubscribeAsync().catch(() => {})
      await conn.peripheral.disconnectAsync()
    } catch {
      /* ignore */
    } finally {
      connected.delete(id)
    }
  }
}

function throwIfCancelled(): void {
  if (cancelRequested) throw new Error('Cancelled')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function deviceId(p: Peripheral): string {
  return String(p.id || p.uuid || p.address || '').toLowerCase()
}

function advertName(p: Peripheral): string {
  return (p.advertisement?.localName || '').trim()
}

function deviceName(p: Peripheral): string {
  return advertName(p) || 'OneKey'
}

/** Official OneKey macOS UUID key: chars [4..8) of normalized UUID, or whole short UUID. */
function uuidKey(uuid: string): string {
  const u = uuid.replace(/-/g, '').toLowerCase()
  return u.length >= 8 ? u.substring(4, 8) : u
}

function hasOneKeyService(p: Peripheral): boolean {
  const services = p.advertisement?.serviceUuids || []
  return services.some((s) => uuidKey(String(s)) === NORMALIZED_SERVICE)
}

function acceptOneKeyPeripheral(p: Peripheral): boolean {
  const name = advertName(p)
  if (name && isOnekeyDevice(name, p.id)) return true
  return hasOneKeyService(p)
}

function logBle(...args: unknown[]): void {
  console.log('[OneKeyBLE]', ...args)
}

async function loadNoble(): Promise<NobleModule> {
  if (nobleMod) return nobleMod
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@stoprocent/noble') as NobleModule & { default?: NobleModule }
  nobleMod = mod?.default && typeof mod.default.startScanningAsync === 'function' ? mod.default : mod
  if (!nobleMod || typeof nobleMod.startScanningAsync !== 'function') {
    throw new Error('Bluetooth stack (@stoprocent/noble) failed to load')
  }
  return nobleMod
}

async function waitPoweredOn(noble: NobleModule, timeoutMs = 12000): Promise<void> {
  if (typeof noble.waitForPoweredOnAsync === 'function') {
    try {
      await noble.waitForPoweredOnAsync(timeoutMs)
      return
    } catch {
      /* fall through to explicit checks */
    }
  }

  if (!noble.state || noble.state === 'unknown') {
    await sleep(400)
  }
  if (noble.state === 'poweredOn') return
  if (noble.state === 'unauthorized') {
    throw new Error(BLUETOOTH_UNAUTHORIZED_MESSAGE)
  }
  if (noble.state === 'poweredOff') {
    throw new Error(BLUETOOTH_OFF_MESSAGE)
  }
  if (noble.state === 'unsupported') {
    throw new Error('Bluetooth LE is not supported on this system.')
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      noble.removeListener('stateChange', onState)
      const s = noble.state || 'unknown'
      if (s === 'unauthorized') reject(new Error(BLUETOOTH_UNAUTHORIZED_MESSAGE))
      else reject(new Error(BLUETOOTH_OFF_MESSAGE))
    }, timeoutMs)
    const onState = (state: unknown) => {
      const s = String(state)
      if (s === 'poweredOn') {
        clearTimeout(timer)
        noble.removeListener('stateChange', onState)
        resolve()
        return
      }
      if (s === 'unsupported') {
        clearTimeout(timer)
        noble.removeListener('stateChange', onState)
        reject(new Error('Bluetooth LE is not supported on this system.'))
        return
      }
      if (s === 'unauthorized') {
        clearTimeout(timer)
        noble.removeListener('stateChange', onState)
        reject(new Error(BLUETOOTH_UNAUTHORIZED_MESSAGE))
        return
      }
      if (s === 'poweredOff') {
        clearTimeout(timer)
        noble.removeListener('stateChange', onState)
        reject(new Error(BLUETOOTH_OFF_MESSAGE))
      }
    }
    noble.on('stateChange', onState)
  })
}

function ensureGlobalDesktopApi(nobleBle: NobleBleAPI): void {
  const g = globalThis as typeof globalThis & {
    window?: { desktopApi?: { nobleBle?: NobleBleAPI } }
  }
  if (!g.window) g.window = {}
  if (!g.window.desktopApi) g.window.desktopApi = {}
  g.window.desktopApi.nobleBle = nobleBle
}

export async function ensureBluetoothPoweredOn(): Promise<{
  ok: boolean
  state: string
  error?: string
}> {
  try {
    const noble = await loadNoble()
    try {
      await waitPoweredOn(noble, 5000)
      return { ok: true, state: noble.state || 'poweredOn' }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const unauthorized = message === BLUETOOTH_UNAUTHORIZED_MESSAGE || /unauthorized/i.test(message)
      const off =
        message === BLUETOOTH_OFF_MESSAGE || /turned off|powered off|unavailable/i.test(message)
      if (unauthorized) {
        return { ok: false, state: noble.state || 'unauthorized', error: BLUETOOTH_UNAUTHORIZED_MESSAGE }
      }
      if (off) {
        return { ok: false, state: noble.state || 'poweredOff', error: BLUETOOTH_OFF_MESSAGE }
      }
      return { ok: false, state: noble.state || 'unknown', error: message }
    }
  } catch (e) {
    return {
      ok: false,
      state: 'error',
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

async function scanPhase(
  noble: NobleModule,
  serviceUuids: string[],
  allowDuplicates: boolean,
  durationMs: number,
): Promise<void> {
  throwIfCancelled()
  await noble.startScanningAsync(serviceUuids, allowDuplicates)
  const deadline = Date.now() + durationMs
  let firstHitAt = 0
  while (Date.now() < deadline) {
    throwIfCancelled()
    if (discovered.size > 0) {
      if (!firstHitAt) firstHitAt = Date.now()
      // Keep scanning ~2s after first hit so scan-response localName can arrive.
      if (Date.now() - firstHitAt >= 2000) break
    }
    await sleep(250)
  }
  try {
    await noble.stopScanningAsync()
  } catch {
    /* ignore */
  }
}

async function forceReconnect(peripheral: Peripheral, id: string): Promise<void> {
  logBle('force reconnect', id, 'state=', peripheral.state)
  // Drop prior session for this id if any.
  const prior = connected.get(id)
  if (prior) {
    try {
      if (prior.onData) prior.notifyChar.removeListener('data', prior.onData)
      await prior.notifyChar.unsubscribeAsync().catch(() => {})
    } catch {
      /* ignore */
    }
    connected.delete(id)
  }

  if (peripheral.state === 'connected') {
    try {
      peripheral.removeAllListeners?.('disconnect')
      await peripheral.disconnectAsync()
    } catch {
      /* ignore */
    }
    await sleep(300)
  }

  try {
    await withTimeout(peripheral.connectAsync(), 15000, 'OneKey Bluetooth connect')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/already connected/i.test(msg)) {
      logBle('already connected — continuing')
    } else {
      throw new Error(
        msg ||
          'Could not connect to OneKey over Bluetooth. Unlock it, enable Bluetooth on the device, stay nearby, and try again.',
      )
    }
  }
  await sleep(500)
}

async function discoverCharacteristics(peripheral: Peripheral): Promise<{
  writeChar: BleCharacteristic
  notifyChar: BleCharacteristic
}> {
  let characteristics: BleCharacteristic[] = []
  try {
    if (typeof peripheral.discoverAllServicesAndCharacteristicsAsync === 'function') {
      const all = await withTimeout(
        peripheral.discoverAllServicesAndCharacteristicsAsync(),
        15000,
        'OneKey Bluetooth service discovery',
      )
      characteristics = all.characteristics || []
    } else {
      const some = await withTimeout(
        peripheral.discoverSomeServicesAndCharacteristicsAsync([], []),
        15000,
        'OneKey Bluetooth service discovery',
      )
      characteristics = some.characteristics || []
    }
  } catch (e) {
    // Fallback: try explicit OneKey service filter
    logBle('full discovery failed, retry with OneKey service', e)
    const some = await withTimeout(
      peripheral.discoverSomeServicesAndCharacteristicsAsync([ONEKEY_SERVICE_UUID], []),
      15000,
      'OneKey Bluetooth service discovery',
    )
    characteristics = some.characteristics || []
  }

  logBle(
    'chars',
    characteristics.map((c) => `${c.uuid}→${uuidKey(c.uuid)}`).join(', ') || '(none)',
  )

  let writeChar: BleCharacteristic | undefined
  let notifyChar: BleCharacteristic | undefined
  for (const c of characteristics) {
    const key = uuidKey(c.uuid)
    if (key === NORMALIZED_WRITE) writeChar = c
    else if (key === NORMALIZED_NOTIFY) notifyChar = c
  }

  if (!writeChar || !notifyChar) {
    try {
      await peripheral.disconnectAsync()
    } catch {
      /* ignore */
    }
    throw new Error(
      'Connected, but OneKey BLE characteristics were not found. ' +
        'In macOS Bluetooth settings, Forget the OneKey device if it was paired there, close the OneKey App, then connect only from SeedMask.',
    )
  }
  return { writeChar, notifyChar }
}

export function getOneKeyNobleBleApi(): NobleBleAPI {
  if (api) return api

  api = {
    async checkAvailability() {
      try {
        const noble = await loadNoble()
        await waitPoweredOn(noble, 5000)
        return {
          available: true,
          state: noble.state,
          unsupported: false,
          initialized: true,
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const unsupported = /not supported/i.test(msg)
        const unauthorized = /unauthorized|Privacy & Security → Bluetooth/i.test(msg)
        return {
          available: false,
          state: unsupported ? 'unsupported' : unauthorized ? 'unauthorized' : 'poweredOff',
          unsupported,
          initialized: false,
        }
      }
    },

    async enumerate() {
      throwIfCancelled()
      const noble = await loadNoble()
      await waitPoweredOn(noble)
      throwIfCancelled()
      discovered.clear()
      lastScanSeen = 0
      lastScanNames = []

      const onDiscover = (raw: unknown) => {
        const p = raw as Peripheral
        const id = deviceId(p)
        if (!id) return
        lastScanSeen += 1
        const name = advertName(p)
        if (name && lastScanNames.length < 12 && !lastScanNames.includes(name)) {
          lastScanNames.push(name)
        }
        if (!acceptOneKeyPeripheral(p)) return
        const prev = discovered.get(id)
        // Prefer entries that gained a real localName.
        const nextName = advertName(p) || prev?.name || 'OneKey'
        discovered.set(id, { peripheral: p, name: nextName })
        logBle('accepted', nextName, id)
      }

      noble.on('discover', onDiscover)
      try {
        // 1) Filtered scan for OneKey service UUID
        await scanPhase(noble, [ONEKEY_SERVICE_UUID], true, SCAN_SERVICE_MS)
        // 2) Always do an open scan — Pro often omits service UUID in ADV until bonded,
        //    and localName often arrives only in scan-response packets.
        throwIfCancelled()
        await scanPhase(noble, [], true, discovered.size > 0 ? 4000 : SCAN_OPEN_MS)
      } finally {
        try {
          await noble.stopScanningAsync()
        } catch {
          /* ignore */
        }
        noble.removeListener('discover', onDiscover)
      }
      throwIfCancelled()

      const list = [...discovered.entries()].map(([id, d]) => ({ id, name: d.name }))
      logBle(
        `enumerate done: onekey=${list.length} seen=${lastScanSeen} names=${lastScanNames.join('|') || '-'}`,
      )
      return list
    },

    async getDevice(uuid: string) {
      const id = uuid.toLowerCase()
      const hit = discovered.get(id)
      if (hit) return { id, name: hit.name }
      const conn = connected.get(id)
      if (conn) return { id, name: conn.name }
      // Official handler returns a placeholder so acquire can still try targeted connect.
      return { id, name: 'OneKey Device' }
    },

    async connect(uuid: string) {
      throwIfCancelled()
      const id = uuid.toLowerCase()
      let entry = discovered.get(id)

      if (!entry) {
        logBle('connect: device not in cache, open rescan', id)
        const noble = await loadNoble()
        await waitPoweredOn(noble)
        const onDiscover = (raw: unknown) => {
          const p = raw as Peripheral
          const pid = deviceId(p)
          if (pid === id) {
            discovered.set(id, { peripheral: p, name: deviceName(p) })
          }
        }
        noble.on('discover', onDiscover)
        try {
          await scanPhase(noble, [], true, 4000)
        } finally {
          try {
            await noble.stopScanningAsync()
          } catch {
            /* ignore */
          }
          noble.removeListener('discover', onDiscover)
        }
        entry = discovered.get(id)
      }

      if (!entry) {
        throw new Error(`OneKey Bluetooth device ${uuid} not found. Scan again.`)
      }

      const { peripheral, name } = entry
      throwIfCancelled()
      await forceReconnect(peripheral, id)
      throwIfCancelled()
      const { writeChar, notifyChar } = await discoverCharacteristics(peripheral)

      peripheral.once('disconnect', () => {
        connected.delete(id)
        for (const cb of disconnectListeners) cb({ id, name })
      })
      connected.set(id, { peripheral, name, writeChar, notifyChar })
      logBle('connected', name, id)
    },

    async disconnect(uuid: string) {
      const id = uuid.toLowerCase()
      const conn = connected.get(id)
      if (!conn) return
      try {
        if (conn.onData) conn.notifyChar.removeListener('data', conn.onData)
        await conn.notifyChar.unsubscribeAsync().catch(() => {})
        await conn.peripheral.disconnectAsync()
      } finally {
        connected.delete(id)
      }
    },

    async subscribe(uuid: string) {
      const id = uuid.toLowerCase()
      const conn = connected.get(id)
      if (!conn) throw new Error('OneKey not connected over Bluetooth')
      if (conn.onData) return
      const onData = (data: Buffer) => {
        const hex = Buffer.from(data).toString('hex')
        for (const cb of notificationListeners) cb(id, hex)
      }
      conn.onData = onData
      conn.notifyChar.on('data', onData)
      await conn.notifyChar.subscribeAsync()
      logBle('subscribed', id)
    },

    async unsubscribe(uuid: string) {
      const id = uuid.toLowerCase()
      const conn = connected.get(id)
      if (!conn) return
      if (conn.onData) {
        conn.notifyChar.removeListener('data', conn.onData)
        conn.onData = undefined
      }
      await conn.notifyChar.unsubscribeAsync().catch(() => {})
    },

    async write(uuid: string, data: string) {
      throwIfCancelled()
      const id = uuid.toLowerCase()
      const conn = connected.get(id)
      if (!conn) throw new Error('OneKey not connected over Bluetooth')
      const buf = Buffer.from(data.replace(/^0x/i, ''), 'hex')
      for (let i = 0; i < buf.length; i += BLE_PACKET_SIZE) {
        throwIfCancelled()
        const slice = buf.subarray(i, i + BLE_PACKET_SIZE)
        // Official OneKey stack: write without response
        await conn.writeChar.writeAsync(slice, true)
        await sleep(WRITE_DELAY_MS)
      }
    },

    onNotification(callback) {
      notificationListeners.add(callback)
      return () => {
        notificationListeners.delete(callback)
      }
    },

    onDeviceDisconnected(callback) {
      disconnectListeners.add(callback)
      return () => {
        disconnectListeners.delete(callback)
      }
    },
  }

  ensureGlobalDesktopApi(api)
  return api
}

export function installOneKeyBleDesktopApi(): void {
  ensureGlobalDesktopApi(getOneKeyNobleBleApi())
}

/** For better empty-scan errors in onekey-kaspa. */
export function getLastBleScanDiagnostics(): { seen: number; names: string[] } {
  return { seen: lastScanSeen, names: [...lastScanNames] }
}
