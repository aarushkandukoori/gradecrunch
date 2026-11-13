// The /past page: every finished semester from SIO, newest first, with its QPA, factorable units and each course's
// units and final grade. SIO's official cumulative QPA sits at the top. Read-only and plain on purpose.
import { useEffect, useRef } from 'react'
import { formatCourseNumber } from '../lib/cmu'
import { formatQpa, plural } from '../lib/format'
import { finishedSemesters, officialCumulative, semesterTotals } from '../lib/sio'
import type { Level, SioData, SioSemester } from '../types'
import { LetterChip } from './LetterChip'
import { ChevronIcon } from './icons'

interface Props {
  sio: SioData | undefined
  level: Level
  onBack: () => void
}

/** SIO's semester QPA, or (if SIO's QPA row is missing) the one its final grades add up to. */
function semesterQpa(sem: SioSemester): number | null {
  if (sem.qpa.finalQpa !== null) return sem.qpa.finalQpa
  const totals = semesterTotals(sem)
  return totals.units > 0 ? totals.qualityPoints / totals.units : null
}

export function PastSemesters({ sio, level, onBack }: Props) {
  const semesters = finishedSemesters(sio)
  const official = officialCumulative(sio, level)
  // Name the record (undergraduate or graduate) only for students who have both.
  const bothLevels = new Set(semesters.map((s) => s.level)).size > 1
  const headingRef = useRef<HTMLHeadingElement>(null)

  // A new page for screen readers and keyboard users: start them at the heading, like the class page does.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [])

  return (
    <div className="past-page">
      <button type="button" className="back-btn" onClick={onBack}>
        <ChevronIcon size={16} className="back-chev" /> All classes
      </button>
      <h1 ref={headingRef} tabIndex={-1}>
        Past semesters
      </h1>
      {official != null && (
        <p className="past-official">
          Official cumulative QPA <strong className="num">{formatQpa(official)}</strong>
        </p>
      )}

      {semesters.length === 0 && <p className="muted">No finished semesters yet. Sync SIO to see them here.</p>}

      {semesters.map((sem) => {
        const qpa = semesterQpa(sem)
        return (
          <section key={`${sem.level}-${sem.code}`} className="past-sem" aria-labelledby={`past-${sem.level}-${sem.code}`}>
            <div className="past-sem-head">
              <h2 id={`past-${sem.level}-${sem.code}`}>
                {sem.term}
                {bothLevels && ` · ${sem.level === 'grad' ? 'Graduate' : 'Undergraduate'}`}
              </h2>
              <p className="muted small">
                {qpa != null ? `QPA ${formatQpa(qpa)}` : 'No QPA'} · {plural(semesterTotals(sem).units, 'factorable unit')}
              </p>
            </div>
            <ul className="class-list">
              {sem.courses.map((c, i) => (
                <li key={`${c.number ?? c.title}-${i}`} className="past-row">
                  <span className="class-id">
                    <span className="class-num">{c.number ? formatCourseNumber(c.number) : c.title}</span>
                    {c.number && c.title && <span className="class-title">{c.title}</span>}
                  </span>
                  <span className="class-grade">
                    {c.units != null && <span className="muted small num">{plural(c.units, 'unit')}</span>}
                    {c.finalGrade ? <LetterChip letter={c.finalGrade} /> : <span className="chip chip-n chip-md">?</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
