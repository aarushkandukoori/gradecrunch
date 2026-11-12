// The home page before any grades exist: a headline, the one card that connects your grades, a demo link and a
// privacy line. Also reused (with a different headline) as the /setup page.
import { useState } from 'react'
import { BOOKMARKLET_VERSION } from '../lib/bookmarklet'
import type { ManualCourse } from '../types'
import { AddClassDialog } from './AddClassDialog'
import { ConnectCard, ConnectTrouble } from './ConnectCard'
import type { ExtensionView } from './ExtensionBits'
import { ChevronIcon } from './icons'
import { NavLink, type Navigate } from './Link'
import type { PushToast } from './Toasts'

interface Props {
  mode: 'welcome' | 'setup'
  navigate: Navigate
  toast: PushToast
  term: string | null
  onDemo: () => void
  onAddManual: (course: ManualCourse) => void
  onBack?: () => void // on /setup once there are grades: a way back to them
  ext: ExtensionView | null // the Chrome extension, or null when it is not installed
}

export function Welcome(p: Props) {
  const [adding, setAdding] = useState(false)

  return (
    <div className="welcome">
      {p.mode === 'setup' && p.onBack && (
        <button type="button" className="back-btn" onClick={p.onBack}>
          <ChevronIcon size={16} className="back-chev" /> My grades
        </button>
      )}
      {p.mode === 'welcome' ? (
        <section className="hero">
          <h1>All your CMU grades in one place.</h1>
          <p className="lead">Your Canvas and Gradescope scores, merged per class, with your QPA.</p>
        </section>
      ) : p.ext ? (
        <section className="hero">
          <h1>Sync your grades</h1>
          <p className="lead">The GradeCrunch extension is installed. One click brings your grades here.</p>
        </section>
      ) : (
        <section className="hero">
          <h1>Set up the Sync button</h1>
          <p className="lead">Once. After that, one click on Canvas or Gradescope brings your grades here.</p>
        </section>
      )}

      <ConnectCard toast={p.toast} ext={p.ext} />

      <div className="welcome-links">
        {p.mode === 'welcome' && (
          <button type="button" className="link-btn" onClick={p.onDemo}>
            See a demo
          </button>
        )}
        <button type="button" className="link-btn" onClick={() => setAdding(true)}>
          Add a class by hand
        </button>
      </div>

      {!p.ext && <ConnectTrouble toast={p.toast} />}

      <p className="privacy-line muted small">
        Your grades stay in this browser. Nothing goes to a server.{' '}
        <NavLink to="privacy" navigate={p.navigate}>
          Privacy
        </NavLink>
        {p.mode === 'setup' &&
          (p.ext ? <> · Extension version {p.ext.version}</> : <> · Sync button version {BOOKMARKLET_VERSION}</>)}
      </p>

      <AddClassDialog open={adding} onClose={() => setAdding(false)} term={p.term} onAdd={p.onAddManual} />
    </div>
  )
}
