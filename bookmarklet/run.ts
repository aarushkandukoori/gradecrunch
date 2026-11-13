// What the Sync bookmarklet does when clicked, split out from main.ts so tests can call it with
// fake fetchers and fake tabs. Flow:
//   1. right away (while the click still counts, so the popup blocker allows it) open a GradeCrunch tab
//      at <site>/#receive and start listening for its messages
//   2. show a small overlay and read grades same-origin with the student's own session
//   3. hand the grades to the GradeCrunch tab with postMessage (see protocol.ts)
//   4. fallback when the tab was blocked or never answered: navigate this tab to <site>/#sync=<data>.
// Nothing is sent to any server: postMessage goes tab to tab, and a URL fragment never leaves the browser.
import type { SyncPayload } from '../src/types'
import { APP_NAME } from '../src/lib/brand'
import { encodePayload } from '../src/lib/payload'
import { sameOriginBinaryFetcher, sameOriginFetcher, syncCanvas, withoutSyllabusPdfs } from '../src/sync/canvas'
import { syncGradescope } from '../src/sync/gradescope'
import { syncAutolab } from '../src/sync/autolab'
import { BOOKMARKLET_VERSION } from './version'
import {
  detectSite,
  MAX_MESSAGE_CHARS,
  MSG_DONE,
  MSG_READY,
  MSG_SYNC,
  RECEIVE_HASH,
  type DoneMessage,
  type IncomingMessage,
  type SyncMessage,
} from './protocol'

export { detectSite, type IncomingMessage, type Site } from './protocol'

/** The fallback URL: our site + payload in the fragment + bookmarklet version. */
export function syncUrl(siteOrigin: string, encoded: string): string {
  return siteOrigin + '/#sync=' + encoded + '&bv=' + BOOKMARKLET_VERSION
}

/**
 * Longest fallback link we build. Chrome accepts URLs up to 2 MB; syllabus PDFs (base64 in the payload) can be bigger
 * than that, so the fallback link leaves them out when they do not fit.
 */
export const MAX_FALLBACK_URL = 1_500_000

/** The fallback link, without the syllabus PDFs if they would make it too long (the postMessage path keeps them). */
export async function fallbackUrl(siteOrigin: string, payload: SyncPayload, encoded: string): Promise<string> {
  const url = syncUrl(siteOrigin, encoded)
  if (url.length <= MAX_FALLBACK_URL) return url
  const smaller = withoutSyllabusPdfs(payload)
  smaller.warnings = [...smaller.warnings, 'Syllabus PDFs were too big for this link. Allow pop-ups for Canvas and sync again to include them.']
  return syncUrl(siteOrigin, await encodePayload(smaller))
}

/**
 * The grades as one string for the postMessage handoff. If the syllabus PDFs make it longer than the app accepts
 * (MAX_MESSAGE_CHARS), they are left out with a warning; the Syllabus page text and the grades still go.
 */
