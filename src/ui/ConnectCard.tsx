// How grades get here, on the welcome page. Three cases:
//   1. The GradeCrunch Chrome extension is installed: one big "Sync my grades" button (or "Finish setup" first).
//   2. Not installed and the extension is on the Chrome Web Store: an "Add to Chrome" button; the Sync bookmarklet
//      moves into "Trouble?" as the fallback.
//   3. Not installed and not published yet (CHROME_STORE_URL is empty): the Sync bookmarklet, as before.
import { useEffect, useRef } from 'react'
import { bookmarkletHref } from '../lib/bookmarklet'
import { AUTOLAB_ORIGIN, CANVAS_ORIGIN, CHROME_STORE_URL, GRADESCOPE_ORIGIN, SIO_GRADES_URL } from '../lib/brand'
import { FinishSetup, SyncNotes, type ExtensionView } from './ExtensionBits'
import { ExternalLink } from './Link'
import { SyncIcon } from './icons'
import type { PushToast } from './Toasts'

interface Props {
  toast: PushToast
  ext: ExtensionView | null // null = the extension is not installed (or this is not Chrome)
  storeUrl?: string // the Chrome Web Store link; a prop so tests can try both cases
}

/** The one card on the welcome page. */
export function ConnectCard({ toast, ext, storeUrl = CHROME_STORE_URL }: Props) {
  if (ext && !ext.consent) {
    return (
      <section className="card connect-card" aria-label="Get your grades">
        <FinishSetup onOpenWelcome={ext.onOpenWelcome} />
      </section>
    )
  }

  if (ext) {
    return (
      <section className="card connect-card" aria-label="Get your grades">
        <button type="button" className="big-btn" onClick={ext.onSync} disabled={ext.syncing}>
          <SyncIcon size={18} className={ext.syncing ? 'spin' : undefined} />
          {ext.syncing ? 'Syncing…' : 'Sync my grades'}
        </button>
        {ext.syncing && ext.progress && <p className="muted small" aria-live="polite">{ext.progress}</p>}
        <SyncNotes notes={ext.notes} />
      </section>
    )
  }

  if (storeUrl) {
    return (
      <section className="card connect-card" aria-label="Get your grades">
        <ExternalLink href={storeUrl} className="big-btn">
          Add to Chrome
        </ExternalLink>
        <p className="muted">Then come back here and click Sync my grades.</p>
      </section>
    )
  }

  return (
    <section className="card connect-card" aria-label="Get your grades">
      <BookmarkletButton toast={toast} />
      <ol className="connect-steps">
        <li>Drag it to your bookmarks bar</li>
        <li>
          Click it on <ExternalLink href={`${CANVAS_ORIGIN}/`}>Canvas</ExternalLink>, then on{' '}
          <ExternalLink href={`${GRADESCOPE_ORIGIN}/`}>Gradescope</ExternalLink> and{' '}
          <ExternalLink href={SIO_GRADES_URL}>SIO</ExternalLink>
        </li>
      </ol>
      <p className="muted small">A Chrome extension is coming soon.</p>
    </section>
  )
}

/** The draggable Sync bookmarklet. */
function BookmarkletButton({ toast, small = false }: { toast: PushToast; small?: boolean }) {
  const linkRef = useRef<HTMLAnchorElement>(null)

  // React 19 refuses to render javascript: URLs in href (a good default against injected links), so we set this
  // one, which is our own code, directly on the DOM element after it mounts. React never touches it again because
  // we pass no href prop.
  useEffect(() => {
    try {
      linkRef.current?.setAttribute('href', bookmarkletHref(window.location.origin))
    } catch (err) {
      console.error('Could not build the Sync button', err)
    }
  }, [])

  return (
    <a
      ref={linkRef}
      className={small ? 'bookmarklet bookmarklet-sm' : 'bookmarklet'}
      draggable="true"
      title="Drag me to your bookmarks bar"
      onClick={(e) => {
        // Clicking it here does nothing useful: it has to run on Canvas or Gradescope.
        e.preventDefault()
        toast('Drag it to your bookmarks bar instead')
      }}
    >
      <SyncIcon size={small ? 14 : 18} />
      Sync grades
    </a>
  )
}

/** "Trouble?": the fallbacks and edge cases, folded away. Not shown when the extension is installed. */
export function ConnectTrouble({ toast, storeUrl = CHROME_STORE_URL }: { toast: PushToast; storeUrl?: string }) {
  // For browsers where dragging is awkward (phones, some setups): copy the code, then paste it as a bookmark's URL.
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(bookmarkletHref(window.location.origin))
      toast('Copied. Make a new bookmark and paste this as its URL (address).')
    } catch {
      toast("Couldn't copy. Drag the button to your bookmarks bar instead.", { tone: 'error' })
    }
  }

  return (
    <details className="trouble">
      <summary>Trouble?</summary>
      <ul>
        {storeUrl && (
          // With the extension as the main way in, the bookmarklet is the fallback (Safari, Firefox, school laptops).
          <li>
            Not on Chrome, or can't add extensions? Drag <BookmarkletButton toast={toast} small /> to your bookmarks
            bar, then click it on Canvas, Gradescope and SIO.
          </li>
        )}
        <li>
          No bookmarks bar? Press <kbd>Cmd+Shift+B</kbd> (Mac) or <kbd>Ctrl+Shift+B</kbd> (Windows).
        </li>
        <li>
          Can't drag it?{' '}
          <button type="button" className="link-btn" onClick={copyCode}>
            Copy the code
          </button>{' '}
          and paste it as a new bookmark's URL.
        </li>
        <li>Not logged in to Gradescope? Open any class's Gradescope link inside Canvas first.</li>
        <li>
          Classes on Autolab (like 15-122 or 15-213)? Click it on{' '}
          <ExternalLink href={`${AUTOLAB_ORIGIN}/`}>Autolab</ExternalLink> too (beta).
        </li>
        <li>Safari and nothing happens? Turn on Develop &gt; Allow JavaScript from Smart Search Field.</li>
      </ul>
    </details>
  )
}
