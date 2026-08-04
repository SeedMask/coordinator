export {}

declare global {
  interface Window {
    seedmask: {
      getBackendPort: () => Promise<number>
      getBackendLogPath: () => Promise<string | null>
      waitBackendReady: () => Promise<{
        ok: boolean
        error?: string
        logPath?: string | null
        translocated?: boolean
      }>
      openPath: (path: string) => Promise<string>
      openExternal: (url: string) => Promise<void>
      saveFile: (opts: {
        defaultPath?: string
        filters?: { name: string; extensions: string[] }[]
      }) => Promise<string | null>
      openFile: (opts: {
        filters?: { name: string; extensions: string[] }[]
        multi?: boolean
      }) => Promise<string | string[] | null>
      pickPath: (opts: { title?: string; message?: string }) => Promise<string | null>
      readFile: (path: string) => Promise<ArrayBuffer>
      writeFile: (path: string, data: ArrayBuffer) => Promise<boolean>
      copyText: (text: string) => Promise<boolean>
      readText: () => Promise<string>
      exportQrPacks: (
        text: string,
        preferredEncoding?: 'ur' | 'plain',
      ) => Promise<{
        ok: boolean
        static?: { frames: string[]; frameMs: number } | null
        animated?: { frames: string[]; frameMs: number }
        qr_static_available?: boolean
        error?: string
      }>
      ensureBluetoothOn: () => Promise<{
        ok: boolean
        state: string
        error?: string
      }>
      cancelHardwareConnect: () => Promise<{ ok: boolean; error?: string }>
      listLedgerDevices: (opts?: {
        link?: 'usb' | 'ble'
      }) => Promise<{
        ok: boolean
        devices: Array<{ path: string; product: string; vendorId: number; productId: number }>
        error?: string
      }>
      importLedgerKaspa: (opts?: {
        account?: number
        devicePath?: string
        link?: 'usb' | 'ble'
      }) => Promise<{
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
      }>
      onLedgerImportProgress: (
        cb: (progress: { status: string; message: string }) => void,
      ) => () => void
      signLedgerKaspa: (opts: {
        unsigned: unknown
        devicePath?: string
        link?: 'usb' | 'ble'
      }) => Promise<{
        ok: boolean
        result?: {
          version: number
          network: string
          account: number
          draft_hash?: string
          signatures: Array<{ input_index: number; sig_hex: string }>
        }
        error?: string
      }>
      importLedgerBitcoin: (opts?: {
        account?: number
        scriptType?: 'native_segwit' | 'nested_segwit' | 'legacy' | 'taproot'
        policyType?: 'singlesig' | 'multisig'
        devicePath?: string
        link?: 'usb' | 'ble'
      }) => Promise<{
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
      }>
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
      }) => Promise<{
        ok: boolean
        result?: { format: 'bitcoin_psbt'; psbt_base64: string }
        error?: string
      }>
      listOneKeyDevices: (opts?: {
        link?: 'usb' | 'ble'
      }) => Promise<{
        ok: boolean
        devices: Array<{ path: string; product: string; vendorId: number; productId: number }>
        error?: string
      }>
      importOneKeyKaspa: (opts?: {
        account?: number
        accountMode?: 'onekey-app' | 'bip44'
        devicePath?: string
        link?: 'usb' | 'ble'
      }) => Promise<{
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
      }>
      onOneKeyImportProgress: (
        cb: (progress: { status: string; message: string }) => void,
      ) => () => void
      onOneKeyPassphraseChoiceNeeded: (
        cb: (info?: { allowHiddenPin?: boolean }) => void,
      ) => () => void
      chooseOneKeyPassphrase: (
        choice: 'standard' | 'temporary' | 'hidden-pin' | 'cancel',
      ) => Promise<{ ok: boolean }>
      signOneKeyKaspa: (opts: {
        unsigned: unknown
        devicePath?: string
        link?: 'usb' | 'ble'
      }) => Promise<{
        ok: boolean
        result?: {
          version: number
          network: string
          account: number
          draft_hash?: string
          signatures: Array<{ input_index: number; sig_hex: string }>
        }
        error?: string
      }>
      importOneKeyBitcoin: (opts?: {
        account?: number
        scriptType?: 'native_segwit' | 'nested_segwit' | 'legacy' | 'taproot'
        policyType?: 'singlesig' | 'multisig'
        devicePath?: string
        link?: 'usb' | 'ble'
      }) => Promise<{
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
      }>
      signOneKeyBitcoin: (opts: {
        psbtBase64: string
        kpub?: string
        scriptType?: 'native_segwit' | 'nested_segwit' | 'legacy' | 'taproot'
        devicePath?: string
        link?: 'usb' | 'ble'
      }) => Promise<{
        ok: boolean
        result?: { format: 'bitcoin_psbt'; psbt_base64: string }
        error?: string
      }>
    }
  }
}
