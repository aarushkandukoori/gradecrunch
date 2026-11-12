// The home page once there are grades: the semester QPA, then one simple row per class. Clicking a row opens
// that class (ClassView). Hidden classes, "add a class by hand" and Ask Claude are small links under the list.
import { useEffect, useRef, useState } from 'react'
import { courseLabel, formatGradePercent, formatQpa, plural } from '../lib/format'
import { estimatedLetter } from '../lib/qpa'
import { activeWhatIfs } from '../lib/whatIfs'
import type { Course, GradeResult, ManualCourse, NeededResult, QpaResult, Settings } from '../types'
import { AddClassDialog } from './AddClassDialog'
import { LetterChip } from './LetterChip'
import { rowHint, shownPercent } from './view'

interface Props {
  term: string | null
  main: Course[]
  other: Course[]
  grades: Map<string, GradeResult>
  needed: Map<string, NeededResult[]>
  qpa: QpaResult
  settings: Settings
  onSettings: (patch: Partial<Settings>) => void
  onOpenClass: (courseKey: string) => void
  onAddManual: (course: ManualCourse) => void
  onAskClaude: () => void
  demo: boolean // sample data from "See a demo" is showing
  onEndDemo: () => void
  onSetup: () => void
  returnTo: ReturnTo | null // the class we just came back from: put focus and scroll back on its row
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
  if (whatIfs) summaryLine += ' · includes what-if scores'

  function row(c: Course) {
    return (
      <li key={c.key}>
        <ClassRow
          course={c}
          grade={p.grades.get(c.key)}
          needed={p.needed.get(c.key) ?? []}
          settings={p.settings}
          onOpen={() => p.onOpenClass(c.key)}
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

      <section className="summary" aria-labelledby="qpa-title">
        <h1 id="qpa-title" className="summary-term">
          {p.term ?? 'This semester'}
        </h1>
        <p className="qpa-big">{p.qpa.semesterQpa != null ? formatQpa(p.qpa.semesterQpa) : 'No QPA yet'}</p>
        <p className="muted">{summaryLine}</p>
      </section>

      <section aria-label="Classes" ref={listRef}>
        {p.main.length > 0 ? (
          <ul className="class-list">{p.main.map(row)}</ul>
        ) : (
          <p className="empty-note muted">No classes{p.term ? ` for ${p.term}` : ''} yet.</p>
        )}

        {p.other.length > 0 && p.settings.showAll && (
          <>
            <p className="muted small list-note">Hidden. These don't count toward your QPA.</p>
            <ul className="class-list">{p.other.map(row)}</ul>
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
        <button type="button" className="link-btn" onClick={() => setAdding(true)}>
          Add a class by hand
        </button>
        <button type="button" className="link-btn" onClick={p.onAskClaude}>
          Ask Claude about my grades
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
  onOpen: () => void
}

/** One class in the list: number and title on the left, percent and letter on the right. The whole row is a button. */
function ClassRow({ course, grade, needed, settings, onOpen }: RowProps) {
  const percent = shownPercent(course, grade)
  const letter = estimatedLetter(course, grade, settings)
  const hint = rowHint(course, needed, grade, letter, usesWhatIfs(course))

  return (
    <button type="button" className="class-row" data-key={course.key} onClick={onOpen}>
      <span className="class-id">
        <span className="class-num">{courseLabel(course)}</span>
        {course.number && <span className="class-title">{course.title}</span>}
        {hint && <span className="class-hint">{hint}</span>}
      </span>
      <span className="class-grade">
        <span className={percent != null ? 'class-percent' : 'class-percent is-empty'}>
          {percent != null ? formatGradePercent(percent) : 'No grades'}
        </span>
        {letter ? <LetterChip letter={letter} /> : <span className="chip chip-n chip-md">?</span>}
      </span>
    </button>
  )
}
