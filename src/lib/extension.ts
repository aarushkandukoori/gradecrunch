// Talks to the GradeCrunch Chrome extension (the messages are defined in extension/protocol.ts).
//
// How it works: Chrome gives a web page `chrome.runtime.connect(extensionId)` only when an installed extension lists
// that page under "externally_connectable". So on any other browser, or in Chrome without the extension, there is
// nothing to talk to and detectExtension() returns null. Each request opens a fresh "port" (a two-way channel),
// sends one message, collects the answers until the final one, then closes the port.
//
// Everything takes the `chrome` object as a parameter so the tests can pass a fake one.
import { version as manifestVersion } from '../../extension/manifest.json'
import {
  ALL_SOURCES,
  DEV_EXTENSION_ID,
  EXT_PORT_NAME,
  KNOWN_EXTENSION_IDS,
  LOGIN_URLS,
  SOURCES_1_0,
  type ExtProgress,
  type ExtRequest,
  type ExtResponse,
  type ExtSource,
  type ExtSourceResult,
  type ExtSyncResult,
} from '../../extension/protocol'
import { APP_SLUG } from './brand'

export type { ExtProgress, ExtSource, ExtSourceResult, ExtSyncResult }

// ---------------------------------------------------------------- the small part of chrome.runtime we use

/** One open port. Same shape as Chrome's runtime.Port, trimmed to what we call. */
export interface ChromePort {
  postMessage(message: unknown): void
  disconnect(): void
  onMessage: { addListener(fn: (message: unknown) => void): void }
  onDisconnect: { addListener(fn: () => void): void }
}

export interface ChromeLike {
  runtime?: {
    connect?: (extensionId: string, info: { name: string }) => ChromePort
    lastError?: { message?: string }
  }
}

/** The real `chrome` object of this page, if there is one. */
export function browserChrome(): ChromeLike | undefined {
  return (globalThis as { chrome?: ChromeLike }).chrome
}

// ---------------------------------------------------------------- timeouts

export const HELLO_TIMEOUT_MS = 2000 // a sleeping extension wakes up in well under a second
// A sync of many courses can take a while, but the extension sends a progress message after each step. So this is
// a "silence" timeout: it starts over on every message, and only fires when the extension goes quiet.
export const SYNC_TIMEOUT_MS = 90_000

// ---------------------------------------------------------------- one request on one port

/**
 * Sends one request and resolves with the final answer ('hello', 'result' or 'error'). 'progress' messages go to
 * onProgress. Rejects when the port closes early (extension missing, reloaded or crashed) or nothing arrives for
 * `timeoutMs`.
 */
function request(
  chrome: ChromeLike | undefined,
  id: string,
  message: ExtRequest,
  timeoutMs: number,
  onProgress?: (p: ExtProgress) => void,
): Promise<ExtResponse> {
  return new Promise((resolve, reject) => {
    const runtime = chrome?.runtime
    if (!runtime || typeof runtime.connect !== 'function') {
      reject(new Error('The GradeCrunch extension is not installed.'))
      return
    }

    let port: ChromePort
    try {
      port = runtime.connect(id, { name: EXT_PORT_NAME })
    } catch (err) {
      // Chrome throws right away for a malformed id; an id that is simply not installed disconnects instead.
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    function finish(fn: () => void) {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    function restartTimer() {
      clearTimeout(timer)
      timer = setTimeout(() => {
        finish(() => reject(new Error('The extension stopped answering. Try Sync again.')))
        try {
          port.disconnect()
        } catch {
          // already closed
        }
      }, timeoutMs)
    }

    port.onMessage.addListener((raw) => {
      if (done) return
      restartTimer()
      const msg = raw as ExtResponse
      if (!msg || typeof msg !== 'object') return // ignore junk, keep waiting
      if (msg.type === 'progress') {
        onProgress?.({ type: 'progress', source: msg.source, message: String(msg.message).slice(0, 200) })
        return
      }
      if (msg.type === 'hello' || msg.type === 'result' || msg.type === 'error') {
        finish(() => resolve(msg))
        try {
          port.disconnect() // one request per port: we are done with it
        } catch {
          // already closed
        }
      }
    })

    port.onDisconnect.addListener(() => {
      // Reading lastError tells Chrome we handled it (otherwise it logs "Unchecked runtime.lastError").
      const why = runtime.lastError?.message
      finish(() => reject(new Error(why ? `Lost the connection to the extension (${why}).` : 'Lost the connection to the extension.')))
    })

    restartTimer()
    try {
      port.postMessage(message)
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err)))) // the port closed right away
    }
  })
}

// ---------------------------------------------------------------- the three things the website does

