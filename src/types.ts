// Shared data types. Every module (sync, merge, grade math, UI) talks in these shapes.
//
// Flow:  Canvas / Gradescope  --sync-->  SyncPayload (list of SyncedCourse)
//        SIO                  --sync-->  SyncPayload (list of SioSemester: official units, grade option, grades, QPA)
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

/** A syllabus (or the course home page) the sync found, so the app can read the real grading weights. */
export interface SyllabusDoc {
  source: 'canvas-syllabus' | 'canvas-front-page' | 'canvas-file'
  name: string // e.g. "Syllabus page" or "sylb.pdf"
  url: string | null // https link to it on Canvas
  text?: string // plain text (always set once stored; HTML sources arrive as text)
  pdfBase64?: string // raw PDF bytes in a sync payload only; the app turns it into `text` before saving
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
  syllabus?: SyllabusDoc[] // Canvas only: syllabus page / home page / syllabus files, for the grading weights
}

/** What the bookmarklet (or token sync) hands to the app. */
export interface SyncPayload {
  v: 1
  kind: 'canvas' | 'gradescope' | 'autolab' | 'sio'
  at: string // ISO time
  courses: SyncedCourse[] // always empty for 'sio'
  semesters?: SioSemester[] // 'sio' only: every semester SIO showed
  warnings: string[] // human-readable problems that did not stop the sync
  failedIds?: string[] // sourceIds of courses (SIO: semester codes) that could not be read: keep the stored copy
}

// ---------------------------------------------------------------- SIO (CMU's official record)

/** One course on an SIO "Grades and QPA" page. */
export interface SioCourse {
  title: string // "Matrices and Linear Transformations"
  number: string | null // "21241" (5 digits, no dash); null when SIO shows something we can't read
  alsoNumbers: string[] // more numbers written in the same cell, e.g. ["10615"] for "10-335/615"
  section: string | null // "F"
  gradeOption: string | null // "L" letter grade, "P" pass/no pass, "A" audit, ...
  units: number | null // 9, 12, 4.5
  midGrade: string | null // mid-semester grade, e.g. "B+"; null when SIO shows NA
  finalGrade: string | null // "A", "P", "W", ...; null until it is posted
}

/** The QPA row under one semester. null = SIO shows nothing there yet (no final grades, no mid-semester grades). */
export interface SioQpa {
  midSemQpa: number | null
  unitsCarried: number | null
  unitsPassed: number | null
  factorableUnits: number | null
  qualityPoints: number | null
  finalQpa: number | null // the semester QPA
  cumulativeQpa: number | null // the official cumulative QPA SIO shows with this semester
}

/** One semester from SIO's semester picker. */
export interface SioSemester {
  code: string // "F26"
  term: string // the picker's label, e.g. "Fall 2026"
  level: Level // the picker group it sits in: UNDERGRADUATE or GRADUATE (separate records, separate cumulatives)
  courses: SioCourse[]
  qpa: SioQpa
}

/** What the store keeps from the last good SIO sync. */
export interface SioData {
  semesters: SioSemester[] // newest first
  syncedAt: string // ISO time of that sync
  // Codes of semesters SIO listed that the last sync couldn't read and that we have no stored copy of. While any are
  // missing, "QPA before this semester" is not added up from SIO (it would leave a semester out).
  unread?: string[]
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
  whatIfGraded?: string[] // itemKeys whose what-if was typed over an existing real score (keep it after re-syncs);
  //                         any other what-if stops applying once the item gets a real score
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
  lastSync: { canvas?: string; gradescope?: string; autolab?: string; sio?: string }
  sio?: SioData // the last good SIO sync (missing in stores saved before SIO support)
  demo?: boolean // true while the sample data from "See a demo" is loaded
}

// ---------------------------------------------------------------- merged model (derived, never stored)

export interface Category {
  key: string
  name: string
  weight: number | null // effective weight percent after prefs; null in points mode
  weightSource?: 'you' | 'syllabus' | 'canvas' // where `weight` came from
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
  aliases?: string[] // other keys this same assignment had before (e.g. its Gradescope key before Canvas posted it)
  planned: boolean // a ManualItem the student added
}

export interface CourseSourceRef {
  source: Source
  sourceId: string
  url: string
  syncedAt: string
}

/** What SIO says about one class. Only set for classes in a term SIO has. */
export interface CourseSio {
  registered: boolean // false: SIO lists this term but not this class (you dropped it, or never took it)
  units: number | null // exact units
  gradeOption: string | null // "L" letter, "P" pass/fail, ...
  midGrade: string | null // e.g. "B+"
  finalGrade: string | null // once posted
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
  unitsSource: 'catalog' | 'custom' | 'default' | 'sio'
  manualPercent: number | null // from a ManualCourse
  // The student's prefs (item keys renamed to the current ones), plus what SIO implies when the student set nothing:
  // passFail true for grade option "P", hidden true for a class SIO doesn't list. An explicit false always wins.
  prefs: CoursePrefs
  weightNote?: string | null // why the weights differ from Canvas, e.g. "Using syllabus weights; Canvas isn't weighted"
  syllabusUsed?: { name: string; url: string | null } | null // the syllabus document the weights came from
  sio?: CourseSio | null // set when SIO has this class's term
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
  status: 'locked' | 'guaranteed' | 'possible' | 'impossible' | 'unknown'
  // locked: no remaining work, you have it / guaranteed: even 0% on the rest gets it
  // possible: need `needed`% on the rest / impossible: even 100% on the rest misses it
  // unknown: work is still to come but its point values are not known yet (Gradescope hides them until graded)
}

/** Where the letter used for a class's QPA came from. */
export type LetterBasis =
  | 'you' // the final letter the student picked
  | 'sio-final' // the final grade posted in SIO
  | 'estimate' // computed from the scores (or Canvas's own score, or a typed-in percent)
  | 'sio-mid' // the SIO mid-semester grade, when nothing else is known

export interface QpaRow {
  courseKey: string
  label: string // "21-241"
  units: number
  letter: string | null // final letter used (override or estimate)
  points: number | null // quality points per unit for that letter
  factorable: boolean // counts toward QPA
  reason: string | null // why not factorable ("Pass/fail", "No grade yet", ...)
  basis?: LetterBasis | null // where `letter` came from
}

export interface QpaResult {
  rows: QpaRow[]
  semesterQpa: number | null
  factorableUnits: number
  totalUnits: number
  qualityPoints: number
  cumulativeQpa: number | null // null unless prior QPA and units are set
  // incomplete: SIO shows an Incomplete (I) this semester, which rules the Dean's List out whatever the QPA
  deansList: { eligible: boolean; threshold: number; minUnits: number; college: string; note: string; incomplete?: boolean } | null
}
