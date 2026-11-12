// What the Sync bookmarklet does when clicked, split out from main.ts so tests can call it with
// fake fetchers. Flow: figure out which site we are on -> show a small overlay -> read grades
// same-origin with the student's own session -> navigate to our site with the data in the URL
// fragment (#sync=...). The fragment never reaches any server, and nothing else is sent anywhere.
import type { SyncPayload } from '../src/types'
import { APP_NAME } from '../src/lib/brand'
import { encodePayload } from '../src/lib/payload'
import { sameOriginFetcher, syncCanvas } from '../src/sync/canvas'
import { syncGradescope } from '../src/sync/gradescope'
import { syncAutolab } from '../src/sync/autolab'
import { BOOKMARKLET_VERSION } from './version'

export type Site = 'canvas' | 'gradescope' | 'autolab'

export function detectSite(hostname: string): Site | null {
  const host = hostname.toLowerCase()
  if (host === 'canvas.cmu.edu' || host === 'cmu.instructure.com') return 'canvas'
  if (host === 'www.gradescope.com' || host === 'gradescope.com') return 'gradescope'
  if (host === 'autolab.andrew.cmu.edu') return 'autolab'
  return null
}

/** The URL we send the student to: our site + payload in the fragment + bookmarklet version. */
export function syncUrl(siteOrigin: string, encoded: string): string {
  return siteOrigin + '/#sync=' + encoded + '&bv=' + BOOKMARKLET_VERSION
}

/** Gradescope pages are HTML, fetched with the student's cookies. */
export function gradescopeFetchText(path: string): Promise<string> {
  return fetch(path, { credentials: 'same-origin' }).then((r) => {
    if (!r.ok) throw new Error('Gradescope returned an error (' + r.status + ') for ' + path)
    return r.text()
  })
}

/** Autolab pages are HTML too; we also need the final URL to notice redirects (to the login page, for example). */
export function autolabFetchPage(path: string): Promise<{ html: string; url: string }> {
  return fetch(path, { credentials: 'same-origin' }).then(async (r) => {
    if (!r.ok) throw new Error('Autolab returned an error (' + r.status + ') for ' + path)
    return { html: await r.text(), url: r.url }
  })
}

// Everything that touches the outside world, injectable so tests can fake it.
export interface RunDeps {
  hostname: string
  siteOrigin: string
  syncCanvas: (onProgress: (msg: string) => void) => Promise<SyncPayload>
  syncGradescope: (onProgress: (msg: string) => void) => Promise<SyncPayload>
  syncAutolab: (onProgress: (msg: string) => void) => Promise<SyncPayload>
  navigate: (url: string) => void
  alert: (msg: string) => void
}

export function realDeps(siteOrigin: string): RunDeps {
  return {
    hostname: location.hostname,
    siteOrigin,
    syncCanvas: (p) => syncCanvas(sameOriginFetcher(), p),
    syncGradescope: (p) => syncGradescope(gradescopeFetchText, p),
    syncAutolab: (p) => syncAutolab(autolabFetchPage, p),
    navigate: (url) => {
      location.href = url
    },
    alert: (msg) => window.alert(msg),
  }
}

type GuardedWindow = Window & { __gradeSyncRunning?: boolean }

/** Run one sync. Resolves when it has navigated, failed (overlay shows why) or been cancelled. */
export async function runSync(deps: RunDeps): Promise<void> {
  const w = window as GuardedWindow
  if (w.__gradeSyncRunning) return // clicking the bookmark twice should not start two syncs
  const site = detectSite(deps.hostname)
  if (!site) {
    deps.alert(APP_NAME + ': open canvas.cmu.edu, gradescope.com or autolab.andrew.cmu.edu, log in, then click this bookmark again.')
    return
  }

  w.__gradeSyncRunning = true
  let cancelled = false
  const overlay = createOverlay(() => {
    cancelled = true // we cannot stop fetches already in flight, but we will not navigate
    overlay.remove()
    w.__gradeSyncRunning = false
  })

  try {
    const sync = { canvas: deps.syncCanvas, gradescope: deps.syncGradescope, autolab: deps.syncAutolab }[site]
    const payload = await sync((msg) => overlay.setStatus(msg))
    if (cancelled) return
    overlay.setStatus('Opening ' + APP_NAME + '...')
    deps.navigate(syncUrl(deps.siteOrigin, await encodePayload(payload)))
  } catch (err) {
    if (cancelled) return
    overlay.showError(err instanceof Error ? err.message : String(err))
    w.__gradeSyncRunning = false
  }
}

// ---------------------------------------------------------------- overlay

interface Overlay {
  setStatus: (msg: string) => void
  showError: (msg: string) => void
  remove: () => void
}

/** A small box in the top-right corner. Inline styles only: we cannot load CSS on someone else's site. */
function createOverlay(onCancel: () => void): Overlay {
  const box = document.createElement('div')
  box.setAttribute('role', 'status')
  box.setAttribute('data-grade-sync', '')
  box.style.cssText =
    'position:fixed;top:16px;right:16px;z-index:2147483647;width:300px;padding:14px 16px;' +
    'background:#fff;color:#1a1a1a;border:1px solid #ccc;border-radius:12px;' +
    'box-shadow:0 6px 24px rgba(0,0,0,.18);font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'

  const title = document.createElement('div')
  title.style.cssText = 'font-weight:600;margin-bottom:4px'
  title.textContent = APP_NAME + ': syncing...'

  const status = document.createElement('div')
  status.style.cssText = 'color:#444;margin-bottom:10px;word-wrap:break-word'
  status.textContent = 'Starting'

  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Cancel'
  button.style.cssText =
    'padding:4px 12px;border:1px solid #999;border-radius:6px;background:#f4f4f4;color:#1a1a1a;cursor:pointer;font:inherit'
  button.onclick = onCancel

  box.append(title, status, button)
  document.body.appendChild(box)

  return {
    setStatus: (msg) => {
      status.textContent = msg
    },
    showError: (msg) => {
      title.textContent = APP_NAME + ': sync failed'
      status.textContent = msg // textContent, never innerHTML: error text can contain page data
      status.style.color = '#a11'
      button.textContent = 'Close'
      button.onclick = () => box.remove()
    },
    remove: () => box.remove(),
  }
}
