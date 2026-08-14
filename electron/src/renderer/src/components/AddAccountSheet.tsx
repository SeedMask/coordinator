import { useMemo, useState } from 'react'
import type { WalletDTO } from '@renderer/api/types'
import { walletCoin } from '@renderer/api/types'
import {
  ConnectHardwareWalletSheet,
  type HardwareImportPayload,
} from '@renderer/components/ConnectHardwareWalletSheet'
import { QRScannerSheet } from '@renderer/components/QRScannerSheet'
import { WalletPasswordModal } from '@renderer/components/WalletPasswordModal'
import { useApp } from '@renderer/state/AppProvider'
import { APIError } from '@renderer/api/client'
import { extractKeyForCoin, importKeyValidationError, parseExtendedKeyMetadata } from '@renderer/utils/extendedKey'
import { needsKaspaImportHistoryPrompt } from '@renderer/utils/networkSettings'
import {
  derivationForSiblingAccount,
  sanitizeFingerprint,
  unusedAccountIndices,
  walletAccountImportKind,
  walletIsMultisig,
  walletResolvedAccount,
  walletResolvedDerivation,
  walletResolvedFingerprint,
  walletsSharingAccountGroup,
  walletSupportsAddAccount,
  walletUsbHardwareBrand,
} from '@renderer/utils/walletHelpers'
import { scriptFromDerivation, type BitcoinScriptType } from '@renderer/utils/bitcoinWallet'
import { apiError } from '@renderer/utils/userErrors'

type Step = 'pick' | 'hardware'

/**
 * Sparrow-style Add Account: choose an unused account index, then import via the
 * same source as the original wallet (Ledger / OneKey / SeedMask / watch-only).
 */
