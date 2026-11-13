// The grade summary the AI advisor sends with each question: plain text, built from the same numbers the app shows
// (snapshot.ts). It lists, for the term on screen, each class with its key (the tools take keys), units and where
// they come from, pass/fail, percent and letter, letter cutoffs, categories with weights and where they come from,
// item scores (capped per class) and what is needed for each letter; then the QPA summary, the settings, today's
// date and, when the student synced SIO, what SIO says about each class (registered or not, grade option,
// mid-semester and final grades) and their past semesters with the official cumulative QPA.
//
// It replaced the old "Ask Claude" copy-and-paste summary and keeps what that one was careful about: what-if scores
// are marked as made up, and every class says whether it counts toward the QPA and why. It never includes names,
// emails, ids from Canvas or links, and never syllabus text: a syllabus is a teacher's document, and text in it
// could try to give the AI instructions. Class, category and item names are cut short and kept on one line.
// Kept under about 25 KB: if a long semester doesn't fit, fewer items are listed per class.
import { collegeByKey, formatCourseNumber } from '../cmu'
import { dropRuleText, formatDue, formatGradePercent, formatPercent, formatPoints, formatQpa } from '../format'
import { neededForLetters } from '../grade'
import { letterWithBasis } from '../qpa'
import { canonicalTerm } from '../courseNumber'
import { finishedSemesters, officialCumulative, semesterTotals, termInProgress } from '../sio'
import { activeWhatIfs, whatIfApplies } from '../whatIfs'
import { collapseScheme, isZeroPointPlaceholder, neededFor, neededLine, placeholderOnlyCategories, shownPercent } from '../../ui/view'
import type { Category, CategoryResult, Course, Item, Level, SioSemester, Store } from '../../types'
import { classLabel, gradeText, qpaText, snapshot, type Snapshot } from './snapshot'

export const CONTEXT_TARGET_CHARS = 25_000
const ITEM_CAPS = [25, 10, 3, 0] // items listed per class; the next one is tried when the summary is too long
const NAME_CHARS = 60
const OTHER_TERM_CLASSES = 20
const SIO_SEMESTERS = 12
const SIO_COURSES = 12

const UNITS_SOURCE: Record<Course['unitsSource'], string> = {
  catalog: 'from the CMU catalog',
  custom: 'set by the student',
  default: 'a guess, not known',
  sio: 'from SIO',
}

const SCHEME_SOURCE: Record<Course['schemeSource'], string> = {
  canvas: 'from Canvas',
  custom: 'set by the student',
  default: 'CMU default',
}

const WEIGHT_SOURCE: Record<NonNullable<Category['weightSource']>, string> = {
  you: 'set by the student',
  syllabus: 'from the syllabus',
  canvas: 'from Canvas',
}

const BASIS: Record<string, string> = {
  you: 'final letter set by the student',
  'sio-final': 'final grade posted in SIO',
  estimate: 'estimate',
  'sio-mid': 'SIO mid-semester grade',
}

// SIO's grade option letters (anything else is shown as SIO writes it).
const GRADE_OPTIONS: Record<string, string> = { L: 'letter', P: 'pass/fail', A: 'audit' }

/** A name from a teacher's site, safe to put on one line: no control characters or line breaks, cut short.
 * (\s also matches the Unicode line and paragraph separators.) */
export function cleanName(name: string): string {
  const flat = name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > NAME_CHARS ? `${flat.slice(0, NAME_CHARS - 1)}…` : flat
}

/** Builds the summary. `now` is passed in so tests get the same text every time. */
export function buildContext(store: Store, now: Date): string {
  const snap = snapshot(store)
  for (const cap of ITEM_CAPS) {
    const text = render(store, snap, now, cap)
    if (text.length <= CONTEXT_TARGET_CHARS) return text
  }
  // Still too long with no items at all (dozens of classes): cut it, the server refuses anything much longer.
  return `${render(store, snap, now, 0).slice(0, CONTEXT_TARGET_CHARS - 20)}\n(cut short)`
}

