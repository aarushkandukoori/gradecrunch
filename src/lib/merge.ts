// Turns what we synced (Canvas + Gradescope + hand-added courses) plus the student's own fixes (prefs) into
// one clean Course per real class. This is where "21241 on Canvas" and "21241 on Gradescope" become one card.
//
// Steps (numbers match the build spec):
//  1. group synced courses by term + course number (cross-listed numbers join the same group)
//  2. take categories and items from Canvas
//  3. match Gradescope items onto Canvas items by name; add the rest as new items
//  4. Gradescope-only courses get categories guessed from item names
//  5. guess unknown max points from similar items
//  5b. grading weights from the syllabus, when we can read them (see syllabus.ts)
//  6. add hand-made courses
//  6b. SIO, for terms it has: units, grade option and grades per class, classes SIO doesn't list hidden, and
//      registered courses with no other data added as classes of their own
//  7. apply the student's prefs (weights, moves, planned items, units, cutoffs)
//     Weights, per category: the student's own > the syllabus's (when confidently read) > Canvas's group weights.
//     Units: the student's own > SIO's > the catalog's > 9.
//  8. pick a title
//  9. sort
import type {
  Category,
  Course,
  CoursePrefs,
  CourseSio,
  CourseSourceRef,
  GradeCut,
  Item,
  ItemStatus,
  ManualCourse,
  SioCourse,
  Store,
  SyllabusDoc,
  SyncedCourse,
  SyncedItem,
} from '../types'
import { lookupCourse } from './catalog'
import { bestCategoryMatch, inferCategory, normalizeName } from './categorize'
import { DEFAULT_SCHEME_GRAD, DEFAULT_SCHEME_UNDERGRAD } from './cmu'
import { canonicalTerm, parseCourseNumbers, termSortKey } from './courseNumber'
import { levelFor, semestersFor, termInProgress } from './sio'
import { matchDrop, matchWeights, moveTargets, pickSyllabus, type CategoryRef } from './syllabus'

// termSortKey lives in courseNumber.ts (so the payload validator can use it without this file); re-exported
// here because the UI and tests have always imported it from merge.
export { canonicalTerm, termSortKey }

const DEFAULT_UNITS = 9 // most CMU courses are 9 units; the UI asks the student to check SIO
const STATUSES: ItemStatus[] = ['graded', 'submitted', 'ungraded', 'missing', 'unsubmitted', 'excused']

// ---------------------------------------------------------------- small safety helpers
// Stored data can be old or hand-edited, so never trust a field to exist or have the right type.

/** A finite number, or null. */
function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}

function str(x: unknown): string {
  return typeof x === 'string' ? x : ''
}

function list<T>(x: T[] | null | undefined): T[] {
  return Array.isArray(x) ? x : []
}

/** Middle value of a list of numbers (average of the two middle ones for even lengths). */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Copy a scheme, drop broken rows and sort by cutoff, highest first. Returns null when nothing usable is left. */
function cleanScheme(scheme: GradeCut[] | null | undefined): GradeCut[] | null {
  const rows = list(scheme)
    .filter((c) => c && typeof c.letter === 'string' && c.letter.trim() !== '' && num(c.min) !== null)
    .map((c) => ({ letter: c.letter.trim(), min: c.min }))
    .sort((a, b) => b.min - a.min)
  return rows.length > 0 ? rows : null
}

/** All course numbers a synced course claims (main + cross-listings). */
function numbersOf(c: SyncedCourse): string[] {
  return c.number ? [c.number, ...list(c.alsoNumbers)] : []
}

// ---------------------------------------------------------------- terms

/** Distinct terms of academic courses, newest first (null terms left out). */
export function termsOf(courses: Course[]): string[] {
  const terms: string[] = []
  for (const c of courses) {
    if (c.academic && c.term && !terms.includes(c.term)) terms.push(c.term)
  }
  return terms.sort((a, b) => termSortKey(b) - termSortKey(a) || a.localeCompare(b))
}

// ---------------------------------------------------------------- step 1: grouping

interface Group {
  key: string
  number: string | null
  term: string | null
  members: SyncedCourse[] // Canvas members first, then Gradescope, then Autolab
}

// Which source decides a group's key and number, and wins ties: Canvas, then Gradescope, then Autolab.
// (Sorting by the source name would put "autolab" before "canvas".)
const SOURCE_RANK: Record<string, number> = { canvas: 0, gradescope: 1, autolab: 2 }

