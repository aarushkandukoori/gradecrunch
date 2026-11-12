// Gradescope sync: reads the student's own Gradescope pages (HTML, same-origin) and turns them into
// SyncedCourse objects. Gradescope has no student API, so we parse the home page (course list) and each
// course page (assignment table). Gradescope changes its markup now and then, so every lookup here is
// defensive: a missing optional element gives null / gets skipped, it never throws.
//
// Runs in the bookmarklet (on www.gradescope.com) and in jsdom tests, so it only uses DOMParser, no
// global `document`.

import type { ItemStatus, SyncedCourse, SyncedItem, SyncPayload } from '../types'
import { GRADESCOPE_ORIGIN } from '../lib/brand'
import { parseCourseNumbers } from '../lib/courseNumber'

/** One course box from the Gradescope home page. */
export interface GsCourseRef {
  id: string
  shortName: string
  name: string
  term: string | null
  url: string
}

// ---------------------------------------------------------------- small helpers

/** Parse an HTML string into its own document (never touches the live page). */
function toDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

/** Text of an element with runs of whitespace collapsed; '' when the element is missing. */
function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Normalized assignment name used as the item id. Lowercase letters and digits only, and leading zeros
 * dropped in digit runs, so "HW01" and "hw 1" give the same id.
 * (Kept local so this module does not depend on the merge module.)
 */
function slugName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/\d+/g, (digits) => String(Number(digits)))
}

