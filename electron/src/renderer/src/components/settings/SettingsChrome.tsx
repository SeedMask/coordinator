import type { ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppTheme, ConnectionTestResponse } from '@renderer/api/types'
import type { NetworkSettingsSavePhase } from '@renderer/hooks/useNetworkSettingsEditor'
import { ChainLogoMark, ThemeIcon } from '@renderer/components/BrandMarks'
import { CalloutIcon, CheckmarkIcon, ConnectionModeIcon, InfoTipIcon, LoadingSpinner } from '@renderer/components/icons'
import { pickPathWithDialog } from '@renderer/utils/nativeFiles'
import { saveErrorForChain, type CoinChainFilter } from '@renderer/utils/networkSettings'

export function SettingsPageLayout({
  title,
  subtitle,
  backTitle,
  onBack,
  children,
}: {
  title: string
  subtitle?: string
  backTitle?: string
  onBack?: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="settings-page">
      <div className="settings-page-header">
        {onBack && backTitle && (
          <button type="button" className="settings-back-btn" onClick={onBack}>
            ← {backTitle}
          </button>
        )}
        <h2 className="settings-page-title">{title}</h2>
        {subtitle && <p className="muted settings-page-subtitle">{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}

export function SettingsSectionBlock({
  title,
  subtitle,
  children,
  trailing,
  titleBadge,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  trailing?: ReactNode
  titleBadge?: ReactNode
}): React.JSX.Element {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div>
          <h3 className={titleBadge ? 'settings-section-title-row' : undefined}>
            {title}
            {titleBadge}
          </h3>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        {trailing}
      </div>
      {children}
    </section>
  )
}

export function SettingsFriendlyCallout({
  text,
  icon = 'info',
}: {
  text: string
  icon?: 'eye' | 'info' | 'warning' | 'shield'
}): React.JSX.Element {
  return (
    <div className={`settings-callout${icon === 'shield' ? ' security' : ''}`}>
      <CalloutIcon name={icon} size={18} className="settings-callout-icon" />
      <span>{text}</span>
    </div>
  )
}

function SettingsFieldLabel({ label, infoTip }: { label: string; infoTip?: string }): React.JSX.Element {
  return (
    <span className="settings-field-label-row">
      <span className="field-label">{label}</span>
      {infoTip && <InfoTipButton text={infoTip} />}
    </span>
  )
}

export function InfoTipButton({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const [coords, setCoords] = useState<{ top: number; left: number; placeAbove: boolean } | null>(null)

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) {
      setCoords(null)
      return
    }
    const update = () => {
      if (!wrapRef.current) return
      const rect = wrapRef.current.getBoundingClientRect()
      const maxWidth = 280
      const pad = 10
      let left = rect.left + rect.width / 2
      left = Math.min(Math.max(left, maxWidth / 2 + pad), window.innerWidth - maxWidth / 2 - pad)
      const placeAbove = rect.bottom + 140 > window.innerHeight && rect.top > 140
      setCoords({
        top: placeAbove ? rect.top - 8 : rect.bottom + 8,
        left,
        placeAbove,
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, text])

  return (
    <span className="info-tip-wrap" ref={wrapRef}>
      <button
        type="button"
        className="info-tip-btn"
        aria-label="More information"
        title={text}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
      >
        i
      </button>
      {open &&
        coords &&
        createPortal(
          <span
            className={`info-tip-popover info-tip-popover-fixed${coords.placeAbove ? ' above' : ''}`}
            style={{ top: coords.top, left: coords.left }}
            role="tooltip"
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  )
}

export function SettingsChoiceOption({
  title,
  subtitle,
  selected,
  badge,
  onClick,
}: {
  title: string
  subtitle: string
  selected: boolean
  badge?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button" className={`settings-choice${selected ? ' selected' : ''}`} onClick={onClick}>
      <span className="settings-choice-radio">{selected ? '●' : '○'}</span>
      <span className="settings-choice-body">
        <span className="settings-choice-title">
          {title}
          {badge && <span className="settings-badge">{badge}</span>}
        </span>
        <span className="settings-choice-subtitle">{subtitle}</span>
      </span>
    </button>
  )
}

export function SettingsConnectionModeTile({
  label,
  subtitle,
  icon,
  selected,
  onClick,
}: {
  label: string
  subtitle: string
  icon: 'globe' | 'desktop' | 'lock-shield'
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button" className={`settings-mode-tile${selected ? ' selected' : ''}`} onClick={onClick}>
      <ConnectionModeIcon mode={icon} size={24} className="settings-mode-icon" />
      <strong>{label}</strong>
      <span className="muted">{subtitle}</span>
    </button>
  )
}

export function SettingsField({
  label,
  hint,
  infoTip,
  value,
  onChange,
  placeholder,
  multiline,
  password,
}: {
  label: string
  hint?: string
  infoTip?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  multiline?: boolean
  password?: boolean
}): React.JSX.Element {
  return (
    <label className="settings-field">
      <SettingsFieldLabel label={label} infoTip={infoTip} />
      {multiline ? (
        <textarea
          className="field-input"
          rows={4}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="field-input"
          type={password ? 'password' : 'text'}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {hint && <span className="settings-field-hint">{hint}</span>}
    </label>
  )
}

const KASPA_LOCAL_NODE_HOST = '127.0.0.1:17110'
const KASPA_LOCAL_NODE_SUGGESTION = `ws://${KASPA_LOCAL_NODE_HOST}`

export function SettingsKaspaWsUrlField({
  label,
  hint,
  infoTip,
  value,
  onChange,
}: {
  label: string
  hint?: string
  infoTip?: string
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const scheme = /^wss:\/\//i.test(value) ? 'wss://' : 'ws://'
  const rest = value.replace(/^wss?:\/\//i, '')

  function setScheme(nextScheme: 'ws://' | 'wss://'): void {
    onChange(`${nextScheme}${rest}`)
  }

  function setRest(nextRest: string): void {
    const cleaned = nextRest.replace(/^wss?:\/\//i, '')
    onChange(`${scheme}${cleaned}`)
  }

  return (
    <div className="settings-field">
      <SettingsFieldLabel label={label} infoTip={infoTip} />
      <div className="settings-ws-url-row">
        <label className="settings-ws-scheme-wrap">
          <span className="sr-only">WebSocket scheme</span>
          <select
            className="settings-ws-scheme-select"
            value={scheme}
            onChange={(e) => setScheme(e.target.value === 'wss://' ? 'wss://' : 'ws://')}
          >
            <option value="ws://">ws://</option>
            <option value="wss://">wss://</option>
          </select>
          <svg className="settings-ws-scheme-caret" viewBox="0 0 12 8" width="12" height="8" aria-hidden>
            <path
              d="M1.2 1.6 L6 6.4 L10.8 1.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </label>
        <input
          className="field-input settings-ws-url-input"
          type="text"
          value={rest}
          placeholder="127.0.0.1:17110"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setRest(e.target.value)}
        />
      </div>
      <div className="settings-ws-url-actions">
        <button
          type="button"
          className="settings-link-btn"
          disabled={value.trim() === KASPA_LOCAL_NODE_SUGGESTION}
          onClick={() => onChange(KASPA_LOCAL_NODE_SUGGESTION)}
        >
          Use local node ({KASPA_LOCAL_NODE_HOST})
        </button>
      </div>
      {hint && <span className="settings-field-hint">{hint}</span>}
    </div>
  )
}

export function SettingsPathBrowseField({
  label,
  hint,
  infoTip,
  value,
  onChange,
  placeholder,
  panelMessage,
}: {
  label: string
  hint?: string
  infoTip?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  panelMessage?: string
}): React.JSX.Element {
  return (
    <label className="settings-field">
      <SettingsFieldLabel label={label} infoTip={infoTip} />
      <div className="settings-path-browse-row">
        <input
          className="field-input"
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-secondary settings-path-browse-btn"
          title="Choose folder or file…"
          onClick={() => {
            void (async () => {
              const picked = await pickPathWithDialog({
                title: label,
                message: panelMessage ?? 'Choose a folder or file.',
              })
              if (picked) onChange(picked)
            })()
          }}
        >
          Choose…
        </button>
      </div>
      {hint && <span className="settings-field-hint">{hint}</span>}
    </label>
  )
}

export function SettingsHostPortField({
  label,
  hint,
  infoTip,
  host,
  port,
  onHostChange,
  onPortChange,
  hostPlaceholder,
  portPlaceholder,
}: {
  label: string
  hint?: string
  infoTip?: string
  host: string
  port: number
  onHostChange: (v: string) => void
  onPortChange: (v: number) => void
  hostPlaceholder?: string
  portPlaceholder?: string
}): React.JSX.Element {
  return (
    <label className="settings-field">
      <SettingsFieldLabel label={label} infoTip={infoTip} />
      <div className="settings-host-port">
        <input
          className="field-input"
          value={host}
          placeholder={hostPlaceholder}
          onChange={(e) => onHostChange(e.target.value)}
        />
        <input
          className="field-input settings-port-input"
          value={port > 0 ? String(port) : ''}
          placeholder={portPlaceholder}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '')
            if (!digits) {
              onPortChange(0)
              return
            }
            const parsed = Number(digits)
            if (parsed > 0 && parsed <= 65535) onPortChange(parsed)
          }}
        />
      </div>
      {hint && <span className="settings-field-hint">{hint}</span>}
    </label>
  )
}

export function SettingsToggleRow({
  label,
  infoTip,
  checked,
  onChange,
  className,
}: {
  label: string
  infoTip?: string
  checked: boolean
  onChange: (checked: boolean) => void
  className?: string
}): React.JSX.Element {
  return (
    <label className={className ? `settings-toggle-row ${className}` : 'settings-toggle-row'}>
      <span className="settings-toggle-label">
        <span>{label}</span>
        {infoTip && <InfoTipButton text={infoTip} />}
      </span>
      <input
        type="checkbox"
        className="settings-switch"
        role="switch"
        aria-checked={checked}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  )
}

export function SettingsChainHubCard({
  chain,
  serverLabel,
  serverDetail,
  onOpen,
}: {
  chain: 'bitcoin' | 'kaspa'
  serverLabel: string
  serverDetail: string
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button type="button" className={`settings-chain-card settings-chain-card-${chain}`} onClick={onOpen}>
      <div className="settings-chain-card-head">
        <ChainLogoMark chain={chain} size={44} selected />
        <div>
          <strong>{chain === 'bitcoin' ? 'Bitcoin' : 'Kaspa'}</strong>
          <span className="muted">How this app talks to the network</span>
        </div>
      </div>
      <div className="settings-chain-card-body">
        <span className="muted">Currently using</span>
        <strong>{serverLabel}</strong>
        <span className="muted">{serverDetail}</span>
      </div>
      <span className="settings-chain-card-action">Open settings →</span>
    </button>
  )
}

export function SettingsSaveStatus({
  savePhase,
  saveError,
  chain,
}: {
  savePhase: NetworkSettingsSavePhase
  saveError: string | null
  chain?: CoinChainFilter
}): React.JSX.Element {
  const filteredError = chain ? saveErrorForChain(saveError, chain) : saveError
  let effectivePhase = savePhase
  if (savePhase === 'failed' && chain && !filteredError) {
    effectivePhase = 'idle'
  }

  let text = 'Changes save automatically'
  if (effectivePhase === 'pending') text = 'Saving…'
  if (effectivePhase === 'saved') text = 'Saved'
  if (effectivePhase === 'failed') text = filteredError ?? saveError ?? 'Could not save'

  return (
    <div className={`settings-save-status settings-save-status-${effectivePhase}`}>
      {text}
    </div>
  )
}

export function SettingsRestoreButton({ title, onClick }: { title: string; onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className="settings-restore-btn" onClick={onClick}>
      {title}
    </button>
  )
}

export function SettingsInlineError({ message }: { message: string }): React.JSX.Element {
  return <SettingsFriendlyCallout text={message} />
}

export function SettingsConnectionTestPanel({
  result,
  errorMessage,
  isRunning,
}: {
  result: ConnectionTestResponse | null
  errorMessage: string | null
  isRunning: boolean
}): React.JSX.Element {
  const steps =
    result?.steps?.length
      ? result.steps
      : isRunning
        ? ['Running connection test…']
        : errorMessage
          ? [errorMessage]
          : ['Press Test Connection above to verify your current settings.']

  const statusTitle = isRunning
    ? 'Testing…'
    : result
      ? result.ok
        ? result.summary.toLowerCase().includes('still syncing')
          ? 'Connected — syncing'
          : 'Connection OK'
        : 'Connection failed'
      : errorMessage
        ? 'Connection failed'
        : 'Ready to test'

  const statusSubtitle = isRunning
    ? 'Checking the endpoints listed below using your current form values.'
    : result?.summary || errorMessage || 'Press Test Connection above to verify your current settings.'

  const statusKind = isRunning
    ? 'running'
    : result?.ok
      ? result.summary.toLowerCase().includes('still syncing')
        ? 'warn'
        : 'ok'
      : result || errorMessage
        ? 'failed'
        : 'idle'

  return (
    <div className={`test-panel settings-test-panel settings-test-panel-${statusKind}`}>
      <div className="settings-test-panel-head">
        <span className={`settings-test-status-icon ${statusKind}`} aria-hidden>
          {isRunning ? (
            <LoadingSpinner size={18} />
          ) : statusKind === 'ok' || statusKind === 'warn' ? (
            <CheckmarkIcon size={18} />
          ) : statusKind === 'failed' ? (
            <span className="settings-test-x">✕</span>
          ) : (
            <InfoTipIcon size={18} />
          )}
        </span>
        <div>
          <strong className={`settings-test-status-title ${statusKind}`}>{statusTitle}</strong>
          {statusSubtitle && <p className="muted settings-test-status-subtitle">{statusSubtitle}</p>}
        </div>
      </div>
      {result?.mode && (
        <p className="settings-test-mode">
          Mode <code>{result.mode}</code>
        </p>
      )}
      <p className="field-label" style={{ marginTop: 12 }}>
        What was checked
      </p>
      <div className="test-steps">
        {steps.map((step, index) => (
          <div key={index}>{formatTestStep(step)}</div>
        ))}
      </div>
    </div>
  )
}

function formatTestStep(step: string): string {
  const lower = step.toLowerCase()
  if (lower.startsWith('failed') || lower.startsWith('✗') || lower.includes('utxo index is off') || lower.includes('utxo index appears missing') || lower.includes('cookie file not found') || lower.includes('connection refused') || lower.includes('rejected login')) {
    return `✗  ${step}`
  }
  if (lower.startsWith('warning:') || lower.includes('still syncing')) {
    return `!  ${step}`
  }
  if (
    lower.includes(' ok') ||
    lower.startsWith('esplora ok') ||
    lower.includes('reachable') ||
    lower.includes('ping') ||
    lower.includes('connected') ||
    lower.includes('enabled') ||
    lower.includes('reports synced')
  ) {
    return `✓  ${step}`
  }
  return `•  ${step}`
}

export function SettingsThemeTile({
  theme,
  label,
  selected,
  onClick,
}: {
  theme: AppTheme
  label: string
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button" className={`settings-theme-tile${selected ? ' selected' : ''}`} onClick={onClick}>
      <ThemeIcon theme={theme} />
      <span className={`settings-theme-label${selected ? ' selected' : ''}`}>{label}</span>
    </button>
  )
}
