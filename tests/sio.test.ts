// Tests for SIO support: the page reader (src/sync/sio.ts), payload validation, saving it in the store, the merge
// rules (units, pass/fail, final grades, unregistered classes, SIO-only classes), the cumulative QPA math, the view
// helpers and the Past semesters page. The HTML follows the structure of SIO's real "Grades and QPA" page, but every
// course title and grade here is made up.
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { loadCatalog } from '../src/lib/catalog'
import { gradeCourse } from '../src/lib/grade'
import { buildCourses } from '../src/lib/merge'
import { cleanSioSemesters, decodePayload, encodePayload, validatePayload } from '../src/lib/payload'
import { computeQpa, estimatedLetter, letterWithBasis } from '../src/lib/qpa'
import {
  finishedSemesters,
  isFinished,
  levelFor,
  officialCumulative,
  priorFromSio,
  semesterTotals,
  termInProgress,
  withSioPrior,
} from '../src/lib/sio'
import { applyPayload, defaultStore, loadStore, parseStore, saveStore, withToggle } from '../src/lib/store'
import {
  isGradesPage,
  parseSemesterOptions,
  parseSemesterPage,
  SIO_HOME_PATH,
  SIO_PAUSE_MS,
  syncSio,
} from '../src/sync/sio'
import { notInSio, rowHint, sioRowNote, sourceText, splitCourses } from '../src/ui/view'
import type {
  Course,
  CoursePrefs,
  GradeResult,
  Level,
  ManualCourse,
  Settings,
  SioCourse,
  SioQpa,
  SioSemester,
  Store,
  SyncedCourse,
  SyncPayload,
} from '../src/types'

beforeAll(() => loadCatalog())

// ---------------------------------------------------------------- made-up SIO pages

const COURSE_HEADERS = ['COURSE', 'NUMBER', 'GRADE<br>OPTION', 'UNITS', 'MID-SEM', 'FINAL']
const QPA_HEADERS = ['MID-SEM QPA', 'UNITS CARRIED', 'UNITS PASSED', 'FACTORABLE UNITS', 'QUALITY POINTS', 'FINAL QPA', 'CUMULATIVE QPA']
type Group = [label: string, options: [code: string, label: string][]]
const UNDERGRAD: Group = [
  'UNDERGRADUATE',
  [
    ['F26', 'Fall 2026'],
    ['S26', 'Spring 2026'],
    ['F25', 'Fall 2025'],
  ],
]

function picker(selected: string, groups: Group[]): string {
  const option = ([code, label]: [string, string]) =>
    `<option value="${code}"${code === selected ? ' selected="selected"' : ''}>${label}</option>`
  return (
    `<select id="grades-semester-code-select" class="navigation-control" name="semester" aria-label="Semester">\n` +
    `  <option value="AP"${selected === 'AP' ? ' selected' : ''}>Advanced Placement</option>\n` +
    groups.map(([label, options]) => `  <optgroup label="${label}">${options.map(option).join('\n')}</optgroup>`).join('\n') +
    `\n</select>`
  )
}

function courseTable(rows: string[][], headers: string[]): string {
  const th = headers.map((h, i) => `<th${h === 'UNITS' ? ' class="text-right-sm-left"' : ''}><div class="grid-hdr column${i}">${h}</div></th>`)
  const tr = rows.map(
    (row) =>
      '<tr>' +
      row.map((cell, i) => `<td${i === 0 ? ' class="text-break"' : ''}><div class="${i === 0 ? 'font-weight-bold ' : ''}column${i}">${cell}</div></td>`).join('') +
      '</tr>',
  )
  return `<table id="semester-grades-table" class="grades-tbl table"><tbody>\n<tr class="header-row">${th.join('')}</tr>\n${tr.join('\n')}\n</tbody></table>`
}

function qpaTable(values: string[], headers = QPA_HEADERS): string {
  return (
    `<table id="qpa-table" class="qpa-tbl table"><tbody>` +
    `<tr class="header-row">${headers.map((h) => `<th>${h}</th>`).join('')}</tr>` +
    `<tr>${values.map((v) => `<td>${v}</td>`).join('')}</tr>` +
    `</tbody></table>`
  )
}

interface PageSpec {
  selected: string
  label: string
  rows: string[][]
  qpa: string[]
  groups?: Group[]
  headers?: string[]
}

/** A whole "Grades and QPA" page, with the extra bits the real one has (headings with odd spacing, hidden modals). */
function sioHtml(p: PageSpec): string {
  return `<!doctype html><html><head><title>SIO</title></head><body>
<nav>Student Information Online</nav>
<main>
${picker(p.selected, p.groups ?? [UNDERGRAD])}
<h2 class="page-title">
      Grades for
      ${p.label}
</h2>
${courseTable(p.rows, p.headers ?? COURSE_HEADERS)}
<h2 class="page-title">QPA for ${p.label}</h2>
${qpaTable(p.qpa)}
<h2 class="page-title">QPA as of 12 Nov 2026</h2>
<div id="qpa-chart"></div>
</main>
<div class="modal" style="display:none">SIO session expired. Your session is about to expire.</div>
</body></html>`
}

// The semester in progress: no final grades yet, so SIO shows 0.00 for units, quality points and the final QPA.
const FALL_26: PageSpec = {
  selected: 'F26',
  label: 'Fall 2026',
  rows: [
    ['Made-up Independent Study', '15-400 A', 'L', '12.0', 'NA', 'NA'],
    ['Matrices &amp; Made-up Things', '21-241 F', 'P', '11.0', 'B+', 'NA'],
    ['Made-up Writing', '76-101 K', 'L', '9.0', 'A-', 'NA'],
    ['Made-up Systems', '10-335/615 A', 'L', '12.0', 'C', 'NA'],
  ],
  qpa: ['3.25', '0.00', '0.00', '0.00', '0.00', '0.00', '3.56'],
}

// Finished semesters. Spring: 12 x A + 9 x B = 75 quality points on 21 factorable units (P and W don't count).
const SPRING_26: PageSpec = {
  selected: 'S26',
  label: 'Spring 2026',
  rows: [
    ['Made-up Programming', '15-122 B', 'L', '12.0', 'A', 'A'],
    ['Made-up Statistics', '36-200 C', 'L', '9.0', 'NA', 'B'],
    ['Made-up StuCo', '98-317 A', 'P', '3.0', 'NA', 'P'],
    ['Made-up Lab', '99-101 W', 'L', '4.5', 'NA', 'W'],
  ],
  qpa: ['3.50', '28.50', '24.00', '21.00', '75.00', '3.57', '3.56'],
}

// Fall: 12 x A + 10 x B = 78 quality points on 22 units.
const FALL_25: PageSpec = {
  selected: 'F25',
  label: 'Fall 2025',
  rows: [
    ['Made-up Intro', '15-112 A', 'L', '12.0', 'B', 'A'],
    ['Made-up Calculus', '21-120 D', 'L', '10.0', 'NA', 'B'],
  ],
  qpa: ['3.00', '22.00', '22.00', '22.00', '78.00', '3.55', '3.55'],
}

const LOGIN_PAGE = '<html><body><h1>CMU Web Login</h1><form><input name="j_username"></form></body></html>'

// ---------------------------------------------------------------- the reader

