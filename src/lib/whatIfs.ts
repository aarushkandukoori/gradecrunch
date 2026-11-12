// Which what-if scores are actually changing a course's grade right now. The dashboard, the QPA card and the
// Ask Claude summary use this to label numbers that include made-up scores, so a what-if typed days ago is
// never mistaken for a real grade.
import { isCountable } from './grade'
import type { Course, CoursePrefs, Item } from '../types'

/**
 * True when the grade math uses the what-if saved for this item. Mirrors effectiveScore in grade.ts:
 *  - the item must count toward the grade (not omitted, excused or ignored),
 *  - its max must be known (a what-if on "Points unknown" is ignored),
 *  - and either it has no real score yet, or the student typed the what-if over the real score (whatIfGraded).
 */
export function whatIfApplies(item: Item, prefs: CoursePrefs): boolean {
  const value = prefs.whatIf?.[item.key]
  if (value === undefined || !Number.isFinite(value)) return false
  if (!isCountable(item, new Set(prefs.ignored ?? [])) || item.max === null) return false
  return item.score === null || (prefs.whatIfGraded ?? []).includes(item.key)
}

/** The items whose what-if scores are in this course's grade. Empty when the grade is all real. */
export function activeWhatIfs(course: Course): Item[] {
  return course.items.filter((i) => whatIfApplies(i, course.prefs))
}

/** Prefs with every what-if removed (both the scores and the "typed over a real score" list). */
export function withoutWhatIfs(p: CoursePrefs): CoursePrefs {
  return { ...p, whatIf: undefined, whatIfGraded: undefined }
}
