import type { SidebarSection } from '@renderer/api/types'
import { HorizontalKeyIcon, VerticalKeyIcon } from '@renderer/components/BrandMarks'

type IconProps = { size?: number; className?: string }

export function NavIcon({ section, size = 17 }: { section: SidebarSection; size?: number }): React.JSX.Element {
  const icons: Record<SidebarSection, React.JSX.Element> = {
    dashboard: <HouseIcon size={size} />,
    addresses: <ListIcon size={size} />,
    coins: <GridIcon size={size} />,
    walletSettings: <WalletIcon size={size} />,
    systemSettings: <GearIcon size={size} />,
  }
  return <span className="nav-icon" aria-hidden>{icons[section]}</span>
}

export function SettingsNavIcon({ pane, size = 15 }: { pane: 'general' | 'connections'; size?: number }): React.JSX.Element {
  return (
    <span className="nav-icon" aria-hidden>
      {pane === 'general' ? <SliderIcon size={size} /> : <NetworkIcon size={size} />}
    </span>
  )
}

export function HouseIcon({ size = 15, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 3 3 10.5V21h6v-6h6v6h6V10.5L12 3Z" />
    </svg>
  )
}

export function ListIcon({ size = 15, className }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="5" y="3" width="16" height="18" rx="2.5" />
      <path d="M5 7H3M5 12H3M5 17H3" />
      <circle cx="11" cy="9" r="2.2" />
      <path d="M7.8 16c.6-2 1.7-3 3.2-3s2.6 1 3.2 3M16.5 8H19M16.5 12H19M16.5 16H19" />
    </svg>
  )
}

export function GridIcon({ size = 15, className }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v4c0 1.65 3.36 3 7.5 3s7.5-1.35 7.5-3V6" />
      <path d="M4.5 10v4c0 1.65 3.36 3 7.5 3s7.5-1.35 7.5-3v-4" />
      <path d="M4.5 14v4c0 1.65 3.36 3 7.5 3s7.5-1.35 7.5-3v-4" />
    </svg>
  )
}

export function WalletIcon({ size = 15, className }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M4.5 6.5h14A2.5 2.5 0 0 1 21 9v9a2 2 0 0 1-2 2H4.5A2.5 2.5 0 0 1 2 17.5V7.75A3.75 3.75 0 0 1 5.75 4H18v2.5" />
      <path d="M16 10h5v5h-5a2.5 2.5 0 0 1 0-5Z" />
      <circle cx="16.5" cy="12.5" r=".7" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function GearIcon({ size = 15, className }: IconProps): React.JSX.Element {
  const gearPath =
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <g transform="translate(0 0) scale(.68)">
        <path d={gearPath} />
        <circle cx="12" cy="12" r="3" />
      </g>
      <g transform="translate(10.5 10.5) scale(.5)">
        <path d={gearPath} fill="var(--sidebar)" />
        <circle cx="12" cy="12" r="3" fill="var(--sidebar)" />
      </g>
    </svg>
  )
}

export function SliderIcon({ size = 15, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M4 7.25h16v1.5H4v-1.5Zm2.5 4.25h11v1.5h-11v-1.5Zm3 4.25h5v1.5h-5v-1.5Z" />
      <circle cx="8" cy="8" r="1.6" />
      <circle cx="16" cy="12.5" r="1.6" />
      <circle cx="11" cy="16.75" r="1.6" />
    </svg>
  )
}

export function NetworkIcon({ size = 15, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className} aria-hidden>
      <circle cx="6.5" cy="17.5" r="2.1" />
      <circle cx="17.5" cy="17.5" r="2.1" />
      <circle cx="12" cy="6.5" r="2.1" />
      <path d="M8.2 15.8 10.6 8.8M15.8 15.8 13.4 8.8M8.6 17.5h7.8" strokeLinecap="round" strokeDasharray="2.2 2.2" />
    </svg>
  )
}

export function ArrowUpRightIcon({ size = 17, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={className} aria-hidden>
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  )
}

export function ArrowDownLeftIcon({ size = 17, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={className} aria-hidden>
      <path d="M17 7 7 17M7 9v8h8" />
    </svg>
  )
}

export function RefreshIcon({ size = 18, className, spinning }: IconProps & { spinning?: boolean }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={`${className ?? ''}${spinning ? ' icon-spinning' : ''}`}
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}

export function ChevronLeftIcon({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={className} aria-hidden>
      <path d="M15 6 9 12l6 6" />
    </svg>
  )
}

export function EyeSlashIcon({ size = 56, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 5c-4.2 0-7.8 2.4-9.6 6 1.8 3.6 5.4 6 9.6 6s7.8-2.4 9.6-6c-1.8-3.6-5.4-6-9.6-6Zm0 10a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm-6.8-4c1.4 2.2 3.8 3.6 6.8 3.6s5.4-1.4 6.8-3.6C18.4 8.8 15.4 7 12 7S5.6 8.8 4.2 11ZM2 2l20 20-1.4 1.4L2 3.4 2 2Z" />
    </svg>
  )
}

