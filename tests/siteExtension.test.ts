// Tests for the website side of the Chrome extension: the client in src/lib/extension.ts (with a fake
// chrome.runtime), and how the App uses it (auto-sync, login lines, re-sync on focus, the "finish setup" card,
// the header Sync button, the Autolab setting) with a fake extension client. All data is synthetic.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  AUTOLAB_SETTING_KEY,
  detectExtension,
  loginSources,
  mergeNotes,
  needsAutoSync,
  openExtensionWelcome,
  pickSources,
  safeLoginUrl,
  syncWithExtension,
  type ChromeLike,
  type ChromePort,
  type ExtensionClient,
  type ExtensionInfo,
  type ExtProgress,
  type ExtSource,
  type ExtSourceResult,
  type SyncNote,
} from '../src/lib/extension'
import { applyPayload, defaultStore, saveStore, STORE_KEY } from '../src/lib/store'
import { ConnectCard, ConnectTrouble } from '../src/ui/ConnectCard'
import type { Store, SyncedCourse, SyncPayload } from '../src/types'

// ---------------------------------------------------------------- browser setup (same as app.test.ts)

// Node's own experimental localStorage shadows jsdom's and does not work without a flag, so use a small one.
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
  window.scrollTo = () => {}
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
})

async function render(element: ReturnType<typeof createElement>) {
  root = createRoot(container)
  await act(async () => root!.render(element))
}

