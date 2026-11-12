// Everything the app remembers lives in the student's own browser. This is the only file that touches
// localStorage / sessionStorage. Every access is wrapped in try/catch because storage can be blocked (private
// windows, strict privacy settings): the app must still work then, it just forgets on reload.
//
// It also holds small pure helpers that return an updated copy of the store or of one course's prefs, so React
// state updates stay one-liners in the components and are easy to test.
import { APP_SLUG } from './brand'
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

/**
 * Loosely checks that `x` looks like a saved Store and returns a clean copy (or null if it clearly is not one).
 * Used when loading from localStorage and when importing a file. "Loosely" on purpose: the merge code already
 * tolerates odd values, we just make sure the top-level shape is right so nothing crashes on `.map` of undefined.
 */
export function parseStore(x: unknown): Store | null {
  if (!isObject(x) || x.v !== 1) return null
  if (!isObject(x.synced) || !Array.isArray(x.manual) || !isObject(x.prefs)) return null

  const synced: Record<string, SyncedCourse> = {}
  for (const [key, c] of Object.entries(x.synced)) {
    // A synced course must at least have lists we can loop over.
    if (isObject(c) && Array.isArray(c.items) && Array.isArray(c.categories)) synced[key] = c as unknown as SyncedCourse
  }

  const manual = x.manual.filter((m): m is ManualCourse => isObject(m) && typeof m.key === 'string')

  const prefs: Record<string, CoursePrefs> = {}
  for (const [key, p] of Object.entries(x.prefs)) if (isObject(p)) prefs[key] = p as CoursePrefs

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
 * Puts a sync result into the store: every course from that source is replaced by the new list (so courses you
 * dropped disappear), courses from the other source are kept. Prefs are keyed by merged course, so they survive.
 */
export function applyPayload(store: Store, payload: SyncPayload): Store {
  // A real sync replaces the sample data entirely (never mix demo courses with real ones).
  if (store.demo) store = { ...defaultStore(), settings: store.settings }
  const synced: Record<string, SyncedCourse> = {}
  for (const [key, course] of Object.entries(store.synced)) {
    if (course.source !== payload.kind) synced[key] = course
  }
  for (const course of payload.courses) {
    synced[`${payload.kind}:${course.sourceId}`] = { ...course, source: payload.kind }
  }
  return { ...store, synced, lastSync: { ...store.lastSync, [payload.kind]: payload.at } }
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

/** Applies `change` to one course's prefs and returns the new store. */
export function updatePrefs(store: Store, courseKey: string, change: (p: CoursePrefs) => CoursePrefs): Store {
  const next = cleanPrefs(change({ ...(store.prefs[courseKey] ?? {}) }))
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

/** Sets (or clears, with null) a what-if score in points for one item. */
export function withWhatIf(p: CoursePrefs, itemKey: string, score: number | null): CoursePrefs {
  return { ...p, whatIf: setKey(p.whatIf, itemKey, score) }
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

/** Load the made-up sample grades from "See a demo", keeping the student's settings. */
export function loadDemo(store: Store, payloads: SyncPayload[]): Store {
  let next: Store = { ...defaultStore(), settings: { ...store.settings, term: null } }
  for (const payload of payloads) next = applyPayload(next, payload)
  return { ...next, demo: true }
}

/** Remove the sample data again. */
export function clearDemo(store: Store): Store {
  return { ...defaultStore(), settings: store.settings }
}
