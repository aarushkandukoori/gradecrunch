// The message protocol between the Sync bookmarklet (running on Canvas / Gradescope / Autolab / SIO) and the
// GradeCrunch tab it opens. Shared by both sides (the app imports it through src/lib/bookmarklet.ts), so the
// message names are defined in exactly one place.
//
//   bookmarklet tab                                   GradeCrunch tab (opened at <site>/#receive)
//   window.open(<site>/#receive)  ------------------>  starts up
//                                 <------------------  { type: 'gradecrunch:ready' }  (repeated until data arrives)
//   { type: 'gradecrunch:sync', payload, bv }  ----->  imports the grades
//                                 <------------------  { type: 'gradecrunch:done', ok, message? }
//
// Why not just put the grades in the URL (#sync=...)? A URL stays in browser history (and Chrome syncs
// history to Google). postMessage hands the data straight to the other tab and leaves no trace. The URL
// fragment is still the fallback when the popup is blocked.

export const RECEIVE_HASH = '#receive' // the receiver tab's URL is siteOrigin + '/' + RECEIVE_HASH
export const MSG_READY = 'gradecrunch:ready'
export const MSG_SYNC = 'gradecrunch:sync'
export const MSG_DONE = 'gradecrunch:done'

/**
 * Longest `payload` string the app accepts in a sync message. The app refuses anything that unzips to more than
 * 10 MB (MAX_DECODED_BYTES in src/lib/payload.ts), and 10 MB written as base64url is about 13.4 million characters,
 * so a bigger string could never be valid anyway. Syllabus PDFs (up to 5 MB per sync) fit comfortably.
 */
export const MAX_MESSAGE_CHARS = 14_000_000

/** Bookmarklet -> app: the grades, encoded with encodePayload, plus the bookmarklet version. */
export interface SyncMessage {
  type: typeof MSG_SYNC
  payload: string
  bv: number
}

/** App -> bookmarklet: whether the import worked, and why not. */
export interface DoneMessage {
  type: typeof MSG_DONE
  ok: boolean
  message?: string
}

/** The parts of a 'message' event both sides look at. */
export interface IncomingMessage {
  source: unknown // the window that sent it
  origin: string // the sender's origin, filled in by the browser (the sender cannot fake it)
  data: unknown
}

export type Site = 'canvas' | 'gradescope' | 'autolab' | 'sio'

/** Which grade site a hostname belongs to, or null for anything else (exact matches only). */
export function detectSite(hostname: string): Site | null {
  const host = hostname.toLowerCase()
  if (host === 'canvas.cmu.edu' || host === 'cmu.instructure.com') return 'canvas'
  if (host === 'www.gradescope.com' || host === 'gradescope.com') return 'gradescope'
  if (host === 'autolab.andrew.cmu.edu') return 'autolab'
  if (host === 's3.andrew.cmu.edu') return 'sio'
  return null
}

/** True for an https origin of a site the bookmarklet runs on. The app only accepts grades from these. */
export function isGradeSiteOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' && url.origin === origin && detectSite(url.hostname) !== null
  } catch {
    return false // not a URL at all (e.g. "null" from a sandboxed frame)
  }
}