export interface ExtensionInfo {
  id: string
  version: string
  consent: boolean // false until the student clicked Continue on the extension's welcome page
  sources?: ExtSource[] // the sites it can sync; missing for version 1.0.0 (Canvas, Gradescope, Autolab)
}

/** Finds the installed extension: says 'hello' to each known id in turn. null when none answers. */
export async function detectExtension(
  chrome: ChromeLike | undefined = browserChrome(),
  ids: string[] = KNOWN_EXTENSION_IDS,
  timeoutMs = HELLO_TIMEOUT_MS,
): Promise<ExtensionInfo | null> {
  if (typeof chrome?.runtime?.connect !== 'function') return null // not Chrome, or no extension lists this site
  for (const id of ids) {
    try {
      const answer = await request(chrome, id, { type: 'hello' }, timeoutMs)
      if (answer.type === 'hello') {
        const info: ExtensionInfo = { id, version: String(answer.version).slice(0, 20), consent: answer.consent === true }
        if (Array.isArray(answer.sources)) info.sources = ALL_SOURCES.filter((s) => answer.sources?.includes(s))
        return info
      }
    } catch {
      // not installed under this id (or asleep too long): try the next one
    }
  }
  return null
}

/**
 * Asks the extension to sync these sites. Resolves with one result per site. Rejects when the extension cannot
 * be reached, goes quiet, or refuses (the error message is 'consent' when its welcome page is not finished).
 */
export async function syncWithExtension(
  id: string,
  sources: ExtSource[],
  onProgress: (p: ExtProgress) => void,
  chrome: ChromeLike | undefined = browserChrome(),
  timeoutMs = SYNC_TIMEOUT_MS,
): Promise<ExtSyncResult> {
  const answer = await request(chrome, id, { type: 'sync', sources }, timeoutMs, onProgress)
  if (answer.type === 'error') throw new Error(String(answer.message).slice(0, 300))
  if (answer.type !== 'result') throw new Error('The extension sent an unexpected answer.')
  return { type: 'result', results: cleanResults(answer.results) }
}

/** Opens the extension's welcome page (where the student agrees to what it reads). */
export async function openExtensionWelcome(id: string, chrome: ChromeLike | undefined = browserChrome()): Promise<void> {
  await request(chrome, id, { type: 'openWelcome' }, HELLO_TIMEOUT_MS)
}

/** Asks the unpacked dev build to reload itself (the store build says no). Rejects when it refuses. */
export async function reloadExtension(id: string, chrome: ChromeLike | undefined = browserChrome()): Promise<void> {
  const answer = await request(chrome, id, { type: 'reload' }, HELLO_TIMEOUT_MS)
  if (answer.type === 'error') throw new Error(String(answer.message).slice(0, 300))
}

// ---------------------------------------------------------------- keeping the dev build up to date

/** The extension version this website was built with (from extension/manifest.json). */
export const EXTENSION_VERSION: string = manifestVersion

/** True when version `a` is older than `b` ("1.0.0" < "1.1.0" < "1.10.0"). */
export function olderVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number(n) || 0)
  const pb = b.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

/**
 * The unpacked dev build runs older code than this website expects: its files were rebuilt (npm run build:extension)
 * but Chrome keeps running the old ones until the extension reloads. The App then sends 'reload' once, so the student
 * never has to click Reload at chrome://extensions. The store build updates itself, so it is never asked.
 */
export function needsReload(info: ExtensionInfo, expected = EXTENSION_VERSION): boolean {
  return info.id === DEV_EXTENSION_ID && olderVersion(info.version, expected)
}

// The version the site last asked the dev build to reload from, in this tab (sessionStorage). The App asks once per
// version: when a reload doesn't help (the files on disk are just as old, say `npm run build:extension` wasn't run),
// asking again on every page load would only restart the extension each time. A new tab asks once more.
export const DEV_RELOAD_KEY = `${APP_SLUG}:devReloadTried`

export function reloadTried(version: string): boolean {
  try {
    return sessionStorage.getItem(DEV_RELOAD_KEY) === version
  } catch {
    return false // storage blocked: ask (it is only the dev build)
  }
}

export function markReloadTried(version: string): void {
  try {
    sessionStorage.setItem(DEV_RELOAD_KEY, version)
  } catch {
    // blocked storage: ignore
  }
}

// ---------------------------------------------------------------- one object for the App (so tests can swap it)

export interface ExtensionClient {
  detect(): Promise<ExtensionInfo | null>
  sync(id: string, sources: ExtSource[], onProgress: (p: ExtProgress) => void): Promise<ExtSyncResult>
  openWelcome(id: string): Promise<void>
  reload?(id: string): Promise<void> // dev build only (see needsReload)
}