/** Clean up a synced course read from storage (fill missing fields, re-parse numbers if needed). */
function sanitizeSynced(raw: SyncedCourse): SyncedCourse | null {
  if (!raw || typeof raw !== 'object') return null
  if (raw.source !== 'canvas' && raw.source !== 'gradescope' && raw.source !== 'autolab') return null
  const sourceId = str(raw.sourceId) || (typeof raw.sourceId === 'number' ? String(raw.sourceId) : '')
  if (!sourceId) return null
  // Re-parse numbers so a hand-edited "21-241" still works; a null number stays null (non-academic shell).
  const number = typeof raw.number === 'string' ? parseCourseNumbers(raw.number).number : null
  const alsoNumbers: string[] = []
  for (const text of list(raw.alsoNumbers)) {
    const p = parseCourseNumbers(str(text))
    for (const n of [p.number, ...p.also]) if (n && n !== number && !alsoNumbers.includes(n)) alsoNumbers.push(n)
  }
  return {
    ...raw,
    sourceId,
    number,
    alsoNumbers,
    title: str(raw.title).trim(),
    // One spelling per term ("F26" and "fall 2026" -> "Fall 2026"), so grouping and keys agree across sites.
    term: canonicalTerm(str(raw.term)),
    url: str(raw.url),
    weighted: raw.weighted === true,
    categories: list(raw.categories).filter((c) => c && typeof c === 'object' && (str(c.id) || typeof c.id === 'number')),
    items: list(raw.items).filter((i) => i && typeof i === 'object' && (str(i.id) || typeof i.id === 'number')),
    canvasScore: num(raw.canvasScore),
    canvasGrade: str(raw.canvasGrade) || null,
    syncedAt: str(raw.syncedAt),
  }
}

/**
 * Group synced courses into real classes. Same term + same number = same class (e.g. a lecture shell and a
 * recitation shell on Canvas, plus the Gradescope course). A cross-listed number also joins ("10-335/615" on
 * Gradescope joins "10615" on Canvas). Different terms never merge, and courses without a number never merge.
 */
function groupSynced(synced: Store['synced']): Group[] {
  const courses = Object.values(synced ?? {})
    .map(sanitizeSynced)
    .filter((c): c is SyncedCourse => c !== null)
    // Canvas first so it decides keys and wins ties; then by id so the result never depends on storage order.
    .sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.sourceId.localeCompare(b.sourceId))

  const groups: Group[] = []
  for (const c of courses) {
    if (!c.number) {
      groups.push({ key: `${c.source}:${c.sourceId}`, number: null, term: c.term, members: [c] })
      continue
    }
    const mine = numbersOf(c)
    const existing = groups.find(
      (g) => g.number !== null && g.term === c.term && g.members.some((m) => numbersOf(m).some((n) => mine.includes(n))),
    )
    if (existing) existing.members.push(c)
    else groups.push({ key: `${c.term ?? ''}|${c.number}`, number: c.number, term: c.term, members: [c] })
  }
  return groups
}

// ---------------------------------------------------------------- steps 2-4: categories and items

/** A category created from item names (Gradescope has no categories), key "g:<kind>". */
function ensureInferredCategory(categories: Category[], kind: string): string {
  const key = `g:${kind}`
  if (!categories.some((c) => c.key === key)) {
    categories.push({ key, name: kind, weight: null, dropLowest: 0, dropHighest: 0, neverDrop: [] })
  }
  return key
}

/** Category for an item we could not place: best name match among existing categories, else a guessed one. */
function placeItem(categories: Category[], name: string): string {
  return bestCategoryMatch(name, categories) ?? ensureInferredCategory(categories, inferCategory(name))
}

function makeItem(si: SyncedItem, key: string, categoryKey: string, source: Item['source']): Item {
  return {
    key,
    name: str(si.name).trim() || 'Untitled',
    categoryKey,
    score: num(si.score),
    max: num(si.max),
    maxEstimated: false,
    status: STATUSES.includes(si.status) ? si.status : 'unsubmitted',
    due: str(si.due) || null,
    omit: si.omit === true,
    url: str(si.url) || null,
    source,
    otherScore: null,
    planned: false,
  }
}

/**
 * Step 2: Canvas assignment groups become categories, Canvas assignments become items.
 * `useWeights` is false for every shell except the one weighted shell the group takes weights from: two shells
 * each bring weights that add to 100, so keeping both would let the grade go above 100%.
 */
function addCanvas(course: SyncedCourse, categories: Category[], items: Item[], useWeights: boolean): void {
  const catKey = (groupId: string) => `c:${course.sourceId}:${groupId}`
  for (const sc of course.categories) {
    const key = catKey(String(sc.id))
    if (categories.some((c) => c.key === key)) continue // duplicate group id: keep the first
    categories.push({
      key,
      name: str(sc.name).trim() || 'Untitled group',
      weight: useWeights ? num(sc.weight) : null,
      dropLowest: Math.max(0, Math.floor(num(sc.dropLowest) ?? 0)),
      dropHighest: Math.max(0, Math.floor(num(sc.dropHighest) ?? 0)),
      neverDrop: list(sc.neverDrop).map((id) => `c:${id}`),
    })
  }
  for (const si of course.items) {
    const key = `c:${si.id}`
    if (items.some((i) => i.key === key)) continue // same assignment twice: keep the first
    const groupKey = si.categoryId !== null && si.categoryId !== undefined ? catKey(String(si.categoryId)) : null
    const categoryKey = groupKey && categories.some((c) => c.key === groupKey) ? groupKey : placeItem(categories, str(si.name))
    items.push(makeItem(si, key, categoryKey, 'canvas'))
  }
}

/** Two max values agree when they are equal (within rounding). */
function sameMax(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && Math.abs(a - b) <= 0.001
}

/** Canvas items keep their "c:" key even after a Gradescope score fills them in (their `source` changes). */
function fromCanvas(item: Item): boolean {
  return item.key.startsWith('c:')
}

