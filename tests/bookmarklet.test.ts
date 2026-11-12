// Tests for the Sync bookmarklet: the app-side helpers (src/lib/bookmarklet.ts), the run logic
// (bookmarklet/run.ts, with fake syncs) and the generated bundle (src/generated/bookmarklet.ts).
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SyncPayload } from '../src/types'
import { APP_NAME } from '../src/lib/brand'
import { BOOKMARKLET_VERSION, bookmarkletHref, parseSyncFragment } from '../src/lib/bookmarklet'
import { decodePayload } from '../src/lib/payload'
import { BOOKMARKLET_BUILT_VERSION, BOOKMARKLET_CODE } from '../src/generated/bookmarklet'
import { detectSite, runSync, syncUrl, type RunDeps } from '../bookmarklet/run'

type GuardedWindow = Window & { __gradeSyncRunning?: boolean }

const payload: SyncPayload = {
  v: 1,
  kind: 'gradescope',
  at: '2026-11-12T15:00:00.000Z',
  warnings: [],
  courses: [
    {
      source: 'gradescope',
      sourceId: '1000001',
      number: '21241',
      alsoNumbers: [],
      title: 'Matrices',
      term: 'Fall 2026',
      url: 'https://www.gradescope.com/courses/1000001',
      weighted: false,
      categories: [],
      items: [],
      canvasScore: null,
      canvasGrade: null,
      scheme: null,
      syncedAt: '2026-11-12T15:00:00.000Z',
    },
  ],
}

function fakeDeps(overrides: Partial<RunDeps> = {}): RunDeps & { navigated: string[]; alerts: string[] } {
  const navigated: string[] = []
  const alerts: string[] = []
  return {
    hostname: 'www.gradescope.com',
    siteOrigin: 'https://example.pages.dev',
    syncCanvas: async () => ({ ...payload, kind: 'canvas', courses: [] }),
    syncGradescope: async (progress) => {
      progress('Gradescope: 1 of 1 courses')
      return payload
    },
    syncAutolab: async () => ({ ...payload, kind: 'autolab', courses: [] }),
    navigate: (url) => navigated.push(url),
    alert: (msg) => alerts.push(msg),
    navigated,
    alerts,
    ...overrides,
  }
}

function overlay(): HTMLElement | null {
  return document.querySelector('[data-grade-sync]')
}

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as GuardedWindow).__gradeSyncRunning
  vi.restoreAllMocks()
})

describe('parseSyncFragment', () => {
  test('reads payload and version', () => {
    expect(parseSyncFragment('#sync=zAbC-_9&bv=3')).toEqual({ payload: 'zAbC-_9', version: 3 })
  })
  test('works without "#" and without a version', () => {
    expect(parseSyncFragment('sync=jXYZ')).toEqual({ payload: 'jXYZ', version: null })
  })
  test('ignores unknown params and a non-numeric version', () => {
    expect(parseSyncFragment('#sync=zA&foo=1&bv=abc')).toEqual({ payload: 'zA', version: null })
  })
  test('returns null for anything that is not a sync link', () => {
    for (const h of ['', '#', '#settings', '#sync=', '#sync=&bv=1', '#xsync=zA', '#bv=1&sync=zA']) {
      expect(parseSyncFragment(h)).toBeNull()
    }
  })
})

