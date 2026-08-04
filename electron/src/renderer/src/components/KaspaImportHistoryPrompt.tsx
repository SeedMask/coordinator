import type { NetworkSettingsDTO } from '@renderer/api/types'
import {
  KASPA_PUBLIC_HISTORY_API,
  withKaspaPublicHistory,
} from '@renderer/utils/networkSettings'

/**
 * Shown after importing/restoring a Kaspa watch-only wallet (kpub / SeedMask / Ledger / OneKey)
 * when Connections uses Own node + Transaction history None.
 */
export function KaspaImportHistoryPrompt({
  onChoosePublic,
  onChoosePrivate,
}: {
  onChoosePublic: () => void
  onChoosePrivate: () => void
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal-card kaspa-import-history-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kaspa-import-history-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="kaspa-import-history-title">Find past Kaspa activity?</h3>
        <p className="muted">
          You are using <strong>Your own node</strong> with <strong>None (private)</strong> history. Your node
          can see current balances and UTXOs, but not fully spent addresses. Choose how to discover past receive
          and change addresses for this imported wallet (including Ledger and OneKey).
        </p>

        <div className="kaspa-import-history-options">
          <button type="button" className="kaspa-import-history-option" onClick={onChoosePublic}>
            <strong>Use public history</strong>
            <span className="muted">
              Query <code>{KASPA_PUBLIC_HISTORY_API}</code> to find previously used addresses. That service can
              see which addresses are looked up. This also sets Connections → Kaspa → Transaction history to{' '}
              <strong>Public</strong> (you can switch back to None anytime).
            </span>
          </button>
          <button type="button" className="kaspa-import-history-option" onClick={onChoosePrivate}>
            <strong>Keep private (None)</strong>
            <span className="muted">
              Do not contact a history service. Only current UTXOs and local SeedMask records are used. Old fully
              spent addresses may be missed until you enable Public or a private history API later.
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}

export type KaspaImportHistoryChoice = 'public' | 'private'

export async function applyKaspaImportHistoryChoice(opts: {
  choice: KaspaImportHistoryChoice
  walletId: string
  networkSettings: NetworkSettingsDTO | null
  persistNetworkSettings: (s: NetworkSettingsDTO) => Promise<void>
  discoverWallet: (walletId: string, wait?: boolean) => Promise<void>
}): Promise<void> {
  const { choice, walletId, networkSettings, persistNetworkSettings, discoverWallet } = opts
  if (choice === 'public' && networkSettings) {
    await persistNetworkSettings(withKaspaPublicHistory(networkSettings))
  }
  await discoverWallet(walletId)
}
