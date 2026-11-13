// Tests for the Chrome extension (extension/src). Only made-up data: no real courses or grades.
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { ALL_SOURCES, LOGIN_URLS } from '../extension/protocol'
import manifest from '../extension/manifest.json'
import welcomeHtml from '../extension/welcome.html?raw'
import {
  isAllowedOrigin,
  isOffscreenProgress,
  isOffscreenSyncRequest,
  isSourceResultFor,
  parseRequest,
  PDF_ORIGINS,
  resultForStorage,
  resultFromError,
} from '../extension/src/rules'
import { autolabFetchPage, gradescopeFetchText, runSource, sioFetchPage, siteUrl } from '../extension/src/sync'
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
  test('hello, openWelcome and reload', () => {
    expect(parseRequest({ type: 'hello' })).toEqual({ type: 'hello' })
    expect(parseRequest({ type: 'openWelcome', extra: 1 })).toEqual({ type: 'openWelcome' })
    expect(parseRequest({ type: 'reload' })).toEqual({ type: 'reload' }) // only the dev build acts on it
  })

  test('SIO is a site it can sync', () => {
    expect(parseRequest({ type: 'sync', sources: ['sio', 'canvas'] })).toEqual({ type: 'sync', sources: ['canvas', 'sio'] })
    expect(ALL_SOURCES).toEqual(['canvas', 'gradescope', 'autolab', 'sio'])
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

describe('SIO permission', () => {
  test('the manifest can reach SIO (s3.andrew.cmu.edu) and the login link is the Grades page', () => {
    expect(manifest.host_permissions).toContain('https://s3.andrew.cmu.edu/*')
    expect(LOGIN_URLS.sio).toBe('https://s3.andrew.cmu.edu/sio/mpa/grades/home')
  })

  test('the welcome page says what it reads on SIO', () => {
    expect(welcomeHtml).toContain('s3.andrew.cmu.edu')
    expect(welcomeHtml).toContain('mid-semester and final grades')
  })
})

describe('privacy wording', () => {
  // The site's optional AI advisor chat sends a grade summary to OpenAI, so "nothing goes to a server" would be false.
  test('the store summary fits the 132-character limit and makes no "no server" claim', () => {
    expect(manifest.description.length).toBeLessThanOrEqual(132)
    expect(manifest.description).not.toMatch(/server/i)
  })

  test('the welcome page says what the site sends to OpenAI when you use the AI advisor', () => {
    expect(welcomeHtml).toContain('OpenAI')
    expect(welcomeHtml).toContain('optional AI advisor')
    expect(welcomeHtml).not.toMatch(/\bAsk\b/) // the chat's old name
    expect(welcomeHtml).not.toContain('never sent to a server')
  })
})

describe('syllabus PDF permission', () => {
  test('the file-storage host is optional, never a required host permission', () => {
    expect(manifest.optional_host_permissions).toEqual(PDF_ORIGINS)
    expect(manifest.optional_host_permissions).toEqual(['https://*.inscloudgate.net/*'])
    expect(manifest.host_permissions).not.toContain('https://*.inscloudgate.net/*')
  })

  test('the welcome page has the checkbox, ticked by default', () => {
    const html = welcomeHtml
    expect(html).toMatch(/<input id="pdfs" type="checkbox" checked \/>/)
    expect(html).toContain('Also read syllabus PDFs from Canvas (recommended)')
  })

  test('resultForStorage drops the PDF bytes and leaves everything else', () => {
    const doc = { source: 'canvas-file', name: 'Syllabus.pdf', url: null, pdfBase64: 'JVBERg==' }
    const payload = { v: 1, kind: 'canvas', at: 'x', warnings: [], courses: [{ sourceId: '1', syllabus: [doc] }] }
    const stored = resultForStorage({ source: 'canvas', status: 'ok', payload })
    expect(stored).toEqual({
      source: 'canvas',
      status: 'ok',
      payload: { ...payload, courses: [{ sourceId: '1', syllabus: [{ source: 'canvas-file', name: 'Syllabus.pdf', url: null }] }] },
    })
    expect(doc.pdfBase64).toBe('JVBERg==') // the result sent to the website keeps them
    const login = { source: 'canvas' as const, status: 'login' as const, loginUrl: LOGIN_URLS.canvas }
    expect(resultForStorage(login)).toBe(login)
    const odd = { source: 'autolab' as const, status: 'ok' as const, payload: 'not an object' }
    expect(resultForStorage(odd)).toBe(odd)
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
    expect(resultFromError('sio', new Error('Log in to SIO first'))).toEqual({
      source: 'sio',
      status: 'login',
      loginUrl: 'https://s3.andrew.cmu.edu/sio/mpa/grades/home',
    })
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
    await expect(sioFetchPage('@evil.example/')).rejects.toThrow('Refused to fetch')
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

describe('sioFetchPage', () => {
  test('fetches the full URL with cookies and returns the HTML and the final URL', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse('<html>grades</html>', { url: 'https://s3.andrew.cmu.edu/sio/mpa/grades/home?semester=F25' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await sioFetchPage('/sio/mpa/grades/home?semester=F25')).toEqual({
      html: '<html>grades</html>',
      url: 'https://s3.andrew.cmu.edu/sio/mpa/grades/home?semester=F25',
    })
    expect(fetchMock).toHaveBeenCalledWith('https://s3.andrew.cmu.edu/sio/mpa/grades/home?semester=F25', {
      credentials: 'include',
    })
  })

  test('sent to the CMU login, or blocked on the way there, means logged out', async () => {
    vi.stubGlobal('fetch', async () => fakeResponse('<html>login</html>', { url: 'https://login.cmu.edu/idp/profile/SAML2/Redirect/SSO' }))
    await expect(sioFetchPage('/sio/mpa/grades/home')).rejects.toThrow('Log in to SIO first')
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch') // what Chrome does when the redirect leaves the extension's sites
    })
    await expect(sioFetchPage('/sio/mpa/grades/home')).rejects.toThrow('Log in to SIO first')
  })

  test('HTTP errors keep their status', async () => {
    vi.stubGlobal('fetch', async () => fakeResponse('', { status: 503, url: 'https://s3.andrew.cmu.edu/sio/mpa/grades/home' }))
    await expect(sioFetchPage('/sio/mpa/grades/home')).rejects.toThrow('SIO returned an error (503)')
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

  /** A tiny fake Canvas over fetch: one numbered course whose syllabus PDF is in Files. */
  function stubCanvasWithSyllabus() {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })
      const api = 'https://canvas.cmu.edu/api/v1/'
      if (url.startsWith(api + 'courses?')) {
        return json([{ id: 7, name: 'Made-up Course', course_code: '99101', term: { name: 'Fall 2026' }, enrollments: [{ type: 'student' }] }])
      }
      if (url.startsWith(api + 'courses/7/assignment_groups')) return json([])
      if (url === api + 'courses/7?include[]=syllabus_body') return json({ syllabus_body: '<p>Final Exam: 30%</p>' })
      if (url === api + 'courses/7/files?search_term=syllabus&per_page=20') {
        return json([{ id: 3, display_name: 'Syllabus.pdf', 'content-type': 'application/pdf', size: 20, url: 'https://canvas.cmu.edu/files/3/download?verifier=q' }])
      }
      if (url === 'https://canvas.cmu.edu/files/3/download?verifier=q') return new Response('%PDF-1.4 made up', { status: 200 })
      return new Response('{}', { status: 404 })
    })
    return urls
  }

  test('Canvas reads syllabi; PDFs only when the permission was granted', async () => {
    const urls = stubCanvasWithSyllabus()
    const withPdfs = await runSource('canvas', () => {}, { pdfs: true })
    expect(withPdfs.status).toBe('ok')
    const course = (withPdfs as { payload: { courses: { syllabus?: { source: string; text?: string; pdfBase64?: string }[] }[] } }).payload.courses[0]
    expect(course.syllabus?.map((d) => d.source)).toEqual(['canvas-syllabus', 'canvas-file'])
    expect(course.syllabus?.[0].text).toBe('Final Exam: 30%')
    expect(atob(course.syllabus?.[1].pdfBase64 ?? '')).toBe('%PDF-1.4 made up')
    expect(urls).toContain('https://canvas.cmu.edu/files/3/download?verifier=q')

    urls.length = 0
    const noPdfs = await runSource('canvas', () => {}) // permission missing: same sync, no file requests
    const plain = (noPdfs as { payload: { courses: { syllabus?: { source: string }[] }[] } }).payload.courses[0]
    expect(plain.syllabus?.map((d) => d.source)).toEqual(['canvas-syllabus'])
    expect(urls.some((u) => u.includes('/files'))).toBe(false)
  })

  test('Autolab redirecting to its sign-in page gives a login result', async () => {
    vi.stubGlobal('fetch', async () =>
      fakeResponse('<html>sign in</html>', { url: 'https://autolab.andrew.cmu.edu/auth/users/sign_in' }),
    )
    expect((await runSource('autolab', () => {})).status).toBe('login')
  })

  test('SIO: reads the Grades page and every other semester; logged out gives a login result', async () => {
    const page = (code: string, label: string) =>
      `<select id="grades-semester-code-select"><optgroup label="UNDERGRADUATE">` +
      `<option value="F26"${code === 'F26' ? ' selected' : ''}>Fall 2026</option>` +
      `<option value="S26"${code === 'S26' ? ' selected' : ''}>Spring 2026</option></optgroup></select>` +
      `<h2 class="page-title">Grades for ${label}</h2>` +
      `<table id="semester-grades-table"><tr class="header-row"><th>COURSE</th><th>NUMBER</th><th>UNITS</th><th>FINAL</th></tr>` +
      `<tr><td>Made-up Course</td><td>99-101 A</td><td>9.0</td><td>${code === 'S26' ? 'A' : 'NA'}</td></tr></table>`
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      const code = url.includes('semester=F26') ? 'F26' : 'S26' // the plain page shows the last finished semester
      return fakeResponse(page(code, code === 'F26' ? 'Fall 2026' : 'Spring 2026'), { url })
    })
    const result = await runSource('sio', () => {})
    expect(result).toMatchObject({ source: 'sio', status: 'ok', payload: { kind: 'sio', courses: [] } })
    const semesters = (result as { payload: { semesters: { code: string }[] } }).payload.semesters
    expect(semesters.map((s) => s.code)).toEqual(['F26', 'S26'])
    expect(urls).toEqual([
      'https://s3.andrew.cmu.edu/sio/mpa/grades/home',
      'https://s3.andrew.cmu.edu/sio/mpa/grades/home?semester=F26',
    ])

    vi.stubGlobal('fetch', async () => fakeResponse('<html>Web Login</html>', { url: 'https://login.cmu.edu/idp/profile/SAML2/Redirect/SSO' }))
    expect(await runSource('sio', () => {})).toEqual({ source: 'sio', status: 'login', loginUrl: LOGIN_URLS.sio })
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
    reload: vi.fn(),
  },
  storage: {
    local: {
      get: async (key: string) => ({ [key]: stored[key] }),
      set: async (items: Record<string, unknown>) => void Object.assign(stored, items),
    },
  },
  tabs: { create: vi.fn(async (_props: { url: string }) => ({ id: 99 })) },
  permissions: { contains: vi.fn(async (_p: { origins?: string[] }) => false) },
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

  test('hello answers with the version, consent and the sites it can sync, then closes the port', async () => {
    const c = connect('https://gradecrunch.pages.dev')
    c.request({ type: 'hello' })
    await c.done()
    expect(c.posted).toEqual([{ type: 'hello', version: '1.2.3', consent: false, sources: ['canvas', 'gradescope', 'autolab', 'sio'] }])
  })

  test('only the first request on a port is answered', async () => {
    stored.consent = true
    const c = connect('https://gradecrunch.pages.dev')
    c.request({ type: 'hello' })
    c.request({ type: 'openWelcome' })
    await c.done()
    expect(c.posted).toEqual([{ type: 'hello', version: '1.2.3', consent: true, sources: ALL_SOURCES }])
    expect(fakeChrome.tabs.create).not.toHaveBeenCalled()
  })

  test('reload is refused unless the build switched it on (the store build)', async () => {
    const c = connect('https://gradecrunch.pages.dev')
    c.request({ type: 'reload' })
    await c.done()
    expect(c.posted).toEqual([{ type: 'error', message: 'Unknown request' }])
    await new Promise((r) => setTimeout(r, 150))
    expect(fakeChrome.runtime.reload).not.toHaveBeenCalled()
  })

  test('the dev build answers reload with hello, then reloads itself', async () => {
    // scripts/build-extension.mjs replaces __DEV_BUILD__ with true in dist-extension/ and false in the store build.
    const g = globalThis as { __DEV_BUILD__?: boolean }
    g.__DEV_BUILD__ = true
    try {
      const c = connect('https://gradecrunch.pages.dev')
      c.request({ type: 'reload' })
      await c.done()
      expect(c.posted).toEqual([{ type: 'hello', version: '1.2.3', consent: false, sources: ALL_SOURCES }])
      await vi.waitFor(() => expect(fakeChrome.runtime.reload).toHaveBeenCalledOnce())
    } finally {
      delete g.__DEV_BUILD__
    }
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

  test('tells the offscreen page whether it may read syllabus PDFs; the saved copy has no PDF bytes', async () => {
    stored.consent = true
    fakeChrome.permissions.contains.mockResolvedValueOnce(true)
    const doc = { source: 'canvas-file', name: 'Syllabus.pdf', url: null, pdfBase64: 'JVBERg==' }
    const payload = { v: 1, kind: 'canvas', courses: [{ sourceId: '1', syllabus: [doc] }] }
    fakeChrome.runtime.sendMessage.mockImplementation(async (message: any) => {
      if (message.source === 'canvas') return { source: 'canvas', status: 'ok', payload }
      return { source: message.source, status: 'ok', payload: { v: 1, courses: [] } }
    })
    const c = connect('https://gradecrunch.pages.dev')
    c.request({ type: 'sync', sources: ['canvas', 'gradescope'] })
    await c.done()

    expect(fakeChrome.permissions.contains).toHaveBeenCalledWith({ origins: ['https://*.inscloudgate.net/*'] })
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith({ target: 'offscreen', type: 'sync', source: 'canvas', pdfs: true })
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith({ target: 'offscreen', type: 'sync', source: 'gradescope', pdfs: false })
    expect(c.posted.at(-1).results[0].payload.courses[0].syllabus[0].pdfBase64).toBe('JVBERg==') // the website gets them
    expect((stored['last:canvas'] as any).result.payload.courses[0].syllabus[0]).toEqual({
      source: 'canvas-file',
      name: 'Syllabus.pdf',
      url: null,
    })
  })

  test('without the permission (or if checking fails) PDFs are off', async () => {
    stored.consent = true
    fakeChrome.permissions.contains.mockRejectedValueOnce(new Error('no permissions API'))
    fakeChrome.runtime.sendMessage.mockImplementation(async () => ({ source: 'canvas', status: 'ok', payload: {} }))
    const c = connect('https://gradecrunch.pages.dev')
    c.request({ type: 'sync', sources: ['canvas'] })
    await c.done()
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith({ target: 'offscreen', type: 'sync', source: 'canvas', pdfs: false })
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

// ---------------------------------------------------------------- the welcome page

describe('welcome page', () => {
  const order: string[] = [] // which chrome calls happened, in order
  let granted = false
  const welcomeChrome = {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => void order.push('consent')),
      },
    },
    permissions: {
      request: vi.fn(async () => {
        order.push('request')
        granted = true
        return true
      }),
      remove: vi.fn(async () => {
        order.push('remove')
        granted = false
        return true
      }),
      contains: vi.fn(async () => granted),
    },
    tabs: { update: vi.fn(async () => undefined), getCurrent: vi.fn(async () => ({ id: 5 })), remove: vi.fn(async () => {}) },
  }

  beforeAll(async () => {
    document.body.innerHTML =
      '<input id="pdfs" type="checkbox" checked /><button id="continue" type="button">Continue</button><p id="status"></p>'
    window.history.replaceState(null, '', '/welcome.html?tab=12')
    vi.stubGlobal('chrome', welcomeChrome)
    await import('../extension/src/welcome')
  })
  beforeEach(() => {
    vi.stubGlobal('chrome', welcomeChrome)
    order.length = 0
    ;(document.getElementById('continue') as HTMLButtonElement).disabled = false
  })

  test('Continue asks for the PDF permission during the click, before anything else', async () => {
    const button = document.getElementById('continue') as HTMLButtonElement
    button.click()
    // Called synchronously inside the click handler: Chrome only shows the prompt during a user gesture.
    expect(welcomeChrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://*.inscloudgate.net/*'] })
    await vi.waitFor(() => expect(welcomeChrome.tabs.update).toHaveBeenCalledWith(12, { active: true }))
    expect(order).toEqual(['request', 'consent'])
  })

  test('unticking the box removes the permission and still saves consent', async () => {
    welcomeChrome.tabs.update.mockClear()
    ;(document.getElementById('pdfs') as HTMLInputElement).checked = false
    ;(document.getElementById('continue') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(welcomeChrome.tabs.update).toHaveBeenCalled())
    expect(order).toEqual(['remove', 'consent'])
  })

  test('consent is saved while Chrome\'s prompt is still open, and the page waits for the answer', async () => {
    welcomeChrome.tabs.update.mockClear()
    let answer: (v: boolean) => void = () => {}
    welcomeChrome.permissions.request.mockImplementationOnce(() => {
      order.push('request')
      return new Promise<boolean>((resolve) => (answer = resolve))
    })
    ;(document.getElementById('pdfs') as HTMLInputElement).checked = true
    ;(document.getElementById('continue') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(order).toEqual(['request', 'consent']))
    expect(welcomeChrome.tabs.update).not.toHaveBeenCalled() // still on the welcome page while the prompt is open
    answer(true)
    await vi.waitFor(() => expect(welcomeChrome.tabs.update).toHaveBeenCalledWith(12, { active: true }))
  })

  test('saying no in Chrome\'s prompt still finishes the welcome page', async () => {
    welcomeChrome.tabs.update.mockClear()
    welcomeChrome.permissions.request.mockRejectedValueOnce(new Error('denied'))
    ;(document.getElementById('pdfs') as HTMLInputElement).checked = true
    ;(document.getElementById('continue') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(welcomeChrome.tabs.update).toHaveBeenCalled())
    expect(order).toEqual(['consent'])
  })
})
