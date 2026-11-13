// View logic for the dashboard, kept out of the components so it can be unit tested: which courses show for a
// term, what one-line insight a card shows, which warnings it shows, how assignments are grouped.
import type { Course, GradeCut, GradeResult, Item, LetterBasis, Level, NeededResult } from '../types'
import { NON_FACTORABLE, stripPlusMinus } from '../lib/cmu'
import { article, formatPercent } from '../lib/format'
import { isCountable, plannedCategories } from '../lib/grade'
import { termsOf } from '../lib/merge'

/** An empty result, for courses the grade math has not seen (should not happen, but never crash on it). */
export const EMPTY_GRADE: GradeResult = { percent: null, letter: null, categories: [], graded: 0, remaining: 0 }

/**
 * "A-" -> "A", "B+" -> "B". CMU undergrad final grades have no plus or minus, and F is called R.
 * stripPlusMinus also handles the Unicode minus some Canvas schemes use ("A−").
 */
function family(letter: string): string {
  const base = stripPlusMinus(letter)
  return base === 'F' ? 'R' : base
}

/**
 * For undergrads, a Canvas scheme like A 93 / A- 90 / B+ 87 / B 83 / B- 80 really means "A from 90, B from 80",
 * because an A- or B+ in Canvas turns into a plain A or B on the transcript. Keep, for each letter family, the
 * lowest cut (the easiest way to get that letter), labeled with the plain letter. Grad students keep every cut.
 */
export function collapseScheme(scheme: GradeCut[], level: Level): GradeCut[] {
  if (level === 'grad') return scheme
  const byFamily = new Map<string, number>()
  for (const cut of scheme) {
    const f = family(cut.letter)
    const prev = byFamily.get(f)
    if (prev === undefined || cut.min < prev) byFamily.set(f, cut.min)
  }
  return [...byFamily].map(([letter, min]) => ({ letter, min })).sort((a, b) => b.min - a.min)
}

/** Same idea for "what you need" rows: keep the lowest cut of each letter family (undergrad only). */
export function collapseNeeded(needed: NeededResult[], level: Level): NeededResult[] {
  if (level === 'grad') return needed
  const byFamily = new Map<string, NeededResult>()
  for (const n of needed) {
    const f = family(n.letter)
    const prev = byFamily.get(f)
    if (!prev || n.min < prev.min) byFamily.set(f, { ...n, letter: f })
  }
  return [...byFamily.values()].sort((a, b) => b.min - a.min)
}

/**
 * "What you need" only makes sense when the course has assignments. A hand-added course with just a percent
 * has nothing left to score, so it gets no rows (otherwise every letter would read "out of reach").
 */
export function neededFor(course: Course, compute: (c: Course) => NeededResult[], level: Level): NeededResult[] {
  if (course.items.length === 0) return []
  return collapseNeeded(compute(course), level)
}

/** Terms that have at least one academic course with a graded item. */
export function termsWithGrades(courses: Course[], grades: Map<string, GradeResult>): Set<string> {
  const out = new Set<string>()
  for (const c of courses) {
    if (c.academic && c.term && (grades.get(c.key)?.graded ?? 0) > 0) out.add(c.term)
  }
  return out
}

/**
 * Which term the dashboard shows. `terms` come newest first.
 *  1. The term the student picked, if it still exists.
 *  2. Else the newest term with graded work (`gradedTerms`). Next semester's courses often show up on Canvas or
 *     Gradescope in November, before this semester's grades are final; we don't want to jump to an empty term.
 *  3. Else the newest term, else null.
 */
export function pickTerm(terms: string[], chosen: string | null, gradedTerms?: Set<string>): string | null {
  if (chosen && terms.includes(chosen)) return chosen
  const newestGraded = gradedTerms ? terms.find((t) => gradedTerms.has(t)) : undefined
  return newestGraded ?? terms[0] ?? null
}

/** A course only typed in by hand (no Canvas or Gradescope data). */
export function isManualOnly(c: Course): boolean {
  return c.sources.length > 0 && c.sources.every((s) => s.source === 'manual')
}

