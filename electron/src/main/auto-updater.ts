/**
 * App updates via electron-updater.
 *
 * Production: GitHub Releases on SeedMask/coordinator (from electron-builder publish).
 * Local test: set SEEDMASK_UPDATE_URL to a generic feed (see scripts/serve-local-updates.mjs).
 * Does not publish anything — only checks/downloads when asked.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, ipcMain } = require('electron') as typeof import('electron')
import type { BrowserWindow } from 'electron'
import { spawn, execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import {
  AUTO_UPDATE_DEMO,
  AUTO_UPDATE_DEMO_RELEASE_NOTES,
  AUTO_UPDATE_DEMO_RELEASE_URL,
  AUTO_UPDATE_DEMO_VERSION,
} from './auto-update'

export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  | 'disabled'
  | 'whats-new'

export type UpdaterStatus = {
  phase: UpdaterPhase
  currentVersion: string
  availableVersion?: string
  percent?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
  error?: string
  feed?: string
  packaged: boolean
  message?: string
  demo?: boolean
  releaseNotes?: string
  releaseUrl?: string
}

type GetMainWindow = () => BrowserWindow | null

type PendingWhatsNew = {
  version: string
  releaseNotes?: string
  releaseUrl?: string
}

function pendingWhatsNewPath(): string {
  return join(app.getPath('userData'), 'pending-whats-new.json')
}

function writePendingWhatsNew(payload: PendingWhatsNew): void {
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    writeFileSync(pendingWhatsNewPath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch {
    /* best-effort */
  }
}

function readPendingWhatsNew(): PendingWhatsNew | null {
  try {
    const path = pendingWhatsNewPath()
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf8')) as PendingWhatsNew
    if (!raw || typeof raw.version !== 'string' || !raw.version.trim()) return null
    return {
      version: raw.version.trim(),
      releaseNotes: typeof raw.releaseNotes === 'string' ? raw.releaseNotes : undefined,
      releaseUrl: typeof raw.releaseUrl === 'string' ? raw.releaseUrl : undefined,
    }
  } catch {
    return null
  }
}

function clearPendingWhatsNew(): void {
  try {
    const path = pendingWhatsNewPath()
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* ignore */
  }
}

function releaseMeta(version?: string): Pick<UpdaterStatus, 'releaseNotes' | 'releaseUrl'> {
  if (AUTO_UPDATE_DEMO && (!version || version === AUTO_UPDATE_DEMO_VERSION)) {
    return {
      releaseNotes: AUTO_UPDATE_DEMO_RELEASE_NOTES,
      releaseUrl: AUTO_UPDATE_DEMO_RELEASE_URL,
    }
  }
  if (version) {
    return {
      releaseUrl: `https://github.com/SeedMask/coordinator/releases/tag/v${version}`,
    }
  }
  return {}
}

function baseStatus(): UpdaterStatus {
  return {
    phase: 'idle',
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    demo: AUTO_UPDATE_DEMO,
  }
}

let status: UpdaterStatus = {
  phase: 'idle',
  currentVersion: '0.0.0',
  packaged: false,
  demo: AUTO_UPDATE_DEMO,
}

let configured = false
let checking = false
let demoDownloadTimer: ReturnType<typeof setInterval> | null = null
let holdingWhatsNew = false
let downloadedUpdateFile: string | undefined

function isSameVersion(a?: string, b?: string): boolean {
  const left = (a || '').trim().replace(/^v/i, '')
  const right = (b || '').trim().replace(/^v/i, '')
  return Boolean(left) && left === right
}

function runningMacBundlePath(): string {
  return join(process.execPath, '..', '..', '..')
}

function findMacAppBundle(dir: string, depth = 0): string | null {
  if (depth > 4) return null
  let nested: string | null = null
  for (const name of readdirSync(dir)) {
    if (name === '__MACOSX' || name.startsWith('.')) continue
    const full = join(dir, name)
    try {
      if (!statSync(full).isDirectory()) continue
    } catch {
      continue
    }
    if (name.endsWith('.app')) return full
    nested = findMacAppBundle(full, depth + 1) ?? nested
  }
  return nested
}

