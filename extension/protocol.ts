// Messages between the GradeCrunch website and the GradeCrunch Chrome extension. Shared by both sides.
//
// The website opens a port with chrome.runtime.connect(<extension id>, { name: EXT_PORT_NAME }). Chrome only allows
// this from the origins listed under "externally_connectable" in extension/manifest.json (our own site), so no other
// website can ask the extension for grades. The website sends ONE request per port and gets back messages until the
// final one ('hello', 'result' or 'error'), then the port closes.
//
//   website                                   extension (service worker + offscreen document)
//   { type: 'hello' }                 ----->   { type: 'hello', version, consent }
//   { type: 'sync', sources }         ----->   { type: 'progress', source, message }   (any number)
//                                     <-----   { type: 'result', results: [...] }      (one per requested source)
//   { type: 'openWelcome' }           ----->   opens the extension's welcome page; replies { type: 'hello', ... }

export const EXT_PORT_NAME = 'gradecrunch'

/** Extension ids the website will try, in order. The dev id comes from the "key" in the dev manifest; add the Chrome
 *  Web Store id here once the extension is published (the store assigns its own id). */
export const KNOWN_EXTENSION_IDS: string[] = ['ammnjhfalihccnpglfookiiebpiaoeak']

export type ExtSource = 'canvas' | 'gradescope' | 'autolab'

export type ExtRequest =
  | { type: 'hello' }
  | { type: 'sync'; sources: ExtSource[] }
  | { type: 'openWelcome' }

export interface ExtHello {
  type: 'hello'
  version: string // manifest version, e.g. "1.0.0"
  consent: boolean // false until the student clicked Continue on the extension's welcome page
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
}
