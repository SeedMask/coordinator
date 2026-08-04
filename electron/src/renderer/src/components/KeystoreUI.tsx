import { useState } from 'react'
import {
  HorizontalKeyIcon,
  LedgerMark,
  OneKeyMark,
  SeedMaskLogoMark,
  WalletMark,
} from '@renderer/components/BrandMarks'
import { QRViewfinderIcon } from '@renderer/components/icons'
import { sanitizeFingerprint } from '@renderer/utils/bitcoinWallet'
import type { CoinChain } from '@renderer/api/types'
import {
  alternateBitcoinExtendedPubkey,
  bitcoinExtendedPubPrefix,
} from '@renderer/utils/extendedKey'

export { WalletMark }

export type KeystoreHardwareKind = 'ledger' | 'onekey' | 'seedmask' | '' | null | undefined

function normalizeHardwareKind(hardware: string | null | undefined): 'ledger' | 'onekey' | 'seedmask' | '' {
  const kind = (hardware || '').trim().toLowerCase()
  if (kind === 'ledger' || kind === 'onekey' || kind === 'seedmask') return kind
  return ''
}

function KeystoreTileIcon({ hardware }: { hardware: KeystoreHardwareKind }): React.JSX.Element {
  const kind = normalizeHardwareKind(hardware)
  if (kind === 'ledger') return <LedgerMark size={40} />
  if (kind === 'onekey') return <OneKeyMark size={40} />
  // Same 40×40 box as Ledger/OneKey (.hw-brand-logo); logo has transparent padding so it needs the full tile.
  if (kind === 'seedmask') return <SeedMaskLogoMark size={40} className="hw-brand-logo" />
  return <HorizontalKeyIcon size={20} />
}

export function KeystoreFieldRow({
  title,
  value,
  onChange,
  mono = false,
  placeholder = '',
  prominent = false,
  readOnly = false,
  uppercase = false,
  fieldSize,
  maxLength,
}: {
  title: string
  value: string
  onChange: (v: string) => void
  mono?: boolean
  placeholder?: string
  prominent?: boolean
  readOnly?: boolean
  uppercase?: boolean
  fieldSize?: 'fingerprint' | 'derivation'
  maxLength?: number
}): React.JSX.Element {
  const sizeClass =
    fieldSize === 'fingerprint'
      ? ' keystore-field--fingerprint'
      : fieldSize === 'derivation'
        ? ' keystore-field--derivation'
        : ''
  return (
    <label className={`keystore-field${prominent ? ' prominent' : ''}${sizeClass}`}>
      <span className="keystore-field-label">{title}</span>
      <input
        className={`field-input${mono ? ' mono' : ''}`}
        value={value}
        placeholder={placeholder || title}
        readOnly={readOnly}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        style={uppercase ? { textTransform: 'uppercase' } : undefined}
      />
    </label>
  )
}

export function KeystoreTilesRow({
  labels,
  fingerprints,
  filled,
  selectedIndex,
  onSelect,
  hardwareKinds,
}: {
  labels: string[]
  fingerprints: string[]
  filled: boolean[]
  selectedIndex: number
  onSelect: (index: number) => void
  /** Per-tile hardware signer; ledger / onekey / seedmask swap the key icon. */
  hardwareKinds?: Array<string | null | undefined>
}): React.JSX.Element {
  return (
    <div className="keystore-tiles-scroll">
      <div className="keystore-tiles-row">
        {labels.map((label, index) => (
          <KeystoreTile
            key={index}
            label={label}
            fingerprint={fingerprints[index] ?? ''}
            isFilled={filled[index] ?? false}
            isSelected={selectedIndex === index}
            hardware={hardwareKinds?.[index]}
            onSelect={() => onSelect(index)}
          />
        ))}
      </div>
    </div>
  )
}

function KeystoreTile({
  label,
  fingerprint,
  isFilled,
  isSelected,
  hardware,
  onSelect,
}: {
  label: string
  fingerprint: string
  isFilled: boolean
  isSelected: boolean
  hardware?: string | null
  onSelect: () => void
}): React.JSX.Element {
  const displayLabel = label.trim() || 'Keystore'
  const fp = fingerprint.toUpperCase().replace(/[^0-9A-F]/g, '')
  const fpSnippet = fp.length > 0 ? fp : isFilled ? '········' : 'Empty'
  const hw = normalizeHardwareKind(hardware)
  const hwClass = hw ? ` hw-${hw}` : ''

  return (
    <button type="button" className={`keystore-tile${isSelected ? ' selected' : ''}`} onClick={onSelect}>
      <div className="keystore-tile-icon-wrap">
        <div className={`keystore-tile-icon${isFilled ? ' filled' : ''}${hwClass}`} aria-hidden>
          <KeystoreTileIcon hardware={hw} />
        </div>
      </div>
      <span className="keystore-tile-label">{displayLabel}</span>
      <span className="keystore-tile-fp">{fpSnippet}</span>
    </button>
  )
}

