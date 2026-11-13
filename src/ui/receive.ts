// How grades get from the Sync button into this app.
//
// Main path (postMessage): the bookmarklet, running on Canvas / Gradescope / Autolab / SIO, opens this site at
// /#receive in a new tab. This tab says "ready" to the tab that opened it (window.opener), the bookmarklet
// answers with the grades, and we reply "done". The grades never appear in a URL, so they never land in
// browser history. The message names live in bookmarklet/protocol.ts, shared with the bookmarklet.
//
// Fallback (#sync= link): when a popup blocker stops the new tab, the bookmarklet navigates to /#sync=<grades>.
// Anyone can make such a link, so an old one asks before replacing anything (see syncLinkIsStale).
import { MAX_MESSAGE_CHARS, MSG_DONE, MSG_READY, MSG_SYNC, type DoneMessage, type IncomingMessage } from '../lib/bookmarklet'
import { decodePayload } from '../lib/payload'
import type { SyncPayload } from '../types'

/** The only origins we accept grades from, and which site each one is. Exact matches, https only. */
export const SYNC_ORIGINS: Record<string, SyncPayload['kind']> = {
  'https://canvas.cmu.edu': 'canvas',
  'https://cmu.instructure.com': 'canvas',
  'https://www.gradescope.com': 'gradescope',
  'https://gradescope.com': 'gradescope',
  'https://autolab.andrew.cmu.edu': 'autolab',
  'https://s3.andrew.cmu.edu': 'sio',
}

export const READY_EVERY_MS = 250 // how often we say "ready" until the grades arrive
export const READY_TRIES = 60 // give up saying "ready" after 60 tries (15 seconds)
// Refuse anything bigger before decoding. Shared with the bookmarklet, which leaves syllabus PDFs out to stay under it.
export const MAX_PAYLOAD_CHARS = MAX_MESSAGE_CHARS

/** The bits of the browser the receiver uses. Passed in so tests can fake them. */
export interface ReceiverDeps {
  opener: { postMessage: (message: unknown, targetOrigin: string) => void } | null
  listen: (handler: (event: IncomingMessage) => void) => () => void // returns "stop listening"
  every: (ms: number, fn: () => void) => () => void // returns "stop repeating"
}

/** The real browser versions of ReceiverDeps. */
export function browserReceiverDeps(): ReceiverDeps {
  return {
    opener: (window.opener as ReceiverDeps['opener']) ?? null,
    listen: (handler) => {
      const onMessage = (e: MessageEvent) => handler({ source: e.source, origin: e.origin, data: e.data })
      window.addEventListener('message', onMessage)
      return () => window.removeEventListener('message', onMessage)
    },
    every: (ms, fn) => {
      const id = setInterval(fn, ms)
      return () => clearInterval(id)
    },
  }
}

/**
 * Starts listening for grades from the tab that opened this one. `onSync` gets the decoded payload and the
 * bookmarklet version (null if missing); if it throws, the bookmarklet is told why.
 * Returns a function that stops everything, or null when there is no opener (nothing to talk to).
 */
export function startReceiver(
  deps: ReceiverDeps,
  onSync: (payload: SyncPayload, version: number | null) => void,
): (() => void) | null {
  const opener = deps.opener
  if (!opener) return null
  let received = false
  let tries = 0
  let stopReady = () => {}

  // "ready" carries no data, so '*' is fine: we don't know yet which grade site opened us.
  const sayReady = () => {
    tries++
    opener.postMessage({ type: MSG_READY }, '*')
    if (tries >= READY_TRIES) stopReady()
  }
  sayReady()
  stopReady = deps.every(READY_EVERY_MS, sayReady)

  const stopListening = deps.listen((event) => {
    if (received) return
    // Only the tab that opened us, and only when it is one of the grade sites. Any other page could post a
    // message that looks like grades.
    const site = SYNC_ORIGINS[event.origin]
    if (event.source !== opener || !site) return
    const data = event.data as { type?: unknown; payload?: unknown; bv?: unknown } | null
    if (!data || typeof data !== 'object' || data.type !== MSG_SYNC) return
    if (typeof data.payload !== 'string') return
    if (data.payload.length >= MAX_PAYLOAD_CHARS) {
      // Say so instead of staying quiet, or the Sync button would wait for an answer that never comes.
      const tooBig: DoneMessage = { type: MSG_DONE, ok: false, message: 'Those grades were too big to send. Click Sync again.' }
      opener.postMessage(tooBig, event.origin)
      return
    }
    received = true
    stopReady()
    const version = typeof data.bv === 'number' && Number.isInteger(data.bv) ? data.bv : null

    const reply = (done: DoneMessage) => {
      opener.postMessage(done, event.origin) // back to exactly the site that sent the grades
      stopListening()
    }
    decodePayload(data.payload)
      .then((payload) => {
        // Canvas can only send Canvas grades, and so on: a page can't pass off one site's data as another's.
        if (payload.kind !== site) throw new Error(`Got ${payload.kind} grades from ${event.origin}.`)
        onSync(payload, version)
        reply({ type: MSG_DONE, ok: true })
      })
      .catch((err: unknown) => {
        reply({ type: MSG_DONE, ok: false, message: err instanceof Error ? err.message : String(err) })
      })
  })

  return () => {
    stopReady()
    stopListening()
  }
}

/** How old a #sync= link may be before we ask first. A real sync opens the link within seconds. */
export const STALE_LINK_MS = 15 * 60_000

/**
 * True when a #sync= link's time is more than 15 minutes away from now (or missing / unreadable). Such a link
 * came from browser history or from someone else, so we ask before it replaces the student's grades.
 */
export function syncLinkIsStale(at: string, now: number): boolean {
  const t = Date.parse(at)
  return Number.isNaN(t) || Math.abs(now - t) > STALE_LINK_MS
}
