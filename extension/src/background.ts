/// <reference path="./chrome.d.ts" />
// The extension's service worker: the part that is always installed and wakes up on events.
//   - The GradeCrunch website connects to it (externally_connectable) and asks for 'hello', 'sync' or 'openWelcome'.
//   - For a sync it opens the hidden offscreen page, which runs the real sync code (it needs DOMParser), relays the
//     progress lines to the website, then sends one 'result' with an answer per site.
//   - It also opens the welcome page on install and the website when the toolbar button is clicked.
// Chrome requires every listener to be registered at the top level of this file, which is why they are all down here.
import { EXT_PORT_NAME, type ExtProgress, type ExtRequest, type ExtResponse, type ExtSource, type ExtSourceResult } from '../protocol'
import {
  CONSENT_KEY,
  OFFSCREEN_PATH,
  PDF_ORIGINS,
  SITE_URL,
  isAllowedOrigin,
  isOffscreenProgress,
  isSourceResultFor,
  lastResultKey,
  parseRequest,
  resultForStorage,
  resultFromError,
  type OffscreenSyncRequest,
} from './rules'

type Send = (message: ExtResponse) => void

// ---------------------------------------------------------------- the website's port

chrome.runtime.onConnectExternal.addListener((port) => {
  // Chrome already lets only our own site connect (manifest "externally_connectable"); check again here anyway.
  const patterns = chrome.runtime.getManifest().externally_connectable?.matches ?? []
  if (port.name !== EXT_PORT_NAME || !isAllowedOrigin(port.sender?.origin, patterns)) {
    port.disconnect()
    return
  }

  let open = true
  port.onDisconnect.addListener(() => {
    open = false // the website tab closed or navigated away; a running sync still finishes and saves its result
  })
  const send: Send = (message) => {
    if (!open) return
    try {
      port.postMessage(message)
    } catch {
      open = false
    }
  }

  let answered = false
  port.onMessage.addListener((message) => {
    if (answered) return // one request per port (see protocol.ts)
    answered = true
    handleRequest(parseRequest(message), port.sender?.tab?.id, send)
      .catch((err) => send({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        // The final message is sent: close the port so the website knows we are done.
        if (open) port.disconnect()
        open = false
      })
  })
})

async function handleRequest(request: ExtRequest | null, tabId: number | undefined, send: Send): Promise<void> {
  if (!request) return send({ type: 'error', message: 'Unknown request' })
  if (request.type === 'hello') return send(await hello())
  if (request.type === 'openWelcome') {
    await openWelcome(tabId)
    return send(await hello())
  }
  // request.type === 'sync'
  if (!(await hasConsent())) return send({ type: 'error', message: 'consent' })
  // Each site runs on its own, so Canvas and Gradescope sync at the same time.
  const results = await Promise.all(request.sources.map((source) => syncSource(source, send)))
  send({ type: 'result', results })
}

async function hello(): Promise<ExtResponse> {
  return { type: 'hello', version: chrome.runtime.getManifest().version, consent: await hasConsent() }
}

async function hasConsent(): Promise<boolean> {
  const stored = await chrome.storage.local.get(CONSENT_KEY)
  return stored[CONSENT_KEY] === true
}

/** Open the welcome page. `tabId` is the website's tab, so the welcome page can switch back to it afterwards. */
async function openWelcome(tabId?: number): Promise<void> {
  const query = tabId === undefined ? '' : '?tab=' + tabId
  await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') + query })
}

// ---------------------------------------------------------------- one sync per site at a time

interface Job {
  promise: Promise<ExtSourceResult>
  listeners: Set<(progress: ExtProgress) => void> // one per website port waiting on this site
}

/** Syncs running right now, by site. If the website asks for a site that is already syncing (two tabs, a double
 *  click), the second request joins the running sync instead of hitting the site twice. */
const jobs = new Map<ExtSource, Job>()

function syncSource(source: ExtSource, send: Send): Promise<ExtSourceResult> {
  let job = jobs.get(source)
  if (!job) {
    const promise = runJob(source).finally(() => jobs.delete(source))
    job = { promise, listeners: new Set() }
    jobs.set(source, job)
  }
  const listeners = job.listeners
  const listener = (progress: ExtProgress) => send(progress)
  listeners.add(listener)
  return job.promise.finally(() => listeners.delete(listener))
}

/** Ask the offscreen page to sync one site. Never throws: problems become an 'error' result. */
async function runJob(source: ExtSource): Promise<ExtSourceResult> {
  jobStarted()
  let result: ExtSourceResult
  try {
    await ensureOffscreen()
    // The offscreen page cannot use chrome.permissions, so we check here whether it may download syllabus PDFs.
    const pdfs = source === 'canvas' && (await canReadPdfs())
    const request: OffscreenSyncRequest = { target: 'offscreen', type: 'sync', source, pdfs }
    const answer = await chrome.runtime.sendMessage(request)
    result = isSourceResultFor(answer, source) ? answer : { source, status: 'error', message: 'The sync page gave no answer' }
  } catch (err) {
    result = resultFromError(source, err)
  }
  jobFinished()
  if (result.status === 'ok') await saveLastResult(result)
  return result
}

/** True when the student allowed reading syllabus PDFs (the optional host permission from the welcome page). */
async function canReadPdfs(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: PDF_ORIGINS })
  } catch {
    return false
  }
}