function render(store: Store, snap: Snapshot, now: Date, itemCap: number): string {
  const lines: string[] = []
  const s = snap.settings
  const college = collegeByKey(store.settings.college)
  lines.push(`Today: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`)
  // The level is the one of the record SIO puts the term on screen in (sio.ts levelFor); say so when it isn't the setting.
  const record = (level: Level) => (level === 'grad' ? 'graduate' : 'undergraduate')
  const bySio =
    s.level !== store.settings.level
      ? ` for ${snap.term ?? 'this term'} (SIO lists it in the ${record(s.level)} record; the Level setting says ${record(store.settings.level)})`
      : ''
  lines.push(
    `Student: ${s.level === 'grad' ? 'graduate (4.33 scale, +/- grades count)' : 'undergraduate (no +/- on final grades)'}${bySio}. ` +
      `College: ${college ? `${college.short} (key ${college.key})` : 'not set'}.`,
  )
  if (snap.term) {
    const others = snap.terms.filter((t) => t !== snap.term)
    lines.push(`Term on screen: ${snap.term}${others.length > 0 ? `. Other terms: ${others.join(', ')}` : ''}.`)
  }
  lines.push('')
  qpaLines(store, snap, lines)

  lines.push('')
  lines.push(`CLASSES${snap.term ? ` (${snap.term})` : ''}. In tool calls, name a class by its key or number.`)
  if (snap.main.length === 0) lines.push('No classes with grades in this term yet.')
  for (const course of snap.main) classLines(snap, course, itemCap, lines)

  const hidden = snap.other.filter((c) => c.academic && c.prefs.hidden)
  if (hidden.length > 0) {
    lines.push('')
    lines.push('HIDDEN CLASSES (left out of the QPA; set_hidden can show them again)')
    for (const course of hidden) {
      const why = course.sio?.registered === false ? ". Not on the student's SIO schedule for this term" : ''
      lines.push(`- ${classTitle(course)} [key: ${course.key}] ${gradeText(snap, course)}, ${formatPoints(course.units)} units${why}`)
    }
  }

  const older = snap.courses.filter((c) => c.academic && c.term !== null && c.term !== snap.term)
  if (older.length > 0) {
    lines.push('')
    lines.push('CLASSES IN OTHER TERMS (not in this QPA)')
    for (const course of older.slice(0, OTHER_TERM_CLASSES)) {
      lines.push(`- ${course.term}: ${classTitle(course)} [key: ${course.key}] ${gradeText(snap, course)}, ${formatPoints(course.units)} units`)
    }
    if (older.length > OTHER_TERM_CLASSES) lines.push(`- and ${older.length - OTHER_TERM_CLASSES} more`)
  }

  sioLines(store, now, lines)
  return lines.join('\n')
}

// ---------------------------------------------------------------- QPA and settings

function qpaLines(store: Store, snap: Snapshot, lines: string[]): void {
  const q = snap.qpa
  const whatIf = snap.main.some((c) => c.items.some((i) => whatIfApplies(i, c.prefs)))
  lines.push(`QPA (estimates${whatIf ? ', including what-if scores the student typed' : ''})`)
  lines.push(`- Semester QPA: ${qpaText(q.semesterQpa)} on ${formatPoints(q.factorableUnits)} factorable units (${formatPoints(q.totalUnits)} units in all)`)
  const s = snap.settings
  if (s.priorQpa !== null && s.priorUnits !== null) {
    const from = snap.priorFromSio ? 'from SIO' : 'typed in Settings'
    lines.push(`- Before this semester: QPA ${formatQpa(s.priorQpa)} on ${formatPoints(s.priorUnits)} factorable units (${from})`)
  }
  if (q.cumulativeQpa !== null) lines.push(`- Cumulative QPA after this semester: ${formatQpa(q.cumulativeQpa)}`)
  else lines.push('- Cumulative QPA: not known (needs the QPA and units from before this semester: sync SIO or type them in Settings)')
  const official = officialCumulative(store.sio, s.level)
  if (official !== null) lines.push(`- Official cumulative QPA in SIO (finished semesters only): ${formatQpa(official)}`)
  if (q.deansList) {
    const d = q.deansList
    const status = d.eligible ? 'on track' : d.incomplete ? 'not possible: SIO shows an incomplete (I) this semester' : 'not on track'
    lines.push(`- Dean's List (${d.college}): ${status}. Rule: ${d.note}`)
  }
}

// ---------------------------------------------------------------- one class

function classTitle(course: Course): string {
  return course.number ? `${classLabel(course)} ${cleanName(course.title)}` : cleanName(course.title)
}

