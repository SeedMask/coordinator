const CHUNK_GROUP = 4

function chunkBody(body: string, group = CHUNK_GROUP): string {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    if (i > 0 && i % group === 0) out += ' '
    out += body[i]
  }
  return out
}

/** Insert spaces every `group` characters (preserves optional " (+n)" suffix). */
export function chunkAddress(address: string, group = CHUNK_GROUP): string {
  const suffixMatch = address.match(/( \(\+\d+\))$/)
  const suffix = suffixMatch?.[1] ?? ''
  const main = (suffix ? address.slice(0, -suffix.length) : address).replace(/\s/g, '')
  if (!main) return address

  const kaspaMatch = main.match(/^(kaspa:)(.*)$/i)
  if (kaspaMatch) {
    const body = kaspaMatch[2]
    return body ? `${kaspaMatch[1]}${chunkBody(body, group)}${suffix}` : `${kaspaMatch[1]}${suffix}`
  }

  return chunkBody(main, group) + suffix
}

export function chunkAddressTokens(address: string, group = CHUNK_GROUP): string[] {
  return chunkAddress(address, group).split(' ').filter(Boolean)
}
