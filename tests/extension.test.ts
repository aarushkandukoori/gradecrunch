// Tests for the Chrome extension (extension/src). Only made-up data: no real courses or grades.
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { LOGIN_URLS } from '../extension/protocol'
import {
  isAllowedOrigin,
  isOffscreenProgress,
  isOffscreenSyncRequest,
  isSourceResultFor,
  parseRequest,
  resultFromError,
} from '../extension/src/rules'
import { autolabFetchPage, gradescopeFetchText, runSource, siteUrl } from '../extension/src/sync'
import { absoluteFetcher, CanvasAuthError, CanvasHttpError } from '../src/sync/canvas'

const PATTERNS = ['https://grades.aarushkandukoori.com/*', 'https://gradecrunch.pages.dev/*', 'http://localhost/*']

/** A stand-in for a fetch Response with just the fields our fetchers read. */
function fakeResponse(body: string, init: { status?: number; url?: string; link?: string } = {}) {
  const status = init.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    url: init.url ?? '',
    headers: new Headers(init.link ? { Link: init.link } : {}),
    text: async () => body,
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------- sender origin

describe('isAllowedOrigin', () => {
  test('accepts our sites', () => {
    expect(isAllowedOrigin('https://grades.aarushkandukoori.com', PATTERNS)).toBe(true)
    expect(isAllowedOrigin('https://gradecrunch.pages.dev', PATTERNS)).toBe(true)
  })

  test('a pattern without a port matches any port, like Chrome', () => {
    expect(isAllowedOrigin('http://localhost:5173', PATTERNS)).toBe(true)
    expect(isAllowedOrigin('http://localhost', PATTERNS)).toBe(true)
    expect(isAllowedOrigin('http://localhost:5173', ['http://localhost:3000/*'])).toBe(false)
  })

  test('rejects other sites, look-alikes and wrong schemes', () => {
    expect(isAllowedOrigin('https://evil.example', PATTERNS)).toBe(false)
    expect(isAllowedOrigin('https://grades.aarushkandukoori.com.evil.example', PATTERNS)).toBe(false)
    expect(isAllowedOrigin('https://sub.gradecrunch.pages.dev', PATTERNS)).toBe(false)
    expect(isAllowedOrigin('http://grades.aarushkandukoori.com', PATTERNS)).toBe(false)
    expect(isAllowedOrigin('https://localhost:5173', PATTERNS)).toBe(false)
  })

  test('rejects missing or malformed origins', () => {
    expect(isAllowedOrigin(undefined, PATTERNS)).toBe(false)
    expect(isAllowedOrigin('', PATTERNS)).toBe(false)
    expect(isAllowedOrigin('null', PATTERNS)).toBe(false)
    expect(isAllowedOrigin('https://gradecrunch.pages.dev/path', PATTERNS)).toBe(false)
  })

  test('the store build (no localhost pattern) rejects localhost', () => {
    expect(isAllowedOrigin('http://localhost:5173', PATTERNS.slice(0, 2))).toBe(false)
  })
})

// ---------------------------------------------------------------- request validation

describe('parseRequest', () => {
  test('hello and openWelcome', () => {
    expect(parseRequest({ type: 'hello' })).toEqual({ type: 'hello' })
    expect(parseRequest({ type: 'openWelcome', extra: 1 })).toEqual({ type: 'openWelcome' })
  })

  test('sync keeps known sites once, in a fixed order', () => {
    expect(parseRequest({ type: 'sync', sources: ['gradescope', 'canvas'] })).toEqual({
      type: 'sync',
      sources: ['canvas', 'gradescope'],
    })
    expect(parseRequest({ type: 'sync', sources: ['autolab', 'autolab'] })).toEqual({ type: 'sync', sources: ['autolab'] })
  })

  test('rejects anything else', () => {
    expect(parseRequest(null)).toBeNull()
    expect(parseRequest('hello')).toBeNull()
    expect(parseRequest({ type: 'deleteEverything' })).toBeNull()
    expect(parseRequest({ type: 'sync' })).toBeNull()
    expect(parseRequest({ type: 'sync', sources: [] })).toBeNull()
    expect(parseRequest({ type: 'sync', sources: 'canvas' })).toBeNull()
    expect(parseRequest({ type: 'sync', sources: ['canvas', 'piazza'] })).toBeNull()
  })
})

describe('internal message checks', () => {
  test('offscreen sync request and progress', () => {
    expect(isOffscreenSyncRequest({ target: 'offscreen', type: 'sync', source: 'canvas' })).toBe(true)
    expect(isOffscreenSyncRequest({ target: 'offscreen', type: 'sync', source: 'piazza' })).toBe(false)
    expect(isOffscreenProgress({ target: 'background', type: 'progress', source: 'autolab', message: 'x' })).toBe(true)
    expect(isOffscreenProgress({ target: 'background', type: 'progress', source: 'autolab' })).toBe(false)
  })

  test('isSourceResultFor', () => {
    expect(isSourceResultFor({ source: 'canvas', status: 'ok', payload: {} }, 'canvas')).toBe(true)
    expect(isSourceResultFor({ source: 'canvas', status: 'ok', payload: {} }, 'gradescope')).toBe(false)
    expect(isSourceResultFor({ source: 'canvas', status: 'login', loginUrl: 'https://canvas.cmu.edu/' }, 'canvas')).toBe(true)
    expect(isSourceResultFor({ source: 'canvas', status: 'error' }, 'canvas')).toBe(false)
    expect(isSourceResultFor(undefined, 'canvas')).toBe(false)
  })
})

// ---------------------------------------------------------------- errors -> results

describe('resultFromError', () => {
  test('logged out becomes a login result with that site\'s login page', () => {
    expect(resultFromError('canvas', new CanvasAuthError('Log in to Canvas first'))).toEqual({
      source: 'canvas',
      status: 'login',
      loginUrl: LOGIN_URLS.canvas,
    })
    expect(resultFromError('gradescope', new Error('Log in to Gradescope first'))).toEqual({
      source: 'gradescope',
      status: 'login',
      loginUrl: 'https://www.gradescope.com/',
    })
    expect(resultFromError('autolab', new Error('Log in to Autolab first')).status).toBe('login')
  })

  test('anything else becomes an error result with the message', () => {
    expect(resultFromError('canvas', new CanvasHttpError(500, 'Canvas answered 500'))).toEqual({
      source: 'canvas',
      status: 'error',
      message: 'Canvas answered 500',
    })
    expect(resultFromError('autolab', 'boom')).toEqual({ source: 'autolab', status: 'error', message: 'boom' })
    expect(resultFromError('autolab', new Error(''))).toEqual({
      source: 'autolab',
      status: 'error',
      message: 'Something went wrong',
    })
  })
})

// ---------------------------------------------------------------- absolute fetchers

describe('absoluteFetcher (Canvas)', () => {
  test('requests the full URL with cookies and follows the Link header', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse('while(1);[{"id":1}]', {
        link: '<https://canvas.cmu.edu/api/v1/courses?page=2&per_page=100>; rel="next", <https://canvas.cmu.edu/api/v1/courses?page=3>; rel="last"',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const page = await absoluteFetcher('https://canvas.cmu.edu')('courses?per_page=100')
    expect(page).toEqual({ data: [{ id: 1 }], next: 'courses?page=2&per_page=100' })
    expect(fetchMock).toHaveBeenCalledWith('https://canvas.cmu.edu/api/v1/courses?per_page=100', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
  })

  test('401 means logged out', async () => {
    vi.stubGlobal('fetch', async () => fakeResponse('{}', { status: 401 }))
    await expect(absoluteFetcher('https://canvas.cmu.edu')('courses')).rejects.toBeInstanceOf(CanvasAuthError)
  })

  test('other errors keep their status', async () => {
    vi.stubGlobal('fetch', async () => fakeResponse('{}', { status: 403 }))
    await expect(absoluteFetcher('https://canvas.cmu.edu')('courses')).rejects.toMatchObject({ status: 403 })
  })
})

describe('siteUrl (requests with cookies stay on the grade site)', () => {
  test('a path on the site becomes a full URL', () => {
    expect(siteUrl('https://www.gradescope.com', '/courses/1')).toBe('https://www.gradescope.com/courses/1')
  })

  test.each(['@evil.example/x', '//evil.example/x', 'https://evil.example/', 'courses/1'])('refuses %s', (path) => {
    expect(() => siteUrl('https://www.gradescope.com', path)).toThrow('Refused to fetch')
  })

  test('the fetchers refuse before any request goes out', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(gradescopeFetchText('@evil.example/')).rejects.toThrow('Refused to fetch')
    await expect(autolabFetchPage('//evil.example/')).rejects.toThrow('Refused to fetch')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('gradescopeFetchText', () => {
  test('fetches the full URL with cookies', async () => {
    const fetchMock = vi.fn(async () => fakeResponse('<html>ok</html>', { url: 'https://www.gradescope.com/courses/1' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await gradescopeFetchText('/courses/1')).toBe('<html>ok</html>')
    expect(fetchMock).toHaveBeenCalledWith('https://www.gradescope.com/courses/1', { credentials: 'include' })
  })

  test('HTTP errors throw', async () => {
    vi.stubGlobal('fetch', async () => fakeResponse('', { status: 500 }))
    await expect(gradescopeFetchText('/')).rejects.toThrow('Gradescope returned an error (500) for /')
  })

  test('a redirect to another site means logged out', async () => {
    vi.stubGlobal('fetch', async () => fakeResponse('<html></html>', { url: 'https://login.example.edu/sso' }))
    await expect(gradescopeFetchText('/')).rejects.toThrow('Log in to Gradescope first')
  })
})

describe('autolabFetchPage', () => {
  test('returns the HTML and the final URL', async () => {
    const fetchMock = vi.fn(async () => fakeResponse('<html>list</html>', { url: 'https://autolab.andrew.cmu.edu/courses' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await autolabFetchPage('/courses')).toEqual({
      html: '<html>list</html>',
      url: 'https://autolab.andrew.cmu.edu/courses',
    })
    expect(fetchMock).toHaveBeenCalledWith('https://autolab.andrew.cmu.edu/courses', { credentials: 'include' })
  })

  test('falls back to the requested URL when the response has none', async () => {
    vi.stubGlobal('fetch', async () => fakeResponse('<html></html>'))
    expect((await autolabFetchPage('/courses')).url).toBe('https://autolab.andrew.cmu.edu/courses')
  })

  test('a redirect off Autolab means logged out', async () => {
    vi.stubGlobal('fetch', async () => fakeResponse('', { url: 'https://login.example.edu/idp' }))
    await expect(autolabFetchPage('/courses')).rejects.toThrow('Log in to Autolab first')
  })
})

// ---------------------------------------------------------------- runSource (what the offscreen page answers)

describe('runSource', () => {
  test('Canvas logged out gives a login result', async () => {
    vi.stubGlobal('fetch', async () => fakeResponse('{}', { status: 401 }))
    expect(await runSource('canvas', () => {})).toEqual({ source: 'canvas', status: 'login', loginUrl: LOGIN_URLS.canvas })
  })

  test('Canvas with no courses gives an ok result with an empty payload', async () => {
    vi.stubGlobal('fetch', async () => fakeResponse('[]'))
    const progress: string[] = []
    const result = await runSource('canvas', (m) => progress.push(m))
    expect(result).toMatchObject({ source: 'canvas', status: 'ok', payload: { v: 1, kind: 'canvas', courses: [] } })
    expect(progress).toContain('Canvas: reading your course list')
  })

  test('Autolab redirecting to its sign-in page gives a login result', async () => {
    vi.stubGlobal('fetch', async () =>
      fakeResponse('<html>sign in</html>', { url: 'https://autolab.andrew.cmu.edu/auth/users/sign_in' }),
    )
    expect((await runSource('autolab', () => {})).status).toBe('login')
  })

  test('a network failure gives an error result', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await runSource('gradescope', () => {})).toEqual({
      source: 'gradescope',
      status: 'error',
      message: 'Failed to fetch',
    })
  })
})

// ---------------------------------------------------------------- the service worker, with a minimal fake chrome

type Listener = (...args: any[]) => unknown
function fakeEvent() {
  const listeners: Listener[] = []
  return { listeners, addListener: (cb: Listener) => listeners.push(cb) }
}

const stored: Record<string, unknown> = {}
const fakeChrome = {
  runtime: {
    id: 'ext-id',
    onConnectExternal: fakeEvent(),
    onMessage: fakeEvent(),
    onInstalled: fakeEvent(),
    getManifest: () => ({ version: '1.2.3', externally_connectable: { matches: PATTERNS.slice(0, 2) } }),
    getURL: (path: string) => 'chrome-extension://ext-id/' + path,
    getContexts: vi.fn(async () => [] as unknown[]),
    getPlatformInfo: vi.fn(async () => ({})),
    sendMessage: vi.fn(async (_message: any): Promise<unknown> => undefined),
  },
  storage: {
    local: {
      get: async (key: string) => ({ [key]: stored[key] }),
      set: async (items: Record<string, unknown>) => void Object.assign(stored, items),
    },
  },
  tabs: { create: vi.fn(async (_props: { url: string }) => ({ id: 99 })) },
  action: { onClicked: fakeEvent() },
  offscreen: { createDocument: vi.fn(async () => {}), closeDocument: vi.fn(async () => {}) },
}

/** A website port as Chrome would hand it to onConnectExternal. */
function connect(origin: string, name = 'gradecrunch', tabId = 7) {
  const posted: any[] = []
  const port = {
    name,
    sender: { origin, tab: { id: tabId } },
    postMessage: (m: unknown) => posted.push(m),
    disconnect: vi.fn(),
    onMessage: fakeEvent(),
    onDisconnect: fakeEvent(),
  }
  for (const listener of fakeChrome.runtime.onConnectExternal.listeners) listener(port)
  const request = (message: unknown) => port.onMessage.listeners.forEach((l) => l(message, port))
  const done = () => vi.waitFor(() => expect(port.disconnect).toHaveBeenCalled())
  return { port, posted, request, done }
}

describe('background service worker', () => {
  beforeAll(async () => {
    vi.stubGlobal('chrome', fakeChrome)
    await import('../extension/src/background')
  })
  beforeEach(() => {
    vi.stubGlobal('chrome', fakeChrome) // the file-level afterEach unstubs globals; put chrome back
  })
  afterEach(() => {
    for (const key of Object.keys(stored)) delete stored[key]
    vi.clearAllMocks()
  })

  test('registers its listeners at load', () => {
    expect(fakeChrome.runtime.onConnectExternal.listeners).toHaveLength(1)
    expect(fakeChrome.runtime.onInstalled.listeners).toHaveLength(1)
    expect(fakeChrome.action.onClicked.listeners).toHaveLength(1)
  })

  test('drops ports from other origins or with the wrong name', () => {
    const evil = connect('https://evil.example')
    expect(evil.port.disconnect).toHaveBeenCalled()
    expect(evil.port.onMessage.listeners).toHaveLength(0)
    const wrongName = connect('https://gradecrunch.pages.dev', 'other')
    expect(wrongName.port.disconnect).toHaveBeenCalled()
  })

  test('hello answers with the version and consent, then closes the port', async () => {
    const c = connect('https://gradecrunch.pages.dev')
    c.request({ type: 'hello' })
    await c.done()
    expect(c.posted).toEqual([{ type: 'hello', version: '1.2.3', consent: false }])
  })

  test('only the first request on a port is answered', async () => {
    stored.consent = true
    const c = connect('https://gradecrunch.pages.dev')
    c.request({ type: 'hello' })
    c.request({ type: 'openWelcome' })
    await c.done()
    expect(c.posted).toEqual([{ type: 'hello', version: '1.2.3', consent: true }])
    expect(fakeChrome.tabs.create).not.toHaveBeenCalled()
  })

  test('unknown requests get an error', async () => {
    const c = connect('https://gradecrunch.pages.dev')
    c.request({ type: 'nope' })
    await c.done()
    expect(c.posted).toEqual([{ type: 'error', message: 'Unknown request' }])
  })

  test('openWelcome opens the welcome page with the website tab id', async () => {
    const c = connect('https://grades.aarushkandukoori.com', 'gradecrunch', 42)
    c.request({ type: 'openWelcome' })
    await c.done()
    expect(fakeChrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://ext-id/welcome.html?tab=42' })
    expect(c.posted[0]).toMatchObject({ type: 'hello' })
  })

  test('sync without consent is refused', async () => {
    const c = connect('https://gradecrunch.pages.dev')
    c.request({ type: 'sync', sources: ['canvas'] })
    await c.done()
    expect(c.posted).toEqual([{ type: 'error', message: 'consent' }])
    expect(fakeChrome.offscreen.createDocument).not.toHaveBeenCalled()
  })

  test('sync relays progress, returns one result per site, saves ok results and closes the offscreen page', async () => {
    stored.consent = true
    fakeChrome.runtime.sendMessage.mockImplementation(async (message: any) => {
      // Pretend to be the offscreen page: one progress line, then the answer.
      const progress = { target: 'background', type: 'progress', source: message.source, message: message.source + ' step' }
      fakeChrome.runtime.onMessage.listeners.forEach((l) => l(progress, { id: 'ext-id' }, () => {}))
      if (message.source === 'canvas') return { source: 'canvas', status: 'ok', payload: { v: 1, kind: 'canvas' } }
      return { source: 'gradescope', status: 'login', loginUrl: LOGIN_URLS.gradescope }
    })

    const c = connect('https://gradecrunch.pages.dev')
    c.request({ type: 'sync', sources: ['gradescope', 'canvas'] })
    await c.done()

    expect(fakeChrome.offscreen.createDocument).toHaveBeenCalledTimes(1)
    expect(fakeChrome.offscreen.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'offscreen.html', reasons: ['DOM_PARSER'] }),
    )
    expect(c.posted).toContainEqual({ type: 'progress', source: 'canvas', message: 'canvas step' })
    expect(c.posted).toContainEqual({ type: 'progress', source: 'gradescope', message: 'gradescope step' })
    expect(c.posted.at(-1)).toEqual({
      type: 'result',
      results: [
        { source: 'canvas', status: 'ok', payload: { v: 1, kind: 'canvas' } },
        { source: 'gradescope', status: 'login', loginUrl: LOGIN_URLS.gradescope },
      ],
    })
    expect(stored['last:canvas']).toMatchObject({ result: { status: 'ok' } })
    expect(stored['last:gradescope']).toBeUndefined() // a failed sync does not overwrite the last good copy
    await vi.waitFor(() => expect(fakeChrome.offscreen.closeDocument).toHaveBeenCalledTimes(1))
  })

  test('ignores progress messages from outside the extension', async () => {
    stored.consent = true
    fakeChrome.runtime.sendMessage.mockImplementation(async () => {
      const progress = { target: 'background', type: 'progress', source: 'autolab', message: 'fake' }
      fakeChrome.runtime.onMessage.listeners.forEach((l) => l(progress, { id: 'someone-else' }, () => {}))
      return { source: 'autolab', status: 'ok', payload: {} }
    })
    const c = connect('https://gradecrunch.pages.dev')
    c.request({ type: 'sync', sources: ['autolab'] })
    await c.done()
    expect(c.posted.filter((m) => m.type === 'progress')).toEqual([])
  })

  test('two tabs syncing the same site share one sync', async () => {
    stored.consent = true
    let finish: (value: unknown) => void = () => {}
    fakeChrome.runtime.sendMessage.mockImplementation(() => new Promise((resolve) => (finish = resolve)))

    const a = connect('https://gradecrunch.pages.dev')
    const b = connect('https://grades.aarushkandukoori.com')
    a.request({ type: 'sync', sources: ['gradescope'] })
    await vi.waitFor(() => expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledTimes(1))
    b.request({ type: 'sync', sources: ['gradescope'] })
    finish({ source: 'gradescope', status: 'ok', payload: {} })
    await a.done()
    await b.done()

    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledTimes(1)
    expect(a.posted.at(-1)).toEqual(b.posted.at(-1))
  })

  test('a broken answer from the offscreen page becomes an error result', async () => {
    stored.consent = true
    fakeChrome.runtime.sendMessage.mockImplementation(async () => undefined)
    const c = connect('https://gradecrunch.pages.dev')
    c.request({ type: 'sync', sources: ['canvas'] })
    await c.done()
    expect(c.posted.at(-1)).toEqual({
      type: 'result',
      results: [{ source: 'canvas', status: 'error', message: 'The sync page gave no answer' }],
    })
  })

  test('install opens the welcome page; the toolbar button opens the site', () => {
    fakeChrome.runtime.onInstalled.listeners[0]({ reason: 'update' })
    expect(fakeChrome.tabs.create).not.toHaveBeenCalled()
    fakeChrome.runtime.onInstalled.listeners[0]({ reason: 'install' })
    expect(fakeChrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://ext-id/welcome.html' })
    fakeChrome.action.onClicked.listeners[0]()
    expect(fakeChrome.tabs.create).toHaveBeenCalledWith({ url: 'https://grades.aarushkandukoori.com/' })
  })
})
