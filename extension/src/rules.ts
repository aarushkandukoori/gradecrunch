// Small pure pieces shared by the service worker and the offscreen document: constants, the messages they send each
// other, and the checks on anything that arrives from outside. No chrome.* calls here, so tests can import it.
import type { ExtRequest, ExtSource, ExtSourceResult } from '../protocol'
import { LOGIN_URLS } from '../protocol'
import type { SyncPayload } from '../../src/types'
import { CanvasAuthError, withoutSyllabusPdfs } from '../../src/sync/canvas'

/** The GradeCrunch website. The toolbar button and the welcome page open it. */
export const SITE_URL = 'https://grades.aarushkandukoori.com/'

/** The hidden page that runs the sync code (it has DOMParser, which the service worker lacks). */
export const OFFSCREEN_PATH = 'offscreen.html'

/** chrome.storage.local keys. */
export const CONSENT_KEY = 'consent' // true once the student clicked Continue on the welcome page
export const lastResultKey = (source: ExtSource) => 'last:' + source // last sync result for one site

export const ALL_SOURCES: ExtSource[] = ['canvas', 'gradescope', 'autolab']

/**
 * Canvas keeps uploaded files (syllabus PDFs) on its storage service and redirects downloads there. The extension
 * may only read those answers with a host permission for it. It is optional: the student grants it on the welcome
 * page, and without it the sync just skips PDFs (the Syllabus page and home page text still work).
 */
export const PDF_ORIGINS = ['https://*.inscloudgate.net/*']

// ---------------------------------------------------------------- service worker <-> offscreen messages
// chrome.runtime.sendMessage reaches every page of the extension, so each message names who it is for.

/** Service worker -> offscreen: sync one site, answer with an ExtSourceResult. */
export interface OffscreenSyncRequest {
  target: 'offscreen'
  type: 'sync'
  source: ExtSource
  pdfs?: boolean // Canvas only: true when the student granted PDF_ORIGINS (only the service worker can check that)
}

/** Offscreen -> service worker: a progress line for one site. */
export interface OffscreenProgress {
  target: 'background'
  type: 'progress'
  source: ExtSource
  message: string
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

function isSource(x: unknown): x is ExtSource {
  return typeof x === 'string' && (ALL_SOURCES as string[]).includes(x)
}

export function isOffscreenSyncRequest(x: unknown): x is OffscreenSyncRequest {
  return isObject(x) && x.target === 'offscreen' && x.type === 'sync' && isSource(x.source)
}

export function isOffscreenProgress(x: unknown): x is OffscreenProgress {
  return isObject(x) && x.target === 'background' && x.type === 'progress' && isSource(x.source) && typeof x.message === 'string'
}

/** The offscreen page's answer should be one ExtSourceResult for the site we asked about. */
export function isSourceResultFor(x: unknown, source: ExtSource): x is ExtSourceResult {
  if (!isObject(x) || x.source !== source) return false
  if (x.status === 'ok') return 'payload' in x
  if (x.status === 'login') return typeof x.loginUrl === 'string'
  if (x.status === 'error') return typeof x.message === 'string'
  return false
}

/**
 * The copy of a result we keep in chrome.storage.local, minus the raw syllabus PDFs: storage.local holds about 10 MB
 * and a few PDFs could fill it. The website already got the full result with the PDFs.
 */
export function resultForStorage(result: ExtSourceResult): ExtSourceResult {
  if (result.status !== 'ok') return result
  const payload = result.payload
  if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as { courses?: unknown }).courses)) return result
  return { ...result, payload: withoutSyllabusPdfs(payload as SyncPayload) }
}

// ---------------------------------------------------------------- checks on the website's port

/**
 * True when `origin` (Chrome's sender.origin, e.g. "https://gradecrunch.pages.dev") matches one of the manifest's
 * externally_connectable patterns (e.g. "https://gradecrunch.pages.dev/*"). Chrome already blocks every other site
 * from connecting; this is a second lock in case the manifest is ever loosened by mistake.
 * A pattern without a port ("http://localhost/*") matches any port, the same as Chrome's own rule.
 */
export function isAllowedOrigin(origin: string | undefined, patterns: string[]): boolean {
  if (!origin) return false
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false // e.g. "null" from a sandboxed frame
  }
  if (url.origin !== origin) return false // must be a bare origin, no path
  return patterns.some((pattern) => {
    const match = pattern.match(/^(https?):\/\/([^/:]+)(?::(\d+))?\//)
    if (!match) return false
    const [, scheme, host, port] = match
    return url.protocol === scheme + ':' && url.hostname === host && (port === undefined || url.port === port)
  })
}

/** Turn whatever the website sent into a clean ExtRequest, or null if it is not one we understand. */
export function parseRequest(x: unknown): ExtRequest | null {
  if (!isObject(x)) return null
  if (x.type === 'hello') return { type: 'hello' }
  if (x.type === 'openWelcome') return { type: 'openWelcome' }
  if (x.type === 'sync') {
    if (!Array.isArray(x.sources)) return null
    const asked: unknown[] = x.sources
    // Each known site once, in our fixed order. Reject the request if it names a site we do not know.
    const sources = ALL_SOURCES.filter((s) => asked.includes(s))
    if (sources.length === 0 || sources.length !== new Set(asked).size) return null
    return { type: 'sync', sources }
  }
  return null
}

// ---------------------------------------------------------------- errors -> results

/** The sync code says "Log in to Canvas first" (and the same for Gradescope / Autolab) when the student is logged out. */
const LOGIN_MESSAGE = /^Log in to (Canvas|Gradescope|Autolab) first/

/** Map a failed sync to what the website should do next: send the student to log in, or show the error. */
export function resultFromError(source: ExtSource, err: unknown): ExtSourceResult {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof CanvasAuthError || LOGIN_MESSAGE.test(message)) {
    return { source, status: 'login', loginUrl: LOGIN_URLS[source] }
  }
  return { source, status: 'error', message: message || 'Something went wrong' }
}
