import type { BalanceResponse } from '@renderer/api/types'

export class WalletEventStream {
  private abort: AbortController | null = null
  private connected = false

  start(
    walletId: string,
    baseURL: string,
    onConnected: () => void,
    onBalance: (balance: BalanceResponse) => void,
    onDisconnected: () => void,
  ): void {
    this.stop(false, onDisconnected)
    const loop = async (): Promise<void> => {
      while (this.abort && !this.abort.signal.aborted) {
        try {
          await this.stream(walletId, baseURL, onConnected, onBalance)
        } catch {
          if (this.abort?.signal.aborted) break
        }
        if (this.connected) {
          this.connected = false
          onDisconnected()
        }
        await sleep(3000)
      }
    }
    this.abort = new AbortController()
    void loop()
  }

  stop(notify = true, onDisconnected?: () => void): void {
    this.abort?.abort()
    this.abort = null
    if (notify && this.connected) {
      this.connected = false
      onDisconnected?.()
    }
  }

  private async stream(
    walletId: string,
    baseURL: string,
    onConnected: () => void,
    onBalance: (balance: BalanceResponse) => void,
  ): Promise<void> {
    const res = await fetch(`${baseURL}/api/wallets/${walletId}/events`, {
      headers: { Accept: 'text/event-stream' },
      signal: this.abort?.signal,
    })
    if (!res.ok || !res.body) throw new Error(`SSE failed ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let eventName = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventName = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          const payload = line.slice(6)
          if (eventName === 'connected') {
            this.connected = true
            onConnected()
          } else if (eventName === 'balance') {
            try {
              onBalance(JSON.parse(payload) as BalanceResponse)
            } catch {
              /* ignore */
            }
          }
          eventName = ''
        }
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
