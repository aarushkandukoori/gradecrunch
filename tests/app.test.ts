// Tests for the app shell and UI fixes: syncing between tabs, Undo after a sync, old #sync links, the
// postMessage receiver, what-if labels, the item row (what-if box, pencil focus, More menu), the course detail
// (weights reset, cutoffs, final letter, remove), the class page routing (/class/<key>), toasts, the Sync
// popover, QPA extras in Settings, the P/F button on the class list, and the AI advisor wiring (header button, class
// page link, Settings, delete).
// All data is synthetic.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { applyPayload, defaultStore, loadDemo, saveStore, STORE_KEY } from '../src/lib/store'
import { demoPayloads } from '../src/lib/demo'
import { encodePayload } from '../src/lib/payload'
import { CHAT_KEY, CONSENT_KEY, MEMORY_KEY, saveChat, saveNotes } from '../src/lib/chat/memory'
import { activeWhatIfs, whatIfApplies, withoutWhatIfs } from '../src/lib/whatIfs'
import { MAX_PAYLOAD_CHARS, READY_TRIES, startReceiver, syncLinkIsStale, type ReceiverDeps } from '../src/ui/receive'
import { ItemRow } from '../src/ui/ItemRow'
import { CourseDetail } from '../src/ui/CourseDetail'
import { Toasts, type Toast } from '../src/ui/Toasts'
import { Header } from '../src/ui/Header'
import { QpaExtras } from '../src/ui/QpaExtras'
import { rowHint, shownLetter } from '../src/ui/view'
import type {
  Category,
  Course,
  CoursePrefs,
  GradeResult,
  Item,
  NeededResult,
  QpaResult,
  Settings,
  Store,
  SyncedCourse,
  SyncPayload,
} from '../src/types'

// ---------------------------------------------------------------- browser setup

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

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.scrollTo = () => {} // jsdom has no scrolling; opening a class page scrolls to the top
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function render(element: ReturnType<typeof createElement>) {
  root = createRoot(container)
  await act(async () => root!.render(element))
}

async function renderApp() {
  const { default: App } = await import('../src/App')
  await render(createElement(App))
}

/** Lets promises (payload decoding) and the resulting renders finish. */
async function settle(ms = 50) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

function text(): string {
  return container.textContent ?? ''
}

function buttonByText(label: string): HTMLButtonElement {
  const b = [...container.querySelectorAll('button')].find((el) => el.textContent?.trim() === label)
  if (!b) throw new Error(`no button "${label}"`)
  return b
}

function key(el: Element, k: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
}

/** Types into a React-controlled input (React listens for the native input event). */
function typeInto(input: HTMLInputElement, value: string) {
  input.focus() // so the blur that saves it really fires
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

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
      { id: '11', name: 'HW1', categoryId: '1', score: 9, max: 10, status: 'graded', due: null, omit: false, url: null },
      { id: '12', name: 'HW2', categoryId: '1', score: null, max: 10, status: 'unsubmitted', due: null, omit: false, url: null },
      { id: '21', name: 'Midterm 1', categoryId: '2', score: 80, max: 100, status: 'graded', due: null, omit: false, url: null },
      { id: '22', name: 'Final', categoryId: '2', score: null, max: 100, status: 'unsubmitted', due: null, omit: false, url: null },
    ],
    canvasScore: 84,
    canvasGrade: 'B',
    scheme: null,
    syncedAt: '2026-11-12T10:00:00Z',
    ...overrides,
  }
}

function payload(courses: SyncedCourse[], overrides: Partial<SyncPayload> = {}): SyncPayload {
  return { v: 1, kind: 'canvas', at: new Date().toISOString(), courses, warnings: [], ...overrides }
}

function item(k: string, overrides: Partial<Item> = {}): Item {
  return {
    key: k,
    name: k,
    categoryKey: 'hw',
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

const CATEGORIES: Category[] = [
  { key: 'hw', name: 'Homework', weight: 40, dropLowest: 0, dropHighest: 0, neverDrop: [] },
  { key: 'ex', name: 'Exams', weight: 60, dropLowest: 0, dropHighest: 0, neverDrop: [] },
]

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
    categories: CATEGORIES,
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

const GRADE: GradeResult = { percent: 84, letter: 'B', categories: [], graded: 2, remaining: 2 }

function savedStore(): Store {
  return JSON.parse(localStorage.getItem(STORE_KEY)!) as Store
}

// ---------------------------------------------------------------- two tabs

describe('another tab saving', () => {
  test('a storage event loads the other tab\'s copy, and this tab never writes its old copy back', async () => {
    saveStore(applyPayload(defaultStore(), payload([syncedCanvas('1')])))
    await renderApp()
    expect(text()).toContain('21-241')

    // Another tab syncs Gradescope and adds a hidden course.
    const other = applyPayload(
      applyPayload(defaultStore(), payload([syncedCanvas('1')])),
      payload([syncedCanvas('9', { source: 'gradescope', number: '15122', title: 'Imperative Computation' })], { kind: 'gradescope' }),
    )
    other.prefs['Fall 2026|15122'] = { hidden: true }
    localStorage.setItem(STORE_KEY, JSON.stringify(other))
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: STORE_KEY })))
    expect(text()).toContain('Show 1 hidden class')

    // Any change in this tab now saves the merged data, not the old snapshot.
    await act(async () => buttonByText('Show 1 hidden class').click())
    const saved = savedStore()
    expect(Object.keys(saved.synced).sort()).toEqual(['canvas:1', 'gradescope:9'])
    expect(saved.settings.showAll).toBe(true)
    expect(saved.lastSync.gradescope).toBeDefined()
  })

  test('coming back to the tab (focus) also picks up a newer copy', async () => {
    saveStore(applyPayload(defaultStore(), payload([syncedCanvas('1')])))
    await renderApp()
    const other = applyPayload(defaultStore(), payload([syncedCanvas('2', { number: '15151', title: 'Discrete Math' })]))
    localStorage.setItem(STORE_KEY, JSON.stringify(other))
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(text()).toContain('15-151')
    expect(text()).not.toContain('21-241')
  })

  test('"Delete everything" in another tab empties this one too', async () => {
    saveStore(applyPayload(defaultStore(), payload([syncedCanvas('1')])))
    await renderApp()
    localStorage.removeItem(STORE_KEY)
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: STORE_KEY })))
    expect(text()).toContain('All your CMU grades in one place.')
  })
})

// ---------------------------------------------------------------- imports: Undo and old links

