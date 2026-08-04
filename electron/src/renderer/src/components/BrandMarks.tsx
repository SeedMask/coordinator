import type { AppTheme, CoinChain } from '@renderer/api/types'

const BRANDING = {
  seedmask: './branding/seedmask-logo-square.png',
  kaspa: './branding/kaspa-kas-logo.png',
  bitcoin: './branding/bitcoin-btc-logo.png',
  keyHorizontalMedium: './branding/key-horizontal-fill-medium.png',
  keyHorizontalSemibold: './branding/key-horizontal-fill-semibold.png',
  ledger: './branding/ledger.png',
  onekey: './branding/onekey.png',
} as const

const CHAIN_ACCENT: Record<CoinChain, string> = {
  kaspa: 'var(--kaspa-accent)',
  bitcoin: 'var(--btc-accent)',
}

/** Square SeedMask app mark (same footprint as Ledger / OneKey). */
export function SeedMaskLogoMark({
  height = 36,
  size,
  className,
}: {
  height?: number
  size?: number
  className?: string
}): React.JSX.Element {
  const box = size ?? height
  return (
    <img
      src={BRANDING.seedmask}
      alt="SeedMask"
      width={box}
      height={box}
      className={`seedmask-logo-mark hw-brand-logo${className ? ` ${className}` : ''}`}
      style={{ width: box, height: box, objectFit: 'contain' }}
      draggable={false}
    />
  )
}

/** Matches Swift `ChainBrandLogo` — organic Kaspa ring, circular Bitcoin ring. */
export function ChainLogoMark({
  chain,
  size = 38,
  selected = false,
}: {
  chain: CoinChain
  size?: number
  selected?: boolean
}): React.JSX.Element {
  const src = chain === 'kaspa' ? BRANDING.kaspa : BRANDING.bitcoin
  const accent = CHAIN_ACCENT[chain]
  const ringScale = 1.06
  const ringWidth = 2
  const contentSize = selected ? size * 0.92 : size
  const canvasSize = selected ? size * ringScale + ringWidth : size
  const ringDiameter = size * ringScale
  const outerSize = ringDiameter + ringWidth
  const innerSize = ringDiameter - ringWidth

  return (
    <span
      className={`chain-logo-canvas${chain === 'bitcoin' ? ' circle' : ''}${selected ? ' selected' : ''}`}
      data-chain={chain}
      style={{ width: canvasSize, height: canvasSize, ['--chain-accent' as string]: accent }}
    >
      {selected && chain === 'bitcoin' && (
        <span
          className="chain-circle-ring"
          style={{ width: ringDiameter, height: ringDiameter, borderColor: accent }}
          aria-hidden
        />
      )}
      {selected && chain === 'kaspa' && (
        <span className="chain-organic-ring" aria-hidden>
          <span
            className="chain-organic-ring-outer"
            style={{
              width: outerSize,
              height: outerSize,
              background: accent,
              WebkitMaskImage: `url(${src})`,
              maskImage: `url(${src})`,
            }}
          />
          <span
            className="chain-organic-ring-inner"
            style={{
              width: innerSize,
              height: innerSize,
              WebkitMaskImage: `url(${src})`,
              maskImage: `url(${src})`,
            }}
          />
        </span>
      )}
      <img
        src={src}
        alt={chain === 'kaspa' ? 'Kaspa' : 'Bitcoin'}
        className={`chain-logo-image${chain === 'bitcoin' ? ' circle' : ''}`}
        style={{ width: contentSize, height: contentSize }}
        draggable={false}
      />
    </span>
  )
}

export function WalletMark({
  label,
  size = 26,
  draft = false,
  fixedLetter,
}: {
  label: string
  size?: number
  draft?: boolean
  fixedLetter?: string
}): React.JSX.Element {
  const trimmed = label.trim()
  let text = fixedLetter ?? (trimmed ? trimmed[0]?.toUpperCase() : '?')
  if (draft && !trimmed) text = '+'

  const fontSize = text.length <= 1 ? size * 0.42 : size * 0.3
  const radius = size * 0.28

  return (
    <span
      className={`wallet-mark${draft ? ' draft' : ''}`}
      style={{ width: size, height: size, fontSize, borderRadius: radius }}
    >
      {text}
    </span>
  )
}

