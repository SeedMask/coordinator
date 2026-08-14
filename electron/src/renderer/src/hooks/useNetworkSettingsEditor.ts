import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '@renderer/state/AppProvider'
import type { BitcoinNetworkSettingsDTO, NetworkSettingsDTO } from '@renderer/api/types'
import {
  applyBitcoinServerMode,
  applyKaspaMode,
  applyPublicPreset,
  type BitcoinPublicPreset,
  type BitcoinServerMode,
  type CoinChainFilter,
  type KaspaHistoryMode,
  type KaspaRpcMode,
  KASPA_PUBLIC_HISTORY_API,
  resolveBitcoinPublicPreset,
  resolveBitcoinServerMode,
  resolveKaspaHistoryMode,
  resolveKaspaRpcMode,
  completeBitcoinSettings,
  isKaspaCustomRpcUrlReady,
  sanitizedForSave,
  settingsEqual,
} from '@renderer/utils/networkSettings'

export type NetworkSettingsSavePhase = 'idle' | 'pending' | 'saved' | 'failed'

export type NetworkSettingsEditor = ReturnType<typeof useNetworkSettingsEditor>

export function useNetworkSettingsEditor() {
  const { networkSettingsEnvelope, persistNetworkSettings, networkSettingsSaving } = useApp()
  const [draft, setDraft] = useState<NetworkSettingsDTO | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState<NetworkSettingsDTO | null>(null)
  const [defaults, setDefaults] = useState<NetworkSettingsDTO | null>(null)
  const [savePhase, setSavePhase] = useState<NetworkSettingsSavePhase>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [lastSaveContext, setLastSaveContext] = useState<CoinChainFilter | null>(null)
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedIndicatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftRef = useRef<NetworkSettingsDTO | null>(null)
  const savedSnapshotRef = useRef<NetworkSettingsDTO | null>(null)

  draftRef.current = draft
  savedSnapshotRef.current = savedSnapshot

  const isLoaded = draft != null && defaults != null
  const isDirty = !settingsEqual(draft, savedSnapshot)
  const bitcoinServerMode = draft ? resolveBitcoinServerMode(draft.bitcoin.server_mode) : 'public'
  const bitcoinPublicPreset = draft ? resolveBitcoinPublicPreset(draft.bitcoin.public_preset) : 'recommended'
  const kaspaRpcMode = draft ? resolveKaspaRpcMode(draft.kaspa) : 'resolver'
  const kaspaHistoryMode = draft ? resolveKaspaHistoryMode(draft.kaspa) : 'public'

  const syncFromEnvelope = useCallback(() => {
    if (!networkSettingsEnvelope) return
    setDefaults(networkSettingsEnvelope.defaults)
    setSavedSnapshot(networkSettingsEnvelope.settings)
    savedSnapshotRef.current = networkSettingsEnvelope.settings
    setDraft((current) => {
      if (current && !settingsEqual(current, networkSettingsEnvelope.settings)) {
        return current
      }
      const next = structuredClone(networkSettingsEnvelope.settings)
      draftRef.current = next
      return next
    })
    setSaveError(null)
    setSavePhase('idle')
  }, [networkSettingsEnvelope])

  useEffect(() => {
    syncFromEnvelope()
  }, [syncFromEnvelope])

  const save = useCallback(
    async (context?: CoinChainFilter | null, payloadOverride?: NetworkSettingsDTO) => {
      const source = payloadOverride ?? draftRef.current
      const snapshot = savedSnapshotRef.current
      if (!source || !defaults) return

      // Own-node with an empty/incomplete WebSocket URL: keep the draft (including history
      // choices) local until the user finishes the address. Do not revert or block the UI.
      if (
        resolveKaspaRpcMode(source.kaspa) === 'custom' &&
        !isKaspaCustomRpcUrlReady(source.kaspa.rpc_url)
      ) {
        setSavePhase('idle')
        setSaveError(null)
        return
      }

      setSaveError(null)
      setSavePhase('pending')
      setLastSaveContext(context ?? null)
      const merged: NetworkSettingsDTO = {
        ...source,
        bitcoin: completeBitcoinSettings(source.bitcoin, defaults.bitcoin),
      }
      const payload = sanitizedForSave(merged, snapshot)
      try {
        await persistNetworkSettings(payload)
        setSavedSnapshot(structuredClone(payload))
        savedSnapshotRef.current = structuredClone(payload)
        setDraft(structuredClone(payload))
        draftRef.current = structuredClone(payload)
        setSavePhase('saved')
        if (savedIndicatorTimer.current) clearTimeout(savedIndicatorTimer.current)
        savedIndicatorTimer.current = setTimeout(() => {
          setSavePhase((phase) => (phase === 'saved' ? 'idle' : phase))
        }, 2500)
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : 'Could not save')
        setSavePhase('failed')
      }
    },
    [persistNetworkSettings, defaults],
  )

  const scheduleAutoSave = useCallback(
    (context?: CoinChainFilter | null, immediate = false) => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
      const latest = draftRef.current
      const snap = savedSnapshotRef.current
      if (!latest || !snap) return
      if (settingsEqual(latest, snap)) {
        setSavePhase('idle')
        return
      }
      if (immediate) {
        void save(context, latest)
        return
      }
      setSavePhase('pending')
      autoSaveTimer.current = setTimeout(() => {
        const current = draftRef.current
        const saved = savedSnapshotRef.current
        if (!current || !saved || settingsEqual(current, saved)) {
          setSavePhase('idle')
          return
        }
        void save(context, current)
      }, 300)
    },
    [save],
  )

  const patchDraft = useCallback(
    (updater: (current: NetworkSettingsDTO) => NetworkSettingsDTO, context?: CoinChainFilter | null, immediate = false) => {
      setDraft((current) => {
        if (!current) return current
        const next = updater(current)
        draftRef.current = next
        setSaveError(null)
        return next
      })
      scheduleAutoSave(context, immediate)
    },
    [scheduleAutoSave],
  )

  const setBitcoinServerMode = useCallback(
    (mode: BitcoinServerMode, context?: CoinChainFilter | null) => {
      if (!draft || !defaults) return
      patchDraft((current) => applyBitcoinServerMode(mode, current, defaults), context, true)
    },
    [draft, defaults, patchDraft],
  )

  const setPublicPreset = useCallback(
    (preset: BitcoinPublicPreset, context?: CoinChainFilter | null) => {
      if (!draft || !defaults) return
      patchDraft((current) => {
        const next = structuredClone(current)
        next.bitcoin = applyPublicPreset(preset, defaults)
        return next
      }, context, true)
    },
    [draft, defaults, patchDraft],
  )

  const setKaspaMode = useCallback(
    (mode: KaspaRpcMode, context?: CoinChainFilter | null) => {
      if (!draft) return
      // Selecting Custom with no URL yet must remain a local draft. Saving immediately
      // would sanitize the empty custom setting back to the saved Resolver mode before
      // the user has a chance to enter their node address.
      if (mode === 'custom' && !draft.kaspa.rpc_url.trim()) {
        setDraft((current) => {
          if (!current) return current
          const next = applyKaspaMode(mode, current)
          draftRef.current = next
          return next
        })
        setSaveError(null)
        setSavePhase('idle')
        setLastSaveContext(context ?? null)
        return
      }
      patchDraft((current) => applyKaspaMode(mode, current), context, true)
    },
    [draft, patchDraft],
  )

  const setKaspaHistoryMode = useCallback(
    (mode: KaspaHistoryMode, context?: CoinChainFilter | null) => {
      if (!draft) return
      const update = (current: NetworkSettingsDTO) => {
        const next = structuredClone(current)
        next.kaspa.history_mode = mode
        if (mode === 'public') {
          next.kaspa.history_api_base = KASPA_PUBLIC_HISTORY_API
        }
        return next
      }
      const ownNodeIncomplete =
        resolveKaspaRpcMode(draft.kaspa) === 'custom' && !isKaspaCustomRpcUrlReady(draft.kaspa.rpc_url)
      const privateHistoryIncomplete = mode === 'custom' && !(draft.kaspa.history_api_base || '').trim()
      if (ownNodeIncomplete || privateHistoryIncomplete) {
        setDraft((current) => {
          if (!current) return current
          const next = update(current)
          draftRef.current = next
          return next
        })
        setSaveError(null)
        setSavePhase('idle')
        setLastSaveContext(context ?? null)
        return
      }
      patchDraft(update, context, true)
    },
    [draft, patchDraft],
  )

  const resetBitcoin = useCallback(
    (context?: CoinChainFilter | null) => {
      if (!draft || !defaults) return
      patchDraft((current) => {
        const next = structuredClone(current)
        next.bitcoin = structuredClone(defaults.bitcoin)
        return next
      }, context)
    },
    [draft, defaults, patchDraft],
  )

  const resetKaspa = useCallback(
    (context?: CoinChainFilter | null) => {
      if (!draft || !defaults) return
      patchDraft((current) => {
        const next = structuredClone(current)
        next.kaspa = structuredClone(defaults.kaspa)
        return next
      }, context)
    },
    [draft, defaults, patchDraft],
  )

  const patchBitcoin = useCallback(
    (updater: (bitcoin: BitcoinNetworkSettingsDTO) => BitcoinNetworkSettingsDTO, context?: CoinChainFilter | null) => {
      patchDraft((current) => {
        const next = structuredClone(current)
        next.bitcoin = updater(next.bitcoin)
        return next
      }, context)
    },
    [patchDraft],
  )

  useEffect(
    () => () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
      if (savedIndicatorTimer.current) clearTimeout(savedIndicatorTimer.current)
    },
    [],
  )

  return {
    draft,
    defaults,
    isLoaded,
    isDirty,
    bitcoinServerMode,
    bitcoinPublicPreset,
    kaspaRpcMode,
    kaspaHistoryMode,
    savePhase,
    saveError,
    lastSaveContext,
    networkSettingsSaving,
    syncFromEnvelope,
    scheduleAutoSave,
    save,
    setDraft: patchDraft,
    patchBitcoin,
    setBitcoinServerMode,
    setPublicPreset,
    setKaspaMode,
    setKaspaHistoryMode,
    resetBitcoin,
    resetKaspa,
  }
}
