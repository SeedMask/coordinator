import type { CoinChain, DisplayCurrency } from '@renderer/api/types'

const CURRENCY_KEYS: Record<DisplayCurrency, string> = {
  USD: 'usd',
  EUR: 'eur',
  GBP: 'gbp',
  JPY: 'jpy',
  CAD: 'cad',
  CHF: 'chf',
  AUD: 'aud',
}

class FiatPriceServiceImpl {
  private matrix: Record<string, Record<string, number>> = {}
  private lastFetch: number | null = null
  private readonly cacheTTL = 300_000
  private rangeCache = new Map<string, Array<{ date: Date; price: number }>>()

  price(chain: CoinChain, currency: DisplayCurrency): number | undefined {
    const id = chain === 'kaspa' ? 'kaspa' : 'bitcoin'
    return this.matrix[id]?.[CURRENCY_KEYS[currency]]
  }

  nearestPrice(samples: Array<{ date: Date; price: number }>, to: Date): number | undefined {
    if (!samples.length) return undefined
    let best = samples[0]
    let bestDelta = Math.abs(best.date.getTime() - to.getTime())
    for (const sample of samples) {
      const delta = Math.abs(sample.date.getTime() - to.getTime())
      if (delta < bestDelta) {
        best = sample
        bestDelta = delta
      }
    }
    return best.price
  }

  async refreshIfNeeded(): Promise<void> {
    if (this.lastFetch && Date.now() - this.lastFetch < this.cacheTTL && Object.keys(this.matrix).length) {
      return
    }
    await this.refresh()
  }

  async refresh(): Promise<void> {
    const currencies = Object.values(CURRENCY_KEYS).join(',')
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=kaspa,bitcoin&vs_currencies=${currencies}`
    try {
      const res = await fetch(url)
      if (!res.ok) return
      this.matrix = (await res.json()) as Record<string, Record<string, number>>
      this.lastFetch = Date.now()
    } catch {
      /* keep stale */
    }
  }

  async historicalUnitPrices(
    chain: CoinChain,
    currency: DisplayCurrency,
    from: Date,
    to: Date,
  ): Promise<Array<{ date: Date; price: number }>> {
    const coinId = chain === 'kaspa' ? 'kaspa' : 'bitcoin'
    const fromTs = Math.floor(from.getTime() / 1000)
    const toTs = Math.max(fromTs + 3600, Math.floor(to.getTime() / 1000))
    const cacheKey = `${coinId}-${CURRENCY_KEYS[currency]}-${fromTs}-${toTs}`
    const cached = this.rangeCache.get(cacheKey)
    if (cached) return cached

    await this.refreshIfNeeded()
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart/range?vs_currency=${CURRENCY_KEYS[currency]}&from=${fromTs}&to=${toTs}`
    try {
      const res = await fetch(url)
      if (!res.ok) return this.fallbackHistorical(from, to, chain, currency)
      const json = (await res.json()) as { prices?: number[][] }
      const samples = (json.prices ?? [])
        .filter((p) => p.length >= 2)
        .map((p) => ({ date: new Date(p[0]), price: p[1] }))
        .sort((a, b) => a.date.getTime() - b.date.getTime())
      this.rangeCache.set(cacheKey, samples)
      return samples
    } catch {
      return this.fallbackHistorical(from, to, chain, currency)
    }
  }

  private fallbackHistorical(from: Date, to: Date, chain: CoinChain, currency: DisplayCurrency) {
    const spot = this.price(chain, currency)
    if (spot == null) return []
    return [
      { date: from, price: spot },
      { date: to, price: spot },
    ]
  }
}

export const fiatPriceService = new FiatPriceServiceImpl()
