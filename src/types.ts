// Shared data types. Every module (sync, merge, grade math, UI) talks in these shapes.
//
// Flow:  Canvas / Gradescope  --sync-->  SyncPayload (list of SyncedCourse)
//        stored in the browser  --merge with user prefs-->  Course[]
//        Course  --grade math-->  GradeResult, NeededResult[], QPA

/** Where a piece of grade data came from. */
export type Source = 'canvas' | 'gradescope' | 'autolab' | 'manual'

/** What the source says about one assignment. */
export type ItemStatus =
  | 'graded' // has a released score
  | 'submitted' // turned in, no score yet
  | 'ungraded' // Gradescope "Ungraded": exists (e.g. paper exam), no score released yet
  | 'missing' // Canvas marked it missing
  | 'unsubmitted' // nothing turned in (may not be due yet)
  | 'excused' // Canvas "excused": ignored in the grade

/** An assignment group (Canvas) or inferred category (Gradescope), as synced. */
export interface SyncedCategory {
  id: string // source-scoped id (Canvas assignment group id, or inferred name for Gradescope)
  name: string
  weight: number | null // percent of the course grade (0-100); null when unknown / not weighted
  dropLowest: number
  dropHighest: number
  neverDrop: string[] // item ids that may never be dropped
}

/** One assignment, as synced. */
export interface SyncedItem {
  id: string // source-scoped id
  name: string
  categoryId: string | null // SyncedCategory.id, or null if unknown
  score: number | null // points earned; null = no released score
  max: number | null // points possible; null = unknown (Gradescope hides it until graded)
  status: ItemStatus
  due: string | null // ISO 8601 with offset, e.g. "2026-09-11T23:59:00-04:00"
  omit: boolean // Canvas "do not count toward final grade" / not_graded
  url: string | null // https link back to the assignment on the source site
}

/** One row of a letter-grade scheme: you get `letter` if your percent >= `min`. */
export interface GradeCut {
  letter: string
  min: number // percent, 0-100
}

/** One course as one source sees it. */
export interface SyncedCourse {
  source: Source
  sourceId: string // Canvas course id / Gradescope course id / random id for manual
  number: string | null // 5-digit CMU course number without dash, e.g. "21241"; null if none found
  alsoNumbers: string[] // cross-listed numbers, e.g. ["10615"] for "10-335/615"
  title: string // human title, e.g. "Matrices and Linear Transformations"
  term: string | null // e.g. "Fall 2026"; null for Canvas "Default Term"
  url: string // https link to the course on the source site
  weighted: boolean // Canvas apply_assignment_group_weights
  categories: SyncedCategory[]
  items: SyncedItem[]
  canvasScore: number | null // Canvas's own current score (percent), when the course shows it
  canvasGrade: string | null // Canvas's own current letter, when shown
  scheme: GradeCut[] | null // the course's letter scheme from Canvas, sorted by min descending
  syncedAt: string // ISO time of the sync
}

/** What the bookmarklet (or token sync) hands to the app. */
export interface SyncPayload {
  v: 1
  kind: 'canvas' | 'gradescope' | 'autolab'
  at: string // ISO time
  courses: SyncedCourse[]
  warnings: string[] // human-readable problems that did not stop the sync
}

// ---------------------------------------------------------------- user preferences

/** A future assignment the student adds by hand (to plan around work not posted yet). */
export interface ManualItem {
  key: string // "m:<random>"
  name: string
  categoryKey: string
  max: number
}

/** Everything the student can change about one course. All optional. */
export interface CoursePrefs {
  units?: number // overrides catalog units
  letter?: string // final letter override ("A", "B", ..., "P", "N", "W")
  passFail?: boolean // taken pass/no pass: not counted in QPA
  hidden?: boolean // hide from dashboard and QPA
  weighted?: boolean // force weighted (true) or total-points (false) grading
  weights?: Record<string, number> // categoryKey -> weight percent
  cutoffs?: GradeCut[] // custom letter cutoffs for this course
  whatIf?: Record<string, number> // itemKey -> hypothetical score (points)
  moved?: Record<string, string> // itemKey -> categoryKey (re-categorized by the student)
  ignored?: string[] // itemKeys excluded from the grade
  included?: string[] // itemKeys we skipped automatically that the student wants counted anyway
  extra?: ManualItem[] // planned future items
}

export type Level = 'undergrad' | 'grad'

