// The numbers the app shows, worked out from a store the same way App.tsx does it: classes, grades, which term is
// on screen, and the QPA for that term. The chat uses this to describe the student's grades to the AI (context.ts)
// and to report what a change did (tools.ts), so its numbers always match the screen.
import { formatCourseNumber } from '../cmu'
import { formatGradePercent, formatQpa } from '../format'
import { gradeCourse } from '../grade'
import { buildCourses, termsOf } from '../merge'
import { computeQpa, letterWithBasis } from '../qpa'
import { withSioPrior } from '../sio'
import { pickTerm, shownPercent, splitCourses, termsWithGrades } from '../../ui/view'
import type { Course, GradeResult, QpaResult, Settings, Store } from '../../types'

export interface Snapshot {
  courses: Course[] // every class, every term
  grades: Map<string, GradeResult> // course key -> grade (with the student's what-ifs, like the dashboard)
  terms: string[] // newest first
  term: string | null // the term on screen
  main: Course[] // the classes on screen that count toward the QPA
  other: Course[] // hidden classes of that term, and classes with no term
  qpa: QpaResult
  settings: Settings // the student's settings, with "QPA before this semester" from SIO filled in when known
  priorFromSio: boolean // true when that prior QPA came from SIO (not typed in Settings)
  includeCumulative: boolean // the computeQpa option App uses for this term
}

/** Everything App.tsx derives from the store, in one go. Works with or without SIO data. */
export function snapshot(store: Store): Snapshot {
  const courses = buildCourses(store)
  const grades = new Map(courses.map((c) => [c.key, gradeCourse(c, { whatIf: c.prefs.whatIf })]))
  const terms = termsOf(courses)
  const term = pickTerm(terms, store.settings.term, termsWithGrades(courses, grades))
  const newestTerm = terms.length === 0 || term === terms[0]
  const prior = withSioPrior(store.settings, store.sio, term)
  const { main, other } = splitCourses(courses, term)
  const includeCumulative = newestTerm || prior.fromSio
  const qpa = computeQpa(main, grades, prior.settings, { includeCumulative })
  return { courses, grades, terms, term, main, other, qpa, settings: prior.settings, priorFromSio: prior.fromSio, includeCumulative }
}

/** "21-241", or the title for a class with no number. */
export function classLabel(course: Course): string {
  return course.number ? formatCourseNumber(course.number) : course.title
}

/** A class's percent and letter as the class list shows them: "88.52% B", "88.52%", "A" or "no grade yet". */
export function gradeText(snap: Snapshot, course: Course): string {
  const percent = shownPercent(course, snap.grades.get(course.key))
  const { letter } = letterWithBasis(course, snap.grades.get(course.key), snap.settings)
  const parts = [percent !== null ? formatGradePercent(percent) : '', letter ?? ''].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'no grade yet'
}

/** "3.42", or "none" when there is no QPA (no class with a grade counts yet). */
export function qpaText(qpa: number | null): string {
  return qpa === null ? 'none' : formatQpa(qpa)
}
