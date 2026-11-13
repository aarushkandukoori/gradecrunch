// Semester QPA, projected cumulative QPA and the Dean's List check.
// QPA = sum(quality points x units) / sum(factorable units). Letters with no quality points
// (P, N, W, ...), pass/fail courses and audited courses are left out entirely (research section C).
import type { Course, GradeResult, LetterBasis, QpaResult, QpaRow, Settings } from '../types'
import { collegeByKey, formatCourseNumber, letterPoints, toCmuLetter } from './cmu'
import { letterFor } from './grade'

/**
 * The letter we expect for a course and where it came from, best source first:
 *  1. the final letter the student picked,
 *  2. the final grade posted in SIO,
 *  3. our computed grade, then Canvas's own score, then a typed-in percent,
 *  4. the SIO mid-semester grade, when nothing else is known (a class with no Canvas or Gradescope site).
 * Undergrads get no +/- on final grades, so "A-" (or a mid-semester "B+") becomes "A" ("B"). F becomes R (CMU's
 * failing grade). Grad students keep +/-, but a D- (not on CMU's grad scale) becomes D.
 */
export function letterWithBasis(
  course: Course,
  grade: GradeResult | undefined,
  settings: Settings,
): { letter: string | null; basis: LetterBasis | null } {
  const estimate =
    grade?.letter || letterFor(course.canvasScore, course.scheme) || letterFor(course.manualPercent, course.scheme) || null
  const choices: [string | null | undefined, LetterBasis][] = [
    [course.prefs.letter, 'you'],
    [course.sio?.finalGrade, 'sio-final'],
    [estimate, 'estimate'],
    [course.sio?.midGrade, 'sio-mid'],
  ]
  for (const [letter, basis] of choices) {
    if (letter) return { letter: toCmuLetter(letter, settings.level), basis }
  }
  return { letter: null, basis: null }
}

/** The letter we expect for a course (see letterWithBasis for the order). */
export function estimatedLetter(course: Course, grade: GradeResult | undefined, settings: Settings): string | null {
  return letterWithBasis(course, grade, settings).letter
}

/** SIO grade option "A": the class is audited. An audit ends as an O, which never counts toward the QPA. */
export function isAudit(course: Course): boolean {
  return course.sio?.gradeOption === 'A'
}

/** Dietrich (and IS, which follows Dietrich) leaves PE (69-xxx) and StuCo (98-xxx) out of the QPA. */
function excludedByCollege(course: Course, settings: Settings): boolean {
  const dietrichRules = settings.college === 'dietrich' || settings.college === 'is'
  const n = course.number ?? ''
  return dietrichRules && (n.startsWith('69') || n.startsWith('98'))
}

function buildRow(course: Course, grade: GradeResult | undefined, settings: Settings): QpaRow {
  const { letter, basis } = letterWithBasis(course, grade, settings)
  const points = letter === null ? null : letterPoints(letter, settings.level)

  // The first rule that applies explains why a course does not count.
  let reason: string | null = null
  if (course.prefs.passFail) reason = 'Pass/fail'
  else if (isAudit(course)) reason = 'Audit'
  else if (excludedByCollege(course, settings)) reason = "Dietrich doesn't count PE/StuCo"
  else if (letter === null) reason = 'No grade yet'
  else if (points === null) reason = `${letter} doesn't count toward QPA`
  else if (!(course.units > 0)) reason = '0 units'

  return {
    courseKey: course.key,
    label: course.number ? formatCourseNumber(course.number) : course.title,
    units: course.units,
    letter,
    points,
    factorable: reason === null,
    reason,
    basis,
  }
}

export interface QpaOptions {
  // Compute "cumulative after this semester"? With a prior QPA the student typed in, only right for the newest term:
  // an older term is already part of that number, so adding it again would count it twice. A prior QPA from SIO
  // (withSioPrior in sio.ts) only counts semesters before the term shown, so it is right for any term. Default true.
  includeCumulative?: boolean
}

/** Semester QPA over the given courses (the caller picks the term), plus cumulative and Dean's List. */
export function computeQpa(
  courses: Course[],
  grades: Map<string, GradeResult>,
  settings: Settings,
  opts: QpaOptions = {},
): QpaResult {
  const includeCumulative = opts.includeCumulative ?? true
  const rows = courses
    .filter(c => c.academic && !c.prefs.hidden)
    .map(c => buildRow(c, grades.get(c.key), settings))

  let factorableUnits = 0
  let qualityPoints = 0
  let totalUnits = 0
  for (const row of rows) {
    totalUnits += row.units
    if (row.factorable && row.points !== null) {
      factorableUnits += row.units
      qualityPoints += row.points * row.units
    }
  }
  const semesterQpa = factorableUnits > 0 ? qualityPoints / factorableUnits : null

  // Cumulative = (old quality points + this semester's) / (old units + this semester's).
  const { priorQpa, priorUnits } = settings
  const cumulativeQpa =
    includeCumulative && priorQpa !== null && priorUnits !== null && priorUnits > 0
      ? (priorQpa * priorUnits + qualityPoints) / (priorUnits + factorableUnits)
      : null

  // Every college's Dean's List also needs no incompletes that semester. SIO shows one as a final grade of I.
  const incomplete = courses.some((c) => c.academic && !c.prefs.hidden && c.sio?.finalGrade === 'I')

  return {
    rows,
    semesterQpa,
    factorableUnits,
    totalUnits,
    qualityPoints,
    cumulativeQpa,
    deansList: deansListCheck(semesterQpa, factorableUnits, settings, incomplete),
  }
}

/**
 * Dean's List for the student's college, or null when no college is picked, the college's list can't be
 * computed (CFA, Heinz), or the student is a grad student (Dean's List is an undergraduate honor, and grad
 * QPAs are on the 4.33 scale, so the thresholds don't apply). Compares the unrounded semester QPA: CMU doesn't publish how it rounds.
 * When a college has two ways to qualify (Dietrich, CMU-Q), we report the rule that is met, else the rule
 * the student's units fit, so the shown threshold is the one that matters. An Incomplete (`incomplete`) rules it out.
 */
function deansListCheck(qpa: number | null, units: number, settings: Settings, incomplete: boolean): QpaResult['deansList'] {
  if (settings.level === 'grad') return null
  const college = collegeByKey(settings.college)
  if (!college || !college.deansList) return null
  const main = college.deansList
  const rules = main.alt ? [{ qpa: main.qpa, minUnits: main.minUnits }, main.alt] : [{ qpa: main.qpa, minUnits: main.minUnits }]

  const meets = (r: { qpa: number; minUnits: number }) => qpa !== null && qpa >= r.qpa && units >= r.minUnits
  const shown = rules.find(meets) ?? rules.find(r => units >= r.minUnits) ?? rules[0]

  return {
    eligible: meets(shown) && !incomplete,
    threshold: shown.qpa,
    minUnits: shown.minUnits,
    college: college.short,
    note: main.note,
    ...(incomplete ? { incomplete: true } : {}),
  }
}
