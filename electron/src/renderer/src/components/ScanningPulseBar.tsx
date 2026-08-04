export function ScanningPulseBar(): React.JSX.Element {
  return (
    <div className="scanning-pulse-bar" aria-hidden>
      <span className="scanning-pulse-bar-track" />
      <span className="scanning-pulse-bar-glow" />
    </div>
  )
}