/**
 * main  = academic, not hidden, in the selected term. These count toward QPA.
 * other = what "Show N hidden courses" reveals: hidden courses of this term, non-academic Canvas shells, and
 *         synced courses with no term (Canvas "Default Term").
 * Courses from other terms are in neither list; switch the term to see them.
 * Hand-added courses with no term (added on the welcome page, before any sync) belong to the newest term only,
 * since that is the semester the student is in. Counting them in every term would add them to past QPAs. (With SIO
 * synced they have a term already: buildCourses gives them SIO's semester in progress.)
 */
export function splitCourses(courses: Course[], term: string | null): { main: Course[]; other: Course[] } {
  const newest = termsOf(courses)[0] ?? null
  const main: Course[] = []
  const other: Course[] = []
  for (const c of courses) {
    const manualNoTerm = c.term === null && isManualOnly(c)
    const inTerm = c.term === term || (manualNoTerm && term === newest)
    if (inTerm && c.academic && !c.prefs.hidden) main.push(c)
    else if (inTerm || (c.term === null && !manualNoTerm)) other.push(c)
  }
  return { main, other }
}

/** The percent a card shows: our computed one, else Canvas's own, else the one typed in by hand. */
export function shownPercent(course: Course, grade: GradeResult | undefined): number | null {
  return grade?.percent ?? course.canvasScore ?? course.manualPercent ?? null
}

/** Rounded to 2 decimals the same way the letter math does, so "89.999" counts as 90. */
function atLeast(percent: number | null, min: number): boolean {
  return percent != null && Math.round(percent * 100) / 100 >= min
}

/**
 * The one-line insight under a card's grade. `needed` is ordered from the highest letter down, so the first
 * letter that is not out of reach is the best one the student can still get.
 */
export function courseInsight(needed: NeededResult[], grade: GradeResult | undefined): string | null {
  if (needed.length === 0) return null
  // 'locked' means nothing is left to grade (whether or not the letter was reached).
  if (needed.every((n) => n.status === 'locked')) return 'Every grade is in'
  if (needed.every((n) => n.status === 'unknown')) return "Point values for the rest aren't posted yet"
  const best = needed.find((n) => n.status !== 'impossible')
  if (!best) return `Even 100% on the rest stays below ${needed[needed.length - 1].letter}`
  if (best.status === 'guaranteed') return `${best.letter} is locked in`
  if (best.status === 'possible' && best.needed != null) {
    return `Need ${best.needed.toFixed(1)}% on the rest for ${article(best.letter)} ${best.letter}`
  }
  return grade && grade.remaining === 0 ? 'Every grade is in' : null
}

/** Text for one row of the "What you need" table. */
export function neededText(n: NeededResult, percent: number | null): string {
  switch (n.status) {
    case 'guaranteed':
      return 'Guaranteed'
    case 'locked':
      // "locked" only means nothing is left to grade; whether you have the letter depends on the percent.
      return atLeast(percent, n.min) ? 'Locked in' : 'Out of reach'
    case 'possible':
      return n.needed != null ? `Need ${n.needed.toFixed(1)}% avg on remaining work` : 'Possible'
    case 'impossible':
      return 'Out of reach'
    case 'unknown':
      return "Point values aren't posted yet"
  }
}

/**
 * The "to go" half of a card's meta line, e.g. "14 graded · 3 to go" or "14 graded · Final Exam to go".
 * Counts remaining items that are worth points (or whose points are unknown), plus empty weighted categories
 * the "what you need" math plans for (e.g. a 30% final not posted yet), so the two never disagree.
 */
export function toGoText(course: Course, grade: GradeResult): string {
  // Categories that already have an item counted in grade.remaining are covered by that item.
  const ignored = new Set(course.prefs.ignored ?? [])
  const hasRemainingItem = (key: string) =>
    course.items.some(
      (i) => i.categoryKey === key && i.score === null && isCountable(i, ignored) && (i.max === null || i.max > 0),
    )
  const empty = plannedCategories(course).filter((c) => !hasRemainingItem(c.key))
  const graded = `${grade.graded} graded`
  if (grade.remaining === 0 && empty.length === 1) return `${graded} · ${empty[0].name} to go`
  return `${graded} · ${grade.remaining + empty.length} to go`
}

