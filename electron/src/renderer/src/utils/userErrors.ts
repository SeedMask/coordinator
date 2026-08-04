export function startupError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes('Applications folder') || raw.includes('disk image')) {
    return raw
  }
  if (raw.includes('dependencies missing') || raw.includes('fastapi')) {
    return 'SeedMask Coordinator could not start. Please reinstall the app from the official download.'
  }
  if (raw.includes('run_backend.py') || raw.includes('Cannot find')) {
    return 'SeedMask Coordinator is incomplete. Please download and install the latest version.'
  }
  return 'SeedMask Coordinator could not start. Quit the app and try again. If this continues, reinstall.'
}

export function feeHint(reason: string): string {
  return apiError(400, reason)
}

export function apiError(httpCode: number, detail: string): string {
  const d = detail.trim().toLowerCase()
  if (d.includes('utxo not found')) return 'That coin is no longer available. Refresh your wallet and try again.'
  if (d.includes('configure watch-only') || d.includes('wallet first')) {
    return 'Add your SeedMask watch-only key first (Crypto → Export on the device).'
  }
  if (d.includes('invalid') && d.includes('address')) {
    return "That address doesn't look valid. Check the recipient and try again."
  }
  if (d.includes('already imported') || d.includes('already in your')) {
    return 'This wallet is already in your list. Remove the existing one first, or import a different key.'
  }
  if (d.includes('descriptor') && d.includes('invalid')) {
    return "That output descriptor isn't valid. Check the paste and try again."
  }
  if (d.includes('xpub') || d.includes('zpub') || d.includes('ypub') || d.includes('descriptor')) {
    return 'Bitcoin watch-only key problem — export xpub again from SeedMask and re-add the wallet.'
  }
  if (d.includes('kpub')) {
    return 'Kaspa watch-only key problem — export kpub again from SeedMask and re-add the wallet.'
  }
  if (d.includes('watch-only')) {
    return 'Watch-only key problem — re-export from SeedMask and add the wallet again.'
  }
  if (d.includes('coin metadata') || d.includes('coin data is incomplete')) {
    return detail
  }
  if (d.includes('minimum spendable')) {
    return detail
  }
  if (d.includes('storage mass') || d.includes('kip-9') || d.includes('cannot be built')) {
    return "This amount can't be sent with the selected coins. Try Max, a slightly different amount, or change which coins are included."
  }
  if (d.includes('cannot be sent with the selected coins')) {
    return "This amount can't be sent with the selected coins. Try Max, a slightly different amount, or change which coins are included."
  }
  if (d.includes('ur parts') || d.includes('animated qr parts') || d.includes('fragment length')) {
    return 'This transaction is too large for animated QR. Tap Dense below the QR, or select fewer coins.'
  }
  if (d.includes('too large for static qr') || d.includes('static qr needs')) {
    return 'This transaction is too large to show as a QR. Select fewer coins or use Save transaction… and sign from file.'
  }
  if (d.includes('network fee') && d.includes('sompi') && d.includes('below')) {
    return detail
  }
  if (d.includes('fee') && (d.includes('minimum') || d.includes('relay'))) {
    return 'Network fee is too low. Increase the fee and try again.'
  }
  if (d.includes('fee') && d.includes('exceeds selected coins')) {
    return 'Network fee is higher than the selected coins. Lower the amount, reduce the fee, or pick fewer / larger coins.'
  }
  if (d.includes('could not build kaspa')) {
    return detail || 'Could not build this Kaspa transaction. Try fewer coins or a lower amount.'
  }
  if (d.includes('too small for the network fee') || d.includes('insufficient')) {
    return 'Selected coins are too small to cover the network fee. Use a larger coin or add funds.'
  }
  if (d.includes('no longer unspent') || d.includes('no unspent utxo')) {
    return detail
  }
  if (httpCode === 400) return detail || 'Could not complete that action. Check the details and try again.'
  if (httpCode === 502 || httpCode === 503) {
    return 'Network service is temporarily unavailable. Try again in a moment.'
  }
  if (d.includes('draft not found')) {
    return 'Transaction draft expired — go back and build the transaction again.'
  }
  if (httpCode === 404) return detail || 'Not found. Try building the transaction again.'
  return detail || 'Something went wrong. Try again, or restart SeedMask Coordinator.'
}