/**
 * Find the existing item a Gradescope item is the same assignment as: equal normalized name, preferring an equal
 * max, then an unknown max, then a Canvas item with a different max (instructors often rescale Gradescope scores
 * on Canvas, e.g. a 60 point exam shown out of 100; counting it twice would wreck the grade). A different max is
 * NOT a match between Gradescope and Autolab: "Lab 1" written on Gradescope (20 pts) and "Lab 1" code on Autolab
 * (100 pts) are two real deliverables. `taken` holds items already matched by another item of the same course.
 */
function findMatch(gs: SyncedItem, items: Item[], taken: Set<string>): Item | null {
  const name = normalizeName(str(gs.name))
  if (!name) return null
  const candidates = items.filter((i) => !i.planned && !taken.has(i.key) && normalizeName(i.name) === name)
  const gsMax = num(gs.max)
  return (
    candidates.find((i) => sameMax(i.max, gsMax)) ??
    candidates.find((i) => i.max === null || gsMax === null) ??
    candidates.find(fromCanvas) ??
    null
  )
}

/** Gradescope score converted to the matched item's point scale (they differ when the course rescales). */
function scaledScore(gsScore: number, gsMax: number | null, target: Item): number {
  if (gsMax !== null && gsMax > 0 && target.max !== null && target.max > 0 && !sameMax(gsMax, target.max)) {
    return (gsScore / gsMax) * target.max
  }
  return gsScore
}

/**
 * Autolab reports its own category for each item ("Lab", "Exam"). Put the item in the matching existing
 * category if there is one, else create that Autolab category (unweighted until the student sets weights).
 */
function placeAutolabItem(course: SyncedCourse, si: SyncedItem, categories: Category[]): string {
  const cat = course.categories.find((c) => str(c.id) === str(si.categoryId))
  if (!cat) return placeItem(categories, str(si.name))
  const match = bestCategoryMatch(str(cat.name), categories)
  if (match) return match
  const key = `a:${course.sourceId}:${str(cat.id)}`
  if (!categories.some((c) => c.key === key)) {
    categories.push({ key, name: str(cat.name).trim() || 'Autolab', weight: null, dropLowest: 0, dropHighest: 0, neverDrop: [] })
  }
  return key
}

/**
 * Step 3 and 4: merge one Gradescope (or Autolab) course's items into the group. Items with the same name as an
 * existing (Canvas) item are the same assignment: fill in what Canvas lacks instead of counting it twice.
 */
function addGradescope(course: SyncedCourse, categories: Category[], items: Item[]): void {
  const source = course.source === 'autolab' ? 'autolab' : 'gradescope'
  const prefix = source === 'autolab' ? 'a' : 'g'
  const taken = new Set<string>()
  for (const si of course.items) {
    const gsScore = num(si.score)
    const gsMax = num(si.max)
    const key = `${prefix}:${course.sourceId}:${si.id}` // this item's own key when nothing matches
    const target = findMatch(si, items, taken)

    if (!target) {
      if (items.some((i) => i.key === key)) continue
      const categoryKey = source === 'autolab' ? placeAutolabItem(course, si, categories) : placeItem(categories, str(si.name))
      items.push(makeItem(si, key, categoryKey, source))
      taken.add(key)
      continue
    }

    taken.add(target.key)
    // Remember our own key: prefs saved under it (before Canvas posted this column) must still find the item.
    if (!list(target.aliases).includes(key)) target.aliases = [...list(target.aliases), key]
    if (target.max === null && gsMax !== null) target.max = gsMax // learn the max if we did not know it
    if (target.status === 'excused' || target.omit) {
      // Canvas excused it or leaves it out of the grade: that decision wins. Only show the other site's score.
      if (gsScore !== null) {
        target.otherScore = scaledScore(gsScore, gsMax, target)
        target.otherSource = source
      }
    } else if (target.score === null && gsScore !== null) {
      // Canvas has nothing yet (often Gradescope scores reach Canvas late): use Gradescope's.
      target.score = scaledScore(gsScore, gsMax, target)
      target.status = 'graded'
      target.source = source
    } else if (target.score !== null && gsScore !== null) {
      // Both have a score and they disagree. Gradescope is where these assignments are graded, and the copy on
      // Canvas lags behind regrades, so Gradescope's score wins and Canvas's is shown next to it. Two exceptions
      // keep the Canvas score: Autolab (its Canvas copy often has late penalties applied by hand) and a different
      // max on Canvas (the instructor rescaled or curved it there on purpose).
      const other = scaledScore(gsScore, gsMax, target)
      if (Math.abs(other - target.score) > 0.001) {
        const sameScale = gsMax === null || target.max === null || sameMax(gsMax, target.max)
        if (source === 'gradescope' && fromCanvas(target) && target.source === 'canvas' && sameScale) {
          target.otherScore = target.score
          target.otherSource = 'canvas'
          target.score = other
          target.source = 'gradescope'
        } else {
          target.otherScore = other
          target.otherSource = source
        }
      }
    } else if (target.score === null && target.status === 'unsubmitted' && (si.status === 'submitted' || si.status === 'ungraded')) {
      // Neither has a score, but Gradescope knows it was turned in (or the paper exam happened).
      target.status = si.status
    }
    if (!target.url && str(si.url)) target.url = str(si.url)
    if (!target.due && str(si.due)) target.due = str(si.due)
  }
}

