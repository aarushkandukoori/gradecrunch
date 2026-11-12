// Semester QPA, projected cumulative QPA and the Dean's List check.
// QPA = sum(quality points x units) / sum(factorable units). Letters with no quality points
// (P, N, W, ...) and pass/fail courses are left out entirely (research section C).
import type { Course, GradeResult, QpaResult, QpaRow, Settings } from '../types'
import { collegeByKey, formatCourseNumber, letterPoints, normalizeLetter, stripPlusMinus } from './cmu'
import { letterFor } from './grade'

/**
 * The letter we expect for a course, best source first:
 * the student's override, then our computed grade, then Canvas's own score, then a typed-in percent.
 * Undergrads get no +/- on final grades, so "A-" becomes "A". F becomes R (CMU's failing grade).
 */
export function estimatedLetter(course: Course, grade: GradeResult | undefined, settings: Settings): string | null {
  const letter =
    course.prefs.letter ||
    grade?.letter ||
    letterFor(course.canvasScore, course.scheme) ||
    letterFor(course.manualPercent, course.scheme) ||
    null
  if (letter === null) return null
  let clean = settings.level === 'undergrad' ? stripPlusMinus(letter) : normalizeLetter(letter)
  if (clean === 'F') clean = 'R'
  return clean
}

/** Dietrich (and IS, which follows Dietrich) leaves PE (69-xxx) and StuCo (98-xxx) out of the QPA. */
function excludedByCollege(course: Course, settings: Settings): boolean {
  const dietrichRules = settings.college === 'dietrich' || settings.college === 'is'
  const n = course.number ?? ''
  return dietrichRules && (n.startsWith('69') || n.startsWith('98'))
}

function buildRow(course: Course, grade: GradeResult | undefined, settings: Settings): QpaRow {
  const letter = estimatedLetter(course, grade, settings)
  const points = letter === null ? null : letterPoints(letter, settings.level)

  // The first rule that applies explains why a course does not count.
  let reason: string | null = null
  if (course.prefs.passFail) reason = 'Pass/fail'
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
  }
}

/** Semester QPA over the given courses (the caller picks the term), plus cumulative and Dean's List. */
export function computeQpa(courses: Course[], grades: Map<string, GradeResult>, settings: Settings): QpaResult {
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
    priorQpa !== null && priorUnits !== null && priorUnits > 0
      ? (priorQpa * priorUnits + qualityPoints) / (priorUnits + factorableUnits)
      : null

  return {
    rows,
    semesterQpa,
    factorableUnits,
    totalUnits,
    qualityPoints,
    cumulativeQpa,
    deansList: deansListCheck(semesterQpa, factorableUnits, settings),
  }
}

/**
 * Dean's List for the student's college, or null when no college is picked or the college's list can't be
 * computed (CFA, Heinz). Compares the unrounded semester QPA: CMU doesn't publish how it rounds.
 * When a college has two ways to qualify (Dietrich, CMU-Q), we report the rule that is met, else the rule
 * the student's units fit, so the shown threshold is the one that matters.
 */
function deansListCheck(qpa: number | null, units: number, settings: Settings): QpaResult['deansList'] {
  const college = collegeByKey(settings.college)
  if (!college || !college.deansList) return null
  const main = college.deansList
  const rules = main.alt ? [{ qpa: main.qpa, minUnits: main.minUnits }, main.alt] : [{ qpa: main.qpa, minUnits: main.minUnits }]

  const meets = (r: { qpa: number; minUnits: number }) => qpa !== null && qpa >= r.qpa && units >= r.minUnits
  const shown = rules.find(meets) ?? rules.find(r => units >= r.minUnits) ?? rules[0]

  return {
    eligible: meets(shown),
    threshold: shown.qpa,
    minUnits: shown.minUnits,
    college: college.short,
    note: main.note,
  }
}
