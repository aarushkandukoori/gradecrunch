// Tests for the ui module: the store (localStorage, payloads, prefs helpers, theme),
// display formatting, dashboard view logic, the Ask Claude summary, and a few full renders of <App />.
// All data is synthetic.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import {
  STORE_KEY,
  THEME_KEY,
  addManualCourse,
  applyPayload,
  applyTheme,
  cleanPrefs,
  clearAll,
  defaultStore,
  exportStoreJson,
  getTheme,
  loadStore,
  parseStore,
  removeManualCourse,
  saveStore,
  setTheme,
  updatePrefs,
  updateSettings,
  withCutoff,
  withIgnored,
  withMoved,
  withPlanned,
  withWeight,
  withWhatIf,
  withoutPlanned,
} from '../src/lib/store'
import {
  article,
  courseLabel,
  dropRuleText,
  formatDue,
  formatGradePercent,
  formatPercent,
  formatPoints,
  formatQpa,
  formatScore,
  letterTone,
  plural,
  scorePercent,
  statusLabel,
  timeAgo,
} from '../src/lib/format'
import {
  barPosition,
  collapseNeeded,
  collapseScheme,
  courseInsight,
  courseWarnings,
  groupItems,
  neededFor,
  neededText,
  pickTerm,
  shownPercent,
  sortNewestFirst,
  splitCourses,
} from '../src/ui/view'
import { buildClaudePrompt } from '../src/lib/askClaude'
import { encodePayload } from '../src/lib/payload'
import { BOOKMARKLET_VERSION } from '../src/lib/bookmarklet'
import type {
  Course,
  GradeResult,
  Item,
  NeededResult,
  QpaResult,
  Settings,
  Store,
  SyncedCourse,
  SyncPayload,
} from '../src/types'

// ---------------------------------------------------------------- synthetic fixtures

function syncedCanvas(id: string, overrides: Partial<SyncedCourse> = {}): SyncedCourse {
  return {
    source: 'canvas',
    sourceId: id,
    number: '21241',
    alsoNumbers: [],
    title: 'Matrices and Linear Transformations',
    term: 'Fall 2026',
    url: `https://canvas.cmu.edu/courses/${id}`,
    weighted: true,
    categories: [
      { id: '1', name: 'Homework', weight: 40, dropLowest: 0, dropHighest: 0, neverDrop: [] },
      { id: '2', name: 'Exams', weight: 60, dropLowest: 0, dropHighest: 0, neverDrop: [] },
    ],
    items: [
      { id: '11', name: 'HW1', categoryId: '1', score: 9, max: 10, status: 'graded', due: '2026-09-10T23:59:00-04:00', omit: false, url: `https://canvas.cmu.edu/courses/${id}/assignments/11` },
      { id: '12', name: 'HW2', categoryId: '1', score: null, max: 10, status: 'unsubmitted', due: '2026-09-17T23:59:00-04:00', omit: false, url: null },
      { id: '21', name: 'Midterm 1', categoryId: '2', score: 80, max: 100, status: 'graded', due: '2026-10-01T19:00:00-04:00', omit: false, url: null },
      { id: '22', name: 'Final', categoryId: '2', score: null, max: 100, status: 'unsubmitted', due: '2026-12-10T08:30:00-05:00', omit: false, url: null },
    ],
    canvasScore: 84,
    canvasGrade: 'B',
    scheme: null,
    syncedAt: '2026-11-12T10:00:00Z',
    ...overrides,
  }
}

function payload(kind: 'canvas' | 'gradescope', courses: SyncedCourse[], warnings: string[] = []): SyncPayload {
  return { v: 1, kind, at: '2026-11-12T12:00:00Z', courses, warnings }
}

function item(key: string, overrides: Partial<Item> = {}): Item {
  return {
    key,
    name: key,
    categoryKey: 'cat',
    score: null,
    max: 10,
    maxEstimated: false,
    status: 'unsubmitted',
    due: null,
    omit: false,
    url: null,
    source: 'canvas',
    otherScore: null,
    planned: false,
    ...overrides,
  }
}

function course(overrides: Partial<Course> = {}): Course {
  return {
    key: 'Fall 2026|21241',
    number: '21241',
    alsoNumbers: [],
    title: 'Matrices and Linear Transformations',
    term: 'Fall 2026',
    academic: true,
    sources: [{ source: 'canvas', sourceId: '1', url: 'https://canvas.cmu.edu/courses/1', syncedAt: '2026-11-12T10:00:00Z' }],
    weighted: true,
    categories: [
      { key: 'hw', name: 'Homework', weight: 40, dropLowest: 1, dropHighest: 0, neverDrop: [] },
      { key: 'ex', name: 'Exams', weight: 60, dropLowest: 0, dropHighest: 0, neverDrop: [] },
    ],
    items: [],
    canvasScore: null,
    canvasGrade: null,
    scheme: [
      { letter: 'A', min: 90 },
      { letter: 'B', min: 80 },
      { letter: 'C', min: 70 },
      { letter: 'D', min: 60 },
      { letter: 'R', min: 0 },
    ],
    schemeSource: 'default',
    units: 11,
    unitsSource: 'catalog',
    manualPercent: null,
    prefs: {},
    ...overrides,
  }
}