describe('sync links', () => {
  test('every sync can be undone from its toast', async () => {
    saveStore(applyPayload(defaultStore(), payload([syncedCanvas('1')])))
    const encoded = await encodePayload(payload([syncedCanvas('7', { number: '15151', title: 'Discrete Math' })]))
    window.history.replaceState(null, '', `/#sync=${encoded}&bv=1`)
    await renderApp()
    await settle()
    expect(text()).toContain('Synced 1 course from Canvas')
    expect(Object.keys(savedStore().synced)).toEqual(['canvas:7'])

    await act(async () => buttonByText('Undo').click())
    expect(Object.keys(savedStore().synced)).toEqual(['canvas:1'])
    expect(text()).toContain('21-241')
    expect(text()).toContain('Undone')
  })

  test('an old link asks first; saying no changes nothing', async () => {
    saveStore(applyPayload(defaultStore(), payload([syncedCanvas('1')])))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const encoded = await encodePayload(payload([], { at: '2026-01-05T12:00:00Z' }))
    window.history.replaceState(null, '', `/#sync=${encoded}&bv=1`)
    await renderApp()
    await settle()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toMatch(/^This sync link is from .*2026.*\. Replace your Canvas grades with it\?$/)
    expect(Object.keys(savedStore().synced)).toEqual(['canvas:1'])
    expect(savedStore().lastSync.canvas).not.toBe('2026-01-05T12:00:00Z')
    expect(text()).toContain('Ignored the old sync link')
  })

  test('an old link is applied after saying yes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const encoded = await encodePayload(payload([syncedCanvas('3')], { at: 'not a date' }))
    window.history.replaceState(null, '', `/#sync=${encoded}&bv=1`)
    await renderApp()
    await settle()
    expect(window.confirm).toHaveBeenCalledWith('This sync link is from an unknown time. Replace your Canvas grades with it?')
    expect(Object.keys(savedStore().synced)).toEqual(['canvas:3'])
  })

  test('syncLinkIsStale: within 15 minutes either way is fresh', () => {
    const now = Date.parse('2026-11-12T12:00:00Z')
    expect(syncLinkIsStale('2026-11-12T11:50:00Z', now)).toBe(false)
    expect(syncLinkIsStale('2026-11-12T11:44:00Z', now)).toBe(true)
    expect(syncLinkIsStale('2026-11-12T12:20:00Z', now)).toBe(true) // from the future: also ask
    expect(syncLinkIsStale('garbage', now)).toBe(true)
  })
})

// ---------------------------------------------------------------- postMessage receiver

describe('startReceiver', () => {
  function fake() {
    const posted: { message: unknown; origin: string }[] = []
    const opener = { postMessage: (message: unknown, origin: string) => void posted.push({ message, origin }) }
    let handler: ((e: { source: unknown; origin: string; data: unknown }) => void) | null = null
    let tick: (() => void) | null = null
    const deps: ReceiverDeps = {
      opener,
      listen: (h) => {
        handler = h
        return () => {
          handler = null
        }
      },
      every: (_ms, fn) => {
        tick = fn
        return () => {
          tick = null
        }
      },
    }
    return {
      deps,
      opener,
      posted,
      send: (data: unknown, origin = 'https://canvas.cmu.edu', source: unknown = opener) => handler?.({ source, origin, data }),
      tick: () => tick?.(),
      get listening() {
        return handler !== null
      },
      get ticking() {
        return tick !== null
      },
    }
  }

  test('no opener: nothing to do', () => {
    const f = fake()
    expect(startReceiver({ ...f.deps, opener: null }, () => {})).toBeNull()
  })

  test('says ready to any origin, at most 60 times', () => {
    const f = fake()
    startReceiver(f.deps, () => {})
    expect(f.posted).toEqual([{ message: { type: 'gradecrunch:ready' }, origin: '*' }])
    for (let i = 0; i < 100; i++) f.tick()
    expect(f.posted).toHaveLength(READY_TRIES)
    expect(f.ticking).toBe(false)
  })

  test('accepts grades only from the opener on a grade site, then replies done to that origin', async () => {
    const f = fake()
    const onSync = vi.fn()
    startReceiver(f.deps, onSync)
    const encoded = await encodePayload(payload([syncedCanvas('1')]))
    const msg = { type: 'gradecrunch:sync', payload: encoded, bv: 1 }

    f.send(msg, 'https://evil.example') // wrong origin
    f.send(msg, 'http://canvas.cmu.edu') // not https
    f.send(msg, 'https://canvas.cmu.edu', {}) // another window
    f.send({ ...msg, type: 'other' }) // not a sync message
    f.send({ ...msg, payload: 'x'.repeat(MAX_PAYLOAD_CHARS) }) // too big
    f.send({ ...msg, payload: 42 })
    await settle(20)
    expect(onSync).not.toHaveBeenCalled()
    expect(f.listening).toBe(true)

    f.send(msg)
    await settle(20)
    expect(onSync).toHaveBeenCalledTimes(1)
    expect(onSync.mock.calls[0][0].courses[0].sourceId).toBe('1')
    expect(onSync.mock.calls[0][1]).toBe(1)
    expect(f.posted.at(-1)).toEqual({ message: { type: 'gradecrunch:done', ok: true }, origin: 'https://canvas.cmu.edu' })
    expect(f.listening).toBe(false)
    expect(f.ticking).toBe(false)
  })

  test('grades too big to accept get an error answer instead of silence', async () => {
    const f = fake()
    const onSync = vi.fn()
    startReceiver(f.deps, onSync)
    f.send({ type: 'gradecrunch:sync', payload: 'x'.repeat(MAX_PAYLOAD_CHARS), bv: 2 })
    await settle(20)
    expect(onSync).not.toHaveBeenCalled()
    expect(f.posted.at(-1)).toEqual({
      message: { type: 'gradecrunch:done', ok: false, message: expect.stringContaining('too big') },
      origin: 'https://canvas.cmu.edu',
    })
  })

  test('a site can only send its own kind of grades', async () => {
    const f = fake()
    const onSync = vi.fn()
    startReceiver(f.deps, onSync)
    const encoded = await encodePayload(payload([syncedCanvas('1')])) // Canvas grades...
    f.send({ type: 'gradecrunch:sync', payload: encoded, bv: 1 }, 'https://www.gradescope.com') // ...from Gradescope
    await settle(20)
    expect(onSync).not.toHaveBeenCalled()
    const done = f.posted.at(-1)!
    expect(done.origin).toBe('https://www.gradescope.com')
    expect(done.message).toMatchObject({ type: 'gradecrunch:done', ok: false })
  })

  test('broken grades are reported back, and a missing version is null', async () => {
    const f = fake()
    const onSync = vi.fn()
    startReceiver(f.deps, onSync)
    f.send({ type: 'gradecrunch:sync', payload: 'zzz-not-a-payload' })
    await settle(20)
    expect(f.posted.at(-1)!.message).toMatchObject({ ok: false, message: expect.stringContaining('broken') })

    const g = fake()
    startReceiver(g.deps, onSync)
    g.send({ type: 'gradecrunch:sync', payload: await encodePayload(payload([syncedCanvas('1')])) })
    await settle(20)
    expect(onSync.mock.calls[0][1]).toBeNull()
  })
})

