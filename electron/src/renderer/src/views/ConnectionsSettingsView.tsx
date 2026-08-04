import { useEffect, useState } from 'react'
import { useApp } from '@renderer/state/AppProvider'
import {
  SettingsChainHubCard,
  SettingsChoiceOption,
  SettingsConnectionModeTile,
  SettingsConnectionTestPanel,
  SettingsField,
  SettingsFriendlyCallout,
  SettingsHostPortField,
  SettingsInlineError,
  SettingsPageLayout,
  SettingsPathBrowseField,
  SettingsRestoreButton,
  SettingsSaveStatus,
  SettingsSectionBlock,
  SettingsToggleRow,
} from '@renderer/components/settings/SettingsChrome'
import { useNetworkSettingsEditor, type NetworkSettingsEditor } from '@renderer/hooks/useNetworkSettingsEditor'
import {
  BITCOIN_PUBLIC_PRESETS,
  BITCOIN_SERVER_MODES,
  KASPA_RPC_MODES,
  bitcoinHubDetail,
  bitcoinHubLabel,
  kaspaHubDetail,
  saveErrorForChain,
  completeBitcoinSettings,
  splitNetworkLines,
} from '@renderer/utils/networkSettings'

type ConnectionsDestination = 'overview' | 'bitcoin' | 'kaspa'

export function ConnectionsSettingsView({
  editor: editorProp,
}: {
  editor?: NetworkSettingsEditor
} = {}): React.JSX.Element {
  if (editorProp) {
    return <ConnectionsSettingsInner editor={editorProp} />
  }
  return <ConnectionsSettingsWithOwnEditor />
}

function ConnectionsSettingsWithOwnEditor(): React.JSX.Element {
  const { loadNetworkSettings } = useApp()
  const editor = useNetworkSettingsEditor()
  useEffect(() => {
    void loadNetworkSettings()
  }, [loadNetworkSettings])
  return <ConnectionsSettingsInner editor={editor} />
}

function ConnectionsSettingsInner({ editor }: { editor: NetworkSettingsEditor }): React.JSX.Element {
  const [destination, setDestination] = useState<ConnectionsDestination>('overview')

  if (!editor.isLoaded || !editor.draft || !editor.defaults) {
    return (
      <SettingsPageLayout
        title="Connections"
        subtitle="Choose where SeedMask looks up balances, fees, and transaction history. Most people can leave the defaults."
      >
        <p className="muted">Loading connections…</p>
      </SettingsPageLayout>
    )
  }

  if (destination === 'bitcoin') {
    return (
      <BitcoinNetworkSettingsPage
        editor={editor}
        onBack={() => setDestination('overview')}
      />
    )
  }

  if (destination === 'kaspa') {
    return (
      <KaspaNetworkSettingsPage
        editor={editor}
        onBack={() => setDestination('overview')}
      />
    )
  }

  return (
    <SettingsPageLayout
      title="Connections"
      subtitle="Choose where SeedMask looks up balances, fees, and transaction history. Most people can leave the defaults."
    >
      <div className="settings-hub-grid">
        <SettingsChainHubCard
          chain="bitcoin"
          serverLabel={bitcoinHubLabel(editor.draft.bitcoin)}
          serverDetail={bitcoinHubDetail(editor.draft.bitcoin)}
          onOpen={() => setDestination('bitcoin')}
        />
        <SettingsChainHubCard
          chain="kaspa"
          serverLabel={KASPA_RPC_MODES.find((m) => m.id === editor.kaspaRpcMode)?.label ?? 'Automatic'}
          serverDetail={kaspaHubDetail(editor.draft.kaspa)}
          onOpen={() => setDestination('kaspa')}
        />
      </div>

      <SettingsSaveStatus savePhase={editor.savePhase} saveError={editor.saveError} />
    </SettingsPageLayout>
  )
}

