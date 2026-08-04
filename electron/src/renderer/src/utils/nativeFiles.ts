/** Native save/open dialogs when running inside Electron; browser fallbacks in dev web preview. */

export async function saveFileWithDialog(
  data: Uint8Array,
  defaultPath: string,
  mime: string,
): Promise<boolean> {
  if (window.seedmask?.saveFile) {
    const ext = defaultPath.includes('.') ? defaultPath.split('.').pop() ?? 'bin' : 'bin'
    const path = await window.seedmask.saveFile({
      defaultPath,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    })
    if (!path) return false
    const copy = data.slice()
    await window.seedmask.writeFile(path, copy.buffer)
    return true
  }
  downloadBlob(data, defaultPath, mime)
  return true
}

export async function pickPathWithDialog(opts: {
  title?: string
  message?: string
}): Promise<string | null> {
  if (window.seedmask?.pickPath) {
    return window.seedmask.pickPath(opts)
  }
  return null
}

export async function openFileWithDialog(
  filters: { name: string; extensions: string[] }[],
): Promise<ArrayBuffer | null> {
  if (window.seedmask?.openFile) {
    const picked = await window.seedmask.openFile({ filters })
    if (!picked || Array.isArray(picked)) return null
    return window.seedmask.readFile(picked)
  }
  return pickFileViaInput(filters)
}

function downloadBlob(data: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([data.slice().buffer], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function pickFileViaInput(filters: { name: string; extensions: string[] }[]): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    const exts = filters.flatMap((f) => f.extensions).map((e) => `.${e}`)
    if (exts.length) input.accept = exts.join(',')
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      resolve(await file.arrayBuffer())
    }
    input.click()
  })
}
