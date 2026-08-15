/** Parse GitHub release / legacy New:/Fixed:/Improved: notes for the Update details list. */

export type UpdateNoteKind = 'new' | 'fixed' | 'improved' | 'other'

export type UpdateNoteItem = {
  kind: UpdateNoteKind
  text: string
}

function kindFromHeading(heading: string): UpdateNoteKind | null {
  const h = heading.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!h) return null
  if (h.includes('highlight') || h.includes('what s new') || h.includes('whats new') || h === 'new') {
    return 'new'
  }
  if (h.includes('bug') || h.includes('fix')) return 'fixed'
  if (h.includes('improvement') || h.includes('changed') || h.includes('change')) return 'improved'
  return null
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function stripTags(text: string): string {
  return decodeHtmlEntities(text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

/** GitHub’s updater feed sends HTML; in-app pills need markdown-style headings + bullets. */
export function htmlReleaseNotesToMarkdown(raw: string): string {
  if (!/<\s*(h[1-6]|ul|ol|li|p|div|br)\b/i.test(raw)) return raw
  let s = raw.replace(/\r\n/g, '\n')
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n')
  s = s.replace(/<\s*\/\s*p\s*>/gi, '\n')
  s = s.replace(/<\s*p\b[^>]*>/gi, '')
  s = s.replace(/<\s*h([1-6])\b[^>]*>([\s\S]*?)<\s*\/\s*h\1\s*>/gi, (_m, _n, inner) => {
    return `\n### ${stripTags(String(inner))}\n`
  })
  s = s.replace(/<\s*li\b[^>]*>([\s\S]*?)<\s*\/\s*li\s*>/gi, (_m, inner) => {
    return `- ${stripTags(String(inner))}\n`
  })
  s = s.replace(/<\s*\/?\s*(ul|ol)\b[^>]*>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  return decodeHtmlEntities(s)
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, lines) => line.length > 0 || (i > 0 && lines[i - 1]?.length))
    .join('\n')
    .trim()
}

function stripBullet(line: string): string {
  return line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim()
}

function kindFromPrefixedLine(line: string): UpdateNoteItem | null {
  const m = /^(New|Fixed|Improved):\s*(.+)$/i.exec(line)
  if (!m) return null
  const tag = m[1]!.toLowerCase()
  const kind: UpdateNoteKind = tag === 'new' ? 'new' : tag === 'fixed' ? 'fixed' : 'improved'
  return { kind, text: m[2]!.trim() }
}

/**
 * Turns release body into the same pill rows as today (new / fixed / improved).
 * Supports:
 * - Legacy: `New: …` / `Fixed: …` / `Improved: …`
 * - GitHub markdown: `### Highlights` / `### Bugs fixed` / `### Improvements` + `-` bullets
 * - GitHub HTML from the updater feed: `<h3>`, `<ul>`, `<li>`
 */
export function parseUpdateReleaseNotes(raw: string): UpdateNoteItem[] {
  const text = htmlReleaseNotesToMarkdown((raw || '').replace(/\r\n/g, '\n')).trim()
  if (!text) return []

  const out: UpdateNoteItem[] = []
  let section: UpdateNoteKind | null = null

  for (const original of text.split('\n')) {
    const line = original.trim()
    if (!line) continue

    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      section = kindFromHeading(heading[2] || '')
      continue
    }

    // Bold-only section labels sometimes used instead of ###
    const boldHeading = /^\*\*(.+?)\*\*:?$/.exec(line)
    if (boldHeading && !line.includes(' - ')) {
      const mapped = kindFromHeading(boldHeading[1] || '')
      if (mapped) {
        section = mapped
        continue
      }
    }

    const prefixed = kindFromPrefixedLine(line)
    if (prefixed) {
      out.push(prefixed)
      continue
    }

    const bullet = stripBullet(line)
    if (bullet !== line || line.startsWith('-') || line.startsWith('*')) {
      if (!bullet) continue
      out.push({ kind: section ?? 'other', text: bullet })
      continue
    }

    // Plain paragraph under a known section
    if (section) {
      out.push({ kind: section, text: line })
    } else {
      out.push({ kind: 'other', text: line })
    }
  }

  return out.filter((n) => n.text.length > 0 && !/^<\/?[a-z]/.test(n.text))
}

export function updateNoteTagLabel(kind: UpdateNoteKind): string {
  return kind === 'other' ? 'Note' : kind
}