describe('SIO page reader', () => {
  test('isGradesPage: the Grades page has the semester picker, the login page does not', () => {
    expect(isGradesPage(sioHtml(FALL_26))).toBe(true) // even though the hidden modal says "session expired"
    expect(isGradesPage(LOGIN_PAGE)).toBe(false)
  })

  test('the semester picker: codes, labels, which one is shown; Advanced Placement is skipped', () => {
    expect(parseSemesterOptions(sioHtml(SPRING_26))).toEqual([
      { code: 'F26', label: 'Fall 2026', level: 'undergrad', selected: false },
      { code: 'S26', label: 'Spring 2026', level: 'undergrad', selected: true },
      { code: 'F25', label: 'Fall 2025', level: 'undergrad', selected: false },
    ])
  })

  test('a GRADUATE group marks its semesters grad (and UNDERGRADUATE stays undergrad)', () => {
    const html = sioHtml({
      ...FALL_26,
      groups: [
        ['GRADUATE', [['F26', 'Fall 2026']]],
        ['UNDERGRADUATE', [['S26', 'Spring 2026']]],
      ],
    })
    expect(parseSemesterOptions(html).map((o) => [o.code, o.level])).toEqual([
      ['F26', 'grad'],
      ['S26', 'undergrad'],
    ])
  })

  test('summer semesters keep their own codes and names', () => {
    const html = sioHtml({ ...FALL_26, groups: [['UNDERGRADUATE', [['N26', 'Summer Two 2026'], ['M26', 'Summer One 2026']]]] })
    expect(parseSemesterOptions(html).map((o) => o.code)).toEqual(['N26', 'M26'])
  })

  test('the semester in progress: final grades NA become null, and the 0.00 totals mean "not yet", not zero', () => {
    const page = parseSemesterPage(sioHtml(FALL_26))
    expect(page.shownCode).toBe('F26')
    expect(page.heading).toBe('Fall 2026')
    expect(page.courses[0]).toEqual({
      title: 'Made-up Independent Study',
      number: '15400',
      alsoNumbers: [],
      section: 'A',
      gradeOption: 'L',
      units: 12,
      midGrade: null,
      finalGrade: null,
    })
    expect(page.courses[1]).toMatchObject({ title: 'Matrices & Made-up Things', number: '21241', gradeOption: 'P', units: 11, midGrade: 'B+' })
    expect(page.courses[2].midGrade).toBe('A-')
    expect(page.qpa).toEqual({
      midSemQpa: 3.25,
      unitsCarried: null,
      unitsPassed: null,
      factorableUnits: null,
      qualityPoints: null,
      finalQpa: null,
      cumulativeQpa: 3.56, // SIO's official cumulative, through the last finished semester
    })
  })

  test('a final grade posted during the semester (a mini course, a W) keeps the 0.00 totals as "not yet"', () => {
    const rows = [
      ['Made-up Mini', '76-106 A', 'L', '4.5', 'NA', 'A'],
      ['Made-up Systems', '15-213 B', 'L', '12.0', 'NA', 'W'],
      ['Made-up Writing', '76-101 K', 'L', '9.0', 'A-', 'NA'],
    ]
    const page = parseSemesterPage(sioHtml({ ...FALL_26, rows }))
    expect(page.courses.map((c) => c.finalGrade)).toEqual(['A', 'W', null])
    expect(page.qpa).toMatchObject({ unitsCarried: null, unitsPassed: null, factorableUnits: null, qualityPoints: null, finalQpa: null, cumulativeQpa: 3.56 })
  })

  test('a finished semester keeps every number, and its NA mid-semester grades become null', () => {
    const page = parseSemesterPage(sioHtml(SPRING_26))
    expect(page.courses.map((c) => [c.number, c.units, c.midGrade, c.finalGrade, c.gradeOption])).toEqual([
      ['15122', 12, 'A', 'A', 'L'],
      ['36200', 9, null, 'B', 'L'],
      ['98317', 3, null, 'P', 'P'],
      ['99101', 4.5, null, 'W', 'L'],
    ])
    expect(page.qpa).toEqual({
      midSemQpa: 3.5,
      unitsCarried: 28.5,
      unitsPassed: 24,
      factorableUnits: 21,
      qualityPoints: 75,
      finalQpa: 3.57,
      cumulativeQpa: 3.56,
    })
  })

  test('a cross-listed number gives the other numbers too', () => {
    const page = parseSemesterPage(sioHtml(FALL_26))
    expect(page.courses[3]).toMatchObject({ number: '10335', alsoNumbers: ['10615'], section: 'A' })
    const other = parseSemesterPage(sioHtml({ ...FALL_26, rows: [['Made-up Course', '15-213/18-213 B', 'L', '12.0', 'NA', 'NA']] }))
    expect(other.courses[0]).toMatchObject({ number: '15213', alsoNumbers: ['18213'], section: 'B' })
  })

  test('columns are found by their header text, not their position', () => {
    const headers = ['FINAL', 'UNITS', 'COURSE', 'MID-SEM', 'NUMBER', 'GRADE<br>OPTION']
    const page = parseSemesterPage(sioHtml({ ...SPRING_26, headers, rows: [['B', '9.0', 'Made-up Statistics', 'B+', '36-200 C', 'L']] }))
    expect(page.courses).toEqual([
      { title: 'Made-up Statistics', number: '36200', alsoNumbers: [], section: 'C', gradeOption: 'L', units: 9, midGrade: 'B+', finalGrade: 'B' },
    ])
  })

  test('blank cells, NA and odd values become null; message rows are skipped', () => {
    const html = sioHtml({
      ...FALL_26,
      rows: [
        ['Made-up Seminar', '76-102', '', 'NA', '', ' NA '],
        ['No grades to show for this semester'],
      ],
      qpa: ['0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00'], // a first semester: no history at all yet
    })
    const page = parseSemesterPage(html)
    expect(page.courses).toEqual([
      { title: 'Made-up Seminar', number: '76102', alsoNumbers: [], section: null, gradeOption: null, units: null, midGrade: null, finalGrade: null },
    ])
    expect(page.qpa).toEqual({
      midSemQpa: null,
      unitsCarried: null,
      unitsPassed: null,
      factorableUnits: null,
      qualityPoints: null,
      finalQpa: null,
      cumulativeQpa: null,
    })
  })

  test('a finished pass/fail-only semester has no QPA, not a 0.00 one', () => {
    const html = sioHtml({
      ...SPRING_26,
      rows: [['Made-up StuCo', '98-317 A', 'P', '3.0', 'NA', 'P']],
      qpa: ['0.00', '3.00', '3.00', '0.00', '0.00', '0.00', '3.56'],
    })
    expect(parseSemesterPage(html).qpa).toMatchObject({ unitsCarried: 3, factorableUnits: 0, finalQpa: null, cumulativeQpa: 3.56 })
  })
})

describe('syncSio', () => {
  /** A fake SIO: the plain Grades page shows the newest finished semester; ?semester=CODE shows that one. */
  function fakeSio(overrides: Record<string, () => Promise<{ html: string; url: string }>> = {}) {
    const pages: Record<string, PageSpec> = { F26: FALL_26, S26: SPRING_26, F25: FALL_25 }
    const paths: string[] = []
    const fetchPage = vi.fn(async (path: string) => {
      paths.push(path)
      const code = new URL(path, 'https://s3.andrew.cmu.edu').searchParams.get('semester') ?? 'S26'
      if (overrides[code]) return overrides[code]()
      return { html: sioHtml(pages[code]), url: 'https://s3.andrew.cmu.edu' + path }
    })
    return { fetchPage, paths }
  }

  test('reads the Grades page, then every other semester, one at a time', async () => {
    const { fetchPage, paths } = fakeSio()
    const progress: string[] = []
    const payload = await syncSio(fetchPage, (m) => progress.push(m), 0)
    expect(paths).toEqual([SIO_HOME_PATH, `${SIO_HOME_PATH}?semester=F26`, `${SIO_HOME_PATH}?semester=F25`])
    expect(payload).toMatchObject({ v: 1, kind: 'sio', courses: [], warnings: [], failedIds: [] })
    expect(payload.semesters?.map((s) => [s.code, s.term, s.level, s.courses.length])).toEqual([
      ['F26', 'Fall 2026', 'undergrad', 4],
      ['S26', 'Spring 2026', 'undergrad', 4],
      ['F25', 'Fall 2025', 'undergrad', 2],
    ])
    expect(progress).toEqual(['SIO: reading your semesters', 'SIO: 1 of 3 semesters', 'SIO: 2 of 3 semesters', 'SIO: 3 of 3 semesters'])
    expect(SIO_PAUSE_MS).toBe(300) // the real sync waits this long between pages
  })

  test('logged out: SIO sends the request to CMU Web Login', async () => {
    const fetchPage = async () => ({ html: LOGIN_PAGE, url: 'https://login.cmu.edu/idp/profile/SAML2/Redirect/SSO' })
    await expect(syncSio(fetchPage, undefined, 0)).rejects.toThrow('Log in to SIO first')
  })

  test('logged out: a page on SIO without the semester picker', async () => {
    const fetchPage = async () => ({ html: LOGIN_PAGE, url: 'https://s3.andrew.cmu.edu/sio/mpa/grades/home' })
    await expect(syncSio(fetchPage, undefined, 0)).rejects.toThrow('Log in to SIO first')
  })

  test('logged out halfway through: the whole sync stops', async () => {
    const { fetchPage } = fakeSio({ F25: async () => ({ html: LOGIN_PAGE, url: 'https://login.cmu.edu/idp/x' }) })
    await expect(syncSio(fetchPage, undefined, 0)).rejects.toThrow('Log in to SIO first')
  })

  test('one semester that fails becomes a warning, and its code goes in failedIds', async () => {
    const { fetchPage } = fakeSio({
      F25: async () => {
        throw new Error('SIO returned an error (500)')
      },
    })
    const payload = await syncSio(fetchPage, undefined, 0)
    expect(payload.semesters?.map((s) => s.code)).toEqual(['F26', 'S26'])
    expect(payload.failedIds).toEqual(['F25'])
    expect(payload.warnings).toEqual(["SIO: couldn't read Fall 2025 (SIO returned an error (500))"])
  })

  test('SIO showing a different semester than the one asked for is not saved under the wrong name', async () => {
    const { fetchPage } = fakeSio({ F25: async () => ({ html: sioHtml(SPRING_26), url: 'https://s3.andrew.cmu.edu/x' }) })
    const payload = await syncSio(fetchPage, undefined, 0)
    expect(payload.failedIds).toEqual(['F25'])
    expect(payload.warnings[0]).toContain('SIO showed a different semester')
  })

  test('the payload passes the strict check unchanged', async () => {
    const { fetchPage } = fakeSio()
    const payload = await syncSio(fetchPage, undefined, 0)
    const { failedIds: _none, ...rest } = payload
    expect(validatePayload(JSON.parse(JSON.stringify(payload)))).toEqual(rest) // an empty failedIds is left out
  })
})

