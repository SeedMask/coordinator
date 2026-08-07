import { useEffect, useId, useRef, useState } from 'react'
import { CalloutIcon, EyeSlashIcon } from '@renderer/components/icons'
import { InfoTipButton } from '@renderer/components/settings/SettingsChrome'

type Mode = 'encrypt' | 'unlock' | 'change'

const HINT_MAX = 80
const HINT_INFO =
  'A reminder only you will understand. Optional, and stored in plaintext on this Mac — don’t put the password itself in the hint.'

function PasswordInput({
  inputRef,
  value,
  onChange,
  onEnter,
  disabled,
  autoComplete,
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>
  value: string
  onChange: (value: string) => void
  onEnter: () => void
  disabled?: boolean
  autoComplete: string
}): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  return (
    <div className="field-with-trailing wallet-password-input-row">
      <input
        ref={inputRef}
        className="seed-mask-field"
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter()
        }}
      />
      <button
        type="button"
        className="wallet-password-visibility-btn"
        disabled={disabled}
        aria-label={visible ? 'Hide password' : 'Show password'}
        title={visible ? 'Hide password' : 'Show password'}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? <EyeSlashIcon size={16} /> : <CalloutIcon name="eye" size={16} />}
      </button>
    </div>
  )
}

interface Props {
  mode: Mode
  walletLabel?: string
  busy?: boolean
  error?: string | null
  /** When set, modal shows a brief success state instead of the form. */
  successMessage?: string | null
  /** encrypt mode for an existing unencrypted wallet (strip menu). */
  encryptExisting?: boolean
  /** Stored hint shown on unlock; prefilled when changing password. */
  passwordHint?: string | null
  onCancel: () => void
  /** encrypt/unlock: password (+ optional hint). change: current, new, hint. */
  onConfirm: (password: string, newPassword?: string, hint?: string) => void | Promise<void>
}

