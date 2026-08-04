import type { CoinChain } from '@renderer/api/types'
import { ConnectHardwareWalletRow } from './ConnectHardwareWalletSheet'
import {
  DeviceGuideHint,
  FingerprintField,
  InfoRow,
  KeystoreDetailPanel,
  KeystoreFieldRow,
  KeystoreTilesRow,
  KpubTextField,
  ExtendedKeyLabelRow,
  SegmentedControl,
  WalletMark,
} from './KeystoreUI'
import {
  BITCOIN_POLICY_OPTIONS,
  type BitcoinMultisigQuorum,
  type BitcoinPolicyType,
  type BitcoinScriptType,
  type MultisigCosignerDraft,
  QUORUM_PRESETS,
  kaspaScriptDisplayName,
  kaspaScriptForPolicy,
  kaspaScriptOptionsForPolicy,
  quorumDisplayLabel,
  scriptDisplayName,
  scriptOptionsForPolicy,
} from '@renderer/utils/bitcoinWallet'
import {
  alternateBitcoinExtendedPubkey,
  extractKey,
  importKeyValidationError,
} from '@renderer/utils/extendedKey'

export function MultisigQuorumCard({
  chain,
  quorum,
  useCustomQuorum,
  scriptType,
  onSelectPreset,
  onSelectCustom,
  onQuorumChange,
}: {
  chain: CoinChain
  quorum: BitcoinMultisigQuorum
  useCustomQuorum: boolean
  scriptType: BitcoinScriptType
  onSelectPreset: (q: BitcoinMultisigQuorum) => void
  onSelectCustom: () => void
  onQuorumChange: (q: BitcoinMultisigQuorum) => void
}): React.JSX.Element {
  const requiredRange = range(Math.min(Math.max(quorum.total, 1), 15), 1)
  const totalRange = range(15, Math.min(Math.max(quorum.required, 1), 15))

  return (
    <div className={`card policy-card${useCustomQuorum ? ' policy-card-custom' : ''}`}>
      <h3 className="policy-card-title">
        Policy
        <span className="muted policy-card-inline-hint"> — Choose how many signatures are required.</span>
      </h3>
      <div className="quorum-chips">
        {!useCustomQuorum &&
          QUORUM_PRESETS.map((preset) => {
            const selected = quorum.required === preset.required && quorum.total === preset.total
            return (
              <button
                key={`${preset.required}of${preset.total}`}
                type="button"
                className={`quorum-chip${selected ? ' selected' : ''}`}
                onClick={() => onSelectPreset(preset)}
              >
                {quorumDisplayLabel(preset)}
              </button>
            )
          })}
        <button
          type="button"
          className={`quorum-chip${useCustomQuorum ? ' selected quorum-chip-custom-open' : ''}`}
          title={useCustomQuorum ? 'Show presets' : undefined}
          aria-label={useCustomQuorum ? 'Show presets' : undefined}
          onClick={() => {
            if (useCustomQuorum) {
              onSelectPreset(QUORUM_PRESETS[0] ?? { required: 2, total: 3 })
            } else {
              onSelectCustom()
            }
          }}
        >
          {useCustomQuorum && (
            <span className="quorum-collapse-presets" aria-hidden>
              <svg className="quorum-collapse-icon" viewBox="0 0 14 8" width="14" height="8">
                <path
                  d="M1.5 6.25 L7 1.5 L12.5 6.25"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          )}
          Custom
        </button>
      </div>
      {useCustomQuorum && (
        <div className="custom-quorum-row">
          <span className="muted">Require</span>
          <QuorumSelect
            value={quorum.required}
            options={requiredRange}
            onChange={(required) => onQuorumChange({ ...quorum, required })}
          />
          <span className="muted">of</span>
          <QuorumSelect
            value={quorum.total}
            options={totalRange}
            onChange={(total) => onQuorumChange({ ...quorum, total })}
          />
          <span className="muted">signatures</span>
        </div>
      )}
      <p className="quorum-summary mono muted">
        {quorumDisplayLabel(quorum)} ·{' '}
        {chain === 'kaspa' ? kaspaScriptDisplayName('p2sh') : scriptDisplayName(scriptType)}
      </p>
    </div>
  )
}

