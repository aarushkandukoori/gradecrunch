// Tests for the Sync bookmarklet: the app-side helpers (src/lib/bookmarklet.ts), the run logic
// (bookmarklet/run.ts, with fake syncs) and the generated bundle (src/generated/bookmarklet.ts).
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SyncPayload } from '../src/types'
import { APP_NAME } from '../src/lib/brand'
import {
  BOOKMARKLET_VERSION,
  bookmarkletHref,
  isGradeSiteOrigin,
  parseSyncFragment,
  type IncomingMessage,
} from '../src/lib/bookmarklet'
import { decodePayload } from '../src/lib/payload'
import { BOOKMARKLET_BUILT_VERSION, BOOKMARKLET_CODE } from '../src/generated/bookmarklet'
import { detectSite, runSync, syncUrl, type ReceiverTab, type RunDeps } from '../bookmarklet/run'

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
    openReceiver: () => null, // popup blocked unless a test says otherwise: the fragment fallback
    listen: () => () => {},
    navigate: (url) => navigated.push(url),
    alert: (msg) => alerts.push(msg),
    timeoutMs: 30,
    closeDelayMs: 30,
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

// ---------------------------------------------------------------- postMessage handoff (bookmarklet side)

const SITE = 'https://example.pages.dev'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A fake message bus standing in for window 'message' events. */
function fakeBus() {
  const handlers: ((e: IncomingMessage) => void)[] = []
  return {
    handlers,
    listen: (h: (e: IncomingMessage) => void) => {
      handlers.push(h)
      return () => handlers.splice(handlers.indexOf(h), 1)
    },
    emit: (e: IncomingMessage) => [...handlers].forEach((h) => h(e)),
  }
}

/**
 * A fake GradeCrunch tab. It says "ready" shortly after opening (unless told not to) and answers a sync
 * message with `answer` (null = never answers).
 */
class FakeTab implements ReceiverTab {
  closed = false
  focused = 0
  posted: { message: unknown; targetOrigin: string }[] = []
  constructor(
    private bus: ReturnType<typeof fakeBus>,
    private answer: { ok: boolean; message?: string } | null = { ok: true },
  ) {}
  sayReady(origin = SITE, source: unknown = this) {
    this.bus.emit({ source, origin, data: { type: 'gradecrunch:ready' } })
  }
  postMessage(message: unknown, targetOrigin: string) {
    this.posted.push({ message, targetOrigin })
    const answer = this.answer
    if (answer) setTimeout(() => this.bus.emit({ source: this, origin: SITE, data: { type: 'gradecrunch:done', ...answer } }), 0)
  }
  focus() {
    this.focused++
  }
  close() {
    this.closed = true
  }
}

/** Deps with a receiver tab that opens fine. `onOpen` runs right after the tab is "opened". */
function handoffDeps(tab: FakeTab, bus: ReturnType<typeof fakeBus>, onOpen: () => void = () => setTimeout(() => tab.sayReady(), 0)) {
  const order: string[] = []
  const deps = fakeDeps({
    siteOrigin: SITE,
    openReceiver: (url) => {
      order.push('open ' + url)
      onOpen()
      return tab
    },
    listen: bus.listen,
    syncGradescope: async () => {
      order.push('sync')
      return payload
    },
  })
  return { deps, order }
}