/** Sum of every category weight (null counts as 0). */
export function weightSum(course: Course): number {
  return course.categories.reduce((sum, c) => sum + (c.weight ?? 0), 0)
}

/** Small amber notes on a card. */
export function courseWarnings(course: Course, grade: GradeResult | undefined): string[] {
  const out: string[] = []
  const p = grade?.percent ?? null
  if (course.canvasScore != null && p != null && Math.abs(course.canvasScore - p) > 0.5) {
    out.push(`Canvas shows ${formatPercent(course.canvasScore)}`)
  }
  if (!course.weighted && course.categories.length >= 2 && course.items.length > 0) {
    out.push('Using total points. Add syllabus weights for a better estimate.')
  }
  if (course.weighted && course.categories.length > 0) {
    // We check the syllabus total (all categories), not only the ones with grades yet: an empty "Final Exam"
    // category is normal mid-semester, but weights that never reach 100 usually mean a typo.
    const sum = weightSum(course)
    if (Math.abs(sum - 100) > 0.01) out.push(`Weights add up to ${Math.round(sum * 100) / 100}%`)
  }
  return out
}

/** Where a percent sits on the card's bar, which runs from 50% (left) to 100% (right). Returns 0-100. */
export function barPosition(percent: number): number {
  return Math.min(100, Math.max(0, (percent - 50) * 2))
}

/** Newest due date first; items with no due date go last; ties by name. */
export function sortNewestFirst(items: Item[]): Item[] {
  return [...items].sort((a, b) => {
    const ta = a.due ? Date.parse(a.due) : NaN
    const tb = b.due ? Date.parse(b.due) : NaN
    if (Number.isNaN(ta) !== Number.isNaN(tb)) return Number.isNaN(ta) ? 1 : -1
    if (!Number.isNaN(ta) && ta !== tb) return tb - ta
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })
}

export interface ItemGroup {
  key: string
  name: string
  items: Item[]
}

/** Items grouped by category in the course's category order. Items pointing at an unknown category go in "Other". */
export function groupItems(course: Course): ItemGroup[] {
  const known = new Set(course.categories.map((c) => c.key))
  const groups: ItemGroup[] = course.categories.map((c) => ({
    key: c.key,
    name: c.name,
    items: sortNewestFirst(course.items.filter((i) => i.categoryKey === c.key)),
  }))
  const orphans = course.items.filter((i) => !known.has(i.categoryKey))
  if (orphans.length) groups.push({ key: '__other', name: 'Other', items: sortNewestFirst(orphans) })
  return groups
}

/**
 * A zero-point placeholder: no score, worth 0 points, not planned and no what-if. Canvas courses often have dozens
 * of these (lecture notes, attendance sign-ins). They never change the grade, so the course view hides them by default.
 */
export function isZeroPointPlaceholder(item: Item, whatIf: Record<string, number> | undefined): boolean {
  return item.score === null && item.max === 0 && !item.planned && whatIf?.[item.key] === undefined
}

/** Category keys to hide from the course view: they hold only zero-point placeholders and carry no weight. */
export function placeholderOnlyCategories(course: Course): Set<string> {
  const hide = new Set<string>()
  for (const cat of course.categories) {
    const items = course.items.filter((i) => i.categoryKey === cat.key)
    const weighty = course.weighted && (cat.weight ?? 0) > 0
    if (items.length > 0 && !weighty && items.every((i) => isZeroPointPlaceholder(i, course.prefs.whatIf))) hide.add(cat.key)
  }
  return hide
}

// ---------------------------------------------------------------- simple class list and class page

/**
 * One line of "What you need", said after the letter: "A: 74% average on what's left", "B: Guaranteed".
 * Same meaning as neededText, in fewer words.
 */
export function neededLine(n: NeededResult, percent: number | null): string {
  if (n.status === 'possible' && n.needed != null) return `${Number(n.needed.toFixed(1))}% average on what's left`
  return neededText(n, percent)
}

/**
 * The short muted hint under a class in the list, or null when there is nothing worth saying.
 * `letter` is the letter the row shows, so a student who already has an A reads "to keep the A".
 * `whatIf` is true when the percent includes made-up scores.
 */
