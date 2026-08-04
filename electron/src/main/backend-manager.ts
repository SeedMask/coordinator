import { spawn, type ChildProcess } from 'child_process'
import { existsSync, unlinkSync, createWriteStream, readFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import {
  findCoordinatorRoot,
  resolvePython,
  bundledRuntimePaths,
  backendStderrLogPath,
  writableLogsDir,
  clearMacQuarantine,
  isTranslocatedMacApp,
  isPackagedApp,
} from './paths'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class BackendManager {
  readonly port: number
  logPath: string | null = null
  private process: ChildProcess | null = null
  private lastStartError: string | null = null

  constructor(port: number) {
    this.port = port
  }

  getLastStartError(): string | null {
    return this.lastStartError
  }

  isRunning(): boolean {
    return this.process != null && this.process.exitCode == null
  }

  async start(): Promise<void> {
    if (this.isRunning()) return
    this.process = null
    this.lastStartError = null

    if (isTranslocatedMacApp()) {
      throw new Error(
        'Move SeedMask Coordinator to your Applications folder before opening it. Do not run the app directly from the disk image (.dmg).',
      )
    }

    clearMacQuarantine()
    this.terminateProcessOnPort(this.port)

    const root = findCoordinatorRoot()
    const script = join(root, 'run_backend.py')
    if (!existsSync(script)) {
      throw new Error(`Missing run_backend.py at ${script}`)
    }

    const python = resolvePython(root)
    const pythonArgs = python === 'py' ? ['-3', script] : [script]
    const pythonBin = python === 'py' ? 'py' : python
    this.logPath = backendStderrLogPath()
    try {
      unlinkSync(this.logPath)
    } catch {
      /* ok */
    }
    const logStream = createWriteStream(this.logPath, { flags: 'a' })

    const runtime = bundledRuntimePaths()
    const toolPaths = [join(root, 'tools')]
    // Dev-only sibling probe — packaged apps must not touch ../tools (Desktop TCC).
    if (!isPackagedApp()) {
      const siblingTools = join(root, '..', 'tools')
      if (existsSync(siblingTools)) toolPaths.push(siblingTools)
    }
    const workDir = writableLogsDir()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SEEDPASS_COORDINATOR_PORT: String(this.port),
      SEEDPASS_COORDINATOR_ROOT: root,
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPYCACHEPREFIX: join(workDir, 'pycache'),
      PYTHONPATH: [...toolPaths, process.env.PYTHONPATH].filter(Boolean).join(
        process.platform === 'win32' ? ';' : ':',
      ),
    }
    if (runtime.node) env.SEEDMASK_NODE = runtime.node
    if (runtime.wasmDir) env.SEEDMASK_WASM_DIR = runtime.wasmDir

    const proc = spawn(pythonBin, pythonArgs, {
      cwd: workDir,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    this.process = proc

    proc.stderr?.pipe(logStream)
    proc.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.warn(`Backend exited code=${code} signal=${signal}`)
        this.lastStartError = this.formatStartupFailure(`Backend exited (code ${code})`)
      }
      this.process = null
    })

    proc.on('error', (err) => {
      console.error('Backend spawn error:', err)
      this.lastStartError = this.formatStartupFailure(err.message)
      this.process = null
    })

    await this.waitUntilHealthy()
  }

  private async waitUntilHealthy(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.ping()) return
      if (!this.process) {
        throw new Error(this.formatStartupFailure('Backend process stopped during startup'))
      }
      if (this.process.exitCode != null) {
        throw new Error(this.formatStartupFailure(`Backend exited (code ${this.process.exitCode})`))
      }
      await sleep(300)
    }
    throw new Error(
      this.formatStartupFailure(
        'Backend did not respond in time. If you downloaded the app, move it to Applications and open it from there (not from the .dmg).',
      ),
    )
  }

  private async ping(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/api/status`, {
        signal: AbortSignal.timeout(4_000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  private formatStartupFailure(reason: string): string {
    let tail = ''
    try {
      if (this.logPath && existsSync(this.logPath)) {
        const content = readFileSync(this.logPath, 'utf8').trim()
        if (content) {
          tail = content.split('\n').slice(-10).join('\n')
        }
      }
    } catch {
      /* ignore */
    }
    this.lastStartError = tail ? `${reason}\n\n${tail}` : reason
    return this.lastStartError
  }

  stop(): void {
    if (!this.process) return
    this.process.kill('SIGTERM')
    setTimeout(() => this.process?.kill('SIGKILL'), 3000)
    this.process = null
  }

  private terminateProcessOnPort(port: number): void {
    try {
      if (process.platform === 'win32') {
        const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' })
        const pids = new Set<string>()
        for (const line of out.split('\n')) {
          const parts = line.trim().split(/\s+/)
          const pid = parts[parts.length - 1]
          if (pid && /^\d+$/.test(pid)) pids.add(pid)
        }
        Array.from(pids).forEach((pid) => {
          try {
            execSync(`taskkill /PID ${pid} /F`)
          } catch {
            /* ignore */
          }
        })
      } else {
        execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null || true`, { shell: '/bin/bash' })
      }
    } catch {
      /* port free */
    }
  }
}