function grade(overrides: Partial<GradeResult> = {}): GradeResult {
  return { percent: 84, letter: 'B', categories: [], graded: 2, remaining: 2, ...overrides }
}

function need(letter: string, min: number, status: NeededResult['status'], needed: number | null = null): NeededResult {
  return { letter, min, status, needed }
}

// Node 25 ships its own experimental global localStorage, which shadows jsdom's and does not work without a
// --localstorage-file flag. Give the tests a small in-memory Storage so they behave like a browser.
class MemoryStorage implements Storage {
  private data = new Map<string, string>()
  get length() {
    return this.data.size
  }
  clear() {
    this.data.clear()
  }
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value))
  }
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true })
  Object.defineProperty(window, name, { value: storage, configurable: true, writable: true })
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------- store: load / save

describe('loadStore / saveStore', () => {
  test('starts fresh when nothing is saved', () => {
    expect(loadStore()).toEqual(defaultStore())
  })

  test('round trips through localStorage under the app key', () => {
    const s = updateSettings(applyPayload(defaultStore(), payload('canvas', [syncedCanvas('1')])), { college: 'scs' })
    saveStore(s)
    expect(localStorage.getItem(STORE_KEY)).not.toBeNull()
    expect(loadStore()).toEqual(s)
  })

  test('tolerates corrupt JSON and wrong shapes by starting fresh', () => {
    localStorage.setItem(STORE_KEY, '{not json')
    expect(loadStore()).toEqual(defaultStore())
    localStorage.setItem(STORE_KEY, JSON.stringify({ v: 2, synced: {} }))
    expect(loadStore()).toEqual(defaultStore())
    localStorage.setItem(STORE_KEY, JSON.stringify([1, 2, 3]))
    expect(loadStore()).toEqual(defaultStore())
  })

  test('keeps working when storage throws (blocked storage)', () => {
    for (const s of [localStorage, sessionStorage]) {
      vi.spyOn(s, 'getItem').mockImplementation(() => {
        throw new Error('blocked')
      })
      vi.spyOn(s, 'setItem').mockImplementation(() => {
        throw new Error('blocked')
      })
    }
    expect(loadStore()).toEqual(defaultStore())
    expect(() => saveStore(defaultStore())).not.toThrow()
    expect(getTheme()).toBe('system')
  })
})

describe('parseStore', () => {
  test('cleans bad settings and drops malformed entries', () => {
    const parsed = parseStore({
      v: 1,
      synced: { 'canvas:1': syncedCanvas('1'), 'canvas:bad': { items: 'nope' } },
      manual: [{ key: 'manual:a', number: null, title: 'X', term: null, percent: 90 }, 'junk'],
      prefs: { a: { units: 12 }, b: 'junk' },
      settings: { level: 'phd', college: 7, priorQpa: 'high', priorUnits: 40, term: 'Fall 2026', showAll: 'yes' },
      lastSync: { canvas: '2026-11-12T00:00:00Z', gradescope: 5 },
    })
    expect(parsed).not.toBeNull()
    expect(Object.keys(parsed!.synced)).toEqual(['canvas:1'])
    expect(parsed!.manual).toHaveLength(1)
    expect(parsed!.prefs).toEqual({ a: { units: 12 } })
    expect(parsed!.settings).toEqual({ level: 'undergrad', college: null, priorQpa: null, priorUnits: 40, term: 'Fall 2026', showAll: false })
    expect(parsed!.lastSync).toEqual({ canvas: '2026-11-12T00:00:00Z' })
  })

  test('rejects things that are not a store', () => {
    expect(parseStore(null)).toBeNull()
    expect(parseStore({ v: 1 })).toBeNull()
    expect(parseStore({ v: 1, synced: {}, manual: {}, prefs: {} })).toBeNull()
  })

  test('rebuilds prefs field by field so a malformed file cannot crash the app', () => {
    const parsed = parseStore({
      v: 1,
      synced: {},
      manual: [],
      prefs: {
        bad: {
          units: -3,
          letter: {},
          passFail: 'yes',
          hidden: true,
          weighted: 1,
          weights: { a: 30, b: 'x', c: Infinity },
          cutoffs: [{ letter: 'A', min: 90 }, { letter: '', min: 80 }, { letter: 'B' }, 'junk'],
          whatIf: { 'c:1': 8, 'c:2': '9' },
          whatIfGraded: ['c:1', 5],
          moved: { 'c:1': 'cat', 'c:2': 7 },
          ignored: 5,
          included: ['c:3', null],
          extra: [{ key: 'm:1', name: 'Quiz 9', categoryKey: 'q', max: 20 }, { key: 'm:2', name: 'No max', categoryKey: 'q' }, 'junk'],
          unknownField: 'dropped',
        },
        letterOk: { letter: ' A ' },
      },
    })
    expect(parsed!.prefs).toEqual({
      bad: {
        hidden: true,
        weights: { a: 30 },
        cutoffs: [{ letter: 'A', min: 90 }],
        whatIf: { 'c:1': 8 },
        whatIfGraded: ['c:1'],
        moved: { 'c:1': 'cat' },
        included: ['c:3'],
        extra: [{ key: 'm:1', name: 'Quiz 9', categoryKey: 'q', max: 20 }],
      },
      letterOk: { letter: 'A' },
    })
  })

  test('accepts an exported store', () => {
    const s = applyPayload(defaultStore(), payload('canvas', [syncedCanvas('1')]))
    const json = exportStoreJson(s)
    expect(parseStore(JSON.parse(json))).toEqual(s)
  })
})