/** Ad-hoc / unsigned Mac builds: Squirrel.Mac relaunches the old .app. Replace the bundle ourselves. */
function applyMacZipUpdate(zipPath: string): void {
  const bundlePath = runningMacBundlePath()
  if (!bundlePath.endsWith('.app')) {
    throw new Error('Could not find the running SeedMask Coordinator.app to replace.')
  }
  if (bundlePath.startsWith('/Volumes/')) {
    throw new Error('Move SeedMask Coordinator to Applications, then update from there.')
  }
  const extractDir = join(tmpdir(), `seedmask-update-${Date.now()}`)
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  execFileSync('ditto', ['-x', '-k', zipPath, extractDir], { stdio: 'ignore' })
  const newApp = findMacAppBundle(extractDir)
  if (!newApp) {
    throw new Error('The update zip did not contain SeedMask Coordinator.app.')
  }
  const scriptPath = join(tmpdir(), `seedmask-apply-update-${process.pid}.sh`)
  const script = `#!/bin/bash
set -euo pipefail
APP_PATH=${JSON.stringify(bundlePath)}
NEW_APP=${JSON.stringify(newApp)}
OLD_PID=${String(process.pid)}
i=0
while kill -0 "$OLD_PID" 2>/dev/null; do
  sleep 0.25
  i=$((i + 1))
  if [ "$i" -gt 80 ]; then
    break
  fi
done
sleep 0.5
OLD_COPY="\${APP_PATH}.preupdate.$$"
rm -rf "$OLD_COPY"
if [ -d "$APP_PATH" ]; then
  mv "$APP_PATH" "$OLD_COPY"
fi
ditto "$NEW_APP" "$APP_PATH"
rm -rf "$OLD_COPY"
xattr -dr com.apple.quarantine "$APP_PATH" >/dev/null 2>&1 || true
open "$APP_PATH"
rm -rf ${JSON.stringify(extractDir)}
rm -f ${JSON.stringify(scriptPath)}
`
  writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o755 })
  const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' })
  child.unref()
}

function pushStatus(partial: Partial<UpdaterStatus>): void {
  const nextVersion = partial.availableVersion ?? status.availableVersion
  const meta = releaseMeta(nextVersion)
  const next: UpdaterStatus = {
    ...status,
    ...partial,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    demo: AUTO_UPDATE_DEMO,
  }
  if (!('releaseNotes' in partial)) {
    next.releaseNotes = status.releaseNotes ?? meta.releaseNotes
  } else if (partial.releaseNotes === undefined) {
    delete next.releaseNotes
  }
  if (!('releaseUrl' in partial)) {
    next.releaseUrl = meta.releaseUrl ?? status.releaseUrl
  } else if (partial.releaseUrl === undefined) {
    delete next.releaseUrl
  } else {
    next.releaseUrl = partial.releaseUrl
  }
  status = next
}

function broadcast(getMainWindow: GetMainWindow): void {
  const win = getMainWindow()
  win?.webContents.send('updater:event', status)
}

function rememberWhatsNewForRestart(): void {
  const version = (status.availableVersion || app.getVersion() || '').trim()
  if (!version) return
  const meta = releaseMeta(version)
  writePendingWhatsNew({
    version,
    releaseNotes: status.releaseNotes || meta.releaseNotes || '',
    releaseUrl: status.releaseUrl || meta.releaseUrl,
  })
}

function applyPendingWhatsNew(getMainWindow: GetMainWindow): boolean {
  const pending = readPendingWhatsNew()
  if (!pending) return false
  holdingWhatsNew = true
  const meta = releaseMeta(pending.version)
  pushStatus({
    phase: 'whats-new',
    availableVersion: pending.version,
    releaseNotes: pending.releaseNotes || meta.releaseNotes,
    releaseUrl: pending.releaseUrl || meta.releaseUrl,
    percent: undefined,
    error: undefined,
    message: `Welcome to v${pending.version}.`,
  })
  broadcast(getMainWindow)
  return true
}

function localFeedUrl(): string | null {
  const raw = process.env.SEEDMASK_UPDATE_URL?.trim()
  if (!raw) return null
  return raw.replace(/\/$/, '')
}

function pushDemoAvailable(getMainWindow: GetMainWindow): void {
  checking = false
  pushStatus({
    phase: 'available',
    availableVersion: AUTO_UPDATE_DEMO_VERSION,
    percent: undefined,
    error: undefined,
    feed: status.feed || 'auto-update-demo',
    message: `Version ${AUTO_UPDATE_DEMO_VERSION} is available.`,
  })
  broadcast(getMainWindow)
}

function scheduleDemoAvailableAgain(getMainWindow: GetMainWindow, delayMs = 2000): void {
  // DEMO ONLY — real updater must not re-prompt after a successful install.
  setTimeout(() => {
    pushDemoAvailable(getMainWindow)
  }, delayMs)
}