/** Keep the last good grades per site, so the website can be told about them later without a new sync.
 *  Only 'ok' results: a failed sync should not wipe the last good copy. */
async function saveLastResult(result: ExtSourceResult): Promise<void> {
  try {
    await chrome.storage.local.set({
      [lastResultKey(result.source)]: { at: new Date().toISOString(), result: resultForStorage(result) },
    })
  } catch {
    // Storage full or unavailable: the website still gets the result, we just do not keep a copy.
  }
}

// Progress lines from the offscreen page go to every website port waiting on that site.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || !isOffscreenProgress(message)) return undefined
  const progress: ExtProgress = { type: 'progress', source: message.source, message: message.message }
  jobs.get(message.source)?.listeners.forEach((listener) => listener(progress))
  return undefined
})

// ---------------------------------------------------------------- offscreen page + keepalive

let running = 0 // how many site syncs are in progress
let offscreenReady: Promise<void> | null = null // set while the offscreen page is open (or opening)
let closing: Promise<void> = Promise.resolve() // set while the offscreen page is closing
let keepAlive: ReturnType<typeof setInterval> | undefined

/** Chrome stops an idle service worker after about 30 seconds. A cheap extension API call every 20 seconds
 *  counts as activity, so a long Gradescope sync (one page a second) is not cut off halfway. */
function jobStarted() {
  running++
  if (keepAlive === undefined) keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000)
}

function jobFinished() {
  running--
  if (running > 0) return
  clearInterval(keepAlive)
  keepAlive = undefined
  // Nothing left to do: close the offscreen page so it does not sit in memory.
  if (offscreenReady) {
    offscreenReady = null
    closing = chrome.offscreen.closeDocument().catch(() => {})
  }
}

/** Make sure exactly one offscreen page is open (Chrome allows only one per extension). */
async function ensureOffscreen(): Promise<void> {
  await closing // if the last sync just closed it, wait for that to finish before opening a new one
  if (!offscreenReady) offscreenReady = openOffscreen()
  try {
    await offscreenReady
  } catch (err) {
    offscreenReady = null // let the next sync try again
    throw err
  }
}

async function openOffscreen(): Promise<void> {
  // After a service worker restart our variables are empty, but the page may still be open from before.
  const url = chrome.runtime.getURL(OFFSCREEN_PATH)
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })
  if (existing.length > 0) return
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['DOM_PARSER'],
    justification: 'Reads your Gradescope and Autolab grade pages (HTML) so GradeCrunch can show your grades.',
  })
}

// ---------------------------------------------------------------- install + toolbar button

chrome.runtime.onInstalled.addListener((details) => {
  // First install only (not updates): show what the extension reads before it does anything.
  if (details.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') })
})

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: SITE_URL })
})
