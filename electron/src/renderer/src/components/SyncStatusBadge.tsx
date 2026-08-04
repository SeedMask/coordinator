import type { WalletSyncStatus } from '@renderer/api/types'

const LABELS: Record<WalletSyncStatus, string> = {
  cached: 'Cached',
  syncing: 'Syncing…',
  live: 'Live',
  incomplete: 'Incomplete scan',
}

export function SyncStatusBadge({ status }: { status: WalletSyncStatus | null }): React.JSX.Element | null {
  if (!status) return null
  return (
    <span className={`sync-status-badge sync-status-${status}`} title={`Wallet data: ${LABELS[status]}`}>
      {LABELS[status]}
    </span>
  )
}