export function AddAccountSheet({
  sourceWallet,
  onClose,
  onCreated,
}: {
  sourceWallet: WalletDTO
  onClose: () => void
  onCreated: (wallet: WalletDTO) => void
}): React.JSX.Element {
  const { api, wallets, loadWallets, activateWallet, discoverWallet, setStatusMessage, networkSettings, setKaspaImportHistoryPromptWalletId } =
    useApp()
  const chain = walletCoin(sourceWallet)
  const group = useMemo(() => walletsSharingAccountGroup(wallets, sourceWallet), [wallets, sourceWallet])
  const unused = useMemo(() => unusedAccountIndices(group), [group])
  const usedAccounts = useMemo(() => new Set(group.map((w) => walletResolvedAccount(w))), [group])
  const expectedFp = sanitizeFingerprint(walletResolvedFingerprint(sourceWallet))
  const supports = walletSupportsAddAccount(sourceWallet)
  const importKind = walletAccountImportKind(sourceWallet)
  const hwBrand = walletUsbHardwareBrand(sourceWallet)
  const usbHardwareOnly = importKind === 'ledger' || importKind === 'onekey'
  const seedMaskOnly = importKind === 'seedmask'
  const watchOnly = importKind === 'watch'
  const deviceImport = usbHardwareOnly || seedMaskOnly || watchOnly

  const [step, setStep] = useState<Step>('pick')
  const [accountIndex, setAccountIndex] = useState<number | null>(unused[0] ?? null)
  const [customIndexText, setCustomIndexText] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [encryptPromptOpen, setEncryptPromptOpen] = useState(false)
  const [encryptError, setEncryptError] = useState<string | null>(null)
  const [pendingCreate, setPendingCreate] = useState<{
    kpub: string
    label: string
    derivation: string
    fingerprint?: string
    scriptType?: string
    policyType?: string
    account: number
    hardware?: string
  } | null>(null)
  const [showScanner, setShowScanner] = useState(false)

  const derivation = accountIndex == null ? '' : derivationForSiblingAccount(sourceWallet, accountIndex)
  const btcScript: BitcoinScriptType =
    scriptFromDerivation(walletResolvedDerivation(sourceWallet)) ?? 'native_segwit'
  const multisig = walletIsMultisig(sourceWallet)
  const sourceLabel =
    importKind === 'onekey'
      ? 'OneKey'
      : importKind === 'ledger'
        ? 'Ledger'
        : importKind === 'seedmask'
          ? 'SeedMask'
          : null

  function defaultLabel(_index: number): string {
    return sourceWallet.label.replace(/\s*\(Account\s+\d+\)\s*$/i, '').trim() || 'Wallet'
  }

  function selectAccountIndex(index: number): void {
    setAccountIndex(index)
    setCustomIndexText(String(index))
    setLabel(defaultLabel(index))
    setError(null)
  }

  function applyCustomIndex(text: string): void {
    setCustomIndexText(text)
    const n = Number.parseInt(text.trim(), 10)
    if (!Number.isFinite(n) || n < 0 || usedAccounts.has(n)) {
      setAccountIndex(null)
      return
    }
    setError(null)
    setAccountIndex(n)
    setLabel(defaultLabel(n))
  }

  function goAfterPick(): void {
    setError(null)
    setShowScanner(false)
    setStep('hardware')
  }

  function backFromImport(): void {
    setShowScanner(false)
    setStep('pick')
  }

  async function createFromKey(opts: {
    kpub: string
    fingerprint: string
    derivation: string
    account: number
    hardware?: string
    label: string
    scriptType?: string
    policyType?: string
  }): Promise<void> {
    if (!api) throw new Error('API unavailable')
    const fp = sanitizeFingerprint(opts.fingerprint)
    if (expectedFp && fp && fp !== expectedFp) {
      throw new Error(
        `Fingerprint ${fp} does not match this wallet’s fingerprint ${expectedFp}. Use the same seed/device.`,
      )
    }
    const keyErr = importKeyValidationError(chain, opts.kpub)
    if (keyErr) throw new Error(keyErr)

    const hardware =
      opts.hardware ??
      (seedMaskOnly ? 'seedmask' : usbHardwareOnly ? sourceWallet.hardware || undefined : undefined)

    setPendingCreate({
      kpub: opts.kpub,
      label: opts.label,
      derivation: opts.derivation,
      fingerprint: fp || expectedFp || undefined,
      scriptType: opts.scriptType,
      policyType: opts.policyType,
      account: opts.account,
      hardware,
    })
    setEncryptError(null)
    setEncryptPromptOpen(true)
  }

  async function confirmCreateSibling(password: string, _newPassword?: string, hint?: string): Promise<void> {
    if (!api || !pendingCreate) return
    setEncryptError(null)
    setBusy(true)
    try {
      const opts = pendingCreate
      const passwordHint = password.trim() ? (hint || '').trim() || undefined : undefined
      const wallet = await api.createWallet({
        kpub: extractKeyForCoin(chain, opts.kpub),
        label: opts.label.trim() || defaultLabel(opts.account),
        scan_limit: sourceWallet.scan_limit ?? 30,
        coin: chain,
        derivation: opts.derivation,
        fingerprint: opts.fingerprint,
        script_type: opts.scriptType ?? sourceWallet.script_type ?? (chain === 'kaspa' ? (multisig ? 'p2sh' : 'p2pk') : btcScript),
        policy_type: opts.policyType ?? sourceWallet.policy_type ?? (multisig ? 'multisig' : 'singlesig'),
        multisig_m: multisig ? (sourceWallet.multisig_m ?? undefined) : undefined,
        multisig_n: multisig ? (sourceWallet.multisig_n ?? undefined) : undefined,
        account: opts.account,
        hardware: opts.hardware,
        activate: true,
        password: password.trim() || undefined,
        password_hint: passwordHint,
      })
      setEncryptPromptOpen(false)
      setPendingCreate(null)
      await loadWallets()
      await activateWallet(wallet.id, wallet)
      setStatusMessage(`Account ${opts.account} added`)
      if (chain === 'kaspa' && needsKaspaImportHistoryPrompt(networkSettings)) {
        setKaspaImportHistoryPromptWalletId(wallet.id)
        onCreated(wallet)
        return
      }
      void discoverWallet(wallet.id)
      onCreated(wallet)
    } catch (e) {
      setEncryptError(e instanceof Error ? e.message : 'Failed to add account')
    } finally {
      setBusy(false)
    }
  }

  async function importWatchPayload(raw: string): Promise<void> {
    if (accountIndex == null || (!seedMaskOnly && !watchOnly)) return
    setError(null)
    setBusy(true)
    try {
      let key = ''
      let fp = expectedFp
      let path = derivation
      let accountFromKey: number | null = null

      if (api) {
        try {
          const parsed = await api.parseKpub(raw, chain)
          if (parsed.kpub) {
            key = extractKeyForCoin(chain, parsed.kpub)
            fp = sanitizeFingerprint(parsed.fingerprint || expectedFp)
            if (parsed.derivation?.trim()) path = parsed.derivation.trim()
            if (parsed.account != null) accountFromKey = parsed.account
          }
        } catch {
          /* fall through to local parse */
        }
      }
      if (!key) {
        const meta = parseExtendedKeyMetadata(raw, chain)
        key = extractKeyForCoin(chain, raw)
        fp = sanitizeFingerprint(meta?.fingerprint || expectedFp)
        path = (meta?.account != null ? meta.derivation?.trim() : '') || derivation
        accountFromKey = meta?.account ?? null
      }

      if (accountFromKey != null && accountFromKey !== accountIndex) {
        throw new Error(
          `This key is account ${accountFromKey}, but you selected Account ${accountIndex}. Pick the matching index or key.`,
        )
      }
      await createFromKey({
        kpub: key,
        fingerprint: fp,
        derivation: path,
        account: accountIndex,
        hardware: seedMaskOnly ? 'seedmask' : undefined,
        label: label.trim() || defaultLabel(accountIndex),
      })
    } catch (e) {
      setError(e instanceof APIError ? apiError(e.status ?? 0, e.message) : e instanceof Error ? e.message : 'Import failed')
      setShowScanner(false)
    } finally {
      setBusy(false)
    }
  }

  async function onHardwareImported(payload: HardwareImportPayload): Promise<void> {
    if (accountIndex == null || !usbHardwareOnly) return
    setError(null)
    setBusy(true)
    try {
      if (hwBrand && payload.hardware !== hwBrand) {
        throw new Error(
          `This wallet was imported from ${sourceLabel}. Connect the same ${sourceLabel} device.`,
        )
      }
      if (payload.account !== accountIndex) {
        throw new Error(
          `Hardware returned account ${payload.account}, expected ${accountIndex}. Reconnect with the correct account index.`,
        )
      }
      await createFromKey({
        kpub: payload.kpub,
        fingerprint: payload.fingerprint,
        derivation: payload.derivation || derivation,
        account: accountIndex,
        hardware: payload.hardware,
        label: label.trim() || payload.label || defaultLabel(accountIndex),
        scriptType: payload.scriptType,
        policyType: payload.policyType,
      })
    } catch (e) {
      setError(e instanceof APIError ? apiError(e.status ?? 0, e.message) : e instanceof Error ? e.message : 'Import failed')
      backFromImport()
    } finally {
      setBusy(false)
    }
  }

  const leadExtra =
    importKind === 'ledger' || importKind === 'onekey'
      ? ` Connect the same ${sourceLabel} to export another BIP44 account.`
      : importKind === 'seedmask'
        ? ' Scan Export from the same SeedMask for another BIP44 account.'
        : ' Import the watch-only key for another BIP44 account.'

  if (!supports) {
    return (
      <div className="modal-backdrop" role="presentation" onClick={onClose}>
        <div className="modal-card add-account-sheet elevated-card" role="dialog" onClick={(e) => e.stopPropagation()}>
          <h3>Add Account</h3>
          <p className="muted">
            This wallet type does not support additional accounts (Sparrow disables Add Account for legacy P2SH
            multisig).
          </p>
          <div className="add-account-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (step === 'hardware' && accountIndex != null && deviceImport) {
    return (
      <>
        <ConnectHardwareWalletSheet
          chain={chain}
          multisig={multisig}
          scriptType={btcScript}
          initialAccount={accountIndex}
          restrictToBrand={usbHardwareOnly ? hwBrand ?? undefined : undefined}
          seedMaskOnly={seedMaskOnly}
          watchOnlyOnly={watchOnly}
          onClose={backFromImport}
          onHardwareImported={usbHardwareOnly ? (p) => void onHardwareImported(p) : undefined}
          onChooseSeedMask={seedMaskOnly ? () => setShowScanner(true) : undefined}
          onSeedMaskFile={seedMaskOnly ? (text) => void importWatchPayload(text) : undefined}
          onChooseWatchOnly={watchOnly ? () => setShowScanner(true) : undefined}
          onWatchOnlyFile={watchOnly ? (text) => void importWatchPayload(text) : undefined}
        />
        {showScanner && (seedMaskOnly || watchOnly) && (
          <QRScannerSheet
            title={
              seedMaskOnly
                ? chain === 'kaspa'
                  ? 'Scan Export kpub QR'
                  : 'Scan Export xpub QR'
                : chain === 'kaspa'
                  ? 'Scan kpub QR'
                  : 'Scan xpub QR'
            }
            hint={
              seedMaskOnly
                ? chain === 'kaspa'
                  ? `Account ${accountIndex} · ${derivation}. On SeedMask: Kaspa → Export kPub.`
                  : `Account ${accountIndex} · ${derivation}. On SeedMask: Bitcoin → Export xPub.`
                : `Account ${accountIndex} · ${derivation}. Scan the watch-only ${chain === 'kaspa' ? 'kpub' : 'xpub'} for this account.`
            }
            api={api}
            assembleAnimatedUr={seedMaskOnly}
            onCancel={() => setShowScanner(false)}
            onScan={(payload) => {
              setShowScanner(false)
              void importWatchPayload(payload)
            }}
          />
        )}
        {encryptPromptOpen && (
          <WalletPasswordModal
            mode="encrypt"
            walletLabel={pendingCreate?.label || label || undefined}
            busy={busy}
            error={encryptError}
            onCancel={() => {
              if (busy) return
              setEncryptPromptOpen(false)
              setPendingCreate(null)
              setEncryptError(null)
            }}
            onConfirm={(password, _newPassword, hint) => void confirmCreateSibling(password, undefined, hint)}
          />
        )}
        {error && (
          <div className="modal-backdrop" role="presentation" onClick={() => setError(null)}>
            <div className="modal-card elevated-card" role="dialog" onClick={(e) => e.stopPropagation()}>
              <h3>Import failed</h3>
              <p className="form-error">{error}</p>
              <div className="add-account-actions">
                <button type="button" className="btn btn-primary" onClick={() => setError(null)}>
                  OK
                </button>
              </div>
            </div>
          </div>
        )}
        {busy && !encryptPromptOpen && (
          <div className="modal-backdrop" role="status" aria-live="polite">
            <div className="modal-card elevated-card">
              <p>Importing Account {accountIndex}…</p>
            </div>
          </div>
        )}
      </>
    )
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-card add-account-sheet elevated-card" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Add Account</h3>
        <p className="muted add-account-lead">
          Same master fingerprint as Account {walletResolvedAccount(sourceWallet)}
          {expectedFp ? ` (${expectedFp})` : ''}.{leadExtra}
        </p>

        {step === 'pick' && (
          <>
            <label className="add-account-field-label">Account</label>
            {unused.length > 0 && (
              <div className="add-account-index-grid">
                {unused.map((i) => (
                  <button
                    key={i}
                    type="button"
                    className={`add-account-index-btn${accountIndex === i ? ' active' : ''}`}
                    onClick={() => selectAccountIndex(i)}
                  >
                    {i}
                  </button>
                ))}
              </div>
            )}
            <label className="add-account-field-label">Custom index</label>
            <input
              className="seed-mask-field add-account-custom-index"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="e.g. 12"
              value={customIndexText}
              onChange={(e) => applyCustomIndex(e.target.value)}
            />
            <p className="muted add-account-hint">BIP44 account index ≥ 0. Already imported indices cannot be reused.</p>
            {error && <p className="form-error">{error}</p>}
            {accountIndex != null && (
              <p className="add-account-derivation mono">
                Derivation <strong>{derivation}</strong>
              </p>
            )}
            <div className="add-account-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={accountIndex == null} onClick={goAfterPick}>
                Next
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
