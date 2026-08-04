import type { ReactNode } from 'react'

export function InfoRow({
  title,
  value,
  fiat,
  note,
  tip,
}: {
  title: string
  value: ReactNode
  fiat?: ReactNode
  note?: ReactNode
  tip?: string
}): React.JSX.Element {
  return (
    <div className="info-row">
      <div className="info-row-title">
        <span>{title}</span>
        {tip && (
          <button type="button" className="info-tip-btn" title={tip} aria-label={tip}>
            i
          </button>
        )}
      </div>
      <div className="info-row-value">
        <div>{value}</div>
        {fiat && <div className="info-row-fiat muted">{fiat}</div>}
        {note && <div className="info-row-note muted">{note}</div>}
      </div>
    </div>
  )
}