/** Rendered from macOS SF Symbol `key.horizontal.fill` (mask + accent color). */
function KeySymbolMask({
  variant,
  width,
  height,
  rotate,
  className,
  style,
}: {
  variant: 'medium' | 'semibold'
  width: number
  height: number
  rotate?: number
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element {
  const mask =
    variant === 'semibold' ? BRANDING.keyHorizontalSemibold : BRANDING.keyHorizontalMedium
  return (
    <span
      className={`sf-key-mask${className ? ` ${className}` : ''}`}
      style={{
        width,
        height,
        WebkitMaskImage: `url(${mask})`,
        maskImage: `url(${mask})`,
        transform: rotate ? `rotate(${rotate}deg)` : undefined,
        ...style,
      }}
      aria-hidden
    />
  )
}

/** Horizontal key for keystore tiles (Swift `key.horizontal.fill` at 20pt medium). */
export function HorizontalKeyIcon({
  size = 20,
  className,
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <KeySymbolMask
      variant="medium"
      width={size * 1.5}
      height={size * 0.8}
      className={className}
    />
  )
}

/** Official Ledger Live app icon. */
export function LedgerMark({
  size = 22,
  className,
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <img
      src={BRANDING.ledger}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className={`hw-brand-logo${className ? ` ${className}` : ''}`}
      aria-hidden
    />
  )
}

/** Official OneKey app mark. */
export function OneKeyMark({
  size = 22,
  className,
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <img
      src={BRANDING.onekey}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className={`hw-brand-logo${className ? ` ${className}` : ''}`}
      aria-hidden
    />
  )
}

/** Same key as keystore tiles (`HorizontalKeyIcon` size 20), rotated for wallet strip. */
function RotatedKeystoreStripKey(): React.JSX.Element {
  return (
    <span className="wallet-strip-key-rotated" aria-hidden>
      <HorizontalKeyIcon size={24} />
    </span>
  )
}

export function WalletKeystoreGlyph({
  keyCount = 1,
  iconSize = 18,
}: {
  keyCount?: number
  iconSize?: number
}): React.JSX.Element {
  const count = Math.min(Math.max(keyCount, 1), 2)
  const keyWidth = iconSize * 0.46
  const pairGap = 5
  const pairStep = keyWidth + pairGap
  const width = count > 1 ? pairStep + keyWidth : keyWidth

  return (
    <span
      className={`wallet-keystore-glyph${count > 1 ? ' multisig' : ''}`}
      style={{ width, height: iconSize, paddingRight: count > 1 ? 6 : 0 }}
      aria-hidden
    >
      <span className="wallet-keystore-glyph-key" style={{ width: keyWidth, height: iconSize }}>
        <RotatedKeystoreStripKey />
      </span>
      {count > 1 && (
        <span
          className="wallet-keystore-glyph-key paired"
          style={{ width: keyWidth, height: iconSize, left: pairStep }}
        >
          <RotatedKeystoreStripKey />
        </span>
      )}
    </span>
  )
}

/** Swift `key.horizontal.fill` rotated 90° — vertical key beside wallet names. */
export function VerticalKeyIcon({
  size,
  style,
  className,
}: {
  size: number
  style?: React.CSSProperties
  className?: string
}): React.JSX.Element {
  const keyWidth = size * 0.46
  return (
    <span
      className={`wallet-keystore-glyph-key${className ? ` ${className}` : ''}`}
      style={{ width: keyWidth, height: size, ...style }}
    >
      <RotatedKeystoreStripKey />
    </span>
  )
}

const THEME_ICONS: Record<AppTheme, React.JSX.Element> = {
  light: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 17.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11Zm0-14.5h1.75V1H12v2Zm0 18h1.75V23H12v-2ZM3.72 5.72l1.24-1.24 1.24 1.24-1.24 1.24-1.24-1.24Zm14.8 14.8 1.24-1.24 1.24 1.24-1.24 1.24-1.24-1.24ZM1 11.25h2v1.5H1v-1.5Zm20 0h2v1.5h-2v-1.5ZM3.72 18.28l1.24 1.24-1.24 1.24-1.24-1.24 1.24-1.24Zm14.8-14.8 1.24 1.24-1.24 1.24-1.24-1.24 1.24-1.24Z" />
    </svg>
  ),
  dark: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  ),
  dim: (
    <svg width="36" height="24" viewBox="0 0 36 24" fill="currentColor" aria-hidden>
      <path d="M10 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
      <path d="M20.5 3.75 21.1 5.55 22.9 6.15 21.1 6.75 20.5 8.55 19.9 6.75 18.1 6.15 19.9 5.55 20.5 3.75Z" />
      <path d="M27.5 9.75 28.15 11.7 30.1 12.35 28.15 13 27.5 14.95 26.85 13 24.9 12.35 26.85 11.7 27.5 9.75Z" />
      <path d="M22 15.75 22.55 17.35 24.15 17.9 22.55 18.45 22 20.05 21.45 18.45 19.85 17.9 21.45 17.35 22 15.75Z" />
    </svg>
  ),
}

export function ThemeIcon({ theme }: { theme: AppTheme }): React.JSX.Element {
  return <span className={`theme-icon${theme === 'dim' ? ' dim' : ''}`}>{THEME_ICONS[theme]}</span>
}
