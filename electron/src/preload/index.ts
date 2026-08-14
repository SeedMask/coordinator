import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

export interface SaveFileOptions {
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

export interface OpenFileOptions {
  filters?: { name: string; extensions: string[] }[]
  multi?: boolean
  title?: string
  message?: string
  defaultPath?: string
}

contextBridge.exposeInMainWorld('seedmask', {
  getBackendPort: (): Promise<number> => ipcRenderer.invoke('backend:get-port'),
  getBackendLogPath: (): Promise<string | null> => ipcRenderer.invoke('backend:get-log-path'),
  waitBackendReady: (): Promise<{
    ok: boolean
    error?: string
    logPath?: string | null
    translocated?: boolean
  }> => ipcRenderer.invoke('backend:wait-ready'),
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('shell:open-path', p),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  saveFile: (opts: SaveFileOptions): Promise<string | null> =>
    ipcRenderer.invoke('dialog:save-file', opts),
  openFile: (opts: OpenFileOptions): Promise<string | string[] | null> =>
    ipcRenderer.invoke('dialog:open-file', opts),
  pickPath: (opts: { title?: string; message?: string }): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pick-path', opts),
  readFile: (path: string): Promise<ArrayBuffer> => ipcRenderer.invoke('fs:read-file', path),
  writeFile: (path: string, data: ArrayBuffer): Promise<boolean> =>
    ipcRenderer.invoke('fs:write-file', path, data),
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:write-text', text),
  readText: (): Promise<string> => ipcRenderer.invoke('clipboard:read-text'),
  exportQrPacks: (
    text: string,
    preferredEncoding: 'ur' | 'plain' = 'ur',
  ): Promise<{
    ok: boolean
    static?: { frames: string[]; frameMs: number } | null
    animated?: { frames: string[]; frameMs: number }
    qr_static_available?: boolean
    error?: string
  }> => ipcRenderer.invoke('qr:export-packs', text, preferredEncoding),
  ensureBluetoothOn: (): Promise<{
    ok: boolean
    state: string
    error?: string
  }> => ipcRenderer.invoke('bluetooth:ensure-on'),
  cancelHardwareConnect: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('hardware:cancel'),
  listLedgerDevices: (opts?: {
    link?: 'usb' | 'ble'
  }): Promise<{
    ok: boolean
    devices: Array<{ path: string; product: string; vendorId: number; productId: number }>
    error?: string
  }> => ipcRenderer.invoke('ledger:list', opts),
  importLedgerKaspa: (opts?: {
    account?: number
    devicePath?: string
    link?: 'usb' | 'ble'
  }): Promise<{
    ok: boolean
    result?: {
      kpub: string
      fingerprint: string
      derivation: string
      account: number
      label: string
      hardware: 'ledger'
      deviceModel: string
      verifiedReceiveAddressHint: string
    }
    error?: string
  }> => ipcRenderer.invoke('ledger:import-kaspa', opts),
  onLedgerImportProgress: (
    cb: (progress: { status: string; message: string }) => void,
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, progress: { status: string; message: string }) => {
      cb(progress)
    }
    ipcRenderer.on('ledger:import-progress', handler)
    return () => ipcRenderer.removeListener('ledger:import-progress', handler)
  },
  signLedgerKaspa: (opts: {
    unsigned: unknown
    devicePath?: string
    link?: 'usb' | 'ble'
  }): Promise<{
    ok: boolean
    result?: {
      version: number
      network: string
      account: number
      draft_hash?: string
      signatures: Array<{ input_index: number; sig_hex: string }>
    }
    error?: string
  }> => ipcRenderer.invoke('ledger:sign-kaspa', opts),
  importLedgerBitcoin: (opts?: {
    account?: number
    scriptType?: 'native_segwit' | 'nested_segwit' | 'legacy' | 'taproot'
    policyType?: 'singlesig' | 'multisig'
    devicePath?: string
    link?: 'usb' | 'ble'
  }): Promise<{
    ok: boolean
    result?: {
      kpub: string
      fingerprint: string
      derivation: string
      account: number
      scriptType: 'native_segwit' | 'nested_segwit' | 'legacy' | 'taproot'
      policyType?: 'singlesig' | 'multisig'
      label: string
      hardware: 'ledger'
      deviceModel: string
      verifiedReceiveAddressHint: string
    }
    error?: string
  }> => ipcRenderer.invoke('ledger:import-bitcoin', opts),
  signLedgerBitcoin: (opts: {
    psbtBase64: string
    kpub?: string
    scriptType?: 'native_segwit' | 'nested_segwit' | 'legacy' | 'taproot'
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
  }): Promise<{
    ok: boolean
    result?: { format: 'bitcoin_psbt'; psbt_base64: string }
    error?: string
  }> => ipcRenderer.invoke('ledger:sign-bitcoin', opts),
  listOneKeyDevices: (opts?: {
    link?: 'usb' | 'ble'
  }): Promise<{
    ok: boolean
    devices: Array<{ path: string; product: string; vendorId: number; productId: number }>
    error?: string
  }> => ipcRenderer.invoke('onekey:list', opts),
  importOneKeyKaspa: (opts?: {
    account?: number
    accountMode?: 'onekey-app' | 'bip44'
    devicePath?: string
    link?: 'usb' | 'ble'
  }): Promise<{
    ok: boolean
    result?: {
      kpub: string
      fingerprint: string
      derivation: string
      account: number
      label: string
      hardware: 'onekey'
      deviceModel: string
      verifiedReceiveAddressHint: string
      accountMode: 'onekey-app' | 'bip44'
      verifiedReceiveIndex: number
    }
    error?: string
  }> => ipcRenderer.invoke('onekey:import-kaspa', opts),
  onOneKeyImportProgress: (
    cb: (progress: { status: string; message: string }) => void,
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, progress: { status: string; message: string }) => {
      cb(progress)
    }
    ipcRenderer.on('onekey:import-progress', handler)
    return () => ipcRenderer.removeListener('onekey:import-progress', handler)
  },
  onOneKeyPassphraseChoiceNeeded: (
    cb: (info?: { allowHiddenPin?: boolean }) => void,
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, info?: { allowHiddenPin?: boolean }) => {
      cb(info)
    }
    ipcRenderer.on('onekey:need-passphrase-choice', handler)
    return () => ipcRenderer.removeListener('onekey:need-passphrase-choice', handler)
  },
  chooseOneKeyPassphrase: (
    choice: 'standard' | 'temporary' | 'hidden-pin' | 'cancel',
  ): Promise<{ ok: boolean }> => ipcRenderer.invoke('onekey:passphrase-choice', choice),
  signOneKeyKaspa: (opts: {
    unsigned: unknown
    devicePath?: string
    link?: 'usb' | 'ble'
  }): Promise<{
    ok: boolean
    result?: {
      version: number
      network: string
      account: number
      draft_hash?: string
      signatures: Array<{ input_index: number; sig_hex: string }>
    }
    error?: string
  }> => ipcRenderer.invoke('onekey:sign-kaspa', opts),
  importOneKeyBitcoin: (opts?: {
    account?: number
    scriptType?: 'native_segwit' | 'nested_segwit' | 'legacy' | 'taproot'
    policyType?: 'singlesig' | 'multisig'
    devicePath?: string
    link?: 'usb' | 'ble'
  }): Promise<{
    ok: boolean
    result?: {
      kpub: string
      fingerprint: string
      derivation: string
      account: number
      scriptType: 'native_segwit' | 'nested_segwit' | 'legacy' | 'taproot'
      policyType?: 'singlesig' | 'multisig'
      label: string
      hardware: 'onekey'
      deviceModel: string
      verifiedReceiveAddressHint: string
    }
    error?: string
  }> => ipcRenderer.invoke('onekey:import-bitcoin', opts),
  signOneKeyBitcoin: (opts: {
    psbtBase64: string
    kpub?: string
    scriptType?: 'native_segwit' | 'nested_segwit' | 'legacy' | 'taproot'
    devicePath?: string
    link?: 'usb' | 'ble'
  }): Promise<{
    ok: boolean
    result?: { format: 'bitcoin_psbt'; psbt_base64: string }
    error?: string
  }> => ipcRenderer.invoke('onekey:sign-bitcoin', opts),
  getUpdaterStatus: (): Promise<{
    phase: string
    currentVersion: string
    availableVersion?: string
    percent?: number
    error?: string
    feed?: string
    packaged: boolean
    message?: string
    demo?: boolean
    releaseNotes?: string
    releaseUrl?: string
  }> => ipcRenderer.invoke('updater:get-status'),
  checkForUpdates: (): Promise<{
    phase: string
    currentVersion: string
    availableVersion?: string
    percent?: number
    error?: string
    feed?: string
    packaged: boolean
    message?: string
    demo?: boolean
    releaseNotes?: string
    releaseUrl?: string
  }> => ipcRenderer.invoke('updater:check'),
  downloadUpdate: (): Promise<{
    phase: string
    currentVersion: string
    availableVersion?: string
    percent?: number
    error?: string
    feed?: string
    packaged: boolean
    message?: string
    demo?: boolean
    releaseNotes?: string
    releaseUrl?: string
  }> => ipcRenderer.invoke('updater:download'),
  installUpdate: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('updater:install'),
  applyUpdate: (): Promise<{
    phase: string
    currentVersion: string
    availableVersion?: string
    percent?: number
    error?: string
    feed?: string
    packaged: boolean
    message?: string
    demo?: boolean
    releaseNotes?: string
    releaseUrl?: string
  }> => ipcRenderer.invoke('updater:apply'),
  dismissWhatsNew: (): Promise<{
    phase: string
    currentVersion: string
    availableVersion?: string
    percent?: number
    error?: string
    feed?: string
    packaged: boolean
    message?: string
    demo?: boolean
    releaseNotes?: string
    releaseUrl?: string
  }> => ipcRenderer.invoke('updater:dismiss-whats-new'),
  onUpdaterEvent: (
    cb: (status: {
      phase: string
      currentVersion: string
      availableVersion?: string
      percent?: number
      error?: string
      feed?: string
      packaged: boolean
      message?: string
      demo?: boolean
      releaseNotes?: string
      releaseUrl?: string
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      status: {
        phase: string
        currentVersion: string
        availableVersion?: string
        percent?: number
        error?: string
        feed?: string
        packaged: boolean
        message?: string
        demo?: boolean
        releaseNotes?: string
        releaseUrl?: string
      },
    ) => {
      cb(status)
    }
    ipcRenderer.on('updater:event', handler)
    return () => ipcRenderer.removeListener('updater:event', handler)
  },
})
