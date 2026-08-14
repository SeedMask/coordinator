import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { app } from 'electron'
import { canRunPython } from './python-probe'

export const APP_NAME = 'SeedMask Coordinator'

export function isPackagedApp(): boolean {
  try {
    return app.isPackaged
  } catch {
    return __dirname.includes('app.asar')
  }
}

/** macOS runs DMG-launched apps from a read-only translocated copy — backend spawn often fails. */
export function isTranslocatedMacApp(): boolean {
  if (process.platform !== 'darwin' || !isPackagedApp()) return false
  const markers = [process.resourcesPath, process.execPath, appBundlePath()]
  return markers.some((p) => p.includes('AppTranslocation'))
}

export function appBundlePath(): string {
  return join(process.execPath, '..', '..', '..')
}

/** macOS TCC-protected user folders — reading here prompts “files on the Desktop”, etc. */
export function isMacUserProtectedPath(filePath: string): boolean {
  if (process.platform !== 'darwin') return false
  const home = homedir()
  const protectedRoots = ['Desktop', 'Documents', 'Downloads'].map((name) => join(home, name))
  const resolved = filePath
  return protectedRoots.some(
    (root) => resolved === root || resolved.startsWith(root + '/') || resolved.startsWith(root + '\\'),
  )
}

/** Packaged .app launched from Desktop/Documents/Downloads (common after local builds). */
export function isPackagedAppInProtectedFolder(): boolean {
  if (!isPackagedApp()) return false
  return isMacUserProtectedPath(appBundlePath())
}

/**
 * Clear quarantine on the critical binaries only.
 * Do NOT run recursive `xattr -cr` / `-dr` on the whole .app — that walks every
 * file and triggers macOS Desktop/Documents TCC when the build lives under ~/Desktop.
 * Also skip entirely when the bundle itself is under a TCC-protected folder —
 * quarantine is cleared after install into /Applications instead.
 */
export function clearMacQuarantine(): void {
  if (process.platform !== 'darwin' || !isPackagedApp()) return
  if (isPackagedAppInProtectedFolder()) return
  const targets = [
    appBundlePath(),
    process.execPath,
    join(process.resourcesPath, 'runtime', 'python', 'bin', 'python3'),
    join(process.resourcesPath, 'runtime', 'node', 'bin', 'node'),
  ]
  for (const target of targets) {
    if (isMacUserProtectedPath(target)) continue
    if (!existsSync(target)) continue
    try {
      execSync(`xattr -d com.apple.quarantine "${target}" 2>/dev/null || true`, {
        shell: '/bin/bash',
      })
    } catch {
      /* non-fatal */
    }
  }
}

function devBuildDir(): string[] {
  return [join(process.cwd(), 'build'), join(__dirname, '..', '..', 'build')]
}

/** SeedMask dock/window icon (dev uses electron/build; packaged app embeds its own). */
export function resolveAppIconPath(preferPng = false): string | undefined {
  const names = preferPng
    ? ['icon.png', 'icon.icns', 'icon.ico']
    : process.platform === 'darwin'
      ? ['icon.icns', 'icon.png']
      : process.platform === 'win32'
        ? ['icon.ico', 'icon.png']
        : ['icon.png', 'icon.icns']
  const roots = isPackagedApp() ? [] : devBuildDir()
  for (const root of roots) {
    for (const name of names) {
      const path = join(root, name)
      if (existsSync(path)) return path
    }
  }
  return undefined
}

function runtimeBaseCandidates(): string[] {
  if (isPackagedApp()) return [join(process.resourcesPath, 'runtime')]
  return devBuildDir().map((d) => join(d, 'runtime'))
}

export function bundledRuntimeDir(): string | undefined {
  for (const base of runtimeBaseCandidates()) {
    const python =
      process.platform === 'win32'
        ? [join(base, 'python', 'python.exe'), join(base, 'python', 'Scripts', 'python.exe')].find((p) =>
            existsSync(p),
          )
        : join(base, 'python', 'bin', 'python3')
    if (python && existsSync(python)) return base
  }
  return undefined
}

