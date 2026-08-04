import { useEffect, useMemo, useState } from 'react'
import { useApp } from '@renderer/state/AppProvider'
import type { AppTheme, CoinChain, DisplayCurrency } from '@renderer/api/types'
import { SeedMaskLogoMark } from '@renderer/components/BrandMarks'
import { SettingsNavIcon } from '@renderer/components/icons'
import {
  SettingsFriendlyCallout,
  SettingsPageLayout,
  SettingsSectionBlock,
  SettingsThemeTile,
  SettingsToggleRow,
} from '@renderer/components/settings/SettingsChrome'
import { useNetworkSettingsEditor } from '@renderer/hooks/useNetworkSettingsEditor'
import { bitcoinHubLabel, friendlyHost } from '@renderer/utils/networkSettings'
import { ConnectionsSettingsView } from './ConnectionsSettingsView'

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

export function SystemSettingsView(): React.JSX.Element {
  const { loadNetworkSettings, networkSettingsEnvelope } = useApp()
  const editor = useNetworkSettingsEditor()
  const [pane, setPane] = useState<SystemPane>('general')

  useEffect(() => {
    void loadNetworkSettings()
  }, [loadNetworkSettings])

  // Prefer live draft so public-server clicks update the sidebar immediately
  // (envelope only refreshes after autosave finishes).
  const connectionsSubtitle = useMemo(() => {
    const bitcoin = editor.draft?.bitcoin ?? networkSettingsEnvelope?.settings?.bitcoin
    if (!bitcoin) return 'Bitcoin & Kaspa'
    return bitcoinHubLabel(bitcoin) || friendlyHost(bitcoin.esplora_primary, 'Recommended servers')
  }, [editor.draft, networkSettingsEnvelope])

  return (
    <div className="system-settings-shell">
      <aside className="system-settings-sidebar">
        <div className="system-settings-sidebar-title">Settings</div>
        <button
          type="button"
          className={`sidebar-nav-btn system-settings-nav-btn${pane === 'general' ? ' active' : ''}`}
          onClick={() => setPane('general')}
        >
          <SettingsNavIcon pane="general" />
          General
        </button>
        <button
          type="button"
          className={`sidebar-nav-btn system-settings-nav-btn connections${pane === 'connections' ? ' active' : ''}`}
          onClick={() => setPane('connections')}
        >
          <SettingsNavIcon pane="connections" />
          <span className="system-settings-nav-label">
            <span>Connections</span>
            <span className="system-settings-nav-sub">{connectionsSubtitle}</span>
          </span>
        </button>
      </aside>
      <div className="system-settings-detail">
        {pane === 'general' ? <GeneralSettingsPanel /> : <ConnectionsSettingsView editor={editor} />}
      </div>
    </div>
  )
}

function GeneralSettingsPanel(): React.JSX.Element {
  const { appTheme, setAppTheme, displayCurrency, setDisplayCurrency, chunkAddresses, setChunkAddresses, buildLabel } = useApp()

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

      <SettingsSectionBlock title="Display currency" subtitle="Fiat amounts on the dashboard and when sending.">
        <div className="settings-currency-card">
          <span className="settings-currency-label">Currency</span>
          <select
            className="seed-mask-field settings-currency-select"
            value={displayCurrency}
            onChange={(e) => setDisplayCurrency(e.target.value as DisplayCurrency)}
          >
            {(['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'CHF', 'AUD'] as DisplayCurrency[]).map((c) => (
              <option key={c} value={c}>
                {c} {CURRENCY_SYMBOLS[c]}
              </option>
            ))}
          </select>
        </div>
      </SettingsSectionBlock>

      <SettingsSectionBlock title="Addresses">
        <SettingsToggleRow
          label="Chunk addresses"
          checked={chunkAddresses}
          onChange={setChunkAddresses}
        />
        <p className="settings-field-hint">
          Splits long addresses into short groups (every 4 characters) so they are easier to read and verify in Receive and Review &amp; sign.
        </p>
      </SettingsSectionBlock>

      <SettingsSectionBlock title="Security">
        <SettingsFriendlyCallout
          icon="shield"
          text="This Mac only stores watch-only public keys. Your seed and private key never leave your hardware device."
        />
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
    </SettingsPageLayout>
  )
}