async function settle(ms = 30) {
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

// ---------------------------------------------------------------- a fake chrome.runtime

const INSTALLED_ID = 'b'.repeat(32)
const OTHER_ID = 'a'.repeat(32)

interface FakeExtensionSide {
  send: (msg: unknown) => void // extension -> page
  close: (lastError?: string) => void // the extension (or Chrome) closes the port
}

/**
 * A chrome object whose runtime.connect behaves like Chrome's: an id that is not installed gives a port that
 * disconnects with lastError set; the installed id calls `onRequest` with each message the page posts.
 */
function fakeChrome(onRequest: (msg: unknown, ext: FakeExtensionSide) => void, installed = [INSTALLED_ID]) {
  const chrome: ChromeLike & { runtime: { lastError?: { message?: string } } } = { runtime: {} }
  const posted: unknown[] = []
  const lastErrorReads: string[] = []

  chrome.runtime.connect = (id: string) => {
    const onMessage: ((m: unknown) => void)[] = []
    const onDisconnect: (() => void)[] = []
    let open = true
    const ext: FakeExtensionSide = {
      send: (msg) => setTimeout(() => open && onMessage.forEach((fn) => fn(msg)), 0),
      close: (lastError) => {
        if (!open) return
        open = false
        // Chrome sets lastError only while the onDisconnect listeners run.
        let error: { message?: string } | undefined = lastError ? { message: lastError } : undefined
        Object.defineProperty(chrome.runtime, 'lastError', {
          configurable: true,
          get() {
            if (error?.message) lastErrorReads.push(error.message)
            return error
          },
        })
        onDisconnect.forEach((fn) => fn())
        error = undefined
      },
    }
    const port: ChromePort = {
      postMessage: (msg) => {
        posted.push(msg)
        if (installed.includes(id)) setTimeout(() => open && onRequest(msg, ext), 0)
      },
      disconnect: () => {
        open = false // the page closing its own end does not fire its own onDisconnect (same as Chrome)
      },
      onMessage: { addListener: (fn) => onMessage.push(fn) },
      onDisconnect: { addListener: (fn) => onDisconnect.push(fn) },
    }
    if (!installed.includes(id)) setTimeout(() => ext.close('Could not establish connection. Receiving end does not exist.'), 0)
    return port
  }
  return { chrome, posted, lastErrorReads }
}

/** An extension that answers hello and openWelcome. */
function helloOnly(consent = true) {
  return (msg: unknown, ext: FakeExtensionSide) => {
    const type = (msg as { type: string }).type
    if (type === 'hello' || type === 'openWelcome') ext.send({ type: 'hello', version: '1.2.3', consent })
  }
}

// ---------------------------------------------------------------- the client

describe('detectExtension', () => {
  test('no chrome object at all (Safari, Firefox): null', async () => {
    expect(await detectExtension(undefined)).toBeNull()
    expect(await detectExtension({})).toBeNull()
    expect(await detectExtension({ runtime: {} })).toBeNull() // Chrome without any extension that lists this site
  })

  test('tries each known id and returns the one that says hello', async () => {
    const f = fakeChrome(helloOnly(false))
    const info = await detectExtension(f.chrome, [OTHER_ID, INSTALLED_ID])
    expect(info).toEqual({ id: INSTALLED_ID, version: '1.2.3', consent: false })
    expect(f.posted).toEqual([{ type: 'hello' }, { type: 'hello' }])
    expect(f.lastErrorReads).toEqual(['Could not establish connection. Receiving end does not exist.']) // handled
  })

  test('nothing installed: null', async () => {
    const f = fakeChrome(helloOnly(), [])
    expect(await detectExtension(f.chrome, [OTHER_ID, INSTALLED_ID])).toBeNull()
  })

  test('an extension that never answers times out: null', async () => {
    const f = fakeChrome(() => {}) // connects, never replies
    expect(await detectExtension(f.chrome, [INSTALLED_ID], 20)).toBeNull()
  })

  test('connect throwing (a malformed id) is handled', async () => {
    const chrome: ChromeLike = {
      runtime: {
        connect: () => {
          throw new Error('Invalid extension id')
        },
      },
    }
    expect(await detectExtension(chrome, ['bad'])).toBeNull()
  })
})

describe('syncWithExtension', () => {
  const okPayload = { v: 1, kind: 'canvas', at: '2026-11-12T10:00:00Z', courses: [], warnings: [] }

  test('streams progress, then resolves with the cleaned results', async () => {
    const f = fakeChrome((msg, ext) => {
      expect(msg).toEqual({ type: 'sync', sources: ['canvas', 'gradescope', 'autolab'] })
      ext.send({ type: 'progress', source: 'canvas', message: 'Canvas: 1 of 2 courses' })
      ext.send({ type: 'progress', source: 'canvas', message: 'Canvas: 2 of 2 courses' })
      ext.send({
        type: 'result',
        results: [
          { source: 'canvas', status: 'ok', payload: okPayload },
          { source: 'gradescope', status: 'login', loginUrl: 'https://evil.example/login' },
          { source: 'autolab', status: 'error', message: 'Autolab is down' },
          { source: 'moodle', status: 'ok', payload: {} }, // not a site we know: dropped
          'junk',
        ],
      })
    })
    const progress: ExtProgress[] = []
    const result = await syncWithExtension(INSTALLED_ID, ['canvas', 'gradescope', 'autolab'], (p) => progress.push(p), f.chrome)
    expect(progress.map((p) => p.message)).toEqual(['Canvas: 1 of 2 courses', 'Canvas: 2 of 2 courses'])
    expect(result.results).toEqual([
      { source: 'canvas', status: 'ok', payload: okPayload },
      { source: 'gradescope', status: 'login', loginUrl: 'https://www.gradescope.com/' }, // unsafe link replaced
      { source: 'autolab', status: 'error', message: 'Autolab is down' },
    ])
  })

  test("an 'error' answer rejects with its message ('consent' before the welcome page is done)", async () => {
    const f = fakeChrome((_msg, ext) => ext.send({ type: 'error', message: 'consent' }))
    await expect(syncWithExtension(INSTALLED_ID, ['canvas'], () => {}, f.chrome)).rejects.toThrow('consent')
  })

  test('the port closing before the result rejects', async () => {
    const f = fakeChrome((_msg, ext) => {
      ext.send({ type: 'progress', source: 'canvas', message: 'Canvas: starting' })
      setTimeout(() => ext.close('The extension was reloaded'), 5)
    })
    await expect(syncWithExtension(INSTALLED_ID, ['canvas'], () => {}, f.chrome)).rejects.toThrow(/Lost the connection/)
  })

  test('silence for longer than the timeout rejects', async () => {
    const f = fakeChrome(() => {})
    await expect(syncWithExtension(INSTALLED_ID, ['canvas'], () => {}, f.chrome, 20)).rejects.toThrow(/stopped answering/)
  })

  test('each progress message restarts the timeout, so a long but live sync finishes', async () => {
    const f = fakeChrome((_msg, ext) => {
      // 4 progress messages 15 ms apart = 60 ms in all, with a 40 ms timeout
      for (let i = 1; i <= 4; i++) setTimeout(() => ext.send({ type: 'progress', source: 'gradescope', message: `step ${i}` }), i * 15)
      setTimeout(() => ext.send({ type: 'result', results: [] }), 75)
    })
    const result = await syncWithExtension(INSTALLED_ID, ['gradescope'], () => {}, f.chrome, 40)
    expect(result.results).toEqual([])
  })

  test('no chrome: rejects', async () => {
    await expect(syncWithExtension(INSTALLED_ID, ['canvas'], () => {}, undefined)).rejects.toThrow(/not installed/)
  })
})

describe('openExtensionWelcome and helpers', () => {
  test('openWelcome sends the request', async () => {
    const f = fakeChrome(helloOnly(false))
    await openExtensionWelcome(INSTALLED_ID, f.chrome)
    expect(f.posted).toEqual([{ type: 'openWelcome' }])
  })

  test('needsAutoSync: nothing synced, or the newest sync is older than 10 minutes', () => {
    const now = Date.parse('2026-11-12T12:00:00Z')
    expect(needsAutoSync({}, now)).toBe(true)
    expect(needsAutoSync({ canvas: '2026-11-12T11:30:00Z' }, now)).toBe(true)
    expect(needsAutoSync({ canvas: '2026-11-12T11:30:00Z', gradescope: '2026-11-12T11:55:00Z' }, now)).toBe(false)
  })

  test('pickSources adds Autolab only when used before or turned on', () => {
    expect(pickSources(false, false)).toEqual(['canvas', 'gradescope'])
    expect(pickSources(true, false)).toEqual(['canvas', 'gradescope', 'autolab'])
    expect(pickSources(false, true)).toEqual(['canvas', 'gradescope', 'autolab'])
  })

  test('mergeNotes keeps notes about sites that were not synced again', () => {
    const old: SyncNote[] = [
      { kind: 'login', source: 'gradescope', url: 'https://www.gradescope.com/' },
      { kind: 'error', source: 'autolab', message: 'down' },
      { kind: 'error', source: null, message: 'timeout' },
    ]
    const merged = mergeNotes(old, ['gradescope'], [])
    expect(merged).toEqual([{ kind: 'error', source: 'autolab', message: 'down' }])
    expect(loginSources(old)).toEqual(['gradescope'])
  })

  test('safeLoginUrl only keeps https links on the same site', () => {
    expect(safeLoginUrl('canvas', 'https://canvas.cmu.edu/login')).toBe('https://canvas.cmu.edu/login')
    expect(safeLoginUrl('canvas', 'javascript:alert(1)')).toBe('https://canvas.cmu.edu/')
    expect(safeLoginUrl('canvas', 'http://canvas.cmu.edu/login')).toBe('https://canvas.cmu.edu/')
    expect(safeLoginUrl('autolab', 42)).toBe('https://autolab.andrew.cmu.edu/')
  })
})

// ---------------------------------------------------------------- the App with a fake extension client

function syncedCourse(source: 'canvas' | 'autolab', id: string): SyncedCourse {
  return {
    source,
    sourceId: id,
    number: '21241',
    alsoNumbers: [],
    title: 'Matrices and Linear Transformations',
    term: 'Fall 2026',
    url: `https://canvas.cmu.edu/courses/${id}`,
    weighted: false,
    categories: [],
    items: [{ id: '1', name: 'HW1', categoryId: null, score: 9, max: 10, status: 'graded', due: null, omit: false, url: null }],
    canvasScore: null,
    canvasGrade: null,
    scheme: null,
    syncedAt: '2026-11-12T10:00:00Z',
  }
}

function canvasPayload(): SyncPayload {
  return { v: 1, kind: 'canvas', at: new Date().toISOString(), courses: [syncedCourse('canvas', '7')], warnings: [] }
}

const LOGIN_GS: ExtSourceResult = { source: 'gradescope', status: 'login', loginUrl: 'https://www.gradescope.com/login' }

/** A fake ExtensionClient. `answer` decides the results for each sync call. */
function fakeClient(info: ExtensionInfo | null, answer: (sources: ExtSource[], call: number) => ExtSourceResult[]) {
  let calls = 0
  const client = {
    detect: vi.fn(async () => info),
    sync: vi.fn(async (_id: string, sources: ExtSource[], onProgress: (p: ExtProgress) => void) => {
      onProgress({ type: 'progress', source: sources[0], message: 'Canvas: 1 of 1 courses' })
      return { type: 'result' as const, results: answer(sources, calls++) }
    }),
    openWelcome: vi.fn(async () => {}),
  } satisfies ExtensionClient
  return client
}

const READY: ExtensionInfo = { id: INSTALLED_ID, version: '1.0.0', consent: true }

/** A store with Canvas grades synced `minutesAgo` minutes ago. */
function savedStore(minutesAgo: number, extra: (s: Store) => Store = (s) => s) {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  const p: SyncPayload = { v: 1, kind: 'canvas', at, courses: [syncedCourse('canvas', '7')], warnings: [] }
  saveStore(extra(applyPayload(defaultStore(), p)))
}

async function renderApp(client: ExtensionClient) {
  const { default: App } = await import('../src/App')
  await render(createElement(App, { extension: client }))
  await settle()
}

describe('App with the extension', () => {
  test('auto-syncs on load when the last sync is old, applies ok payloads, shows one line per login', async () => {
    savedStore(60)
    const client = fakeClient(READY, () => [{ source: 'canvas', status: 'ok', payload: canvasPayload() }, LOGIN_GS])
    await renderApp(client)
    expect(client.sync).toHaveBeenCalledTimes(1)
    expect(client.sync.mock.calls[0][1]).toEqual(['canvas', 'gradescope'])
    expect(text()).toContain('Synced 1 course from Canvas')
    expect(text()).toContain('Undo')
    expect(text()).toContain('Log in to Gradescope to include it.')
    expect(text()).toContain("Not logged in? Open any class's Gradescope link inside Canvas.")
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Open Gradescope')!
    expect(link.getAttribute('href')).toBe('https://www.gradescope.com/login')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  test('no auto-sync when the grades are fresh; the header Sync button syncs instead of opening the popover', async () => {
    savedStore(2)
    const client = fakeClient(READY, () => [{ source: 'canvas', status: 'ok', payload: canvasPayload() }])
    await renderApp(client)
    expect(client.sync).not.toHaveBeenCalled()
    expect(container.querySelector('button[aria-haspopup="dialog"]')).toBeNull() // no bookmarklet popover
    await act(async () => buttonByText('Sync').click())
    await settle()
    expect(client.sync).toHaveBeenCalledTimes(1)
    expect(text()).toContain('Synced 1 course from Canvas')
  })

  test('Autolab is synced when it already has data here', async () => {
    savedStore(60, (s) =>
      applyPayload(s, { v: 1, kind: 'autolab', at: new Date(Date.now() - 3_600_000).toISOString(), courses: [syncedCourse('autolab', '3')], warnings: [] }),
    )
    const client = fakeClient(READY, () => [])
    await renderApp(client)
    expect(client.sync.mock.calls[0][1]).toEqual(['canvas', 'gradescope', 'autolab'])
  })

  test('the Autolab setting adds Autolab to the next sync', async () => {
    savedStore(2)
    const client = fakeClient(READY, () => [])
    await renderApp(client)
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!.click())
    const box = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Also sync Autolab (beta)'))!
    await act(async () => box.querySelector('input')!.click())
    expect(localStorage.getItem(AUTOLAB_SETTING_KEY)).toBe('1')
    await act(async () => buttonByText('Sync').click())
    await settle()
    expect(client.sync.mock.calls[0][1]).toEqual(['canvas', 'gradescope', 'autolab'])
  })

  test('coming back to the tab re-syncs only the sites that needed a login', async () => {
    savedStore(60)
    const client = fakeClient(READY, (sources, call) =>
      call === 0 ? [{ source: 'canvas', status: 'ok', payload: canvasPayload() }, LOGIN_GS] : sources.map(() => ({ source: 'gradescope', status: 'ok', payload: { v: 1, kind: 'gradescope', at: new Date().toISOString(), courses: [], warnings: [] } })),
    )
    await renderApp(client)
    expect(text()).toContain('Log in to Gradescope')
    await act(async () => window.dispatchEvent(new Event('focus')))
    await settle()
    expect(client.sync).toHaveBeenCalledTimes(2)
    expect(client.sync.mock.calls[1][1]).toEqual(['gradescope'])
    expect(text()).not.toContain('Log in to Gradescope')
    // Nothing left to log in to: coming back again does not sync.
    await act(async () => window.dispatchEvent(new Event('focus')))
    await settle()
    expect(client.sync).toHaveBeenCalledTimes(2)
  })

  test('error results and a failed sync show one short line', async () => {
    savedStore(60)
    const client = fakeClient(READY, () => [
      { source: 'canvas', status: 'error', message: 'Canvas said 500' },
      { source: 'gradescope', status: 'ok', payload: { not: 'a payload' } }, // fails validatePayload
    ])
    await renderApp(client)
    expect(text()).toContain('Canvas: Canvas said 500')
    expect(text()).toContain('Gradescope: This sync link is not from a supported version')
    expect(JSON.parse(localStorage.getItem(STORE_KEY)!).synced['canvas:7']).toBeDefined() // old grades kept

    client.sync.mockRejectedValueOnce(new Error('Lost the connection to the extension.'))
    await act(async () => buttonByText('Sync').click())
    await settle()
    expect(text()).toContain('Lost the connection to the extension.')
  })

  test('before consent: a "Finish setting up" card that opens the welcome page, and no sync', async () => {
    savedStore(60)
    const client = fakeClient({ ...READY, consent: false }, () => [])
    await renderApp(client)
    expect(text()).toContain('Finish setting up the extension')
    expect(client.sync).not.toHaveBeenCalled()
    await act(async () => buttonByText('Finish setup').click())
    expect(client.openWelcome).toHaveBeenCalledWith(INSTALLED_ID)

    // The student clicks Continue in the extension and comes back: the card goes and the auto-sync runs.
    client.detect.mockResolvedValue(READY)
    await act(async () => window.dispatchEvent(new Event('focus')))
    await settle()
    expect(text()).not.toContain('Finish setting up the extension')
    expect(client.sync).toHaveBeenCalledTimes(1)
  })

  test("'consent' from a sync brings the card back", async () => {
    savedStore(60)
    const client = fakeClient(READY, () => [])
    client.sync.mockRejectedValueOnce(new Error('consent'))
    await renderApp(client)
    expect(text()).toContain('Finish setting up the extension')
  })

  test('welcome page with the extension: a big Sync my grades button, and the first sync runs by itself', async () => {
    const client = fakeClient(READY, () => [
      { source: 'canvas', status: 'login', loginUrl: 'https://canvas.cmu.edu/' },
      LOGIN_GS,
    ])
    await renderApp(client)
    expect(client.sync).toHaveBeenCalledTimes(1)
    expect(buttonByText('Sync my grades')).toBeTruthy()
    expect(text()).toContain('Log in to Canvas to include it.')
    expect(text()).toContain('Log in to Gradescope to include it.')
    expect(text()).not.toContain('Trouble?') // bookmarklet help is not needed
  })

  test('no extension: the app is unchanged (bookmarklet popover in the header)', async () => {
    savedStore(60)
    const client = fakeClient(null, () => [])
    await renderApp(client)
    expect(client.sync).not.toHaveBeenCalled()
    expect(container.querySelector('button[aria-haspopup="dialog"]')).not.toBeNull()
  })
})

describe('ConnectCard without the extension', () => {
  const toast = () => {}

  test('not published yet: the bookmarklet card, plus a coming-soon line', async () => {
    await render(createElement(ConnectCard, { toast, ext: null, storeUrl: '' }))
    expect(container.querySelector('a.bookmarklet')).not.toBeNull()
    expect(text()).toContain('A Chrome extension is coming soon')
  })

  test('published: an Add to Chrome button, and the bookmarklet moves into Trouble?', async () => {
    const url = 'https://chromewebstore.google.com/detail/example'
    await render(
      createElement('div', null, createElement(ConnectCard, { toast, ext: null, storeUrl: url }), createElement(ConnectTrouble, { toast, storeUrl: url })),
    )
    const add = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Add to Chrome')!
    expect(add.getAttribute('href')).toBe(url)
    expect(container.querySelector('.connect-card a.bookmarklet')).toBeNull()
    expect(container.querySelector('.trouble a.bookmarklet')).not.toBeNull()
    expect(text()).not.toContain('coming soon')
  })
})
