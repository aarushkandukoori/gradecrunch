// How grades get here. Today that is the Sync bookmarklet: drag it to the bookmarks bar, then click it on Canvas
// and Gradescope. This is the only place that explains it, so a future "Add to Chrome" button can replace
// <ConnectCard /> and <ConnectTrouble /> without touching the rest of the welcome page.
import { useEffect, useRef } from 'react'
import { bookmarkletHref } from '../lib/bookmarklet'
import { AUTOLAB_ORIGIN, CANVAS_ORIGIN, GRADESCOPE_ORIGIN } from '../lib/brand'
import { ExternalLink } from './Link'
import { SyncIcon } from './icons'
import type { PushToast } from './Toasts'

/** The one card: the Sync button and two numbered steps. */
export function ConnectCard({ toast }: { toast: PushToast }) {
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
    <section className="card connect-card" aria-label="Get your grades">
      <a
        ref={linkRef}
        className="bookmarklet"
        draggable="true"
        title="Drag me to your bookmarks bar"
        onClick={(e) => {
          // Clicking it here does nothing useful: it has to run on Canvas or Gradescope.
          e.preventDefault()
          toast('Drag it to your bookmarks bar instead')
        }}
      >
        <SyncIcon size={18} />
        Sync grades
      </a>
      <ol className="connect-steps">
        <li>Drag it to your bookmarks bar</li>
        <li>
          Click it on <ExternalLink href={`${CANVAS_ORIGIN}/`}>Canvas</ExternalLink>, then on{' '}
          <ExternalLink href={`${GRADESCOPE_ORIGIN}/`}>Gradescope</ExternalLink>
        </li>
      </ol>
    </section>
  )
}

/** "Trouble?": the fallbacks and edge cases, folded away. */
export function ConnectTrouble({ toast }: { toast: PushToast }) {
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
