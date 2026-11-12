// Reads a student's courses, assignment groups, scores and letter scales from the Canvas REST API
// and turns them into our SyncedCourse shape.
//
// The same code runs in two places, so it must not touch the DOM:
//   1. inside the Sync bookmarklet on canvas.cmu.edu (sameOriginFetcher, uses the student's session cookie)
//   2. in Node tests with a fake PageFetcher
import type { GradeCut, ItemStatus, SyncPayload, SyncedCategory, SyncedCourse, SyncedItem } from '../types'
import { CANVAS_ORIGIN } from '../lib/brand'
import { parseCourseNumbers } from '../lib/courseNumber'

/** Fetch one page of a Canvas API path (relative to /api/v1/, query included). `next` = next page path or null. */
export type PageFetcher = (path: string) => Promise<{ data: unknown; next: string | null }>

/** The student is not logged in (bookmarklet) or the token is bad (proxy). Stops the whole sync. */
export class CanvasAuthError extends Error {}

/** Any other non-2xx answer from Canvas. `status` lets callers treat 403/404 differently. */
export class CanvasHttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// ---------------------------------------------------------------- fetchers

/**
 * Canvas can prefix session-authenticated JSON with `while(1);` (an old trick that stops other sites
 * from reading it via <script> tags). Strip it before parsing.
 */
export function parseCanvasJson(text: string): unknown {
  return JSON.parse(text.replace(/^\s*while\(1\);/, ''))
}

/**
 * Pull the rel="next" URL out of a Link header and make it relative to /api/v1/.
 * Example header: <https://canvas.cmu.edu/api/v1/courses?page=2&per_page=100>; rel="next", <...>; rel="last"
 * Returns "courses?page=2&per_page=100", or null when there is no next page.
 */
export function nextPathFromLink(link: string | null): string | null {
  if (!link) return null
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]*)>\s*;\s*rel="?next"?/)
    if (!match) continue
    const marker = '/api/v1/'
    const at = match[1].indexOf(marker)
    return at === -1 ? null : match[1].slice(at + marker.length)
  }
  return null
}

/** Shared by both fetchers: turn an HTTP response into a page, or a clear error. */
async function readPage(res: Response, next: string | null, authMessage: string) {
  if (res.status === 401) throw new CanvasAuthError(authMessage)
  if (!res.ok) throw new CanvasHttpError(res.status, `Canvas answered ${res.status}`)
  return { data: parseCanvasJson(await res.text()), next }
}

