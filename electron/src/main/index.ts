/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, session, clipboard } =
  require('electron') as typeof import('electron')
import { join, relative, resolve, isAbsolute } from 'path'
import { homedir } from 'os'
import { existsSync, mkdirSync, renameSync, cpSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { BackendManager } from './backend-manager'
import {
  importKaspaWatchOnlyFromLedger,
  listLedgerBleDevices,
  listLedgerUsbDevices,
  signKaspaUnsignedWithLedger,
} from './ledger-kaspa'
import {
  importBitcoinWatchOnlyFromLedger,
  signBitcoinPsbtWithLedger,
} from './ledger-bitcoin'
import {
  clearHardwareCancel,
  ensureBluetoothPoweredOn,
  importKaspaWatchOnlyFromOneKey,
  listOneKeyBleDevices,
  listOneKeyUsbDevices,
  requestHardwareCancel,
  setOneKeyPassphraseChoiceHandler,
  signKaspaUnsignedWithOneKey,
  type OneKeyPassphraseChoice,
} from './onekey-kaspa'
import {
  importBitcoinWatchOnlyFromOneKey,
  signBitcoinPsbtWithOneKey,
  type BitcoinScriptType,
} from './onekey-bitcoin'
import { APP_NAME, resolveAppIconPath, isTranslocatedMacApp } from './paths'
import { buildExportQrPacks } from './ur-qr'
import { registerAutoUpdater } from './auto-updater'

type BrowserWindowInstance = InstanceType<typeof BrowserWindow>

/** App wallet data dir — same as Python ~/.seedmask-coordinator. */
function seedmaskDataDir(): string {
  return join(homedir(), '.seedmask-coordinator')
}

function seedmaskVisibleDataDir(): string {
  return join(homedir(), 'SeedMask Coordinator')
}

function seedmaskWalletsDir(): string {
  return join(seedmaskDataDir(), 'wallets')
}

/** Undo the brief visible-folder experiment if needed. */
function migrateVisibleDataDirBack(): void {
  const hidden = seedmaskDataDir()
  const visible = seedmaskVisibleDataDir()
  if (existsSync(hidden) || !existsSync(visible)) return
  try {
    renameSync(visible, hidden)
  } catch {
    try {
      cpSync(visible, hidden, { recursive: true })
    } catch {
      /* leave visible copy; dialogs use hidden path once created */
    }
  }
}

/** Prefer wallets/; fall back to the data root. Always an absolute path. */
function seedmaskImportExportDir(): string {
  migrateVisibleDataDirBack()
  const data = seedmaskDataDir()
  const wallets = seedmaskWalletsDir()
  try {
    if (!existsSync(data)) mkdirSync(data, { recursive: true })
    if (!existsSync(wallets)) mkdirSync(wallets, { recursive: true })
    return wallets
  } catch {
    return data
  }
}

function isInsideDir(filePath: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(filePath))
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

function isInsideWalletsFolder(filePath: string): boolean {
  if (isInsideDir(filePath, seedmaskWalletsDir())) return true
  return isInsideDir(filePath, join(homedir(), 'SeedMask Coordinator', 'wallets'))
}

/**
 * Default Save / Import location: ~/.seedmask-coordinator/wallets.
 * Dialogs also set showHiddenFiles so the hidden parent stays visible if the user navigates up.
 */
function resolveSeedmaskDialogPath(defaultPath?: string): string {
  if (defaultPath && (defaultPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(defaultPath))) {
    return defaultPath
  }
  const base = seedmaskImportExportDir()
  if (!defaultPath) return base
  return join(base, defaultPath)
}

function isPackagedApp(): boolean {
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) return true
  return __dirname.includes('app.asar')
}

const DEFAULT_PORT = 18765
let mainWindow: BrowserWindowInstance | null = null
let backend: BackendManager | null = null
let backendStartPromise: Promise<number> | null = null

// macOS menu bar / process name — must be set before app.ready (packaged .app already has this).
if (!isPackagedApp()) {
  app.setName(APP_NAME)
}

