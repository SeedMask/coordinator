/** Copy text to the system clipboard (Electron IPC + browser fallbacks). */

export async function copyToClipboard(text: string): Promise<boolean> {
  const value = text.trim()
  if (!value) return false

  try {
    if (window.seedmask?.copyText) {
      return await window.seedmask.copyText(value)
    }
  } catch {
    /* try fallbacks */
  }

  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    /* execCommand fallback */
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

export async function readFromClipboard(): Promise<string | null> {
  try {
    if (window.seedmask?.readText) {
      const text = await window.seedmask.readText()
      return text.trim() || null
    }
  } catch {
    /* try browser API */
  }

  try {
    const text = await navigator.clipboard.readText()
    return text.trim() || null
  } catch {
    return null
  }
}
