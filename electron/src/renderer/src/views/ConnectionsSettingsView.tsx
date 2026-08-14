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
  SettingsKaspaWsUrlField,
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

export type { ConnectionsDestination }

export function ConnectionsSettingsView({
  editor: editorProp,
  onDestinationChange,
}: {
  editor?: NetworkSettingsEditor
  onDestinationChange?: (destination: ConnectionsDestination) => void
} = {}): React.JSX.Element {
  if (editorProp) {
    return <ConnectionsSettingsInner editor={editorProp} onDestinationChange={onDestinationChange} />
  }
  return <ConnectionsSettingsWithOwnEditor onDestinationChange={onDestinationChange} />
}

function ConnectionsSettingsWithOwnEditor({
  onDestinationChange,
}: {
  onDestinationChange?: (destination: ConnectionsDestination) => void
}): React.JSX.Element {
  const { loadNetworkSettings } = useApp()
  const editor = useNetworkSettingsEditor()
  useEffect(() => {
    void loadNetworkSettings()
  }, [loadNetworkSettings])
  return <ConnectionsSettingsInner editor={editor} onDestinationChange={onDestinationChange} />
}

function ConnectionsSettingsInner({
  editor,
  onDestinationChange,
}: {
  editor: NetworkSettingsEditor
  onDestinationChange?: (destination: ConnectionsDestination) => void
}): React.JSX.Element {
  const [destination, setDestination] = useState<ConnectionsDestination>('overview')

  useEffect(() => {
    onDestinationChange?.(destination)
  }, [destination, onDestinationChange])

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
  const [showCoreGuide, setShowCoreGuide] = useState(false)
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
        <SettingsSectionBlock
          title="Bitcoin Core RPC"
          subtitle="Point Coordinator at your local node, then test the connection."
        >
          <div className="own-node-guide-row">
            <p className="muted own-node-guide-blurb">
              Need help? Open the setup guide for install, bitcoin.conf, and which fields to fill.
            </p>
            <button type="button" className="settings-link-btn" onClick={() => setShowCoreGuide(true)}>
              How to set up →
            </button>
          </div>
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
      {showCoreGuide && <BitcoinCoreOwnNodeGuide onClose={() => setShowCoreGuide(false)} />}
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
  const { testKaspaConnection } = useApp()
  const [showExpert, setShowExpert] = useState(() => editor.kaspaRpcMode === 'custom')
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [showOwnNodeGuide, setShowOwnNodeGuide] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<import('@renderer/api/types').KaspaConnectionTestResponse | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const { draft, defaults, kaspaRpcMode } = editor
  if (!draft || !defaults) return <p className="muted">Loading…</p>

  const chainError =
    editor.savePhase === 'failed' ? saveErrorForChain(editor.saveError, 'kaspa') : null

  async function runConnectionTest(): Promise<void> {
    setTesting(true)
    setTestResult(null)
    setTestError(null)
    try {
      const result = await testKaspaConnection({
        ...defaults!.kaspa,
        ...draft!.kaspa,
        rpc_mode: draft!.kaspa.rpc_mode || defaults!.kaspa.rpc_mode,
        rpc_url: draft!.kaspa.rpc_url ?? defaults!.kaspa.rpc_url,
      })
      setTestResult(result)
    } catch (e) {
      setTestError(e instanceof Error ? e.message : 'Test failed')
    } finally {
      setTesting(false)
    }
  }

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
                setTestResult(null)
                setTestError(null)
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
          <SettingsKaspaWsUrlField
            label="Node WebSocket address"
            hint="Usually a local kaspad Borsh port. Open How to if you need Docker or MyKAI steps."
            value={draft.kaspa.rpc_url}
            onChange={(v) => {
              editor.setDraft((current) => {
                const next = structuredClone(current)
                next.kaspa.rpc_url = v
                return next
              }, 'kaspa')
              setTestResult(null)
              setTestError(null)
            }}
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

      <div className="settings-test-section">
        <div className="row" style={{ justifyContent: 'center' }}>
          <button type="button" className="btn btn-ghost" disabled={testing} onClick={() => void runConnectionTest()}>
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
        </div>
        <SettingsConnectionTestPanel result={testResult} errorMessage={testError} isRunning={testing} />
      </div>

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

function GuideCommandBlock({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  async function copyCommand(): Promise<void> {
    try {
      if (window.seedmask?.copyText) {
        await window.seedmask.copyText(text)
      } else {
        await navigator.clipboard.writeText(text)
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="own-node-guide-command-wrap">
      <pre className="own-node-guide-command">
        <code>{text}</code>
      </pre>
      <button type="button" className="own-node-guide-copy-btn" onClick={() => void copyCommand()}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

const KASPA_DOCKER_COMMAND = `docker run -d \\
  --name kaspa-node \\
  --restart unless-stopped \\
  -v ~/kaspa-data:/app/data \\
  -p 16111:16111 \\
  -p 17110:17110 \\
  kaspanet/rusty-kaspad:latest \\
  kaspad --utxoindex --disable-upnp --yes \\
  --rpclisten-borsh=0.0.0.0:17110`

const KASPA_DOCKER_STOP = 'docker stop kaspa-node'
const KASPA_DOCKER_START = 'docker start kaspa-node'
const KASPA_DOCKER_PAUSE = 'docker pause kaspa-node'
const KASPA_DOCKER_UNPAUSE = 'docker unpause kaspa-node'

const BITCOIN_CONF_SNIPPET = `server=1
rpcbind=127.0.0.1
rpcallowip=127.0.0.1`

function BitcoinCoreOwnNodeGuide({ onClose }: { onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const openBitcoinCore = (): void => {
    const url = 'https://bitcoincore.org/en/download/'
    if (window.seedmask?.openExternal) {
      void window.seedmask.openExternal(url)
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card own-node-guide-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bitcoin-core-guide-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="own-node-guide-modal-head">
          <div>
            <p className="own-node-guide-eyebrow">Bitcoin</p>
            <h3 id="bitcoin-core-guide-title">How to connect Bitcoin Core</h3>
            <p className="muted">
              Think of this as three short jobs: get Core running, turn on RPC, then tell Coordinator where it is.
            </p>
          </div>
          <button type="button" className="btn btn-ghost own-node-guide-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="own-node-guide-modal-body">
          <section>
            <h4>Get Bitcoin Core ready</h4>
            <p>
              Download Bitcoin Core from the official site, install it, and open it. The first sync can take many hours
              — wait until Core shows that it is fully synced before you rely on balances in Coordinator.
            </p>
            <button type="button" className="settings-link-btn" onClick={openBitcoinCore}>
              Official download ↗
            </button>
          </section>

          <section>
            <h4>Turn on RPC (one-time)</h4>
            <p>
              Coordinator talks to Core through RPC on this Mac. Add these lines to{' '}
              <code>bitcoin.conf</code>, then restart Bitcoin Core:
            </p>
            <p className="muted own-node-guide-path">
              Usual file on macOS: <code>~/Library/Application Support/Bitcoin/bitcoin.conf</code>
            </p>
            <GuideCommandBlock text={BITCOIN_CONF_SNIPPET} />
            <p className="muted">
              You can leave username and password empty. Modern Core creates a <code>.cookie</code> file for login —
              Coordinator reads it when <strong>Data folder</strong> points at that Bitcoin directory. You do not need{' '}
              <code>txindex=1</code> for watch-only wallets in Coordinator.
            </p>
          </section>

          <section>
            <h4>Fill in Coordinator</h4>
            <ul className="own-node-guide-checklist">
              <li>
                <strong>URL:</strong> host <code>127.0.0.1</code>, port <code>8332</code>
              </li>
              <li>
                <strong>Data folder:</strong> <code>~/Library/Application Support/Bitcoin</code> (or browse to it)
              </li>
              <li>
                <strong>Username / password:</strong> leave blank if you use the cookie
              </li>
              <li>
                Tap <strong>Test Connection</strong>. When it succeeds, you are done.
              </li>
            </ul>
          </section>
        </div>

        <div className="own-node-guide-modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Back to settings
          </button>
        </div>
      </div>
    </div>
  )
}

function KaspaOwnNodeGuide({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [showExistingKaspadHelp, setShowExistingKaspadHelp] = useState(false)

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const openExternal = (url: string): void => {
    if (window.seedmask?.openExternal) {
      void window.seedmask.openExternal(url)
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card own-node-guide-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kaspa-node-guide-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="own-node-guide-modal-head">
          <div>
            <p className="own-node-guide-eyebrow">Kaspa</p>
            <h3 id="kaspa-node-guide-title">How to run your own Kaspa node</h3>
            <p className="muted">
              Your computer verifies Kaspa; Coordinator only asks for balances and broadcast. Signing stays on SeedMask.
            </p>
          </div>
          <button type="button" className="btn btn-ghost own-node-guide-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="own-node-guide-modal-body">
          <section>
            <h4>Mac or Linux</h4>
            <ol className="own-node-guide-numbered">
              <li>
                <strong>Install Docker</strong> if needed, open it, wait until it is running.
                <div className="own-node-guide-inline-links">
                  <button
                    type="button"
                    className="settings-link-btn"
                    onClick={() => openExternal('https://www.docker.com/products/docker-desktop/')}
                  >
                    Docker Desktop (Mac) ↗
                  </button>
                  <button
                    type="button"
                    className="settings-link-btn"
                    onClick={() => openExternal('https://docs.docker.com/engine/install/')}
                  >
                    Docker Engine (Linux) ↗
                  </button>
                </div>
              </li>
              <li>
                <strong>Open Terminal</strong> (Mac: Spotlight → “Terminal”; Linux: your terminal app).
              </li>
              <li>
                <strong>Copy, paste, Enter</strong> — once. First run downloads the image (a few minutes).
                <GuideCommandBlock text={KASPA_DOCKER_COMMAND} />
                <p className="muted own-node-guide-note">
                  Creates <code>kaspa-node</code>, stores data in <code>~/kaspa-data</code>, opens port{' '}
                  <code>17110</code>. No need to run again unless you delete the container.
                </p>
              </li>
              <li>
                <strong>Wait for sync.</strong> First sync can take a while; balances may look empty until it finishes.
              </li>
            </ol>

            <div className="own-node-guide-note own-node-guide-expand">
              <p className="muted own-node-guide-note">
                <strong>Already run kaspad yourself?</strong>{' '}
                <button
                  type="button"
                  className="settings-link-btn"
                  aria-expanded={showExistingKaspadHelp}
                  onClick={() => setShowExistingKaspadHelp((open) => !open)}
                >
                  {showExistingKaspadHelp ? 'See less' : 'See more'}
                </button>
              </p>
              {showExistingKaspadHelp ? (
                <p className="muted own-node-guide-note">
                  Skip the Docker steps above — do not start a second node. Stop your current kaspad, then start it
                  again with these two options added (same as the Docker command uses): <code>--utxoindex</code> and{' '}
                  <code>--rpclisten-borsh=0.0.0.0:17110</code>. After it is synced, use{' '}
                  <code>ws://127.0.0.1:17110</code> in Coordinator. If you are using the Docker command, you can ignore
                  this.
                </p>
              ) : null}
            </div>
            <p className="muted own-node-guide-note">
              <strong>Windows:</strong> install{' '}
              <button type="button" className="settings-link-btn" onClick={() => openExternal('https://mykai.dev/')}>
                MyKAI ↗
              </button>
              , start the node, wait for sync, then use <code>ws://127.0.0.1:17110</code> (Borsh wRPC).
            </p>
          </section>

          <section>
            <h4>Connect Coordinator</h4>
            <ul className="own-node-guide-checklist">
              <li>
                Stay on <strong>Connections → Kaspa</strong> and select <strong>Your own node</strong>
              </li>
              <li>
                Set <strong>Node WebSocket address</strong> to <code>ws://127.0.0.1:17110</code>
              </li>
              <li>
                Tap <strong>Test Connection</strong>. When it succeeds (or says syncing), you are on the right path.
              </li>
              <li>Keep that setting — live balance, coins, send, and broadcast use your node</li>
              <li>
                History is optional: <strong>None</strong> (most private), public API, or your own history server
              </li>
            </ul>
          </section>

          <details
            className="own-node-guide-disclosure"
            onToggle={(event) => {
              if (!event.currentTarget.open) return
              const panel = event.currentTarget
              window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => {
                  panel.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' })
                })
              })
            }}
          >
            <summary className="own-node-guide-disclosure-summary">
              <h4>Useful later</h4>
              <span className="own-node-guide-chevron" aria-hidden />
            </summary>
            <div className="own-node-guide-disclosure-body">
            <ol className="own-node-guide-numbered">
              <li>
                <strong>Docker resources (Mac)</strong> — Docker Desktop → <strong>Settings → Resources</strong>.
                <p className="muted own-node-guide-note">
                  Use CPU <strong>3</strong>, Memory <strong>5 GB</strong>, Swap <strong>1 GB</strong>, then Apply.
                  Lower settings often make catch-up crawl or look stuck. You can lower resources again when the node is
                  synced and you want the Mac snappier. Changing these does not wipe <code>~/kaspa-data</code>.
                </p>
              </li>
              <li>
                <strong>Turn the node off and on</strong> — use stop / start for everyday use (closing the lid for a
                while, freeing Mac memory, finishing for the day).
                <p className="muted own-node-guide-note">
                  Stop shuts the node down cleanly. Start brings the same container back. Data stays in{' '}
                  <code>~/kaspa-data</code> — do not run the first-time <code>docker run</code> command again.
                  Overnight or a day off, catch-up is usually short. After several days or weeks off, Kaspa is so fast
                  that catch-up can take hours and feel like a full sync. That is normal.
                </p>
                <div className="own-node-guide-command-stack">
                  <GuideCommandBlock text={KASPA_DOCKER_STOP} />
                  <GuideCommandBlock text={KASPA_DOCKER_START} />
                </div>
              </li>
              <li>
                <strong>Short pause only</strong> — freeze / unfreeze without a full shutdown (quick break).
                <p className="muted own-node-guide-note">
                  Pause keeps the process in memory. Prefer stop / start if you will be away longer or the Mac feels
                  slow.
                </p>
                <div className="own-node-guide-command-stack">
                  <GuideCommandBlock text={KASPA_DOCKER_PAUSE} />
                  <GuideCommandBlock text={KASPA_DOCKER_UNPAUSE} />
                </div>
              </li>
              <li>
                <strong>Leave Docker running in the background</strong> — close Docker Desktop with the window{' '}
                <strong>×</strong>. Do not Quit Docker from the menu if you want <code>kaspa-node</code> to keep
                running.
              </li>
            </ol>

            <p className="muted own-node-guide-note">
              <strong>Optional:</strong> copy <code>~/kaspa-data</code> only if you might wipe Docker or reinstall the
              Mac. Stop the node first. That copy will not skip a long catch-up after days off.
            </p>
            </div>
          </details>
        </div>

        <div className="own-node-guide-modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Back to settings
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
