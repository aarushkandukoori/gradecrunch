// Reads a student's courses, assignment groups, scores and letter scales from the Canvas REST API
// and turns them into our SyncedCourse shape.
//
// The same code runs in two places, so it must not touch the DOM:
//   1. inside the Sync bookmarklet on canvas.cmu.edu (sameOriginFetcher, uses the student's session cookie)
//   2. in the Chrome extension's offscreen page (absoluteFetcher)
//   3. in Node tests with a fake PageFetcher
import type { GradeCut, ItemStatus, SyllabusDoc, SyncPayload, SyncedCategory, SyncedCourse, SyncedItem } from '../types'
import { CANVAS_ORIGIN } from '../lib/brand'
import { parseCourseNumbers, termSortKey } from '../lib/courseNumber'

/** Fetch one page of a Canvas API path (relative to /api/v1/, query included). `next` = next page path or null. */
export type PageFetcher = (path: string) => Promise<{ data: unknown; next: string | null }>

/**
 * Download one Canvas file as raw bytes. `path` is relative to the Canvas site, e.g. "/files/5/download?verifier=abc".
 * Canvas answers with a redirect to its file storage (inscloudgate.net); fetch follows it.
 */
export type BinaryFetcher = (path: string) => Promise<{ contentType: string | null; bytes: Uint8Array }>

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

/** Shared by both binary fetchers: the bytes, or the same errors the JSON fetchers throw. */
async function readBinary(res: Response) {
  if (res.status === 401) throw new CanvasAuthError('Log in to Canvas first')
  if (!res.ok) throw new CanvasHttpError(res.status, `Canvas answered ${res.status}`)
  return { contentType: res.headers.get('Content-Type'), bytes: new Uint8Array(await res.arrayBuffer()) }
}

/** Only paths on the Canvas site itself: the student's cookies go with these requests. */
function checkCanvasPath(path: string) {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Refused to fetch ' + path + ': not a Canvas path')
}

/** Bookmarklet: download a file same-origin (works because the bookmarklet runs on canvas.cmu.edu). */
export function sameOriginBinaryFetcher(): BinaryFetcher {
  return async (path) => {
    checkCanvasPath(path)
    return readBinary(await fetch(path, { credentials: 'same-origin' }))
  }
}

/**
 * Extension: download a file from `origin`. Canvas redirects to https://*.inscloudgate.net, so the extension needs that
 * (optional) host permission too, or Chrome blocks reading the answer. The caller only uses this when it was granted.
 */
