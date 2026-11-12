// Course grade math (Canvas-compatible) and "what do I need on the rest for an A/B/C".
//
// The goal is to reproduce Canvas's own "current score" exactly, because students compare our number
// to Canvas. Every rule below was checked against the canvas-lms source (Nov 2026):
//   ui/shared/grading/CourseGradeCalculator.ts       (combining groups: weights, renormalizing)
//   ui/shared/grading/AssignmentGroupGradeCalculator.ts (one group: excused, drop rules)
//   lib/grade_calculator.rb                            (the server copy that fills computed_current_score)
//   packages/grading-utils/src/index.js                (percent -> letter)
import type { Category, CategoryResult, Course, GradeCut, GradeResult, Item, NeededResult } from '../types'

export interface GradeOptions {
  whatIf?: Record<string, number> // itemKey -> hypothetical score in points
  fillRemaining?: number | null // if set (0..1), every remaining countable item scores fillRemaining * max
}

/** A scored item ready for the math: points earned and points possible. */
export interface Entry {
  key: string
  score: number
  max: number // 0 for extra credit items (points with nothing possible)
}

// ------------------------------------------------------------------ small helpers

function sumScore(entries: Entry[]): number {
  return entries.reduce((total, e) => total + e.score, 0)
}

function sumMax(entries: Entry[]): number {
  return entries.reduce((total, e) => total + e.max, 0)
}

/** Percent-like ratio of a set. Extra credit with nothing possible counts as "infinitely good". */
function ratio(score: number, max: number): number {
  if (max > 0) return score / max
  if (score > 0) return Infinity
  if (score < 0) return -Infinity
  return 0
}

/**
 * Round a percent to 2 decimals the way Canvas does: it does the math in exact decimals (big.js) and
 * rounds half up. Floats can turn 89.995 into 89.99499999999, so first cut float noise with
 * toPrecision(12), then shift the decimal point with an "e2" string so 89.995 becomes exactly 8999.5.
 */
export function roundPercent(x: number): number {
  const clean = Number(x.toPrecision(12))
  const shifted = Math.round(Number(`${clean}e2`))
  const result = Number(`${shifted}e-2`)
  return Number.isFinite(result) ? result : Math.round(x * 100) / 100
}

/** Does `percent` earn a cut with minimum `min`? Canvas compares the 2-decimal rounded score, floored at 0. */
function meetsCut(percent: number | null, min: number): boolean {
  if (percent === null) return false
  return roundPercent(Math.max(percent, 0)) >= roundPercent(min)
}

/** The score to use for an item: a what-if if there is one, else the real score (null = no score). */
function effectiveScore(item: Item, whatIf: Record<string, number>): number | null {
  if (Object.hasOwn(whatIf, item.key) && Number.isFinite(whatIf[item.key])) return whatIf[item.key]
  return item.score
}

// ------------------------------------------------------------------ drop rules

/** Number of ways to choose k of n, stopping early once it passes `cap` (we only need "is it small?"). */
function choose(n: number, k: number, cap: number): number {
  k = Math.min(k, n - k)
  let result = 1
  for (let i = 1; i <= k; i++) {
    result = (result * (n - k + i)) / i
    if (result > cap) return result
  }
  return result
}

/** Call fn with every set of k indexes out of 0..n-1 (in increasing order). */
function forEachCombination(n: number, k: number, fn: (indexes: number[]) => void): void {
  const picked: number[] = []
  function step(start: number) {
    if (picked.length === k) {
      fn(picked)
      return
    }
    // Leave enough indexes after i to finish the set.
    for (let i = start; i <= n - (k - picked.length); i++) {
      picked.push(i)
      step(i + 1)
      picked.pop()
    }
  }
  step(0)
}

type KeepMode = 'highest' | 'lowest'

/**
 * Exact answer by trying every way to drop (n - keep) items. Simple and obviously right; used when
 * there are at most a few thousand combinations, which covers nearly every real course.
 * The grade of a choice includes the never-drop items (`fixed`), like Canvas.
 */