describe('runSync handoff to the GradeCrunch tab', () => {
  test('happy path: opens the tab first, posts the grades to the exact origin, shows Done', async () => {
    const bus = fakeBus()
    const tab = new FakeTab(bus)
    const { deps, order } = handoffDeps(tab, bus)
    await runSync(deps)

    expect(order).toEqual([`open ${SITE}/#receive`, 'sync']) // opened before any await (user gesture)
    expect(tab.posted).toHaveLength(1)
    expect(tab.posted[0].targetOrigin).toBe(SITE) // never '*'
    const msg = tab.posted[0].message as { type: string; payload: string; bv: number }
    expect(msg.type).toBe('gradecrunch:sync')
    expect(msg.bv).toBe(BOOKMARKLET_VERSION)
    expect(await decodePayload(msg.payload)).toEqual(payload)

    expect(deps.navigated).toEqual([]) // no #sync URL in this tab's history
    expect(overlay()?.textContent).toContain(`Done. Your grades are in the ${APP_NAME} tab.`)
    expect(tab.focused).toBe(1)
    expect(tab.closed).toBe(false)
    expect(bus.handlers).toHaveLength(0) // stopped listening
    expect((window as GuardedWindow).__gradeSyncRunning).toBe(false)
    await sleep(50) // closeDelayMs is 30 in the fake deps
    expect(overlay()).toBeNull()
  })

  test('a "ready" that arrived during the sync is remembered', async () => {
    const bus = fakeBus()
    const tab = new FakeTab(bus)
    let finish: (p: SyncPayload) => void = () => {}
    const { deps } = handoffDeps(tab, bus, () => {})
    deps.syncGradescope = () => new Promise((resolve) => (finish = resolve))
    const running = runSync(deps)
    tab.sayReady() // the tab loads while we are still reading grades
    finish(payload)
    await running
    expect(tab.posted).toHaveLength(1)
    expect(deps.navigated).toEqual([])
  })

  test('popup blocked: falls back to the #sync fragment in this tab', async () => {
    const listen = vi.fn(() => () => {})
    const deps = fakeDeps({ siteOrigin: SITE, openReceiver: () => null, listen })
    await runSync(deps)
    expect(listen).not.toHaveBeenCalled()
    expect(deps.navigated).toHaveLength(1)
    const frag = parseSyncFragment(new URL(deps.navigated[0]).hash)
    expect(await decodePayload(frag!.payload)).toEqual(payload)
  })

  test('the tab never says ready: closes it and falls back to the fragment', async () => {
    const bus = fakeBus()
    const tab = new FakeTab(bus)
    const { deps } = handoffDeps(tab, bus, () => {})
    await runSync(deps)
    expect(tab.posted).toEqual([])
    expect(tab.closed).toBe(true)
    expect(bus.handlers).toHaveLength(0)
    expect(deps.navigated).toHaveLength(1)
    expect(deps.navigated[0].startsWith(`${SITE}/#sync=`)).toBe(true)
  })

  test('the tab was closed by the student: falls back without waiting', async () => {
    const bus = fakeBus()
    const tab = new FakeTab(bus)
    const { deps } = handoffDeps(tab, bus, () => {})
    deps.syncGradescope = async () => {
      tab.closed = true
      return payload
    }
    await runSync(deps)
    expect(tab.posted).toEqual([])
    expect(deps.navigated).toHaveLength(1)
  })

  test('messages from another origin or another window are ignored', async () => {
    const bus = fakeBus()
    const tab = new FakeTab(bus)
    const other = {}
    const { deps } = handoffDeps(tab, bus, () =>
      setTimeout(() => {
        tab.sayReady('https://evil.example') // right window, wrong origin
        tab.sayReady(SITE, other) // right origin, wrong window
      }, 0),
    )
    await runSync(deps)
    expect(tab.posted).toEqual([]) // never counted as ready
    expect(deps.navigated).toHaveLength(1) // so it fell back
  })

  test('a forged "done" from another window does not count', async () => {
    const bus = fakeBus()
    const tab = new FakeTab(bus, null) // the real tab never answers
    const { deps } = handoffDeps(tab, bus)
    const running = runSync(deps)
    await sleep(5)
    bus.emit({ source: {}, origin: SITE, data: { type: 'gradecrunch:done', ok: true } })
    await running
    expect(overlay()?.textContent).toContain('did not answer')
  })

  test('the tab reports an error: shows it, no fallback navigation', async () => {
    const bus = fakeBus()
    const tab = new FakeTab(bus, { ok: false, message: 'That sync data looks broken.' })
    const { deps } = handoffDeps(tab, bus)
    await runSync(deps)
    expect(deps.navigated).toEqual([])
    expect(overlay()?.textContent).toContain(`${APP_NAME}: sync failed`)
    expect(overlay()?.textContent).toContain('That sync data looks broken.')
    expect(overlay()!.querySelector('button')!.textContent).toBe('Close')
    expect((window as GuardedWindow).__gradeSyncRunning).toBe(false)
  })

  test('Cancel closes the GradeCrunch tab and posts nothing', async () => {
    const bus = fakeBus()
    const tab = new FakeTab(bus)
    let finish: (p: SyncPayload) => void = () => {}
    const { deps } = handoffDeps(tab, bus)
    deps.syncGradescope = () => new Promise((resolve) => (finish = resolve))
    const running = runSync(deps)
    overlay()!.querySelector('button')!.click()
    finish(payload)
    await running
    expect(tab.closed).toBe(true)
    expect(tab.posted).toEqual([])
    expect(deps.navigated).toEqual([])
    expect(bus.handlers).toHaveLength(0)
  })

  test('a failed sync closes the unused GradeCrunch tab', async () => {
    const bus = fakeBus()
    const tab = new FakeTab(bus)
    const { deps } = handoffDeps(tab, bus)
    deps.syncGradescope = async () => {
      throw new Error('Log in to Gradescope first')
    }
    await runSync(deps)
    expect(tab.closed).toBe(true)
    expect(overlay()?.textContent).toContain('Log in to Gradescope first')
  })
})

describe('double-click guard and Back navigation', () => {
  test('the guard is cleared before navigating, and a cache restore removes the stale overlay', async () => {
    const sync = vi.fn(async () => payload)
    const deps = fakeDeps({ syncGradescope: sync })
    await runSync(deps)
    expect(deps.navigated).toHaveLength(1)
    expect((window as GuardedWindow).__gradeSyncRunning).toBe(false)
    expect(overlay()).not.toBeNull() // "Opening GradeCrunch..." while the new page loads

    window.dispatchEvent(new Event('pageshow')) // the student pressed Back and the page came from the cache
    expect(overlay()).toBeNull()

    await runSync(deps) // clicking the bookmark again works
    expect(sync).toHaveBeenCalledTimes(2)
    expect(deps.navigated).toHaveLength(2)
  })
})

// ---------------------------------------------------------------- postMessage handoff (app side)

describe('isGradeSiteOrigin', () => {
  test('accepts only https origins of the grade sites', () => {
    expect(isGradeSiteOrigin('https://canvas.cmu.edu')).toBe(true)
    expect(isGradeSiteOrigin('https://cmu.instructure.com')).toBe(true)
    expect(isGradeSiteOrigin('https://www.gradescope.com')).toBe(true)
    expect(isGradeSiteOrigin('https://autolab.andrew.cmu.edu')).toBe(true)
    expect(isGradeSiteOrigin('http://canvas.cmu.edu')).toBe(false)
    expect(isGradeSiteOrigin('https://canvas.cmu.edu.evil.example')).toBe(false)
    expect(isGradeSiteOrigin('https://canvas.cmu.edu/path')).toBe(false)
    expect(isGradeSiteOrigin('null')).toBe(false)
    expect(isGradeSiteOrigin('')).toBe(false)
  })
})