export function absoluteBinaryFetcher(origin: string): BinaryFetcher {
  return async (path) => {
    checkCanvasPath(path)
    return readBinary(await fetch(origin + path, { credentials: 'include' }))
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

/** Extra things syncCanvas can read. Everything is off unless the caller turns it on. */
export interface SyncCanvasOptions {
  /**
   * Also read each course's syllabus (Syllabus page, home page, syllabus PDFs) so the app can find the real grading
   * weights. fetchBinary downloads PDFs; null = skip PDFs and read only the HTML pages.
   */
  syllabus?: { fetchBinary: BinaryFetcher | null }
}

/** Read every active course the student is enrolled in as a student, with assignments and letter scales. */
export async function syncCanvas(
  fetchPage: PageFetcher,
  onProgress?: (msg: string) => void,
  options: SyncCanvasOptions = {},
): Promise<SyncPayload> {
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

  if (options.syllabus) await addSyllabi(fetchPage, options.syllabus.fetchBinary, courses, warnings, progress)

  return { v: 1, kind: 'canvas', at, courses, warnings, failedIds }
}

// ---------------------------------------------------------------- syllabi
// Canvas's own grade is often wrong because the instructor never set up the group weights. The real weights are in
// the syllabus, which lives in one of three places: the Syllabus page, the course home page, or a PDF in Files.
// We collect all three as SyllabusDoc and let the app read the weights out of them.

const MAX_SYLLABUS_COURSES = 8 // a normal semester is 4-6 classes; older terms do not need weights
const MAX_PDFS_PER_COURSE = 2
const MAX_PDF_BYTES = 3 * 1024 * 1024 // a syllabus PDF is usually well under 1 MB
const MAX_TOTAL_PDF_BYTES = 5 * 1024 * 1024 // keeps the whole payload under the app's 10 MB limit (base64 adds a third)
const MAX_LINKED_FILES = 10 // file links per course we look up (a home page can link dozens of handouts)
const MAX_TEXT_CHARS = 100_000

interface RawFile {
  id?: number | string
  display_name?: string
  filename?: string
  'content-type'?: string
  size?: number
  url?: string
  locked_for_user?: boolean
}

/** Canvas answers 403/404 (and 401 for a hidden page) when a piece simply is not there or not visible: not a problem. */
function isMissing(err: unknown): boolean {
  return err instanceof CanvasAuthError || (err instanceof CanvasHttpError && [401, 403, 404].includes(err.status))
}

/** Add `syllabus` to up to MAX_SYLLABUS_COURSES numbered courses, newest terms first. Never throws. */
async function addSyllabi(
  fetchPage: PageFetcher,
  fetchBinary: BinaryFetcher | null,
  courses: SyncedCourse[],
  warnings: string[],
  progress: (msg: string) => void,
) {
  // sort is stable, so courses in the same term keep Canvas's order.
  const picked = courses
    .filter((c) => c.number !== null)
    .sort((a, b) => termSortKey(b.term) - termSortKey(a.term))
    .slice(0, MAX_SYLLABUS_COURSES)
  const pdfBudget = { left: MAX_TOTAL_PDF_BYTES } // shared by all courses
  let done = 0
  await mapLimit(picked, 3, async (course) => {
    const problems: string[] = []
    const docs = await collectSyllabus(fetchPage, fetchBinary, course.sourceId, pdfBudget, problems)
    if (docs.length > 0) course.syllabus = docs
    // At most one warning per course, so a sync never drowns in syllabus noise.
    if (problems.length > 0) warnings.push(`${course.title}: could not read the syllabus (${problems[0]})`)
    done++
    progress(`Canvas: read ${done} of ${picked.length} syllabi`)
  })
}

/** Everything we can find for one course. Missing pieces are skipped; real errors go into `problems`. */
export async function collectSyllabus(
  fetchPage: PageFetcher,
  fetchBinary: BinaryFetcher | null,
  courseId: string,
  pdfBudget: { left: number },
  problems: string[],
): Promise<SyllabusDoc[]> {
  const docs: SyllabusDoc[] = []
  const links: FileLink[] = [] // file links found in the two HTML pages

  /** Run one step; a missing piece is fine, anything else is noted. Returns null when it failed. */
  async function attempt<T>(step: () => Promise<T>): Promise<T | null> {
    try {
      return await step()
    } catch (err) {
      if (!isMissing(err)) problems.push(reason(err))
      return null
    }
  }

  // 1. The Syllabus page (Canvas's "Syllabus" tab).
  const info = (await attempt(() => fetchPage(`courses/${courseId}?include[]=syllabus_body`)))?.data
  const syllabusHtml = isObject(info) ? info.syllabus_body : null
  if (typeof syllabusHtml === 'string') {
    const text = htmlToText(syllabusHtml)
    if (text) docs.push({ source: 'canvas-syllabus', name: 'Syllabus page', url: `${CANVAS_ORIGIN}/courses/${courseId}/assignments/syllabus`, text })
    links.push(...findFileLinks(syllabusHtml))
  }

  // 2. The course home page (404 when the course has none).
  const front = (await attempt(() => fetchPage(`courses/${courseId}/front_page`)))?.data
  const frontPage = isObject(front) ? front : null
  if (frontPage && typeof frontPage.body === 'string') {
    const text = htmlToText(frontPage.body)
    const title = typeof frontPage.title === 'string' && frontPage.title.trim() ? frontPage.title.trim() : 'Home page'
    if (text) docs.push({ source: 'canvas-front-page', name: title, url: `${CANVAS_ORIGIN}/courses/${courseId}`, text })
    links.push(...findFileLinks(frontPage.body))
  }

  if (!fetchBinary) return docs // PDFs are off (extension without the extra permission)

  // 3. Syllabus PDFs: files named like "syllabus" (403 when the Files tab is hidden), then syllabus-looking links.
  const candidates: RawFile[] = []
  const search = (await attempt(() => fetchPage(`courses/${courseId}/files?search_term=syllabus&per_page=20`)))?.data
  if (Array.isArray(search)) candidates.push(...(search as RawFile[]))

  // Links whose text says "syllabus" first, so they are looked up even when the page links many other files.
  const seen = new Set(candidates.map((f) => String(f.id)))
  const toLookUp = uniqueLinks(links)
    .filter((l) => !seen.has(l.fileId))
    .sort((a, b) => Number(SYL.test(b.text)) - Number(SYL.test(a.text)))
    .slice(0, MAX_LINKED_FILES)
  for (const link of toLookUp) {
    // /api/v1/files/:id works even when the Files tab is hidden, for files the student can see.
    const meta = (await attempt(() => fetchPage(`files/${link.fileId}`)))?.data
    const file = isObject(meta) ? (meta as RawFile) : null
    if (file && (SYL.test(link.text) || SYL.test(file.display_name ?? ''))) candidates.push(file)
  }

  const taken = new Set<string>()
  for (const file of candidates) {
    if (docs.filter((d) => d.source === 'canvas-file').length >= MAX_PDFS_PER_COURSE) break
    const id = String(file.id)
    if (file.id == null || taken.has(id) || !isPdf(file) || file.locked_for_user) continue
    taken.add(id)
    const doc = await attempt(() => downloadPdf(fetchBinary, courseId, file, pdfBudget))
    if (typeof doc === 'string') problems.push(doc)
    else if (doc) docs.push(doc)
  }
  return docs
}

/** "syl" anywhere: "Syllabus", "sylb.pdf", "SYLLABUS_F26". */
const SYL = /syl/i

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isPdf(file: RawFile): boolean {
  const type = file['content-type']
  if (typeof type === 'string') return type.toLowerCase() === 'application/pdf'
  return /\.pdf$/i.test(file.display_name ?? file.filename ?? '') // older Canvas answers can leave the type out
}

/**
 * Download one PDF and wrap it as a SyllabusDoc. Returns a short reason string instead when we chose to skip it
 * for a reason the student should hear about (too big), and null when it was silently not usable.
 */
async function downloadPdf(
  fetchBinary: BinaryFetcher,
  courseId: string,
  file: RawFile,
  budget: { left: number },
): Promise<SyllabusDoc | string | null> {
  const name = file.display_name || file.filename || 'Syllabus.pdf'
  if (typeof file.size === 'number' && file.size > MAX_PDF_BYTES) return `${name} is over 3 MB`
  if (typeof file.url !== 'string') return null
  let path: string
  try {
    const url = new URL(file.url, CANVAS_ORIGIN)
    path = url.pathname + url.search // relative, so the fetcher sends it to its own Canvas origin
  } catch {
    return null
  }
  // Reserve space before downloading: up to three courses download at the same time.
  const reserved = typeof file.size === 'number' ? file.size : MAX_PDF_BYTES
  if (reserved > budget.left) return null // earlier PDFs used up the room; the HTML syllabi still count
  budget.left -= reserved
  let used = 0 // bytes we end up keeping; the rest of the reservation goes back to the budget
  try {
    const { bytes } = await fetchBinary(path)
    if (bytes.length > MAX_PDF_BYTES) return `${name} is over 3 MB`
    // Every PDF starts with "%PDF". Anything else (a login page, an error page) is not what we asked for.
    if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 4)) !== '%PDF') return null
    if (bytes.length > reserved + budget.left) return null // bigger than Canvas said, and no room left for it
    used = bytes.length
    return { source: 'canvas-file', name, url: `${CANVAS_ORIGIN}/courses/${courseId}/files/${String(file.id)}`, pdfBase64: bytesToBase64(bytes) }
  } finally {
    budget.left += reserved - used
  }
}

