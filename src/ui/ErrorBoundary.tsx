// If anything throws while rendering (for example odd saved data), show a calm message with a way out instead of
// a blank page. React only supports this as a class component, which is why this one file uses a class.
import { Component, type ReactNode } from 'react'
import { clearAll } from '../lib/store'

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="container crash">
        <h1>Something went wrong showing your grades.</h1>
        <p className="muted">{this.state.error.message}</p>
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button
            type="button"
            className="btn btn-danger-ghost"
            onClick={() => {
              if (window.confirm('Delete all saved grades and settings from this browser and start over?')) {
                clearAll()
                window.location.reload()
              }
            }}
          >
            Start over
          </button>
        </div>
      </main>
    )
  }
}
