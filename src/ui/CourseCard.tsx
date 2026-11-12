// One course on the dashboard. Collapsed: number, title, percent, letter, bar, one-line insight, warnings.
// Click the header to expand into the full detail (what you need, categories, assignments, settings).
import { useId, useState } from 'react'
import { courseLabel, formatPercent } from '../lib/format'
import { estimatedLetter } from '../lib/qpa'
import type { Course, CoursePrefs, GradeResult, NeededResult, Settings, Source } from '../types'
import { CourseDetail } from './CourseDetail'
import { GradeBar } from './GradeBar'
import { LetterChip } from './LetterChip'
import { ChevronIcon, WarningIcon } from './icons'
import { courseInsight, courseWarnings, isManualOnly, shownPercent } from './view'

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
            {percent != null ? formatPercent(percent) : 'No grades yet'}
          </span>
          {letter && <LetterChip letter={letter} size="lg" />}
          {course.prefs.passFail && <span className="badge">Pass/fail</span>}
        </div>
        <GradeBar percent={percent} scheme={course.scheme} level={settings.level} />
        {insight && <p className="insight">{insight}</p>}
        <p className="meta">
          {manualOnly ? 'Added by hand' : `${grade.graded} graded · ${grade.remaining} to go`}
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