function configureUpdater(getMainWindow: GetMainWindow): void {
  if (configured) return
  configured = true

  autoUpdater.autoDownload = false
  // macOS: Squirrel.Mac cannot apply ad-hoc signed zips; we swap the .app ourselves.
  autoUpdater.autoInstallOnAppQuit = process.platform !== 'darwin'
  autoUpdater.allowDowngrade = false

  const local = localFeedUrl()
  if (local) {
    autoUpdater.setFeedURL({ provider: 'generic', url: local })
    autoUpdater.forceDevUpdateConfig = true
    pushStatus({ feed: `generic:${local}` })
  } else if (AUTO_UPDATE_DEMO) {
    pushStatus({ feed: 'auto-update-demo' })
  } else {
    pushStatus({ feed: 'github:SeedMask/coordinator' })
  }

  if (process.platform === 'win32') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(autoUpdater as any).verifyUpdateCodeSignature = false
    } catch {
      /* older electron-updater */
    }
  }

  autoUpdater.on('checking-for-update', () => {
    if (AUTO_UPDATE_DEMO) return
    pushStatus({ phase: 'checking', error: undefined, message: 'Checking for updates…' })
    broadcast(getMainWindow)
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    if (AUTO_UPDATE_DEMO) return
    checking = false
    if (isSameVersion(info.version, app.getVersion())) {
      pushStatus({
        phase: 'not-available',
        availableVersion: info.version,
        error: undefined,
        message: 'You are up to date.',
      })
      broadcast(getMainWindow)
      return
    }
    pushStatus({
      phase: 'available',
      availableVersion: info.version,
      error: undefined,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      message: `Version ${info.version} is available.`,
    })
    broadcast(getMainWindow)
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    if (AUTO_UPDATE_DEMO) return
    checking = false
    pushStatus({
      phase: 'not-available',
      availableVersion: info.version,
      error: undefined,
      message: 'You are up to date.',
    })
    broadcast(getMainWindow)
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    if (AUTO_UPDATE_DEMO) return
    pushStatus({
      phase: 'downloading',
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
      message: `Downloading… ${Math.floor(progress.percent)}%`,
    })
    broadcast(getMainWindow)
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo & { downloadedFile?: string }) => {
    if (AUTO_UPDATE_DEMO) return
    downloadedUpdateFile = info.downloadedFile || downloadedUpdateFile
    pushStatus({
      phase: 'downloaded',
      availableVersion: info.version,
      percent: 100,
      error: undefined,
      message: `Version ${info.version} downloaded. Restart to install.`,
    })
    broadcast(getMainWindow)
  })

  autoUpdater.on('error', (err: Error) => {
    if (AUTO_UPDATE_DEMO) return
    checking = false
    pushStatus({
      phase: 'error',
      error: err?.message || String(err),
      message: err?.message || 'Update failed.',
    })
    broadcast(getMainWindow)
  })
}

async function checkForUpdates(getMainWindow: GetMainWindow): Promise<UpdaterStatus> {
  configureUpdater(getMainWindow)
  if (holdingWhatsNew) return status

  if (AUTO_UPDATE_DEMO) {
    pushStatus({ phase: 'checking', error: undefined, message: 'Checking for updates…' })
    broadcast(getMainWindow)
    await new Promise((r) => setTimeout(r, 600))
    pushDemoAvailable(getMainWindow)
    return status
  }

  if (!app.isPackaged && !localFeedUrl()) {
    pushStatus({
      phase: 'disabled',
      message:
        'Updates run in the installed app. For local testing, package a build and set SEEDMASK_UPDATE_URL.',
    })
    broadcast(getMainWindow)
    return status
  }

  if (checking) return status
  checking = true
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    checking = false
    const message = e instanceof Error ? e.message : String(e)
    pushStatus({ phase: 'error', error: message, message })
    broadcast(getMainWindow)
  }
  return status
}

async function downloadUpdate(getMainWindow: GetMainWindow): Promise<UpdaterStatus> {
  configureUpdater(getMainWindow)
  if (status.phase !== 'available' && status.phase !== 'error' && status.phase !== 'downloaded') {
    return status
  }

  if (AUTO_UPDATE_DEMO) {
    if (demoDownloadTimer) clearInterval(demoDownloadTimer)
    let percent = 0
    pushStatus({
      phase: 'downloading',
      percent: 0,
      availableVersion: AUTO_UPDATE_DEMO_VERSION,
      message: 'Downloading… 0%',
      error: undefined,
    })
    broadcast(getMainWindow)
    // ~10s fake download — real builds take longer; this should still feel deliberate.
    await new Promise<void>((resolve) => {
      demoDownloadTimer = setInterval(() => {
        const step = percent < 70 ? 4 : percent < 92 ? 3 : 2
        percent = Math.min(100, percent + step)
        if (percent >= 100) {
          if (demoDownloadTimer) clearInterval(demoDownloadTimer)
          demoDownloadTimer = null
          pushStatus({
            phase: 'downloaded',
            percent: 100,
            availableVersion: AUTO_UPDATE_DEMO_VERSION,
            message: `Version ${AUTO_UPDATE_DEMO_VERSION} downloaded.`,
            error: undefined,
          })
          broadcast(getMainWindow)
          resolve()
          return
        }
        pushStatus({
          phase: 'downloading',
          percent,
          availableVersion: AUTO_UPDATE_DEMO_VERSION,
          message: `Downloading… ${percent}%`,
        })
        broadcast(getMainWindow)
      }, 420)
    })
    return status
  }

  try {
    pushStatus({ phase: 'downloading', percent: 0, message: 'Starting download…', error: undefined })
    broadcast(getMainWindow)
    await autoUpdater.downloadUpdate()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    pushStatus({ phase: 'error', error: message, message })
    broadcast(getMainWindow)
  }
  return status
}