// ---------------------------------------------------------------- store: payloads and manual courses

describe('applyPayload', () => {
  test('replaces only the courses of the synced source and records the sync time', () => {
    let s = defaultStore()
    s = applyPayload(s, payload('canvas', [syncedCanvas('1'), syncedCanvas('2', { number: '36225' })]))
    const gs: SyncedCourse = { ...syncedCanvas('900'), source: 'gradescope', url: 'https://www.gradescope.com/courses/900' }
    s = applyPayload(s, { ...payload('gradescope', [gs]), at: '2026-11-12T13:00:00Z' })
    expect(Object.keys(s.synced).sort()).toEqual(['canvas:1', 'canvas:2', 'gradescope:900'])

    // A new Canvas sync without course 2 removes it but keeps Gradescope.
    s = applyPayload(s, { ...payload('canvas', [syncedCanvas('1')]), at: '2026-11-12T14:00:00Z' })
    expect(Object.keys(s.synced).sort()).toEqual(['canvas:1', 'gradescope:900'])
    expect(s.lastSync).toEqual({ canvas: '2026-11-12T14:00:00Z', gradescope: '2026-11-12T13:00:00Z' })
  })

  test('forces the source to match the payload kind and keeps prefs', () => {
    let s = updatePrefs(defaultStore(), 'Fall 2026|21241', (p) => ({ ...p, units: 12 }))
    s = applyPayload(s, payload('gradescope', [syncedCanvas('5')]))
    expect(s.synced['gradescope:5'].source).toBe('gradescope')
    expect(s.prefs['Fall 2026|21241']).toEqual({ units: 12 })
  })

  test('does not mutate the old store', () => {
    const s = defaultStore()
    applyPayload(s, payload('canvas', [syncedCanvas('1')]))
    expect(s.synced).toEqual({})
  })

  test('a sync with zero courses changes no course data, only the sync time', () => {
    const s = applyPayload(defaultStore(), payload('canvas', [syncedCanvas('1')]))
    const next = applyPayload(s, { ...payload('canvas', []), at: '2026-11-13T00:00:00Z' })
    expect(next.synced).toEqual(s.synced)
    expect(next.lastSync.canvas).toBe('2026-11-13T00:00:00Z')
  })

  test('a course the sync could not read keeps its stored copy', () => {
    const s = applyPayload(defaultStore(), payload('canvas', [syncedCanvas('1'), syncedCanvas('2', { number: '36225' })]))
    // Course 1 came back empty (its assignments request failed); course 2 was left out entirely.
    const broken = syncedCanvas('1', { categories: [], items: [] })
    const next = applyPayload(s, { ...payload('canvas', [broken, syncedCanvas('3', { number: '15122' })]), failedIds: ['1', '2'] })
    expect(next.synced['canvas:1'].items).toHaveLength(4)
    expect(next.synced['canvas:2']).toEqual(s.synced['canvas:2'])
    expect(next.synced['canvas:3']).toBeDefined()
  })

  test('a failed course with no stored copy is still added', () => {
    const next = applyPayload(defaultStore(), { ...payload('canvas', [syncedCanvas('1', { items: [] })]), failedIds: ['1'] })
    expect(next.synced['canvas:1']).toBeDefined()
  })

  test("courses from terms the sync did not cover stay (last term's final grades)", () => {
    const fall = syncedCanvas('1', { term: 'Fall 2026' })
    const s = applyPayload(defaultStore(), payload('canvas', [fall, syncedCanvas('2', { number: '36225' })]))
    const next = applyPayload(s, payload('canvas', [syncedCanvas('9', { term: 'Spring 2027', number: '15122' })]))
    expect(Object.keys(next.synced).sort()).toEqual(['canvas:1', 'canvas:2', 'canvas:9'])
  })

  test('terms are compared by meaning, so "fall 2026" covers "Fall 2026"', () => {
    const s = applyPayload(defaultStore(), payload('canvas', [syncedCanvas('1'), syncedCanvas('2', { number: '36225' })]))
    const next = applyPayload(s, payload('canvas', [syncedCanvas('1', { term: 'fall 2026' })]))
    expect(Object.keys(next.synced)).toEqual(['canvas:1']) // course 2 was dropped this term
  })
})