export function keepBestBruteForce(entries: Entry[], keep: number, fixed: Entry[], mode: KeepMode): Entry[] {
  const dropCount = entries.length - keep
  const allScore = sumScore(entries) + sumScore(fixed)
  const allMax = sumMax(entries) + sumMax(fixed)
  let bestDropped: number[] = []
  let bestRatio = 0
  let first = true
  forEachCombination(entries.length, dropCount, dropped => {
    let score = allScore
    let max = allMax
    for (const i of dropped) {
      score -= entries[i].score
      max -= entries[i].max
    }
    const r = ratio(score, max)
    const better = mode === 'highest' ? r > bestRatio : r < bestRatio
    if (first || better) {
      bestDropped = [...dropped]
      bestRatio = r
      first = false
    }
  })
  return entries.filter((_, i) => !bestDropped.includes(i))
}

/**
 * Exact answer for big groups, using the method Canvas uses ("Dropping Lowest Grades", Kane & Kane,
 * cited in AssignmentGroupGradeCalculator.ts). Idea: guess a percent q. Each item is worth
 * (score - q * max) relative to q. Keep the `keep` items worth the most (or least): if their total
 * (plus the never-drop items) is >= 0, the best possible percent is at least q. Binary search q.
 */
export function keepBestBisection(entries: Entry[], keep: number, fixed: Entry[], mode: KeepMode): Entry[] {
  const all = [...entries, ...fixed]
  // Bounds on any set's percent: positive points over the smallest possible max, and the same for negatives.
  const positiveMaxes = all.filter(e => e.max > 0).map(e => e.max)
  const minMax = positiveMaxes.length > 0 ? Math.min(...positiveMaxes) : 1
  let lo = all.reduce((t, e) => t + Math.min(e.score, 0), 0) / minMax
  let hi = all.reduce((t, e) => t + Math.max(e.score, 0), 0) / minMax

  // Items ranked by value at q, best first for 'highest' (worst first for 'lowest'); keep the top `keep`.
  function pick(q: number): { kept: Entry[]; value: number } {
    const ranked = [...entries].sort((a, b) => {
      const diff = b.score - q * b.max - (a.score - q * a.max)
      return mode === 'highest' ? diff : -diff
    })
    const kept = ranked.slice(0, keep)
    const value = [...kept, ...fixed].reduce((t, e) => t + e.score - q * e.max, 0)
    return { kept, value }
  }

  for (let i = 0; i < 100 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2
    if (pick(mid).value >= 0) lo = mid
    else hi = mid
  }
  const keptSet = new Set(pick((lo + hi) / 2).kept)
  return entries.filter(e => keptSet.has(e)) // keep the original order
}

/** Keep the best (or worst) `keep` items: brute force when small, bisection otherwise. */
function keepBest(entries: Entry[], keep: number, fixed: Entry[], mode: KeepMode): Entry[] {
  // Canvas keepHelper: always keep at least one item.
  keep = Math.max(1, keep)
  if (entries.length <= keep) return entries
  if (choose(entries.length, keep, 5000) <= 5000) return keepBestBruteForce(entries, keep, fixed, mode)
  return keepBestBisection(entries, keep, fixed, mode)
}

/**
 * Apply a category's drop rules to its scored entries. Returns the keys of dropped entries.
 * Rules confirmed in AssignmentGroupGradeCalculator.ts (dropAssignments) and grade_calculator.rb (drop_assignments):
 *  - never_drop items are set aside and always kept, but they still count when judging which set is best.
 *  - Drop at most (droppable - 1) lowest, so at least one droppable item stays.
 *  - If drop lowest + drop highest would remove every droppable item, drop highest is ignored.
 *  - "Drop lowest" drops the items whose removal gives the HIGHEST category percent (not simply the lowest
 *    percents: with unequal max points these differ). Then "drop highest" drops, from what is left, the items
 *    whose removal gives the LOWEST percent.
 *  - If no item has points possible (all extra credit), Canvas simply sorts by score instead.
 */