/** Coordinator root = folder containing run_backend.py */
export function findCoordinatorRoot(): string {
  const env = process.env.SEEDMASK_COORDINATOR_ROOT?.trim()
  if (env && existsSync(join(env, 'run_backend.py'))) return env

  // Packaged: Resources/coordinator
  if (isPackagedApp()) {
    const packaged = join(process.resourcesPath, 'coordinator')
    if (existsSync(join(packaged, 'run_backend.py'))) return packaged
  }

  // out/main -> SeedMask_Coordinator/electron/out/main -> ../../.. = coordinator root
  const relativeRoot = join(__dirname, '..', '..', '..')
  if (existsSync(join(relativeRoot, 'run_backend.py'))) return relativeRoot

  throw new Error(
    'Cannot find coordinator backend (run_backend.py). Set SEEDMASK_COORDINATOR_ROOT or run from SeedMask_Coordinator/electron.',
  )
}

/** User-writable log dir (never inside .app bundle — DMG mounts are read-only). */
export function writableLogsDir(): string {
  const dir = join(homedir(), 'Library', 'Logs', APP_NAME, 'seedmask-backend')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function backendStderrLogPath(): string {
  return join(writableLogsDir(), 'backend_stderr.log')
}

export function resolvePython(coordinatorRoot: string): string {
  const env = process.env.SEEDMASK_PYTHON?.trim()
  if (env && canRunPython(env)) return env

  const venv =
    process.platform === 'win32'
      ? join(coordinatorRoot, '.venv', 'Scripts', 'python.exe')
      : join(coordinatorRoot, '.venv', 'bin', 'python3')
  // Prefer the project venv in dev — it is the supported local setup and avoids
  // picking a system Python (e.g. /usr/bin/python3) that lacks coordinator deps.
  if (existsSync(venv) && canRunPython(venv)) return venv

  const bundled = bundledRuntimePaths().python
  // Packaged builds ship a vetted runtime. Probing it via execSync is slow and often
  // fails under macOS hardened runtime, which blocked the window for minutes.
  if (bundled) {
    if (isPackagedApp()) return bundled
    if (canRunPython(bundled)) return bundled
  }

  const candidates =
    process.platform === 'win32'
      ? ['python', 'python3']
      : [
          '/opt/homebrew/bin/python3.13',
          '/usr/local/bin/python3.13',
          '/opt/homebrew/bin/python3',
          '/usr/local/bin/python3',
          '/usr/bin/python3',
          'python3',
        ]

  for (const c of candidates) {
    if (canRunPython(c)) return c
  }

  const { execSync } = require('child_process') as typeof import('child_process')

  // Windows: try via py launcher
  if (process.platform === 'win32') {
    try {
      execSync('py -3 -c "import fastapi, uvicorn, embit, httpx"', { stdio: 'ignore', timeout: 15000 })
      return 'py'
    } catch {
      /* ignore */
    }
  }

  throw new Error(
    'Python with coordinator dependencies not found. Run: cd coordinator && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
  )
}

export function bundledRuntimePaths(): { python?: string; node?: string; wasmDir?: string } {
  const base = bundledRuntimeDir()
  if (!base) return {}

  const python: string | undefined =
    process.platform === 'win32'
      ? [join(base, 'python', 'python.exe'), join(base, 'python', 'Scripts', 'python.exe')].find((p) =>
          existsSync(p),
        )
      : join(base, 'python', 'bin', 'python3')
  const node =
    process.platform === 'win32'
      ? join(base, 'node', 'node.exe')
      : join(base, 'node', 'bin', 'node')
  const wasmDir = join(base, 'kaspa_wasm')

  return {
    python: python && existsSync(python) ? python : undefined,
    node: existsSync(node) ? node : undefined,
    wasmDir: existsSync(join(wasmDir, 'sdk_v2', 'kaspa_bg.wasm')) ? wasmDir : undefined,
  }
}
