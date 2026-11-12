// The three setup steps: drag the Sync button to the bookmarks bar, then click it on Canvas and on Gradescope
// (and on Autolab, for the classes that use it).
import { useEffect, useRef } from 'react'
import { bookmarkletHref } from '../lib/bookmarklet'
import { AUTOLAB_ORIGIN, CANVAS_ORIGIN, GRADESCOPE_ORIGIN } from '../lib/brand'
import { ExternalLink } from './Link'
import { ExternalIcon, SyncIcon } from './icons'
import type { PushToast } from './Toasts'

export function SetupSteps({ toast }: { toast: PushToast }) {
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
    <>
    <ol className="steps">
      <li className="card step">
        <span className="step-num" aria-hidden="true">
          1
        </span>
        <h3>Add the Sync button</h3>
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
        <p>
          Drag this to your bookmarks bar. No bookmarks bar? Press <kbd>Cmd+Shift+B</kbd> (Mac) or{' '}
          <kbd>Ctrl+Shift+B</kbd> (Windows).
        </p>
        <p className="muted small">
          Can't drag it?{' '}
          <button type="button" className="link-btn" onClick={copyCode}>
            Copy the code
          </button>{' '}
          and paste it as a new bookmark's URL.
        </p>
      </li>
      <li className="card step">
        <span className="step-num" aria-hidden="true">
          2
        </span>
        <h3>Click it on Canvas</h3>
        <ExternalLink href={`${CANVAS_ORIGIN}/`} className="btn btn-secondary">
          Open Canvas <ExternalIcon size={14} />
        </ExternalLink>
        <p>Log in like usual, click Sync grades in your bookmarks bar, and you'll land back here with your grades.</p>
      </li>
      <li className="card step">
        <span className="step-num" aria-hidden="true">
          3
        </span>
        <h3>Click it on Gradescope</h3>
        <ExternalLink href={`${GRADESCOPE_ORIGIN}/`} className="btn btn-secondary">
          Open Gradescope <ExternalIcon size={14} />
        </ExternalLink>
        <p>
          Same thing. Not logged in to Gradescope? Open any class's Gradescope link inside Canvas first, then go to
          gradescope.com.
        </p>
        <p className="muted small">
          Classes on Autolab (like 15-122 or 15-213)? Click it on{' '}
          <ExternalLink href={`${AUTOLAB_ORIGIN}/`}>Autolab</ExternalLink> too (beta).
        </p>
      </li>
    </ol>
    <p className="setup-note muted small center">
      Using Safari and nothing happens when you click it? Turn on Develop &gt; Allow JavaScript from Smart Search Field.
    </p>
    </>
  )
}