describe('bookmarkletHref', () => {
  test('is a javascript: URL with our origin swapped in and no raw special characters', () => {
    const href = bookmarkletHref('https://example.pages.dev')
    expect(href.startsWith('javascript:')).toBe(true)
    const code = decodeURIComponent(href.slice('javascript:'.length))
    expect(code).toContain('"https://example.pages.dev"')
    expect(code).not.toContain('__SITE_ORIGIN__')
    // Only characters encodeURIComponent leaves alone, plus %XX escapes (no spaces, quotes or #).
    expect(href.slice('javascript:'.length)).toMatch(/^([A-Za-z0-9\-_.!~*'()]|%[0-9A-F]{2})*$/)
  })
})

describe('generated bundle', () => {
  test('exists, is small, and has the placeholder exactly once', () => {
    expect(BOOKMARKLET_CODE.length).toBeGreaterThan(100)
    expect(new TextEncoder().encode(BOOKMARKLET_CODE).length).toBeLessThanOrEqual(60 * 1024)
    expect(BOOKMARKLET_CODE.split('__SITE_ORIGIN__').length - 1).toBe(1)
    expect(BOOKMARKLET_CODE).toContain('"__SITE_ORIGIN__"') // as a complete string literal
  })
  test('was built from the current version number', () => {
    expect(BOOKMARKLET_BUILT_VERSION).toBe(BOOKMARKLET_VERSION)
  })
  test('running it on a non-Canvas site only shows the alert', () => {
    // jsdom's page is on localhost, so the real bundle should refuse to sync.
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const result = new Function(BOOKMARKLET_CODE)()
    expect(result).toBeUndefined() // a javascript: URL that returns a value would replace the page
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('open canvas.cmu.edu, gradescope.com or autolab.andrew.cmu.edu'))
    expect(overlay()).toBeNull()
  })
})

describe('detectSite / syncUrl', () => {
  test('recognizes Canvas and Gradescope hosts only', () => {
    expect(detectSite('canvas.cmu.edu')).toBe('canvas')
    expect(detectSite('CMU.instructure.com')).toBe('canvas')
    expect(detectSite('www.gradescope.com')).toBe('gradescope')
    expect(detectSite('gradescope.com')).toBe('gradescope')
    expect(detectSite('autolab.andrew.cmu.edu')).toBe('autolab')
    expect(detectSite('autolab.andrew.cmu.edu.evil.example')).toBeNull()
    expect(detectSite('canvas.cmu.edu.evil.example')).toBeNull()
    expect(detectSite('example.com')).toBeNull()
  })
  test('puts the payload in the fragment with the bookmarklet version', () => {
    expect(syncUrl('https://x.pages.dev', 'zAAA')).toBe(`https://x.pages.dev/#sync=zAAA&bv=${BOOKMARKLET_VERSION}`)
  })
})

describe('runSync', () => {
  test('on an unsupported site: alerts, no overlay, no navigation', async () => {
    const deps = fakeDeps({ hostname: 'example.com' })
    await runSync(deps)
    expect(deps.alerts).toEqual([`${APP_NAME}: open canvas.cmu.edu, gradescope.com or autolab.andrew.cmu.edu, log in, then click this bookmark again.`])
    expect(deps.navigated).toEqual([])
    expect(overlay()).toBeNull()
  })

  test('on Gradescope: syncs and navigates to our site with a decodable fragment', async () => {
    const deps = fakeDeps()
    await runSync(deps)
    expect(deps.navigated).toHaveLength(1)
    const url = new URL(deps.navigated[0])
    expect(url.origin).toBe('https://example.pages.dev')
    expect(url.search).toBe('') // nothing in the query string, which would reach the server
    const frag = parseSyncFragment(url.hash)
    expect(frag?.version).toBe(BOOKMARKLET_VERSION)
    expect(await decodePayload(frag!.payload)).toEqual(payload)
  })

  test('on Canvas: uses the Canvas sync', async () => {
    const canvas = vi.fn(async () => ({ ...payload, kind: 'canvas' as const, courses: [] }))
    const gradescope = vi.fn(async () => payload)
    const deps = fakeDeps({ hostname: 'canvas.cmu.edu', syncCanvas: canvas, syncGradescope: gradescope })
    await runSync(deps)
    expect(canvas).toHaveBeenCalledOnce()
    expect(gradescope).not.toHaveBeenCalled()
    expect(deps.navigated).toHaveLength(1)
  })

  test('shows progress in the overlay while syncing', async () => {
    let finish: (p: SyncPayload) => void = () => {}
    const deps = fakeDeps({
      syncGradescope: (progress) => {
        progress('Gradescope: 2 of 5 courses')
        return new Promise((resolve) => (finish = resolve))
      },
    })
    const running = runSync(deps)
    expect(overlay()?.textContent).toContain(`${APP_NAME}: syncing...`)
    expect(overlay()?.textContent).toContain('Gradescope: 2 of 5 courses')
    expect(overlay()?.style.zIndex).toBe('2147483647')
    finish(payload)
    await running
    expect(deps.navigated).toHaveLength(1)
  })

  test('on error: shows the message with a Close button and never navigates', async () => {
    const deps = fakeDeps({
      syncGradescope: async () => {
        throw new Error('Log in to Gradescope first')
      },
    })
    await runSync(deps)
    expect(deps.navigated).toEqual([])
    expect(overlay()?.textContent).toContain('Log in to Gradescope first')
    const button = overlay()!.querySelector('button')!
    expect(button.textContent).toBe('Close')
    button.click()
    expect(overlay()).toBeNull()
    expect((window as GuardedWindow).__gradeSyncRunning).toBe(false) // can try again
  })

  test('error text is shown as text, not HTML', async () => {
    const deps = fakeDeps({
      syncGradescope: async () => {
        throw new Error('<img src=x onerror=alert(1)>')
      },
    })
    await runSync(deps)
    expect(overlay()!.querySelector('img')).toBeNull()
    expect(overlay()!.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  test('Cancel removes the overlay and stops the navigation', async () => {
    let finish: (p: SyncPayload) => void = () => {}
    const deps = fakeDeps({ syncGradescope: () => new Promise((resolve) => (finish = resolve)) })
    const running = runSync(deps)
    overlay()!.querySelector('button')!.click()
    expect(overlay()).toBeNull()
    finish(payload)
    await running
    expect(deps.navigated).toEqual([])
  })

  test('a second click while running does nothing', async () => {
    let finish: (p: SyncPayload) => void = () => {}
    const sync = vi.fn(() => new Promise<SyncPayload>((resolve) => (finish = resolve)))
    const deps = fakeDeps({ syncGradescope: sync })
    const first = runSync(deps)
    await runSync(deps)
    expect(sync).toHaveBeenCalledOnce()
    expect(document.querySelectorAll('[data-grade-sync]')).toHaveLength(1)
    finish(payload)
    await first
  })
})
