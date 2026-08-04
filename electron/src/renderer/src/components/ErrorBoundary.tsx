import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

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
        <p className="muted">Quit the app (Cmd+Q) and open it again from Applications.</p>
      </div>
    )
  }
}
