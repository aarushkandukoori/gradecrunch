// The home page once there are grades: the semester QPA, then one simple row per class. Clicking a row opens
// that class (ClassView); the small P/F button at the end of a row counts that class as pass/fail. Hidden classes,
// past semesters, "add a class by hand" and the AI advisor (the AI chat) are small links under the list.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { courseLabel, formatGradePercent, formatQpa, plural } from '../lib/format'
import { letterWithBasis } from '../lib/qpa'
import { withToggle } from '../lib/store'
import { activeWhatIfs } from '../lib/whatIfs'
import type { Course, CoursePrefs, GradeResult, ManualCourse, NeededResult, QpaResult, Settings } from '../types'
import { AddClassDialog } from './AddClassDialog'
import { LetterChip } from './LetterChip'
import { offersPassFail, rowHint, shownLetter, shownPercent, sioRowNote } from './view'

interface Props {
  term: string | null
  main: Course[]
  other: Course[]
  grades: Map<string, GradeResult>
  needed: Map<string, NeededResult[]>
  qpa: QpaResult
  official?: number | null // SIO's official cumulative QPA, shown next to the projected one
  settings: Settings
  onSettings: (patch: Partial<Settings>) => void
  onOpenClass: (courseKey: string) => void
  onPrefs: (courseKey: string, change: (p: CoursePrefs) => CoursePrefs) => void // the same path the class page uses
  onPastSemesters?: () => void // set when SIO has finished semesters to list
  onAddManual: (course: ManualCourse) => void
  onAsk: () => void // opens the AI advisor chat
  demo: boolean // sample data from "See a demo" is showing
  onEndDemo: () => void
  onSetup: () => void
  returnTo: ReturnTo | null // the class we just came back from: put focus and scroll back on its row
  notice?: ReactNode // extension messages ("Finish setting up", "Log in to Gradescope"), shown above the QPA
}

/** Where the student was in the list before opening a class. */
export interface ReturnTo {
  key: string
  scrollY: number
}

/** A what-if only changes the grade when the class uses its percent (not pass/fail, no final letter set by hand). */
function usesWhatIfs(c: Course): boolean {
  return !c.prefs.passFail && !c.prefs.letter && activeWhatIfs(c).length > 0
}

export function Dashboard(p: Props) {
  const [adding, setAdding] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const whatIfs = p.main.some(usesWhatIfs)

  // Coming back from a class: same scroll spot, and keyboard focus on the row that was opened.
  const returnTo = p.returnTo
  useEffect(() => {
    if (!returnTo) return
    const rowButton = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button.class-row') ?? [])].find(
      (b) => b.dataset.key === returnTo.key,
    )
    rowButton?.focus({ preventScroll: true })
    window.scrollTo(0, returnTo.scrollY)
  }, [returnTo])

  let summaryLine = p.qpa.factorableUnits > 0 ? `Estimated QPA · ${plural(p.qpa.factorableUnits, 'unit')}` : 'Add grades to see your QPA'
  if (p.qpa.cumulativeQpa != null) summaryLine += ` · Cumulative ${formatQpa(p.qpa.cumulativeQpa)}`
  // SIO's official cumulative (through your last finished semester), next to the projected one.
  if (p.official != null) {
    summaryLine += p.qpa.cumulativeQpa != null ? ` · Official ${formatQpa(p.official)}` : ` · Official cumulative ${formatQpa(p.official)}`
  }
  if (whatIfs) summaryLine += ' · includes what-if scores'
  // Screen readers say this line when it changes (after a P/F tap, for example), since the big number isn't announced.
  const spokenQpa =
    p.qpa.semesterQpa != null ? `QPA ${formatQpa(p.qpa.semesterQpa)}, ${plural(p.qpa.factorableUnits, 'unit')}` : 'No QPA yet'

  // `counted`: the class is in the main list. Those get the P/F button, unless SIO already settled it (offersPassFail).
  // It works like "Taken pass/fail" on the class page: picking what SIO says clears the setting (withToggle).
  function row(c: Course, counted: boolean) {
    const setPassFail = (on: boolean) =>
      p.onPrefs(c.key, (prefs) => withToggle(prefs, 'passFail', on, c.sio?.gradeOption === 'P'))
    return (
      <li key={c.key}>
        <ClassRow
          course={c}
          grade={p.grades.get(c.key)}
          needed={p.needed.get(c.key) ?? []}
          settings={p.settings}
          counts={p.qpa.rows.some((r) => r.courseKey === c.key && r.factorable)}
          onOpen={() => p.onOpenClass(c.key)}
          onPassFail={counted && offersPassFail(c) ? setPassFail : undefined}
        />
      </li>
    )
  }

  return (
    <div className="dash">
      {p.demo && (
        <div className="demo-banner" role="status">
          <p>
            <strong>These are sample grades.</strong>
          </p>
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-sm" onClick={p.onSetup}>
              Set up mine
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={p.onEndDemo}>
              Clear sample data
            </button>
          </div>
        </div>
      )}

      {p.notice}

      <section className="summary" aria-labelledby="qpa-title">
        <h1 id="qpa-title" className="summary-term">
          {p.term ?? 'This semester'}
        </h1>
        <p className="qpa-big">{p.qpa.semesterQpa != null ? formatQpa(p.qpa.semesterQpa) : 'No QPA yet'}</p>
        <p className="muted">{summaryLine}</p>
        <p className="sr-only" aria-live="polite">
          {spokenQpa}
        </p>
      </section>

      <section aria-label="Classes" ref={listRef}>
        {p.main.length > 0 ? (
          <ul className="class-list">{p.main.map((c) => row(c, true))}</ul>
        ) : (
          <p className="empty-note muted">No classes{p.term ? ` for ${p.term}` : ''} yet.</p>
        )}

        {p.other.length > 0 && p.settings.showAll && (
          <>
            <p className="muted small list-note">Hidden. These don't count toward your QPA.</p>
            <ul className="class-list">{p.other.map((c) => row(c, false))}</ul>
          </>
        )}
      </section>

      <div className="dash-links">
        {p.other.length > 0 && (
          <button
            type="button"
            className="link-btn"
            aria-expanded={p.settings.showAll}
            onClick={() => p.onSettings({ showAll: !p.settings.showAll })}
          >
            {p.settings.showAll
              ? 'Hide hidden classes'
              : `Show ${p.other.length} hidden ${p.other.length === 1 ? 'class' : 'classes'}`}
          </button>
        )}
        {p.onPastSemesters && (
          <button type="button" className="link-btn" onClick={p.onPastSemesters}>
            Past semesters
          </button>
        )}
        <button type="button" className="link-btn" onClick={() => setAdding(true)}>
          Add a class by hand
        </button>
        <button type="button" className="link-btn" onClick={p.onAsk}>
          Ask the AI advisor
        </button>
      </div>

      <AddClassDialog open={adding} onClose={() => setAdding(false)} term={p.term} onAdd={p.onAddManual} />
    </div>
  )
}

