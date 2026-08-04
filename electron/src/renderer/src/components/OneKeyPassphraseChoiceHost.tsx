import { useEffect, useState } from 'react'
import { OneKeyMark } from '@renderer/components/BrandMarks'

type PassphraseChoice = 'standard' | 'temporary' | 'hidden-pin'

/**
 * Shown when passphrase is enabled on the device.
 * Standard = no device passphrase keyboard.
 * Temporary / Hidden PIN = one device prompt after this choice.
 */
export function OneKeyPassphraseChoiceHost(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [allowHiddenPin, setAllowHiddenPin] = useState(true)

  useEffect(() => {
    const stop = window.seedmask?.onOneKeyPassphraseChoiceNeeded?.((info) => {
      setAllowHiddenPin(info?.allowHiddenPin !== false)
      setOpen(true)
    })
    return () => stop?.()
  }, [])

  async function choose(choice: PassphraseChoice | 'cancel'): Promise<void> {
    setOpen(false)
    try {
      await window.seedmask?.chooseOneKeyPassphrase?.(choice)
    } catch {
      /* ignore */
    }
  }

  if (!open) return null

  return (
    <div
      className="onekey-passphrase-choice-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) void choose('cancel')
      }}
    >
      <div
        className="hw-bt-off-prompt onekey-passphrase-choice-card"
        role="alertdialog"
        aria-labelledby="onekey-passphrase-title"
        onClick={(e) => e.stopPropagation()}
      >
        <OneKeyMark size={28} />
        <h4 id="onekey-passphrase-title">Which OneKey wallet?</h4>
        <div className="hw-bt-off-actions" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <button type="button" className="btn btn-primary" onClick={() => void choose('standard')}>
            Standard wallet
          </button>
          <span className="muted" style={{ fontSize: 12, lineHeight: 1.35, marginTop: -4 }}>
            Normal PIN only — no passphrase prompt on the device.
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => void choose('temporary')}>
            Temporary passphrase
          </button>
          <span className="muted" style={{ fontSize: 12, lineHeight: 1.35, marginTop: -4 }}>
            Same as My address → arrows → Enter passphrase. You will type it once on the device.
          </span>
          {allowHiddenPin ? (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void choose('hidden-pin')}
              >
                Hidden PIN wallet
              </button>
              <span className="muted" style={{ fontSize: 12, lineHeight: 1.35, marginTop: -4 }}>
                Passphrase attached to PIN (e.g. 6-digit hidden PIN) — once on the device.
              </span>
            </>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost"
            style={{ marginTop: 8 }}
            onClick={() => void choose('cancel')}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
