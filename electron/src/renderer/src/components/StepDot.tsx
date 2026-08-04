export function StepDot({
  index,
  current,
  title,
}: {
  index: number
  current: number
  title: string
}): React.JSX.Element {
  const done = index < current
  const active = index === current
  return (
    <div className={`step-dot${active ? ' active' : ''}${done ? ' done' : ''}`}>
      <span className="step-dot-circle" aria-hidden>
        {done ? '✓' : index + 1}
      </span>
      <span className="step-dot-title">{title}</span>
    </div>
  )
}
