import { KASPA_PUBLIC_HISTORY_API } from '@renderer/utils/networkSettings'

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
          can see current balances and UTXOs, but not fully spent addresses. This choice is only for this
          wallet — Connections stays on None.
        </p>

        <div className="kaspa-import-history-options">
          <button type="button" className="kaspa-import-history-option" onClick={onChoosePublic}>
            <strong>Use public history</strong>
            <span className="muted">
              One lookup of <code>{KASPA_PUBLIC_HISTORY_API}</code> to find previously used addresses for this
              wallet. That service can see which addresses are looked up. Later syncs stay private on your
              node.
            </span>
          </button>
          <button type="button" className="kaspa-import-history-option" onClick={onChoosePrivate}>
            <strong>Keep private (None)</strong>
            <span className="muted">
              Do not contact a history service. Only current UTXOs and local SeedMask records are used. Old
              fully spent addresses may be missed until you enable Public or a private history API later.
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
  discoverWallet: (walletId: string, wait?: boolean, extra?: { historyOnce?: 'public' }) => Promise<void>
}): Promise<void> {
  const { choice, walletId, discoverWallet } = opts
  if (choice === 'public') {
    await discoverWallet(walletId, true, { historyOnce: 'public' })
    return
  }
  await discoverWallet(walletId)
}