describe('manual courses', () => {
  test('add and remove (removing also drops its prefs)', () => {
    const mc = { key: 'manual:abc', number: '15213', title: '', term: 'Fall 2026', percent: 88 }
    let s = addManualCourse(defaultStore(), mc)
    s = updatePrefs(s, mc.key, (p) => ({ ...p, units: 12 }))
    expect(s.manual).toEqual([mc])
    s = removeManualCourse(s, mc.key)
    expect(s.manual).toEqual([])
    expect(s.prefs[mc.key]).toBeUndefined()
  })
})

// ---------------------------------------------------------------- store: prefs helpers

describe('prefs helpers', () => {
  test('withWhatIf keeps whatIfGraded in sync', () => {
    let p = withWhatIf({}, 'c:1', 8, true)
    expect(p.whatIf).toEqual({ 'c:1': 8 })
    expect(p.whatIfGraded).toEqual(['c:1'])
    p = withWhatIf(p, 'c:1', 9, true) // typed again: listed once
    expect(p.whatIfGraded).toEqual(['c:1'])
    p = withWhatIf(p, 'c:2', 5) // on an ungraded item: not listed
    expect(p.whatIfGraded).toEqual(['c:1'])
    p = withWhatIf(p, 'c:1', null, true) // cleared: removed from both
    expect(cleanPrefs(p)).toEqual({ whatIf: { 'c:2': 5 } })
  })

  test('updatePrefs can start from the prefs the app shows (renamed item keys)', () => {
    let s = updatePrefs(defaultStore(), 'k', () => ({ whatIf: { 'g:9:1': 85 } }))
    // The app shows the what-if under the item's current key "c:1"; clearing it there must really clear it.
    s = updatePrefs(s, 'k', (p) => withWhatIf(p, 'c:1', null), { whatIf: { 'c:1': 85 } })
    expect(s.prefs.k).toBeUndefined()
  })

  test('updatePrefs removes empty values and deletes the course entry when nothing is left', () => {
    let s = updatePrefs(defaultStore(), 'k', (p) => withWhatIf(p, 'c:1', 8))
    expect(s.prefs.k).toEqual({ whatIf: { 'c:1': 8 } })
    s = updatePrefs(s, 'k', (p) => withWhatIf(p, 'c:1', null))
    expect(s.prefs.k).toBeUndefined()
  })

  test('cleanPrefs drops undefined, empty lists and empty maps but keeps false and 0', () => {
    expect(cleanPrefs({ units: 0, passFail: false, ignored: [], whatIf: {}, letter: undefined })).toEqual({ units: 0, passFail: false })
  })

  test('withWeight sets a weight and turns weights on; null clears it', () => {
    const p = withWeight({ weighted: false }, 'cat1', 30)
    expect(p).toEqual({ weighted: true, weights: { cat1: 30 } })
    expect(withWeight(p, 'cat1', null).weights).toEqual({})
  })

  test('withIgnored adds once and removes', () => {
    let p = withIgnored({}, 'c:1', true)
    p = withIgnored(p, 'c:1', true)
    expect(p.ignored).toEqual(['c:1'])
    expect(withIgnored(p, 'c:1', false).ignored).toEqual([])
  })

  test('withMoved sets and clears a category move', () => {
    const p = withMoved({}, 'c:1', 'cat2')
    expect(p.moved).toEqual({ 'c:1': 'cat2' })
    expect(withMoved(p, 'c:1', null).moved).toEqual({})
  })

  test('withPlanned / withoutPlanned also clean what-ifs, moves and ignores for that item', () => {
    let p = withPlanned({}, { key: 'm:1', name: 'Quiz 9', categoryKey: 'q', max: 20 })
    p = withWhatIf(p, 'm:1', 15)
    p = withMoved(p, 'm:1', 'other')
    p = withIgnored(p, 'm:1', true)
    expect(p.extra).toHaveLength(1)
    expect(cleanPrefs(withoutPlanned(p, 'm:1'))).toEqual({})
  })

  test('withCutoff starts from the current scheme and keeps it sorted', () => {
    const scheme = course().scheme
    const p = withCutoff({}, scheme, 'B', 78)
    expect(p.cutoffs?.map((c) => [c.letter, c.min])).toEqual([['A', 90], ['B', 78], ['C', 70], ['D', 60], ['R', 0]])
    // A second change builds on the first.
    const p2 = withCutoff(p, scheme, 'A', 93)
    expect(p2.cutoffs?.find((c) => c.letter === 'B')?.min).toBe(78)
    expect(p2.cutoffs?.[0]).toEqual({ letter: 'A', min: 93 })
    // The input scheme is never mutated.
    expect(scheme[1].min).toBe(80)
  })

  test('updateSettings merges a patch', () => {
    const s = updateSettings(defaultStore(), { level: 'grad', priorQpa: 3.5 })
    expect(s.settings.level).toBe('grad')
    expect(s.settings.priorQpa).toBe(3.5)
    expect(s.settings.showAll).toBe(false)
  })
})

