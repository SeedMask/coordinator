/** Host OS for user-facing copy (Mac vs Windows vs Linux). */
export function getHostPlatform(): string {
  try {
    return window.seedmask?.getPlatform?.() || 'unknown'
  } catch {
    return 'unknown'
  }
}

/** e.g. "this Mac" / "this PC" / "this computer" */
export function thisDevicePhrase(): string {
  const p = getHostPlatform()
  if (p === 'darwin') return 'this Mac'
  if (p === 'win32') return 'this PC'
  return 'this computer'
}

/** Capitalized form: "This Mac" / "This PC" / "This computer" */
export function ThisDevicePhrase(): string {
  const s = thisDevicePhrase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}