// ---------------------------------------------------------------- step 5: unknown max points

/**
 * Gradescope hides max points until an item is graded. Guess them from scored items in the same category:
 * the median of their max values (which is simply the shared value when they all agree).
 */
function estimateMissingMax(items: Item[]): void {
  for (const item of items) {
    if (item.max !== null || item.omit || item.planned) continue
    const maxes = items
      .filter((o) => o !== item && o.categoryKey === item.categoryKey && !o.maxEstimated && o.score !== null && o.max !== null && o.max > 0)
      .map((o) => o.max as number)
    const guess = median(maxes)
    if (guess !== null) {
      item.max = guess
      item.maxEstimated = true
    }
  }
}

// ---------------------------------------------------------------- step 6: alternate exam versions

// "Midterm 1A", "Exam 2 (Alt)", "Final Makeup": a second version of an exam for students who took it at another
// time. Only one version of the pair is yours, so counting both would double the remaining work.
const ALT_SUFFIX = /^(.*?\S)[\s\-_(]*(?:a|b|alt|alternate|make\s*-?\s*up|conflict)\)?$/i

/**
 * For each exam whose name is another exam's name plus an "alternate" suffix, count only one of the two: the one
 * with a score, else the main version. Only for exam-like names, so "HW 1" + "HW 1B" (two real parts) are left
 * alone. The student can undo this per item (prefs.included).
 */
function markAlternateExams(items: Item[], included: Set<string>): void {
  for (const alt of items) {
    if (alt.planned || alt.omit || inferCategory(alt.name) !== 'Exams') continue
    const m = alt.name.trim().match(ALT_SUFFIX)
    const baseName = m ? normalizeName(m[1]) : ''
    if (!baseName) continue
    const base = items.find(
      (b) => b !== alt && !b.planned && !b.omit && b.categoryKey === alt.categoryKey && normalizeName(b.name) === baseName,
    )
    if (!base) continue
    const skip = alt.score === null ? alt : base.score === null ? base : null // both scored: keep both
    if (!skip || included.has(skip.key)) continue
    skip.omit = true
    skip.skipReason = skip === alt ? `Alternate version of ${base.name}` : `You took ${alt.name} instead`
  }
}

// ---------------------------------------------------------------- steps 7-8: prefs, units, scheme, title

/** Strip a leading course number from a source title: "21-241 Matrices" -> "Matrices", "15122: PIC" -> "PIC". */
export function stripNumberPrefix(title: string): string {
  return title
    .replace(/^\s*\d{1,3}\.\s+/, '') // Canvas nickname ordering like "1. 21241"
    .replace(/^\s*\d{2}-?\d{3}(?:\/(?:\d{2}-?)?\d{3})*(?:-[A-Za-z0-9]+)?(?:\s+[A-Z]\d{2})?\s*(?:[:|\-–]\s*)?/, '')
    .trim()
}

function bestTitle(number: string | null, members: SyncedCourse[]): string {
  const catalog = number ? lookupCourse(number) : null
  if (catalog && catalog.title) return catalog.title
  for (const source of ['canvas', 'gradescope', 'autolab'] as const) {
    for (const m of members) {
      if (m.source !== source) continue
      const t = number ? stripNumberPrefix(m.title) : m.title.trim()
      if (t) return t
    }
  }
  if (number) return `${number.slice(0, 2)}-${number.slice(2)}`
  return members.find((m) => m.title)?.title || 'Untitled course'
}

function catalogUnits(numbers: string[]): number | null {
  for (const n of numbers) {
    const entry = lookupCourse(n)
    if (entry && entry.units !== null) return entry.units
  }
  return null
}

/** Read prefs defensively: anything malformed is treated as "not set". */
function prefsFor(store: Store, key: string): CoursePrefs {
  const p = store.prefs && Object.hasOwn(store.prefs, key) ? store.prefs[key] : null
  return p && typeof p === 'object' ? p : {}
}

/**
 * Prefs with item keys rewritten to each item's current key. An item that first came from Gradescope had the key
 * "g:<course>:<id>"; once Canvas posts the same column the item becomes "c:<id>" and keeps the old key in
 * `aliases`. A what-if, move or ignore saved under the old key is moved to the new one. When both keys have an
 * entry, the one under the current key wins (it is the newer edit). The UI and grade math only see current keys.
 */
export function rekeyPrefs(prefs: CoursePrefs, items: Item[]): CoursePrefs {
  const current = new Map<string, string>() // old key -> current item key
  for (const i of items) for (const a of list(i.aliases)) current.set(a, i.key)
  if (current.size === 0) return prefs

  function rekeyMap<T>(map: Record<string, T>): Record<string, T> {
    const out: Record<string, T> = {}
    // Old-key entries first, so an entry saved under the current key overwrites them.
    for (const [k, v] of Object.entries(map)) if (current.has(k)) out[current.get(k) as string] = v
    for (const [k, v] of Object.entries(map)) if (!current.has(k)) out[k] = v
    return out
  }
  function rekeyList(keys: string[]): string[] {
    return [...new Set(keys.map((k) => current.get(k) ?? k))]
  }

  const out: CoursePrefs = { ...prefs }
  if (prefs.whatIf && typeof prefs.whatIf === 'object') out.whatIf = rekeyMap(prefs.whatIf)
  if (prefs.moved && typeof prefs.moved === 'object') out.moved = rekeyMap(prefs.moved)
  if (Array.isArray(prefs.whatIfGraded)) out.whatIfGraded = rekeyList(prefs.whatIfGraded)
  if (Array.isArray(prefs.ignored)) out.ignored = rekeyList(prefs.ignored)
  if (Array.isArray(prefs.included)) out.included = rekeyList(prefs.included)
  return out
}