/** Run `work` over `list` with at most `limit` running at once; results keep the input order. */
async function mapLimit<T, R>(list: T[], limit: number, work: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(list.length)
  let next = 0
  async function worker() {
    while (next < list.length) {
      const i = next++ // safe: JS is single-threaded, no await between read and increment
      results[i] = await work(list[i], i)
    }
  }
  const workers = []
  for (let w = 0; w < Math.min(limit, list.length); w++) workers.push(worker())
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------- dates

/**
 * Gradescope `datetime` attributes look like "2026-09-11 23:59:00 -0400".
 * Returns ISO 8601 with offset ("2026-09-11T23:59:00-04:00"), or null when the text is not in that shape.
 */
export function parseGsDate(s: string | null | undefined): string | null {
  if (!s) return null
  const m = s
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(?:([+-])(\d{2}):?(\d{2})|(Z|UTC))$/i)
  if (!m) return null
  const [, y, mo, d, h, mi, sec = '00', sign, oh, om, zulu] = m
  // Reject impossible values the regex alone lets through (month 13, hour 25, ...).
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +sec > 59) return null
  const offset = zulu ? '+00:00' : `${sign}${oh}:${om}`
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${sec}${offset}`
  // Final check: a real calendar date (catches Feb 31 style input, which Date rolls over).
  const back = new Date(`${y}-${mo}-${d}T00:00:00Z`)
  if (Number.isNaN(back.getTime()) || back.getUTCDate() !== +d) return null
  return iso
}

// ---------------------------------------------------------------- home page: course list

/**
 * The nearest heading (h1-h6) that comes before `el` in document order, or null.
 * Used to tell "Instructor Courses" lists apart from "Student Courses" lists.
 */
function nearestHeadingBefore(el: Element): Element | null {
  let node: Element | null = el
  while (node) {
    let sib = node.previousElementSibling
    while (sib) {
      if (/^H[1-6]$/.test(sib.tagName)) return sib
      // A sibling that wraps headings (e.g. a header div): its last heading is the closest one.
      const inner = sib.querySelectorAll('h1, h2, h3, h4, h5, h6')
      if (inner.length > 0) return inner[inner.length - 1]
      sib = sib.previousElementSibling
    }
    node = node.parentElement // nothing before us at this level: look before our parent
  }
  return null
}

/** True when the home page HTML has a course list at all (it does not when logged out). */
export function hasCourseList(html: string): boolean {
  return toDoc(html).querySelector('.courseList') !== null
}

/**
 * Active courses the user takes as a student, from the Gradescope home page.
 * Skips instructor/TA lists and the "See older courses" (inactive) section.
 */
export function parseCourseList(html: string): GsCourseRef[] {
  const doc = toDoc(html)
  const out: GsCourseRef[] = []
  const seen = new Set<string>()

  for (const list of Array.from(doc.querySelectorAll('.courseList'))) {
    // Accounts that are also TAs get an "Instructor Courses" list: those are not the student's grades.
    if (/instructor/i.test(textOf(nearestHeadingBefore(list)))) continue

    for (const box of Array.from(list.querySelectorAll('a.courseBox'))) {
      if (box.closest('.courseList--inactiveCourses')) continue // old terms
      // A disabled box means the school wants you to open this course from Canvas first (LMS login).
      if (box.classList.contains('disabled')) continue

      // The "add a course" tile and anything odd have no /courses/<id> link: skip them.
      const href = box.getAttribute('href') ?? ''
      const idMatch = href.match(/\/courses\/(\d+)/)
      if (!idMatch) continue
      const id = idMatch[1]
      if (seen.has(id)) continue
      seen.add(id)

      // The term label is the element right before this term's group of course boxes.
      const group = box.closest('.courseList--coursesForTerm')
      const termEl = group?.previousElementSibling
      const term = termEl?.classList.contains('courseList--term') ? textOf(termEl) || null : null

      const shortName = textOf(box.querySelector('.courseBox--shortname'))
      const name = textOf(box.querySelector('.courseBox--name')) || shortName

      out.push({ id, shortName, name, term, url: `${GRADESCOPE_ORIGIN}/courses/${id}` })
    }
  }
  return out
}

// ---------------------------------------------------------------- course page: assignments

/** Map Gradescope's status text to our ItemStatus (used only when there is no score). */
function statusFromText(text: string): ItemStatus {
  const t = text.toLowerCase()
  if (t.includes('ungraded')) return 'ungraded' // check before "graded"-like words
  if (t.includes('submitted')) return 'submitted'
  // "No Submission" and anything unknown. Gradescope shows no "missing" flag, so we never claim one.
  return 'unsubmitted'
}

/** The regular due date of a row. A late due date (class contains "lateDueDate") is ignored. */
function dueOf(row: Element): string | null {
  for (const time of Array.from(row.querySelectorAll('time'))) {
    const cls = time.getAttribute('class') ?? ''
    if (/lateDueDate/i.test(cls)) continue
    if (/dueDate/i.test(cls)) return parseGsDate(time.getAttribute('datetime'))
  }
  return null
}

/** Parse one assignment row; null when the row has no name (not an assignment). */
function parseRow(row: Element): SyncedItem | null {
  // The name cell is a <th> (sometimes a <td> in older markup); it holds a link only when submitted.
  const nameCell = row.querySelector('th') ?? row.querySelector('td')
  const name = textOf(nameCell)
  if (!nameCell || !name) return null

  const link = nameCell.querySelector('a')
  const href = link?.getAttribute('href') ?? ''
  // The id is always name-based, never the assignment number from the link: an assignment has no link
  // until you submit it, so a link-based id would change on submission and lose the student's what-ifs
  // and other per-item settings. parseCoursePage adds "#2", "#3" when two rows share a name.
  const id = `name:${slugName(name)}`
  // Only trust relative Gradescope links; anything else could point off-site.
  const url = href.startsWith('/courses/') ? GRADESCOPE_ORIGIN + href : null

  const statusCell = row.querySelector('.submissionStatus')
  const scoreText = textOf(statusCell?.querySelector('.submissionStatus--score'))
  const scoreMatch = scoreText.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/)

  let score: number | null = null
  let max: number | null = null
  let status: ItemStatus
  if (scoreMatch) {
    score = Number(scoreMatch[1])
    max = Number(scoreMatch[2])
    status = 'graded'
  } else {
    // Prefer the dedicated text div; fall back to the whole cell's text.
    const statusText = textOf(statusCell?.querySelector('.submissionStatus--text')) || textOf(statusCell)
    status = statusFromText(statusText)
  }

  // categoryId null: the merge step infers categories from names.
  return { id, name, categoryId: null, score, max, status, due: dueOf(row), omit: false, url }
}

/** Title, term and assignment rows from a Gradescope course page. */
export function parseCoursePage(
  html: string,
  _courseId: string, // part of the shared signature; item ids only need to be unique within one course
): { term: string | null; title: string | null; items: SyncedItem[] } {
  const doc = toDoc(html)
  const title = textOf(doc.querySelector('.courseHeader--title')) || null
  const term = textOf(doc.querySelector('.courseHeader--term')) || null

  // The student table has a known id; if Gradescope renames it, fall back to any table body rows.
  let rows = Array.from(doc.querySelectorAll('#assignments-student-table tbody tr'))
  if (rows.length === 0) rows = Array.from(doc.querySelectorAll('table tbody tr'))

  const items: SyncedItem[] = []
  const usedIds = new Set<string>()
  for (const row of rows) {
    const item = parseRow(row)
    if (!item) continue
    // Two rows with the same name would share an id: make the later ones unique ("name:quiz#2").
    let id = item.id
    for (let n = 2; usedIds.has(id); n++) id = `${item.id}#${n}`
    usedIds.add(id)
    items.push({ ...item, id })
  }
  return { term, title, items }
}

