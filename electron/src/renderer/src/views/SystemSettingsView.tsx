import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '@renderer/state/AppProvider'
import type { AppTheme, DisplayCurrency } from '@renderer/api/types'
import { SeedMaskLogoMark } from '@renderer/components/BrandMarks'
import { SettingsNavIcon } from '@renderer/components/icons'
import {
  InfoTipButton,
  SettingsFriendlyCallout,
  SettingsPageLayout,
  SettingsSectionBlock,
  SettingsThemeTile,
  SettingsToggleRow,
} from '@renderer/components/settings/SettingsChrome'
import { useNetworkSettingsEditor } from '@renderer/hooks/useNetworkSettingsEditor'
import { bitcoinHubLabel, kaspaHubLabel } from '@renderer/utils/networkSettings'
import { ConnectionsSettingsView, type ConnectionsDestination } from './ConnectionsSettingsView'
import { useUpdaterStatus } from '@renderer/hooks/useUpdaterStatus'
import { AddressDisplay } from '@renderer/components/AddressDisplay'

type SystemPane = 'general' | 'connections'

const CURRENCY_SYMBOLS: Record<DisplayCurrency, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CAD: 'CA$',
  CHF: 'CHF',
  AUD: 'A$',
}

// Preview lengths match typical mainnet addresses so leftover chunk size is realistic
// (Kaspa payload length ≡ 1 mod 4 → last group is 1 character).
const CHUNK_PREVIEW_KASPA =
  'kaspa:qqxq8yv63c3c4q8zq8yv63c3c4q8zq8yv63c3c4q8zq8yv63c3c4q8zq8yv6x'
const CHUNK_PREVIEW_BITCOIN = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'

export function SystemSettingsView(): React.JSX.Element {
  const { loadNetworkSettings, networkSettingsEnvelope } = useApp()
  const editor = useNetworkSettingsEditor()
  const [pane, setPane] = useState<SystemPane>('general')
  const [generalKey, setGeneralKey] = useState(0)
  const [connectionsKey, setConnectionsKey] = useState(0)
  const [connectionsDestination, setConnectionsDestination] = useState<ConnectionsDestination>('overview')
  const detailRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadNetworkSettings()
  }, [loadNetworkSettings])

  // Prefer live draft so preference clicks update the sidebar immediately
  // (envelope only refreshes after autosave finishes).
  const connectionsSubtitle = useMemo(() => {
    const bitcoin = editor.draft?.bitcoin ?? networkSettingsEnvelope?.settings?.bitcoin
    const kaspa = editor.draft?.kaspa ?? networkSettingsEnvelope?.settings?.kaspa
    const bitcoinLabel = bitcoin ? bitcoinHubLabel(bitcoin) : 'Bitcoin'
    const kaspaLabel = kaspa ? kaspaHubLabel(kaspa) : 'Kaspa'

    if (connectionsDestination === 'bitcoin') return bitcoinLabel
    if (connectionsDestination === 'kaspa') return kaspaLabel
    return [
      { chain: 'Bitcoin', label: bitcoinLabel },
      { chain: 'Kaspa', label: kaspaLabel },
    ]
  }, [editor.draft, networkSettingsEnvelope, connectionsDestination])

  function openPane(next: SystemPane): void {
    if (pane === next) {
      if (next === 'general') setGeneralKey((k) => k + 1)
      else {
        setConnectionsKey((k) => k + 1)
        setConnectionsDestination('overview')
      }
    } else {
      setPane(next)
      if (next === 'connections') setConnectionsDestination('overview')
    }
    detailRef.current?.scrollTo({ top: 0, left: 0 })
  }

  return (
    <div className="system-settings-shell">
      <aside className="system-settings-sidebar">
        <div className="system-settings-sidebar-title">Settings</div>
        <button
          type="button"
          className={`sidebar-nav-btn system-settings-nav-btn${pane === 'general' ? ' active' : ''}`}
          onClick={() => openPane('general')}
        >
          <SettingsNavIcon pane="general" />
          General
        </button>
        <button
          type="button"
          className={`sidebar-nav-btn system-settings-nav-btn connections${pane === 'connections' ? ' active' : ''}`}
          onClick={() => openPane('connections')}
        >
          <SettingsNavIcon pane="connections" />
          <span className="system-settings-nav-label">
            <span>Connections</span>
            {typeof connectionsSubtitle === 'string' ? (
              <span className="system-settings-nav-sub">{connectionsSubtitle}</span>
            ) : (
              <span className="system-settings-nav-sub system-settings-nav-sub-stack">
                {connectionsSubtitle.map((row) => (
                  <span key={row.chain} className="system-settings-nav-sub-line">
                    <span className="system-settings-nav-sub-chain">{row.chain}</span>
                    {row.label}
                  </span>
                ))}
              </span>
            )}
          </span>
        </button>
      </aside>
      <div className="system-settings-detail" ref={detailRef}>
        {pane === 'general' ? (
          <GeneralSettingsPanel key={generalKey} />
        ) : (
          <ConnectionsSettingsView
            key={connectionsKey}
            editor={editor}
            onDestinationChange={setConnectionsDestination}
          />
        )}
      </div>
    </div>
  )
}

