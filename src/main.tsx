// Entry point: applies the saved theme, then renders the app inside an error boundary.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { APP_NAME, OLD_SITE_HOST, SITE_URL } from './lib/brand'
import { applyTheme, getTheme } from './lib/store'
import { ErrorBoundary } from './ui/ErrorBoundary'
import './styles.css'

// Visitors on the old address go to the main one, keeping the path and #part (e.g. a #sync= link). Only the exact old
// host: Cloudflare's per-deploy preview addresses (<hash>.gradecrunch.pages.dev) keep working for testing.
const movingToMainSite = window.location.hostname === OLD_SITE_HOST
if (movingToMainSite) {
  const { pathname, search, hash } = window.location
  window.location.replace(SITE_URL + pathname + search + hash)
}

document.title = `${APP_NAME} - CMU grades and QPA`

// Set the theme before the first render so a dark-mode choice doesn't flash light.
applyTheme(getTheme())

const root = document.getElementById('root')
if (root && !movingToMainSite) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}