export function WalletPasswordModal({
  mode,
  walletLabel,
  busy = false,
  error = null,
  successMessage = null,
  encryptExisting = false,
  passwordHint = null,
  onCancel,
  onConfirm,
}: Props) {
  const titleId = useId()
  const passwordRef = useRef<HTMLInputElement>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [hint, setHint] = useState(() => (passwordHint || '').trim())
  const [localError, setLocalError] = useState<string | null>(null)
  const succeeded = Boolean(successMessage)
  const encryptExistingFlow = mode === 'encrypt' && encryptExisting
  const showHintField = mode === 'encrypt' || mode === 'change'
  const storedHint = (passwordHint || '').trim()

  useEffect(() => {
    if (!succeeded) passwordRef.current?.focus()
  }, [succeeded])

  async function submit(): Promise<void> {
    if (succeeded) return
    setLocalError(null)
    const nextHint = hint.trim().slice(0, HINT_MAX)
    if (mode === 'encrypt') {
      if (encryptExisting && !password.trim()) {
        setLocalError('Enter a password')
        return
      }
      if (password !== confirm) {
        setLocalError('Passwords do not match')
        return
      }
      await onConfirm(password, undefined, password.trim() ? nextHint : '')
      return
    }
    if (mode === 'change') {
      if (!password.trim()) {
        setLocalError('Enter the current password')
        return
      }
      if (newPassword !== confirm) {
        setLocalError('New passwords do not match')
        return
      }
      await onConfirm(password, newPassword, newPassword.trim() ? nextHint : '')
      return
    }
    if (!password.trim()) {
      setLocalError('Enter the wallet password')
      return
    }
    await onConfirm(password)
  }

  const title = encryptExistingFlow
    ? 'Encrypt this wallet'
    : mode === 'encrypt'
      ? 'Encrypt wallet on this Mac?'
      : mode === 'change'
        ? 'Change password'
        : 'Unlock wallet'
  const primary = encryptExistingFlow
    ? 'Encrypt'
    : mode === 'encrypt'
      ? 'Save wallet'
      : mode === 'change'
        ? 'Save password'
        : 'Unlock'
  const wideCard = mode === 'change' || encryptExistingFlow

  function renderWarnings(): React.JSX.Element | null {
    if (encryptExistingFlow) {
      return (
        <div className="wallet-password-warning" role="note">
          <strong>Before you encrypt</strong>
          <ul>
            <li>Watch-only secrets on this Mac will be protected by your password.</li>
            <li>
              If you forget the password, SeedMask cannot recover this wallet. You would need to import your
              xpub or descriptor again.
            </li>
            <li>A hint is optional and stored in plaintext next to the encrypted wallet.</li>
            <li>Keep a backup of your wallet details somewhere safe before continuing.</li>
          </ul>
        </div>
      )
    }
    if (mode === 'change') {
      return (
        <div className="wallet-password-warning" role="note">
          <strong>Important</strong>
          <ul>
            <li>Leave the new password blank to store this wallet unencrypted on disk.</li>
            <li>If you change the password, remember it. SeedMask cannot reset or recover it for you.</li>
            <li>Hints are stored in plaintext — don’t put the password itself in the hint.</li>
          </ul>
        </div>
      )
    }
    if (mode === 'encrypt') {
      return (
        <div className="wallet-password-warning wallet-password-warning-info" role="note">
          <strong>Optional encryption</strong>
          <ul>
            <li>Leave blank to store this watch-only wallet unencrypted on disk.</li>
            <li>If you set a password, remember it. SeedMask cannot recover a forgotten password.</li>
            <li>A hint is optional and stored in plaintext on this Mac.</li>
          </ul>
        </div>
      )
    }
    return null
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={busy || succeeded ? undefined : onCancel}
    >
      <div
        className={`modal-card elevated-card${wideCard ? ' wallet-password-modal-change' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        {succeeded ? (
          <>
            <h3 id={titleId}>{title}</h3>
            {walletLabel ? (
              <p className="muted" style={{ marginTop: 6 }}>
                {walletLabel}
              </p>
            ) : null}
            <p
              className="form-success"
              style={{ marginTop: 18, lineHeight: 1.45 }}
              role="status"
              aria-live="polite"
            >
              {successMessage}
            </p>
          </>
        ) : (
          <>
            <h3 id={titleId}>{title}</h3>
            {walletLabel ? (
              <p className="muted" style={{ marginTop: 6 }}>
                {walletLabel}
              </p>
            ) : null}
            {encryptExistingFlow ? (
              <p className="muted" style={{ marginTop: 8, lineHeight: 1.45 }}>
                Choose a password to encrypt this watch-only wallet on disk.
              </p>
            ) : mode === 'encrypt' ? null : mode === 'change' ? (
              <p className="muted" style={{ marginTop: 8, lineHeight: 1.45 }}>
                Enter your current password, then choose a new one.
              </p>
            ) : (
              <p className="muted" style={{ marginTop: 8, lineHeight: 1.45 }}>
                This wallet is encrypted on disk. Enter the password to use it in this session.
              </p>
            )}
            {renderWarnings()}
            <label className="field" style={{ display: 'block', marginTop: 14 }}>
              <span className="field-label">{mode === 'change' ? 'Current password' : 'Password'}</span>
              <PasswordInput
                inputRef={passwordRef}
                value={password}
                onChange={setPassword}
                onEnter={() => void submit()}
                disabled={busy}
                autoComplete={mode === 'unlock' ? 'current-password' : 'new-password'}
              />
            </label>
            {mode === 'unlock' && storedHint ? (
              <div className="wallet-password-hint-wrap">
                <span className="wallet-password-hint-display" role="note">
                  Hint: {storedHint}
                </span>
              </div>
            ) : null}
            {mode === 'change' ? (
              <label className="field" style={{ display: 'block', marginTop: 10 }}>
                <span className="field-label">New password</span>
                <PasswordInput
                  value={newPassword}
                  onChange={setNewPassword}
                  onEnter={() => void submit()}
                  disabled={busy}
                  autoComplete="new-password"
                />
              </label>
            ) : null}
            {(mode === 'encrypt' || mode === 'change') && (
              <label className="field" style={{ display: 'block', marginTop: 10 }}>
                <span className="field-label">
                  {mode === 'change' ? 'Confirm new password' : 'Confirm password'}
                </span>
                <PasswordInput
                  value={confirm}
                  onChange={setConfirm}
                  onEnter={() => void submit()}
                  disabled={busy}
                  autoComplete="new-password"
                />
              </label>
            )}
            {showHintField ? (
              <label className="field" style={{ display: 'block', marginTop: 10 }}>
                <span className="wallet-password-hint-label">
                  <span className="field-label">Hint (optional)</span>
                  <InfoTipButton text={HINT_INFO} />
                </span>
                <input
                  className="seed-mask-field"
                  type="text"
                  autoComplete="off"
                  maxLength={HINT_MAX}
                  value={hint}
                  disabled={busy}
                  onChange={(e) => setHint(e.target.value.slice(0, HINT_MAX))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submit()
                  }}
                />
              </label>
            ) : null}
            {(localError || error) && (
              <p className="form-error" style={{ marginTop: 10 }} role="alert">
                {localError || error}
              </p>
            )}
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" disabled={busy} onClick={onCancel}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
                {busy ? 'Working…' : primary}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
