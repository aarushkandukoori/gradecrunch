// The home page before any grades exist: headline, the three setup steps, manual add and the
// privacy promise. Also reused (without the headline) as the /setup page.
import { BOOKMARKLET_VERSION } from '../lib/bookmarklet'
import { REPO_URL } from '../lib/brand'
import type { ManualCourse } from '../types'
import { ExternalLink, NavLink, type Navigate } from './Link'
import { ManualCourseForm } from './ManualCourseForm'
import { SetupSteps } from './SetupSteps'
import type { PushToast } from './Toasts'
import { LockIcon } from './icons'

interface Props {
  mode: 'welcome' | 'setup'
  navigate: Navigate
  toast: PushToast
  term: string | null
  onDemo: () => void
  onAddManual: (course: ManualCourse) => void
}

export function Welcome(p: Props) {
  return (
    <div className="welcome">
      {p.mode === 'welcome' ? (
        <section className="hero">
          <h1>All your CMU grades and your QPA, in one place.</h1>
          <p className="lead">
            Pulls your scores from Canvas and Gradescope, fixes the weights, and tells you what you need on the rest of
            the semester. Runs entirely in your browser.
          </p>
          <p className="hero-actions">
            <button type="button" className="btn btn-secondary" onClick={p.onDemo}>
              See a demo with sample grades
            </button>
          </p>
        </section>
      ) : (
        <section className="page-head">
          <h1>Setup</h1>
          <p className="lead">Two minutes, once. After that, one click on Canvas or Gradescope brings your grades here.</p>
        </section>
      )}

      <SetupSteps toast={p.toast} />

      <details className="card disclosure">
        <summary>Class graded somewhere else? Add it by hand</summary>
        <div className="disclosure-body">
          <ManualCourseForm term={p.term} onAdd={p.onAddManual} />
        </div>
      </details>

      {p.mode === 'setup' && <p className="muted small center">Your Sync button is version {BOOKMARKLET_VERSION}.</p>}

      <section className="privacy-strip" aria-label="Privacy">
        <ul>
          <li>
            <LockIcon /> Nothing stored on a server
          </li>
          <li>
            <LockIcon /> No passwords, ever
          </li>
          <li>
            <LockIcon /> Open source
          </li>
        </ul>
        <p>
          <NavLink to="privacy" navigate={p.navigate}>
            How your data is handled
          </NavLink>
          {' · '}
          <ExternalLink href={REPO_URL}>Code on GitHub</ExternalLink>
        </p>
      </section>
    </div>
  )
}
