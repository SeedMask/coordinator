/**
 * Export QR: Dense + Animated packs are built locally in Electron main
 * (BC-UR + qrcode) — Sparrow-style, no Python round-trip.
 */
export type ExportQrPack = { frames: string[]; frameMs: number }

export type LocalExportQrPacks = {
  static?: ExportQrPack
  animated: ExportQrPack
}

function seedmaskApi(): Window['seedmask'] | undefined {
  return typeof window !== 'undefined' ? window.seedmask : undefined
}

/** Local UR/plain packs — both modes in one IPC call when available. */
export async function localExportQrPacks(
  text: string,
  preferredEncoding: 'ur' | 'plain' = 'ur',
): Promise<LocalExportQrPacks> {
  const api = seedmaskApi()
  if (!api?.exportQrPacks) {
    throw new Error('Local QR encode unavailable')
  }
  const res = await api.exportQrPacks(text, preferredEncoding)
  if (!res.ok) {
    throw new Error(res.error || 'QR export failed')
  }
  const staticPack = res.static?.frames?.length ? res.static : undefined
  const animatedPack = res.animated?.frames?.length ? res.animated : undefined
  if (!staticPack && !animatedPack) {
    throw new Error(res.error || 'QR export failed')
  }
  return {
    static: staticPack,
    animated: animatedPack ?? staticPack!,
  }
}
