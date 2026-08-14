#!/usr/bin/env node
/**
 * Serve electron/release/ as a generic electron-updater feed (local only).
 *
 * Usage:
 *   1. Build a NEWER version into release/ (bump package.json, then package:mac)
 *      so latest-mac.yml + zip exist for that version.
 *   2. node scripts/serve-local-updates.mjs
 *   3. Launch an OLDER packaged .app with:
 *        SEEDMASK_UPDATE_URL=http://127.0.0.1:8787 open ".../SeedMask Coordinator.app"
 *
 * Does not touch GitHub.
 */
import { createServer } from 'http'
import { createReadStream, existsSync, statSync } from 'fs'
import { join, extname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '..', 'release')
const PORT = Number(process.env.SEEDMASK_UPDATE_PORT || 8787)

const MIME = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.dmg': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
  '.exe': 'application/octet-stream',
  '.AppImage': 'application/octet-stream',
}

if (!existsSync(ROOT)) {
  console.error(`Missing release folder: ${ROOT}`)
  console.error('Build first: npm run package:mac')
  process.exit(1)
}

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  const rel = urlPath === '/' ? '/index.html' : urlPath
  const filePath = join(ROOT, rel.replace(/^\//, ''))

  if (!filePath.startsWith(ROOT) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    // Helpful listing for /
    if (urlPath === '/' || urlPath === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(
        [
          'SeedMask local update feed',
          `Serving: ${ROOT}`,
          '',
          'Expected files (from electron-builder):',
          '  latest-mac.yml',
          '  SeedMask-Coordinator-*-mac-arm64.zip',
          '',
          `Point an older packaged app at: SEEDMASK_UPDATE_URL=http://127.0.0.1:${PORT}`,
        ].join('\n'),
      )
      return
    }
    res.writeHead(404).end('Not found')
    return
  }

  const type = MIME[extname(filePath)] || 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  createReadStream(filePath).pipe(res)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Local update feed: http://127.0.0.1:${PORT}`)
  console.log(`Serving: ${ROOT}`)
  console.log('')
  console.log('Launch older packaged app with:')
  console.log(`  SEEDMASK_UPDATE_URL=http://127.0.0.1:${PORT} open '/Applications/SeedMask Coordinator.app'`)
})