export function applyDropRules(
  entries: Entry[],
  dropLowest: number,
  dropHighest: number,
  neverDrop: Set<string>,
): Set<string> {
  const none = new Set<string>()
  if (!(dropLowest > 0 || dropHighest > 0)) return none

  const fixed = entries.filter(e => neverDrop.has(e.key))
  const droppable = entries.filter(e => !neverDrop.has(e.key))
  if (droppable.length === 0) return none

  const lowest = Math.min(Math.max(dropLowest, 0), droppable.length - 1)
  const highest = lowest + dropHighest >= droppable.length ? 0 : Math.max(dropHighest, 0)
  const keepHighest = droppable.length - lowest
  const keepLowest = keepHighest - highest

  let kept: Entry[]
  if (entries.some(e => e.max > 0)) {
    kept = keepBest(droppable, keepHighest, fixed, 'highest')
    kept = keepBest(kept, keepLowest, fixed, 'lowest')
  } else {
    // grade_calculator.rb drop_unpointed: sort by score, keep the top keepHighest, then the bottom keepLowest of those.
    const sorted = [...droppable].sort((a, b) => a.score - b.score)
    kept = sorted.slice(sorted.length - keepHighest).slice(0, keepLowest)
  }
  const keptSet = new Set(kept)
  return new Set(droppable.filter(e => !keptSet.has(e)).map(e => e.key))
}

// ------------------------------------------------------------------ the course grade

/** GradeResult plus how much work fillRemaining had to fill (used by neededForLetters). */
interface GradeDetail {
  result: GradeResult
  filled: number // remaining items that got a fill score
  virtual: number // empty weighted categories that got a virtual item
}

/** Categories of the course, plus a stand-in for any item whose category no longer exists. */
function categoriesWithOrphans(course: Course): Category[] {
  const categories = [...course.categories]
  const known = new Set(categories.map(c => c.key))
  for (const item of course.items) {
    if (!known.has(item.categoryKey)) {
      known.add(item.categoryKey)
      categories.push({ key: item.categoryKey, name: 'Other', weight: null, dropLowest: 0, dropHighest: 0, neverDrop: [] })
    }
  }
  return categories
}

function computeGrade(course: Course, opts: GradeOptions): GradeDetail {
  const whatIf = opts.whatIf ?? {}
  const fill = typeof opts.fillRemaining === 'number' ? opts.fillRemaining : null
  const ignored = new Set(course.prefs.ignored ?? [])

  let graded = 0
  let remaining = 0
  let filled = 0
  let virtual = 0
  const categories: CategoryResult[] = []

  for (const cat of categoriesWithOrphans(course)) {
    const entries: Entry[] = []
    for (const item of course.items) {
      if (item.categoryKey !== cat.key) continue
      // Countable: Canvas skips omitted ("do not count toward final grade") and excused items.
      if (item.omit || item.status === 'excused' || ignored.has(item.key)) continue

      const score = effectiveScore(item, whatIf)
      if (score !== null) {
        graded++
        // Canvas parseScore turns a missing points_possible into 0, so a score with no max is extra credit.
        entries.push({ key: item.key, score, max: item.max ?? 0 })
      } else {
        // No score yet: Canvas's "current score" ignores it. When planning, give it fill * max.
        // Items with an unknown max (or max 0) can't be planned for, so they stay ignored.
        // Zero-point placeholders (attendance, lecture notes) are not "work to go", so they don't count as remaining.
        if (item.max === null || item.max > 0) remaining++
        if (fill !== null && item.max !== null && item.max > 0) {
          entries.push({ key: item.key, score: fill * item.max, max: item.max })
          filled++
        }
      }
    }

    // When planning, a weighted category with no points possible yet (e.g. "Final Exam", not posted)
    // still has to be earned: stand in one 100-point item for it.
    if (fill !== null && course.weighted && (cat.weight ?? 0) > 0 && sumMax(entries) === 0) {
      entries.push({ key: `virtual:${cat.key}`, score: fill * 100, max: 100 })
      virtual++
    }

    const dropped = applyDropRules(entries, cat.dropLowest, cat.dropHighest, new Set(cat.neverDrop))
    const kept = entries.filter(e => !dropped.has(e.key))
    const earned = sumScore(kept)
    const possible = sumMax(kept)
    categories.push({
      key: cat.key,
      name: cat.name,
      weight: cat.weight,
      earned,
      possible,
      percent: possible > 0 ? (earned / possible) * 100 : null,
      dropped: [...dropped].filter(k => !k.startsWith('virtual:')),
      counted: false, // set below
    })
  }

  let percent: number | null = null
  if (course.weighted) {
    // CourseGradeCalculator.ts combineAssignmentGroupGrades: only groups with points possible count
    // (an empty group, or one with only extra credit, is skipped). A null weight counts as 0.
    const counted = categories.filter(c => c.possible > 0)
    const fullWeight = counted.reduce((t, c) => t + (c.weight ?? 0), 0)
    const total = counted.reduce((t, c) => t + (c.earned / c.possible) * (c.weight ?? 0), 0)
    for (const c of counted) c.counted = (c.weight ?? 0) > 0
    if (fullWeight === 0) percent = null
    // Weights of the counted groups add to less than 100: scale up, so 45/50 of the weight = 90%.
    else if (fullWeight < 100) percent = (total * 100) / fullWeight
    // Weights add to 100 or more: Canvas does NOT scale down (over-100 weights act like bonus).
    else percent = total
  } else {
    // Total points (grade_calculator.rb): sum of earned over sum of possible across every group; group
    // weights are ignored even when they are set.
    const earned = categories.reduce((t, c) => t + c.earned, 0)
    const possible = categories.reduce((t, c) => t + c.possible, 0)
    percent = possible > 0 ? (earned / possible) * 100 : null
    if (percent !== null) for (const c of categories) c.counted = c.possible > 0 || c.earned !== 0
  }

  const result: GradeResult = {
    percent,
    letter: letterFor(percent, course.scheme),
    categories,
    graded,
    remaining,
  }
  return { result, filled, virtual }
}