function BitcoinNetworkSettingsPage({
  editor,
  onBack,
}: {
  editor: ReturnType<typeof useNetworkSettingsEditor>
  onBack: () => void
}): React.JSX.Element {
  const { testBitcoinConnection } = useApp()
  const [showExpert, setShowExpert] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<import('@renderer/api/types').BitcoinConnectionTestResponse | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  const { draft, defaults, bitcoinServerMode, bitcoinPublicPreset } = editor
  if (!draft || !defaults) return <p className="muted">Loading…</p>

  const chainError =
    editor.savePhase === 'failed' ? saveErrorForChain(editor.saveError, 'bitcoin') : null

  async function runConnectionTest(): Promise<void> {
    setTesting(true)
    setTestResult(null)
    setTestError(null)
    try {
      const payload = completeBitcoinSettings(draft!.bitcoin, defaults!.bitcoin)
      const result = await testBitcoinConnection(payload)
      setTestResult(result)
      if (!result.ok) {
        setTestError(null)
      }
    } catch (e) {
      setTestError(e instanceof Error ? e.message : 'Test failed')
    } finally {
      setTesting(false)
    }
  }

  return (
    <SettingsPageLayout
      title="Bitcoin"
      subtitle="Choose how this app connects for balance, fees, sending, and transaction history."
      backTitle="Connections"
      onBack={onBack}
    >
      {chainError && <SettingsInlineError message={chainError} />}

      <SettingsSectionBlock
        title="Connection type"
        subtitle="Public providers are easiest. Core or Electrum keeps queries on your own infrastructure."
      >
        <div className="settings-mode-row">
          {BITCOIN_SERVER_MODES.map((mode) => (
            <SettingsConnectionModeTile
              key={mode.id}
              label={mode.label}
              subtitle={mode.subtitle}
              icon={mode.icon}
              selected={bitcoinServerMode === mode.id}
              onClick={() => {
                editor.setBitcoinServerMode(mode.id, 'bitcoin')
                setTestResult(null)
                setTestError(null)
              }}
            />
          ))}
        </div>
      </SettingsSectionBlock>

      {bitcoinServerMode === 'public' && (
        <>
          <SettingsFriendlyCallout
            icon="eye"
            text="Public servers can see which addresses and transactions you query. Use your own server for stronger privacy."
          />

          <SettingsSectionBlock title="Public server" subtitle="Pick a hosted provider.">
            {BITCOIN_PUBLIC_PRESETS.map((preset) => (
              <SettingsChoiceOption
                key={preset.id}
                title={preset.label}
                subtitle={preset.subtitle}
                selected={bitcoinPublicPreset === preset.id}
                badge={preset.suggested ? 'Suggested' : undefined}
                onClick={() => {
                  editor.setPublicPreset(preset.id, 'bitcoin')
                  setTestResult(null)
                  setTestError(null)
                }}
              />
            ))}
          </SettingsSectionBlock>

          <button type="button" className="settings-link-btn" onClick={() => setShowExpert((v) => !v)}>
            {showExpert ? 'Hide expert options' : 'Show expert options'}
          </button>

          {showExpert && (
            <BitcoinExpertSection
              draft={draft}
              defaults={defaults}
              onPatch={(updater) => editor.patchBitcoin(updater, 'bitcoin')}
            />
          )}
        </>
      )}

      {bitcoinServerMode === 'bitcoin_core' && (
        <SettingsSectionBlock title="Bitcoin Core RPC">
          <SettingsHostPortField
            label="URL"
            hint="Hostname or IP address — port is entered separately. Local Core uses plain HTTP."
            infoTip="Enter the node's hostname or IP only (e.g. 127.0.0.1). Port goes in the box beside it. Standard Bitcoin Core RPC on your Mac uses plain HTTP — not HTTPS."
            host={draft.bitcoin.core_host}
            port={draft.bitcoin.core_port}
            hostPlaceholder="127.0.0.1"
            portPlaceholder="8332"
            onHostChange={(v) => editor.patchBitcoin((b) => ({ ...b, core_host: v }), 'bitcoin')}
            onPortChange={(v) => editor.patchBitcoin((b) => ({ ...b, core_port: v }), 'bitcoin')}
          />
          <SettingsField
            label="RPC username"
            hint="From bitcoin.conf — leave empty if you use a cookie file instead."
            infoTip="The rpcuser= value from bitcoin.conf. Leave blank when using a .cookie file for authentication instead."
            value={draft.bitcoin.core_user}
            placeholder="rpcuser"
            onChange={(v) => editor.patchBitcoin((b) => ({ ...b, core_user: v }), 'bitcoin')}
          />
          <SettingsField
            label="RPC password"
            hint="From bitcoin.conf — stored only in your local settings file on this Mac."
            infoTip="The rpcpassword= value from bitcoin.conf. Stored locally in ~/.seedmask-coordinator/network_settings.json on this Mac only."
            value={draft.bitcoin.core_password}
            placeholder="rpcpassword"
            password
            onChange={(v) => editor.patchBitcoin((b) => ({ ...b, core_password: v }), 'bitcoin')}
          />
          <SettingsPathBrowseField
            label="Data folder"
            hint="Bitcoin Core data directory, or path to .cookie. Default on macOS: ~/Library/Application Support/Bitcoin"
            infoTip="The folder where Bitcoin Core stores its data. If you pick a folder, the app looks for a .cookie file inside it for default authentication. You can also paste or choose the .cookie file directly."
            value={draft.bitcoin.core_cookie_path}
            placeholder="~/Library/Application Support/Bitcoin"
            panelMessage="Choose your Bitcoin Core data folder, or select the .cookie file directly."
            onChange={(v) => editor.patchBitcoin((b) => ({ ...b, core_cookie_path: v }), 'bitcoin')}
          />
        </SettingsSectionBlock>
      )}

      {bitcoinServerMode === 'electrum' && (
        <SettingsSectionBlock title="Private Electrum">
          <SettingsHostPortField
            label="URL"
            hint="Hostname or IP address — port is entered separately."
            infoTip="Enter the Electrum server's hostname or IP only (e.g. 127.0.0.1). Port is in the box beside it. Use the SSL toggle for encrypted connections."
            host={draft.bitcoin.electrum_host}
            port={draft.bitcoin.electrum_port}
            hostPlaceholder="127.0.0.1"
            portPlaceholder="50002"
            onHostChange={(v) => editor.patchBitcoin((b) => ({ ...b, electrum_host: v }), 'bitcoin')}
            onPortChange={(v) => editor.patchBitcoin((b) => ({ ...b, electrum_port: v }), 'bitcoin')}
          />
          <SettingsToggleRow
            label="Use SSL"
            infoTip="Most private Electrum servers (electrs, Fulcrum) use SSL on port 50002. Disable only for unencrypted local TCP servers."
            checked={draft.bitcoin.electrum_use_ssl}
            onChange={(v) => editor.patchBitcoin((b) => ({ ...b, electrum_use_ssl: v }), 'bitcoin')}
          />
        </SettingsSectionBlock>
      )}

      <div className="settings-test-section">
        <div className="row" style={{ justifyContent: 'center' }}>
          <button type="button" className="btn btn-ghost" disabled={testing} onClick={() => void runConnectionTest()}>
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
        </div>
        <SettingsConnectionTestPanel result={testResult} errorMessage={testError} isRunning={testing} />
      </div>

      <SettingsSaveStatus savePhase={editor.savePhase} saveError={editor.saveError} chain="bitcoin" />
      <SettingsRestoreButton
        title="Restore recommended Bitcoin settings"
        onClick={() => setShowResetConfirm(true)}
      />

      {showResetConfirm && (
        <ConfirmDialog
          title="Restore Bitcoin defaults?"
          message="Returns to the recommended public servers."
          confirmLabel="Restore"
          onConfirm={() => {
            editor.resetBitcoin('bitcoin')
            setShowResetConfirm(false)
          }}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}
    </SettingsPageLayout>
  )
}

function BitcoinExpertSection({
  draft,
  defaults,
  onPatch,
}: {
  draft: import('@renderer/api/types').NetworkSettingsDTO
  defaults: import('@renderer/api/types').NetworkSettingsDTO
  onPatch: (updater: (b: import('@renderer/api/types').BitcoinNetworkSettingsDTO) => import('@renderer/api/types').BitcoinNetworkSettingsDTO) => void
}): React.JSX.Element {
  return (
    <SettingsSectionBlock title="Expert options" subtitle="Fine-tune the public server endpoints.">
      <SettingsField
        label="Block explorer API"
        hint="Used for balance and UTXO lookups."
        value={draft.bitcoin.esplora_primary}
        placeholder={defaults.bitcoin.esplora_primary}
        onChange={(v) => onPatch((b) => ({ ...b, esplora_primary: v }))}
      />
      <SettingsField
        label="Backup explorers"
        hint="One address per line — tried if the main one is down."
        value={draft.bitcoin.esplora_fallbacks.join('\n')}
        placeholder="https://…"
        multiline
        onChange={(v) => onPatch((b) => ({ ...b, esplora_fallbacks: splitNetworkLines(v) }))}
      />
      <SettingsField
        label="Live balance updates"
        hint="WebSocket address for instant balance changes."
        value={draft.bitcoin.websocket_url}
        placeholder={defaults.bitcoin.websocket_url}
        onChange={(v) => onPatch((b) => ({ ...b, websocket_url: v }))}
      />
      <SettingsField
        label="Fee suggestions"
        value={draft.bitcoin.fee_recommended_url}
        placeholder={defaults.bitcoin.fee_recommended_url}
        onChange={(v) => onPatch((b) => ({ ...b, fee_recommended_url: v }))}
      />
      <SettingsField
        label="Broadcast targets"
        hint="Where signed transactions are submitted."
        value={draft.bitcoin.broadcast_urls.join('\n')}
        placeholder="One URL per line"
        multiline
        onChange={(v) => onPatch((b) => ({ ...b, broadcast_urls: splitNetworkLines(v) }))}
      />
      <SettingsField
        label="Explorer links"
        hint="Use {txid} where the transaction ID goes."
        value={draft.bitcoin.explorer_tx_template}
        placeholder={defaults.bitcoin.explorer_tx_template}
        onChange={(v) => onPatch((b) => ({ ...b, explorer_tx_template: v }))}
      />
      <SettingsToggleRow
        label="Allow older backup services"
        checked={draft.bitcoin.enable_legacy_fallbacks}
        onChange={(v) => onPatch((b) => ({ ...b, enable_legacy_fallbacks: v }))}
      />
    </SettingsSectionBlock>
  )
}

function KaspaNetworkSettingsPage({
  editor,
  onBack,
}: {
  editor: ReturnType<typeof useNetworkSettingsEditor>
  onBack: () => void
}): React.JSX.Element {
  const [showExpert, setShowExpert] = useState(() => editor.kaspaRpcMode === 'custom')
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [showOwnNodeGuide, setShowOwnNodeGuide] = useState(false)
  const { draft, defaults, kaspaRpcMode } = editor
  if (!draft || !defaults) return <p className="muted">Loading…</p>

  const chainError =
    editor.savePhase === 'failed' ? saveErrorForChain(editor.saveError, 'kaspa') : null

  return (
    <SettingsPageLayout
      title="Kaspa"
      subtitle="One connection for live balance, and a separate service for transaction history."
      backTitle="Connections"
      onBack={onBack}
    >
      {chainError && <SettingsInlineError message={chainError} />}

      <SettingsSectionBlock
        title="Live balance"
        subtitle="How the app watches your wallet in real time."
      >
        {KASPA_RPC_MODES.map((mode) => {
          const choice = (
            <SettingsChoiceOption
              title={mode.label}
              subtitle={mode.subtitle}
              selected={kaspaRpcMode === mode.id}
              badge={mode.suggested ? 'Suggested' : undefined}
              onClick={() => {
                editor.setKaspaMode(mode.id, 'kaspa')
                if (mode.id === 'custom') setShowExpert(true)
              }}
            />
          )

          if (mode.id !== 'custom') {
            return <div key={mode.id}>{choice}</div>
          }

          return (
            <div className="settings-choice-with-help" key={mode.id}>
              {choice}
              <button
                type="button"
                className="settings-choice-help-btn"
                aria-label="How to run your own Kaspa node"
                onClick={() => setShowOwnNodeGuide(true)}
              >
                <span>How to</span>
                <span className="settings-choice-help-icon" aria-hidden="true">
                  i
                </span>
              </button>
            </div>
          )
        })}

        {kaspaRpcMode === 'custom' && (
          <SettingsField
            label="Node WebSocket address"
            hint="The wrpc endpoint your Kaspa node exposes."
            value={draft.kaspa.rpc_url}
            placeholder="wss://…"
            onChange={(v) =>
              editor.setDraft((current) => {
                const next = structuredClone(current)
                next.kaspa.rpc_url = v
                return next
              }, 'kaspa')
            }
          />
        )}
      </SettingsSectionBlock>

      {showExpert ? (
        <>
          <SettingsSectionBlock
            title="Transaction history"
            subtitle={
              kaspaRpcMode === 'custom'
                ? 'Own-node mode never sends wallet addresses to a public history service by default.'
                : 'Automatic mode uses the Kaspa community history API.'
            }
          >
            {kaspaRpcMode === 'custom' ? (
              <>
                <SettingsFriendlyCallout
                  icon={editor.kaspaHistoryMode === 'disabled' ? 'shield' : 'eye'}
                  text={
                    editor.kaspaHistoryMode === 'disabled'
                      ? 'Private mode is active. Live balance, UTXOs, sends, and broadcasts use your node; no address history is sent to third parties.'
                      : editor.kaspaHistoryMode === 'public'
                        ? 'Live balance still uses your node. Address history queries go to the public Kaspa API below — that service can see which addresses you look up.'
                        : 'Live balance uses your node. Transaction history uses the private API you configure below.'
                  }
                />
                <SettingsChoiceOption
                  title="None (private)"
                  subtitle="Do not query any transaction-history service. Safest for privacy; may miss fully spent addresses on restore."
                  selected={editor.kaspaHistoryMode === 'disabled'}
                  badge="Default"
                  onClick={() => editor.setKaspaHistoryMode('disabled', 'kaspa')}
                />
                <SettingsChoiceOption
                  title="Public history"
                  subtitle="Community address history API. Finds past receive/change activity; the provider sees queried addresses."
                  selected={editor.kaspaHistoryMode === 'public'}
                  onClick={() => editor.setKaspaHistoryMode('public', 'kaspa')}
                />
                {editor.kaspaHistoryMode === 'public' && (
                  <div className="settings-history-path">
                    <span className="settings-field-hint">History service path</span>
                    <code className="settings-history-path-url">https://api.kaspa.org</code>
                    <p className="muted settings-history-path-note">
                      Coordinator calls this HTTP API for transaction history and address discovery. Your Kaspa
                      node WebSocket is still used for live balance, UTXOs, and broadcast.
                    </p>
                  </div>
                )}
                <SettingsChoiceOption
                  title="Private history API"
                  subtitle="Use a kaspa-rest-server and indexer that you host or trust."
                  selected={editor.kaspaHistoryMode === 'custom'}
                  onClick={() => editor.setKaspaHistoryMode('custom', 'kaspa')}
                />
                {editor.kaspaHistoryMode === 'custom' && (
                  <SettingsField
                    label="Private history API address"
                    hint="Example: http://127.0.0.1:8000. No public fallback is used."
                    value={draft.kaspa.history_api_base ?? ''}
                    placeholder="http://127.0.0.1:8000"
                    onChange={(v) =>
                      editor.setDraft((current) => {
                        const next = structuredClone(current)
                        next.kaspa.history_mode = 'custom'
                        next.kaspa.history_api_base = v
                        return next
                      }, 'kaspa')
                    }
                  />
                )}
              </>
            ) : (
              <SettingsFriendlyCallout
                icon="eye"
                text="The public history service can see which wallet addresses are queried. Choose Your own node for private-by-default operation."
              />
            )}
          </SettingsSectionBlock>

          <SettingsSectionBlock
            title="Explorer links"
            subtitle="Explorer websites are contacted only when you open a transaction link."
          >
            <SettingsField
              label="Explorer link template"
              hint="Use {txid} where the transaction ID goes."
              value={draft.kaspa.explorer_tx_template ?? defaults.kaspa.explorer_tx_template ?? ''}
              placeholder="https://kaspa.stream/transactions/{txid}"
              onChange={(v) =>
                editor.setDraft((current) => {
                  const next = structuredClone(current)
                  next.kaspa.explorer_tx_template = v
                  return next
                }, 'kaspa')
              }
            />
          </SettingsSectionBlock>
        </>
      ) : (
        <button type="button" className="settings-link-btn" onClick={() => setShowExpert(true)}>
          Show privacy, history & explorer options
        </button>
      )}

      <div className="settings-kaspa-footer">
        <SettingsRestoreButton title="Restore recommended Kaspa settings" onClick={() => setShowResetConfirm(true)} />
        <SettingsSaveStatus savePhase={editor.savePhase} saveError={editor.saveError} chain="kaspa" />
      </div>

      {showResetConfirm && (
        <ConfirmDialog
          title="Restore Kaspa defaults?"
          message="Returns to automatic node discovery."
          confirmLabel="Restore"
          onConfirm={() => {
            editor.resetKaspa('kaspa')
            setShowResetConfirm(false)
          }}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}
      {showOwnNodeGuide && <KaspaOwnNodeGuide onClose={() => setShowOwnNodeGuide(false)} />}
    </SettingsPageLayout>
  )
}

function KaspaOwnNodeGuide({ onClose }: { onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const openMyKai = (): void => {
    if (window.seedmask?.openExternal) {
      void window.seedmask.openExternal('https://mykai.dev/')
      return
    }
    window.open('https://mykai.dev/', '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card kaspa-node-guide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kaspa-node-guide-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="kaspa-node-guide-head">
          <div>
            <h3 id="kaspa-node-guide-title">Run your own Kaspa node</h3>
            <p className="muted">
              Coordinator uses your node for live balance, UTXOs, sending, and broadcasting. When the node and
              Coordinator run on the same computer, use <code>ws://127.0.0.1:17110</code>.
            </p>
          </div>
          <button type="button" className="btn btn-ghost kaspa-node-guide-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="kaspa-node-guide-content">
          <section>
            <h4>Mac or Linux — Docker</h4>
            <ol>
              <li>Install and start Docker Desktop (Mac) or Docker Engine (Linux).</li>
              <li>Run kaspad with its data saved locally and Borsh wRPC exposed on port 17110:</li>
            </ol>
            <pre className="kaspa-node-guide-command">
              <code>{`docker run -d \\
  --name kaspa-node \\
  --restart unless-stopped \\
  -v ~/kaspa-data:/app/data \\
  -p 16111:16111 \\
  -p 17110:17110 \\
  kaspanet/rusty-kaspad:latest \\
  kaspad --utxoindex --disable-upnp --yes \\
  --rpclisten-borsh=0.0.0.0:17110`}</code>
            </pre>
            <p className="muted">
              Wait for the node to sync. Close this guide, then enter <code>ws://127.0.0.1:17110</code> in the{' '}
              <strong>Node WebSocket address</strong> field. If you already run kaspad, do not start a second
              container—just ensure port 17110 and the Borsh option are enabled.
            </p>
          </section>

          <section>
            <h4>Windows — MyKAI</h4>
            <p>
              Install and start the one-click node, wait for it to sync, then use{' '}
              <code>ws://127.0.0.1:17110</code>. MyKAI must expose Borsh wRPC on port 17110.
            </p>
            <button type="button" className="settings-link-btn kaspa-node-guide-link" onClick={openMyKai}>
              Open mykai.dev ↗
            </button>
          </section>

          <section className="kaspa-node-guide-history">
            <h4>Transaction history is separate</h4>
            <p>
              A kaspad node does not provide indexed wallet history. Under Transaction history choose{' '}
              <strong>None (private)</strong> (no third-party queries), <strong>Public</strong> (
              <code>https://api.kaspa.org</code> — finds past activity; the API sees queried addresses), or a{' '}
              <strong>Private history API</strong> you host.
            </p>
          </section>
        </div>

        <div className="kaspa-node-guide-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div className="modal-card" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p className="muted">{message}</p>
        <div className="row spread" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