describe('#receive in the app', () => {
  let frame: HTMLIFrameElement

  beforeEach(() => {
    // A real window object to play the bookmarklet's tab (window.opener).
    frame = document.createElement('iframe')
    document.body.appendChild(frame)
    Object.defineProperty(window, 'opener', { value: frame.contentWindow, configurable: true, writable: true })
  })

  afterEach(() => {
    Object.defineProperty(window, 'opener', { value: null, configurable: true, writable: true })
    frame.remove()
  })

  test('clears the hash, says ready, imports the grades with Undo, and replies done', async () => {
    const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
    window.history.replaceState(null, '', '/#receive')
    await renderApp()
    expect(window.location.hash).toBe('')
    expect(post).toHaveBeenCalledWith({ type: 'gradecrunch:ready' }, '*')

    const encoded = await encodePayload(payload([syncedCanvas('5')], { at: '2026-01-01T00:00:00Z' }))
    const confirm = vi.spyOn(window, 'confirm')
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'gradecrunch:sync', payload: encoded, bv: 1 },
          origin: 'https://canvas.cmu.edu',
          source: frame.contentWindow,
        }),
      )
    })
    await settle()
    expect(confirm).not.toHaveBeenCalled() // the handoff is live, so an old `at` doesn't matter
    expect(text()).toContain('Synced 1 course from Canvas')
    expect(buttonByText('Undo')).toBeTruthy()
    expect(Object.keys(savedStore().synced)).toEqual(['canvas:5'])
    expect(post).toHaveBeenCalledWith({ type: 'gradecrunch:done', ok: true }, 'https://canvas.cmu.edu')
  })
})

// ---------------------------------------------------------------- what-if labels

describe('what-ifs are labeled', () => {
  test('whatIfApplies follows the grade math', () => {
    const prefs: CoursePrefs = { whatIf: { a: 5, b: 5, c: 5, d: 5, e: 5 }, whatIfGraded: ['c'], ignored: ['e'] }
    expect(whatIfApplies(item('a'), prefs)).toBe(true) // still to come
    expect(whatIfApplies(item('b', { score: 7, status: 'graded' }), prefs)).toBe(false) // real score came out
    expect(whatIfApplies(item('c', { score: 7, status: 'graded' }), prefs)).toBe(true) // typed over the real score
    expect(whatIfApplies(item('d', { max: null }), prefs)).toBe(false) // points unknown
    expect(whatIfApplies(item('e'), prefs)).toBe(false) // ignored
    expect(whatIfApplies(item('z'), prefs)).toBe(false) // no what-if
    expect(withoutWhatIfs(prefs)).toEqual({ ignored: ['e'], whatIf: undefined, whatIfGraded: undefined })
  })

  test('QPA line, what-if note on the class page, and Clear what-ifs', async () => {
    const s = applyPayload(defaultStore(), payload([syncedCanvas('1')]))
    s.prefs['Fall 2026|21241'] = { whatIf: { 'c:12': 10 } }
    saveStore(s)
    await renderApp()
    expect(text()).toContain('includes what-if scores')

    await act(async () => container.querySelector<HTMLButtonElement>('button.class-row')!.click())
    // The switch starts on because this class already has a what-if.
    expect(container.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(true)
    expect(text()).toContain('Includes 1 what-if score, not your real grade.')

    await act(async () => buttonByText('Clear what-ifs').click())
    expect(text()).not.toContain('Includes 1 what-if score')
    expect(savedStore().prefs['Fall 2026|21241']).toBeUndefined()
  })

  test('turning the what-if switch off clears the what-ifs', async () => {
    const s = applyPayload(defaultStore(), payload([syncedCanvas('1')]))
    s.prefs['Fall 2026|21241'] = { whatIf: { 'c:12': 10 } }
    saveStore(s)
    window.history.replaceState(null, '', '/class/' + encodeURIComponent('Fall 2026|21241'))
    await renderApp()
    await act(async () => container.querySelector<HTMLInputElement>('input[role="switch"]')!.click())
    expect(savedStore().prefs['Fall 2026|21241']).toBeUndefined()
    expect(container.querySelector('.whatif input')).toBeNull()
  })

  test('a what-if left on an item that now has a real score is not counted', async () => {
    const s = applyPayload(defaultStore(), payload([syncedCanvas('1')]))
    s.prefs['Fall 2026|21241'] = { whatIf: { 'c:11': 2 } } // HW1 is graded 9/10
    saveStore(s)
    await renderApp()
    expect(text()).not.toContain('includes what-if scores')
  })

  test('only what-ifs that change the grade count as active', () => {
    // HW1 has a real score and the what-if wasn't typed over it, so only HW2's what-if is in the grade.
    const c = course({
      items: [item('hw2', { name: 'HW2' }), item('hw1', { name: 'HW1', score: 9, status: 'graded' })],
      prefs: { whatIf: { hw2: 10, hw1: 5 } },
    })
    expect(activeWhatIfs(c).map((i) => i.key)).toEqual(['hw2'])
  })
})

// ---------------------------------------------------------------- item row

describe('<ItemRow />', () => {
  function row(
    it: Item,
    extra: { whatIf?: number; whatIfMode?: boolean; onPrefs?: (change: (p: CoursePrefs) => CoursePrefs) => void } = {},
  ) {
    return createElement(
      'ul',
      null,
      createElement(ItemRow, {
        item: it,
        categories: CATEGORIES,
        whatIf: extra.whatIf,
        ignored: false,
        included: false,
        dropped: false,
        whatIfMode: extra.whatIfMode ?? true,
        onPrefs: extra.onPrefs ?? (() => {}),
      }),
    )
  }

  test('no what-if box while the points are unknown', async () => {
    await render(row(item('gs', { max: null })))
    expect(text()).toContain('Points unknown')
    expect(container.querySelector('input')).toBeNull()
  })

  test('remaining work with known points gets a what-if box', async () => {
    await render(row(item('hw')))
    expect(container.querySelector('input')).not.toBeNull()
  })

  test('with "Try what-if scores" off: no what-if box and no pencil, but the menu stays', async () => {
    await render(row(item('hw')))
    act(() => root!.unmount())
    await render(row(item('hw', { score: 9, status: 'graded' }), { whatIfMode: false }))
    expect(container.querySelector('input')).toBeNull()
    expect(container.querySelector('button[aria-label^="Try a what-if"]')).toBeNull()
    expect(container.querySelector('button[aria-haspopup="menu"]')).not.toBeNull()
    expect(text()).not.toContain('Graded') // a graded score speaks for itself
  })

  test('pencil focuses the new box; Escape closes it and puts focus back on the pencil', async () => {
    await render(row(item('hw1', { score: 9, status: 'graded' })))
    const pencil = container.querySelector<HTMLButtonElement>('button[aria-label^="Try a what-if"]')!
    await act(async () => pencil.click())
    const input = container.querySelector('input')!
    expect(document.activeElement).toBe(input)

    await act(async () => key(input, 'Escape'))
    expect(container.querySelector('input')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Try a what-if/)
  })

  test('leaving the box empty closes it, so the pencil comes back', async () => {
    await render(row(item('hw1', { score: 9, status: 'graded' })))
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="Try a what-if"]')!.click())
    await act(async () => container.querySelector('input')!.blur())
    expect(container.querySelector('input')).toBeNull()
    expect(container.querySelector('button[aria-label^="Try a what-if"]')).not.toBeNull()
  })

  test('a what-if typed over a real score is saved as such (whatIfGraded)', async () => {
    const onPrefs = vi.fn()
    await render(row(item('hw1', { score: 9, status: 'graded' }), { onPrefs }))
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="Try a what-if"]')!.click())
    const input = container.querySelector('input')!
    await act(async () => typeInto(input, '10'))
    await act(async () => input.blur())
    expect(onPrefs).toHaveBeenCalledTimes(1)
    expect(onPrefs.mock.calls[0][0]({})).toEqual({ whatIf: { hw1: 10 }, whatIfGraded: ['hw1'] })
  })

  test('More is a button menu: arrow keys only move focus, an action runs only when chosen', async () => {
    const onPrefs = vi.fn()
    await render(row(item('hw1'), { onPrefs }))
    expect(container.querySelector('select')).toBeNull()
    const more = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
    expect(more.getAttribute('aria-expanded')).toBe('false')

    await act(async () => key(more, 'ArrowDown'))
    expect(more.getAttribute('aria-expanded')).toBe('true')
    const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(items.map((b) => b.textContent)).toEqual(['Move to Exams', 'Ignore in grade'])
    expect(document.activeElement).toBe(items[0])
    await act(async () => key(items[0], 'ArrowDown'))
    expect(document.activeElement).toBe(items[1])
    await act(async () => key(items[1], 'Escape'))
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(more)
    expect(onPrefs).not.toHaveBeenCalled()

    await act(async () => more.click())
    await act(async () => buttonByText('Ignore in grade').click())
    expect(onPrefs).toHaveBeenCalledTimes(1)
    expect(onPrefs.mock.calls[0][0]({})).toEqual({ ignored: ['hw1'] })
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })
})

