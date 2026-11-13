// SIO sync: reads the student's own SIO "Grades and QPA" pages (HTML, same-origin) and turns them into SioSemester
// objects. SIO (Student Information Online, s3.andrew.cmu.edu/sio) is CMU's official record: every semester's courses
// with exact units, grade option (letter or pass/fail), mid-semester and final grades, and the official QPA.
//
// SIO has no student API. The Grades page shows one semester (the newest one with final grades) and has a semester
// picker; "?semester=F25" shows another one. So we read the home page, then every other semester in the picker, one
// at a time with a short pause. Columns are found by their header text, not their position, so a reordered table
// still reads right. Every lookup is defensive: a missing element gives null, it never throws.
//
// Runs in the bookmarklet (on s3.andrew.cmu.edu), in the extension's offscreen page and in jsdom tests, so it only
// uses DOMParser, no global `document`.

import type { Level, SioCourse, SioQpa, SioSemester, SyncPayload } from '../types'
import { SIO_ORIGIN } from '../lib/brand'
import { normalizeLetter } from '../lib/cmu'
import { parseCourseNumbers, termSortKey } from '../lib/courseNumber'
import { isFinished } from '../lib/sio'

/** Pause between semester pages, so SIO sees a few gentle requests, not a burst. */
export const SIO_PAUSE_MS = 300

/** The Grades and QPA page. With no ?semester= it shows the newest semester that has final grades. */
export const SIO_HOME_PATH = '/sio/mpa/grades/home'

/** One semester in the picker. */
export interface SioOption {
  code: string // "F26"
  label: string // "Fall 2026"
  level: Level // from the picker group ("UNDERGRADUATE" / "GRADUATE")
  selected: boolean // the semester this page is showing
}

/** What one Grades page holds. */
export interface SioPage {
  shownCode: string | null // the semester this page shows (the picker's selected option)
  heading: string | null // "Fall 2026", from the "Grades for Fall 2026" heading
  courses: SioCourse[]
  qpa: SioQpa
}

// ---------------------------------------------------------------- small helpers

function toDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

/** Text of an element with runs of whitespace collapsed; '' when the element is missing. */
function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** A header's text as a key: letters only, uppercase. "GRADE<br>OPTION" -> "GRADEOPTION", "MID-SEM" -> "MIDSEM". */
function headerKey(el: Element): string {
  return textOf(el).toUpperCase().replace(/[^A-Z]/g, '')
}

/** "11.0" -> 11. "NA", "" or anything else -> null. */
function numberOf(text: string): number | null {
  const t = text.replace(/,/g, '').trim()
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null
}

/** A grade like "A", "B+", "P", "W" or "AD". "NA", blank and anything odd -> null. */
function gradeOf(text: string): string | null {
  const g = normalizeLetter(text)
  return g !== 'NA' && /^[A-Z]{1,3}[+-]?$/.test(g) ? g : null
}

// ---------------------------------------------------------------- the semester picker

/** True when the page is the Grades page. Logged-out visitors get CMU's login page instead. */
function isGradesDoc(doc: Document): boolean {
  return doc.querySelector('#grades-semester-code-select') !== null
}

export function isGradesPage(html: string): boolean {
  return isGradesDoc(toDoc(html))
}

/**
 * Every semester in the picker, in page order. Options that are not a semester are left out: "Advanced Placement"
 * (AP credit lives on another SIO page, with no course rows here) and anything else whose label is not a term.
 */
export function parseSemesterOptions(html: string): SioOption[] {
  return optionsOf(toDoc(html))
}

function optionsOf(doc: Document): SioOption[] {
  const out: SioOption[] = []
  for (const option of Array.from(doc.querySelectorAll('#grades-semester-code-select option'))) {
    const code = (option.getAttribute('value') ?? '').trim()
    const label = textOf(option)
    if (!/^[A-Za-z0-9]{1,10}$/.test(code) || termSortKey(label) < 0) continue
    if (out.some((o) => o.code === code)) continue
    // "UNDERGRADUATE" also contains "GRADUATE", so look for "UNDER" first.
    const group = (option.closest('optgroup')?.getAttribute('label') ?? '').toUpperCase()
    const level: Level = group.includes('GRAD') && !group.includes('UNDER') ? 'grad' : 'undergrad'
    out.push({ code, label, level, selected: option.hasAttribute('selected') })
  }
  return out
}

// ---------------------------------------------------------------- one semester page

type CourseField = 'title' | 'number' | 'option' | 'units' | 'mid' | 'final'

/** Which course field a header names. */
function courseField(key: string): CourseField | null {
  if (key.startsWith('MID')) return 'mid'
  if (key.startsWith('FINAL')) return 'final'
  if (key.includes('OPTION')) return 'option'
  if (key.startsWith('UNIT')) return 'units'
  if (key.includes('NUMBER')) return 'number'
  if (key.startsWith('COURSE') || key === 'TITLE') return 'title'
  return null
}

