import { ScanningPulseBar } from '@renderer/components/ScanningPulseBar'

export function ScanActivityBanner({
  title,
  detail,
  compact = false,
}: {
  title: string
  detail?: string | null
  compact?: boolean
}): React.JSX.Element {
  return (
    <div className={`scan-activity-banner${compact ? ' compact' : ''}`}>
      <div className="scan-activity-banner-row">
        <span className="scan-activity-spinner" aria-hidden />
        <div className="scan-activity-copy">
          <strong>{title}</strong>
          {detail && <span className="scan-activity-detail">{detail}</span>}
        </div>
      </div>
      <ScanningPulseBar />
    </div>
  )
}