async function installUpdate(getMainWindow: GetMainWindow): Promise<{ ok: boolean; error?: string }> {
  if (status.phase !== 'downloaded' && status.phase !== 'installing') {
    return { ok: false, error: 'No update downloaded yet.' }
  }

  rememberWhatsNewForRestart()

  if (process.platform === 'darwin' && !AUTO_UPDATE_DEMO) {
    pushStatus({
      phase: 'installing',
      percent: 100,
      message: 'Installing update…',
      error: undefined,
    })
    broadcast(getMainWindow)
    try {
      if (!downloadedUpdateFile || !existsSync(downloadedUpdateFile)) {
        throw new Error('Update zip not found. Try Update now again.')
      }
      applyMacZipUpdate(downloadedUpdateFile)
      app.quit()
      return { ok: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      pushStatus({ phase: 'error', error: message, message })
      broadcast(getMainWindow)
      return { ok: false, error: message }
    }
  }

  if (AUTO_UPDATE_DEMO) {
    pushStatus({
      phase: 'installing',
      percent: 100,
      message: 'Installing update…',
      error: undefined,
    })
    broadcast(getMainWindow)
    await new Promise((r) => setTimeout(r, 3200))
    pushStatus({
      phase: 'installing',
      percent: 100,
      message: 'Restarting Coordinator…',
      error: undefined,
    })
    broadcast(getMainWindow)
    await new Promise((r) => setTimeout(r, 2200))
    try {
      // DEMO ONLY paths below. Production: always autoUpdater.quitAndInstall(false, true).
      // Packaged sim: relaunch. Dev (electron-vite): soft reload so the session survives.
      if (!app.isPackaged) {
        // Soft reload keeps main alive — apply What’s new before the renderer reloads.
        applyPendingWhatsNew(getMainWindow)
        const win = getMainWindow()
        win?.webContents.reloadIgnoringCache()
        return { ok: true }
      }
      app.relaunch()
      app.exit(0)
      return { ok: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      pushStatus({ phase: 'error', error: message, message })
      broadcast(getMainWindow)
      return { ok: false, error: message }
    }
  }

  try {
    autoUpdater.quitAndInstall(false, true)
    return { ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message }
  }
}

function dismissWhatsNew(getMainWindow: GetMainWindow): UpdaterStatus {
  clearPendingWhatsNew()
  holdingWhatsNew = false
  pushStatus({
    phase: 'idle',
    availableVersion: undefined,
    percent: undefined,
    error: undefined,
    message: undefined,
    releaseNotes: undefined,
    releaseUrl: undefined,
  })
  broadcast(getMainWindow)
  if (AUTO_UPDATE_DEMO) {
    // DEMO ONLY — re-offer so UX can be retested. Real releases: stay idle after dismiss.
    scheduleDemoAvailableAgain(getMainWindow, 2500)
  }
  return status
}

/** Download then install (used by Update now). */
async function applyUpdate(getMainWindow: GetMainWindow): Promise<UpdaterStatus> {
  if (status.phase === 'available' || status.phase === 'error') {
    await downloadUpdate(getMainWindow)
  }
  if (status.phase === 'downloaded') {
    await installUpdate(getMainWindow)
  }
  return status
}

export function registerAutoUpdater(getMainWindow: GetMainWindow): void {
  status = { ...baseStatus(), ...status, phase: status.phase === 'idle' ? 'idle' : status.phase }
  configureUpdater(getMainWindow)

  ipcMain.handle('updater:get-status', () => status)
  ipcMain.handle('updater:check', () => checkForUpdates(getMainWindow))
  ipcMain.handle('updater:download', () => downloadUpdate(getMainWindow))
  ipcMain.handle('updater:install', () => installUpdate(getMainWindow))
  ipcMain.handle('updater:apply', () => applyUpdate(getMainWindow))
  ipcMain.handle('updater:dismiss-whats-new', () => dismissWhatsNew(getMainWindow))

  // After Update → restart: show What’s new before any “update available” prompt.
  if (applyPendingWhatsNew(getMainWindow)) {
    return
  }

  if (AUTO_UPDATE_DEMO) {
    setTimeout(() => {
      if (holdingWhatsNew) return
      pushDemoAvailable(getMainWindow)
    }, 1_500)
    return
  }

  if (app.isPackaged || localFeedUrl()) {
    setTimeout(() => {
      if (holdingWhatsNew) return
      void checkForUpdates(getMainWindow)
    }, 8_000)
  }
}
