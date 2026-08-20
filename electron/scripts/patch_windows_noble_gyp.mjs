#!/usr/bin/env node
/**
 * Windows-only: patch noble WinRT binding.gyp so MSVC 14.51+ (VS2026) can compile.
 *
 * Error without this:
 *   STL1011 … define _SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS
 *
 * Safe / idempotent. No-op on macOS/Linux (those binding.gyp files are unused there).
 * Does not change Mac native sources or Electron app logic.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFINE = '_SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const TARGETS = [
  'node_modules/@abandonware/noble/lib/win/binding.gyp',
  'node_modules/@stoprocent/noble/lib/win/binding.gyp',
]

function patchFile(rel) {
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) {
    console.log(`[patch-noble] skip (missing): ${rel}`)
    return false
  }
  const before = fs.readFileSync(full, 'utf8')
  if (before.includes(DEFINE)) {
    console.log(`[patch-noble] already patched: ${rel}`)
    return false
  }

  let after = before
  if (after.includes("'_HAS_EXCEPTIONS=1'")) {
    after = after.replace("'_HAS_EXCEPTIONS=1'", `'_HAS_EXCEPTIONS=1', '${DEFINE}'`)
  } else if (after.includes('"_HAS_EXCEPTIONS=1"')) {
    after = after.replace('"_HAS_EXCEPTIONS=1"', `"_HAS_EXCEPTIONS=1", "${DEFINE}"`)
  } else {
    console.warn(`[patch-noble] could not find _HAS_EXCEPTIONS define in ${rel}`)
    return false
  }

  if (after === before) {
    console.warn(`[patch-noble] no change applied: ${rel}`)
    return false
  }
  fs.writeFileSync(full, after)
  console.log(`[patch-noble] patched: ${rel}`)
  return true
}

let n = 0
for (const rel of TARGETS) {
  if (patchFile(rel)) n += 1
}
console.log(`[patch-noble] done (${n} file(s) updated)`)
