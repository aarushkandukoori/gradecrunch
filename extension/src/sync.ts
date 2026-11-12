// Runs the website's existing sync code (src/sync/*) from inside the extension. The only difference from the
// bookmarklet is how pages are fetched: the bookmarklet runs ON the grade site and uses relative URLs, while the
// extension's offscreen page lives at chrome-extension://... and must use full URLs. Because the extension has host
// permissions for the three grade sites, Chrome sends the student's own cookies with these requests.
import type { ExtSource, ExtSourceResult } from '../protocol'
import { AUTOLAB_ORIGIN, CANVAS_ORIGIN, GRADESCOPE_ORIGIN } from '../../src/lib/brand'
import { absoluteFetcher, syncCanvas } from '../../src/sync/canvas'
import { syncGradescope } from '../../src/sync/gradescope'
import { syncAutolab } from '../../src/sync/autolab'
import { resultFromError } from './rules'

/**
 * The full URL for a path on one grade site. The paths come from links in pages we parsed, so this refuses anything
 * that would land on another host (for example "@evil.com" or "//evil.com"), even though the sync code already only
 * follows "/courses/..." links. The student's cookies go with these requests, so they must stay on the grade site.
 */
export function siteUrl(origin: string, path: string): string {
  const url = new URL(path, origin)
  if (!path.startsWith('/') || url.origin !== origin) throw new Error('Refused to fetch ' + path + ': not on ' + origin)
  return url.href
}

/**
 * Gradescope pages are HTML. If Gradescope bounced us to another site (a login page), the student is logged out.
 * Same error text as the sync code, so resultFromError turns it into a 'login' result.
 */
export async function gradescopeFetchText(path: string): Promise<string> {
  const res = await fetch(siteUrl(GRADESCOPE_ORIGIN, path), { credentials: 'include' })
  if (!res.ok) throw new Error('Gradescope returned an error (' + res.status + ') for ' + path)
  if (res.url && new URL(res.url).origin !== GRADESCOPE_ORIGIN) throw new Error('Log in to Gradescope first')
  return res.text()
}

/**
 * Autolab pages are HTML too. syncAutolab also needs the final URL after redirects, because a redirect to
 * /auth/... means the session ran out. A redirect off Autolab entirely (to CMU's login) means the same thing.
 */
export async function autolabFetchPage(path: string): Promise<{ html: string; url: string }> {
  const res = await fetch(siteUrl(AUTOLAB_ORIGIN, path), { credentials: 'include' })
  if (!res.ok) throw new Error('Autolab returned an error (' + res.status + ') for ' + path)
  if (res.url && new URL(res.url).origin !== AUTOLAB_ORIGIN) throw new Error('Log in to Autolab first')
  return { html: await res.text(), url: res.url || AUTOLAB_ORIGIN + path }
}

/**
 * Sync one site and describe the outcome as an ExtSourceResult. Never throws: every failure becomes a 'login' or
 * 'error' result so the website always gets one answer per site.
 * Gradescope keeps its built-in one-page-a-second pace (GRADESCOPE_PAUSE_MS inside syncGradescope).
 */
export async function runSource(source: ExtSource, onProgress: (message: string) => void): Promise<ExtSourceResult> {
  try {
    let payload
    if (source === 'canvas') payload = await syncCanvas(absoluteFetcher(CANVAS_ORIGIN), onProgress)
    else if (source === 'gradescope') payload = await syncGradescope(gradescopeFetchText, onProgress)
    else payload = await syncAutolab(autolabFetchPage, onProgress)
    return { source, status: 'ok', payload }
  } catch (err) {
    return resultFromError(source, err)
  }
}