// ---------------------------------------------------------------- builders for the rest

function sioCourse(number: string | null, extra: Partial<SioCourse> = {}): SioCourse {
  return {
    title: `Made-up ${number ?? 'course'}`,
    number,
    alsoNumbers: [],
    section: 'A',
    gradeOption: 'L',
    units: 9,
    midGrade: null,
    finalGrade: null,
    ...extra,
  }
}

function semester(code: string, term: string, courses: SioCourse[], qpa: Partial<SioQpa> = {}, level: Level = 'undergrad'): SioSemester {
  return {
    code,
    term,
    level,
    courses,
    qpa: {
      midSemQpa: null,
      unitsCarried: null,
      unitsPassed: null,
      factorableUnits: null,
      qualityPoints: null,
      finalQpa: null,
      cumulativeQpa: null,
      ...qpa,
    },
  }
}

// The same three semesters as the pages above, as stored data.
const F25 = semester('F25', 'Fall 2025', [sioCourse('15112', { units: 12, finalGrade: 'A' }), sioCourse('21120', { units: 10, finalGrade: 'B' })], {
  factorableUnits: 22,
  qualityPoints: 78,
  finalQpa: 3.55,
  cumulativeQpa: 3.55,
})
const S26 = semester(
  'S26',
  'Spring 2026',
  [
    sioCourse('15122', { units: 12, finalGrade: 'A' }),
    sioCourse('36200', { units: 9, finalGrade: 'B' }),
    sioCourse('98317', { units: 3, gradeOption: 'P', finalGrade: 'P' }),
    sioCourse('99101', { units: 4.5, finalGrade: 'W' }),
  ],
  { factorableUnits: 21, qualityPoints: 75, finalQpa: 3.57, cumulativeQpa: 3.56 },
)
const F26 = semester(
  'F26',
  'Fall 2026',
  [
    sioCourse('15400', { title: 'Made-up Independent Study', units: 12 }),
    sioCourse('21241', { gradeOption: 'P', units: 11, midGrade: 'B+' }),
    sioCourse('76101', { units: 9, midGrade: 'A-' }),
  ],
  { midSemQpa: 3.25, cumulativeQpa: 3.56 },
)

function canvasCourse(id: string, number: string | null, extra: Partial<SyncedCourse> = {}): SyncedCourse {
  return {
    source: 'canvas',
    sourceId: id,
    number,
    alsoNumbers: [],
    title: `Made-up course ${id}`,
    term: 'Fall 2026',
    url: `https://canvas.cmu.edu/courses/${id}`,
    weighted: false,
    categories: [],
    // One graded item at 95%: an A by the default scale.
    items: [{ id: '1', name: 'HW1', categoryId: null, score: 95, max: 100, status: 'graded', due: null, omit: false, url: null }],
    canvasScore: null,
    canvasGrade: null,
    scheme: null,
    syncedAt: '2026-11-12T10:00:00Z',
    ...extra,
  }
}

function storeWith(o: {
  synced?: SyncedCourse[]
  manual?: ManualCourse[]
  semesters?: SioSemester[]
  prefs?: Record<string, CoursePrefs>
  settings?: Partial<Settings>
}): Store {
  const s = defaultStore()
  for (const c of o.synced ?? []) s.synced[`${c.source}:${c.sourceId}`] = c
  s.manual = o.manual ?? []
  s.prefs = o.prefs ?? {}
  s.settings = { ...s.settings, ...o.settings }
  if (o.semesters) s.sio = { semesters: o.semesters, syncedAt: '2026-11-12T10:00:00Z' }
  return s
}

function find(courses: Course[], number: string, term = 'Fall 2026'): Course {
  const c = courses.find((x) => x.number === number && x.term === term)
  if (!c) throw new Error(`no ${number} in ${term}`)
  return c
}

function gradesOf(courses: Course[]): Map<string, GradeResult> {
  return new Map(courses.map((c) => [c.key, gradeCourse(c)]))
}

function sioPayload(semesters: SioSemester[], extra: Partial<SyncPayload> = {}): SyncPayload {
  return { v: 1, kind: 'sio', at: '2026-11-12T12:00:00.000Z', courses: [], semesters, warnings: [], ...extra }
}

// ---------------------------------------------------------------- payload validation

describe('SIO payloads are checked strictly', () => {
  test('a clean payload passes; SIO payloads never carry courses', () => {
    const p = validatePayload({ ...sioPayload([F26, S26]), courses: [canvasCourse('1', '21241')] })
    expect(p.courses).toEqual([])
    expect(p.semesters).toEqual([F26, S26])
    expect(validatePayload({ v: 1, kind: 'canvas', at: 'x', courses: [], warnings: [] })).not.toHaveProperty('semesters')
  })

  test('bad semesters and fields are dropped or nulled', () => {
    const p = validatePayload({
      v: 1,
      kind: 'sio',
      at: '2026-11-12T12:00:00Z',
      warnings: [],
      semesters: [
        { code: 'F26', term: 'Fall 2026', level: 'grad', courses: [], qpa: { finalQpa: 9, cumulativeQpa: '3.5', factorableUnits: -1 } },
        { code: 'F26', term: 'Fall 2026', courses: [] }, // the same code twice
        { code: 'F/26', term: 'Fall 2026', courses: [] }, // not a code
        { code: 'AP', term: 'Advanced Placement', courses: [] }, // not a term
        'junk',
        {
          code: 'S26',
          term: 'Spring 2026',
          level: 'admin',
          courses: [
            {
              title: 'Made-up Course',
              number: '21-241', // must already be 5 digits
              alsoNumbers: ['10615', 'x', 42],
              section: '<b>',
              gradeOption: 'L',
              units: 500,
              midGrade: 'b+',
              finalGrade: '<script>',
            },
            { title: '', number: null }, // nothing to show
            null,
          ],
        },
      ],
    })
    expect(p.semesters).toEqual([
      semester('F26', 'Fall 2026', [], { cumulativeQpa: 3.5 }, 'grad'),
      semester('S26', 'Spring 2026', [
        { title: 'Made-up Course', number: null, alsoNumbers: ['10615'], section: null, gradeOption: 'L', units: null, midGrade: null, finalGrade: null },
      ]),
    ])
  })

  test('too many semesters are cut, with a warning', () => {
    const many = Array.from({ length: 45 }, (_, i) => semester(`F${i}`, `Fall ${2000 + i}`, []))
    const p = validatePayload(sioPayload(many))
    expect(p.semesters).toHaveLength(40)
    expect(p.warnings[0]).toBe('Only the first 40 of 45 SIO semesters were kept.')
  })

  test('survives the #sync link and postMessage encoding', async () => {
    const p = sioPayload([F26, S26, F25], { failedIds: ['M25'] })
    expect(await decodePayload(await encodePayload(p))).toEqual(p)
  })

  test('cleanSioSemesters (also used for saved data) never throws on junk', () => {
    for (const junk of [null, 5, 'x', {}, [null], [{ code: 1 }], [{ code: 'F26', term: 'Fall 2026', courses: 'x', qpa: 'x' }]]) {
      expect(() => cleanSioSemesters(junk)).not.toThrow()
    }
    expect(cleanSioSemesters([{ code: 'F26', term: 'Fall 2026', courses: 'x', qpa: 'x' }])).toEqual([semester('F26', 'Fall 2026', [])])
  })
})