function showRendererErrorPage(reason: string): void {
  const win = mainWindow
  if (!win) return
  const safe = reason.replace(/[<>&]/g, '')
  void win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#0c0c0d;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:32px"><div><h1>SeedMask Coordinator</h1><p>${safe}</p><p style="opacity:.6">Try quitting the app fully (Cmd+Q) and opening again from Applications.</p></div></body></html>`)}`,
  )
  win.show()
}

function stopBackend(): void {
  backend?.stop()
  backend = null
  backendStartPromise = null
}

function ensureBackendStarting(): Promise<number> {
  // After macOS window close we used to kill the backend but leave a resolved
  // promise — Dock re-open then skipped restart and spun forever. Restart when gone.
  if (!backend?.isRunning()) {
    backendStartPromise = null
  }
  if (!backendStartPromise) {
    backendStartPromise = startBackend().catch((err) => {
      backendStartPromise = null
      throw err
    })
  }
  return backendStartPromise
}

function showOrCreateMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  createWindow()
}

function applyAppIcon(): string | undefined {
  if (isPackagedApp()) return undefined
  const windowIcon = resolveAppIconPath(false)
  const dockIconPath = resolveAppIconPath(true) ?? windowIcon
  if (dockIconPath && process.platform === 'darwin' && app.dock) {
    const dockImage = nativeImage.createFromPath(dockIconPath)
    if (!dockImage.isEmpty()) {
      const sized =
        dockImage.getSize().width > 512
          ? dockImage.resize({ width: 512, height: 512, quality: 'best' })
          : dockImage
      app.dock.setIcon(sized)
    }
  }
  return windowIcon
}

function createWindow(): void {
  const iconPath = applyAppIcon()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: '#0c0c0d',
    show: false,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.on('did-fail-load', (_event: unknown, code: number, desc: string, url: string) => {
    console.error(`Renderer failed to load (${code}): ${desc} — ${url}`)
    if (code !== -3) {
      showRendererErrorPage(`UI failed to load (${code}): ${desc}`)
    }
  })
  mainWindow.webContents.on(
    'render-process-gone',
    (_event: unknown, details: { reason: string; exitCode: number }) => {
    console.error('Renderer process gone:', details.reason, details.exitCode)
    showRendererErrorPage(`UI process stopped (${details.reason}).`)
    },
  )
  mainWindow.webContents.on(
    'console-message',
    (_event: unknown, level: number, message: string, line: number, sourceId: string) => {
    if (level >= 2) {
      console.error(`[renderer] ${message} (${sourceId}:${line})`)
    }
    },
  )

  mainWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  void ensureBackendStarting().catch((err) => {
    console.error('Backend failed to start:', err)
    const msg = err instanceof Error ? err.message : String(err)
    showRendererErrorPage(msg)
  })
}

async function startBackend(): Promise<number> {
  backend = new BackendManager(DEFAULT_PORT)
  await backend.start()
  return DEFAULT_PORT
}

