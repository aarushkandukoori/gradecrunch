// View logic for the dashboard, kept out of the components so it can be unit tested: which courses show for a
// term, what one-line insight a card shows, which warnings it shows, how assignments are grouped.
import type { Course, GradeCut, GradeResult, Item, Level, NeededResult } from '../types'
import { article, formatPercent } from '../lib/format'

/** An empty result, for courses the grade math has not seen (should not happen, but never crash on it). */
export const EMPTY_GRADE: GradeResult = { percent: null, letter: null, categories: [], graded: 0, remaining: 0 }

/** "A-" -> "A", "B+" -> "B". CMU undergrad final grades have no plus or minus, and F is called R. */
function family(letter: string): string {
  const base = letter.trim().toUpperCase().replace(/[+-]$/, '')
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

/** The saved term if it still exists, else the newest term (terms come newest first), else null. */
export function pickTerm(terms: string[], saved: string | null): string | null {
  if (saved && terms.includes(saved)) return saved
  return terms[0] ?? null
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
 * Hand-added courses with no term show in every term (the student did not pick one).
 */
export function splitCourses(courses: Course[], term: string | null): { main: Course[]; other: Course[] } {
  const main: Course[] = []
  const other: Course[] = []
  for (const c of courses) {
    const inTerm = c.term === term || (c.term === null && isManualOnly(c))
    if (inTerm && c.academic && !c.prefs.hidden) main.push(c)
    else if (inTerm || c.term === null) other.push(c)
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
  if (needed.every((n) => n.status === 'locked')) return 'Every grade is in'
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
  }
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
