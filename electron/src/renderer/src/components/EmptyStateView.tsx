import type { ReactNode } from 'react'

export function EmptyStateView({
  icon,
  title,
  message,
  action,
}: {
  icon: ReactNode
  title: string
  message: string
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="empty-state-view">
      <div className="empty-state-icon">{icon}</div>
      <h3>{title}</h3>
      <p className="muted">{message}</p>
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  )
}
