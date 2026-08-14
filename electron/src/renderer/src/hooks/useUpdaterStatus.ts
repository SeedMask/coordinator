import { useEffect, useState } from 'react'

export type UpdaterUiStatus = {
  phase: string
  currentVersion: string
  availableVersion?: string
  percent?: number
  error?: string
  packaged: boolean
  message?: string
  demo?: boolean
  releaseNotes?: string
  releaseUrl?: string
}

export function useUpdaterStatus(): UpdaterUiStatus | null {
  const [status, setStatus] = useState<UpdaterUiStatus | null>(null)

  useEffect(() => {
    const api = window.seedmask
    if (!api?.getUpdaterStatus) return
    void api.getUpdaterStatus().then(setStatus)
    return api.onUpdaterEvent?.(setStatus)
  }, [])

  return status
}

export function updaterNeedsAttention(status: UpdaterUiStatus | null): boolean {
  if (!status) return false
  return (
    status.phase === 'available' ||
    status.phase === 'downloaded' ||
    status.phase === 'downloading' ||
    status.phase === 'installing'
  )
}