/** Which QPA number a header names. */
function qpaField(key: string): keyof SioQpa | null {
  if (key.startsWith('MID')) return 'midSemQpa'
  if (key.includes('CARRIED')) return 'unitsCarried'
  if (key.includes('PASSED')) return 'unitsPassed'
  if (key.includes('FACTORABLE')) return 'factorableUnits'
  if (key.includes('QUALITY')) return 'qualityPoints'
  if (key.startsWith('CUMULATIVE')) return 'cumulativeQpa'
  if (key.startsWith('FINAL')) return 'finalQpa'
  return null
}

/** The header cells of a table and its data rows (rows with <td> cells). */
function tableParts(table: Element | null): { headers: Element[]; rows: Element[][] } {
  if (!table) return { headers: [], rows: [] }
  const all = Array.from(table.querySelectorAll('tr'))
  const headerRow = all.find((r) => r.classList.contains('header-row')) ?? all.find((r) => r.querySelector('th'))
  const headers = headerRow ? Array.from(headerRow.querySelectorAll('th, td')) : []
  const rows = all.filter((r) => r !== headerRow).map((r) => Array.from(r.querySelectorAll('td'))).filter((cells) => cells.length > 0)
  return { headers, rows }
}

/** The first table that has a header for every one of `keys`, if the expected id is missing. */
function tableWithHeaders(doc: Document, id: string, keys: string[]): Element | null {
  const byId = doc.getElementById(id)
  if (byId) return byId
  return (
    Array.from(doc.querySelectorAll('table')).find((t) => {
      const have = tableParts(t).headers.map(headerKey)
      return keys.every((k) => have.some((h) => h.startsWith(k)))
    }) ?? null
  )
}

/** "21-241 F" -> number 21241, section F. "10-335/615 A" also gives 10615 as a cross-listed number. */
function numberAndSection(text: string): { number: string | null; alsoNumbers: string[]; section: string | null } {
  const [first = '', ...rest] = text.split(' ')
  const { number, also } = parseCourseNumbers(first)
  const last = rest.at(-1) ?? ''
  return { number, alsoNumbers: also, section: /^[A-Za-z0-9]{1,4}$/.test(last) ? last.toUpperCase() : null }
}

function parseCourses(doc: Document): SioCourse[] {
  const { headers, rows } = tableParts(tableWithHeaders(doc, 'semester-grades-table', ['COURSE', 'NUMBER']))
  const fields = headers.map((h) => courseField(headerKey(h)))
  const courses: SioCourse[] = []
  for (const cells of rows) {
    const value: Partial<Record<CourseField, string>> = {}
    cells.forEach((cell, i) => {
      const field = fields[i]
      if (field && value[field] === undefined) value[field] = textOf(cell)
    })
    const { number, alsoNumbers, section } = numberAndSection(value.number ?? '')
    const units = numberOf(value.units ?? '')
    // A real course has a number (or at least units). This skips message rows like "No grades to show".
    if (number === null && units === null) continue
    const option = (value.option ?? '').toUpperCase()
    courses.push({
      title: value.title ?? '',
      number,
      alsoNumbers,
      section,
      gradeOption: /^[A-Z]{1,3}$/.test(option) ? option : null,
      units,
      midGrade: gradeOf(value.mid ?? ''),
      finalGrade: gradeOf(value.final ?? ''),
    })
  }
  return courses
}

/**
 * The QPA row. For the semester in progress SIO shows 0.00 for units, quality points and QPA: that means "not all
 * final grades yet", so for a semester that isn't finished (isFinished: a course still has no final grade, even if a
 * mini course or a W already has one) those become null instead of zero. The same goes for a 0.00 mid-semester QPA
 * with no mid-semester grades, a 0.00 semester QPA with no factorable units, and a 0.00 cumulative QPA with no history
 * behind it.
 */