/**
 * True when the HTML really is a course page (it has the course header or the student table).
 * When the session expires mid-sync, Gradescope serves the login or home page for /courses/<id> instead,
 * which has no assignment rows and would otherwise look like a course with zero assignments.
 */
export function isCoursePage(html: string): boolean {
  const doc = toDoc(html)
  return doc.querySelector('.courseHeader, #assignments-student-table') !== null
}

/** True when the HTML is Gradescope's login form (it asks for a password). */
function isLoginPage(html: string): boolean {
  return toDoc(html).querySelector('input[type="password"], form[action*="/login"]') !== null
}

// ---------------------------------------------------------------- full sync

/** Thrown when Gradescope logs the student out partway through: the whole sync stops. */
class LoggedOutError extends Error {}

/**
 * Sync every active student course. `fetchText(path)` returns the HTML for a same-origin path
 * ("/" or "/courses/123") and throws on HTTP errors. A failing course becomes a warning, not a failed sync.
 */
export async function syncGradescope(
  fetchText: (path: string) => Promise<string>,
  onProgress?: (msg: string) => void,
): Promise<SyncPayload> {
  const progress = onProgress ?? (() => {})
  progress('Gradescope: reading your course list')

  const home = await fetchText('/')
  // Logged-out visitors get the marketing page, which has no course list.
  if (!hasCourseList(home)) throw new Error('Log in to Gradescope first')

  const refs = parseCourseList(home)
  const warnings: string[] = []
  const failedIds: string[] = [] // courses we could not read: the app keeps their previously stored copy
  const at = new Date().toISOString()
  let done = 0

  // One course page at a time with a short pause: Gradescope's terms ask for human-like request rates.
  const results = await mapLimit(refs, 1, async (ref, i): Promise<SyncedCourse | null> => {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      const html = await fetchText(`/courses/${ref.id}`)
      if (!isCoursePage(html)) {
        // The session ran out mid-sync: every later page would be the login page too, so stop the whole sync.
        if (isLoginPage(html)) throw new LoggedOutError('Log in to Gradescope first')
        throw new Error('got a different page instead of the course')
      }
      const page = parseCoursePage(html, ref.id)
      const { number, also } = parseCourseNumbers(ref.shortName, ref.name)
      return {
        source: 'gradescope',
        sourceId: ref.id,
        number,
        alsoNumbers: also,
        title: ref.name || page.title || ref.shortName,
        term: ref.term ?? page.term,
        url: ref.url,
        weighted: false, // Gradescope has no weights; the merge step uses Canvas's or the student's
        categories: [], // inferred later by the merge step
        items: page.items,
        canvasScore: null,
        canvasGrade: null,
        scheme: null,
        syncedAt: at,
      }
    } catch (err) {
      if (err instanceof LoggedOutError) throw err
      const why = err instanceof Error ? err.message : String(err)
      warnings.push(`Gradescope: couldn't read ${ref.shortName || ref.name || ref.id} (${why})`)
      failedIds.push(ref.id) // left out of `courses`, so tell the app to keep the stored copy
      return null
    } finally {
      done++
      progress(`Gradescope: ${done} of ${refs.length} courses`)
    }
  })

  const courses = results.filter((c): c is SyncedCourse => c !== null)
  return { v: 1, kind: 'gradescope', at, courses, warnings, failedIds }
}
