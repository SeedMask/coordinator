import type { ReactNode } from 'react'

/** Split `text` and wrap case-insensitive matches of `query` in <mark>. */
export function highlightSearchMatch(text: string, query: string | undefined | null): ReactNode {
  const source = text ?? ''
  const needle = (query || '').trim()
  if (!needle || !source) return source

  const lowerSource = source.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let matchIndex = lowerSource.indexOf(lowerNeedle, cursor)
  let key = 0

  while (matchIndex >= 0) {
    if (matchIndex > cursor) {
      parts.push(source.slice(cursor, matchIndex))
    }
    const end = matchIndex + needle.length
    parts.push(
      <mark key={`m-${key++}`} className="search-highlight">
        {source.slice(matchIndex, end)}
      </mark>,
    )
    cursor = end
    matchIndex = lowerSource.indexOf(lowerNeedle, cursor)
  }

  if (cursor < source.length) {
    parts.push(source.slice(cursor))
  }
  return parts.length === 1 ? parts[0] : parts
}
