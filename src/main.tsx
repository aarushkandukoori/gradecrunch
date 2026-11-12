// Entry point: applies the saved theme, then renders the app inside an error boundary.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { APP_NAME } from './lib/brand'
import { applyTheme, getTheme } from './lib/store'
import { ErrorBoundary } from './ui/ErrorBoundary'
import './styles.css'

document.title = `${APP_NAME} - CMU grades and QPA`

// Set the theme before the first render so a dark-mode choice doesn't flash light.
applyTheme(getTheme())

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}
