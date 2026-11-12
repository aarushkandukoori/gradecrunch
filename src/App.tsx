// The whole app. It owns the saved store, turns it into courses + grades + QPA, picks which page to show
// (home / setup / privacy, mirrored in the URL), and handles syncing: the Sync bookmarklet sends grades here in
// the #sync= fragment, which we read once on load.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildClaudePrompt } from './lib/askClaude'
import { catalogReady, loadCatalog } from './lib/catalog'
import { demoPayloads } from './lib/demo'
import { BOOKMARKLET_VERSION, parseSyncFragment } from './lib/bookmarklet'
import { plural } from './lib/format'
import { gradeCourse, neededForLetters } from './lib/grade'
import { buildCourses, termsOf } from './lib/merge'
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
import { neededFor, pickTerm, splitCourses } from './ui/view'

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

  useEffect(() => saveStore(store), [store])

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
  const term = pickTerm(terms, store.settings.term)
  const { main, other } = useMemo(() => splitCourses(courses, term), [courses, term])
  // "What do I need" runs the grade math many times per course, so only do it for courses on screen.
  const needed = useMemo(() => {
    const map = new Map<string, NeededResult[]>()
    const compute = (c: Course) => neededForLetters(c, c.prefs.whatIf ?? {})
    for (const c of [...main, ...other]) map.set(c.key, neededFor(c, compute, store.settings.level))
    return map
  }, [main, other, store.settings.level])
  const qpa = useMemo(() => computeQpa(main, grades, store.settings), [main, grades, store.settings])
  const hasData = Object.keys(store.synced).length > 0 || store.manual.length > 0

  // ------------------------------------------------------------ store updates

  const changeSettings = useCallback((patch: Partial<Settings>) => setStore((s) => updateSettings(s, patch)), [])
  const changePrefs = useCallback(
    (key: string, change: (p: CoursePrefs) => CoursePrefs) => setStore((s) => updatePrefs(s, key, change)),
    [],
  )
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

  /** Saves a sync result and says how it went. */
  const applySync = useCallback(
    (payload: SyncPayload) => {
      setStore((s) => applyPayload(s, payload))
      const source = SOURCE_NAMES[payload.kind]
      const n = payload.warnings.length
      toast(`Synced ${plural(payload.courses.length, 'course')} from ${source}`, {
        details: n > 0 ? payload.warnings : undefined,
        detailsLabel: plural(n, 'warning'),
      })
    },
    [toast],
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
        applySync(await decodePayload(parsed.payload))
        if (parsed.version !== null && parsed.version < BOOKMARKLET_VERSION) {
          toast('Your Sync button is out of date. Drag the new one from Setup.', {
            action: { label: 'Open Setup', onClick: () => navigate('setup') },
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Couldn't read the synced grades: ${msg}`, { tone: 'error' })
      }
    },
    [applySync, toast, navigate],
  )

  // Once on load. The ref guard matters because React's StrictMode runs effects twice in development.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const hash = window.location.hash
    if (hash.startsWith('#sync=')) {
      // Take the grades out of the address bar and history right away, before even decoding them.
      window.history.replaceState(null, '', window.location.pathname)
      void importFragment(hash)
    }
  }, [importFragment])

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
        onImport={(s) => {
          setStore(s)
          toast('Imported your data')
        }}
        onDeleteAll={deleteAll}
      />
      <ClaudeDialog text={claudeText} onClose={() => setClaudeText(null)} />
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  )
}
