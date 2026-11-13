// The whole app. It owns the saved store, turns it into courses + grades + QPA, picks which page to show
// (home / one class / past semesters / setup / privacy, mirrored in the URL), and handles syncing: the Sync bookmarklet opens this site at
// /#receive and hands the grades over by postMessage (see ui/receive.ts), or, when a popup blocker gets in the
// way, sends them in a #sync= link that we read once on load. With the GradeCrunch Chrome extension installed, the
// Sync button asks the extension instead (see lib/extension.ts), and the app syncs by itself on load when the last
// sync is more than 10 minutes old. Every sync can be undone from its toast. The AI advisor button opens the AI chat
// (ui/ChatPanel.tsx); the notes the AI advisor remembers live here too, so Settings can show and edit them.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { catalogReady, loadCatalog } from './lib/catalog'
import { CHAT_KEY, clearChatData, loadNotes, MEMORY_KEY, saveChat, saveNotes, type Note } from './lib/chat/memory'
import { demoPayloads } from './lib/demo'
import { BOOKMARKLET_VERSION, parseSyncFragment, RECEIVE_HASH } from './lib/bookmarklet'
import { courseLabel, plural } from './lib/format'
import { gradeCourse, neededForLetters } from './lib/grade'
import { buildCourses, rekeyPrefs, termsOf } from './lib/merge'
import {
  browserExtension,
  getAutolabSetting,
  loginSources,
  markReloadTried,
  mergeNotes,
  needsAutoSync,
  needsReload,
  pickSources,
  reloadTried,
  setAutolabSetting,
  supportedSources,
  type ExtensionClient,
  type ExtensionInfo,
  type ExtSource,
  type SyncNote,
} from './lib/extension'
import { decodePayload, validatePayload } from './lib/payload'
import { computeQpa } from './lib/qpa'
import { finishedSemesters, levelFor, officialCumulative, priorFromSio, withSioPrior } from './lib/sio'
import { payloadHasPdfs, pdfsToText } from './lib/syllabus'
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
import { ChatPanel } from './ui/ChatPanel'
import { ClassView } from './ui/ClassView'
import { Dashboard, type ReturnTo } from './ui/Dashboard'
import { FinishSetup, SyncNotes, type ExtensionView } from './ui/ExtensionBits'
import { Footer } from './ui/Footer'
import { Header } from './ui/Header'
import { classKeyFromPath, classPath, VIEW_PATHS, viewFromPath, type View } from './ui/Link'
import { PastSemesters } from './ui/PastSemesters'
import { PrivacyPage } from './ui/PrivacyPage'
import { SettingsDialog } from './ui/SettingsDialog'
import { Toasts, useToasts } from './ui/Toasts'
import { Welcome } from './ui/Welcome'
import { browserReceiverDeps, startReceiver, syncLinkIsStale } from './ui/receive'
import { EMPTY_GRADE, isManualOnly, neededFor, pickTerm, splitCourses, termsWithGrades } from './ui/view'

const RELOAD_WAIT_MS = 1500 // how long the dev extension gets to restart after a reload
const SOURCE_NAMES: Record<SyncPayload['kind'], string> = { canvas: 'Canvas', gradescope: 'Gradescope', autolab: 'Autolab', sio: 'SIO' }

interface AppProps {
  extension?: ExtensionClient // the Chrome extension client; tests pass a fake one
}