/** The real client: looks up `chrome` at call time. */
export const browserExtension: ExtensionClient = {
  detect: () => detectExtension(browserChrome()),
  sync: (id, sources, onProgress) => syncWithExtension(id, sources, onProgress, browserChrome()),
  openWelcome: (id) => openExtensionWelcome(id, browserChrome()),
  reload: (id) => reloadExtension(id, browserChrome()),
}

// ---------------------------------------------------------------- checking what came back

/** Keeps only well-formed results. The payloads stay `unknown`: the App runs each through validatePayload. */
function cleanResults(x: unknown): ExtSourceResult[] {
  if (!Array.isArray(x)) return []
  const out: ExtSourceResult[] = []
  for (const r of x) {
    if (!r || typeof r !== 'object' || !ALL_SOURCES.includes(r.source)) continue
    const source = r.source as ExtSource
    if (r.status === 'ok') out.push({ source, status: 'ok', payload: r.payload })
    else if (r.status === 'login') out.push({ source, status: 'login', loginUrl: safeLoginUrl(source, r.loginUrl) })
    else if (r.status === 'error') {
      const message = typeof r.message === 'string' && r.message ? r.message.slice(0, 300) : 'Something went wrong.'
      out.push({ source, status: 'error', message })
    }
  }
  return out
}

/** The login link, only if it is https on that same site; otherwise the site's home page. */
export function safeLoginUrl(source: ExtSource, url: unknown): string {
  const home = LOGIN_URLS[source]
  try {
    const u = new URL(String(url))
    return u.protocol === 'https:' && u.host === new URL(home).host ? u.href : home
  } catch {
    return home
  }
}

// ---------------------------------------------------------------- small helpers the App uses

export const SITE_NAMES: Record<ExtSource, string> = { canvas: 'Canvas', gradescope: 'Gradescope', autolab: 'Autolab', sio: 'SIO' }

export const AUTO_SYNC_AFTER_MS = 10 * 60 * 1000 // auto-sync on load when the newest sync is older than this

/** True when nothing was synced yet, or the newest sync is older than 10 minutes. */
export function needsAutoSync(lastSync: Partial<Record<ExtSource, string>>, now: number): boolean {
  const times = Object.values(lastSync)
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((t) => !Number.isNaN(t))
  if (times.length === 0) return true
  return now - Math.max(...times) > AUTO_SYNC_AFTER_MS
}

/**
 * Canvas, Gradescope and SIO always; Autolab (beta) only when it was used before or the setting is on. Only sites the
 * installed extension can sync: an older version refuses a request that names a site it doesn't know.
 */
export function pickSources(hasAutolab: boolean, autolabSetting: boolean, supported: ExtSource[] = ALL_SOURCES): ExtSource[] {
  const wanted: ExtSource[] = hasAutolab || autolabSetting ? ['canvas', 'gradescope', 'autolab', 'sio'] : ['canvas', 'gradescope', 'sio']
  return wanted.filter((s) => supported.includes(s))
}

/** The sites an installed extension can sync (version 1.0.0 doesn't say, and knows no SIO). */
export function supportedSources(info: ExtensionInfo): ExtSource[] {
  return info.sources ?? SOURCES_1_0
}

/** One line under the Sync button: a site that needs a login, or something that went wrong. */
export type SyncNote =
  | { kind: 'login'; source: ExtSource; url: string }
  | { kind: 'error'; source: ExtSource | null; message: string } // source null = the whole sync failed

/**
 * The notes after syncing `synced`: notes about other sites stay (a login-only re-sync must not hide the
 * others), notes about the synced sites and whole-sync errors are replaced by `fresh`.
 */
export function mergeNotes(old: SyncNote[], synced: ExtSource[], fresh: SyncNote[]): SyncNote[] {
  return [...old.filter((n) => n.source !== null && !synced.includes(n.source)), ...fresh]
}

/** The sites that still need a login (re-synced when the student comes back to this tab). */
export function loginSources(notes: SyncNote[]): ExtSource[] {
  return notes.flatMap((n) => (n.kind === 'login' ? [n.source] : []))
}

// ---------------------------------------------------------------- the "Also sync Autolab (beta)" setting

// Kept under its own key (not in the store) because it is about the extension, not about grades. The APP_SLUG
// prefix means "Delete everything" removes it too.
export const AUTOLAB_SETTING_KEY = `${APP_SLUG}:syncAutolab`

export function getAutolabSetting(): boolean {
  try {
    return localStorage.getItem(AUTOLAB_SETTING_KEY) === '1'
  } catch {
    return false // storage blocked: the setting just isn't remembered
  }
}

export function setAutolabSetting(on: boolean): void {
  try {
    if (on) localStorage.setItem(AUTOLAB_SETTING_KEY, '1')
    else localStorage.removeItem(AUTOLAB_SETTING_KEY)
  } catch {
    // blocked storage: ignore
  }
}