// ---------------------------------------------------------------- theme, clearAll

describe('theme', () => {
  test('defaults to system, saves light/dark, and applies data-theme', () => {
    expect(getTheme()).toBe('system')
    setTheme('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(getTheme()).toBe('dark')
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    setTheme('system')
    applyTheme('system')
    expect(getTheme()).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  test('ignores junk theme values', () => {
    localStorage.setItem(THEME_KEY, 'purple')
    expect(getTheme()).toBe('system')
  })
})

describe('clearAll', () => {
  test('removes every app key from both storages and nothing else', () => {
    saveStore(defaultStore())
    sessionStorage.setItem(`${STORE_KEY}-extra`, 'x')
    setTheme('light')
    localStorage.setItem('someone-else', 'keep')
    clearAll()
    expect(localStorage.getItem(STORE_KEY)).toBeNull()
    expect(localStorage.getItem(THEME_KEY)).toBeNull()
    expect(sessionStorage.getItem(`${STORE_KEY}-extra`)).toBeNull()
    expect(localStorage.getItem('someone-else')).toBe('keep')
  })
})

// ---------------------------------------------------------------- formatting

describe('format', () => {
  test('numbers', () => {
    expect(formatPercent(85.123)).toBe('85.1%')
    expect(formatPercent(null)).toBe('')
    expect(formatPercent(90, 0)).toBe('90%')
    // Course grades: 2 decimals like Canvas, same rounding as the letter math.
    expect(formatGradePercent(89.96)).toBe('89.96%')
    expect(formatGradePercent(89.95)).toBe('89.95%')
    expect(formatGradePercent(84)).toBe('84%')
    expect(formatGradePercent(84.1)).toBe('84.1%')
    expect(formatGradePercent(89.995)).toBe('90%') // letterFor also gives the A here
    expect(formatGradePercent(89.994)).toBe('89.99%')
    expect(formatGradePercent(null)).toBe('')
    expect(formatQpa(3.5149)).toBe('3.51')
    expect(formatQpa(null)).toBe('')
    expect(formatPoints(36)).toBe('36')
    expect(formatPoints(24.25)).toBe('24.25')
    expect(formatPoints(1 / 3)).toBe('0.33')
    expect(formatPoints(null)).toBe('?')
    expect(formatScore(36, 40)).toBe('36 / 40')
    expect(formatScore(5, null)).toBe('5 / ?')
    expect(scorePercent(36, 40)).toBe('90%')
    expect(scorePercent(3, 0)).toBe('')
    expect(plural(1, 'course')).toBe('1 course')
    expect(plural(6, 'course')).toBe('6 courses')
  })

  test('timeAgo', () => {
    const now = Date.parse('2026-11-12T12:00:00Z')
    expect(timeAgo(undefined, now)).toBe('not synced')
    expect(timeAgo('2026-11-12T11:59:30Z', now)).toBe('just now')
    expect(timeAgo('2026-11-12T11:55:00Z', now)).toBe('5 min ago')
    expect(timeAgo('2026-11-12T10:00:00Z', now)).toBe('2 h ago')
    expect(timeAgo('2026-11-09T12:00:00Z', now)).toBe('3 d ago')
    expect(timeAgo('2026-11-12T12:05:00Z', now)).toBe('just now') // clock skew never shows negatives
  })

  test('formatDue adds the year only for other years', () => {
    const now = Date.parse('2026-11-12T12:00:00Z')
    expect(formatDue('2026-09-11T23:59:00-04:00', now)).toMatch(/^Sep 1[12]$/)
    expect(formatDue('2025-03-05T12:00:00-05:00', now)).toMatch(/2025/)
    expect(formatDue(null, now)).toBe('')
    expect(formatDue('nope', now)).toBe('')
  })

  test('letters, statuses, drop rules, labels', () => {
    expect(['A-', 'B+', 'C', 'D', 'R', 'F', 'P', 'W', null].map(letterTone)).toEqual(['a', 'b', 'c', 'd', 'r', 'r', 'n', 'n', 'n'])
    expect(article('A')).toBe('an')
    expect(article('B')).toBe('a')
    expect(article('R')).toBe('an')
    expect(statusLabel('unsubmitted', false)).toBe('Not submitted')
    expect(statusLabel('graded', true)).toBe('Planned')
    expect(statusLabel('excused', false)).toBe('Excused')
    expect(dropRuleText({ dropLowest: 1, dropHighest: 0 })).toBe('drops lowest 1')
    expect(dropRuleText({ dropLowest: 2, dropHighest: 1 })).toBe('drops lowest 2, highest 1')
    expect(dropRuleText({ dropLowest: 0, dropHighest: 0 })).toBe('')
    expect(courseLabel({ number: '21241', title: 'x' })).toBe('21-241')
    expect(courseLabel({ number: null, title: 'Career Launch' })).toBe('Career Launch')
  })
})

// ---------------------------------------------------------------- dashboard view logic

describe('view logic', () => {
  test('pickTerm prefers a saved term that still exists, else the newest', () => {
    expect(pickTerm(['Fall 2026', 'Spring 2026'], 'Spring 2026')).toBe('Spring 2026')
    expect(pickTerm(['Fall 2026', 'Spring 2026'], 'Fall 2020')).toBe('Fall 2026')
    expect(pickTerm([], null)).toBeNull()
  })

  test('splitCourses: main = academic, visible, this term; other = hidden, shells, no-term synced', () => {
    const manualNoTerm = course({ key: 'manual:1', term: null, sources: [{ source: 'manual', sourceId: '1', url: '', syncedAt: '' }] })
    const list = [
      course({ key: 'a' }),
      course({ key: 'hidden', prefs: { hidden: true } }),
      course({ key: 'shell', academic: false, number: null, term: null }),
      course({ key: 'old', term: 'Spring 2026' }),
      course({ key: 'noterm', term: null }),
      manualNoTerm,
    ]
    const { main, other } = splitCourses(list, 'Fall 2026')
    expect(main.map((c) => c.key)).toEqual(['a', 'manual:1'])
    expect(other.map((c) => c.key)).toEqual(['hidden', 'shell', 'noterm'])
  })

  test('shownPercent falls back from computed to Canvas to manual', () => {
    expect(shownPercent(course({ canvasScore: 70 }), grade({ percent: 84 }))).toBe(84)
    expect(shownPercent(course({ canvasScore: 70 }), grade({ percent: null }))).toBe(70)
    expect(shownPercent(course({ manualPercent: 91 }), undefined)).toBe(91)
    expect(shownPercent(course(), grade({ percent: null }))).toBeNull()
  })

  test('courseInsight picks the best letter still in reach', () => {
    expect(courseInsight([need('A', 90, 'possible', 82.5), need('B', 80, 'guaranteed', 0)], grade())).toBe('Need 82.5% on the rest for an A')
    expect(courseInsight([need('A', 90, 'impossible'), need('B', 80, 'possible', 71.04)], grade())).toBe('Need 71.0% on the rest for a B')
    expect(courseInsight([need('A', 90, 'guaranteed', 0), need('B', 80, 'guaranteed', 0)], grade())).toBe('A is locked in')
    expect(courseInsight([need('A', 90, 'locked'), need('B', 80, 'locked')], grade({ remaining: 0 }))).toBe('Every grade is in')
    expect(courseInsight([need('A', 90, 'impossible'), need('D', 60, 'impossible')], grade())).toBe('Even 100% on the rest stays below D')
    expect(courseInsight([], grade())).toBeNull()
  })

  test('neededText', () => {
    expect(neededText(need('A', 90, 'possible', 82.46), 85)).toBe('Need 82.5% avg on remaining work')
    expect(neededText(need('A', 90, 'guaranteed', 0), 95)).toBe('Guaranteed')
    expect(neededText(need('A', 90, 'impossible'), 70)).toBe('Out of reach')
    expect(neededText(need('A', 90, 'locked'), 92)).toBe('Locked in')
    expect(neededText(need('A', 90, 'locked'), 89.999)).toBe('Locked in') // same 2-decimal rounding as letters
    expect(neededText(need('A', 90, 'locked'), 85)).toBe('Out of reach')
  })

  test('courseWarnings', () => {
    const items = [item('c:1')]
    expect(courseWarnings(course({ canvasScore: 85.1, items }), grade({ percent: 84 }))).toEqual(['Canvas shows 85.1%'])
    expect(courseWarnings(course({ canvasScore: 84.3, items }), grade({ percent: 84 }))).toEqual([])
    expect(courseWarnings(course({ weighted: false, items }), grade())).toEqual(['Using total points. Add syllabus weights for a better estimate.'])
    const lowWeights = course({
      items,
      categories: [
        { key: 'a', name: 'A', weight: 50, dropLowest: 0, dropHighest: 0, neverDrop: [] },
        { key: 'b', name: 'B', weight: 30, dropLowest: 0, dropHighest: 0, neverDrop: [] },
      ],
    })
    expect(courseWarnings(lowWeights, grade())).toEqual(['Weights add up to 80%'])
  })

  test('collapseScheme / collapseNeeded keep the lowest cut per letter for undergrads only', () => {
    const scheme = [
      { letter: 'A', min: 93 },
      { letter: 'A-', min: 90 },
      { letter: 'B+', min: 87 },
      { letter: 'B', min: 83 },
      { letter: 'B-', min: 80 },
      { letter: 'C', min: 70 },
      { letter: 'F', min: 0 },
    ]
    expect(collapseScheme(scheme, 'undergrad')).toEqual([
      { letter: 'A', min: 90 },
      { letter: 'B', min: 80 },
      { letter: 'C', min: 70 },
      { letter: 'R', min: 0 },
    ])
    expect(collapseScheme(scheme, 'grad')).toBe(scheme)
    const needed = [need('A', 93, 'impossible'), need('A-', 90, 'possible', 97), need('B+', 87, 'possible', 80), need('B', 83, 'guaranteed', 0)]
    expect(collapseNeeded(needed, 'undergrad')).toEqual([
      { letter: 'A', min: 90, status: 'possible', needed: 97 },
      { letter: 'B', min: 83, status: 'guaranteed', needed: 0 },
    ])
    expect(collapseNeeded(needed, 'grad')).toBe(needed)
  })

  test('neededFor skips courses without assignments', () => {
    const compute = vi.fn(() => [need('A', 90, 'impossible')])
    expect(neededFor(course({ items: [] }), compute, 'undergrad')).toEqual([])
    expect(compute).not.toHaveBeenCalled()
    expect(neededFor(course({ items: [item('x')] }), compute, 'undergrad')).toHaveLength(1)
  })

  test('barPosition maps 50-100% onto 0-100 and clamps', () => {
    expect(barPosition(50)).toBe(0)
    expect(barPosition(75)).toBe(50)
    expect(barPosition(100)).toBe(100)
    expect(barPosition(30)).toBe(0)
    expect(barPosition(104)).toBe(100)
  })

  test('sortNewestFirst: newest due first, undated last, then by name', () => {
    const sorted = sortNewestFirst([
      item('HW10', { due: null }),
      item('HW1', { due: '2026-09-01T00:00:00Z' }),
      item('HW2', { due: '2026-09-08T00:00:00Z' }),
      item('HW9', { due: null }),
    ])
    expect(sorted.map((i) => i.key)).toEqual(['HW2', 'HW1', 'HW9', 'HW10'])
  })

  test('groupItems follows category order and puts unknown categories in Other', () => {
    const c = course({
      items: [item('x', { categoryKey: 'ex' }), item('y', { categoryKey: 'hw' }), item('z', { categoryKey: 'gone' })],
    })
    const groups = groupItems(c)
    expect(groups.map((g) => [g.name, g.items.map((i) => i.key)])).toEqual([
      ['Homework', ['y']],
      ['Exams', ['x']],
      ['Other', ['z']],
    ])
  })
})

// ---------------------------------------------------------------- Ask Claude summary

describe('buildClaudePrompt', () => {
  const settings: Settings = { level: 'undergrad', college: null, priorQpa: 3.4, priorUnits: 90, term: null, showAll: false }

  test('includes numbers, units, percents, categories, needs and QPA but no ids or URLs', () => {
    const c = course({ items: [item('c:12345', { url: 'https://canvas.cmu.edu/courses/1/assignments/12345' })] })
    const g = grade({
      categories: [
        { key: 'hw', name: 'Homework', weight: 40, earned: 18, possible: 20, percent: 90, dropped: [], counted: true },
        { key: 'ex', name: 'Exams', weight: 60, earned: 80, possible: 100, percent: 80, dropped: [], counted: true },
      ],
    })
    const qpa: QpaResult = {
      rows: [],
      semesterQpa: 3.25,
      factorableUnits: 44,
      totalUnits: 44,
      qualityPoints: 143,
      cumulativeQpa: 3.35,
      deansList: null,
    }
    const text = buildClaudePrompt(
      [c],
      new Map([[c.key, g]]),
      new Map([[c.key, [need('A', 90, 'possible', 95.2), need('B', 80, 'guaranteed', 0)]]]),
      qpa,
      settings,
    )
    expect(text).toContain('21-241 Matrices and Linear Transformations (11 units)')
    expect(text).toContain('Current: 84% (B)') // 2 decimals like Canvas, no trailing zeros
    expect(text).toContain('Homework: weight 40%, 90.0% (18 / 20 pts), drops lowest 1')
    expect(text).toContain('A: need 95.2% average; B: guaranteed')
    expect(text).toContain('Estimated semester QPA: 3.25 from 44 factorable units')
    expect(text).toContain('Estimated cumulative QPA after this semester: 3.35')
    expect(text).toContain('Semester: Fall 2026')
    expect(text).not.toMatch(/https?:/)
    expect(text).not.toContain('12345')
    expect(text).not.toContain('Fall 2026|21241')
  })
})

// ---------------------------------------------------------------- full app renders (real modules, jsdom)

describe('<App />', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    window.scrollTo = () => {} // jsdom has no scrolling; opening a class page scrolls to the top
    window.history.replaceState(null, '', '/')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
  })

  async function renderApp() {
    const { default: App } = await import('../src/App')
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(App))
    })
  }

  test('empty store shows the welcome page: one card with the Sync button and two steps', async () => {
    await renderApp()
    expect(container.textContent).toContain('All your CMU grades in one place.')
    expect(container.querySelectorAll('.connect-steps li')).toHaveLength(2)
    expect(container.textContent).toContain('Drag it to your bookmarks bar')
    expect(container.textContent).toContain('See a demo')
    expect(container.textContent).toContain('Trouble?')
    // The bookmarklet href is set after mount, as a javascript: URL pointing back at this origin.
    const link = container.querySelector('a.bookmarklet')
    expect(link?.getAttribute('href')?.startsWith('javascript:')).toBe(true)
    expect(decodeURIComponent(link!.getAttribute('href')!)).toContain(window.location.origin)
  })

  test('a synced store shows the QPA and one row per class; a row opens the class page', async () => {
    const s = applyPayload(defaultStore(), payload('canvas', [syncedCanvas('1')]))
    saveStore(s)
    await renderApp()
    const text = container.textContent ?? ''
    expect(text).toContain('Estimated QPA')
    expect(text).toContain('21-241')
    expect(text).toContain('84%')
    expect(text).not.toContain('84.0%')
    expect(text).not.toContain('Midterm 1') // assignments live on the class page

    const row = container.querySelector<HTMLButtonElement>('button.class-row')!
    expect(row.textContent).toContain('21-241')
    await act(async () => row.click())
    expect(window.location.pathname).toBe('/class/' + encodeURIComponent('Fall 2026|21241'))
    expect(container.textContent).toContain('What you need')
    expect(container.textContent).toContain('Midterm 1')
  })

  test('a #sync= fragment is imported, removed from the URL, and saved', async () => {
    // A fresh link (made just now), so no "this link is old" question.
    const fresh = { ...payload('canvas', [syncedCanvas('7')], ['Course 99 failed']), at: new Date().toISOString() }
    const encoded = await encodePayload(fresh)
    window.history.replaceState(null, '', `/#sync=${encoded}&bv=${BOOKMARKLET_VERSION}`)
    await renderApp()
    // replaceState happens synchronously on mount, before decoding.
    expect(window.location.hash).toBe('')
    // Let the async decode finish.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(container.textContent).toContain('Synced 1 course from Canvas')
    expect(container.textContent).toContain('1 warning')
    const saved = JSON.parse(localStorage.getItem(STORE_KEY)!) as Store
    expect(Object.keys(saved.synced)).toEqual(['canvas:7'])
  })

  test('the /privacy path shows the privacy page with the storage keys', async () => {
    window.history.replaceState(null, '', '/privacy')
    await renderApp()
    expect(container.textContent).toContain('What is stored')
    expect(container.textContent).toContain(STORE_KEY)
  })
})

