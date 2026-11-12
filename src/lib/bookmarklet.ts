// Helpers the app uses around the Sync bookmarklet: building the draggable javascript: link and reading the
// #sync=... fragment (the fallback when a popup blocker stops the postMessage handoff in src/ui/receive.ts).
import { BOOKMARKLET_CODE } from '../generated/bookmarklet'

// Defined next to the bookmarklet source so the bundle and the app always agree on them.
export { BOOKMARKLET_VERSION } from '../../bookmarklet/version'
export {
  isGradeSiteOrigin,
  MSG_DONE,
  MSG_READY,
  MSG_SYNC,
  RECEIVE_HASH,
  type DoneMessage,
  type IncomingMessage,
  type SyncMessage,
} from '../../bookmarklet/protocol'

/** The javascript: URL the student drags to their bookmarks bar. */
export function bookmarkletHref(siteOrigin: string): string {
  // The bundle contains the placeholder once; split/join replaces every copy just in case.
  const code = BOOKMARKLET_CODE.split('__SITE_ORIGIN__').join(siteOrigin)
  // Browsers decode a javascript: URL once before running it, so encode every special character.
  return 'javascript:' + encodeURIComponent(code)
}

/**
 * Read "#sync=<payload>&bv=<version>" (leading "#" optional).
 * Returns null when the fragment is not a sync link. version is null for links without bv.
 */
export function parseSyncFragment(hash: string): { payload: string; version: number | null } | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  if (!h.startsWith('sync=')) return null
  const parts = h.slice('sync='.length).split('&')
  const payload = parts[0]
  if (!payload) return null
  let version: number | null = null
  for (const part of parts.slice(1)) {
    if (part.startsWith('bv=') && /^\d+$/.test(part.slice(3))) version = Number(part.slice(3))
  }
  return { payload, version }
}