// ---------------------------------------------------------------- the store

describe('saving SIO in the store', () => {
  test('a sync saves the semesters newest first and the sync time; synced courses are not touched', () => {
    const before = applyPayload(defaultStore(), {
      v: 1,
      kind: 'canvas',
      at: '2026-11-12T11:00:00Z',
      courses: [canvasCourse('7', '21241')],
      warnings: [],
    })
    const after = applyPayload(before, sioPayload([F25, F26, S26]))
    expect(after.sio).toEqual({ semesters: [F26, S26, F25], syncedAt: '2026-11-12T12:00:00.000Z' })
    expect(after.lastSync).toEqual({ canvas: '2026-11-12T11:00:00Z', sio: '2026-11-12T12:00:00.000Z' })
    expect(after.synced).toBe(before.synced)
  })

  test('the next sync replaces it; a semester that failed keeps its stored copy; one SIO no longer lists goes', () => {
    const first = applyPayload(defaultStore(), sioPayload([F26, S26, F25]))
    const newF26 = { ...F26, qpa: { ...F26.qpa, midSemQpa: 3.5 } }
    const second = applyPayload(first, sioPayload([newF26], { failedIds: ['S26'] }))
    expect(second.sio?.semesters).toEqual([newF26, S26]) // F25 is gone, S26 kept, F26 replaced
  })

  test('a sync that read no semesters changes nothing but the sync time', () => {
    const first = applyPayload(defaultStore(), sioPayload([F26]))
    const second = applyPayload(first, sioPayload([], { at: '2026-11-13T09:00:00Z' }))
    expect(second.sio).toEqual(first.sio)
    expect(second.lastSync.sio).toBe('2026-11-13T09:00:00Z')
  })

  test('a real SIO sync replaces the sample data', () => {
    const demo = { ...applyPayload(defaultStore(), { v: 1, kind: 'canvas', at: 'x', courses: [canvasCourse('1', '21241')], warnings: [] }), demo: true }
    const after = applyPayload(demo, sioPayload([F26]))
    expect(after.demo).toBeUndefined()
    expect(after.synced).toEqual({})
    expect(after.sio?.semesters).toEqual([F26])
  })

  test('parseStore: old stores without SIO still load; saved SIO data is checked like a payload', () => {
    const old = JSON.parse(JSON.stringify(defaultStore()))
    expect(parseStore(old)).toEqual(defaultStore())
    expect(parseStore(old)).not.toHaveProperty('sio')

    const saved = JSON.parse(JSON.stringify(applyPayload(defaultStore(), sioPayload([F26, S26]))))
    expect(parseStore(saved)?.sio).toEqual({ semesters: [F26, S26], syncedAt: '2026-11-12T12:00:00.000Z' })
    expect(parseStore(saved)?.lastSync.sio).toBe('2026-11-12T12:00:00.000Z')

    saved.sio.semesters[0].courses[0].finalGrade = 'javascript:alert(1)'
    saved.sio.semesters.push({ code: '../x', term: 'Fall 2026' })
    const cleaned = parseStore(saved)
    expect(cleaned?.sio?.semesters).toHaveLength(2)
    expect(cleaned?.sio?.semesters[0].courses[0].finalGrade).toBeNull()

    expect(parseStore({ ...old, sio: { semesters: 'nope' } })).not.toHaveProperty('sio')
    // The list of semesters the last sync couldn't read keeps only real codes.
    const unread = parseStore({ ...saved, sio: { ...saved.sio, unread: ['F25', '../x', 42, 'S25'] } })?.sio?.unread
    expect(unread).toEqual(['F25', 'S25'])
  })
})

// ---------------------------------------------------------------- merge rules