function GeneralSettingsPanel(): React.JSX.Element {
  const { appTheme, setAppTheme, displayCurrency, setDisplayCurrency, chunkAddresses, setChunkAddresses, buildLabel } = useApp()
  const updateStatus = useUpdaterStatus()
  const [updateBusy, setUpdateBusy] = useState(false)

  async function onCheckUpdates(): Promise<void> {
    if (!window.seedmask?.checkForUpdates) return
    setUpdateBusy(true)
    try {
      await window.seedmask.checkForUpdates()
    } finally {
      setUpdateBusy(false)
    }
  }

  async function onDownloadUpdate(): Promise<void> {
    if (!window.seedmask?.applyUpdate) return
    setUpdateBusy(true)
    try {
      await window.seedmask.applyUpdate()
    } finally {
      setUpdateBusy(false)
    }
  }

  async function onInstallUpdate(): Promise<void> {
    if (!window.seedmask?.applyUpdate) return
    setUpdateBusy(true)
    try {
      await window.seedmask.applyUpdate()
    } finally {
      setUpdateBusy(false)
    }
  }

  const phase = updateStatus?.phase ?? 'idle'
  const updateHint =
    updateStatus?.message ||
    (phase === 'idle' ? 'Check GitHub Releases for a newer Coordinator build.' : '')

  return (
    <SettingsPageLayout title="General">
      <SettingsSectionBlock title="Theme" subtitle="Light for daytime, Dark or Dim for low-light rooms.">
        <div className="settings-theme-row">
          {(['light', 'dark', 'dim'] as AppTheme[]).map((theme) => (
            <SettingsThemeTile
              key={theme}
              theme={theme}
              label={theme.charAt(0).toUpperCase() + theme.slice(1)}
              selected={appTheme === theme}
              onClick={() => setAppTheme(theme)}
            />
          ))}
        </div>
      </SettingsSectionBlock>

      <SettingsSectionBlock title="Display currency">
        <div className="settings-currency-control">
          <label className="settings-currency-select-wrap">
            <span className="sr-only">Currency</span>
            <select
              className="settings-currency-select"
              value={displayCurrency}
              onChange={(e) => setDisplayCurrency(e.target.value as DisplayCurrency)}
            >
              {(['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'CHF', 'AUD'] as DisplayCurrency[]).map((c) => (
                <option key={c} value={c}>
                  {c} · {CURRENCY_SYMBOLS[c]}
                </option>
              ))}
            </select>
            <svg className="settings-currency-caret" viewBox="0 0 12 8" width="12" height="8" aria-hidden>
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
          <InfoTipButton text="Fiat amounts on the dashboard and when sending." />
        </div>
      </SettingsSectionBlock>

      <section className="settings-section">
        <SettingsToggleRow
          className="settings-toggle-row-start"
          label="Chunk addresses"
          infoTip="Groups of 4 characters — easier to read and check in Receive and Review & sign."
          checked={chunkAddresses}
          onChange={setChunkAddresses}
        />
        <div className="settings-chunk-examples" aria-live="polite">
          <p className="settings-chunk-example">
            <AddressDisplay address={CHUNK_PREVIEW_KASPA} />
          </p>
          <p className="settings-chunk-example">
            <AddressDisplay address={CHUNK_PREVIEW_BITCOIN} />
          </p>
        </div>
      </section>

      <SettingsSectionBlock
        title="Software updates"
        titleBadge={
          phase === 'available' || phase === 'downloaded' ? (
            <span className="settings-update-dot" aria-label="Update available" />
          ) : null
        }
      >
        <div className={`settings-update-card${phase === 'available' || phase === 'downloaded' ? ' has-update' : ''}`}>
          <div className="settings-update-copy">
            <p className="muted">{updateHint}</p>
            {updateStatus?.demo ? (
              <p className="settings-update-sim-note">Demo update flow — not a published release.</p>
            ) : null}
            {phase === 'downloading' && typeof updateStatus?.percent === 'number' ? (
              <div className="settings-update-progress" aria-hidden="true">
                <span style={{ width: `${Math.max(4, Math.min(100, updateStatus.percent))}%` }} />
              </div>
            ) : null}
            {updateStatus?.error ? <p className="settings-update-error">{updateStatus.error}</p> : null}
          </div>
          <div className="settings-update-actions">
            {phase === 'available' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={updateBusy}
                onClick={() => void onDownloadUpdate()}
              >
                Update now
              </button>
            ) : null}
            {phase === 'downloaded' || phase === 'installing' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={updateBusy || phase === 'installing'}
                onClick={() => void onInstallUpdate()}
              >
                {phase === 'installing' ? 'Restarting…' : 'Update now'}
              </button>
            ) : null}
            {phase !== 'available' && phase !== 'downloaded' && phase !== 'downloading' && phase !== 'installing' ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={updateBusy || phase === 'checking'}
                onClick={() => void onCheckUpdates()}
              >
                {phase === 'checking' || updateBusy ? 'Checking…' : 'Check for updates'}
              </button>
            ) : null}
            {phase === 'downloading' ? (
              <button type="button" className="btn btn-secondary" disabled>
                Downloading…
              </button>
            ) : null}
          </div>
        </div>
      </SettingsSectionBlock>

      <SettingsSectionBlock title="About">
        <div className="settings-about-card">
          <SeedMaskLogoMark height={52} />
          <div>
            <strong>SeedMask Coordinator</strong>
            <p className="muted">Watch-only · Kaspa & Bitcoin</p>
            {buildLabel && <p className="muted settings-build-label">{buildLabel}</p>}
          </div>
        </div>
      </SettingsSectionBlock>

      <SettingsSectionBlock title="Security">
        <SettingsFriendlyCallout
          icon="shield"
          text="This Mac only stores watch-only public keys. Your seed and private key never leave your hardware device."
        />
      </SettingsSectionBlock>
    </SettingsPageLayout>
  )
}
