import { Component, type ErrorInfo, type ReactNode } from 'react'
import { getHostPlatform } from '@renderer/utils/platformCopy'

type Props = { children: ReactNode }
type State = { error: Error | null }

function quitHint(): string {
  const p = getHostPlatform()
  if (p === 'win32') {
    return 'Quit the app fully (Alt+F4 or right-click the taskbar icon → Close) and open it again from the Start menu.'
  }
  if (p === 'darwin') {
    return 'Quit the app (Cmd+Q) and open it again from Applications.'
  }
  return 'Quit the app fully and open it again from your application menu.'
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI render error:', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="loading-screen">
        <h1>SeedMask Coordinator</h1>
        <p className="loading-error">{this.state.error.message}</p>
        <p className="muted">{quitHint()}</p>
      </div>
    )
  }
}
