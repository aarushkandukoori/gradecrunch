// The home page once there are grades: QPA card, the course grid for the chosen term, hidden courses, and the
// "add a class by hand" form.
import { plural } from '../lib/format'
import type { Course, CoursePrefs, GradeResult, ManualCourse, NeededResult, QpaResult, Settings } from '../types'
import { CourseCard } from './CourseCard'
import { ManualCourseForm } from './ManualCourseForm'
import { QpaCard } from './QpaCard'
import { EMPTY_GRADE } from './view'

interface Props {
  term: string | null
  main: Course[]
  other: Course[]
  grades: Map<string, GradeResult>
  needed: Map<string, NeededResult[]>
  qpa: QpaResult
  settings: Settings
  onSettings: (patch: Partial<Settings>) => void
  onPrefs: (courseKey: string, change: (p: CoursePrefs) => CoursePrefs) => void
  onAddManual: (course: ManualCourse) => void
  onRemoveManual: (courseKey: string) => void
  onAskClaude: () => void
  onOpenSettings: () => void
  demo: boolean // sample data from "See a demo" is showing
  onEndDemo: () => void
  onSetup: () => void
}

export function Dashboard(p: Props) {
  function card(c: Course) {
    return (
      <CourseCard
        key={c.key}
        course={c}
        grade={p.grades.get(c.key) ?? EMPTY_GRADE}
        needed={p.needed.get(c.key) ?? []}
        settings={p.settings}
        onPrefs={p.onPrefs}
        onRemoveManual={p.onRemoveManual}
      />
    )
  }

  return (
    <div className="dash">
      {p.demo && (
        <div className="demo-banner card" role="status">
          <p>
            <strong>These are sample grades.</strong> Play with weights and what-ifs, then add the Sync button to see your
            own.
          </p>
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-sm" onClick={p.onSetup}>
              Set up mine
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={p.onEndDemo}>
              Clear sample data
            </button>
          </div>
        </div>
      )}
      <QpaCard
        qpa={p.qpa}
        settings={p.settings}
        onSettings={p.onSettings}
        onAskClaude={p.onAskClaude}
        onOpenSettings={p.onOpenSettings}
      />

      <section aria-label="Courses">
        {p.main.length > 0 ? (
          <div className="course-grid">{p.main.map(card)}</div>
        ) : (
          <p className="card empty-note">No classes{p.term ? ` for ${p.term}` : ''} yet. Sync or add one below.</p>
        )}
      </section>

      {p.other.length > 0 && (
        <section className="other-courses" aria-label="Hidden courses">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={p.settings.showAll}
            onClick={() => p.onSettings({ showAll: !p.settings.showAll })}
          >
            {p.settings.showAll ? 'Hide' : 'Show'} {plural(p.other.length, 'hidden course')}
          </button>
          {p.settings.showAll && (
            <>
              <p className="muted small">
                Hidden classes and Canvas pages without a course number. They never count toward your QPA.
              </p>
              <div className="course-grid">{p.other.map(card)}</div>
            </>
          )}
        </section>
      )}

      <details className="card disclosure">
        <summary>Class not on Canvas or Gradescope? Add it by hand</summary>
        <div className="disclosure-body">
          <ManualCourseForm term={p.term} onAdd={p.onAddManual} />
        </div>
      </details>
    </div>
  )
}
