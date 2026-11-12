// The whole app. It owns the saved store, turns it into courses + grades + QPA, picks which page to show
// (home / setup / privacy, mirrored in the URL), and handles syncing: the Sync bookmarklet opens this site at
// /#receive and hands the grades over by postMessage (see ui/receive.ts), or, when a popup blocker gets in the
// way, sends them in a #sync= link that we read once on load. Every sync can be undone from its toast.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildClaudePrompt } from './lib/askClaude'
import { catalogReady, loadCatalog } from './lib/catalog'
import { demoPayloads } from './lib/demo'
import { BOOKMARKLET_VERSION, parseSyncFragment, RECEIVE_HASH } from './lib/bookmarklet'
import { plural } from './lib/format'
import { gradeCourse, neededForLetters } from './lib/grade'
import { buildCourses, rekeyPrefs, termsOf } from './lib/merge'
import { decodePayload } from './lib/payload'
import { computeQpa } from './lib/qpa'
import {
  addManualCourse,
  applyPayload,
  applyTheme,
  clearAll,
  clearDemo,
  getTheme,
  loadDemo,
  loadStore,
  removeManualCourse,
  saveStore,
  setTheme,
  STORE_KEY,
  updatePrefs,
  updateSettings,
  type Theme,
} from './lib/store'
import type { Course, CoursePrefs, ManualCourse, NeededResult, Settings, Store, SyncPayload } from './types'
import { ClaudeDialog } from './ui/ClaudeDialog'
import { Dashboard } from './ui/Dashboard'
import { Footer } from './ui/Footer'
import { Header } from './ui/Header'
import { VIEW_PATHS, viewFromPath, type View } from './ui/Link'
import { PrivacyPage } from './ui/PrivacyPage'
import { SettingsDialog } from './ui/SettingsDialog'
import { Toasts, useToasts } from './ui/Toasts'
import { Welcome } from './ui/Welcome'
import { browserReceiverDeps, startReceiver, syncLinkIsStale } from './ui/receive'
import { neededFor, pickTerm, splitCourses, termsWithGrades } from './ui/view'

const CLAUDE_URL = 'https://claude.ai/new'
const SOURCE_NAMES: Record<SyncPayload['kind'], string> = { canvas: 'Canvas', gradescope: 'Gradescope', autolab: 'Autolab' }

