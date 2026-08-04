import { useApp } from '@renderer/state/AppProvider'
import { chunkAddressTokens } from '@renderer/utils/addressFormat'

export function AddressDisplay({
  address,
  className,
}: {
  address: string
  className?: string
}): React.JSX.Element {
  const { chunkAddresses } = useApp()

  if (!chunkAddresses) {
    return <span className={className}>{address}</span>
  }

  const tokens = chunkAddressTokens(address)
  return (
    <span className={`chunked-address${className ? ` ${className}` : ''}`}>
      {tokens.map((tok, i) => {
        const accentClass = i % 2 === 0 ? 'address-chunk-accent' : undefined
        if (i === 0) {
          const kaspaMatch = tok.match(/^(kaspa:)(.*)$/i)
          if (kaspaMatch) {
            const [, prefix, rest] = kaspaMatch
            return (
              <span key={`${i}-${tok}`}>
                <span className="address-chunk-prefix">{prefix}</span>
                {rest ? <span className={accentClass}>{rest}</span> : null}
              </span>
            )
          }
        }
        return (
          <span key={`${i}-${tok}`} className={accentClass}>
            {i > 0 ? ' ' : null}
            {tok}
          </span>
        )
      })}
    </span>
  )
}