function QuorumSelect({
  value,
  options,
  onChange,
}: {
  value: number
  options: number[]
  onChange: (n: number) => void
}): React.JSX.Element {
  return (
    <select className="quorum-select" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {options.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  )
}

function range(max: number, min: number): number[] {
  const out: number[] = []
  for (let i = min; i <= max; i++) out.push(i)
  return out.length ? out : [min]
}

export function SinglesigPolicyCard({
  chain,
  policyType,
  scriptType,
  derivation,
}: {
  chain: CoinChain
  policyType: BitcoinPolicyType
  scriptType: BitcoinScriptType
  derivation: string
}): React.JSX.Element {
  return (
    <div className="card policy-card">
      <h3 className="policy-card-title">Policy</h3>
      <p className="muted policy-card-sub">Watch-only key metadata for this wallet.</p>
      {chain === 'bitcoin' ? (
        <>
          <InfoRow title="Policy type" value={policyType === 'multisig' ? 'MultiSig' : 'SingleSig'} />
          <InfoRow title="Script type" value={scriptDisplayName(scriptType)} />
        </>
      ) : (
        <>
          <InfoRow title="Policy type" value={policyType === 'multisig' ? 'MultiSig' : 'SingleSig'} />
          <InfoRow
            title="Policy script"
            value={kaspaScriptDisplayName(kaspaScriptForPolicy(policyType))}
          />
        </>
      )}
      <InfoRow title="Derivation" value={derivation} mono />
    </div>
  )
}

export function MainWalletFormCard({
  chain,
  walletName,
  onWalletNameChange,
  policyType,
  onPolicyTypeChange,
  scriptType,
  onScriptTypeChange,
  errorMessage,
  busy,
}: {
  chain: CoinChain
  walletName: string
  onWalletNameChange: (v: string) => void
  policyType: BitcoinPolicyType
  onPolicyTypeChange: (v: BitcoinPolicyType) => void
  scriptType: BitcoinScriptType
  onScriptTypeChange: (v: BitcoinScriptType) => void
  errorMessage: string | null
  busy: boolean
}): React.JSX.Element {
  return (
    <div className="card main-wallet-form">
      {(chain === 'bitcoin' || chain === 'kaspa') && (
        <>
          <SegmentedControl
            label="Policy type"
            value={policyType}
            options={BITCOIN_POLICY_OPTIONS}
            onChange={onPolicyTypeChange}
          />
        </>
      )}
      {chain === 'bitcoin' && (
        <>
          <SegmentedControl
            label="Script type"
            value={scriptType}
            options={scriptOptionsForPolicy(policyType)}
            onChange={onScriptTypeChange}
          />
        </>
      )}
      {chain === 'kaspa' && (
        <SegmentedControl
          label="Policy script"
          value={kaspaScriptForPolicy(policyType)}
          options={kaspaScriptOptionsForPolicy(policyType)}
          onChange={() => {
            /* Only one script option per Kaspa policy for now */
          }}
        />
      )}
      <div className="row wallet-name-row">
        <WalletMark label={walletName || '?'} size={28} />
        <input
          className="field-input"
          value={walletName}
          placeholder="Wallet name"
          onChange={(e) => onWalletNameChange(e.target.value)}
        />
      </div>
      {errorMessage && <p className="form-error">{errorMessage}</p>}
      {busy && (
        <div className="row muted">
          <span className="spinner" aria-hidden />
          <span>Syncing mainnet…</span>
        </div>
      )}
    </div>
  )
}

export function SinglesigKeystoreSection({
  chain,
  keystore,
  onKeystoreChange,
  displayedDerivation,
  scriptType,
  onScan,
  onConnectHardware,
  hardware,
}: {
  chain: CoinChain
  keystore: MultisigCosignerDraft
  onKeystoreChange: (k: MultisigCosignerDraft) => void
  displayedDerivation: string
  scriptType?: BitcoinScriptType
  onScan: () => void
  onConnectHardware: () => void
  /** Hardware signer for this keystore — logo for ledger / onekey / seedmask. */
  hardware?: string | null
}): React.JSX.Element {
  const derivation = keystore.derivation.trim() || displayedDerivation
  const alt =
    chain === 'bitcoin'
      ? alternateBitcoinExtendedPubkey(keystore.xpub, scriptType, derivation)
      : null
  const filled =
    importKeyValidationError(chain, extractKey(keystore.xpub)) == null && !!keystore.xpub.trim()

  return (
    <div className="card keystore-section">
      <div className="keystore-section-header">
        <div className="keystore-section-header-top">
          <div>
            <h3>Keystores</h3>
            <p className="muted">
              {chain === 'bitcoin'
                ? 'Select the keystore and add its watch-only xpub.'
                : 'Select the keystore and add its watch-only kpub.'}
            </p>
          </div>
          <ConnectHardwareWalletRow compact onClick={onConnectHardware} />
        </div>
      </div>
      <KeystoreTilesRow
        labels={[keystore.label || 'Keystore']}
        fingerprints={[keystore.fingerprint]}
        filled={[filled]}
        selectedIndex={0}
        onSelect={() => {}}
        hardwareKinds={[hardware]}
      />
      <KeystoreDetailPanel>
        <p className="keystore-detail-title">{keystore.label || 'Keystore'}</p>
        <KeystoreFieldRow
          title="Label"
          value={keystore.label}
          prominent
          onChange={(label) => onKeystoreChange({ ...keystore, label })}
        />
        <FingerprintField
          title="Fingerprint"
          value={keystore.fingerprint}
          placeholder="00000000"
          onChange={(fingerprint) => onKeystoreChange({ ...keystore, fingerprint })}
        />
        <KeystoreFieldRow
          title="Derivation"
          value={derivation}
          mono
          prominent
          fieldSize="derivation"
          onChange={(nextDerivation) => onKeystoreChange({ ...keystore, derivation: nextDerivation })}
        />
        <label className="keystore-field prominent">
          <ExtendedKeyLabelRow
            coin={chain}
            keyValue={keystore.xpub}
            scriptType={scriptType}
            derivation={derivation}
            onToggle={() => {
              if (!alt) return
              onKeystoreChange({ ...keystore, xpub: alt.key })
            }}
            fallbackLabel={chain === 'bitcoin' ? 'Xpub' : 'Kpub'}
          />
          <KpubTextField
            value={keystore.xpub}
            placeholder={chain === 'bitcoin' ? 'xpub6… / zpub6…' : 'kpub6…'}
            onScan={onScan}
            onChange={(xpub) => onKeystoreChange({ ...keystore, xpub })}
          />
        </label>
      </KeystoreDetailPanel>
    </div>
  )
}

export function MultisigCosignersSection({
  chain,
  cosigners,
  selectedIndex,
  onSelectIndex,
  onCosignerChange,
  defaultDerivation,
  scriptType,
  onScanCosigner,
  onConnectHardware,
}: {
  chain: CoinChain
  cosigners: MultisigCosignerDraft[]
  selectedIndex: number
  onSelectIndex: (i: number) => void
  onCosignerChange: (index: number, c: MultisigCosignerDraft) => void
  defaultDerivation: string
  scriptType?: BitcoinScriptType
  onScanCosigner: (index: number) => void
  onConnectHardware: () => void
}): React.JSX.Element {
  const selected = cosigners[selectedIndex]
  const derivation = selected ? selected.derivation.trim() || defaultDerivation : defaultDerivation
  const alt =
    chain === 'bitcoin' && selected
      ? alternateBitcoinExtendedPubkey(selected.xpub, scriptType, derivation)
      : null

  return (
    <div className="card keystore-section">
      <div className="keystore-section-header">
        <div className="keystore-section-header-top">
          <div>
            <h3>Keystores</h3>
            <p className="muted">
              Select a keystore to add its cosigner {chain === 'kaspa' ? 'kpub' : 'xpub'}.
            </p>
          </div>
          <ConnectHardwareWalletRow compact onClick={onConnectHardware} />
        </div>
      </div>
      <KeystoreTilesRow
        labels={cosigners.map((c, i) => c.label || `Cosigner ${i + 1}`)}
        fingerprints={cosigners.map((c) => c.fingerprint)}
        filled={cosigners.map((c) => importKeyValidationError(chain, extractKey(c.xpub)) == null && !!c.xpub.trim())}
        selectedIndex={selectedIndex}
        onSelect={onSelectIndex}
      />
      {selected && (
        <KeystoreDetailPanel>
          <p className="keystore-detail-title">{selected.label || `Keystore ${selectedIndex + 1}`}</p>
          <KeystoreFieldRow
            title="Label"
            value={selected.label}
            prominent
            onChange={(label) => onCosignerChange(selectedIndex, { ...selected, label })}
          />
          <FingerprintField
            title="Fingerprint"
            value={selected.fingerprint}
            placeholder="00000000"
            onChange={(fingerprint) => onCosignerChange(selectedIndex, { ...selected, fingerprint })}
          />
          <KeystoreFieldRow
            title="Derivation"
            value={derivation}
            mono
            prominent
            fieldSize="derivation"
            onChange={(nextDerivation) =>
              onCosignerChange(selectedIndex, { ...selected, derivation: nextDerivation })
            }
          />
          <label className="keystore-field prominent">
            <ExtendedKeyLabelRow
              coin={chain}
              keyValue={selected.xpub}
              scriptType={scriptType}
              derivation={derivation}
              onToggle={() => {
                if (!alt) return
                onCosignerChange(selectedIndex, { ...selected, xpub: alt.key })
              }}
              fallbackLabel={chain === 'kaspa' ? 'Kpub' : 'Xpub'}
            />
            <KpubTextField
              value={selected.xpub}
              placeholder={chain === 'kaspa' ? 'kpub6…' : 'xpub6… / zpub6…'}
              onScan={() => onScanCosigner(selectedIndex)}
              onChange={(xpub) => onCosignerChange(selectedIndex, { ...selected, xpub })}
            />
          </label>
        </KeystoreDetailPanel>
      )}
    </div>
  )
}

export function AddWalletTopLayout({
  chain,
  showDeviceGuide,
  mainForm,
  sideCard,
}: {
  chain: CoinChain
  showDeviceGuide: boolean
  mainForm: React.ReactNode
  sideCard: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="add-wallet-top-row">
      <div className="add-wallet-main-col">
        {showDeviceGuide && <DeviceGuideHint chain={chain} />}
        {mainForm}
      </div>
      <div className="add-wallet-side-col">{sideCard}</div>
    </div>
  )
}

export { DeviceGuideHint }