export default function App() {
  const [store, setStore] = useState<Store>(loadStore)
  const [view, setView] = useState<View>(() => viewFromPath(window.location.pathname))
  const [theme, setThemeState] = useState<Theme>(getTheme)
  const [now, setNow] = useState(() => Date.now())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [claudeText, setClaudeText] = useState<string | null>(null)
  const { toasts, push: toast, dismiss } = useToasts()
  // The course catalog (titles + units) loads in the background; bump this when it arrives to recompute.
  const [catalogLoaded, setCatalogLoaded] = useState(catalogReady)
  const startedRef = useRef(false)

  // ------------------------------------------------------------ persistence, clock, routing

  // Saving and other tabs. Every change here is saved to localStorage. If another GradeCrunch tab saves (a sync
  // usually opens a new tab), this tab must load that copy first: saving its own old copy on the next click
  // would silently throw the new sync away.
  const lastSavedRaw = useRef<string | null>(null) // the localStorage text this tab last wrote or loaded
  const skipNextSave = useRef(false) // the store just came from another tab: no need to write it back

  useEffect(() => {
    if (skipNextSave.current) {
      skipNextSave.current = false
      return
    }
    saveStore(store)
    lastSavedRaw.current = readSavedRaw()
  }, [store])

  useEffect(() => {
    function reloadIfChanged() {
      const raw = readSavedRaw()
      if (raw === lastSavedRaw.current) return // nothing new
      lastSavedRaw.current = raw
      skipNextSave.current = true
      setStore(loadStore())
    }
    // 'storage' fires in every other tab when one tab writes. Focus / visibility are a backup check for browsers
    // that delay the event while a tab is in the background.
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORE_KEY || e.key === null) reloadIfChanged() // null = storage cleared ("Delete everything")
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') reloadIfChanged()
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', reloadIfChanged)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', reloadIfChanged)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  useEffect(() => {
    if (catalogLoaded) return
    loadCatalog()
      .then(() => setCatalogLoaded(true))
      .catch(() => toast("Couldn't load the CMU course list, so units show as 9. Reload to try again.", { tone: 'error' }))
  }, [catalogLoaded, toast])

  // Re-render once a minute so "5 min ago" stays true.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const onPop = () => setView(viewFromPath(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((next: View) => {
    if (window.location.pathname !== VIEW_PATHS[next]) window.history.pushState(null, '', VIEW_PATHS[next])
    setView(next)
    window.scrollTo(0, 0)
  }, [])

  // ------------------------------------------------------------ derived data (recomputed only when the store changes)

  // catalogLoaded is a dependency on purpose: when the catalog arrives, lookupCourse starts returning titles/units.
  const courses = useMemo(() => buildCourses(store), [store, catalogLoaded])
  const grades = useMemo(
    () => new Map(courses.map((c) => [c.key, gradeCourse(c, { whatIf: c.prefs.whatIf })])),
    [courses],
  )
  const terms = useMemo(() => termsOf(courses), [courses])
  // Default to the newest term that has grades, not next semester's empty courses that appear in November.
  const gradedTerms = useMemo(() => termsWithGrades(courses, grades), [courses, grades])
  const term = pickTerm(terms, store.settings.term, gradedTerms)
  // "Cumulative after this semester" only for the newest term: the SIO QPA the student typed already counts
  // older terms, so adding an older term again would count it twice.
  const newestTerm = terms.length === 0 || term === terms[0]
  const { main, other } = useMemo(() => splitCourses(courses, term), [courses, term])
  // "What do I need" runs the grade math many times per course, so only do it for courses on screen.
  const needed = useMemo(() => {
    const map = new Map<string, NeededResult[]>()
    const compute = (c: Course) => neededForLetters(c, c.prefs.whatIf ?? {})
    for (const c of [...main, ...other]) map.set(c.key, neededFor(c, compute, store.settings.level))
    return map
  }, [main, other, store.settings.level])
  const qpa = useMemo(
    () => computeQpa(main, grades, store.settings, { includeCumulative: newestTerm }),
    [main, grades, store.settings, newestTerm],
  )
  const hasData = Object.keys(store.synced).length > 0 || store.manual.length > 0

  // ------------------------------------------------------------ store updates

  const changeSettings = useCallback((patch: Partial<Settings>) => setStore((s) => updateSettings(s, patch)), [])
  // The latest courses, for changePrefs below (a ref so changePrefs never changes and cards don't re-render).
  const coursesRef = useRef(courses)
  useEffect(() => {
    coursesRef.current = courses
  }, [courses])
  const changePrefs = useCallback((key: string, change: (p: CoursePrefs) => CoursePrefs) => {
    const items = coursesRef.current.find((c) => c.key === key)?.items
    // Start from the prefs with old item keys renamed to the current ones (rekeyPrefs), the same view the course
    // shows. Otherwise clearing a what-if saved under an item's old key would leave the old entry behind.
    setStore((s) => updatePrefs(s, key, change, items ? rekeyPrefs(s.prefs[key] ?? {}, items) : undefined))
  }, [])
  const addManual = useCallback(
    (course: ManualCourse) => {
      setStore((s) => addManualCourse(s, course))
      toast(`Added ${course.title || 'your class'}`)
    },
    [toast],
  )
  const removeManual = useCallback((key: string) => setStore((s) => removeManualCourse(s, key)), [])

  // "See a demo": load made-up grades so people can try everything before adding the Sync button.
  const startDemo = useCallback(() => {
    setStore((s) => loadDemo(s, demoPayloads()))
    navigate('home')
  }, [navigate])
  const endDemo = useCallback(() => {
    setStore((s) => clearDemo(s))
    navigate('home')
  }, [navigate])

  // ------------------------------------------------------------ syncing

  /** Replaces the store and offers an Undo that puts back the store from just before. */
  const replaceWithUndo = useCallback(
    (change: (s: Store) => Store, message: string, extra: { details?: string[]; detailsLabel?: string } = {}) => {
      let before: Store | null = null
      setStore((s) => {
        before = s // the updater runs before Undo can be clicked, so `before` is set by then
        return change(s)
      })
      toast(message, {
        ...extra,
        action: {
          label: 'Undo',
          onClick: () => {
            if (before) setStore(before)
            toast('Undone. Your grades are back to how they were.')
          },
        },
      })
    },
    [toast],
  )

  /** Saves a sync result and says how it went. */
  const applySync = useCallback(
    (payload: SyncPayload) => {
      const source = SOURCE_NAMES[payload.kind]
      const n = payload.warnings.length
      replaceWithUndo((s) => applyPayload(s, payload), `Synced ${plural(payload.courses.length, 'course')} from ${source}`, {
        details: n > 0 ? payload.warnings : undefined,
        detailsLabel: plural(n, 'warning'),
      })
    },
    [replaceWithUndo],
  )

  /** Tells the student to update an old Sync button (it still works, but may miss fixes). */
  const checkVersion = useCallback(
    (version: number | null) => {
      if (version !== null && version < BOOKMARKLET_VERSION) {
        toast('Your Sync button is out of date. Drag the new one from Setup.', {
          action: { label: 'Open Setup', onClick: () => navigate('setup') },
        })
      }
    },
    [toast, navigate],
  )

  /** Reads grades the bookmarklet put in the URL fragment (#sync=<payload>&bv=<version>). */
  const importFragment = useCallback(
    async (hash: string) => {
      const parsed = parseSyncFragment(hash)
      if (!parsed) {
        toast('That sync link looks broken. Try the Sync button again.', { tone: 'error' })
        return
      }
      try {
        const payload = await decodePayload(parsed.payload)
        // A real sync opens this link within seconds. An old one came from browser history or from someone else's
        // link, so ask before it replaces anything.
        if (syncLinkIsStale(payload.at, Date.now())) {
          const t = Date.parse(payload.at)
          const when = Number.isNaN(t) ? 'an unknown time' : new Date(t).toLocaleString()
          const ok = window.confirm(`This sync link is from ${when}. Replace your ${SOURCE_NAMES[payload.kind]} grades with it?`)
          if (!ok) {
            toast('Ignored the old sync link. Nothing changed.')
            return
          }
        }
        applySync(payload)
        checkVersion(parsed.version)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Couldn't read the synced grades: ${msg}`, { tone: 'error' })
      }
    },
    [applySync, checkVersion, toast],
  )

  // Once on load. The ref guard matters because React's StrictMode runs effects twice in development.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const hash = window.location.hash
    if (hash.startsWith('#sync=')) {
      // Take the grades out of the address bar right away, before even decoding them.
      window.history.replaceState(null, '', window.location.pathname)
      void importFragment(hash)
    } else if (hash === RECEIVE_HASH) {
      // Opened by the Sync button: wait for the grades from the tab that opened us. Without an opener (the tab
      // was opened by hand) there is nothing to wait for, and this is just the normal app.
      window.history.replaceState(null, '', window.location.pathname)
      startReceiver(browserReceiverDeps(), (payload, version) => {
        applySync(payload)
        checkVersion(version)
      })
    }
  }, [importFragment, applySync, checkVersion])

  // ------------------------------------------------------------ theme, data

  function changeTheme(t: Theme) {
    setTheme(t)
    applyTheme(t)
    setThemeState(t)
  }

  function deleteAll() {
    if (!window.confirm('Delete all your grades and settings from this browser? This cannot be undone.')) return
    clearAll()
    window.location.reload()
  }

  async function askClaude() {
    const text = buildClaudePrompt(main, grades, needed, qpa, store.settings)
    try {
      await navigator.clipboard.writeText(text)
      window.open(CLAUDE_URL, '_blank', 'noopener,noreferrer')
      toast('Copied your grade summary. Paste it into Claude.')
    } catch {
      setClaudeText(text) // clipboard blocked: show it so they can copy by hand
    }
  }

  // ------------------------------------------------------------ page

  let page
  if (view === 'privacy') page = <PrivacyPage />
  else if (view === 'setup' || !hasData) {
    page = (
      <Welcome
        mode={view === 'setup' ? 'setup' : 'welcome'}
        navigate={navigate}
        toast={toast}
        term={term}
        onAddManual={addManual}
        onDemo={startDemo}
      />
    )
  } else {
    page = (
      <Dashboard
        term={term}
        newestTerm={newestTerm}
        main={main}
        other={other}
        grades={grades}
        needed={needed}
        qpa={qpa}
        settings={store.settings}
        onSettings={changeSettings}
        onPrefs={changePrefs}
        onAddManual={addManual}
        onRemoveManual={removeManual}
        onAskClaude={askClaude}
        onOpenSettings={() => setSettingsOpen(true)}
        demo={store.demo === true}
        onEndDemo={endDemo}
        onSetup={() => navigate('setup')}
      />
    )
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header
        navigate={navigate}
        showDashboard={view === 'home' && hasData}
        terms={terms}
        term={term}
        onTermChange={(t) => changeSettings({ term: t })}
        lastSync={store.lastSync}
        now={now}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main id="main" className="container main">
        {page}
      </main>
      <Footer navigate={navigate} />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        store={store}
        onSettings={changeSettings}
        theme={theme}
        onTheme={changeTheme}
        onImport={(s) => replaceWithUndo(() => s, 'Imported your data')}
        onDeleteAll={deleteAll}
      />
      <ClaudeDialog text={claudeText} onClose={() => setClaudeText(null)} />
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  )
}

/** The saved store's raw text, to tell whether another tab changed it. null when nothing is saved. */
function readSavedRaw(): string | null {
  try {
    return localStorage.getItem(STORE_KEY)
  } catch {
    return null // storage blocked (private mode): there are no other tabs' copies to worry about
  }
}
