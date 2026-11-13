// Messages between the GradeCrunch website and the GradeCrunch Chrome extension. Shared by both sides.
//
// The website opens a port with chrome.runtime.connect(<extension id>, { name: EXT_PORT_NAME }). Chrome only allows
// this from the origins listed under "externally_connectable" in extension/manifest.json (our own site), so no other
// website can ask the extension for grades. The website sends ONE request per port and gets back messages until the
// final one ('hello', 'result' or 'error'), then the port closes.
//
//   website                                   extension (service worker + offscreen document)
//   { type: 'hello' }                 ----->   { type: 'hello', version, consent, sources }
//   { type: 'sync', sources }         ----->   { type: 'progress', source, message }   (any number)
//                                     <-----   { type: 'result', results: [...] }      (one per requested source)
//   { type: 'openWelcome' }           ----->   opens the extension's welcome page; replies { type: 'hello', ... }
//   { type: 'reload' }                ----->   unpacked dev build only: replies { type: 'hello', ... }, then reloads
//                                              itself (picks up a rebuilt dist-extension/). The store build answers
//                                              { type: 'error', message: 'Unknown request' }. The website sends it
//                                              when the dev build is older than the extension version it was built
//                                              with (see needsReload in src/lib/extension.ts).

export const EXT_PORT_NAME = 'gradecrunch'

/** The unpacked dev build's id. It comes from the "key" in extension/manifest.json, so it never changes. */
export const DEV_EXTENSION_ID = 'ammnjhfalihccnpglfookiiebpiaoeak'

/** Extension ids the website will try, in order. Add the Chrome Web Store id here once the extension is published
 *  (the store assigns its own id). */
export const KNOWN_EXTENSION_IDS: string[] = [DEV_EXTENSION_ID]

export type ExtSource = 'canvas' | 'gradescope' | 'autolab' | 'sio'

/** Every site this version of the extension can sync, in a fixed order. */
export const ALL_SOURCES: ExtSource[] = ['canvas', 'gradescope', 'autolab', 'sio']

/** What version 1.0.0 could sync. Its hello has no `sources` list, so the website assumes these. */
export const SOURCES_1_0: ExtSource[] = ['canvas', 'gradescope', 'autolab']

export type ExtRequest =
  | { type: 'hello' }
  | { type: 'sync'; sources: ExtSource[] }
  | { type: 'openWelcome' }
  | { type: 'reload' }

export interface ExtHello {
  type: 'hello'
  version: string // manifest version, e.g. "1.1.0"
  consent: boolean // false until the student clicked Continue on the extension's welcome page
  sources?: ExtSource[] // the sites it can sync (missing before 1.1.0); the website only asks for these
}

export interface ExtProgress {
  type: 'progress'
  source: ExtSource
  message: string // e.g. "Canvas: 3 of 8 courses"
}

/** What happened for one site. payload is a SyncPayload object (same shape the bookmarklet produces); the website must
 *  still run it through validatePayload because it crossed a trust boundary. */
export type ExtSourceResult =
  | { source: ExtSource; status: 'ok'; payload: unknown }
  | { source: ExtSource; status: 'login'; loginUrl: string } // not logged in to that site: open loginUrl, then sync again
  | { source: ExtSource; status: 'error'; message: string }

export interface ExtSyncResult {
  type: 'result'
  results: ExtSourceResult[]
}

export interface ExtError {
  type: 'error'
  message: string // 'consent' when the student hasn't finished the welcome page; otherwise a readable message
}

export type ExtResponse = ExtHello | ExtProgress | ExtSyncResult | ExtError

/** Where to send a student who must log in first. */
export const LOGIN_URLS: Record<ExtSource, string> = {
  canvas: 'https://canvas.cmu.edu/',
  gradescope: 'https://www.gradescope.com/',
  autolab: 'https://autolab.andrew.cmu.edu/',
  sio: 'https://s3.andrew.cmu.edu/sio/mpa/grades/home',
}