function classLines(snap: Snapshot, course: Course, itemCap: number, lines: string[]): void {
  const grade = snap.grades.get(course.key)
  const { letter, basis } = letterWithBasis(course, grade, snap.settings)
  const percent = shownPercent(course, grade)
  const row = snap.qpa.rows.find((r) => r.courseKey === course.key)

  lines.push('')
  lines.push(`## ${classTitle(course)} [key: ${course.key}]`)
  // Units the student typed win over SIO's; say SIO's number too when the two differ.
  const sioUnits = course.sio?.units ?? null
  const overSio = course.unitsSource === 'custom' && sioUnits !== null && sioUnits !== course.units
  const facts = [`Units: ${formatPoints(course.units)} (${UNITS_SOURCE[course.unitsSource]}${overSio ? `; SIO says ${formatPoints(sioUnits)}` : ''})`]
  const percentText = percent !== null ? formatGradePercent(percent) : 'no percent yet'
  const whatIf = activeWhatIfs(course).length > 0 ? ' (with what-if scores the student typed, not real)' : ''
  facts.push(`Grade${whatIf}: ${percentText}${letter ? `, letter ${letter} (${BASIS[basis ?? 'estimate']})` : ''}`)
  if (row && row.factorable && row.points !== null) facts.push(`In QPA: ${row.letter} = ${formatPoints(row.points)} points x ${formatPoints(row.units)} units`)
  else if (row) facts.push(`Not in QPA: ${row.reason ?? 'no grade'}`)
  lines.push(`${facts.join('. ')}.`)

  const flags: string[] = []
  if (course.prefs.passFail) flags.push(`Taken pass/fail (${course.sio?.gradeOption === 'P' ? 'from SIO' : 'set by the student'})`)
  else if (course.sio?.gradeOption === 'P') flags.push('Counted for a letter grade: the student turned off the pass/fail from SIO')
  if (course.prefs.letter) flags.push(`Final letter set by the student: ${course.prefs.letter}`)
  const sio = sioLine(course)
  if (sio) flags.push(sio)
  if (flags.length > 0) lines.push(`${flags.join('. ')}.`)

  if (course.manualPercent !== null && course.items.length === 0) lines.push('Added by hand with a percent; no assignments.')
  const cuts = collapseScheme(course.scheme, snap.settings.level)
  lines.push(`Letter cutoffs (${SCHEME_SOURCE[course.schemeSource]}): ${cuts.map((c) => `${c.letter} ${formatPoints(c.min)}`).join(', ')}`)

  if (course.categories.length > 0) {
    lines.push(`Grading: ${course.weighted ? 'weighted categories' : 'total points (category weights are ignored)'}`)
    if (course.weightNote) lines.push(`Note: ${course.weightNote}`)
    categoryLines(course, grade?.categories ?? [], itemCap, lines)
  }

  const needed = neededFor(course, (c) => neededForLetters(c, c.prefs.whatIf ?? {}), snap.settings.level)
  if (needed.length > 0) lines.push(`Needed on the rest: ${needed.map((n) => `${n.letter}: ${neededLine(n, percent)}`).join('; ')}`)
  if (grade && course.items.length > 0) lines.push(`Progress: ${grade.graded} graded, ${grade.remaining} still to come`)
}

function categoryLines(course: Course, results: CategoryResult[], itemCap: number, lines: string[]): void {
  const skip = placeholderOnlyCategories(course)
  const dropped = new Set(results.flatMap((r) => r.dropped))
  const ignored = new Set(course.prefs.ignored ?? [])
  let budget = itemCap
  let left = 0 // items not listed because of the cap
  for (const cat of course.categories) {
    if (skip.has(cat.key)) continue
    const r = results.find((x) => x.key === cat.key)
    const bits: string[] = []
    if (course.weighted) bits.push(`weight ${formatPoints(cat.weight ?? 0)}%${cat.weightSource ? ` (${WEIGHT_SOURCE[cat.weightSource]})` : ''}`)
    const drop = dropRuleText(cat)
    if (drop) bits.push(drop)
    bits.push(r && r.percent !== null ? `${formatPercent(r.percent)} (${formatPoints(r.earned)}/${formatPoints(r.possible)} pts)` : 'nothing graded yet')

    // Work still to come first (what-if questions are about it), then graded work, newest first.
    const items = course.items
      .filter((i) => i.categoryKey === cat.key && !isZeroPointPlaceholder(i, course.prefs.whatIf))
      .sort((a, b) => Number(a.score !== null) - Number(b.score !== null) || (b.due ?? '').localeCompare(a.due ?? ''))
    const shown = items.slice(0, Math.max(0, budget))
    budget -= shown.length
    left += items.length - shown.length
    const itemText = shown.map((i) => itemLine(course, i, dropped, ignored)).join('; ')
    lines.push(`- ${cleanName(cat.name)} [key: ${cat.key}]: ${bits.join(', ')}${itemText ? `. Items: ${itemText}` : ''}`)
  }
  if (left > 0) lines.push(`- (${left} more items not listed)`)
}