export function KeystoreDetailPanel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="keystore-detail-panel">{children}</div>
}

export function KpubTextField({
  value,
  onChange,
  placeholder,
  onScan,
  height = 44,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  onScan?: () => void
  height?: number
}): React.JSX.Element {
  const [scanHovered, setScanHovered] = useState(false)

  return (
    <div className="kpub-field" style={{ minHeight: height }}>
      <textarea
        className="kpub-field-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
      />
      {onScan && (
        <div className="kpub-field-scan">
          {scanHovered && <span className="kpub-scan-tooltip">Scan QR</span>}
          <button
            type="button"
            className="kpub-scan-btn"
            aria-label="Scan QR"
            onMouseEnter={() => setScanHovered(true)}
            onMouseLeave={() => setScanHovered(false)}
            onClick={onScan}
          >
            <QRViewfinderIcon size={18} />
          </button>
        </div>
      )}
    </div>
  )
}

export function FingerprintField({
  title,
  value,
  onChange,
  placeholder,
}: {
  title: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}): React.JSX.Element {
  return (
    <KeystoreFieldRow
      title={title}
      value={value}
      placeholder={placeholder}
      mono
      uppercase
      prominent
      fieldSize="fingerprint"
      maxLength={8}
      onChange={(v) => onChange(sanitizeFingerprint(v))}
    />
  )
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string; detail?: string }[]
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="segmented-field">
      <span className="field-label">{label}</span>
      <div className="segmented-control" role="group" aria-label={label}>
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`segmented-option${value === opt.value ? ' selected' : ''}${opt.detail ? ' with-detail' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            <span className="segmented-option-label">{opt.label}</span>
            {opt.detail && <span className="segmented-option-detail">{opt.detail}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

export function InfoRow({
  title,
  value,
  mono = false,
}: {
  title: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="keystore-info-row">
      <span className="keystore-info-row-title">{title}</span>
      <span className={`keystore-info-row-value${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  )
}

export function DeviceGuideHint({ chain }: { chain: 'bitcoin' | 'kaspa' }): React.JSX.Element {
  return (
    <div className="device-guide-hint">
      <p className="device-guide-primary">
        {chain === 'bitcoin'
          ? 'On SeedMask: Crypto → Bitcoin → Export xpub'
          : 'On SeedMask: Crypto → Kaspa → Export kpub'}
      </p>
      <p className="device-guide-danger">Never paste a seed or private key.</p>
    </div>
  )
}

export function ExtendedKeyLabelRow({
  coin,
  keyValue,
  scriptType,
  derivation,
  showAlternate,
  onToggle,
  fallbackLabel,
}: {
  coin: CoinChain
  keyValue: string
  scriptType?: string | null
  derivation?: string | null
  showAlternate?: boolean
  onToggle: () => void
  fallbackLabel?: string
}): React.JSX.Element {
  const alt = coin === 'bitcoin' ? alternateBitcoinExtendedPubkey(keyValue, scriptType, derivation) : null
  const currentPrefix = bitcoinExtendedPubPrefix(keyValue)
  const label =
    showAlternate && alt
      ? alt.label
      : currentPrefix
        ? currentPrefix.toUpperCase()
        : fallbackLabel ?? (coin === 'kaspa' ? 'Kpub' : 'Xpub')

  return (
    <span className="keystore-field-label-row">
      <span className="keystore-field-label">{label}</span>
      {alt && (
        <button
          type="button"
          className={`xpub-format-toggle${showAlternate ? ' active' : ''}`}
          title={`Show as ${alt.label}`}
          aria-label={`Toggle ${alt.label}`}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onToggle()
          }}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
            <path
              fill="currentColor"
              d="M7.5 6.5h7.2l-1.1-1.1 1.1-1.1 3 3-3 3-1.1-1.1 1.1-1.1H7.5a3.5 3.5 0 0 0 0 7h2v1.6h-2a5.1 5.1 0 1 1 0-10.2Zm9 4.4h-2v1.6h2a3.5 3.5 0 1 1 0 7h-7.2l1.1 1.1-1.1 1.1-3-3 3-3 1.1 1.1-1.1 1.1H16.5a5.1 5.1 0 1 0 0-10.2Z"
            />
          </svg>
        </button>
      )}
    </span>
  )
}