describe('SIO in the class list', () => {
  test('exact units come from SIO; the units the student typed still win', () => {
    const store = storeWith({ synced: [canvasCourse('7', '21241')], semesters: [semester('F26', 'Fall 2026', [sioCourse('21241', { units: 12 })])] })
    const c = find(buildCourses(store), '21241')
    expect(c).toMatchObject({ units: 12, unitsSource: 'sio' })
    expect(c.sio).toEqual({ registered: true, units: 12, gradeOption: 'L', midGrade: null, finalGrade: null })

    const mine = find(buildCourses({ ...store, prefs: { [c.key]: { units: 9 } } }), '21241')
    expect(mine).toMatchObject({ units: 9, unitsSource: 'custom' })
  })

  test('grade option P makes the class pass/fail, unless the student said it is not', () => {
    const store = storeWith({ synced: [canvasCourse('7', '21241')], semesters: [semester('F26', 'Fall 2026', [sioCourse('21241', { gradeOption: 'P' })])] })
    const courses = buildCourses(store)
    const c = find(courses, '21241')
    expect(c.prefs.passFail).toBe(true)
    expect(store.prefs).toEqual({}) // nothing is saved: it follows SIO
    const qpa = computeQpa(courses, gradesOf(courses), store.settings)
    expect(qpa.rows[0]).toMatchObject({ factorable: false, reason: 'Pass/fail' })
    expect(qpa.semesterQpa).toBeNull()

    const said = buildCourses({ ...store, prefs: { [c.key]: { passFail: false } } })
    expect(find(said, '21241').prefs.passFail).toBe(false)
    expect(computeQpa(said, gradesOf(said), store.settings).semesterQpa).toBe(4) // the 95% counts again
  })

  test('withToggle saves only a choice that differs from what SIO implies', () => {
    expect(withToggle({}, 'passFail', false, true)).toEqual({ passFail: false })
    expect(withToggle({ passFail: false }, 'passFail', true, true)).toEqual({ passFail: undefined })
    expect(withToggle({}, 'passFail', true)).toEqual({ passFail: true })
    expect(withToggle({ hidden: true }, 'hidden', false)).toEqual({ hidden: undefined })
    expect(withToggle({}, 'hidden', false, true)).toEqual({ hidden: false })
  })

  test('a posted SIO final grade beats the estimate; the letter the student picked still wins', () => {
    const store = storeWith({ synced: [canvasCourse('7', '21241')], semesters: [semester('F26', 'Fall 2026', [sioCourse('21241', { finalGrade: 'B' })])] })
    const courses = buildCourses(store)
    const c = find(courses, '21241')
    expect(gradeCourse(c).letter).toBe('A') // the scores alone say A
    expect(letterWithBasis(c, gradeCourse(c), store.settings)).toEqual({ letter: 'B', basis: 'sio-final' })
    expect(computeQpa(courses, gradesOf(courses), store.settings).semesterQpa).toBe(3)

    const picked = find(buildCourses({ ...store, prefs: { [c.key]: { letter: 'A' } } }), '21241')
    expect(letterWithBasis(picked, gradeCourse(picked), store.settings)).toEqual({ letter: 'A', basis: 'you' })
  })

  test('a registered course with no other data shows up with its units, using the mid-semester grade for the QPA', () => {
    const store = storeWith({
      synced: [canvasCourse('7', '21241')],
      semesters: [semester('F26', 'Fall 2026', [sioCourse('21241'), sioCourse('15400', { title: 'Made-up Independent Study', units: 12, midGrade: 'B+' })])],
    })
    const courses = buildCourses(store)
    const study = find(courses, '15400')
    expect(study).toMatchObject({
      key: 'Fall 2026|15400',
      title: 'Made-up Independent Study',
      academic: true,
      sources: [],
      units: 12,
      unitsSource: 'sio',
    })
    expect(sourceText(study)).toBe('From SIO')
    // Undergrads get plain letters: B+ counts as B.
    const grades = gradesOf(courses)
    expect(letterWithBasis(study, grades.get(study.key), store.settings)).toEqual({ letter: 'B', basis: 'sio-mid' })
    const qpa = computeQpa(courses, grades, store.settings)
    expect(qpa.rows.find((r) => r.courseKey === study.key)).toMatchObject({ letter: 'B', points: 3, factorable: true, basis: 'sio-mid' })
    expect(qpa.factorableUnits).toBe(21) // 9 (21-241) + 12
    expect(sioRowNote(study, 'sio-mid', true)).toBe('Mid-semester B+, used for your QPA')
    // Pass/fail (or hidden), the class isn't in the QPA, so the note doesn't say the QPA uses that grade.
    expect(sioRowNote(study, 'sio-mid', false)).toBe('Mid-semester B+')

    // Grad students keep the +/-.
    const grad = storeWith({ ...store, synced: [], semesters: store.sio!.semesters, settings: { level: 'grad' } })
    const gradStudy = find(buildCourses(grad), '15400')
    expect(estimatedLetter(gradStudy, undefined, grad.settings)).toBe('B+')
  })

  test('with no mid-semester grade either, the SIO-only class says "No grade yet"', () => {
    const store = storeWith({ synced: [canvasCourse('7', '21241')], semesters: [semester('F26', 'Fall 2026', [sioCourse('21241'), sioCourse('15400')])] })
    const courses = buildCourses(store)
    const qpa = computeQpa(courses, gradesOf(courses), store.settings)
    expect(qpa.rows.find((r) => r.courseKey === 'Fall 2026|15400')).toMatchObject({ letter: null, factorable: false, reason: 'No grade yet' })
  })

  test('a Canvas class SIO does not list for that term is hidden and left out of the QPA, until the student shows it', () => {
    const store = storeWith({
      synced: [canvasCourse('7', '21241'), canvasCourse('8', '15122')],
      semesters: [semester('F26', 'Fall 2026', [sioCourse('21241')])],
    })
    const courses = buildCourses(store)
    const dropped = find(courses, '15122')
    expect(dropped.prefs.hidden).toBe(true)
    expect(notInSio(dropped)).toBe(true)
    expect(rowHint(dropped, [], undefined, null)).toBe('Not in your SIO classes')
    const { main, other } = splitCourses(courses, 'Fall 2026')
    expect(main.map((c) => c.number)).toEqual(['21241'])
    expect(other.map((c) => c.number)).toEqual(['15122'])
    expect(computeQpa(main, gradesOf(courses), store.settings).factorableUnits).toBe(9)

    const shown = buildCourses({ ...store, prefs: { [dropped.key]: { hidden: false } } })
    expect(splitCourses(shown, 'Fall 2026').main.map((c) => c.number)).toEqual(['15122', '21241'])
  })

  test('hand-added classes are never hidden; one with no term gets this semester, so SIO does not add it twice', () => {
    const store = storeWith({
      synced: [canvasCourse('7', '21241')],
      manual: [
        { key: 'manual:a', number: '15-400', title: 'My research', term: null, percent: null },
        { key: 'manual:b', number: '99-999', title: 'Made-up club', term: 'Fall 2026', percent: 90 },
      ],
      semesters: [semester('F26', 'Fall 2026', [sioCourse('21241'), sioCourse('15400', { units: 12 })])],
    })
    const courses = buildCourses(store)
    expect(courses.filter((c) => c.number === '15400')).toHaveLength(1)
    const research = courses.find((c) => c.key === 'manual:a')!
    expect(research).toMatchObject({ units: 12, unitsSource: 'sio', term: 'Fall 2026' })
    const club = courses.find((c) => c.key === 'manual:b')!
    expect(club.prefs.hidden).toBeUndefined()
    expect(club.sio).toBeNull()
  })

  test('a hand-added class with no term stays in this semester when next semester is already on Canvas', () => {
    const store = storeWith({
      synced: [canvasCourse('7', '21241'), canvasCourse('9', '15451', { term: 'Spring 2027', items: [] })],
      manual: [{ key: 'manual:a', number: '15-400', title: 'My research', term: null, percent: 95 }],
      semesters: [F26, S26, F25],
    })
    const courses = buildCourses(store)
    expect(courses.filter((c) => c.number === '15400').map((c) => c.key)).toEqual(['manual:a'])
    const fall = splitCourses(courses, 'Fall 2026').main
    expect(fall.map((c) => c.key)).toContain('manual:a')
    expect(splitCourses(courses, 'Spring 2027').main.map((c) => c.key)).toEqual(['Spring 2027|15451'])
    // 15-400: 12 units of A (the typed 95%). 76-101: 9 units of its mid-semester A- (an A). 21-241: pass/fail in SIO.
    expect(computeQpa(fall, gradesOf(courses), store.settings).factorableUnits).toBe(21)
  })

  test('a class added by hand before syncing is not counted twice once Canvas has it too', () => {
    const store = storeWith({
      synced: [canvasCourse('7', '76101')],
      manual: [{ key: 'manual:w', number: '76-101', title: 'Writing', term: null, percent: 80 }],
      semesters: [F26, S26, F25],
    })
    const courses = buildCourses(store)
    expect(courses.filter((c) => c.number === '76101').map((c) => c.key)).toEqual(['Fall 2026|76101'])
  })

  test('terms SIO has no data for are left alone', () => {
    const store = storeWith({ synced: [canvasCourse('7', '21241', { term: 'Spring 2027' })], semesters: [F26] })
    const c = find(buildCourses(store), '21241', 'Spring 2027')
    expect(c.sio).toBeNull()
    expect(c.prefs.hidden).toBeUndefined()
  })

  test('finished semesters with nothing else and next semester (registered early) add no classes', () => {
    const S27 = semester('S27', 'Spring 2027', [sioCourse('15451')])
    const store = storeWith({ synced: [canvasCourse('7', '21241')], semesters: [S27, F26, S26, F25] })
    const courses = buildCourses(store)
    expect(courses.map((c) => c.term).filter((t, i, all) => all.indexOf(t) === i)).toEqual(['Fall 2026'])
  })

  test('only SIO, no Canvas: the semester in progress still shows its classes', () => {
    const courses = buildCourses(storeWith({ semesters: [F26, S26, F25] }))
    expect(courses.map((c) => c.key).sort()).toEqual(['Fall 2026|15400', 'Fall 2026|21241', 'Fall 2026|76101'])
  })

  test('a cross-listed number matches, and so does the title when the numbers differ', () => {
    const store = storeWith({
      synced: [
        canvasCourse('1', '15213', { alsoNumbers: ['18213'] }),
        canvasCourse('2', '99301', { title: 'Made-up Machine Learning' }), // numbers the catalog doesn't know
      ],
      semesters: [
        semester('F26', 'Fall 2026', [
          sioCourse('18213', { units: 12 }),
          sioCourse('99601', { title: 'Made-up Machine Learning!', units: 12 }),
        ]),
      ],
    })
    const courses = buildCourses(store)
    expect(courses).toHaveLength(2)
    expect(courses.every((c) => c.sio?.registered && c.units === 12)).toBe(true)
  })

  test('titles match with "&" in one and "and" in the other', () => {
    const store = storeWith({
      synced: [canvasCourse('2', '99615', { title: 'Made-up Art and Machine Learning' })], // Canvas shows the other number
      semesters: [semester('F26', 'Fall 2026', [sioCourse('99335', { title: 'Made-up Art & Machine Learning', units: 12 })])],
    })
    const courses = buildCourses(store)
    expect(courses).toHaveLength(1) // no SIO-only copy
    expect(courses[0]).toMatchObject({ number: '99615', units: 12, sio: { registered: true } })
    expect(courses[0].prefs.hidden).toBeUndefined()
  })

  test('an audited class (grade option A) is left out of the QPA', () => {
    const store = storeWith({
      synced: [canvasCourse('7', '21241'), canvasCourse('8', '80100')],
      semesters: [semester('F26', 'Fall 2026', [sioCourse('21241', { units: 11 }), sioCourse('80100', { units: 9, gradeOption: 'A' })])],
    })
    const courses = buildCourses(store)
    const qpa = computeQpa(courses, gradesOf(courses), store.settings)
    expect(qpa.rows.find((r) => r.label === '80-100')).toMatchObject({ factorable: false, reason: 'Audit' })
    expect(qpa.factorableUnits).toBe(11)
    expect(rowHint(find(courses, '80100'), [], undefined, 'A')).toBe('Audit, not in your QPA')
  })

  test("an Incomplete (I) in SIO rules out the Dean's List", () => {
    const term = 'Spring 2026'
    const sem = semester('S26', term, [
      sioCourse('15122', { units: 12, finalGrade: 'A' }),
      sioCourse('15150', { units: 12, finalGrade: 'A' }),
      sioCourse('21241', { units: 12, finalGrade: 'A' }),
      sioCourse('36200', { units: 9, finalGrade: 'I' }),
    ])
    const store = storeWith({
      synced: ['15122', '15150', '21241', '36200'].map((n, i) => canvasCourse(String(i + 1), n, { term })),
      semesters: [sem],
      settings: { college: 'scs' },
    })
    const courses = buildCourses(store)
    const qpa = computeQpa(splitCourses(courses, term).main, gradesOf(courses), store.settings)
    expect(qpa.semesterQpa).toBe(4)
    expect(qpa.factorableUnits).toBe(36) // the I doesn't count
    expect(qpa.deansList).toMatchObject({ eligible: false, incomplete: true })

    const noI = buildCourses({ ...store, prefs: { [`${term}|36200`]: { hidden: true } }, sio: { semesters: [{ ...sem, courses: sem.courses.slice(0, 3) }], syncedAt: 'x' } })
    expect(computeQpa(splitCourses(noI, term).main, gradesOf(noI), store.settings).deansList).toMatchObject({ eligible: true })
  })

  test('a term whose SIO courses have no readable numbers changes nothing', () => {
    const store = storeWith({ synced: [canvasCourse('7', '21241')], semesters: [semester('F26', 'Fall 2026', [sioCourse(null)])] })
    const c = find(buildCourses(store), '21241')
    expect(c.prefs.hidden).toBeUndefined()
    expect(c.sio).toBeNull()
  })

  test('the same number twice in SIO (two sections) gives two classes', () => {
    const store = storeWith({ semesters: [semester('F26', 'Fall 2026', [sioCourse('15400', { section: 'A' }), sioCourse('15400', { section: 'B' })])] })
    expect(buildCourses(store).map((c) => c.key)).toEqual(['Fall 2026|15400', 'Fall 2026|15400#2'])
  })

  test('Summer One and Summer Two both belong to the app\'s "Summer 2026"', () => {
    const store = storeWith({
      synced: [canvasCourse('7', '21241', { term: 'Summer 2026' }), canvasCourse('8', '15122', { term: 'Summer 2026' })],
      semesters: [
        semester('M26', 'Summer One 2026', [sioCourse('21241', { units: 10 })]),
        semester('N26', 'Summer Two 2026', [sioCourse('15122', { units: 12 })]),
      ],
    })
    const courses = buildCourses(store)
    expect(find(courses, '21241', 'Summer 2026').units).toBe(10)
    expect(find(courses, '15122', 'Summer 2026').units).toBe(12)
    expect(courses.every((c) => !c.prefs.hidden)).toBe(true)
  })

  test('with both records in one term, a grad student gets the graduate one', () => {
    const store = storeWith({
      synced: [canvasCourse('7', '10601')],
      settings: { level: 'grad' },
      semesters: [
        semester('F26', 'Fall 2026', [sioCourse('10601', { units: 12 })], {}, 'grad'),
        semester('F26U', 'Fall 2026', [sioCourse('21241', { units: 11 })], {}, 'undergrad'),
      ],
    })
    const courses = buildCourses(store)
    expect(find(courses, '10601').units).toBe(12)
    expect(courses.some((c) => c.number === '21241')).toBe(false)
  })

  test('the class row and class page show the mid-semester grade', () => {
    const store = storeWith({ synced: [canvasCourse('7', '76101')], semesters: [F26] })
    const c = find(buildCourses(store), '76101')
    expect(c.sio?.midGrade).toBe('A-')
    expect(sioRowNote(c, 'estimate', true)).toBe('Mid-semester A-') // the scores decide the letter
    expect(sourceText(c)).toBe('From Canvas + SIO')
    expect(sioRowNote({ ...c, sio: { ...c.sio!, midGrade: null } }, 'estimate', true)).toBeNull()
    expect(sioRowNote(c, 'sio-final', true)).toBe('Final grade from SIO')
  })
})

