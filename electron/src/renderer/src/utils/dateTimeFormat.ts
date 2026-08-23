import { UserPrefs } from './userPrefs'
import type { TimeFormat } from '@renderer/api/types'

export type { TimeFormat }

function hour12Option(format: TimeFormat): boolean | undefined {
  if (format === '12h') return true
  if (format === '24h') return false
  return undefined
}

export function formatClock(date: Date, format: TimeFormat = UserPrefs.timeFormat): string {
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: hour12Option(format),
  })
}

export function formatDateAndClock(date: Date, format: TimeFormat = UserPrefs.timeFormat): string {
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: hour12Option(format),
  })
}
