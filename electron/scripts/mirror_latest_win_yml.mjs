#!/usr/bin/env node
/**
 * After a Windows package, electron-builder writes latest-win.yml (publish.channel).
 * Also mirror to latest.yml so older Windows clients (≤1.0.6) that still poll
 * latest.yml can update once to a latest-win-aware build.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const releaseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'release')
const winYml = path.join(releaseDir, 'latest-win.yml')
const legacyYml = path.join(releaseDir, 'latest.yml')

if (!fs.existsSync(winYml)) {
  console.warn(`[mirror-win-yml] missing ${winYml} — skip`)
  process.exit(0)
}

fs.copyFileSync(winYml, legacyYml)
console.log('[mirror-win-yml] latest-win.yml → latest.yml (compat for older Windows clients)')