function registerIpc(): void {
  ipcMain.handle('backend:get-port', () => DEFAULT_PORT)
  ipcMain.handle('backend:get-log-path', () => backend?.logPath ?? null)
  ipcMain.handle('backend:wait-ready', async () => {
    try {
      await ensureBackendStarting()
      return { ok: true as const, logPath: backend?.logPath ?? null }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return {
        ok: false as const,
        error: message,
        logPath: backend?.logPath ?? null,
        translocated: isTranslocatedMacApp(),
      }
    }
  })
  ipcMain.handle('shell:open-path', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('shell:open-external', (_e, url: string) => shell.openExternal(url))

  ipcMain.handle(
    'dialog:save-file',
    async (_e, opts: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow
      if (!win) return null
      const res = await dialog.showSaveDialog(win, {
        defaultPath: resolveSeedmaskDialogPath(opts.defaultPath),
        filters: opts.filters,
        properties: ['showHiddenFiles', 'createDirectory'],
      })
      if (res.canceled || !res.filePath) return null
      const dest = res.filePath
      if (isInsideWalletsFolder(dest) && existsSync(dest)) {
        const choice = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['Cancel', 'Replace anyway'],
          defaultId: 0,
          cancelId: 0,
          message: 'A file with this name already exists in Coordinator’s wallets folder.',
          detail:
            'If you replace it, removing that wallet in Coordinator will delete this file too.',
        })
        if (choice.response !== 1) return null
      }
      return dest
    },
  )

  ipcMain.handle(
    'dialog:open-file',
    async (
      _e,
      opts: {
        filters?: { name: string; extensions: string[] }[]
        multi?: boolean
        title?: string
        message?: string
        defaultPath?: string
      },
    ) => {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow
      if (!win) return null
      const props: Array<
        'openFile' | 'multiSelections' | 'showHiddenFiles'
      > = opts.multi ? ['openFile', 'multiSelections', 'showHiddenFiles'] : ['openFile', 'showHiddenFiles']
      const res = await dialog.showOpenDialog(win, {
        title: opts.title,
        message: opts.message,
        defaultPath: resolveSeedmaskDialogPath(opts.defaultPath),
        // Like Sparrow Open/Import wallet: show dotfolders so ~/.seedmask-coordinator
        // stays findable after navigating away from wallets/.
        properties: props,
        filters: opts.filters,
      })
      if (res.canceled || !res.filePaths.length) return null
      return opts.multi ? res.filePaths : res.filePaths[0]
    },
  )

  ipcMain.handle(
    'dialog:pick-path',
    async (_e, opts: { title?: string; message?: string }) => {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow
      if (!win) return null
      const res = await dialog.showOpenDialog(win, {
        title: opts.title,
        message: opts.message,
        properties: ['openFile', 'openDirectory'],
        buttonLabel: 'Choose',
      })
      if (res.canceled || !res.filePaths.length) return null
      return res.filePaths[0] ?? null
    },
  )

  ipcMain.handle('fs:read-file', async (_e, filePath: string) => {
    const buf = await readFile(filePath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })

  ipcMain.handle('fs:write-file', async (_e, filePath: string, data: ArrayBuffer) => {
    await writeFile(filePath, Buffer.from(data))
    return true
  })

  ipcMain.handle('clipboard:write-text', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })

  ipcMain.handle('clipboard:read-text', () => clipboard.readText())

  ipcMain.handle(
    'qr:export-packs',
    async (_e, text: string, preferredEncoding: 'ur' | 'plain' = 'ur') => {
      try {
        const packs = await buildExportQrPacks(String(text ?? ''), preferredEncoding)
        return { ok: true as const, ...packs }
      } catch (e) {
        return {
          ok: false as const,
          error: e instanceof Error ? e.message : String(e),
        }
      }
    },
  )

  ipcMain.handle('bluetooth:ensure-on', async () => {
    try {
      return await ensureBluetoothPoweredOn()
    } catch (e) {
      return {
        ok: false as const,
        state: 'error',
        error: e instanceof Error ? e.message : String(e),
      }
    }
  })

  ipcMain.handle('hardware:cancel', async () => {
    try {
      requestHardwareCancel()
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('ledger:list', async (_e, opts?: { link?: 'usb' | 'ble' }) => {
    const link = opts?.link === 'ble' ? 'ble' : 'usb'
    try {
      const devices =
        link === 'ble'
          ? await listLedgerBleDevices({ stopOnFirst: true, timeoutMs: 5000 })
          : await listLedgerUsbDevices()
      console.log(`[ledger] ${link.toUpperCase()} scan found ${devices.length} device(s)`)
      return { ok: true as const, devices }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error(`[ledger] ${link.toUpperCase()} scan failed:`, error)
      return {
        ok: false as const,
        devices: [],
        error,
      }
    }
  })

  ipcMain.handle(
    'ledger:import-kaspa',
    async (event, opts?: { account?: number; devicePath?: string; link?: 'usb' | 'ble' }) => {
      try {
        const result = await importKaspaWatchOnlyFromLedger({
          account: opts?.account,
          devicePath: opts?.devicePath,
          link: opts?.link === 'ble' ? 'ble' : 'usb',
          onProgress: (p) => {
            try {
              event.sender.send('ledger:import-progress', p)
            } catch {
              /* window gone */
            }
          },
        })
        return { ok: true as const, result }
      } catch (e) {
        return {
          ok: false as const,
          error: e instanceof Error ? e.message : String(e),
        }
      }
    },
  )

  ipcMain.handle(
    'ledger:sign-kaspa',
    async (_e, opts?: { unsigned?: unknown; devicePath?: string; link?: 'usb' | 'ble' }) => {
      try {
        if (!opts?.unsigned || typeof opts.unsigned !== 'object') {
          throw new Error('Missing unsigned transaction for Ledger signing')
        }
        clearHardwareCancel()
        const result = await signKaspaUnsignedWithLedger({
          unsigned: opts.unsigned as Parameters<typeof signKaspaUnsignedWithLedger>[0]['unsigned'],
          devicePath: opts.devicePath,
          link: opts?.link === 'ble' ? 'ble' : 'usb',
        })
        return { ok: true as const, result }
      } catch (e) {
        return {
          ok: false as const,
          error: e instanceof Error ? e.message : String(e),
        }
      }
    },
  )

  ipcMain.handle(
    'ledger:import-bitcoin',
    async (
      event,
      opts?: {
        account?: number
        scriptType?: BitcoinScriptType
        policyType?: 'singlesig' | 'multisig'
        devicePath?: string
        link?: 'usb' | 'ble'
      },
    ) => {
      try {
        clearHardwareCancel()
        const scriptType: BitcoinScriptType =
          opts?.scriptType === 'nested_segwit' ||
          opts?.scriptType === 'legacy' ||
          opts?.scriptType === 'taproot'
            ? opts.scriptType
            : 'native_segwit'
        const result = await importBitcoinWatchOnlyFromLedger({
          account: opts?.account,
          scriptType,
          policyType: opts?.policyType === 'multisig' ? 'multisig' : 'singlesig',
          devicePath: opts?.devicePath,
          link: opts?.link === 'ble' ? 'ble' : 'usb',
          onProgress: (p) => {
            try {
              event.sender.send('ledger:import-progress', p)
            } catch {
              /* window gone */
            }
          },
        })
        return { ok: true as const, result }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return {
          ok: false as const,
          error: message,
          cancelled: /^cancelled$/i.test(message),
        }
      }
    },
  )

  ipcMain.handle(
    'ledger:sign-bitcoin',
    async (
      event,
      opts?: {
        psbtBase64?: string
        kpub?: string
        scriptType?: BitcoinScriptType
        derivation?: string
        fingerprint?: string
        multisig?: {
          required: number
          total: number
          cosigners: Array<{
            xpub: string
            fingerprint?: string
            derivation?: string
            label?: string
          }>
        }
        devicePath?: string
        link?: 'usb' | 'ble'
      },
    ) => {
      try {
        if (!opts?.psbtBase64 || typeof opts.psbtBase64 !== 'string') {
          throw new Error('Missing PSBT for Ledger Bitcoin signing')
        }
        clearHardwareCancel()
        const scriptType: BitcoinScriptType =
          opts?.scriptType === 'nested_segwit' ||
          opts?.scriptType === 'legacy' ||
          opts?.scriptType === 'taproot'
            ? opts.scriptType
            : 'native_segwit'
        const result = await signBitcoinPsbtWithLedger({
          psbtBase64: opts.psbtBase64,
          kpub: opts.kpub,
          scriptType,
          derivation: opts.derivation,
          fingerprint: opts.fingerprint,
          multisig: opts.multisig,
          devicePath: opts.devicePath,
          link: opts?.link === 'ble' ? 'ble' : 'usb',
          onProgress: (p) => {
            try {
              event.sender.send('ledger:import-progress', p)
            } catch {
              /* ignore */
            }
          },
        })
        return { ok: true as const, result }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return {
          ok: false as const,
          error: message,
          cancelled: /^cancelled$/i.test(message),
        }
      }
    },
  )

  ipcMain.handle('onekey:list', async (_e, opts?: { link?: 'usb' | 'ble' }) => {
    const link = opts?.link === 'ble' ? 'ble' : 'usb'
    try {
      if (link === 'ble') clearHardwareCancel()
      const devices = link === 'ble' ? await listOneKeyBleDevices() : await listOneKeyUsbDevices()
      console.log(`[onekey] ${link.toUpperCase()} scan found ${devices.length} device(s)`)
      return { ok: true as const, devices }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error(`[onekey] ${link.toUpperCase()} scan failed:`, error)
      return {
        ok: false as const,
        devices: [],
        error,
        cancelled: /^cancelled$/i.test(error),
      }
    }
  })

  let passphraseChoiceResolve: ((choice: OneKeyPassphraseChoice | 'cancel') => void) | null = null

  function wirePassphraseChoice(sender: { send: (channel: string, ...args: unknown[]) => void }): void {
    setOneKeyPassphraseChoiceHandler(
      () =>
        new Promise<OneKeyPassphraseChoice | 'cancel'>((resolve) => {
          passphraseChoiceResolve = resolve
          try {
            sender.send('onekey:need-passphrase-choice', {
              allowHiddenPin: true,
            })
          } catch {
            resolve('standard')
          }
        }),
    )
  }

  ipcMain.handle('onekey:passphrase-choice', (_e, choice?: string) => {
    if (choice === 'cancel') {
      passphraseChoiceResolve?.('cancel')
      passphraseChoiceResolve = null
      requestHardwareCancel()
      return { ok: true as const }
    }
    // A real choice starts a fresh attempt — clear sticky cancel from a prior Cancel.
    clearHardwareCancel()
    const normalized: OneKeyPassphraseChoice =
      choice === 'standard' ? 'standard' : choice === 'hidden-pin' ? 'hidden-pin' : 'temporary'
    passphraseChoiceResolve?.(normalized)
    passphraseChoiceResolve = null
    return { ok: true as const }
  })

  ipcMain.handle(
    'onekey:import-kaspa',
    async (
      event,
      opts?: {
        account?: number
        accountMode?: 'onekey-app' | 'bip44'
        devicePath?: string
        link?: 'usb' | 'ble'
      },
    ) => {
      try {
        clearHardwareCancel()
        wirePassphraseChoice(event.sender)
        const result = await importKaspaWatchOnlyFromOneKey({
          account: opts?.account,
          accountMode: opts?.accountMode,
          devicePath: opts?.devicePath,
          link: opts?.link === 'ble' ? 'ble' : 'usb',
          onProgress: (p) => {
            try {
              event.sender.send('onekey:import-progress', p)
            } catch {
              /* window gone */
            }
          },
        })
        return { ok: true as const, result }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return {
          ok: false as const,
          error: message,
          cancelled: /^cancelled$/i.test(message),
        }
      } finally {
        setOneKeyPassphraseChoiceHandler(null)
        // If import ended while the choice dialog was open, unblock the waiter.
        passphraseChoiceResolve?.('standard')
        passphraseChoiceResolve = null
      }
    },
  )

  ipcMain.handle(
    'onekey:sign-kaspa',
    async (event, opts?: { unsigned?: unknown; devicePath?: string; link?: 'usb' | 'ble' }) => {
      try {
        if (!opts?.unsigned || typeof opts.unsigned !== 'object') {
          throw new Error('Missing unsigned transaction for OneKey signing')
        }
        clearHardwareCancel()
        wirePassphraseChoice(event.sender)
        const result = await signKaspaUnsignedWithOneKey({
          unsigned: opts.unsigned as Parameters<typeof signKaspaUnsignedWithOneKey>[0]['unsigned'],
          devicePath: opts.devicePath,
          link: opts?.link === 'ble' ? 'ble' : 'usb',
          onProgress: (p) => {
            try {
              event.sender.send('onekey:import-progress', p)
            } catch {
              /* ignore */
            }
          },
        })
        return { ok: true as const, result }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return {
          ok: false as const,
          error: message,
          cancelled: /^cancelled$/i.test(message),
        }
      } finally {
        setOneKeyPassphraseChoiceHandler(null)
        passphraseChoiceResolve?.('cancel')
        passphraseChoiceResolve = null
      }
    },
  )

  ipcMain.handle(
    'onekey:import-bitcoin',
    async (
      event,
      opts?: {
        account?: number
        scriptType?: BitcoinScriptType
        policyType?: 'singlesig' | 'multisig'
        devicePath?: string
        link?: 'usb' | 'ble'
      },
    ) => {
      try {
        clearHardwareCancel()
        wirePassphraseChoice(event.sender)
        const scriptType: BitcoinScriptType =
          opts?.scriptType === 'nested_segwit' ||
          opts?.scriptType === 'legacy' ||
          opts?.scriptType === 'taproot'
            ? opts.scriptType
            : 'native_segwit'
        const result = await importBitcoinWatchOnlyFromOneKey({
          account: opts?.account,
          scriptType,
          policyType: opts?.policyType === 'multisig' ? 'multisig' : 'singlesig',
          devicePath: opts?.devicePath,
          link: opts?.link === 'ble' ? 'ble' : 'usb',
          onProgress: (p) => {
            try {
              event.sender.send('onekey:import-progress', p)
            } catch {
              /* window gone */
            }
          },
        })
        return { ok: true as const, result }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return {
          ok: false as const,
          error: message,
          cancelled: /^cancelled$/i.test(message),
        }
      } finally {
        setOneKeyPassphraseChoiceHandler(null)
        passphraseChoiceResolve?.('standard')
        passphraseChoiceResolve = null
      }
    },
  )

  ipcMain.handle(
    'onekey:sign-bitcoin',
    async (
      event,
      opts?: {
        psbtBase64?: string
        kpub?: string
        scriptType?: BitcoinScriptType
        devicePath?: string
        link?: 'usb' | 'ble'
      },
    ) => {
      try {
        if (!opts?.psbtBase64 || typeof opts.psbtBase64 !== 'string') {
          throw new Error('Missing PSBT for OneKey Bitcoin signing')
        }
        clearHardwareCancel()
        wirePassphraseChoice(event.sender)
        const scriptType: BitcoinScriptType =
          opts?.scriptType === 'nested_segwit' ||
          opts?.scriptType === 'legacy' ||
          opts?.scriptType === 'taproot'
            ? opts.scriptType
            : 'native_segwit'
        const result = await signBitcoinPsbtWithOneKey({
          psbtBase64: opts.psbtBase64,
          kpub: opts.kpub,
          scriptType,
          devicePath: opts.devicePath,
          link: opts?.link === 'ble' ? 'ble' : 'usb',
          onProgress: (p) => {
            try {
              event.sender.send('onekey:import-progress', p)
            } catch {
              /* ignore */
            }
          },
        })
        return { ok: true as const, result }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return {
          ok: false as const,
          error: message,
          cancelled: /^cancelled$/i.test(message),
        }
      } finally {
        setOneKeyPassphraseChoiceHandler(null)
        passphraseChoiceResolve?.('cancel')
        passphraseChoiceResolve = null
      }
    },
  )
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showOrCreateMainWindow()
  })

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'media' || String(permission) === 'camera')
    })
    registerIpc()
    registerAutoUpdater(() => mainWindow)
    createWindow()
  })

  app.on('activate', () => {
    showOrCreateMainWindow()
  })

  app.on('window-all-closed', () => {
    // macOS: keep process + backend alive in the Dock until Cmd+Q.
    if (process.platform !== 'darwin') {
      stopBackend()
      app.quit()
    }
  })

  app.on('before-quit', () => {
    stopBackend()
  })

}