export function rowHint(
  course: Course,
  needed: NeededResult[],
  grade: GradeResult | undefined,
  letter: string | null = null,
  whatIf = false,
): string | null {
  if (course.prefs.passFail) return 'Pass/fail'
  if (course.sio?.gradeOption === 'A') return 'Audit, not in your QPA'
  if (course.prefs.hidden) return notInSio(course) ? 'Not in your SIO classes' : 'Hidden'
  if (whatIf) return 'Includes what-if scores'
  // "Point values aren't posted yet" is true for most Gradescope classes mid-semester: not worth a line.
  if (needed.length > 0 && needed.every((n) => n.status === 'unknown')) return null
  const best = needed.find((n) => n.status !== 'impossible')
  if (best && best.status === 'possible' && best.needed != null && letter === best.letter) {
    return `Need ${best.needed.toFixed(1)}% on the rest to keep the ${best.letter}`
  }
  return courseInsight(needed, grade)
}

/**
 * The letter a class shows, on its row and on its page. A pass/fail class shows P, since its letter doesn't count
 * toward the QPA, or N (CMU's "no pass") when the grade so far is failing. With no grade yet it shows none (the row
 * shows "?"). A final grade posted in SIO, or a letter that never counts (like W), shows as it is.
 */
export function shownLetter(course: Course, letter: string | null, basis: LetterBasis | null): string | null {
  if (!course.prefs.passFail || basis === 'sio-final' || letter === null) return letter
  if (letter === 'R' || letter === 'X') return 'N'
  if (NON_FACTORABLE.includes(letter)) return letter
  return 'P'
}

/**
 * Whether a class in the main list gets the one-tap P/F button. Not once SIO has settled it: the final grade is
 * posted (the class is over) or the class is audited (it never counts). If the student turned P/F on anyway, the
 * button stays so they can turn it off again.
 */
export function offersPassFail(course: Course): boolean {
  const settled = Boolean(course.sio?.finalGrade) || course.sio?.gradeOption === 'A'
  const setByStudent = course.prefs.passFail === true && course.sio?.gradeOption !== 'P'
  return !settled || setByStudent
}

const SOURCE_LABELS: Record<Course['sources'][number]['source'], string> = {
  canvas: 'Canvas',
  gradescope: 'Gradescope',
  autolab: 'Autolab',
  manual: 'you',
}

/** "From Canvas + Gradescope + SIO", "From SIO", or "Added by hand" for a class typed in by hand. */
export function sourceText(course: Course): string {
  if (isManualOnly(course)) return 'Added by hand'
  const names = [...new Set(course.sources.filter((s) => s.source !== 'manual').map((s) => SOURCE_LABELS[s.source]))]
  if (course.sio?.registered) names.push('SIO')
  return names.length > 0 ? `From ${names.join(' + ')}` : 'Added by hand'
}

// ---------------------------------------------------------------- SIO bits on the class list and class page

/** SIO has this class's term but doesn't list the class: the student isn't registered for it. */
export function notInSio(course: Course): boolean {
  return course.sio?.registered === false
}

/**
 * The mid-semester grade from SIO, or null. It says "used for your QPA" only when the QPA really uses it: the letter
 * comes from it (`basis` is 'sio-mid' because nothing else is known) and the class counts (`counts`: it is in the
 * QPA, so not pass/fail, audited or hidden).
 */
export function midGradeNote(course: Course, basis: LetterBasis | null, counts: boolean): string | null {
  const mid = course.sio?.midGrade
  if (!mid) return null
  return basis === 'sio-mid' && counts ? `Mid-semester ${mid}, used for your QPA` : `Mid-semester ${mid}`
}

/**
 * The SIO line on a class row, or null: the posted final grade, else the mid-semester grade (midGradeNote).
 * `basis` is where the row's letter came from (letterWithBasis).
 */
export function sioRowNote(course: Course, basis: LetterBasis | null, counts: boolean): string | null {
  if (basis === 'sio-final') return 'Final grade from SIO'
  return midGradeNote(course, basis, counts)
}