function parseQpa(doc: Document, courses: SioCourse[]): SioQpa {
  const qpa: SioQpa = {
    midSemQpa: null,
    unitsCarried: null,
    unitsPassed: null,
    factorableUnits: null,
    qualityPoints: null,
    finalQpa: null,
    cumulativeQpa: null,
  }
  const { headers, rows } = tableParts(tableWithHeaders(doc, 'qpa-table', ['CUMULATIVE']))
  const cells = rows[0] ?? []
  headers.forEach((h, i) => {
    const field = qpaField(headerKey(h))
    if (field && cells[i]) qpa[field] = numberOf(textOf(cells[i]))
  })

  const zeroToNull = (n: number | null) => (n === 0 ? null : n)
  if (!isFinished({ courses })) {
    qpa.unitsCarried = zeroToNull(qpa.unitsCarried)
    qpa.unitsPassed = zeroToNull(qpa.unitsPassed)
    qpa.factorableUnits = zeroToNull(qpa.factorableUnits)
    qpa.qualityPoints = zeroToNull(qpa.qualityPoints)
    qpa.finalQpa = zeroToNull(qpa.finalQpa)
  }
  if (!courses.some((c) => c.midGrade !== null)) qpa.midSemQpa = zeroToNull(qpa.midSemQpa)
  if (!((qpa.factorableUnits ?? 0) > 0)) {
    qpa.finalQpa = zeroToNull(qpa.finalQpa)
    qpa.cumulativeQpa = zeroToNull(qpa.cumulativeQpa)
  }
  return qpa
}

/** Courses, QPA and which semester one Grades page shows. */
export function parseSemesterPage(html: string): SioPage {
  return pageOf(toDoc(html))
}

function pageOf(doc: Document): SioPage {
  const selected = doc.querySelector('#grades-semester-code-select option[selected]')
  // "Grades for  Fall 2026" (SIO puts newlines and extra spaces in its headings).
  const heading = Array.from(doc.querySelectorAll('h2'))
    .map((h) => textOf(h).match(/^Grades for (.+)$/i)?.[1] ?? null)
    .find((label) => label !== null)
  const courses = parseCourses(doc)
  return {
    shownCode: selected ? (selected.getAttribute('value') ?? '').trim() || null : null,
    heading: heading ?? null,
    courses,
    qpa: parseQpa(doc, courses),
  }
}

// ---------------------------------------------------------------- full sync

/** The message every reader uses for "you are logged out" (the extension turns it into a login link). */
const LOGGED_OUT = 'Log in to SIO first'

/** True when a page came from SIO itself (a logged-out request ends up on CMU's login site instead). */
function onSio(url: string): boolean {
  if (!url) return true // test fakes and old browsers may not say
  try {
    return new URL(url).origin === SIO_ORIGIN
  } catch {
    return false
  }
}

/** Does this page show the semester we asked for? (SIO shows its default semester for a code it doesn't know.) */
function shows(page: SioPage, option: SioOption): boolean {
  return page.shownCode !== null ? page.shownCode === option.code : page.heading === option.label
}

/**
 * Read every semester. `fetchPage(path)` fetches a path on s3.andrew.cmu.edu and returns the HTML and the final URL
 * after redirects; it throws "Log in to SIO first" when it can tell the student is logged out (SIO sends them to
 * CMU's login site) and another error for anything else. A semester that can't be read becomes a warning, and its
 * code goes in failedIds so the app keeps the copy it already has.
 */
export async function syncSio(
  fetchPage: (path: string) => Promise<{ html: string; url: string }>,
  onProgress?: (msg: string) => void,
  pauseMs = SIO_PAUSE_MS, // tests pass 0
): Promise<SyncPayload> {
  const progress = onProgress ?? (() => {})
  progress('SIO: reading your semesters')

  const home = await fetchPage(SIO_HOME_PATH)
  const homeDoc = toDoc(home.html)
  if (!onSio(home.url) || !isGradesDoc(homeDoc)) throw new Error(LOGGED_OUT)

  const options = optionsOf(homeDoc)
  const homePage = pageOf(homeDoc)
  const at = new Date().toISOString()
  const semesters: SioSemester[] = []
  const warnings: string[] = []
  const failedIds: string[] = [] // semesters we could not read: the app keeps their previously stored copy
  if (options.length === 0) warnings.push("SIO: couldn't find your semesters on the Grades page")

  for (const [i, option] of options.entries()) {
    progress(`SIO: ${i + 1} of ${options.length} semesters`)
    let page = homePage
    if (!shows(homePage, option)) {
      if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs))
      try {
        const res = await fetchPage(`${SIO_HOME_PATH}?semester=${encodeURIComponent(option.code)}`)
        // Sent to the login site halfway through: every later page would fail too, so stop the whole sync.
        if (!onSio(res.url)) throw new Error(LOGGED_OUT)
        const doc = toDoc(res.html)
        if (!isGradesDoc(doc)) throw new Error('got a different page instead of your grades')
        page = pageOf(doc)
        if (!shows(page, option)) throw new Error('SIO showed a different semester')
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        if (why === LOGGED_OUT) throw err
        warnings.push(`SIO: couldn't read ${option.label} (${why})`)
        failedIds.push(option.code)
        continue
      }
    }
    semesters.push({ code: option.code, term: option.label, level: option.level, courses: page.courses, qpa: page.qpa })
  }

  return { v: 1, kind: 'sio', at, courses: [], semesters, warnings, failedIds }
}
