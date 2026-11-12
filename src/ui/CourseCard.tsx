// One course on the dashboard. Collapsed: number, title, percent, letter, bar, one-line insight, warnings, and a
// "What-if" badge whenever the shown grade includes made-up what-if scores.
// Click the header to expand into the full detail (what you need, categories, assignments, settings).
import { useId, useState } from 'react'
import { courseLabel, formatGradePercent } from '../lib/format'
import { estimatedLetter } from '../lib/qpa'
import { activeWhatIfs, withoutWhatIfs } from '../lib/whatIfs'
import type { Course, CoursePrefs, GradeResult, NeededResult, Settings, Source } from '../types'
import { CourseDetail } from './CourseDetail'
import { GradeBar } from './GradeBar'
import { LetterChip } from './LetterChip'
import { ChevronIcon, WarningIcon } from './icons'
import { courseInsight, courseWarnings, isManualOnly, shownPercent, toGoText } from './view'

const SOURCE_NAMES: Record<Source, string> = { canvas: 'Canvas', gradescope: 'Gradescope', autolab: 'Autolab', manual: 'Manual' }

export interface CourseCardProps {
  course: Course
  grade: GradeResult
  needed: NeededResult[]
  settings: Settings
  onPrefs: (courseKey: string, change: (p: CoursePrefs) => CoursePrefs) => void
  onRemoveManual: (courseKey: string) => void
}

export function CourseCard({ course, grade, needed, settings, onPrefs, onRemoveManual }: CourseCardProps) {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const percent = shownPercent(course, grade)
  const letter = estimatedLetter(course, grade, settings)
  const insight = courseInsight(needed, grade)
  const warnings = courseWarnings(course, grade)
  const manualOnly = isManualOnly(course)
  const whatIfCount = activeWhatIfs(course).length
  // Unique source names (a merged course can have two Canvas sections).
  const sources = [...new Set(course.sources.map((s) => s.source))]

  return (
    <article className={`card course ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="course-head"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen(!open)}
      >
        <span className="course-id">
          <span className="course-num">{courseLabel(course)}</span>
          {course.number && <span className="course-title">{course.title}</span>}
        </span>
        <span className="course-badges">
          {sources.map((s) => (
            <span key={s} className={`badge badge-${s}`}>
              {SOURCE_NAMES[s]}
            </span>
          ))}
          <span className="badge badge-units">{course.units}u</span>
          <ChevronIcon className="chev" />
        </span>
      </button>

      <div className="course-summary">
        <div className="course-score">
          <span className={percent != null ? 'big-percent' : 'big-percent is-empty'}>
            {percent != null ? formatGradePercent(percent) : 'No grades yet'}
          </span>
          {letter && <LetterChip letter={letter} size="lg" />}
          {course.prefs.passFail && <span className="badge">Pass/fail</span>}
          {whatIfCount > 0 && (
            <span className="badge badge-whatif" title="This grade includes what-if scores you typed in, not real grades">
              What-if
            </span>
          )}
        </div>
        {whatIfCount > 0 && (
          <p className="note-whatif">
            Includes {whatIfCount === 1 ? '1 what-if score' : `${whatIfCount} what-if scores`}, not your real grade.{' '}
            <button type="button" className="link-btn" onClick={() => onPrefs(course.key, withoutWhatIfs)}>
              Clear what-ifs
            </button>
          </p>
        )}
        <GradeBar percent={percent} scheme={course.scheme} level={settings.level} />
        {insight && <p className="insight">{insight}</p>}
        <p className="meta">
          {manualOnly ? 'Added by hand' : toGoText(course, grade)}
          {course.prefs.hidden && (
            <>
              {' · '}
              <button
                type="button"
                className="link-btn"
                onClick={() => onPrefs(course.key, (p) => ({ ...p, hidden: undefined }))}
              >
                Unhide
              </button>
            </>
          )}
        </p>
        {warnings.map((w) => (
          <p key={w} className="note-warn">
            <WarningIcon size={14} /> {w}
          </p>
        ))}
      </div>

      <div id={detailId} hidden={!open}>
        {open && (
          <CourseDetail
            course={course}
            grade={grade}
            needed={needed}
            level={settings.level}
            onPrefs={(change) => onPrefs(course.key, change)}
            onRemove={manualOnly ? () => onRemoveManual(course.key) : undefined}
          />
        )}
      </div>
    </article>
  )
}