// ---------------------------------------------------------------- cumulative QPA

describe('cumulative QPA from SIO', () => {
  const sio = { semesters: [F26, S26, F25], syncedAt: '2026-11-12T10:00:00Z' }

  test('isFinished, termInProgress and finishedSemesters', () => {
    expect([F26, S26, F25].map(isFinished)).toEqual([false, true, true])
    expect(termInProgress(sio)).toBe('Fall 2026')
    const withNext = { ...sio, semesters: [semester('S27', 'Spring 2027', [sioCourse('15451')]), ...sio.semesters] }
    expect(termInProgress(withNext)).toBe('Fall 2026') // next semester is newer, not in progress
    expect(termInProgress({ ...sio, semesters: [S26, F25, semester('M25', 'Summer One 2025', [])] })).toBeNull()
    expect(finishedSemesters(sio).map((s) => s.code)).toEqual(['S26', 'F25'])
    expect(termInProgress(undefined)).toBeNull()
  })

  test('a final grade posted during the semester (a mini course, a W, AD credit) does not finish it', () => {
    const S27 = semester('S27', 'Spring 2027', [sioCourse('15451'), sioCourse('36226')]) // registered early
    for (const finalGrade of ['A', 'W', 'AD']) {
      const now = semester('F26', 'Fall 2026', [sioCourse('76106', { units: 4.5, finalGrade }), sioCourse('21241', { units: 11 })])
      const data = { semesters: [S27, now, S26, F25], syncedAt: 'x' }
      expect(isFinished(now), finalGrade).toBe(false)
      expect(termInProgress(data), finalGrade).toBe('Fall 2026')
      expect(finishedSemesters(data).map((s) => s.code), finalGrade).toEqual(['S26', 'F25'])
      expect(priorFromSio(data, 'Fall 2026', 'undergrad'), finalGrade).toEqual({ qpa: 153 / 43, units: 43 })
    }
    // Once every final grade is in, it is finished, and next semester is the one in progress.
    const done = semester('F26', 'Fall 2026', [sioCourse('76106', { units: 4.5, finalGrade: 'A' }), sioCourse('21241', { units: 11, finalGrade: 'B' })])
    expect(termInProgress({ semesters: [S27, done, S26, F25], syncedAt: 'x' })).toBe('Spring 2027')
  })

  test('an old semester with one grade never posted still counts as finished', () => {
    const late = semester('F25', 'Fall 2025', [sioCourse('15112', { units: 12, finalGrade: 'A' }), sioCourse('21120', { units: 10 })], {
      factorableUnits: 12,
      qualityPoints: 48,
      finalQpa: 4,
    })
    const data = { semesters: [F26, S26, late], syncedAt: 'x' }
    expect(termInProgress(data)).toBe('Fall 2026')
    expect(finishedSemesters(data).map((s) => s.code)).toEqual(['S26', 'F25'])
    expect(priorFromSio(data, 'Fall 2026', 'undergrad')).toEqual({ qpa: (75 + 48) / 33, units: 33 })
  })

  test('a first sync that missed a finished semester is not used for "QPA before this semester"', () => {
    const store = applyPayload(defaultStore(), sioPayload([F26, S26], { failedIds: ['F25'] }))
    expect(store.sio?.unread).toEqual(['F25'])
    expect(priorFromSio(store.sio, 'Fall 2026', 'undergrad')).toBeNull() // S26 alone would be 3.57, not the real 3.56
    expect(withSioPrior(store.settings, store.sio, 'Fall 2026').fromSio).toBe(false)
    expect(officialCumulative(store.sio, 'undergrad')).toBe(3.56) // SIO's own number still shows
    expect(parseStore(JSON.parse(JSON.stringify(store)))?.sio?.unread).toEqual(['F25']) // kept after a reload

    // The next sync reads it: the record is whole again.
    const later = applyPayload(store, sioPayload([F26, S26, F25]))
    expect(later.sio?.unread).toBeUndefined()
    expect(priorFromSio(later.sio, 'Fall 2026', 'undergrad')).toEqual({ qpa: 153 / 43, units: 43 })
    // If it fails again after that, its stored copy is kept, so nothing is missing.
    const again = applyPayload(later, sioPayload([F26, S26], { failedIds: ['F25'] }))
    expect(again.sio?.unread).toBeUndefined()
    expect(again.sio?.semesters.map((s) => s.code)).toEqual(['F26', 'S26', 'F25'])
  })

  test("a term's record (undergraduate or graduate) comes from SIO, whatever the Level setting says", () => {
    const S26G = semester(
      'S26',
      'Spring 2026',
      [sioCourse('10601', { units: 12, finalGrade: 'A-' }), sioCourse('10605', { units: 12, finalGrade: 'A-' })],
      { factorableUnits: 24, qualityPoints: 88.08, finalQpa: 3.67, cumulativeQpa: 3.67 },
      'grad',
    )
    const F26G = semester('F26', 'Fall 2026', [sioCourse('10701', { units: 12, midGrade: 'A-' })], { cumulativeQpa: 3.67 }, 'grad')

    // Only a graduate record, Level left at undergraduate: Fall 2026 is scored on the graduate scale.
    const gradOnly = storeWith({ semesters: [F26G, S26G], settings: { college: 'scs' } })
    expect(levelFor(gradOnly.sio, 'Fall 2026', 'undergrad')).toBe('grad')
    const prior = withSioPrior(gradOnly.settings, gradOnly.sio, 'Fall 2026')
    expect(prior.settings).toMatchObject({ level: 'grad', priorUnits: 24 })
    const courses = buildCourses(gradOnly)
    const qpa = computeQpa(splitCourses(courses, 'Fall 2026').main, gradesOf(courses), prior.settings)
    expect(qpa.semesterQpa).toBeCloseTo(3.67) // the mid-semester A- keeps its minus
    expect(qpa.cumulativeQpa).toBeCloseTo(3.67)
    expect(qpa.deansList).toBeNull() // an undergraduate honor

    // A CMU undergrad who started a master's: the first graduate semester starts a new record.
    const bsms = storeWith({ semesters: [F26G, S26, F25] })
    expect(termInProgress(bsms.sio)).toBe('Fall 2026')
    expect(withSioPrior(bsms.settings, bsms.sio, 'Fall 2026')).toEqual({ settings: { ...bsms.settings, level: 'grad' }, fromSio: false })
    expect(withSioPrior(bsms.settings, bsms.sio, 'Spring 2026').settings).toMatchObject({ level: 'undergrad', priorUnits: 22 })

    // A term SIO doesn't list follows the setting.
    expect(levelFor(gradOnly.sio, 'Spring 2027', 'undergrad')).toBe('undergrad')
    // A class in a graduate term gets the graduate letter scale by default (91% is an A-, not an A).
    const withCanvas = storeWith({
      synced: [canvasCourse('7', '10701', { items: [{ id: '1', name: 'HW1', categoryId: null, score: 91, max: 100, status: 'graded', due: null, omit: false, url: null }] })],
      semesters: [F26G, S26G],
    })
    const c = find(buildCourses(withCanvas), '10701')
    expect(letterWithBasis(c, gradeCourse(c), withSioPrior(withCanvas.settings, withCanvas.sio, 'Fall 2026').settings).letter).toBe('A-')
  })

  test('sums quality points and factorable units of every finished semester before the term', () => {
    expect(priorFromSio(sio, 'Fall 2026', 'undergrad')).toEqual({ qpa: 153 / 43, units: 43 })
    expect(priorFromSio(sio, 'Spring 2026', 'undergrad')).toEqual({ qpa: 78 / 22, units: 22 })
    expect(priorFromSio(sio, 'Fall 2025', 'undergrad')).toBeNull()
    expect(priorFromSio(undefined, 'Fall 2026', 'undergrad')).toBeNull()
  })

  test("without SIO's QPA row, the totals are added up from the final grades (P, W and pass/fail left out)", () => {
    const noRow = { ...S26, qpa: semester('x', 'Fall 2026', []).qpa }
    expect(semesterTotals(noRow)).toEqual({ qualityPoints: 75, units: 21 })
    const grad = semester('S26', 'Spring 2026', [sioCourse('10601', { units: 12, finalGrade: 'A-' }), sioCourse('10605', { units: 12, finalGrade: 'B+' })], {}, 'grad')
    expect(semesterTotals(grad).qualityPoints).toBeCloseTo(12 * 3.67 + 12 * 3.33)
  })

  test('undergraduate and graduate records have separate cumulatives', () => {
    const both = {
      semesters: [semester('S26G', 'Spring 2026', [sioCourse('10601', { finalGrade: 'A' })], { factorableUnits: 12, qualityPoints: 48, cumulativeQpa: 4 }, 'grad'), S26, F25],
      syncedAt: 'x',
    }
    expect(priorFromSio(both, 'Fall 2026', 'undergrad')?.units).toBe(43)
    expect(priorFromSio(both, 'Fall 2026', 'grad')).toEqual({ qpa: 4, units: 12 })
    expect(officialCumulative(both, 'grad')).toBe(4)
    expect(officialCumulative(both, 'undergrad')).toBe(3.56)
    // A grad student who never changed the Level setting still gets their only record.
    const gradOnly = { semesters: [both.semesters[0]], syncedAt: 'x' }
    expect(priorFromSio(gradOnly, 'Fall 2026', 'undergrad')).toEqual({ qpa: 4, units: 12 })
  })

  test("officialCumulative is SIO's own number from the newest semester that shows one", () => {
    expect(officialCumulative(sio, 'undergrad')).toBe(3.56)
    expect(officialCumulative({ semesters: [F25], syncedAt: 'x' }, 'undergrad')).toBe(3.55)
    expect(officialCumulative(undefined, 'undergrad')).toBeNull()
  })

  test('withSioPrior fills "QPA before this semester" unless the student typed both numbers', () => {
    const settings = defaultStore().settings
    expect(withSioPrior(settings, sio, 'Fall 2026')).toEqual({ settings: { ...settings, priorQpa: 153 / 43, priorUnits: 43 }, fromSio: true })
    const typed = { ...settings, priorQpa: 3.9, priorUnits: 100 }
    expect(withSioPrior(typed, sio, 'Fall 2026')).toEqual({ settings: typed, fromSio: false })
    const half = { ...settings, priorQpa: 3.9 }
    expect(withSioPrior(half, sio, 'Fall 2026').fromSio).toBe(true)
    expect(withSioPrior(settings, undefined, 'Fall 2026')).toEqual({ settings, fromSio: false })
  })

  test('the projected cumulative adds this semester to the SIO record', () => {
    const store = storeWith({ synced: [canvasCourse('7', '76101')], semesters: [F26, S26, F25] })
    const courses = buildCourses(store)
    const main = splitCourses(courses, 'Fall 2026').main
    const { settings } = withSioPrior(store.settings, store.sio, 'Fall 2026')
    const qpa = computeQpa(main, gradesOf(courses), settings)
    // 76-101: 9 units of A (Canvas 95%). 15-400: no grade yet. 21-241: pass/fail.
    expect(qpa.semesterQpa).toBe(4)
    expect(qpa.factorableUnits).toBe(9)
    expect(qpa.cumulativeQpa).toBeCloseTo((153 + 36) / (43 + 9))
  })
})

