// Everything the app remembers lives in the student's own browser. This is the only file that touches
// localStorage / sessionStorage. Every access is wrapped in try/catch because storage can be blocked (private
// windows, strict privacy settings): the app must still work then, it just forgets on reload.
//
// It also holds small pure helpers that return an updated copy of the store or of one course's prefs, so React
// state updates stay one-liners in the components and are easy to test.
import { APP_SLUG } from './brand'
import { canonicalTerm } from './courseNumber'
import { capSyllabusText } from './syllabus'
import type { CoursePrefs, GradeCut, ManualCourse, ManualItem, Settings, Store, SyncedCourse, SyncPayload } from '../types'

export const STORE_KEY = `${APP_SLUG}:v1`
export const THEME_KEY = `${APP_SLUG}:theme`

export type Theme = 'system' | 'light' | 'dark'

// ---------------------------------------------------------------- raw storage access

/** localStorage or sessionStorage, or null when the browser blocks it (even reading `window.localStorage` can throw). */
function storageOf(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage
  } catch {
    return null
  }
}

function readKey(kind: 'local' | 'session', key: string): string | null {
  try {
    return storageOf(kind)?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeKey(kind: 'local' | 'session', key: string, value: string): void {
  try {
    storageOf(kind)?.setItem(key, value)
  } catch {
    // Full or blocked storage: nothing useful to do, the in-memory state still works.
  }
}

function removeKey(kind: 'local' | 'session', key: string): void {
  try {
    storageOf(kind)?.removeItem(key)
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------- the store

export function defaultSettings(): Settings {
  return { level: 'undergrad', college: null, priorQpa: null, priorUnits: null, term: null, showAll: false }
}

export function defaultStore(): Store {
  return { v: 1, synced: {}, manual: [], prefs: {}, settings: defaultSettings(), lastSync: {} }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function numberOrNull(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}

// A key like "__proto__" in a hand-edited file would change an object's prototype when copied, so skip it.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Only the strings of a list (or undefined when it is not a list). */
function stringList(x: unknown): string[] | undefined {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : undefined
}

/** Only the entries of a map whose value passes `keep` (or undefined when it is not a map). */
function recordOf<T>(x: unknown, keep: (v: unknown) => v is T): Record<string, T> | undefined {
  if (!isObject(x)) return undefined
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(x)) if (!UNSAFE_KEYS.has(k) && keep(v)) out[k] = v
  return out
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isString = (v: unknown): v is string => typeof v === 'string'

/**
 * Rebuilds one course's prefs field by field, keeping only values of the right type. An imported file with
 * "ignored": 5 or "letter": {} would otherwise crash the grade math (`new Set(5)`, `letter.trim()`).
 */
function parsePrefs(p: Record<string, unknown>): CoursePrefs {
  const units = numberOrNull(p.units)
  const out: CoursePrefs = {
    units: units !== null && units >= 0 ? units : undefined,
    letter: typeof p.letter === 'string' && p.letter.trim() !== '' ? p.letter.trim().slice(0, 10) : undefined,
    passFail: typeof p.passFail === 'boolean' ? p.passFail : undefined,
    hidden: typeof p.hidden === 'boolean' ? p.hidden : undefined,
    weighted: typeof p.weighted === 'boolean' ? p.weighted : undefined,
    weights: recordOf(p.weights, isFiniteNumber),
    whatIf: recordOf(p.whatIf, isFiniteNumber),
    whatIfGraded: stringList(p.whatIfGraded),
    moved: recordOf(p.moved, isString),
    ignored: stringList(p.ignored),
    included: stringList(p.included),
  }
  if (Array.isArray(p.cutoffs)) {
    out.cutoffs = p.cutoffs
      .filter((c): c is GradeCut => isObject(c) && typeof c.letter === 'string' && c.letter.trim() !== '' && isFiniteNumber(c.min))
      .map((c) => ({ letter: c.letter, min: c.min }))
  }
  if (Array.isArray(p.extra)) {
    out.extra = p.extra
      .filter(
        (m): m is ManualItem =>
          isObject(m) && typeof m.key === 'string' && m.key !== '' && isString(m.name) && isString(m.categoryKey) && isFiniteNumber(m.max),
      )
      .map((m) => ({ key: m.key, name: m.name, categoryKey: m.categoryKey, max: m.max }))
  }
  return cleanPrefs(out)
}

/**
 * Checks that `x` looks like a saved Store and returns a clean copy (or null if it clearly is not one).
 * Used when loading from localStorage and when importing a file. Synced courses are checked loosely (the merge
 * code already tolerates odd values inside them); prefs are rebuilt field by field because the UI and grade
 * math use them directly.
 */
export function parseStore(x: unknown): Store | null {
  if (!isObject(x) || x.v !== 1) return null
  if (!isObject(x.synced) || !Array.isArray(x.manual) || !isObject(x.prefs)) return null

  const synced: Record<string, SyncedCourse> = {}
  for (const [key, c] of Object.entries(x.synced)) {
    // A synced course must at least have lists we can loop over.
    if (!UNSAFE_KEYS.has(key) && isObject(c) && Array.isArray(c.items) && Array.isArray(c.categories)) synced[key] = c as unknown as SyncedCourse
  }

  const manual = x.manual.filter((m): m is ManualCourse => isObject(m) && typeof m.key === 'string')

  const prefs: Record<string, CoursePrefs> = {}
  for (const [key, p] of Object.entries(x.prefs)) if (!UNSAFE_KEYS.has(key) && isObject(p)) prefs[key] = parsePrefs(p)

  const s = isObject(x.settings) ? x.settings : {}
  const settings: Settings = {
    level: s.level === 'grad' ? 'grad' : 'undergrad',
    college: typeof s.college === 'string' ? s.college : null,
    priorQpa: numberOrNull(s.priorQpa),
    priorUnits: numberOrNull(s.priorUnits),
    term: typeof s.term === 'string' ? s.term : null,
    showAll: s.showAll === true,
  }

  const ls = isObject(x.lastSync) ? x.lastSync : {}
  const lastSync: Store['lastSync'] = {}
  if (typeof ls.canvas === 'string') lastSync.canvas = ls.canvas
  if (typeof ls.gradescope === 'string') lastSync.gradescope = ls.gradescope
  if (typeof ls.autolab === 'string') lastSync.autolab = ls.autolab

  return { v: 1, synced, manual, prefs, settings, lastSync, ...(x.demo === true ? { demo: true } : {}) }
}

/** The saved store, or a fresh one when nothing is saved or the saved JSON is corrupt. */
export function loadStore(): Store {
  const raw = readKey('local', STORE_KEY)
  if (!raw) return defaultStore()
  try {
    return parseStore(JSON.parse(raw)) ?? defaultStore()
  } catch {
    return defaultStore()
  }
}

export function saveStore(store: Store): void {
  writeKey('local', STORE_KEY, JSON.stringify(store))
}

/** The store as a pretty JSON file for "Export data". */
export function exportStoreJson(store: Store): string {
  return JSON.stringify(store, null, 2)
}

/**
 * Puts a sync result into the store. Pure: returns a new store and never changes the old one.
 *
 * Rules (a sync only sees part of the picture, so it only replaces what it actually saw):
 *  1. A payload with no courses changes no course data, only the sync time. An empty list usually means the
 *     site's page changed or it is between terms, not that every class was dropped.
 *  2. A course the sync could not read (its sourceId is in payload.failedIds) keeps its stored copy.
 *  3. A stored course from this source is replaced or removed only if the payload has the same course, or the
 *     payload covers its term. So a class you dropped this term disappears, but last term's classes (which Canvas
 *     and Gradescope stop listing once a term ends) stay with their final grades.
 * Courses from other sources are never touched. Prefs are keyed by merged course, so they survive.
 * Syllabus documents are saved as text only (at most 60 KB per course): PDFs never go into localStorage.
 */
export function applyPayload(store: Store, payload: SyncPayload): Store {
  payload = capSyllabusText(payload)
  // A real sync replaces the sample data (never mix demo courses with real ones), keeping hand-added classes.
  if (store.demo) store = withoutDemo(store)
  const lastSync = { ...store.lastSync, [payload.kind]: payload.at }
  if (payload.courses.length === 0) return { ...store, lastSync } // rule 1

  const failed = new Set(payload.failedIds ?? [])
  const inPayload = new Set(payload.courses.map((c) => c.sourceId))
  const termsInPayload = new Set(payload.courses.map((c) => canonicalTerm(c.term)))

  const synced: Record<string, SyncedCourse> = {}
  for (const [key, course] of Object.entries(store.synced)) {
    const replaced =
      course.source === payload.kind &&
      !failed.has(course.sourceId) && // rule 2
      (inPayload.has(course.sourceId) || termsInPayload.has(canonicalTerm(course.term))) // rule 3
    if (!replaced) synced[key] = course
  }
  for (const course of payload.courses) {
    const key = `${payload.kind}:${course.sourceId}`
    if (failed.has(course.sourceId) && synced[key]) continue // rule 2: the stored copy is better than a broken one
    synced[key] = { ...course, source: payload.kind }
  }
  return { ...store, synced, lastSync }
}

export function updateSettings(store: Store, patch: Partial<Settings>): Store {
  return { ...store, settings: { ...store.settings, ...patch } }
}

export function addManualCourse(store: Store, course: ManualCourse): Store {
  return { ...store, manual: [...store.manual, course] }
}

/** Deletes a hand-added course and its prefs. */
export function removeManualCourse(store: Store, key: string): Store {
  const prefs = { ...store.prefs }
  delete prefs[key]
  return { ...store, manual: store.manual.filter((m) => m.key !== key), prefs }
}

// ---------------------------------------------------------------- course prefs helpers (all pure)

/** Drops undefined fields and empty objects/lists so the saved JSON stays small and "no prefs" really means {}. */
export function cleanPrefs(p: CoursePrefs): CoursePrefs {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && v.length === 0) continue
    if (isObject(v) && Object.keys(v).length === 0) continue
    out[k] = v
  }
  return out as CoursePrefs
}

/**
 * Applies `change` to one course's prefs and returns the new store.
 * `current` (optional) is the course's prefs as the app shows them (Course.prefs, where item keys from before
 * Canvas posted a column are already renamed to the current keys). Starting from it saves those renamed keys, so
 * clearing a what-if or an ignore on the current key really clears it instead of the old key bringing it back.
 */
export function updatePrefs(
  store: Store,
  courseKey: string,
  change: (p: CoursePrefs) => CoursePrefs,
  current?: CoursePrefs,
): Store {
  const next = cleanPrefs(change({ ...(current ?? store.prefs[courseKey] ?? {}) }))
  const prefs = { ...store.prefs }
  if (Object.keys(next).length > 0) prefs[courseKey] = next
  else delete prefs[courseKey]
  return { ...store, prefs }
}

/** Copy of a string-keyed map with one key set, or removed when value is null. */
function setKey<T>(map: Record<string, T> | undefined, key: string, value: T | null): Record<string, T> {
  const out = { ...(map ?? {}) }
  if (value === null) delete out[key]
  else out[key] = value
  return out
}

/**
 * Sets (or clears, with null) a what-if score in points for one item.
 * `onGraded` = the item already has a real score and the student typed over it. Those keys go in
 * prefs.whatIfGraded so the what-if keeps applying after re-syncs; any other what-if stops once a real score lands.
 */
export function withWhatIf(p: CoursePrefs, itemKey: string, value: number | null, onGraded = false): CoursePrefs {
  const graded = (p.whatIfGraded ?? []).filter((k) => k !== itemKey)
  if (onGraded && value !== null) graded.push(itemKey)
  return { ...p, whatIf: setKey(p.whatIf, itemKey, value), whatIfGraded: graded.length > 0 ? graded : undefined }
}

/** Sets (or clears) one category weight. Typing a weight means "use weights", so weighted turns on. */
export function withWeight(p: CoursePrefs, categoryKey: string, weight: number | null): CoursePrefs {
  return { ...p, weights: setKey(p.weights, categoryKey, weight), weighted: true }
}

/** Count an item we skipped automatically (an alternate exam), or go back to skipping it. */
export function withIncluded(prefs: CoursePrefs, itemKey: string, on: boolean): CoursePrefs {
  const set = new Set(prefs.included ?? [])
  if (on) set.add(itemKey)
  else set.delete(itemKey)
  return cleanPrefs({ ...prefs, included: [...set] })
}

export function withIgnored(p: CoursePrefs, itemKey: string, ignored: boolean): CoursePrefs {
  const rest = (p.ignored ?? []).filter((k) => k !== itemKey)
  return { ...p, ignored: ignored ? [...rest, itemKey] : rest }
}

/** Moves an item to another category (null puts it back where the source had it). */
export function withMoved(p: CoursePrefs, itemKey: string, categoryKey: string | null): CoursePrefs {
  return { ...p, moved: setKey(p.moved, itemKey, categoryKey) }
}

export function withPlanned(p: CoursePrefs, item: ManualItem): CoursePrefs {
  return { ...p, extra: [...(p.extra ?? []), item] }
}

/** Removes a planned item and anything else that pointed at it. */
export function withoutPlanned(p: CoursePrefs, itemKey: string): CoursePrefs {
  return {
    ...withIgnored(withMoved(withWhatIf(p, itemKey, null), itemKey, null), itemKey, false),
    extra: (p.extra ?? []).filter((i) => i.key !== itemKey),
  }
}

/** Changes one letter's minimum, starting from the course's current scheme. Kept sorted high to low. */
export function withCutoff(p: CoursePrefs, scheme: GradeCut[], letter: string, min: number): CoursePrefs {
  const base = p.cutoffs ?? scheme
  const cutoffs = base.map((c) => (c.letter === letter ? { letter, min } : { ...c })).sort((a, b) => b.min - a.min)
  return { ...p, cutoffs }
}

/** A short random id for hand-added things ("manual:k3j9x0q1"). Not secret, just unique enough. */
export function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}


// ---------------------------------------------------------------- theme

export function getTheme(): Theme {
  const t = readKey('local', THEME_KEY)
  return t === 'light' || t === 'dark' ? t : 'system'
}

export function setTheme(theme: Theme): void {
  if (theme === 'system') removeKey('local', THEME_KEY)
  else writeKey('local', THEME_KEY, theme)
}

/** The CSS reads [data-theme] on <html>; no attribute means "follow the system setting". */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

// ---------------------------------------------------------------- delete everything

/** Removes every key this app ever wrote, in both storages. */
export function clearAll(): void {
  for (const kind of ['local', 'session'] as const) {
    const s = storageOf(kind)
    if (!s) continue
    try {
      const keys: string[] = []
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i)
        if (k && k.startsWith(`${APP_SLUG}:`)) keys.push(k)
      }
      keys.forEach((k) => s.removeItem(k))
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------- demo

/**
 * The store without the sample data: demo courses, their prefs and sync times go; settings and classes the
 * student added by hand during the demo (and those classes' prefs) stay, because those are real.
 */
function withoutDemo(store: Store): Store {
  const prefs: Record<string, CoursePrefs> = {}
  for (const m of store.manual) if (store.prefs[m.key]) prefs[m.key] = store.prefs[m.key]
  return { ...defaultStore(), settings: store.settings, manual: store.manual, prefs }
}

/** Load the made-up sample grades from "See a demo", keeping the student's settings. */
export function loadDemo(store: Store, payloads: SyncPayload[]): Store {
  let next: Store = { ...defaultStore(), settings: { ...store.settings, term: null } }
  for (const payload of payloads) next = applyPayload(next, payload)
  return { ...next, demo: true }
}

/** Remove the sample data again (classes added by hand are kept). */
export function clearDemo(store: Store): Store {
  return withoutDemo(store)
}