export function CopyIcon({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M8 7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2V7Zm2 0v2H6v12h10v-2H10a2 2 0 0 1-2-2V7Zm2 2h8v10h-8V9Z" />
    </svg>
  )
}

export function ExternalLinkIcon({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden>
      <path d="M14 3h7v7M10 14 21 3M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6" />
    </svg>
  )
}

export function CheckCircleIcon({ size = 20, className, filled }: IconProps & { filled?: boolean }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      {filled && <path d="M8.5 12.5 11 15l4.5-5" stroke="#fff" strokeWidth="2" fill="none" />}
    </svg>
  )
}

export function CircleIcon({ size = 20, className, selected }: IconProps & { selected?: boolean }): React.JSX.Element {
  if (selected) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
        <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm-2 14.2 4.5-4.5-1.4-1.4-3.1 3.1-1.3-1.3-1.4 1.4 3.2 3.2Z" />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" />
    </svg>
  )
}

export function MinusCircleIcon({ size = 20, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2ZM8 11h8v2H8v-2Z" />
    </svg>
  )
}

export function QRViewfinderIcon({ size = 18, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden>
      <path d="M3 3h6v6H3V3Zm12 0h6v6h-6V3ZM3 15h6v6H3v-6Zm13 3h3v3h-3v-3ZM15 15h3v3h-3v-3Z" />
    </svg>
  )
}

export function ImportFileIcon({ size = 18, className }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M12 18v-6" />
      <path d="M9 15l3 3 3-3" />
    </svg>
  )
}

export function UsbIcon({ size = 18, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      {/* Filled USB trident: ● top, ■ left, ▲ right, ● base */}
      <rect x="11.05" y="6.4" width="1.9" height="12.2" rx="0.95" />
      <circle cx="12" cy="20.5" r="1.7" />
      <circle cx="12" cy="4.35" r="2.2" />
      <rect x="5.35" y="9.55" width="6.7" height="1.9" rx="0.95" />
      <rect x="4.1" y="6.25" width="4.1" height="4.1" rx="0.4" />
      <rect x="12" y="14.5" width="5.45" height="1.9" rx="0.95" />
      <rect x="17.45" y="10.35" width="1.9" height="5.5" rx="0.95" />
      <path d="M16.05 10.35 18.4 5.85 20.75 10.35Z" />
    </svg>
  )
}

export function BluetoothIcon({ size = 18, className }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M7 7 17 17l-5 4V3l5 4L7 17" />
    </svg>
  )
}

export function KeyIcon({ size = 18, className, vertical }: IconProps & { vertical?: boolean }): React.JSX.Element {
  if (vertical) return <VerticalKeyIcon size={size} className={className} />
  return <HorizontalKeyIcon size={size} className={className} />
}

export function LockIcon({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

export function ConnectionModeIcon({
  mode,
  size = 24,
  className,
}: IconProps & { mode: 'globe' | 'desktop' | 'lock-shield' }): React.JSX.Element {
  if (mode === 'globe') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
        <path
          d="M3 12h18M12 3c2.8 3.2 2.8 14.8 0 18M12 3c-2.8 3.2-2.8 14.8 0 18"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (mode === 'desktop') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
        <path d="M4 4.5h16A1.5 1.5 0 0 1 21.5 6v9A1.5 1.5 0 0 1 20 16.5H14v2.25h2.25V20H7.75v-1.25H10V16.5H4A1.5 1.5 0 0 1 2.5 15V6A1.5 1.5 0 0 1 4 4.5Zm0 1.5v9h16V6H4Z" />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4Zm0 3.18L19 7.3V11c0 4.52-3.04 8.79-7 9.93C8.04 19.79 5 15.52 5 11V7.3l7-3.12ZM11 11h2v5h-2v-5Zm0-3h2v2h-2V8Z" />
    </svg>
  )
}

export function CheckmarkIcon({ size = 18, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M20 6 9 17l-5-5"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function InfoTipIcon({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
      <path d="M12 10v6M12 7.5v.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  )
}

export function CalloutIcon({
  name,
  size = 18,
  className,
}: IconProps & { name: 'eye' | 'info' | 'warning' | 'shield' }): React.JSX.Element {
  if (name === 'shield') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
        <path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4Zm0 3.18 7 3.12V11c0 4.52-3.04 8.79-7 9.93-3.96-1.14-7-5.41-7-9.93V7.3l7-3.12Z" />
      </svg>
    )
  }
  if (name === 'eye') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
        <path d="M12 5C7 5 2.73 8.11 1 12c1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7Zm0 11.5A4.5 4.5 0 1 1 16.5 12 4.5 4.5 0 0 1 12 16.5Z" />
      </svg>
    )
  }
  if (name === 'warning') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
        <path d="M1 21h22L12 2 1 21Zm12-3h-2v-2h2v2Zm0-4h-2v-4h2v4Z" />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 2a10 10 0 0 0-3.16 19.49l.84-1.53A8 8 0 1 1 12 20V2Zm-1 9h2v7h-2v-7Zm0-4h2v2h-2V7Z" />
    </svg>
  )
}

export function LoadingSpinner({ size = 32, className }: IconProps): React.JSX.Element {
  return (
    <span
      className={`loading-spinner${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  )
}