// ---------------------------------------------------------------- the app (dashboard + Past semesters page)

class MemoryStorage implements Storage {
  private data = new Map<string, string>()
  get length() {
    return this.data.size
  }
  clear() {
    this.data.clear()
  }
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value))
  }
}

describe('the app with SIO data', () => {
  let container: HTMLDivElement
  let root: Root | null = null
  const noExtension = { detect: async () => null, sync: async () => ({ type: 'result' as const, results: [] }), openWelcome: async () => {} }

  beforeEach(() => {
    for (const name of ['localStorage', 'sessionStorage'] as const) {
      Object.defineProperty(window, name, { value: new MemoryStorage(), configurable: true, writable: true })
      Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true })
    }
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    window.scrollTo = () => {}
    window.history.replaceState(null, '', '/')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    container.remove()
  })

  async function renderApp(store: Store) {
    saveStore(store)
    const { default: App } = await import('../src/App')
    root = createRoot(container)
    await act(async () => root!.render(createElement(App, { extension: noExtension })))
  }

  const text = () => container.textContent ?? ''
  const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)

  test('dashboard: SIO-only class, hidden unregistered class, official cumulative and a Past semesters link', async () => {
    const store = storeWith({ synced: [canvasCourse('7', '76101'), canvasCourse('8', '15122')], semesters: [F26, S26, F25] })
    await renderApp(applyPayload(store, sioPayload([F26, S26, F25])))
    expect(text()).toContain('15-400')
    expect(text()).toContain('Made-up Independent Study')
    expect(text()).toContain('Mid-semester A-')
    expect(text()).toContain('Pass/fail') // 21-241 is pass/fail in SIO
    expect(text()).toContain('Show 1 hidden class') // 15-122 is not in SIO for Fall 2026
    expect(text()).toContain(`Cumulative ${((153 + 36) / 52).toFixed(2)} · Official 3.56`)

    await act(async () => button('Past semesters')!.click())
    expect(window.location.pathname).toBe('/past')
    expect(container.querySelector('h1')?.textContent).toBe('Past semesters')
    expect(text()).toContain('Official cumulative QPA 3.56')
    const headings = [...container.querySelectorAll('.past-page h2')].map((h) => h.textContent)
    expect(headings).toEqual(['Spring 2026', 'Fall 2025']) // finished only, newest first
    expect(text()).toContain('QPA 3.57 · 21 factorable units')
    expect(text()).toContain('15-122')
    expect(text()).toContain('4.5 units')

    await act(async () => button('All classes')!.click())
    expect(window.location.pathname).toBe('/')
  })

  test('P/F on the class list: an SIO pass/fail class starts on; off is saved, on again goes back to following SIO', async () => {
    const key = 'Fall 2026|21241'
    const at85 = [{ id: '1', name: 'HW1', categoryId: null, score: 85, max: 100, status: 'graded' as const, due: null, omit: false, url: null }]
    await renderApp(storeWith({ synced: [canvasCourse('7', '21241', { items: at85 }), canvasCourse('8', '76101')], semesters: [F26] }))
    const pf = container.querySelector<HTMLButtonElement>(`button.class-row[data-key="${key}"] + button.pf-toggle`)!
    const chip = () => container.querySelector(`button.class-row[data-key="${key}"] .chip`)?.textContent
    const qpa = () => container.querySelector('.qpa-big')?.textContent
    expect(pf.getAttribute('aria-pressed')).toBe('true') // grade option P in SIO
    expect(chip()).toBe('P')
    expect(qpa()).toBe('4.00') // only 76-101 (an A) counts

    await act(async () => pf.click())
    expect(loadStore().prefs[key]).toEqual({ passFail: false }) // goes against SIO, so it is saved
    expect(pf.getAttribute('aria-pressed')).toBe('false')
    expect(chip()).toBe('B') // 85% in Canvas
    expect(qpa()).not.toBe('4.00')

    await act(async () => pf.click())
    expect(loadStore().prefs[key]).toBeUndefined() // the same as SIO: nothing saved
    expect(pf.getAttribute('aria-pressed')).toBe('true')
    expect(qpa()).toBe('4.00')
  })

  // Helpers for the P/F tests below: the row button, its P/F button (if any) and the row's text.
  const pfRow = (key: string) => container.querySelector<HTMLButtonElement>(`button.class-row[data-key="${key}"]`)
  const pfToggle = (key: string) => container.querySelector<HTMLButtonElement>(`button.class-row[data-key="${key}"] + button.pf-toggle`)
  const qpaBig = () => container.querySelector('.qpa-big')?.textContent

  test('P/F on the class list: none once SIO posted the final grade, unless the student set P/F (then it can be turned off)', async () => {
    // Spring 2026 is finished in SIO: 15-122 A, 36-200 B, 98-317 P (taken pass/fail), 99-101 W. (A finished term shows
    // its SIO-only classes once one class of that term came from Canvas, here 15-122.)
    const store = storeWith({
      synced: [canvasCourse('9', '15122', { term: 'Spring 2026' })],
      semesters: [F26, S26],
      settings: { term: 'Spring 2026' },
      prefs: { 'Spring 2026|36200': { passFail: true } },
    })
    await renderApp(store)
    expect(container.querySelector('.summary-term')?.textContent).toBe('Spring 2026')
    for (const n of ['15122', '98317', '99101']) expect(pfToggle(`Spring 2026|${n}`), n).toBeNull()
    expect(pfRow('Spring 2026|15122')!.textContent).toContain('Final grade from SIO')
    expect(pfRow('Spring 2026|15122')!.textContent).not.toContain('Pass/fail')
    expect(pfRow('Spring 2026|98317')!.querySelector('.chip')?.textContent).toBe('P')

    // 36-200 was set to pass/fail before its B was posted: the row says so, and the button can turn it off.
    const statsKey = 'Spring 2026|36200'
    expect(pfRow(statsKey)!.textContent).toContain('Final grade from SIO · Pass/fail')
    expect(pfToggle(statsKey)!.getAttribute('aria-pressed')).toBe('true')
    expect(qpaBig()).toBe('4.00') // only 15-122 counts while 36-200 is pass/fail
    await act(async () => pfToggle(statsKey)!.click())
    expect(loadStore().prefs[statsKey]).toBeUndefined()
    expect(pfToggle(statsKey)).toBeNull() // settled by SIO now, so no button
    expect(pfRow(statsKey)!.textContent).not.toContain('Pass/fail')
    expect(qpaBig()).toBe('3.57') // the same as SIO's official QPA for the term
  })

  test('P/F on the class list: none for an audited class', async () => {
    const audit = semester('F26', 'Fall 2026', [sioCourse('15400', { units: 12, midGrade: 'A-' }), sioCourse('76101', { units: 9, gradeOption: 'A' })])
    await renderApp(storeWith({ synced: [canvasCourse('8', '76101')], semesters: [audit] }))
    expect(pfToggle('Fall 2026|76101')).toBeNull()
    expect(pfRow('Fall 2026|76101')!.textContent).toContain('Audit, not in your QPA')
    expect(pfToggle('Fall 2026|15400')).not.toBeNull()
  })

  test('a pass/fail class with only a mid-semester grade never says the QPA uses that grade', async () => {
    const mids = semester('F26', 'Fall 2026', [sioCourse('15400', { units: 12, midGrade: 'A-' }), sioCourse('76101', { units: 9, midGrade: 'B' })])
    await renderApp(storeWith({ semesters: [mids] }))
    const key = 'Fall 2026|15400'
    expect(pfRow(key)!.textContent).toContain('Mid-semester A-, used for your QPA')
    expect(qpaBig()).toBe('3.57') // (12 x 4 + 9 x 3) / 21

    await act(async () => pfToggle(key)!.click())
    expect(pfRow(key)!.textContent).toContain('Mid-semester A- · Pass/fail')
    expect(pfRow(key)!.textContent).not.toContain('used for your QPA')
    expect(qpaBig()).toBe('3.00') // only 76-101 counts

    // The class page says the same, and its letter is P like on the list.
    await act(async () => pfRow(key)!.click())
    expect(container.querySelector('.class-facts')?.textContent).toBe('From SIO · 12 units · Pass/fail · Mid-semester A-')
    expect(container.querySelector('.class-head-grade .chip')?.textContent).toBe('P')
  })

  test('a class page says pass/fail comes from SIO', async () => {
    const store = storeWith({ synced: [canvasCourse('7', '21241')], semesters: [F26] })
    await renderApp(store)
    await act(async () => container.querySelector<HTMLButtonElement>('button.class-row[data-key="Fall 2026|21241"]')!.click())
    expect(text()).toContain('Pass/fail in SIO')
    expect(text()).toContain('Mid-semester B+')
    expect(text()).toContain('From Canvas + SIO')
  })

  test('a graduate record in SIO: the term uses the graduate scale, and Settings says why', async () => {
    const F26G = semester('F26', 'Fall 2026', [sioCourse('10701', { units: 12, midGrade: 'A-' })], {}, 'grad')
    await renderApp(storeWith({ semesters: [F26G] })) // the Level setting is left at undergraduate
    expect(container.querySelector('.qpa-big')?.textContent).toBe('3.67') // A- = 3.67, not an undergrad A
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!.click())
    expect(text()).toContain('SIO lists Fall 2026 in your graduate record, so Fall 2026 uses the graduate scale.')
  })

  test('only SIO synced: the dashboard shows this semester instead of the welcome page', async () => {
    await renderApp(applyPayload(defaultStore(), sioPayload([F26, S26, F25])))
    expect(text()).toContain('Fall 2026')
    expect(text()).toContain('15-400')
    expect(button('Past semesters')).toBeTruthy()
  })
})