/** Everything a course needs before prefs are applied. */
interface Draft {
  key: string
  number: string | null
  alsoNumbers: string[]
  title: string
  term: string | null
  academic: boolean
  sources: CourseSourceRef[]
  weighted: boolean
  categories: Category[]
  items: Item[]
  canvasScore: number | null
  canvasGrade: string | null
  canvasScheme: GradeCut[] | null
  manualPercent: number | null
  weightNote: string | null
  syllabusUsed: { name: string; url: string | null } | null
  sio: CourseSio | null // what SIO says, for a class in a term SIO has (step 6b)
}

/**
 * What SIO implies, filled in where the student set nothing: grade option "P" means pass/fail, and a class SIO
 * doesn't list is hidden. Anything the student saved (true or false) wins. Returns a copy; saved prefs never change.
 */
function withSioDefaults(prefs: CoursePrefs, sio: CourseSio | null): CoursePrefs {
  if (!sio) return prefs
  const out = { ...prefs }
  if (sio.gradeOption === 'P' && out.passFail === undefined) out.passFail = true
  if (!sio.registered && out.hidden === undefined) out.hidden = true
  return out
}

/** Step 7: the student's fixes win over synced data. */
function applyPrefs(d: Draft, savedPrefs: CoursePrefs, store: Store): Course {
  const prefs = withSioDefaults(rekeyPrefs(savedPrefs, d.items), d.sio)
  const weighted = typeof prefs.weighted === 'boolean' ? prefs.weighted : d.weighted
  const weights = prefs.weights && typeof prefs.weights === 'object' ? prefs.weights : {}

  const categories = d.categories.map((c) => ({ ...c })) // copies, so prefs never leak into the draft

  // Items the student moved to another category (ignore moves to categories that no longer exist).
  const moved = prefs.moved && typeof prefs.moved === 'object' ? prefs.moved : {}
  const items = d.items.map((i) => {
    const to = moved[i.key]
    return typeof to === 'string' && categories.some((c) => c.key === to) ? { ...i, categoryKey: to } : i
  })

  // Planned future items the student added. If their category is gone, guess one from the name.
  for (const m of list(prefs.extra)) {
    if (!m || typeof m !== 'object' || !str(m.key) || items.some((i) => i.key === m.key)) continue
    const name = str(m.name).trim() || 'Planned item'
    const categoryKey = categories.some((c) => c.key === m.categoryKey) ? m.categoryKey : placeItem(categories, name)
    items.push({
      key: m.key,
      name,
      categoryKey,
      score: null,
      max: num(m.max),
      maxEstimated: false,
      status: 'unsubmitted',
      due: null,
      omit: false,
      url: null,
      source: 'manual',
      otherScore: null,
      planned: true,
    })
  }

  // Guess unknown max points after moves, so the guess uses the category the student chose.
  estimateMissingMax(items)
  markAlternateExams(items, new Set(Array.isArray(prefs.included) ? prefs.included : []))

  // Weights: a pref replaces the synced weight (syllabus or Canvas). In total-points mode weights do not apply, so
  // they are null. (Done last so categories created above for planned items get their saved weight too.)
  for (const c of categories) {
    const mine = num(weights[c.key])
    if (!weighted) {
      c.weight = null
      delete c.weightSource
    } else if (mine !== null) {
      c.weight = mine
      c.weightSource = 'you'
    } else if (c.weight !== null) {
      c.weightSource = c.weightSource ?? 'canvas'
    }
  }

  // Units: student's number, else SIO's exact units, else the catalog, else 9 (and the UI says "check SIO").
  const customUnits = num(prefs.units)
  const fromSio = num(d.sio?.units)
  const fromCatalog = d.number ? catalogUnits([d.number, ...d.alsoNumbers]) : null
  let units = DEFAULT_UNITS
  let unitsSource: Course['unitsSource'] = 'default'
  if (customUnits !== null && customUnits >= 0) {
    units = customUnits
    unitsSource = 'custom'
  } else if (fromSio !== null && fromSio >= 0) {
    units = fromSio
    unitsSource = 'sio'
  } else if (fromCatalog !== null) {
    units = fromCatalog
    unitsSource = 'catalog'
  }

  // Letter cutoffs: student's own, else the Canvas course's, else CMU's default for their level.
  const custom = cleanScheme(prefs.cutoffs)
  let scheme: GradeCut[]
  let schemeSource: Course['schemeSource']
  if (custom) {
    scheme = custom
    schemeSource = 'custom'
  } else if (d.canvasScheme) {
    scheme = d.canvasScheme
    schemeSource = 'canvas'
  } else {
    // The term's record decides the scale: the one SIO puts the term in, else the Level setting (sio.ts levelFor).
    const level = levelFor(store?.sio, d.term, store?.settings?.level === 'grad' ? 'grad' : 'undergrad')
    const fallback = level === 'grad' ? DEFAULT_SCHEME_GRAD : DEFAULT_SCHEME_UNDERGRAD
    scheme = fallback.map((c) => ({ ...c })) // copy so nobody can change the shared default
    schemeSource = 'default'
  }

  return {
    key: d.key,
    number: d.number,
    alsoNumbers: d.alsoNumbers,
    title: d.title,
    term: d.term,
    academic: d.academic,
    sources: d.sources,
    weighted,
    categories,
    items,
    canvasScore: d.canvasScore,
    canvasGrade: d.canvasGrade,
    scheme,
    schemeSource,
    units,
    unitsSource,
    manualPercent: d.manualPercent,
    prefs,
    // Notes about syllabus weights only matter while weights are on.
    weightNote: weighted ? d.weightNote : null,
    syllabusUsed: weighted ? d.syllabusUsed : null,
    sio: d.sio,
  }
}