// ---------------------------------------------------------------- course detail

describe('<CourseDetail />', () => {
  function detail(c: Course, level: 'undergrad' | 'grad' = 'undergrad', onPrefs = vi.fn(), onRemove?: () => void) {
    return createElement(CourseDetail, { course: c, grade: GRADE, needed: [], level, onPrefs, onRemove })
  }

  const PLUS_MINUS = [
    { letter: 'A', min: 93 },
    { letter: 'A-', min: 90 },
    { letter: 'B+', min: 87 },
    { letter: 'B', min: 83 },
    { letter: 'B-', min: 80 },
    { letter: 'C', min: 70 },
    { letter: 'D', min: 60 },
    { letter: 'F', min: 0 },
  ]

  function cutLabels(): string[] {
    return [...container.querySelectorAll('.cutoff-grid .numfield-label')].map((el) => el.textContent ?? '')
  }

  test('Reset weights clears the weights and the weighted switch it turned on', async () => {
    const onPrefs = vi.fn()
    await render(detail(course({ prefs: { weights: { hw: 50 }, weighted: true } }), 'undergrad', onPrefs))
    await act(async () => buttonByText('Reset to Canvas weights').click())
    const next = onPrefs.mock.calls[0][0]({ weights: { hw: 50 }, weighted: true })
    expect(next.weights).toBeUndefined()
    expect(next.weighted).toBeUndefined()
  })

  test('undergrad cutoffs edit one cut per letter, the cuts letters are computed with', async () => {
    const onPrefs = vi.fn()
    await render(detail(course({ scheme: PLUS_MINUS, schemeSource: 'canvas' }), 'undergrad', onPrefs))
    expect(cutLabels()).toEqual(['A from', 'B from', 'C from', 'D from'])
    const inputs = [...container.querySelectorAll<HTMLInputElement>('.cutoff-grid input')]
    expect(inputs.map((i) => i.value)).toEqual(['90', '80', '70', '60'])

    await act(async () => typeInto(inputs[0], '95'))
    await act(async () => inputs[0].blur())
    expect(onPrefs.mock.calls[0][0]({ cutoffs: PLUS_MINUS })).toEqual({
      cutoffs: [
        { letter: 'A', min: 95 },
        { letter: 'B', min: 80 },
        { letter: 'C', min: 70 },
        { letter: 'D', min: 60 },
        { letter: 'R', min: 0 },
      ],
    })
  })

  test('a cutoff that would break the order is refused', async () => {
    const onPrefs = vi.fn()
    await render(detail(course(), 'undergrad', onPrefs))
    const b = container.querySelectorAll<HTMLInputElement>('.cutoff-grid input')[1]
    await act(async () => typeInto(b, '95')) // B above A (90)
    await act(async () => b.blur())
    expect(onPrefs).not.toHaveBeenCalled()
    expect(b.value).toBe('80')
  })

  test('grad students still edit every +/- cut', async () => {
    await render(detail(course({ scheme: PLUS_MINUS }), 'grad'))
    expect(cutLabels()).toEqual(['A from', 'A- from', 'B+ from', 'B from', 'B- from', 'C from', 'D from'])
  })

  test('a grad letter override still shows (and can be cleared) in undergrad mode', async () => {
    await render(detail(course({ prefs: { letter: 'B-' } })))
    const select = [...container.querySelectorAll('select')].find((s) => s.closest('label')?.textContent?.includes('Final letter'))!
    expect(select.value).toBe('B-')
    expect([...select.options].map((o) => o.value)).toContain('')
  })

  test('Remove this class asks first', async () => {
    const onRemove = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await render(detail(course(), 'undergrad', vi.fn(), onRemove))
    await act(async () => buttonByText('Remove this class').click())
    expect(confirm).toHaveBeenCalledWith('Remove 21-241? Its units, letter and other settings are deleted too.')
    expect(onRemove).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    await act(async () => buttonByText('Remove this class').click())
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  test('"What you need" notes remaining items whose points are unknown', async () => {
    const c = course({ items: [item('a'), item('b', { max: null })] })
    await render(
      createElement(CourseDetail, {
        course: c,
        grade: GRADE,
        needed: [{ letter: 'A', min: 90, needed: 95, status: 'possible' }],
        level: 'undergrad',
        onPrefs: vi.fn(),
      }),
    )
    expect(text()).toContain("Leaves out 1 item whose point values aren't posted yet.")
  })
})

// ---------------------------------------------------------------- toasts

describe('<Toasts />', () => {
  test('5 s for a plain toast, 8 s with an action, and never while focused', async () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    const toasts: Toast[] = [
      { id: 1, message: 'plain' },
      { id: 2, message: 'undo me', action: { label: 'Undo', onClick: () => {} } },
    ]
    await render(createElement(Toasts, { toasts, onDismiss }))
    act(() => vi.advanceTimersByTime(5000))
    expect(onDismiss.mock.calls.map((c) => c[0])).toEqual([1])
    act(() => vi.advanceTimersByTime(3000))
    expect(onDismiss.mock.calls.map((c) => c[0])).toEqual([1, 2])
  })

  test('keyboard focus inside a toast pauses it', async () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    await render(createElement(Toasts, { toasts: [{ id: 3, message: 'x', action: { label: 'Undo', onClick: () => {} } }], onDismiss }))
    const undo = buttonByText('Undo')
    act(() => undo.focus())
    act(() => vi.advanceTimersByTime(20_000))
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => undo.blur())
    act(() => vi.advanceTimersByTime(8000))
    expect(onDismiss).toHaveBeenCalledWith(3)
  })
})

// ---------------------------------------------------------------- header and QPA card

