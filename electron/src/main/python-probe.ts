import { execSync } from 'child_process'

const DEPS_CHECK = 'import fastapi, uvicorn, embit, httpx'

export function canRunPython(pythonPath: string): boolean {
  try {
    if (pythonPath === 'py') {
      execSync('py -3 -c "import fastapi, uvicorn, embit, httpx"', { stdio: 'ignore', timeout: 15_000 })
      return true
    }
    execSync(`"${pythonPath}" -c "${DEPS_CHECK}"`, { stdio: 'ignore', timeout: 15_000 })
    return true
  } catch {
    return false
  }
}