/** How many items of a synced course have a score. */
function scoredCount(c: SyncedCourse): number {
  return c.items.filter((i) => num(i.score) !== null).length
}

/**
 * The one Canvas shell a group takes category weights from: a weighted shell, preferring one where Canvas shows
 * its own score (the real lecture shell), then the one with the most scored items. Null when no shell is weighted.
 */
function weightShell(canvas: SyncedCourse[]): SyncedCourse | null {
  let best: SyncedCourse | null = null
  for (const c of canvas) {
    if (!c.weighted) continue // an unweighted shell's stored group weights are not used by Canvas either
    if (best === null) {
      best = c
      continue
    }
    const hasScore = c.canvasScore !== null
    const bestHasScore = best.canvasScore !== null
    if (hasScore !== bestHasScore ? hasScore : scoredCount(c) > scoredCount(best)) best = c
  }
  return best
}

/** The two notes the class page shows about where the weights came from. */
export const NOTE_CANVAS_UNWEIGHTED = "Using syllabus weights; Canvas isn't weighted"
export const NOTE_CANVAS_DIFFERENT = "Canvas's weights don't match the syllabus; using the syllabus"

/**
 * Step 5b: when a syllabus document has grading weights we can read with confidence, they replace Canvas's.
 *  - every category gets the syllabus weight it matches (0 when the syllabus doesn't mention it),
 *  - syllabus parts with no category (e.g. "Final Exam 30%" before Canvas has that group) become empty planned
 *    categories, so "what do I need" plans for them,
 *  - items sitting in an unweighted catch-all group move to the category of their kind,
 *  - simple drop rules ("lowest homework is dropped") apply where Canvas has none.
 * Returns the note and the document used, or null when no syllabus could be used (Canvas weights stay).
 */
function applySyllabus(
  canvas: SyncedCourse[],
  categories: Category[],
  items: Item[],
  canvasWeighted: boolean,
): { note: string | null; doc: SyllabusDoc } | null {
  const docs = canvas.flatMap((c) => list(c.syllabus)).filter((d) => d && typeof d === 'object')
  const found = pickSyllabus(docs)
  if (!found) return null

  // `size` (items worth points) lets matching prefer the group that really holds the work.
  const refs = (): CategoryRef[] =>
    categories.map((c) => ({
      key: c.key,
      name: c.name,
      weight: c.weight,
      size: items.filter((i) => i.categoryKey === c.key && (i.score !== null || (i.max ?? 0) > 0)).length,
    }))
  const plan = matchWeights(found.weights.items, refs())
  const canvasWeights = new Map(categories.map((c) => [c.key, c.weight ?? 0]))

  for (const c of categories) {
    c.weight = plan.weights[c.key] ?? 0
    c.weightSource = 'syllabus'
  }
  for (const a of plan.added) {
    categories.push({ key: a.key, name: a.name, weight: a.weight, weightSource: 'syllabus', dropLowest: 0, dropHighest: 0, neverDrop: [] })
  }

  const weightNow: Record<string, number> = {}
  for (const c of categories) weightNow[c.key] = c.weight ?? 0
  const moves = moveTargets(items, refs(), weightNow)
  for (const i of items) if (moves[i.key]) i.categoryKey = moves[i.key]

  for (const d of found.weights.drops) {
    const key = matchDrop(d.label, refs())
    const cat = categories.find((c) => c.key === key)
    if (cat && cat.dropLowest === 0) cat.dropLowest = d.dropLowest // Canvas's own drop rule, when set, wins
  }

  const differs =
    plan.added.some((a) => a.weight > 0) ||
    [...canvasWeights].some(([key, before]) => Math.abs(before - (plan.weights[key] ?? 0)) > 0.01)
  const note = !canvasWeighted ? NOTE_CANVAS_UNWEIGHTED : differs ? NOTE_CANVAS_DIFFERENT : null
  return { note, doc: found.doc }
}