interface RowProps {
  course: Course
  grade: GradeResult | undefined
  needed: NeededResult[]
  settings: Settings
  counts: boolean // the class is in the semester QPA
  onOpen: () => void
  onPassFail?: (on: boolean) => void // set for main-list classes whose P/F is still open: shows the P/F button
}

/**
 * One class in the list: number and title on the left, percent and letter on the right. The row is a button that
 * opens the class. Most classes in the main list also get a small P/F button. It comes after the row button, not
 * inside it (a button can't hold another button), so the row only opens and P/F only switches pass/fail on or off.
 */
function ClassRow({ course, grade, needed, settings, counts, onOpen, onPassFail }: RowProps) {
  const percent = shownPercent(course, grade)
  const { letter, basis } = letterWithBasis(course, grade, settings)
  const chip = shownLetter(course, letter, basis) // "P" while the class is pass/fail
  const passFail = course.prefs.passFail === true
  // With the final grade posted, "what you need" no longer matters: only the SIO line shows, plus "Pass/fail" when
  // the class is set to pass/fail anyway (it is then left out of the QPA).
  const sioNote = sioRowNote(course, basis, counts)
  const hint = basis === 'sio-final' ? (passFail ? 'Pass/fail' : null) : rowHint(course, needed, grade, letter, usesWhatIfs(course))
  const lines = [sioNote, hint].filter((line) => line !== null)

  return (
    <div className="class-item">
      <button type="button" className="class-row" data-key={course.key} onClick={onOpen}>
        <span className="class-id">
          <span className="class-num">{courseLabel(course)}</span>
          {course.number && <span className="class-title">{course.title}</span>}
          {lines.length > 0 && <span className="class-hint">{lines.join(' · ')}</span>}
        </span>
        <span className="class-grade">
          <span className={percent != null ? 'class-percent' : 'class-percent is-empty'}>
            {percent != null ? formatGradePercent(percent) : basis === 'sio-final' ? 'Final' : 'No grades'}
          </span>
          {chip ? <LetterChip letter={chip} /> : <span className="chip chip-n chip-md">?</span>}
        </span>
      </button>
      {onPassFail && (
        // A toggle button: aria-pressed tells screen readers whether pass/fail is on. The name starts with the
        // visible "P/F" so voice control finds it too; the title (shown on hover) says what a click does.
        <button
          type="button"
          className="pf-toggle"
          aria-pressed={passFail}
          aria-label={`P/F (pass/fail), ${courseLabel(course)}`}
          title={passFail ? 'Count the letter grade again' : 'Count this class as pass/fail, left out of your QPA'}
          onClick={() => onPassFail(!passFail)}
        >
          P/F
        </button>
      )}
    </div>
  )
}