export default function App({ extension = browserExtension }: AppProps) {
  const [store, setStore] = useState<Store>(loadStore)
  const storeRef = useRef(store) // the latest store, for callbacks that must not change every time it does
  const [view, setView] = useState<View>(() => viewFromPath(window.location.pathname))
  // The class open at /class/<key>, or null on any other page.
  const [classKey, setClassKey] = useState<string | null>(() => classKeyFromPath(window.location.pathname))
  // The list row (and scroll spot) to return to when leaving a class page.
  const [returnTo, setReturnTo] = useState<ReturnTo | null>(null)
  const [theme, setThemeState] = useState<Theme>(getTheme)
  const [now, setNow] = useState(() => Date.now())
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The AI advisor chat: open or not, and the class it was opened from (its question box then starts with that class).
  const [chatOpen, setChatOpen] = useState(false)
  const [chatTopic, setChatTopic] = useState<string | null>(null)
  const [chatKey, setChatKey] = useState(0) // a new key starts the chat over (when another tab removed the chat)
  const [memory, setMemory] = useState<Note[]>(loadNotes) // what the AI advisor remembers about the student
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
    storeRef.current = store
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
      // The AI advisor's notes and chat, the same way: take the other tab's notes, and when it removed the chat
      // ("Delete everything" or Clear chat), start this tab's chat over too, so this tab never saves its old copy back.
      if (e.key === MEMORY_KEY || e.key === null) setMemory(loadNotes())
      if ((e.key === CHAT_KEY && e.newValue === null) || e.key === null) setChatKey((k) => k + 1)
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
    // We put the scroll back ourselves (class page at the top, the list where it was).
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
    const onPop = () => {
      const key = classKeyFromPath(window.location.pathname)
      setView(viewFromPath(window.location.pathname))
      setClassKey(key)
      if (key) window.scrollTo(0, 0)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((next: View) => {
    if (window.location.pathname !== VIEW_PATHS[next]) window.history.pushState(null, '', VIEW_PATHS[next])
    setView(next)
    setClassKey(null)
    if (next !== 'home') setReturnTo(null)
    window.scrollTo(0, 0)
  }, [])

  const openClass = useCallback((key: string) => {
    setReturnTo({ key, scrollY: window.scrollY })
    window.history.pushState(null, '', classPath(key))
    setView('home')
    setClassKey(key)
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
  // "Cumulative after this semester": the QPA before this semester comes from SIO (only the semesters before the one
  // shown, so any term works), unless the student typed their own in Settings. A typed one already counts every
  // older term, so with it the cumulative only shows for the newest term (an older one would be counted twice).
  const newestTerm = terms.length === 0 || term === terms[0]
  // The settings for the term on screen (sio.ts withSioPrior): the level of the record SIO puts the term in
  // (undergraduate or graduate scale), and the QPA before this semester from SIO unless the student typed it.
  const sioPrior = useMemo(() => withSioPrior(store.settings, store.sio, term), [store.settings, store.sio, term])
  const termSettings = sioPrior.settings
  const official = officialCumulative(store.sio, termSettings.level)
  const hasPast = finishedSemesters(store.sio).length > 0
  const { main, other } = useMemo(() => splitCourses(courses, term), [courses, term])
  // "What do I need" runs the grade math many times per course, so only do it for courses on screen.
  const needed = useMemo(() => {
    const map = new Map<string, NeededResult[]>()
    const compute = (c: Course) => neededForLetters(c, c.prefs.whatIf ?? {})
    for (const c of [...main, ...other]) map.set(c.key, neededFor(c, compute, termSettings.level))
    return map
  }, [main, other, termSettings.level])
  const qpa = useMemo(
    () => computeQpa(main, grades, sioPrior.settings, { includeCumulative: newestTerm || sioPrior.fromSio }),
    [main, grades, sioPrior, newestTerm],
  )
  const hasData = Object.keys(store.synced).length > 0 || store.manual.length > 0 || (store.sio?.semesters.length ?? 0) > 0
  const openCourse = classKey ? courses.find((c) => c.key === classKey) : undefined
  // The class page uses the record of the class's own term (it can be from another term than the one on screen).
  const openLevel = levelFor(store.sio, openCourse?.term ?? null, store.settings.level)
  const openNeeded = useMemo(() => {
    if (!openCourse) return []
    // A class from another term is not in `needed` (that only covers the classes on screen), so compute it here.
    return needed.get(openCourse.key) ?? neededFor(openCourse, (c) => neededForLetters(c, c.prefs.whatIf ?? {}), openLevel)
  }, [openCourse, needed, openLevel])

  // A /class/ link to a class that isn't here (an old link, or it was just removed): show the class list instead.
  useEffect(() => {
    if (classKey && !openCourse) {
      window.history.replaceState(null, '', VIEW_PATHS.home)
      setClassKey(null)
    }
  }, [classKey, openCourse])

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

  // The AI advisor: open the chat (from a class page, `topic` is that class, e.g. "15-122"), and save its notes.
  const openChat = useCallback((topic: string | null = null) => {
    setChatTopic(topic)
    setChatOpen(true)
  }, [])
  const changeMemory = useCallback((next: Note[]) => {
    setMemory(next)
    saveNotes(next)
  }, [])

  // The AI advisor's chat and notes from "See a demo" are about the made-up grades: forget them once the sample data
  // is gone, however it went (Clear sample data, a real sync, an import). Consent stays. The new chatKey starts the chat
  // over, so the sheet neither keeps its old copy nor finishes a question about the demo.
  const wasDemo = useRef(store.demo === true)
  useEffect(() => {
    if (wasDemo.current && !store.demo) {
      saveChat([])
      changeMemory([])
      setChatKey((k) => k + 1)
    }
    wasDemo.current = store.demo === true
  }, [store.demo, changeMemory])

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
  const saveSync = useCallback(
    (payload: SyncPayload) => {
      const source = SOURCE_NAMES[payload.kind]
      const n = payload.warnings.length
      const what = payload.kind === 'sio' ? plural(payload.semesters?.length ?? 0, 'semester') : plural(payload.courses.length, 'course')
      replaceWithUndo((s) => applyPayload(s, payload), `Synced ${what} from ${source}`, {
        details: n > 0 ? payload.warnings : undefined,
        detailsLabel: plural(n, 'warning'),
      })
    },
    [replaceWithUndo],
  )

  /**
   * Every sync (extension, Sync button, #sync link) comes through here. Syllabus PDFs are turned into text first
   * (pdf.js, loaded only then), so localStorage never holds a PDF; applyPayload then keeps at most 60 KB of
   * syllabus text per course. Without PDFs the sync is saved right away.
   */
  const applySync = useCallback(
    (payload: SyncPayload) => {
      if (!payloadHasPdfs(payload)) {
        saveSync(payload)
        return
      }
      pdfsToText(payload)
        .then(saveSync)
        .catch(() => saveSync(payload)) // never lose the grades over a PDF (applyPayload drops the PDFs)
    },
    [saveSync],
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

  // ------------------------------------------------------------ the Chrome extension

  const [ext, setExt] = useState<ExtensionInfo | null>(null) // null = not installed (or not found yet)
  const [extSyncing, setExtSyncing] = useState(false)
  const [extProgress, setExtProgress] = useState<string | null>(null)
  const [notes, setNotes] = useState<SyncNote[]>([]) // "Log in to Gradescope" and error lines from the last sync
  const [autolabOn, setAutolabOn] = useState(getAutolabSetting)
  const syncingRef = useRef(false) // a ref too, so a focus event during a sync can't start a second one
  const notesRef = useRef(notes)
  useEffect(() => {
    notesRef.current = notes
  }, [notes])

  /** Asks the extension for these sites and applies what comes back, one Undo toast per site. */
  const runExtensionSync = useCallback(
    async (info: ExtensionInfo, sources: ExtSource[]) => {
      if (syncingRef.current) return
      syncingRef.current = true
      setExtSyncing(true)
      setExtProgress(null)
      try {
        const { results } = await extension.sync(info.id, sources, (p) => setExtProgress(p.message))
        const fresh: SyncNote[] = []
        for (const r of results) {
          if (r.status === 'ok') {
            try {
              applySync(validatePayload(r.payload)) // the payload crossed a trust boundary: check it like a #sync link
            } catch (err) {
              fresh.push({ kind: 'error', source: r.source, message: err instanceof Error ? err.message : String(err) })
            }
          } else if (r.status === 'login') {
            fresh.push({ kind: 'login', source: r.source, url: r.loginUrl })
          } else {
            fresh.push({ kind: 'error', source: r.source, message: r.message })
          }
        }
        setNotes((old) => mergeNotes(old, sources, fresh))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message === 'consent') {
          // The extension says its welcome page isn't finished: show the "Finish setting up" card.
          setExt({ ...info, consent: false })
          setNotes([])
        } else {
          setNotes((old) => mergeNotes(old, [], [{ kind: 'error', source: null, message }]))
        }
      } finally {
        syncingRef.current = false
        setExtSyncing(false)
        setExtProgress(null)
      }
    },
    [extension, applySync],
  )

  /** Canvas + Gradescope + SIO, plus Autolab when it has data here or the setting is on (what the extension can do). */
  const sourcesToSync = useCallback(
    (info: ExtensionInfo): ExtSource[] => {
      const s = storeRef.current
      const hasAutolab = Boolean(s.lastSync.autolab) || Object.values(s.synced).some((c) => c.source === 'autolab')
      return pickSources(hasAutolab, autolabOn, supportedSources(info))
    },
    [autolabOn],
  )

  const openWelcome = useCallback(
    (info: ExtensionInfo) => {
      extension.openWelcome(info.id).catch(() => toast("Couldn't open the extension. Click its icon in the toolbar.", { tone: 'error' }))
    },
    [extension, toast],
  )

  // Look for the extension once on load (StrictMode runs effects twice in development, hence the ref).
  const detectStartedRef = useRef(false)
  useEffect(() => {
    if (detectStartedRef.current) return
    detectStartedRef.current = true
    async function detect() {
      let info = await extension.detect()
      // The unpacked dev build was rebuilt but still runs its old code: reload it once, then look again. Only once per
      // version in this tab: if the reload didn't help (the files on disk are that old too), asking on every page load
      // would just restart the extension each time.
      if (info && needsReload(info) && extension.reload && !reloadTried(info.version)) {
        markReloadTried(info.version)
        await extension.reload(info.id).catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, RELOAD_WAIT_MS))
        info = (await extension.detect().catch(() => null)) ?? info
      }
      if (info) setExt(info)
    }
    detect().catch(() => {}) // no extension: the bookmarklet keeps working
  }, [extension])

  // Sync by itself once, as soon as the extension is ready (on load, or right after its welcome page is done),
  // unless the grades are fresh (synced in the last 10 minutes) or the sample data is showing.
  const autoSyncedRef = useRef(false)
  useEffect(() => {
    if (!ext?.consent || autoSyncedRef.current) return
    autoSyncedRef.current = true
    const s = storeRef.current
    if (!s.demo && needsAutoSync(s.lastSync, Date.now())) void runExtensionSync(ext, sourcesToSync(ext))
  }, [ext, runExtensionSync, sourcesToSync])

  // Coming back to this tab: after logging in to a site in another tab, re-sync just the sites that needed it.
  // After finishing the extension's welcome page, ask the extension again so the "Finish setting up" card goes away.
  useEffect(() => {
    if (!ext) return
    const onBack = () => {
      if (document.visibilityState === 'hidden') return
      if (!ext.consent) {
        extension
          .detect()
          .then((info) => info && info.consent && setExt(info))
          .catch(() => {})
        return
      }
      const sites = loginSources(notesRef.current)
      if (sites.length > 0) void runExtensionSync(ext, sites)
    }
    window.addEventListener('focus', onBack)
    document.addEventListener('visibilitychange', onBack)
    return () => {
      window.removeEventListener('focus', onBack)
      document.removeEventListener('visibilitychange', onBack)
    }
  }, [ext, extension, runExtensionSync])

  const extView: ExtensionView | null = ext && {
    version: ext.version,
    consent: ext.consent,
    syncing: extSyncing,
    progress: extProgress,
    notes,
    onSync: () => void runExtensionSync(ext, sourcesToSync(ext)),
    onOpenWelcome: () => openWelcome(ext),
  }

  function changeAutolab(on: boolean) {
    setAutolabSetting(on)
    setAutolabOn(on)
  }

  // ------------------------------------------------------------ theme, data

  function changeTheme(t: Theme) {
    setTheme(t)
    applyTheme(t)
    setThemeState(t)
  }

  function deleteAll() {
    if (!window.confirm("Delete all your grades, settings and the AI advisor's chat and notes from this browser? This cannot be undone.")) return
    clearChatData() // the AI advisor's chat, notes and consent (clearAll below also removes every GradeCrunch key)
    clearAll()
    window.location.reload()
  }

  // ------------------------------------------------------------ page

  let page
  if (view === 'privacy') page = <PrivacyPage />
  else if (view === 'past') page = <PastSemesters sio={store.sio} level={store.settings.level} onBack={() => navigate('home')} />
  else if (view === 'setup' || !hasData) {
    page = (
      <Welcome
        mode={view === 'setup' ? 'setup' : 'welcome'}
        navigate={navigate}
        toast={toast}
        term={term}
        onAddManual={addManual}
        onDemo={startDemo}
        onBack={hasData ? () => navigate('home') : undefined}
        ext={extView}
      />
    )
  } else if (openCourse) {
    const key = openCourse.key
    page = (
      <ClassView
        course={openCourse}
        grade={grades.get(key) ?? EMPTY_GRADE}
        needed={openNeeded}
        settings={{ ...store.settings, level: openLevel }}
        qpaRow={qpa.rows.find((r) => r.courseKey === key)}
        onBack={() => navigate('home')}
        onPrefs={(change) => changePrefs(key, change)}
        onAsk={() => openChat(courseLabel(openCourse))}
        onRemove={
          isManualOnly(openCourse)
            ? () => {
                removeManual(key)
                navigate('home')
              }
            : undefined
        }
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
        official={official}
        settings={termSettings}
        onSettings={changeSettings}
        onOpenClass={openClass}
        onPrefs={changePrefs}
        onPastSemesters={hasPast ? () => navigate('past') : undefined}
        onAddManual={addManual}
        onAsk={() => openChat()}
        demo={store.demo === true}
        onEndDemo={endDemo}
        onSetup={() => navigate('setup')}
        returnTo={returnTo}
        notice={
          extView && !extView.consent ? (
            <FinishSetup onOpenWelcome={extView.onOpenWelcome} />
          ) : (
            <SyncNotes notes={notes} sioSaved={store.sio !== undefined} />
          )
        }
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
        onAsk={hasData ? () => openChat() : undefined}
        extSync={
          extView
            ? {
                // Before the extension's welcome page is done, Sync opens that page instead.
                onSync: extView.consent ? extView.onSync : extView.onOpenWelcome,
                syncing: extSyncing,
                progress: extProgress,
              }
            : undefined
        }
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
        qpa={qpa}
        newestTerm={newestTerm}
        sioPrior={priorFromSio(store.sio, term, termSettings.level)}
        sioLevel={term && termSettings.level !== store.settings.level ? { term, level: termSettings.level } : null}
        autolab={ext ? { on: autolabOn, onChange: changeAutolab } : undefined}
        notes={memory}
        onNotesChange={changeMemory}
      />
      {/* Always mounted: it keeps its own chat and opens or closes with `open`. Tool changes and Undo go through
          setStore, so they are saved (and reach other tabs) like any other change. */}
      <ChatPanel
        key={chatKey}
        open={chatOpen}
        topic={chatTopic}
        onClose={() => setChatOpen(false)}
        store={store}
        onStoreChange={setStore}
        notes={memory}
        onNotesChange={changeMemory}
      />
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