/** Steps 2-5 and 8 for one group of synced courses. */
function draftFromGroup(g: Group): Draft {
  const categories: Category[] = []
  const items: Item[] = []
  const canvas = g.members.filter((m) => m.source === 'canvas')
  const gradescope = g.members.filter((m) => m.source === 'gradescope')
  const autolab = g.members.filter((m) => m.source === 'autolab')

  const weightsFrom = weightShell(canvas)
  for (const c of canvas) addCanvas(c, categories, items, c === weightsFrom)
  for (const c of gradescope) addGradescope(c, categories, items)
  for (const c of autolab) addGradescope(c, categories, items)
  const syllabus = applySyllabus(canvas, categories, items, weightsFrom !== null)

  const alsoNumbers: string[] = []
  for (const m of g.members) {
    for (const n of numbersOf(m)) if (n !== g.number && !alsoNumbers.includes(n)) alsoNumbers.push(n)
  }

  // Canvas's own score: from the first Canvas shell that shows one (another shell may be an empty recitation).
  const scored = canvas.find((c) => c.canvasScore !== null)
  const withScheme = canvas.map((c) => cleanScheme(c.scheme)).find((s) => s !== null) ?? null

  return {
    key: g.key,
    number: g.number,
    alsoNumbers,
    title: bestTitle(g.number, g.members),
    term: g.term,
    academic: g.number !== null,
    sources: g.members.map((m) => ({ source: m.source, sourceId: m.sourceId, url: m.url, syncedAt: m.syncedAt })),
    weighted: weightsFrom !== null || syllabus !== null,
    categories,
    items,
    canvasScore: scored ? scored.canvasScore : null,
    canvasGrade: scored ? scored.canvasGrade : (canvas.find((c) => c.canvasGrade)?.canvasGrade ?? null),
    canvasScheme: withScheme,
    manualPercent: null,
    weightNote: syllabus ? syllabus.note : null,
    syllabusUsed: syllabus ? { name: str(syllabus.doc.name) || 'Syllabus', url: str(syllabus.doc.url) || null } : null,
    sio: null,
  }
}

/** Step 6: a course the student typed in by hand. */
function draftFromManual(m: ManualCourse): Draft | null {
  if (!m || typeof m !== 'object' || !str(m.key)) return null
  const parsed = parseCourseNumbers(str(m.number))
  const number = parsed.number
  const catalog = number ? lookupCourse(number) : null
  const title = str(m.title).trim() || catalog?.title || (number ? `${number.slice(0, 2)}-${number.slice(2)}` : 'Untitled course')
  return {
    key: m.key,
    number,
    alsoNumbers: parsed.also,
    title,
    term: canonicalTerm(str(m.term)),
    // The student added it on purpose, so it is a real class even if they left the number blank.
    academic: true,
    sources: [{ source: 'manual', sourceId: m.key, url: '', syncedAt: '' }],
    weighted: false,
    categories: [],
    items: [],
    canvasScore: null,
    canvasGrade: null,
    canvasScheme: null,
    manualPercent: num(m.percent),
    weightNote: null,
    syllabusUsed: null,
    sio: null,
  }
}

// ---------------------------------------------------------------- step 6b: SIO (CMU's official record)

/**
 * Titles compared loosely: "Intro. to Computer Systems" and "intro to computer systems" are the same, and so are
 * "Art & Machine Learning" and "Art and Machine Learning" (CMU writes cross-listed titles both ways).
 */
function titleKey(title: string): string {
  return title.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '')
}

/** What a class gets from the SIO course it matched. */
function sioInfo(sc: SioCourse): CourseSio {
  return {
    registered: true,
    units: num(sc.units),
    gradeOption: str(sc.gradeOption) || null,
    midGrade: str(sc.midGrade) || null,
    finalGrade: str(sc.finalGrade) || null,
  }
}

/** A registered SIO course that no Canvas, Gradescope or hand-added class matched (an independent study, say). */
function draftFromSio(sc: SioCourse, number: string, term: string, key: string): Draft {
  const catalog = lookupCourse(number)
  return {
    key,
    number,
    alsoNumbers: list(sc.alsoNumbers).filter((n) => typeof n === 'string' && n !== number),
    title: str(sc.title).trim() || catalog?.title || `${number.slice(0, 2)}-${number.slice(2)}`,
    term,
    academic: true,
    sources: [],
    weighted: false,
    categories: [],
    items: [],
    canvasScore: null,
    canvasGrade: null,
    canvasScheme: null,
    manualPercent: null,
    weightNote: null,
    syllabusUsed: null,
    sio: sioInfo(sc),
  }
}

/** A class only typed in by hand (no synced data). */
function isManualDraft(d: Draft): boolean {
  return d.sources.length > 0 && d.sources.every((s) => s.source === 'manual')
}

/**
 * Step 6b: for every term SIO has, line the classes up with the courses SIO says you are registered for.
 *  - A class SIO lists (same course number or a cross-listed one; failing that, the same title, for a class whose
 *    other number only SIO shows) gets SIO's units, grade option and grades.
 *  - A Canvas, Gradescope or Autolab class SIO doesn't list is marked not registered, so applyPrefs hides it (the
 *    student can show it again). Hand-added classes are never hidden: the student added them on purpose. (One added
 *    with no term already has the semester in progress as its term, see buildCourses, so SIO doesn't add it twice.)
 *  - An SIO course nothing matched becomes a class of its own (an independent study, say), for a term the student
 *    already has other classes in and for the semester in progress. Not for a finished semester with nothing else
 *    (the Past semesters page lists those) or for next semester (registered early, nothing to show yet).
 * A term whose SIO courses have no readable numbers is left alone, so a change to SIO's page can't hide every class.
 */
