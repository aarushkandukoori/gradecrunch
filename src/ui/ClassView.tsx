// One class on its own page (/class/<course key>): number, title, grade, where it comes from, one or two notes
// that matter, then the details (CourseDetail). The Back button returns to the class list.
import { useEffect, useRef } from 'react'
import { courseLabel, formatGradePercent, plural } from '../lib/format'
import { estimatedLetter } from '../lib/qpa'
import { activeWhatIfs } from '../lib/whatIfs'
import type { Course, CoursePrefs, GradeResult, NeededResult, QpaRow, Settings } from '../types'
import { CourseDetail } from './CourseDetail'
import { LetterChip } from './LetterChip'
import { ChevronIcon, WarningIcon } from './icons'
import { courseWarnings, shownPercent, sourceText } from './view'

interface Props {
  course: Course
  grade: GradeResult
  needed: NeededResult[]
  settings: Settings
  qpaRow: QpaRow | undefined // this class's line in the semester QPA (missing for classes outside it)
  onBack: () => void
  onPrefs: (change: (p: CoursePrefs) => CoursePrefs) => void
  onRemove?: () => void // only for hand-added classes
}

export function ClassView({ course, grade, needed, settings, qpaRow, onBack, onPrefs, onRemove }: Props) {
  const percent = shownPercent(course, grade)
  const letter = estimatedLetter(course, grade, settings)
  const whatIf = activeWhatIfs(course).length > 0
  const headingRef = useRef<HTMLHeadingElement>(null)

  // A new page for screen readers and keyboard users: start them at the class name, not at the top of the site.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [course.key])

  const facts = [sourceText(course), plural(course.units, 'unit')]
  if (course.prefs.passFail) facts.push('Pass/fail')
  else if (qpaRow && !qpaRow.factorable && qpaRow.reason) facts.push(`Not in QPA: ${qpaRow.reason}`)
  if (whatIf) facts.push('Includes what-if scores')

  // At most two short notes, only the ones that change how to read the grade. With what-ifs on, the percent is
  // made up, so "Canvas shows 89.1%" would only look like a mismatch.
  const notes = courseWarnings(course, grade)
    .filter((n) => !(whatIf && n.startsWith('Canvas shows')))
    .slice(0, 2)

  return (
    <div className="class-page">
      <button type="button" className="back-btn" onClick={onBack}>
        <ChevronIcon size={16} className="back-chev" /> All classes
      </button>

      <header className="class-head">
        <div className="class-head-id">
          <h1 ref={headingRef} tabIndex={-1}>
            {courseLabel(course)}
          </h1>
          {course.number && <p className="class-head-title">{course.title}</p>}
        </div>
        <div className="class-head-grade">
          <span className={percent != null ? 'big-percent' : 'big-percent is-empty'}>
            {percent != null ? formatGradePercent(percent) : 'No grades yet'}
          </span>
          {letter && <LetterChip letter={letter} size="lg" />}
        </div>
        <p className="muted class-facts">{facts.join(' · ')}</p>
      </header>

      {(notes.length > 0 || course.prefs.hidden) && (
        <div className="class-notes">
          {course.prefs.hidden && (
            <p className="note-warn">
              This class is hidden and left out of your QPA.{' '}
              <button type="button" className="link-btn" onClick={() => onPrefs((p) => ({ ...p, hidden: undefined }))}>
                Unhide
              </button>
            </p>
          )}
          {notes.map((n) => (
            <p key={n} className="note-warn">
              <WarningIcon size={14} /> {n}
            </p>
          ))}
        </div>
      )}

      <CourseDetail
        course={course}
        grade={grade}
        needed={needed}
        level={settings.level}
        onPrefs={onPrefs}
        onRemove={onRemove}
      />
    </div>
  )
}
