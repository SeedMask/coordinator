import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

/** file:// loads fail when Vite emits crossorigin on module scripts. */
function stripCrossoriginForElectron(): Plugin {
  return {
    name: 'strip-crossorigin-for-electron',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(="[^"]*")?/g, '')
    },
  }
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        // Keep Ledger native stacks out of the bundle — bundling node-hid breaks USB discovery.
        include: [
          '@ledgerhq/hw-transport-node-hid',
          '@ledgerhq/hw-transport-node-hid-noevents',
          '@ledgerhq/hw-transport-node-ble',
          '@ledgerhq/devices',
          '@ledgerhq/errors',
          '@ledgerhq/hw-transport',
          '@ledgerhq/logs',
          '@onekeyfe/hd-common-connect-sdk',
          '@onekeyfe/hd-core',
          '@onekeyfe/hd-shared',
          '@onekeyfe/hd-transport',
          '@onekeyfe/hd-transport-usb',
          '@onekeyfe/hd-transport-http',
          '@onekeyfe/hd-transport-lowlevel',
          '@onekeyfe/hd-transport-emulator',
          '@onekeyfe/hd-transport-web-device',
          '@noble/hashes',
          'node-hid',
          'usb',
        ],
      }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react(), stripCrossoriginForElectron()],
    build: {
      modulePreload: false,
    },
  },
})