/** "Midterm 1 81/100", "Prog 5 ?/100 due Nov 21", "HW 3 6/10 dropped", "Midterm 2 85/100 what-if". */
function itemLine(course: Course, item: Item, dropped: Set<string>, ignored: Set<string>): string {
  const whatIf = whatIfApplies(item, course.prefs) ? course.prefs.whatIf?.[item.key] : undefined
  const score = whatIf ?? item.score
  const max = item.max === null ? '?' : `${formatPoints(item.max)}${item.maxEstimated ? ' (guessed)' : ''}`
  const parts = [`${cleanName(item.name)} ${score === null ? '?' : formatPoints(score)}/${max}`]
  if (whatIf !== undefined) parts.push('what-if')
  if (item.planned) parts.push('planned')
  if (dropped.has(item.key)) parts.push('dropped')
  if (ignored.has(item.key)) parts.push('ignored by the student')
  else if (item.omit) parts.push('not counted')
  else if (item.status === 'excused') parts.push('excused')
  else if (item.score === null && (item.status === 'missing' || item.status === 'submitted')) parts.push(item.status)
  if (item.score === null && item.due) parts.push(`due ${formatDue(item.due)}`)
  return parts.join(' ')
}

// ---------------------------------------------------------------- SIO

/**
 * What SIO says about a class in the list: registered or not, whether SIO is its only source, its grade option and
 * its grades. null when SIO has nothing on this class's term. (A class SIO doesn't list is hidden, so one that is in
 * the list was counted anyway by the student.)
 */
function sioLine(course: Course): string | null {
  const sio = course.sio
  if (!sio) return null
  if (!sio.registered) return "SIO: not on the student's schedule for this term, but the student chose to count it anyway"
  const said = [course.sources.length === 0 ? 'registered (only in SIO: no Canvas, Gradescope or Autolab scores)' : 'registered']
  if (sio.gradeOption) said.push(`grade option ${GRADE_OPTIONS[sio.gradeOption] ?? sio.gradeOption}`)
  if (sio.midGrade) said.push(`mid-semester grade ${sio.midGrade}`)
  if (sio.finalGrade) said.push(`final grade ${sio.finalGrade}`)
  return `SIO: ${said.join(', ')}`
}

function sioLines(store: Store, now: Date, lines: string[]): void {
  const sio = store.sio
  if (!sio || !Array.isArray(sio.semesters) || sio.semesters.length === 0) return
  const finished = finishedSemesters(sio)
  const open = sio.semesters.filter((s) => !finished.includes(s)) // the semester in progress, and next semester
  const current = termInProgress(sio)
  const synced = sio.syncedAt ? `, synced ${formatDue(sio.syncedAt, now.getTime())}` : ''
  const bothLevels = new Set(sio.semesters.map((s) => s.level)).size > 1
  lines.push('')
  lines.push(`SIO (CMU's official record${synced})`)
  for (const sem of open.slice(0, 2)) {
    const when = canonicalTerm(sem.term) === current ? 'in progress' : 'registered, not started'
    lines.push(`- ${semesterName(sem, bothLevels)} (${when}): ${sioCourses(sem)}`)
  }
  for (const sem of finished.slice(0, SIO_SEMESTERS)) {
    const totals = semesterTotals(sem)
    const qpa = sem.qpa.finalQpa ?? (totals.units > 0 ? totals.qualityPoints / totals.units : null)
    const bits = [`QPA ${qpaText(qpa)} on ${formatPoints(totals.units)} factorable units`]
    if (sem.qpa.cumulativeQpa !== null) bits.push(`cumulative ${formatQpa(sem.qpa.cumulativeQpa)}`)
    lines.push(`- ${semesterName(sem, bothLevels)}: ${bits.join(', ')}. ${sioCourses(sem)}`)
  }
  if (finished.length > SIO_SEMESTERS) lines.push(`- and ${finished.length - SIO_SEMESTERS} older semesters`)
}

function semesterName(sem: SioSemester, bothLevels: boolean): string {
  return bothLevels ? `${sem.term} (${sem.level === 'grad' ? 'graduate' : 'undergraduate'})` : sem.term
}

/** "15-112 A 12 units; 76-101 P 9 units pass/fail; ..." */
function sioCourses(sem: SioSemester): string {
  const list = sem.courses.slice(0, SIO_COURSES).map((c) => {
    const name = c.number ? formatCourseNumber(c.number) : cleanName(c.title)
    const parts = [name]
    if (c.finalGrade) parts.push(c.finalGrade)
    else if (c.midGrade) parts.push(`mid-semester ${c.midGrade}`)
    if (c.units !== null) parts.push(`${formatPoints(c.units)} units`)
    if (c.gradeOption === 'P') parts.push('pass/fail')
    return parts.join(' ')
  })
  const more = sem.courses.length > SIO_COURSES ? `; and ${sem.courses.length - SIO_COURSES} more` : ''
  return list.length > 0 ? `${list.join('; ')}${more}` : 'no classes listed'
}