// ---------------------------------------------------------------- demo

describe('demo', () => {
  test('loads sample courses, flags the store, and a real sync replaces them', async () => {
    const { demoPayloads } = await import('../src/lib/demo')
    const { loadDemo, clearDemo } = await import('../src/lib/store')
    const s = loadDemo(defaultStore(), demoPayloads())
    expect(s.demo).toBe(true)
    expect(Object.keys(s.synced).length).toBe(5)
    const real = applyPayload(s, payload('canvas', [syncedCanvas('1')]))
    expect(real.demo).toBeUndefined()
    expect(Object.keys(real.synced)).toEqual(['canvas:1'])
    expect(clearDemo(s).synced).toEqual({})
    expect(parseStore(JSON.parse(exportStoreJson(s)))?.demo).toBe(true)
  })

  test('classes added by hand during the demo survive a real sync and ending the demo', async () => {
    const { demoPayloads } = await import('../src/lib/demo')
    const { loadDemo, clearDemo } = await import('../src/lib/store')
    const mc = { key: 'manual:abc', number: '15213', title: '', term: 'Fall 2026', percent: 88 }
    let s = addManualCourse(loadDemo(defaultStore(), demoPayloads()), mc)
    s = updatePrefs(s, mc.key, (p) => ({ ...p, units: 12 }))
    s = updatePrefs(s, 'Fall 2026|99999', (p) => ({ ...p, units: 3 })) // prefs of a demo course
    for (const after of [applyPayload(s, payload('canvas', [syncedCanvas('1')])), clearDemo(s)]) {
      expect(after.manual).toEqual([mc])
      expect(after.prefs).toEqual({ [mc.key]: { units: 12 } })
    }
  })
})