describe('header and QPA extras', () => {
  function header(terms: string[]) {
    return createElement(Header, {
      navigate: () => {},
      showDashboard: true,
      terms,
      term: terms[0],
      onTermChange: () => {},
      lastSync: {},
      now: Date.now(),
      onOpenSettings: () => {},
    })
  }

  test('the Sync popover says when each site last synced', async () => {
    await render(header(['Fall 2026']))
    expect(container.querySelector('select')).toBeNull() // one term: no picker
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click())
    expect(container.querySelector('.sync-when')?.textContent).toBe('Last sync: Canvas not synced · Gradescope not synced')
  })

  test('the term picker shows only with more than one term', async () => {
    await render(header(['Fall 2026', 'Spring 2026']))
    expect(container.querySelector('select')).not.toBeNull()
  })

  test('cumulative QPA is only offered for the newest term', async () => {
    const qpa: QpaResult = { rows: [], semesterQpa: 3.5, factorableUnits: 36, totalUnits: 36, qualityPoints: 126, cumulativeQpa: null, deansList: null }
    const settings: Settings = { level: 'undergrad', college: null, priorQpa: 3.4, priorUnits: 90, term: 'Spring 2026', showAll: false }
    await render(createElement(QpaExtras, { qpa, settings, onSettings: () => {}, newestTerm: false }))
    expect(text()).toContain('Cumulative QPA shows for your newest term only')
    expect(container.querySelector('input')).toBeNull()
  })

  test('with a prior QPA set, the cumulative result shows', async () => {
    const qpa: QpaResult = { rows: [], semesterQpa: 3.5, factorableUnits: 36, totalUnits: 36, qualityPoints: 126, cumulativeQpa: 3.42, deansList: null }
    const settings: Settings = { level: 'undergrad', college: null, priorQpa: 3.4, priorUnits: 90, term: null, showAll: false }
    await render(createElement(QpaExtras, { qpa, settings, onSettings: () => {}, newestTerm: true }))
    expect(text()).toContain('Cumulative after this semester: 3.42')
    expect(container.querySelectorAll('input')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------- class page routing

describe('class page', () => {
  const KEY = 'Fall 2026|21241'
  const PATH = '/class/' + encodeURIComponent(KEY)

  function synced() {
    saveStore(applyPayload(defaultStore(), payload([syncedCanvas('1')])))
  }

  function popTo(path: string) {
    window.history.replaceState(null, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  test('a row opens the class at /class/<key>; Back returns to the list', async () => {
    synced()
    await renderApp()
    expect(container.querySelector('.class-row')).not.toBeNull()
    expect(text()).not.toContain('Midterm 1')

    await act(async () => container.querySelector<HTMLButtonElement>('button.class-row')!.click())
    expect(window.location.pathname).toBe(PATH)
    expect(container.querySelector('h1')?.textContent).toBe('21-241')
    expect(text()).toContain('From Canvas · 11 units')
    expect(text()).toContain('What you need')
    expect(text()).toContain('Midterm 1')
    expect(container.querySelector('.class-row')).toBeNull()
    // What-if boxes stay hidden until the switch is turned on.
    expect(container.querySelector('.whatif input')).toBeNull()
    await act(async () => container.querySelector<HTMLInputElement>('input[role="switch"]')!.click())
    expect(container.querySelector('.whatif input')).not.toBeNull()

    await act(async () => buttonByText('All classes').click())
    expect(window.location.pathname).toBe('/')
    expect(container.querySelector('.class-row')).not.toBeNull()
  })

  test('the browser Back and Forward buttons (popstate) switch between list and class', async () => {
    synced()
    await renderApp()
    await act(async () => container.querySelector<HTMLButtonElement>('button.class-row')!.click())
    await act(async () => popTo('/'))
    expect(container.querySelector('.class-row')).not.toBeNull()
    await act(async () => popTo(PATH))
    expect(container.querySelector('.class-row')).toBeNull()
    expect(text()).toContain('Midterm 1')
  })

  test('a deep link opens the class directly', async () => {
    synced()
    window.history.replaceState(null, '', PATH)
    await renderApp()
    expect(container.querySelector('h1')?.textContent).toBe('21-241')
    expect(text()).toContain('Edit this class')
  })

  test('a link to a class that is not here falls back to the list', async () => {
    synced()
    window.history.replaceState(null, '', '/class/' + encodeURIComponent('Fall 2026|99999'))
    await renderApp()
    expect(window.location.pathname).toBe('/')
    expect(container.querySelector('.class-row')).not.toBeNull()
  })

  test('a broken /class/ link does not crash', async () => {
    synced()
    window.history.replaceState(null, '', '/class/%E0%A4%A')
    await renderApp()
    expect(container.querySelector('.class-row')).not.toBeNull()
  })

  test('removing a hand-added class goes back to the list', async () => {
    const s = defaultStore()
    s.manual = [{ key: 'manual:abc', number: '15213', title: '', term: null, percent: 88 }]
    saveStore(s)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    window.history.replaceState(null, '', '/class/manual%3Aabc')
    await renderApp()
    expect(text()).toContain('Added by hand')
    await act(async () => buttonByText('Remove this class').click())
    expect(window.location.pathname).toBe('/')
    expect(savedStore().manual).toEqual([])
  })
})

describe('class page focus and small flows', () => {
  const KEY = 'Fall 2026|21241'
  const PATH = '/class/' + encodeURIComponent(KEY)

  function synced() {
    saveStore(applyPayload(defaultStore(), payload([syncedCanvas('1')])))
  }

  test('opening a class focuses its name; Back puts focus on the row that was opened', async () => {
    synced()
    await renderApp()
    await act(async () => container.querySelector<HTMLButtonElement>('button.class-row')!.click())
    expect(document.activeElement).toBe(container.querySelector('h1'))

    await act(async () => buttonByText('All classes').click())
    const row = container.querySelector<HTMLButtonElement>('button.class-row')!
    expect(row.dataset.key).toBe(KEY)
    expect(document.activeElement).toBe(row)
  })

  test('with what-ifs the class says so, and drops the "Canvas shows" note', async () => {
    const s = applyPayload(defaultStore(), payload([syncedCanvas('1')]))
    s.prefs[KEY] = { whatIf: { 'c:12': 10 } } // Canvas says 84%, the what-if makes it 86%
    saveStore(s)
    await renderApp()
    expect(text()).toContain('Includes what-if scores') // the row hint in the list
    window.history.replaceState(null, '', PATH)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await settle(0)
    expect(text()).toContain('From Canvas · 11 units · Includes what-if scores')
    expect(text()).not.toContain('Canvas shows')
  })

  test('"Add a class by hand" opens a dialog that starts in the course number field', async () => {
    synced()
    await renderApp()
    await act(async () => buttonByText('Add a class by hand').click())
    const input = container.querySelector<HTMLInputElement>('dialog [data-autofocus]')!
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
  })

  test('/setup with grades has a way back to them', async () => {
    synced()
    window.history.replaceState(null, '', '/setup')
    await renderApp()
    expect(text()).toContain('Set up the Sync button')
    await act(async () => buttonByText('My grades').click())
    expect(window.location.pathname).toBe('/')
    expect(container.querySelector('.class-row')).not.toBeNull()
  })

  test('/setup with no grades has no back button', async () => {
    window.history.replaceState(null, '', '/setup')
    await renderApp()
    expect(() => buttonByText('My grades')).toThrow()
  })
})

// ---------------------------------------------------------------- P/F on the class list

describe('P/F on the class list', () => {
  const MATH = 'Fall 2026|21241'
  const CS = 'Fall 2026|15122'

  /** 21-241 at 84% (a B) and 15-122 at 95% (an A), both from Canvas. */
  function twoClasses(): Store {
    const cs = syncedCanvas('2', {
      number: '15122',
      title: 'Principles of Imperative Computation',
      items: [{ id: '31', name: 'HW1', categoryId: '1', score: 95, max: 100, status: 'graded', due: null, omit: false, url: null }],
    })
    return applyPayload(defaultStore(), payload([syncedCanvas('1'), cs]))
  }

  const row = (key: string) => container.querySelector<HTMLButtonElement>(`button.class-row[data-key="${key}"]`)
  const toggle = (key: string) => container.querySelector<HTMLButtonElement>(`button.class-row[data-key="${key}"] + button.pf-toggle`)
  const chip = (key: string) => row(key)?.querySelector('.chip')?.textContent
  const qpa = () => container.querySelector('.qpa-big')?.textContent
  const spoken = () => container.querySelector('.summary [aria-live="polite"]')?.textContent

  test('one tap counts a class as pass/fail: saved, the chip says P, the QPA leaves it out; another tap clears it', async () => {
    saveStore(twoClasses())
    await renderApp()
    const before = qpa()
    expect(before).toMatch(/^3\.5\d$/) // a B and an A
    const spokenBefore = spoken()
    expect(spokenBefore).toBe(`QPA ${before}, 23 units`) // 11 (21-241) + 12 (15-122)
    const pf = toggle(MATH)!
    expect(pf.textContent).toBe('P/F')
    expect(pf.getAttribute('aria-pressed')).toBe('false')
    expect(pf.getAttribute('aria-label')).toBe('P/F (pass/fail), 21-241')
    expect(pf.title).toBe('Count this class as pass/fail, left out of your QPA')
    expect(chip(MATH)).toBe('B')

    await act(async () => pf.click())
    expect(savedStore().prefs[MATH]).toEqual({ passFail: true })
    expect(pf.getAttribute('aria-pressed')).toBe('true')
    expect(pf.title).toBe('Count the letter grade again')
    expect(chip(MATH)).toBe('P')
    expect(row(MATH)!.textContent).toContain('84%') // the percent still shows
    expect(row(MATH)!.textContent).toContain('Pass/fail')
    expect(qpa()).toBe('4.00') // only 15-122 counts now
    expect(spoken()).toMatch(/^QPA 4\.00, \d+ units$/) // what screen readers hear after the tap
    expect(window.location.pathname).toBe('/') // P/F never opens the class
    expect(toggle(CS)!.getAttribute('aria-pressed')).toBe('false') // the other class is untouched

    await act(async () => pf.click())
    expect(savedStore().prefs[MATH]).toBeUndefined() // nothing saved: back to the letter
    expect(pf.getAttribute('aria-pressed')).toBe('false')
    expect(chip(MATH)).toBe('B')
    expect(qpa()).toBe(before)
    expect(spoken()).toBe(spokenBefore)
  })

  test('the row button still opens the class, and the class page shows the same setting', async () => {
    saveStore(twoClasses())
    await renderApp()
    expect(container.querySelector('button button')).toBeNull() // never a button inside a button
    await act(async () => toggle(MATH)!.click())
    await act(async () => row(MATH)!.click())
    expect(window.location.pathname).toBe('/class/' + encodeURIComponent(MATH))
    expect(text()).toContain('From Canvas · 11 units · Pass/fail')
    expect(container.querySelector('.class-head-grade .chip')?.textContent).toBe('P') // the same letter as on the list
    const box = [...container.querySelectorAll('label.check')].find((l) => l.textContent?.includes('Taken pass/fail'))
    expect(box?.querySelector('input')?.checked).toBe(true)

    // Back on the list, focus returns to the row that was opened (not to its P/F).
    await act(async () => buttonByText('All classes').click())
    expect(document.activeElement).toBe(row(MATH))
  })

  test('keyboard: Tab goes from a row to its P/F, a native button that keeps focus when pressed', async () => {
    saveStore(twoClasses())
    await renderApp()
    // The tab order follows the page: each row, then its P/F, then the next row.
    const tabbable = [...container.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')].filter(
      (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
    )
    const order = [row(CS), toggle(CS), row(MATH), toggle(MATH)].map((el) => tabbable.indexOf(el!))
    expect(order[0]).toBeGreaterThanOrEqual(0)
    expect(order).toEqual([order[0], order[0] + 1, order[0] + 2, order[0] + 3])

    // A real <button type="button">, so browsers press it with Space and Enter. jsdom doesn't turn keys into clicks,
    // so a click stands in for the key here.
    const pf = toggle(MATH)!
    expect(pf.tagName).toBe('BUTTON')
    expect(pf.type).toBe('button')
    pf.focus()
    await act(async () => pf.click())
    expect(pf.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(pf) // still on P/F after the list re-renders
  })

  test('a class added by hand with only a title gets P/F too; the hidden list gets none', async () => {
    const s = twoClasses()
    s.prefs[CS] = { hidden: true }
    s.manual = [{ key: 'manual:r1', number: '', title: 'Research', term: 'Fall 2026', percent: 90 }]
    s.settings.showAll = true
    saveStore(s)
    await renderApp()
    expect(container.querySelectorAll('.class-row')).toHaveLength(3) // 21-241, Research, and 15-122 under Hidden
    const names = [...container.querySelectorAll('.pf-toggle')].map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['P/F (pass/fail), 21-241', 'P/F (pass/fail), Research'])
    expect(toggle(CS)).toBeNull()

    // Research counts toward the QPA (9 units by default), so P/F takes it out.
    const research = toggle('manual:r1')!
    await act(async () => research.click())
    expect(savedStore().prefs['manual:r1']).toEqual({ passFail: true })
    expect(chip('manual:r1')).toBe('P')
    expect(container.querySelector('.summary .muted')?.textContent).toMatch(/^Estimated QPA · 11 units/) // 21-241 only
  })
})

describe('shownLetter', () => {
  test('a pass/fail class shows P, or N when failing; no grade stays none; a final grade from SIO and letters like W stay', () => {
    const pf = course({ prefs: { passFail: true } })
    expect(shownLetter(course(), 'B', 'estimate')).toBe('B')
    expect(shownLetter(pf, 'B', 'estimate')).toBe('P')
    expect(shownLetter(pf, null, null)).toBeNull() // no grades yet: the row shows "?", not a pass
    expect(shownLetter(pf, 'R', 'estimate')).toBe('N')
    expect(shownLetter(pf, 'W', 'you')).toBe('W')
    expect(shownLetter(pf, 'A', 'sio-final')).toBe('A')
  })
})

describe('rowHint', () => {
  const need = (letter: string, min: number, status: NeededResult['status'], needed: number | null = null): NeededResult => ({
    letter,
    min,
    status,
    needed,
  })

  test('says "to keep" when the row already shows that letter', () => {
    const needed = [need('A', 90, 'possible', 88.5), need('B', 80, 'guaranteed', 0)]
    expect(rowHint(course(), needed, GRADE, 'A')).toBe('Need 88.5% on the rest to keep the A')
    expect(rowHint(course(), needed, GRADE, 'B')).toBe('Need 88.5% on the rest for an A')
  })

  test('pass/fail, hidden and what-ifs come first', () => {
    const needed = [need('A', 90, 'possible', 88.5)]
    expect(rowHint(course({ prefs: { passFail: true } }), needed, GRADE, 'A', true)).toBe('Pass/fail')
    expect(rowHint(course({ prefs: { hidden: true } }), needed, GRADE, 'A', true)).toBe('Hidden')
    expect(rowHint(course(), needed, GRADE, 'A', true)).toBe('Includes what-if scores')
    expect(rowHint(course(), [need('A', 90, 'unknown')], GRADE)).toBeNull()
  })
})

// ---------------------------------------------------------------- syllabus weights

/** A tiny real PDF built here (made-up text): "Grading", "Homework 40%", "Exams 60%". */
function tinySyllabusPdf(): string {
  const lines: [number, string][] = [
    [720, 'Grading'],
    [700, 'Homework 40%'],
    [680, 'Exams 60%'],
  ]
  const content = 'BT /F1 12 Tf ' + lines.map(([y, t]) => `1 0 0 1 72 ${y} Tm (${t}) Tj`).join(' ') + ' ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return btoa(pdf)
}

describe('syllabus weights in the app', () => {
  const KEY = 'Fall 2026|21241'
  const PATH = '/class/' + encodeURIComponent(KEY)

  test('a synced syllabus PDF is saved as text (never the PDF) and its weights replace unweighted Canvas', async () => {
    const course = syncedCanvas('5', {
      weighted: false, // Canvas in points mode
      syllabus: [{ source: 'canvas-file', name: 'syllabus.pdf', url: 'https://canvas.cmu.edu/courses/5/files/9', pdfBase64: tinySyllabusPdf() }],
    })
    const encoded = await encodePayload(payload([course]))
    window.history.replaceState(null, '', `/#sync=${encoded}&bv=1`)
    await renderApp()
    for (let i = 0; i < 40 && !localStorage.getItem(STORE_KEY)?.includes('canvas:5'); i++) await settle(50) // pdf.js reads the file
    const saved = savedStore().synced['canvas:5']
    expect(saved.syllabus).toEqual([
      { source: 'canvas-file', name: 'syllabus.pdf', url: 'https://canvas.cmu.edu/courses/5/files/9', text: 'Grading\nHomework 40%\nExams 60%' },
    ])
    expect(localStorage.getItem(STORE_KEY)).not.toContain('pdfBase64')

    // The class page shows where the weights came from, why they differ from Canvas, and links the syllabus.
    window.history.replaceState(null, '', PATH)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await settle(0)
    const line = container.querySelector('.weights-line')!
    expect(line.textContent).toContain('Weights · Homework 40% · Exams 60% · from syllabus')
    expect(line.textContent).toContain("Using syllabus weights; Canvas isn't weighted.")
    expect(line.querySelector('a')?.getAttribute('href')).toBe('https://canvas.cmu.edu/courses/5/files/9')
  }, 20_000)

  test('with syllabus weights, Reset goes back to the syllabus weights', async () => {
    const c = course({ prefs: { weights: { hw: 50 }, weighted: true }, syllabusUsed: { name: 'Syllabus page', url: null } })
    await render(createElement(CourseDetail, { course: c, grade: GRADE, needed: [], level: 'undergrad', onPrefs: vi.fn() }))
    expect(buttonByText('Reset to syllabus weights')).toBeInstanceOf(HTMLButtonElement)
  })

  test('the Weights line names each source when they are mixed, and stays out of points mode', async () => {
    const mixed: Category[] = [
      { ...CATEGORIES[0], weight: 25, weightSource: 'you' },
      { ...CATEGORIES[1], weight: 75, weightSource: 'syllabus' },
    ]
    await render(createElement(CourseDetail, { course: course({ categories: mixed }), grade: GRADE, needed: [], level: 'undergrad', onPrefs: vi.fn() }))
    expect(container.querySelector('.weights-line')?.textContent).toBe('Weights · Homework 25% (set by you) · Exams 75% (from syllabus)')
    act(() => root?.unmount())
    root = null

    await render(createElement(CourseDetail, { course: course({ weighted: false }), grade: GRADE, needed: [], level: 'undergrad', onPrefs: vi.fn() }))
    expect(container.querySelector('.weights-line')).toBeNull()
  })

  test('Canvas weights alone: "from Canvas", no note', async () => {
    const canvasCats: Category[] = CATEGORIES.map((c) => ({ ...c, weightSource: 'canvas' }))
    await render(createElement(CourseDetail, { course: course({ categories: canvasCats }), grade: GRADE, needed: [], level: 'undergrad', onPrefs: vi.fn() }))
    const line = container.querySelector('.weights-line')!
    expect(line.textContent).toBe('Weights · Homework 40% · Exams 60% · from Canvas')
  })
})

// ---------------------------------------------------------------- the AI advisor in the app (the chat itself: chatPanel.test.ts)

describe('AI advisor wiring', () => {
  function sheet(): HTMLDialogElement {
    const d = container.querySelector<HTMLDialogElement>('dialog.chat-sheet')
    if (!d) throw new Error('no chat sheet')
    return d
  }

  function openSettings() {
    return act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!.click())
  }

  test('the header AI advisor button and the link under the classes open the chat; Ask Claude is gone', async () => {
    saveStore(applyPayload(defaultStore(), payload([syncedCanvas('1')])))
    await renderApp()
    expect(text()).not.toContain('Claude')
    expect(sheet().open).toBe(false)

    await act(async () => buttonByText('AI advisor').click())
    expect(sheet().open).toBe(true)
    expect(sheet().querySelector('h2')?.textContent?.trim()).toBe('AI advisor')
    expect(text()).toContain('GradeCrunch keeps nothing on its server.') // the first-use notice comes first

    await act(async () => sheet().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
    expect(sheet().open).toBe(false)
    await act(async () => buttonByText('Ask the AI advisor').click())
    expect(sheet().open).toBe(true)
  })

  test('no AI advisor button before there are grades', async () => {
    await renderApp()
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'AI advisor')).toBe(false)
  })

  test('"Ask the AI advisor about this class" starts the question with that class', async () => {
    saveStore(applyPayload(defaultStore(), payload([syncedCanvas('1')])))
    localStorage.setItem(CONSENT_KEY, 'yes') // the notice was accepted before
    window.history.replaceState(null, '', '/class/' + encodeURIComponent('Fall 2026|21241'))
    await renderApp()
    await act(async () => buttonByText('Ask the AI advisor about this class').click())
    expect(sheet().open).toBe(true)
    expect(sheet().querySelector('textarea')!.value).toBe('About 21-241: ')

    // Closed without asking, then opened from the top bar: the class start goes away...
    const close = () => act(async () => sheet().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
    await close()
    await act(async () => buttonByText('AI advisor').click())
    expect(sheet().querySelector('textarea')!.value).toBe('')

    // ...but a question the student started typing stays.
    const box = sheet().querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'What do I need on the final?')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await close()
    await act(async () => buttonByText('Ask the AI advisor about this class').click())
    expect(sheet().querySelector('textarea')!.value).toBe('What do I need on the final?')
  })

  test('Settings lists what the AI advisor remembers, and Delete everything removes the chat and notes too', async () => {
    saveStore(applyPayload(defaultStore(), payload([syncedCanvas('1')])))
    saveNotes([{ id: 'n1', text: 'Taking 21-241 pass/fail', at: '2026-11-12T10:00:00Z' }])
    saveChat([{ id: 'm1', role: 'user', text: 'Is 21-241 pass/fail?' }])
    localStorage.setItem(CONSENT_KEY, 'yes')
    await renderApp()
    await openSettings()
    expect(text()).toContain('What the AI advisor remembers')
    expect(text()).toContain('Taking 21-241 pass/fail')
    expect(text()).toContain("Removes your grades, settings and the AI advisor's chat and notes from this browser.")

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    // The page then reloads. jsdom can't, and prints "Not implemented: navigation to another Document": expected.
    await act(async () => buttonByText('Delete everything').click())
    expect(confirm.mock.calls[0][0]).toContain("the AI advisor's chat and notes")
    for (const k of [STORE_KEY, MEMORY_KEY, CHAT_KEY, CONSENT_KEY]) expect(localStorage.getItem(k), k).toBeNull()
  })

  /** Types a question into the open chat and sends it. */
  async function ask(question: string) {
    const box = sheet().querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, question)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => buttonByText('Send').click())
  }

  /** A fake /api/chat whose first answer (a set_pass_fail call for 21-241) waits until `release()`. */
  function slowServer() {
    const call = '{"course":"21-241","on":true}'
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    let release!: () => void
    const first = new Promise<Response>((resolve) => {
      release = () =>
        resolve(json({ text: '', toolCalls: [{ id: 'c1', name: 'set_pass_fail', arguments: call }], items: [{ type: 'function_call', call_id: 'c1', name: 'set_pass_fail', arguments: call }] }))
    })
    const fetchMock = vi.fn().mockReturnValueOnce(first).mockImplementation(async () => json({ text: 'Done.', toolCalls: [], items: [] }))
    vi.stubGlobal('fetch', fetchMock)
    return { fetchMock, release: () => release() }
  }

  test('a question still being answered when another tab deletes everything changes nothing', async () => {
    saveStore(applyPayload(defaultStore(), payload([syncedCanvas('1')])))
    saveNotes([{ id: 'n1', text: 'Aiming for an A in 21-241', at: '' }])
    localStorage.setItem(CONSENT_KEY, 'yes')
    const server = slowServer()
    await renderApp()
    await act(async () => buttonByText('AI advisor').click())
    await ask('Make 21-241 pass/fail')
    expect(server.fetchMock).toHaveBeenCalledTimes(1) // the answer is on its way

    // Another tab: Settings > Delete everything. This tab gets one storage event per key removed.
    for (const k of [MEMORY_KEY, CHAT_KEY, CONSENT_KEY, STORE_KEY]) {
      localStorage.removeItem(k)
      await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: null })))
    }
    expect(text()).toContain('All your CMU grades in one place.')

    server.release() // the AI's tool call arrives anyway
    await settle()
    for (const k of [STORE_KEY, MEMORY_KEY, CHAT_KEY]) expect(localStorage.getItem(k), k).toBeNull() // nothing came back
    expect(server.fetchMock).toHaveBeenCalledTimes(1) // the tool never ran, so no second call
    expect(text()).toContain('All your CMU grades in one place.')
  })

  test('a question still being answered when another tab clears the chat makes no change without a receipt', async () => {
    saveStore(applyPayload(defaultStore(), payload([syncedCanvas('1')])))
    localStorage.setItem(CONSENT_KEY, 'yes')
    const server = slowServer()
    await renderApp()
    await act(async () => buttonByText('AI advisor').click())
    await ask('Make 21-241 pass/fail')

    localStorage.removeItem(CHAT_KEY) // Clear chat in another tab
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: CHAT_KEY, newValue: null })))
    server.release()
    await settle()
    expect(JSON.parse(localStorage.getItem(STORE_KEY)!).prefs['Fall 2026|21241']).toBeUndefined()
    expect(text()).not.toContain('set to pass/fail')
    expect(localStorage.getItem(CHAT_KEY)).toBeNull()
  })

  test("leaving the demo forgets the AI advisor's chat and notes about the made-up grades (the consent stays)", async () => {
    saveStore(loadDemo(defaultStore(), demoPayloads()))
    saveNotes([{ id: 'n1', text: 'Taking 76-101 pass/fail', at: '' }])
    saveChat([{ id: 'm1', role: 'user', text: "I'm taking 76-101 pass/fail" }])
    localStorage.setItem(CONSENT_KEY, 'yes')
    await renderApp()
    expect(text()).toContain("I'm taking 76-101 pass/fail")

    await act(async () => buttonByText('Clear sample data').click())
    expect(localStorage.getItem(MEMORY_KEY)).toBeNull()
    expect(localStorage.getItem(CHAT_KEY)).toBeNull()
    expect(localStorage.getItem(CONSENT_KEY)).toBe('yes')
    expect(text()).not.toContain("I'm taking 76-101 pass/fail")
  })

  test('a real sync that replaces the demo forgets the demo chat and notes too', async () => {
    saveStore(loadDemo(defaultStore(), demoPayloads()))
    saveNotes([{ id: 'n1', text: 'Taking 76-101 pass/fail', at: '' }])
    saveChat([{ id: 'm1', role: 'user', text: "I'm taking 76-101 pass/fail" }])
    const encoded = await encodePayload(payload([syncedCanvas('1')]))
    window.history.replaceState(null, '', `/#sync=${encoded}&bv=1`)
    await renderApp()
    await settle()
    expect(text()).toContain('Synced 1 course from Canvas')
    expect(localStorage.getItem(MEMORY_KEY)).toBeNull()
    expect(localStorage.getItem(CHAT_KEY)).toBeNull()
    expect(text()).not.toContain("I'm taking 76-101 pass/fail")
  })

  test('notes saved in another tab show up here, and a chat deleted in another tab goes away here too', async () => {
    saveStore(applyPayload(defaultStore(), payload([syncedCanvas('1')])))
    saveChat([{ id: 'm1', role: 'user', text: 'An old question' }])
    localStorage.setItem(CONSENT_KEY, 'yes')
    await renderApp()
    expect(text()).toContain('An old question')

    // "Delete everything" in another tab removed the chat: this tab must not keep it (and save it back later).
    localStorage.removeItem(CHAT_KEY)
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: CHAT_KEY, newValue: null })))
    expect(text()).not.toContain('An old question')
    expect(localStorage.getItem(CHAT_KEY)).toBeNull() // and nothing saved back

    localStorage.setItem(MEMORY_KEY, JSON.stringify([{ id: 'n2', text: 'Aiming for an A in 21-241', at: '' }]))
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: MEMORY_KEY })))
    await openSettings()
    expect(text()).toContain('Aiming for an A in 21-241')
  })
})