/**
 * The course grade. With no what-ifs and no fill this matches Canvas's "current score" (Canvas rounds
 * the shown number to 2 decimals; we keep full precision and let the UI format it).
 */
export function gradeCourse(course: Course, opts: GradeOptions = {}): GradeResult {
  return computeGrade(course, opts).result
}

/**
 * The letter for a percent: the highest cut whose minimum the percent reaches, after rounding the percent
 * to 2 decimals and treating negatives as 0. Below every cut you get the lowest letter, like Canvas
 * (grading-utils scoreToLetterGrade). Null when there is no percent or no scheme.
 */
export function letterFor(percent: number | null, scheme: GradeCut[]): string | null {
  if (percent === null || !Number.isFinite(percent) || scheme.length === 0) return null
  const sorted = [...scheme].sort((a, b) => b.min - a.min)
  const cut = sorted.find(c => meetsCut(percent, c.min))
  return (cut ?? sorted[sorted.length - 1]).letter
}

/**
 * For each letter (except the lowest), the average percent needed on all remaining work to get it.
 * "Remaining work" = countable items with no score and a known max, plus weighted categories with nothing
 * in them yet. Remaining items with an unknown max are ignored (we can't know what they're worth).
 */
export function neededForLetters(course: Course, whatIf: Record<string, number> = {}): NeededResult[] {
  const sorted = [...course.scheme].sort((a, b) => b.min - a.min)
  const cuts = sorted.slice(0, -1) // the lowest letter (R/F) is always "reached"
  const gradeAt = (x: number) => computeGrade(course, { whatIf, fillRemaining: x })

  const atOne = gradeAt(1)
  const hasRemaining = atOne.filled + atOne.virtual > 0
  const current = gradeCourse(course, { whatIf }).percent
  const atZero = gradeAt(0).result.percent
  const atFull = atOne.result.percent

  return cuts.map(cut => {
    const base = { letter: cut.letter, min: cut.min }
    if (!hasRemaining) {
      // Nothing left to earn: you either have this letter or you don't.
      return meetsCut(current, cut.min)
        ? { ...base, needed: null, status: 'locked' as const }
        : { ...base, needed: null, status: 'impossible' as const }
    }
    if (meetsCut(atZero, cut.min)) return { ...base, needed: 0, status: 'guaranteed' as const }
    if (!meetsCut(atFull, cut.min)) return { ...base, needed: null, status: 'impossible' as const }

    // Binary search for the smallest average x (0..1) on remaining work that earns the cut.
    let lo = 0 // known to miss
    let hi = 1 // known to earn
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2
      if (meetsCut(gradeAt(mid).result.percent, cut.min)) hi = mid
      else lo = mid
    }
    // Round UP to 0.1% so the shown number is always enough (the tiny epsilon absorbs float noise).
    const needed = Math.min(100, Math.ceil(hi * 1000 - 1e-6) / 10)
    return { ...base, needed, status: 'possible' as const }
  })
}