/** Standard base64 (what atob reads back). Converted in 32 KB slices: spreading a whole PDF overflows the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

// ---------------------------------------------------------------- HTML helpers (regex only: this code has no DOM)

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '-', mdash: '-', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', bull: '-', hellip: '...',
}

/** "&amp;" -> "&", "&#37;" -> "%", "&#x25;" -> "%". One pass, so "&amp;lt;" correctly becomes "&lt;". */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

/**
 * Turn a Canvas page's HTML into plain text, keeping the line structure so "Midterm 1: 20%" stays on its own line.
 * Paragraphs, line breaks, list items, table rows/cells and headings all become new lines; every other tag is dropped.
 * Example: "<p>Homework: <b>15%</b></p><ul><li>Quizzes 15%</li></ul>" -> "Homework: 15%\nQuizzes 15%"
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ') // code and styles are not words
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|td|th|h[1-6]|ul|ol|table|tbody|thead)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '') // every other tag (b, span, a, ...) just disappears
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // at most one blank line in a row
    .trim()
    .slice(0, MAX_TEXT_CHARS)
}

interface FileLink {
  fileId: string
  text: string // the link's visible text, e.g. "Course syllabus (PDF)"
}

/**
 * File links in a Canvas page: <a href="/courses/12/files/345?wrap=1">Syllabus</a>, or the full
 * https://canvas.cmu.edu/... form. Links to other sites are ignored.
 */
export function findFileLinks(html: string): FileLink[] {
  const links: FileLink[] = []
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = m[1].match(/\shref\s*=\s*["']([^"']*)["']/i)?.[1] ?? ''
    const file = decodeEntities(href).match(/^(?:https:\/\/(?:canvas\.cmu\.edu|cmu\.instructure\.com))?(?:\/courses\/\d+)?\/files\/(\d+)/)
    if (file) links.push({ fileId: file[1], text: htmlToText(m[2]).replace(/\s+/g, ' ') })
  }
  return links
}

/** One entry per file; when a file is linked twice, keep both texts so "Syllabus" in either one counts. */
function uniqueLinks(links: FileLink[]): FileLink[] {
  const byId = new Map<string, FileLink>()
  for (const l of links) {
    const old = byId.get(l.fileId)
    byId.set(l.fileId, old ? { fileId: l.fileId, text: (old.text + ' ' + l.text).trim() } : l)
  }
  return [...byId.values()]
}

/** A copy of the payload with the raw PDF bytes removed (for places that cannot hold megabytes, like a URL). */
export function withoutSyllabusPdfs(payload: SyncPayload): SyncPayload {
  return {
    ...payload,
    courses: payload.courses.map((c) =>
      c.syllabus ? { ...c, syllabus: c.syllabus.map(({ pdfBase64: _dropped, ...doc }) => doc) } : c,
    ),
  }
}