function addSio(drafts: Draft[], store: Store, current: string | null): void {
  const sio = store?.sio
  if (!sio || !Array.isArray(sio.semesters)) return
  const level = store.settings?.level === 'grad' ? 'grad' : 'undergrad'
  const terms = new Set(sio.semesters.map((s) => canonicalTerm(s?.term)))
  for (const term of terms) {
    if (term === null) continue
    const semesters = semestersFor(sio, term, level)
    const sioCourses = semesters.flatMap((s) => list(s.courses)).filter((c) => c && typeof c === 'object')
    if (!sioCourses.some((c) => typeof c.number === 'string')) continue

    const classes = drafts.filter((d) => d.academic && d.term === term)
    const taken = new Set<SioCourse>() // each SIO course goes to one class
    const numbersOfSio = (c: SioCourse) => [c.number, ...list(c.alsoNumbers)].filter((n): n is string => typeof n === 'string')
    for (const d of classes) {
      const mine = draftNumbers(d)
      const sc = sioCourses.find((c) => !taken.has(c) && numbersOfSio(c).some((n) => mine.includes(n)))
      if (sc) {
        taken.add(sc)
        d.sio = sioInfo(sc)
      }
    }
    for (const d of classes) {
      if (d.sio) continue
      const sc = sioCourses.find((c) => !taken.has(c) && str(c.title) !== '' && titleKey(str(c.title)) === titleKey(d.title))
      if (sc) {
        taken.add(sc)
        d.sio = sioInfo(sc)
      } else if (!isManualDraft(d)) {
        d.sio = { registered: false, units: null, gradeOption: null, midGrade: null, finalGrade: null }
      }
    }

    if (classes.length === 0 && term !== current) continue
    for (const sc of sioCourses) {
      if (taken.has(sc) || typeof sc.number !== 'string') continue
      // The same number twice (two sections of an independent study, say) gets "#2" so both count.
      let key = `${term}|${sc.number}`
      for (let n = 2; drafts.some((d) => d.key === key); n++) key = `${term}|${sc.number}#${n}`
      drafts.push(draftFromSio(sc, sc.number, term, key))
    }
  }
}

// ---------------------------------------------------------------- main entry

/** Every course number a draft claims (main + cross-listings). */
function draftNumbers(d: Draft): string[] {
  return d.number ? [d.number, ...d.alsoNumbers] : []
}

/** Two drafts are the same class: same term and at least one shared course number. */
function sameClass(a: Draft, b: Draft): boolean {
  const mine = draftNumbers(a)
  return a.term === b.term && draftNumbers(b).some((n) => mine.includes(n))
}

function hasSavedPrefs(store: Store, key: string): boolean {
  return !!store?.prefs && Object.hasOwn(store.prefs, key) && typeof store.prefs[key] === 'object'
}

/**
 * A group's key is "<term>|<number>", and the number can change when a new source joins (e.g. Canvas 18213
 * cross-listed as 15213). If nothing is saved under the new key but prefs exist under "<term>|<n>" for another
 * number n of the same class, keep using that older key so the student's weights, what-ifs and units stay.
 */
function keepSavedKeys(drafts: Draft[], store: Store): void {
  const used = new Set(drafts.map((d) => d.key)) // never give two courses the same key
  for (const d of drafts) {
    if (d.number === null || hasSavedPrefs(store, d.key)) continue
    for (const n of d.alsoNumbers) {
      const alt = `${d.term ?? ''}|${n}`
      if (!used.has(alt) && hasSavedPrefs(store, alt)) {
        used.add(alt)
        d.key = alt
        break
      }
    }
  }
}

/** Synced data + manual courses + SIO + prefs -> one Course per class, academic first, then by course number. */
export function buildCourses(store: Store): Course[] {
  const drafts: Draft[] = groupSynced(store?.synced ?? {}).map(draftFromGroup)
  keepSavedKeys(drafts, store)
  const syncedDrafts = [...drafts]
  // A class added by hand with no term (on the welcome page, before any sync) belongs to the semester in progress.
  // With SIO synced, SIO says which semester that is; without it, the class list puts the class in the newest term
  // (view.ts splitCourses). Giving it the term here also lets the line below catch a class synced since.
  const current = termInProgress(store?.sio)
  for (const m of list(store?.manual)) {
    const d = draftFromManual(m)
    if (!d || drafts.some((x) => x.key === d.key)) continue
    if (d.term === null) d.term = current
    // Same class already synced (same term, a shared number): the synced one wins, or QPA counts it twice.
    if (syncedDrafts.some((x) => sameClass(x, d))) continue
    drafts.push(d)
  }
  addSio(drafts, store, current)

  const courses = drafts.map((d) => applyPrefs(d, prefsFor(store, d.key), store))

  // Step 9: academic first, then by number (same number: newest term first), then by title.
  return courses.sort((a, b) => {
    if (a.academic !== b.academic) return a.academic ? -1 : 1
    if (a.number && b.number && a.number !== b.number) return a.number.localeCompare(b.number)
    if (a.number && !b.number) return -1
    if (!a.number && b.number) return 1
    return termSortKey(b.term) - termSortKey(a.term) || a.title.localeCompare(b.title) || a.key.localeCompare(b.key)
  })
}