export interface Settings {
  level: Level
  college: string | null // key into DEANS_LIST in src/lib/cmu.ts
  priorQpa: number | null // cumulative QPA before this semester (from SIO)
  priorUnits: number | null // factorable units before this semester (from SIO)
  term: string | null // which term the dashboard shows; null = newest
  showAll: boolean // also show non-academic Canvas shells (no course number)
}

/** A course the student types in by hand (e.g. graded on Autolab or paper). */
export interface ManualCourse {
  key: string // "manual:<random>"
  number: string | null
  title: string
  term: string | null
  percent: number | null // current percent if they know it
}

/** Everything saved in localStorage. */
export interface Store {
  v: 1
  synced: Record<string, SyncedCourse> // key = `${source}:${sourceId}`
  manual: ManualCourse[]
  prefs: Record<string, CoursePrefs> // key = Course.key
  settings: Settings
  lastSync: { canvas?: string; gradescope?: string; autolab?: string }
  demo?: boolean // true while the sample data from "See a demo" is loaded
}

// ---------------------------------------------------------------- merged model (derived, never stored)

export interface Category {
  key: string
  name: string
  weight: number | null // effective weight percent after prefs; null in points mode
  dropLowest: number
  dropHighest: number
  neverDrop: string[] // item keys
}

export interface Item {
  key: string // stable across syncs: "c:<canvasId>", "g:<gsCourse>:<gsId>", or "m:<random>"
  name: string
  categoryKey: string
  score: number | null
  max: number | null
  maxEstimated: boolean // max guessed from similar items (Gradescope hides it until graded)
  status: ItemStatus
  due: string | null
  omit: boolean
  url: string | null
  source: Source // where `score` came from
  otherScore: number | null // the other site's score when two sites disagree (e.g. Canvas vs Gradescope)
  otherSource?: Source // which site otherScore came from
  skipReason?: string // set when we left it out automatically (e.g. an alternate exam you didn't take)
  planned: boolean // a ManualItem the student added
}

export interface CourseSourceRef {
  source: Source
  sourceId: string
  url: string
  syncedAt: string
}

export interface Course {
  key: string // `${term}|${number}` when a number is known, else `${source}:${sourceId}`
  number: string | null
  alsoNumbers: string[]
  title: string
  term: string | null
  academic: boolean // false for Canvas shells with no course number (career center, orientation)
  sources: CourseSourceRef[]
  weighted: boolean
  categories: Category[]
  items: Item[]
  canvasScore: number | null
  canvasGrade: string | null
  scheme: GradeCut[] // effective cutoffs, sorted by min descending
  schemeSource: 'canvas' | 'custom' | 'default'
  units: number
  unitsSource: 'catalog' | 'custom' | 'default'
  manualPercent: number | null // from a ManualCourse
  prefs: CoursePrefs
}

// ---------------------------------------------------------------- grade math results

export interface CategoryResult {
  key: string
  name: string
  weight: number | null
  earned: number
  possible: number
  percent: number | null // null when nothing graded in this category
  dropped: string[] // item keys dropped by drop rules
  counted: boolean // contributed to the course percent
}

export interface GradeResult {
  percent: number | null // course percent (0-100+), null when nothing is graded
  letter: string | null // from the course scheme
  categories: CategoryResult[]
  graded: number // number of items with a (real or what-if) score
  remaining: number // number of countable items without a score
}

export interface NeededResult {
  letter: string
  min: number // the cutoff percent
  needed: number | null // average percent needed on all remaining work; null when nothing remains
  status: 'locked' | 'guaranteed' | 'possible' | 'impossible'
  // locked: no remaining work, you have it / guaranteed: even 0% on the rest gets it
  // possible: need `needed`% on the rest / impossible: even 100% on the rest misses it
}

export interface QpaRow {
  courseKey: string
  label: string // "21-241"
  units: number
  letter: string | null // final letter used (override or estimate)
  points: number | null // quality points per unit for that letter
  factorable: boolean // counts toward QPA
  reason: string | null // why not factorable ("Pass/fail", "No grade yet", ...)
}

export interface QpaResult {
  rows: QpaRow[]
  semesterQpa: number | null
  factorableUnits: number
  totalUnits: number
  qualityPoints: number
  cumulativeQpa: number | null // null unless prior QPA and units are set
  deansList: { eligible: boolean; threshold: number; minUnits: number; college: string; note: string } | null
}