/** For the bookmarklet: same-origin requests on canvas.cmu.edu, authenticated by the session cookie. */
export function sameOriginFetcher(): PageFetcher {
  return async (path) => {
    const res = await fetch('/api/v1/' + path, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    return readPage(res, nextPathFromLink(res.headers.get('Link')), 'Log in to Canvas first')
  }
}

/**
 * For the Chrome extension: full-URL requests to `origin` (e.g. "https://canvas.cmu.edu"). The extension has a host
 * permission for Canvas, so Chrome attaches the student's Canvas cookies and lets us read the Link header.
 */
export function absoluteFetcher(origin: string): PageFetcher {
  return async (path) => {
    const res = await fetch(origin + '/api/v1/' + path, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    return readPage(res, nextPathFromLink(res.headers.get('Link')), 'Log in to Canvas first')
  }
}

/** Follow `next` links until the last page and return all rows in one array. */
export async function fetchAll(fetchPage: PageFetcher, path: string): Promise<unknown[]> {
  const rows: unknown[] = []
  let next: string | null = path
  // Safety cap so a buggy server that always returns a next link cannot loop forever.
  for (let pages = 0; next !== null && pages < 50; pages++) {
    const page: { data: unknown; next: string | null } = await fetchPage(next)
    if (!Array.isArray(page.data)) throw new Error('Canvas returned something that is not a list')
    rows.push(...page.data)
    next = page.next
  }
  return rows
}

/** Run `fn` on every item with at most `limit` running at once; results keep the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++ // safe: JS is single-threaded, no await between read and increment
      results[i] = await fn(items[i], i)
    }
  }
  const workers = []
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker())
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------- raw Canvas shapes (only the fields we use)
// Everything is optional because this is data from the network: never trust it to be complete.

interface RawEnrollment {
  type?: string
  computed_current_score?: number | null
  computed_current_grade?: string | null
  computed_current_letter_grade?: string | null
  has_grading_periods?: boolean
  totals_for_all_grading_periods_option?: boolean
  current_period_computed_current_score?: number | null
  current_period_computed_current_grade?: string | null
}
interface RawCourse {
  id?: number | string
  name?: string
  course_code?: string
  original_name?: string
  term?: { name?: string } | null
  apply_assignment_group_weights?: boolean
  grading_standard_id?: number | string | null
  hide_final_grades?: boolean
  enrollments?: RawEnrollment[]
}
interface RawSubmission {
  score?: number | null
  excused?: boolean | null
  missing?: boolean
  workflow_state?: string
}
interface RawAssignment {
  id?: number | string
  name?: string
  points_possible?: number | null
  grading_type?: string
  omit_from_final_grade?: boolean
  hide_in_gradebook?: boolean
  published?: boolean
  due_at?: string | null
  html_url?: string
  submission?: RawSubmission | null
}
interface RawGroup {
  id?: number | string
  name?: string
  group_weight?: number | null
  rules?: { drop_lowest?: number; drop_highest?: number; never_drop?: (number | string)[] } | null
  assignments?: RawAssignment[]
}
interface RawStandard {
  id?: number | string
  grading_scheme?: { name?: string; value?: number }[]
}

// ---------------------------------------------------------------- mapping helpers (pure, exported for tests)

/** A finite number, or null for anything else (null, undefined, NaN, strings). */
function numOrNull(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}

/** Canvas enrollments list "student" when include[]=total_scores is used; older shapes say "StudentEnrollment". */
function isStudent(e: RawEnrollment): boolean {
  return e.type === 'student' || e.type === 'StudentEnrollment'
}

/** A course can have two student enrollments (two sections): use the first one that has a score. */
export function pickEnrollment(course: RawCourse): RawEnrollment | null {
  const students = (course.enrollments ?? []).filter(isStudent)
  return students.find((e) => numOrNull(e.computed_current_score) !== null) ?? students[0] ?? null
}

/** Our status rule, in priority order. Excused wins over everything because Canvas ignores excused work. */
export function itemStatus(sub: RawSubmission | null | undefined): ItemStatus {
  if (!sub) return 'unsubmitted'
  if (sub.excused) return 'excused'
  // A quiz "pending review" can carry a partial score, but Canvas leaves it out of the current grade until a
  // grader finishes it (lib/grade_calculator.rb), so we treat it as submitted-and-waiting too.
  if (sub.workflow_state === 'pending_review') return 'submitted'
  if (numOrNull(sub.score) !== null) return 'graded'
  if (sub.missing) return 'missing'
  if (sub.workflow_state === 'submitted') return 'submitted'
  return 'unsubmitted'
}

export function mapAssignment(a: RawAssignment, groupId: string): SyncedItem {
  const sub = a.submission ?? null
  return {
    id: String(a.id),
    name: a.name ?? 'Untitled',
    categoryId: groupId,
    score: sub?.workflow_state === 'pending_review' ? null : numOrNull(sub?.score), // see itemStatus
    max: numOrNull(a.points_possible),
    status: itemStatus(sub),
    due: a.due_at ?? null,
    // Three different Canvas switches all mean "this does not count toward the grade".
    omit: Boolean(a.omit_from_final_grade) || a.grading_type === 'not_graded' || Boolean(a.hide_in_gradebook),
    url: typeof a.html_url === 'string' && a.html_url.startsWith(CANVAS_ORIGIN + '/') ? a.html_url : null,
  }
}

/** One assignment group -> one category plus its published assignments. */
export function mapGroup(g: RawGroup): { category: SyncedCategory; items: SyncedItem[] } {
  const id = String(g.id)
  const rules = g.rules ?? {}
  return {
    category: {
      id,
      name: g.name ?? 'Assignments',
      // Kept even for unweighted courses; the grade math ignores weights when course.weighted is false.
      weight: numOrNull(g.group_weight),
      dropLowest: numOrNull(rules.drop_lowest) ?? 0,
      dropHighest: numOrNull(rules.drop_highest) ?? 0,
      neverDrop: (rules.never_drop ?? []).map(String),
    },
    // Unpublished assignments are invisible to students in Canvas, so skip them too.
    items: (g.assignments ?? []).filter((a) => a.published !== false).map((a) => mapAssignment(a, id)),
  }
}

/**
 * Canvas stores cutoffs as 0-1 fractions (0.9317). We want percents (93.17), sorted highest first.
 * Rounding removes float noise like 93.17000000000002.
 */
export function mapScheme(standard: RawStandard): GradeCut[] {
  return (standard.grading_scheme ?? [])
    .filter((row) => typeof row.name === 'string' && numOrNull(row.value) !== null)
    .map((row) => ({ letter: row.name as string, min: Math.round((row.value as number) * 1e6) / 1e4 }))
    .sort((a, b) => b.min - a.min)
}

/** Everything about a course that comes from the course list alone (no assignments yet). */
export function mapCourse(c: RawCourse, syncedAt: string): SyncedCourse {
  const id = String(c.id)
  // When a student sets a nickname, `name` is the nickname and `original_name` the real title.
  const title = (c.original_name || c.name || c.course_code || 'Canvas course').trim()
  const { number, also } = parseCourseNumbers(c.course_code, c.original_name, c.name)
  const termName = c.term?.name ?? null
  const enrollment = pickEnrollment(c)
  // hide_final_grades means the instructor hid totals: do not show a number the student cannot see in Canvas.
  const hidden = Boolean(c.hide_final_grades)
  // Courses split into grading periods can hide the all-periods total; Canvas then shows the current period.
  const periodOnly = Boolean(enrollment?.has_grading_periods) && enrollment?.totals_for_all_grading_periods_option === false
  return {
    source: 'canvas',
    sourceId: id,
    number,
    alsoNumbers: also,
    title,
    term: !termName || termName === 'Default Term' ? null : termName,
    url: `${CANVAS_ORIGIN}/courses/${id}`,
    weighted: Boolean(c.apply_assignment_group_weights),
    categories: [],
    items: [],
    canvasScore: hidden
      ? null
      : numOrNull(periodOnly ? enrollment?.current_period_computed_current_score : enrollment?.computed_current_score),
    canvasGrade: hidden
      ? null
      : periodOnly
        ? (enrollment?.current_period_computed_current_grade ?? null)
        : (enrollment?.computed_current_grade ?? enrollment?.computed_current_letter_grade ?? null),
    scheme: null,
    syncedAt,
  }
}

// ---------------------------------------------------------------- the sync

const COURSES_PATH =
  'courses?include[]=total_scores&include[]=term&include[]=current_grading_period_scores&enrollment_state=active&per_page=100'
const GROUPS_QUERY =
  'assignment_groups?include[]=assignments&include[]=submission&exclude_response_fields[]=description&exclude_response_fields[]=rubric&per_page=100'

/** Short reason for a warning, e.g. "Canvas answered 403". */
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Read every active course the student is enrolled in as a student, with assignments and letter scales. */
export async function syncCanvas(fetchPage: PageFetcher, onProgress?: (msg: string) => void): Promise<SyncPayload> {
  const progress = onProgress ?? (() => {})
  const at = new Date().toISOString()
  const warnings: string[] = []
  // Courses whose assignments could not be read. They stay in `courses` (the course-list numbers are still
  // good), but the app keeps its previously stored assignments for them instead of wiping them with [].
  const failedIds: string[] = []

  progress('Canvas: reading your course list')
  const rawCourses = (await fetchAll(fetchPage, COURSES_PATH)) as RawCourse[]
  // Skip courses where the student is a TA/teacher, and "access restricted" stubs that have no enrollments.
  const studentCourses = rawCourses.filter((c) => c && c.id != null && (c.enrollments ?? []).some(isStudent))

  let done = 0
  progress(`Canvas: 0 of ${studentCourses.length} courses`)
  const courses = await mapLimit(studentCourses, 4, async (raw) => {
    const course = mapCourse(raw, at)
    try {
      const groups = (await fetchAll(fetchPage, `courses/${course.sourceId}/${GROUPS_QUERY}`)) as RawGroup[]
      for (const g of groups) {
        const { category, items } = mapGroup(g)
        course.categories.push(category)
        course.items.push(...items)
      }
    } catch (err) {
      if (err instanceof CanvasAuthError) throw err // logged out mid-sync: the whole sync is invalid
      warnings.push(`${course.title}: could not read assignments (${reason(err)})`)
      failedIds.push(course.sourceId)
    }

    if (raw.grading_standard_id != null) {
      try {
        const standards = (await fetchAll(fetchPage, `courses/${course.sourceId}/grading_standards`)) as RawStandard[]
        const match = standards.find((s) => String(s.id) === String(raw.grading_standard_id))
        const cuts = match ? mapScheme(match) : []
        if (cuts.length > 0) course.scheme = cuts
        else warnings.push(`${course.title}: letter scale not found, using the default`)
      } catch (err) {
        if (err instanceof CanvasAuthError) throw err
        warnings.push(`${course.title}: could not read the letter scale (${reason(err)})`)
      }
    }

    done++
    progress(`Canvas: ${done} of ${studentCourses.length} courses`)
    return course
  })

  return { v: 1, kind: 'canvas', at, courses, warnings, failedIds }
}