export async function messagePayload(payload: SyncPayload, maxChars = MAX_MESSAGE_CHARS): Promise<string> {
  const encoded = await encodePayload(payload)
  if (encoded.length < maxChars) return encoded
  const smaller = withoutSyllabusPdfs(payload)
  smaller.warnings = [...smaller.warnings, 'Syllabus PDFs were too big to send, so they were left out.']
  return encodePayload(smaller)
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

/** The parts of the opened GradeCrunch tab we use. A real Window has all of these. */
export interface ReceiverTab {
  readonly closed: boolean
  postMessage: (message: unknown, targetOrigin: string) => void
  focus: () => void
  close: () => void
}

// Everything that touches the outside world, injectable so tests can fake it.
export interface RunDeps {
  hostname: string
  siteOrigin: string
  syncCanvas: (onProgress: (msg: string) => void) => Promise<SyncPayload>
  syncGradescope: (onProgress: (msg: string) => void) => Promise<SyncPayload>
  syncAutolab: (onProgress: (msg: string) => void) => Promise<SyncPayload>
  openReceiver: (url: string) => ReceiverTab | null // null when the popup blocker said no
  listen: (handler: (event: IncomingMessage) => void) => () => void // returns a function that stops listening
  navigate: (url: string) => void
  alert: (msg: string) => void
  timeoutMs: number // how long to wait for each answer from the GradeCrunch tab
  closeDelayMs: number // how long the "Done" overlay stays up
}

export function realDeps(siteOrigin: string): RunDeps {
  return {
    hostname: location.hostname,
    siteOrigin,
    // Also reads syllabi (Syllabus page, home page, syllabus PDFs): same-origin, so PDFs need no extra permission.
    syncCanvas: (p) => syncCanvas(sameOriginFetcher(), p, { syllabus: { fetchBinary: sameOriginBinaryFetcher() } }),
    syncGradescope: (p) => syncGradescope(gradescopeFetchText, p),
    syncAutolab: (p) => syncAutolab(autolabFetchPage, p),
    // No "noopener": the new tab needs window.opener to send us its "ready" message.
    openReceiver: (url) => window.open(url, '_blank'),
    listen: (handler) => {
      const onMessage = (e: MessageEvent) => handler({ source: e.source, origin: e.origin, data: e.data })
      window.addEventListener('message', onMessage)
      return () => window.removeEventListener('message', onMessage)
    },
    navigate: (url) => {
      location.href = url
    },
    alert: (msg) => window.alert(msg),
    timeoutMs: 20000,
    closeDelayMs: 4000,
  }
}

/**
 * Listen to the GradeCrunch tab. Only messages from that exact tab AND from our own site count: any other
 * page can post messages to this window too, and must not be able to fake "ready" or "done".
 */
function watchReceiver(deps: RunDeps, receiver: ReceiverTab) {
  let ready = false
  let done: DoneMessage | null = null
  let wake: (() => void) | null = null // set while someone is waiting for a message

  const stop = deps.listen((event) => {
    if (event.source !== receiver || event.origin !== deps.siteOrigin) return
    const data = event.data as { type?: unknown; ok?: unknown; message?: unknown } | null
    if (!data || typeof data !== 'object') return
    if (data.type === MSG_READY) {
      ready = true
    } else if (data.type === MSG_DONE) {
      done = { type: MSG_DONE, ok: data.ok === true, message: typeof data.message === 'string' ? data.message : undefined }
    } else {
      return
    }
    if (wake) wake()
  })

  /** Resolves true as soon as check() is true, or false after deps.timeoutMs. */
  function waitUntil(check: () => boolean): Promise<boolean> {
    return new Promise((resolve) => {
      if (check()) return resolve(true)
      const timer = setTimeout(() => {
        wake = null
        resolve(false)
      }, deps.timeoutMs)
      wake = () => {
        if (!check()) return
        clearTimeout(timer)
        wake = null
        resolve(true)
      }
    })
  }

  return {
    waitForReady: () => waitUntil(() => ready),
    waitForDone: async (): Promise<DoneMessage | null> => ((await waitUntil(() => done !== null)) ? done : null),
    stop,
  }
}

type GuardedWindow = Window & { __gradeSyncRunning?: boolean }

/** Run one sync. Resolves when the grades were handed over, it failed (overlay shows why) or was cancelled. */
export async function runSync(deps: RunDeps): Promise<void> {
  const w = window as GuardedWindow
  if (w.__gradeSyncRunning) return // clicking the bookmark twice should not start two syncs
  const site = detectSite(deps.hostname)
  if (!site) {
    deps.alert(APP_NAME + ': open canvas.cmu.edu, gradescope.com or autolab.andrew.cmu.edu, log in, then click this bookmark again.')
    return
  }

  // Before any await: browsers only allow window.open during the click itself.
  const receiver = deps.openReceiver(deps.siteOrigin + '/' + RECEIVE_HASH)
  const inbox = receiver ? watchReceiver(deps, receiver) : null

  /** Stop listening and close the GradeCrunch tab if we will not use it. */
  function dropReceiver() {
    inbox?.stop()
    if (receiver && !receiver.closed) receiver.close()
  }

  w.__gradeSyncRunning = true
  let cancelled = false
  const overlay = createOverlay(() => {
    cancelled = true // we cannot stop fetches already in flight, but we will not hand anything over
    dropReceiver()
    overlay.remove()
    w.__gradeSyncRunning = false
  })

  try {
    const sync = { canvas: deps.syncCanvas, gradescope: deps.syncGradescope, autolab: deps.syncAutolab }[site]
    const payload = await sync((msg) => overlay.setStatus(msg))
    if (cancelled) return
    const encoded = await messagePayload(payload)
    if (cancelled) return

    // Main path: hand the grades to the GradeCrunch tab.
    if (receiver && inbox && !receiver.closed) {
      overlay.setStatus('Waiting for the ' + APP_NAME + ' tab...')
      const ready = await inbox.waitForReady()
      if (cancelled) return
      if (ready && !receiver.closed) {
        const message: SyncMessage = { type: MSG_SYNC, payload: encoded, bv: BOOKMARKLET_VERSION }
        receiver.postMessage(message, deps.siteOrigin) // exact origin, never '*': only our site may read it
        overlay.setStatus('Sending your grades to ' + APP_NAME + '...')
        const done = await inbox.waitForDone()
        if (cancelled) return
        inbox.stop()
        w.__gradeSyncRunning = false
        if (!done) {
          overlay.showError('The ' + APP_NAME + ' tab did not answer. Check that tab, or click Sync again.')
        } else if (!done.ok) {
          overlay.showError(done.message || APP_NAME + ' could not read the grades.')
        } else {
          overlay.showDone('Done. Your grades are in the ' + APP_NAME + ' tab.')
          try {
            receiver.focus() // browsers may ignore this; the overlay message says where to look
          } catch {
            // ignore
          }
          setTimeout(() => overlay.remove(), deps.closeDelayMs)
        }
        return
      }
    }

    // Fallback: the popup was blocked or never said "ready". Navigate this tab with the data in the fragment.
    dropReceiver()
    overlay.setStatus('Opening ' + APP_NAME + '...')
    const url = await fallbackUrl(deps.siteOrigin, payload, encoded)
    if (cancelled) return
    // Clear the guard now: if the student comes Back to this page and the browser restores it from its cache,
    // our code would still think a sync is running and ignore the next click.
    w.__gradeSyncRunning = false
    window.addEventListener('pageshow', () => overlay.remove(), { once: true }) // restored from cache: drop the stale box
    deps.navigate(url)
  } catch (err) {
    if (cancelled) return
    dropReceiver()
    overlay.showError(err instanceof Error ? err.message : String(err))
    w.__gradeSyncRunning = false
  }
}

// ---------------------------------------------------------------- overlay

interface Overlay {
  setStatus: (msg: string) => void
  showError: (msg: string) => void
  showDone: (msg: string) => void
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
    showDone: (msg) => {
      title.textContent = APP_NAME + ': synced'
      status.textContent = msg
      button.textContent = 'Close'
      button.onclick = () => box.remove()
    },
    remove: () => box.remove(),
  }
}
