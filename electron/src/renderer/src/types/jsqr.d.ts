declare module 'jsqr' {
  interface QRCode {
    binaryData: number[]
    data: string
    chunks: unknown[]
    version: number
    location: unknown
  }

  interface Options {
    inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst'
  }

  export default function jsQR(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    options?: Options,
  ): QRCode | null
}
