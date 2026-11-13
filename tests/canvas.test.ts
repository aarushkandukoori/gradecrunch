// Tests for src/sync/canvas.ts with synthetic Canvas data shaped like the real API (no real grades).
import { afterEach, describe, expect, test, vi } from 'vitest'

// The course-number parser belongs to another module. Mock it with a small version of the same rule
// (two digits, optional dash, three digits, not inside a longer digit run) so these tests stand alone.
vi.mock('../src/lib/courseNumber', () => ({
  parseCourseNumbers: (...texts: (string | null | undefined)[]) => {
    const found: string[] = []
    for (const t of texts) {
      for (const m of (t ?? '').matchAll(/(?<!\d)(\d{2})-?(\d{3})(?!\d)/g)) {
        if (!found.includes(m[1] + m[2])) found.push(m[1] + m[2])
      }
    }
    return { number: found[0] ?? null, also: found.slice(1) }
  },
  // Only "Fall 2026"-style names are needed here: year * 10 + season, -1 when unreadable.
  termSortKey: (term: string | null | undefined) => {
    const m = (term ?? '').match(/(Spring|Summer|Fall) (\d{4})/)
    return m ? Number(m[2]) * 10 + { Spring: 1, Summer: 2, Fall: 3 }[m[1] as 'Spring' | 'Summer' | 'Fall'] : -1
  },
}))

import {
  absoluteBinaryFetcher,
  bytesToBase64,
  CanvasAuthError,
  CanvasHttpError,
  collectSyllabus,
  decodeEntities,
  fetchAll,
  findFileLinks,
  htmlToText,
  itemStatus,
  mapAssignment,
  mapGroup,
  mapLimit,
  mapScheme,
  nextPathFromLink,
  parseCanvasJson,
  pickEnrollment,
  sameOriginBinaryFetcher,
  sameOriginFetcher,
  syncCanvas,
  withoutSyllabusPdfs,
  type BinaryFetcher,
  type PageFetcher,
} from '../src/sync/canvas'

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------- small helpers

describe('parseCanvasJson', () => {
  test('strips the while(1); prefix', () => {
    expect(parseCanvasJson('while(1);[{"id":1}]')).toEqual([{ id: 1 }])
  })
  test('parses plain JSON', () => {
    expect(parseCanvasJson('{"a":2}')).toEqual({ a: 2 })
  })
})

describe('nextPathFromLink', () => {
  test('finds rel=next among several links', () => {
    const link =
      '<https://canvas.cmu.edu/api/v1/courses?page=1&per_page=100>; rel="current",' +
      '<https://canvas.cmu.edu/api/v1/courses?page=2&per_page=100>; rel="next",' +
      '<https://canvas.cmu.edu/api/v1/courses?page=3&per_page=100>; rel="last"'
    expect(nextPathFromLink(link)).toBe('courses?page=2&per_page=100')
  })
  test('null when there is no next page or no header', () => {
    expect(nextPathFromLink('<https://canvas.cmu.edu/api/v1/courses?page=1>; rel="last"')).toBeNull()
    expect(nextPathFromLink(null)).toBeNull()
  })
})

describe('itemStatus', () => {
  test('follows the priority order', () => {
    expect(itemStatus({ excused: true, score: 5 })).toBe('excused')
    expect(itemStatus({ score: 0, missing: true })).toBe('graded') // a zero is still a score
    expect(itemStatus({ score: null, missing: true })).toBe('missing')
    expect(itemStatus({ score: null, workflow_state: 'submitted' })).toBe('submitted')
    expect(itemStatus({ score: null, workflow_state: 'pending_review' })).toBe('submitted')
    expect(itemStatus({ score: null, workflow_state: 'unsubmitted' })).toBe('unsubmitted')
    expect(itemStatus(null)).toBe('unsubmitted')
  })
})

describe('mapAssignment / mapGroup', () => {
  test('omit covers omit_from_final_grade, not_graded and hide_in_gradebook', () => {
    const base = { id: 1, name: 'x', points_possible: 10, published: true }
    expect(mapAssignment({ ...base, omit_from_final_grade: true }, 'g').omit).toBe(true)
    expect(mapAssignment({ ...base, grading_type: 'not_graded' }, 'g').omit).toBe(true)
    expect(mapAssignment({ ...base, hide_in_gradebook: true }, 'g').omit).toBe(true)
    expect(mapAssignment({ ...base, grading_type: 'points' }, 'g').omit).toBe(false)
  })
  test('keeps only canvas.cmu.edu links', () => {
    expect(mapAssignment({ id: 1, html_url: 'https://canvas.cmu.edu/courses/1/assignments/1' }, 'g').url).toBe(
      'https://canvas.cmu.edu/courses/1/assignments/1',
    )
    expect(mapAssignment({ id: 1, html_url: 'javascript:alert(1)' }, 'g').url).toBeNull()
  })
  test('drop rules, never_drop ids as strings, unpublished skipped', () => {
    const { category, items } = mapGroup({
      id: 7,
      name: 'Quizzes',
      group_weight: 10,
      rules: { drop_lowest: 1, never_drop: [55] },
      assignments: [
        { id: 55, name: 'Quiz 1', published: true },
        { id: 56, name: 'Quiz 2 (draft)', published: false },
      ],
    })
    expect(category).toEqual({ id: '7', name: 'Quizzes', weight: 10, dropLowest: 1, dropHighest: 0, neverDrop: ['55'] })
    expect(items.map((i) => i.id)).toEqual(['55'])
    expect(items[0].categoryId).toBe('7')
  })
  test('empty rules object gives no drops', () => {
    const { category } = mapGroup({ id: 1, name: 'HW', group_weight: null, rules: {} })
    expect(category.dropLowest).toBe(0)
    expect(category.weight).toBeNull()
  })
})

describe('mapScheme', () => {
  test('fractions become percents, sorted high to low, no float noise', () => {
    const cuts = mapScheme({
      id: 1,
      grading_scheme: [
        { name: 'B', value: 0.8 },
        { name: 'A', value: 0.9317 },
        { name: 'R', value: 0 },
      ],
    })
    expect(cuts).toEqual([
      { letter: 'A', min: 93.17 },
      { letter: 'B', min: 80 },
      { letter: 'R', min: 0 },
    ])
  })
})

describe('pickEnrollment', () => {
  test('first student enrollment with a score; ignores TA enrollments', () => {
    const e = pickEnrollment({
      enrollments: [
        { type: 'ta', computed_current_score: 99 },
        { type: 'student', computed_current_score: null },
        { type: 'student', computed_current_score: 88 },
      ],
    })
    expect(e?.computed_current_score).toBe(88)
  })
  test('falls back to the first student enrollment, or null', () => {
    expect(pickEnrollment({ enrollments: [{ type: 'student' }] })).toEqual({ type: 'student' })
    expect(pickEnrollment({ enrollments: [{ type: 'teacher' }] })).toBeNull()
  })
})

describe('mapLimit', () => {
  test('keeps order and never runs more than the limit at once', async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5 - (n % 3)))
      running--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70])
    expect(peak).toBeLessThanOrEqual(3)
  })
  test('empty list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })
})

describe('fetchAll', () => {
  test('follows next links', async () => {
    const pages: Record<string, { data: unknown; next: string | null }> = {
      a: { data: [1, 2], next: 'b' },
      b: { data: [3], next: null },
    }
    expect(await fetchAll(async (p) => pages[p], 'a')).toEqual([1, 2, 3])
  })
  test('rejects a non-list body', async () => {
    await expect(fetchAll(async () => ({ data: { errors: [] }, next: null }), 'a')).rejects.toThrow('not a list')
  })
})

// ---------------------------------------------------------------- fetchers (global fetch stubbed)

function fakeResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers })
}

describe('sameOriginFetcher', () => {
  test('requests /api/v1/<path> with cookies, strips while(1);, reads Link', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, 'while(1);[{"id":1}]', {
        Link: '<https://canvas.cmu.edu/api/v1/courses?page=2&per_page=100>; rel="next"',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const page = await sameOriginFetcher()('courses?per_page=100')
    expect(page).toEqual({ data: [{ id: 1 }], next: 'courses?page=2&per_page=100' })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/courses?per_page=100', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
  })
  test('401 is a CanvasAuthError asking to log in', async () => {
    vi.stubGlobal('fetch', async () => fakeResponse(401, '{}'))
    const err = await sameOriginFetcher()('courses').catch((e) => e)
    expect(err).toBeInstanceOf(CanvasAuthError)
    expect(err.message).toBe('Log in to Canvas first')
  })
  test('other errors carry the status', async () => {
    vi.stubGlobal('fetch', async () => fakeResponse(404, '{}'))
    const err = await sameOriginFetcher()('courses').catch((e) => e)
    expect(err).toBeInstanceOf(CanvasHttpError)
    expect(err.status).toBe(404)
  })
})

// ---------------------------------------------------------------- syncCanvas with a fake Canvas

// Synthetic courses mirroring the real shapes: nickname, two sections, Default Term shells,
// hidden totals, a TA course, empty groups, extra credit, and the course list split over two pages.
const coursesPage1 = [
  {
    id: 101,
    name: '1. 21241', // student nickname
    original_name: 'Matrices and Linear Transformations',
    course_code: '21241',
    term: { name: 'Fall 2026' },
    apply_assignment_group_weights: true,
    grading_standard_id: 9,
    hide_final_grades: false,
    enrollments: [
      { type: 'student', computed_current_score: null, computed_current_grade: null },
      { type: 'student', computed_current_score: 91.5, computed_current_grade: 'A-' },
    ],
  },
  {
    id: 102,
    name: 'Career Launch',
    course_code: 'Career Launch Career Launch - Class of 2029+',
    term: { name: 'Default Term' },
    apply_assignment_group_weights: false,
    grading_standard_id: null,
    enrollments: [{ type: 'student', computed_current_score: null }],
  },
]
const coursesPage2 = [
  {
    id: 103,
    name: 'Probability and Statistics',
    course_code: '36225',
    term: { name: 'Fall 2026' },
    apply_assignment_group_weights: false,
    grading_standard_id: 404, // standard that will fail to load
    hide_final_grades: true,
    enrollments: [{ type: 'student', computed_current_score: 77, computed_current_grade: 'C' }],
  },
  {
    id: 104,
    name: 'Course I TA for',
    course_code: '15112',
    term: { name: 'Fall 2026' },
    enrollments: [{ type: 'ta' }],
  },
  { id: 105, access_restricted_by_date: true }, // stub with no enrollments
]

const groups101 = [
  {
    id: 1,
    name: 'Quizzes',
    position: 1,
    group_weight: 10,
    rules: { drop_lowest: 1 },
    assignments: [
      {
        id: 11,
        name: 'Quiz 1',
        points_possible: 10,
        grading_type: 'points',
        published: true,
        due_at: '2026-09-11T03:59:00Z',
        html_url: 'https://canvas.cmu.edu/courses/101/assignments/11',
        submission: { score: 8, workflow_state: 'graded', excused: false, missing: false },
      },
      {
        id: 12,
        name: 'Quiz 2',
        points_possible: 10,
        grading_type: 'points',
        published: true,
        due_at: null,
        html_url: 'https://canvas.cmu.edu/courses/101/assignments/12',
        submission: { score: null, workflow_state: 'submitted' },
      },
    ],
  },
  { id: 2, name: 'Final Exam', group_weight: 25, rules: {}, assignments: [] }, // empty group
  {
    id: 3,
    name: 'Midterm Exams',
    group_weight: 55,
    rules: {},
    assignments: [
      {
        id: 31,
        name: 'Midterm Curve 3%',
        points_possible: 0, // extra credit
        grading_type: 'points',
        published: true,
        submission: { score: 3, workflow_state: 'graded' },
      },
      {
        id: 32,
        name: 'Syllabus quiz',
        points_possible: null,
        grading_type: 'not_graded',
        omit_from_final_grade: true,
        published: true,
        submission: { score: null, workflow_state: 'unsubmitted', excused: true },
      },
    ],
  },
]

const standards101 = [
  { id: 8, grading_scheme: [{ name: 'A', value: 0.5 }] }, // a different standard, must be ignored
  {
    id: 9,
    title: 'Course scale',
    context_type: 'Course',
    points_based: false,
    grading_scheme: [
      { name: 'A', value: 0.9317, calculated_value: 93.17 },
      { name: 'A-', value: 0.8633 },
      { name: 'B', value: 0.8 },
      { name: 'R', value: 0 },
    ],
  },
]

/** Fake PageFetcher: matches on the path prefix and records every request. */
function fakeCanvas(overrides: Record<string, () => unknown> = {}) {
  const calls: string[] = []
  const fetchPage: PageFetcher = async (path) => {
    calls.push(path)
    for (const [prefix, fn] of Object.entries(overrides)) if (path.startsWith(prefix)) return { data: fn(), next: null }
    if (path.startsWith('courses?page=2')) return { data: coursesPage2, next: null }
    if (path.startsWith('courses?')) return { data: coursesPage1, next: 'courses?page=2&per_page=100' }
    if (path.startsWith('courses/101/assignment_groups')) return { data: groups101, next: null }
    if (path.startsWith('courses/101/grading_standards')) return { data: standards101, next: null }
    if (path.startsWith('courses/103/grading_standards')) throw new CanvasHttpError(404, 'Canvas answered 404')
    if (path.includes('/assignment_groups')) return { data: [], next: null }
    throw new Error('unexpected path ' + path)
  }
  return { fetchPage, calls }
}

describe('syncCanvas', () => {
  test('maps courses, groups, items and schemes from synthetic data', async () => {
    const { fetchPage, calls } = fakeCanvas()
    const progress: string[] = []
    const payload = await syncCanvas(fetchPage, (m) => progress.push(m))

    expect(payload.v).toBe(1)
    expect(payload.kind).toBe('canvas')
    // TA course and the restricted stub are dropped; both course-list pages were read.
    expect(payload.courses.map((c) => c.sourceId)).toEqual(['101', '102', '103'])
    expect(calls).toContain('courses?page=2&per_page=100')
    expect(calls.some((c) => c.startsWith('courses/104'))).toBe(false)
    // No standards request for a course without grading_standard_id.
    expect(calls.some((c) => c.startsWith('courses/102/grading_standards'))).toBe(false)

    const [linear, shell, stats] = payload.courses

    // Nickname: title comes from original_name; score from the second (scored) enrollment.
    expect(linear).toMatchObject({
      source: 'canvas',
      number: '21241',
      alsoNumbers: [],
      title: 'Matrices and Linear Transformations',
      term: 'Fall 2026',
      url: 'https://canvas.cmu.edu/courses/101',
      weighted: true,
      canvasScore: 91.5,
      canvasGrade: 'A-',
    })
    expect(linear.scheme).toEqual([
      { letter: 'A', min: 93.17 },
      { letter: 'A-', min: 86.33 },
      { letter: 'B', min: 80 },
      { letter: 'R', min: 0 },
    ])
    expect(linear.categories.map((c) => [c.id, c.name, c.weight, c.dropLowest])).toEqual([
      ['1', 'Quizzes', 10, 1],
      ['2', 'Final Exam', 25, 0],
      ['3', 'Midterm Exams', 55, 0],
    ])
    const byId = Object.fromEntries(linear.items.map((i) => [i.id, i]))
    expect(byId['11']).toEqual({
      id: '11',
      name: 'Quiz 1',
      categoryId: '1',
      score: 8,
      max: 10,
      status: 'graded',
      due: '2026-09-11T03:59:00Z',
      omit: false,
      url: 'https://canvas.cmu.edu/courses/101/assignments/11',
    })
    expect(byId['12'].status).toBe('submitted')
    expect(byId['31']).toMatchObject({ score: 3, max: 0, status: 'graded' }) // extra credit kept as-is
    expect(byId['32']).toMatchObject({ status: 'excused', omit: true, max: null })

    // Default Term shell: no number, term null, still included (the UI decides what to show).
    expect(shell).toMatchObject({ number: null, term: null, canvasScore: null, scheme: null, items: [] })

    // hide_final_grades: no score or letter even though the enrollment has them.
    expect(stats).toMatchObject({ number: '36225', weighted: false, canvasScore: null, canvasGrade: null, scheme: null })
    // The 404 on the letter scale becomes a warning, not a failure.
    expect(payload.warnings).toEqual([expect.stringContaining('Probability and Statistics: could not read the letter scale')])

    expect(progress[0]).toBe('Canvas: reading your course list')
    expect(progress).toContain('Canvas: 0 of 3 courses')
    expect(progress[progress.length - 1]).toBe('Canvas: 3 of 3 courses')
    expect(typeof payload.at).toBe('string')
    expect(linear.syncedAt).toBe(payload.at)
  })

  test('a course whose assignments fail is kept with a warning', async () => {
    const { fetchPage } = fakeCanvas({
      'courses/101/assignment_groups': () => {
        throw new CanvasHttpError(500, 'Canvas answered 500')
      },
    })
    const payload = await syncCanvas(fetchPage)
    const linear = payload.courses.find((c) => c.sourceId === '101')!
    expect(linear.items).toEqual([])
    expect(linear.canvasScore).toBe(91.5) // still useful from the course list
    expect(payload.warnings).toContain('Matrices and Linear Transformations: could not read assignments (Canvas answered 500)')
    // Listed as failed so the app keeps the stored assignments instead of replacing them with [].
    expect(payload.failedIds).toEqual(['101'])
  })

  test('a letter-scale failure alone does not mark the course as failed', async () => {
    const { fetchPage } = fakeCanvas() // course 103's grading_standards answers 404
    const payload = await syncCanvas(fetchPage)
    expect(payload.failedIds).toEqual([])
  })

  test('missing standard id in the list gives a warning and no scheme', async () => {
    const { fetchPage } = fakeCanvas({ 'courses/101/grading_standards': () => [{ id: 1, grading_scheme: [] }] })
    const payload = await syncCanvas(fetchPage)
    expect(payload.courses[0].scheme).toBeNull()
    expect(payload.warnings).toContain('Matrices and Linear Transformations: letter scale not found, using the default')
  })

  test('logging out mid-sync fails the whole sync', async () => {
    const { fetchPage } = fakeCanvas({
      'courses/103/assignment_groups': () => {
        throw new CanvasAuthError('Log in to Canvas first')
      },
    })
    await expect(syncCanvas(fetchPage)).rejects.toBeInstanceOf(CanvasAuthError)
  })

  test('a failing course list fails the sync', async () => {
    const fetchPage: PageFetcher = async () => {
      throw new CanvasAuthError('Canvas rejected the token')
    }
    await expect(syncCanvas(fetchPage)).rejects.toThrow('Canvas rejected the token')
  })

  test('no courses at all', async () => {
    const payload = await syncCanvas(async () => ({ data: [], next: null }))
    expect(payload.courses).toEqual([])
    expect(payload.warnings).toEqual([])
  })
})

// ---------------------------------------------------------------- syllabi (synthetic syllabus text only)

/** A made-up syllabus page in the shape Canvas's rich editor produces. */
const SYLLABUS_HTML =
  '<h2>Course Policies</h2>' +
  '<p>Your grade is computed as follows:</p>' +
  '<ul><li>Average Homework Score: 15%</li><li>Average Quiz Score:&nbsp;15%</li>' +
  '<li>Midterm 1: <strong>20%</strong></li><li>Midterm 2: 20%</li><li>Final Exam: 30%</li></ul>' +
  '<table><tbody><tr><td>A</td><td>90&ndash;100</td></tr></tbody></table>' +
  '<p>Questions? Read the <a href="/courses/103/files/900?wrap=1">Syllabus (PDF)</a> &amp; ask.<br>Thanks</p>' +
  '<script>alert(1)</script><style>p{color:red}</style>'

const pdfBytes = (body = 'synthetic syllabus') => new TextEncoder().encode('%PDF-1.4\n' + body)

describe('htmlToText', () => {
  test('keeps one line per paragraph, list item, cell and heading', () => {
    expect(htmlToText(SYLLABUS_HTML)).toBe(
      [
        'Course Policies',
        '',
        'Your grade is computed as follows:',
        '',
        'Average Homework Score: 15%',
        '',
        'Average Quiz Score: 15%',
        '',
        'Midterm 1: 20%',
        '',
        'Midterm 2: 20%',
        '',
        'Final Exam: 30%',
        '',
        'A',
        '',
        '90-100',
        '',
        'Questions? Read the Syllabus (PDF) & ask.',
        'Thanks',
      ].join('\n'),
    )
  })
  test('drops scripts, styles and comments; empty HTML gives empty text', () => {
    expect(htmlToText('<p>x</p><!-- hidden 50% --><script>var y = "40%"</script>')).toBe('x')
    expect(htmlToText('')).toBe('')
    expect(htmlToText('<p> </p><br/>')).toBe('')
  })
})

describe('decodeEntities', () => {
  test('named and numeric entities, decoded once', () => {
    expect(decodeEntities('A &amp; B &lt;3 &#37; &#x25; &nbsp;x')).toBe('A & B <3 % %  x')
    expect(decodeEntities('&amp;lt;')).toBe('&lt;') // not decoded twice
    expect(decodeEntities('&unknown; &#0;')).toBe('&unknown; &#0;')
  })
})

describe('findFileLinks', () => {
  test('relative and absolute Canvas file links with their text; other sites ignored', () => {
    const html =
      '<a href="/courses/5/files/11/download">Syllabus</a>' +
      '<a class="x" href="https://canvas.cmu.edu/courses/5/files/12?verifier=abc&amp;wrap=1"><b>Course</b> info</a>' +
      '<a href="/files/13">here</a>' +
      '<a href="https://evil.example/courses/5/files/14">Syllabus</a>' +
      '<a href="/courses/5/pages/syllabus">Syllabus page</a>'
    expect(findFileLinks(html)).toEqual([
      { fileId: '11', text: 'Syllabus' },
      { fileId: '12', text: 'Course info' },
      { fileId: '13', text: 'here' },
    ])
  })
})

describe('bytesToBase64 / withoutSyllabusPdfs', () => {
  test('round-trips through atob, including big inputs', () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 256)
    const back = Uint8Array.from(atob(bytesToBase64(big)), (c) => c.charCodeAt(0))
    expect(back).toEqual(big)
    expect(bytesToBase64(new TextEncoder().encode('%PDF'))).toBe('JVBERg==')
  })
  test('removes only the PDF bytes', () => {
    const course = { sourceId: '1', syllabus: [{ source: 'canvas-file' as const, name: 's.pdf', url: null, pdfBase64: 'AAAA' }] }
    const payload = { v: 1 as const, kind: 'canvas' as const, at: '', warnings: [], courses: [course] }
    const out = withoutSyllabusPdfs(payload as never)
    expect(out.courses[0].syllabus).toEqual([{ source: 'canvas-file', name: 's.pdf', url: null }])
    expect(course.syllabus[0].pdfBase64).toBe('AAAA') // the original is untouched
  })
})

describe('binary fetchers', () => {
  test('same-origin download returns the bytes and content type', async () => {
    const fetchMock = vi.fn(async () => new Response(pdfBytes(), { status: 200, headers: { 'Content-Type': 'application/pdf' } }))
    vi.stubGlobal('fetch', fetchMock)
    const got = await sameOriginBinaryFetcher()('/files/9/download?verifier=v')
    expect(got.contentType).toBe('application/pdf')
    expect(new TextDecoder().decode(got.bytes)).toContain('%PDF')
    expect(fetchMock).toHaveBeenCalledWith('/files/9/download?verifier=v', { credentials: 'same-origin' })
  })
  test('the extension version adds the Canvas origin and sends cookies', async () => {
    const fetchMock = vi.fn(async () => new Response(pdfBytes(), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await absoluteBinaryFetcher('https://canvas.cmu.edu')('/files/9/download')
    expect(fetchMock).toHaveBeenCalledWith('https://canvas.cmu.edu/files/9/download', { credentials: 'include' })
  })
  test('refuses anything that is not a Canvas path', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(sameOriginBinaryFetcher()('https://evil.example/x')).rejects.toThrow('Refused')
    await expect(absoluteBinaryFetcher('https://canvas.cmu.edu')('//evil.example/x')).rejects.toThrow('Refused')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  test('401 and other errors match the JSON fetchers', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 401 }))
    await expect(sameOriginBinaryFetcher()('/files/1/download')).rejects.toBeInstanceOf(CanvasAuthError)
    vi.stubGlobal('fetch', async () => new Response('', { status: 500 }))
    await expect(sameOriginBinaryFetcher()('/files/1/download')).rejects.toMatchObject({ status: 500 })
  })
})

/** Canvas file metadata as /api/v1/files/:id returns it (only the fields we read). */
function fileMeta(id: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    display_name: name,
    'content-type': 'application/pdf',
    size: 2000,
    url: `https://canvas.cmu.edu/files/${id}/download?download_frd=1&verifier=v${id}`,
    ...extra,
  }
}

/**
 * A fake Canvas for syllabus requests. `pages` maps an exact API path to its answer: a value, or an Error to throw.
 * Unknown paths answer 404, like a course with no home page.
 */
function fakeSyllabusCanvas(pages: Record<string, unknown>) {
  const calls: string[] = []
  const fetchPage: PageFetcher = async (path) => {
    calls.push(path)
    if (!(path in pages)) throw new CanvasHttpError(404, 'Canvas answered 404')
    const answer = pages[path]
    if (answer instanceof Error) throw answer
    return { data: answer, next: null }
  }
  return { fetchPage, calls }
}

/** A fake file download: maps a path to bytes (or an Error). Records every path. */
function fakeDownloads(files: Record<string, Uint8Array | Error>) {
  const calls: string[] = []
  const fetchBinary: BinaryFetcher = async (path) => {
    calls.push(path)
    const got = files[path]
    if (got === undefined) throw new CanvasHttpError(404, 'Canvas answered 404')
    if (got instanceof Error) throw got
    return { contentType: 'application/pdf', bytes: got }
  }
  return { fetchBinary, calls }
}

const COURSE_103 = 'courses/103?include[]=syllabus_body'
const SEARCH_103 = 'courses/103/files?search_term=syllabus&per_page=20'

describe('collectSyllabus', () => {
  test('Syllabus page HTML plus the PDF it links (Files tab hidden, no home page)', async () => {
    const { fetchPage, calls } = fakeSyllabusCanvas({
      [COURSE_103]: { id: 103, syllabus_body: SYLLABUS_HTML },
      [SEARCH_103]: new CanvasHttpError(403, 'Canvas answered 403'), // Files tab hidden
      'files/900': fileMeta(900, 'Stats Fall 2026.pdf'), // link text says "Syllabus", the name does not
    })
    const downloads = fakeDownloads({ '/files/900/download?download_frd=1&verifier=v900': pdfBytes() })
    const problems: string[] = []
    const docs = await collectSyllabus(fetchPage, downloads.fetchBinary, '103', { left: 10_000_000 }, problems)

    expect(docs).toEqual([
      {
        source: 'canvas-syllabus',
        name: 'Syllabus page',
        url: 'https://canvas.cmu.edu/courses/103/assignments/syllabus',
        text: expect.stringContaining('Midterm 1: 20%'),
      },
      {
        source: 'canvas-file',
        name: 'Stats Fall 2026.pdf',
        url: 'https://canvas.cmu.edu/courses/103/files/900',
        pdfBase64: bytesToBase64(pdfBytes()),
      },
    ])
    expect(calls).toEqual([COURSE_103, 'courses/103/front_page', SEARCH_103, 'files/900'])
    expect(problems).toEqual([]) // 403 and 404 are normal, not problems
  })

  test('home page link found by file name; files search adds another; non-PDFs and duplicates skipped', async () => {
    const { fetchPage, calls } = fakeSyllabusCanvas({
      'courses/101?include[]=syllabus_body': { id: 101, syllabus_body: null },
      'courses/101/front_page': {
        title: 'Welcome to Matrices',
        body: '<p>Grades: see <a href="/courses/101/files/71">here</a>. <a href="/courses/101/files/72">HW 1</a> <a href="/courses/101/files/73">Old</a></p>',
      },
      'courses/101/files?search_term=syllabus&per_page=20': [
        fileMeta(80, 'Syllabus notes.docx', { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
        fileMeta(73, 'syllabus-2025.pdf', { locked_for_user: true }), // locked: skipped, and not looked up again
      ],
      'files/71': fileMeta(71, 'sylb.pdf'),
      'files/72': fileMeta(72, 'hw1.pdf'), // linked, but not a syllabus
    })
    const downloads = fakeDownloads({ '/files/71/download?download_frd=1&verifier=v71': pdfBytes() })
    const problems: string[] = []
    const docs = await collectSyllabus(fetchPage, downloads.fetchBinary, '101', { left: 10_000_000 }, problems)

    expect(docs.map((d) => [d.source, d.name])).toEqual([
      ['canvas-front-page', 'Welcome to Matrices'],
      ['canvas-file', 'sylb.pdf'],
    ])
    expect(docs[0].text).toBe('Grades: see here. HW 1 Old')
    expect(calls).not.toContain('files/73')
    expect(downloads.calls).toEqual(['/files/71/download?download_frd=1&verifier=v71'])
    expect(problems).toEqual([])
  })

  test('without a binary fetcher only the HTML pages are read', async () => {
    const { fetchPage, calls } = fakeSyllabusCanvas({ [COURSE_103]: { syllabus_body: SYLLABUS_HTML } })
    const docs = await collectSyllabus(fetchPage, null, '103', { left: 10_000_000 }, [])
    expect(docs.map((d) => d.source)).toEqual(['canvas-syllabus'])
    expect(calls).toEqual([COURSE_103, 'courses/103/front_page'])
  })

  test('a PDF over 3 MB is skipped with a reason; a non-PDF answer is skipped silently', async () => {
    const { fetchPage } = fakeSyllabusCanvas({
      [COURSE_103]: { syllabus_body: '' },
      [SEARCH_103]: [fileMeta(1, 'Syllabus big.pdf', { size: 4 * 1024 * 1024 }), fileMeta(2, 'Syllabus.pdf')],
    })
    const downloads = fakeDownloads({
      '/files/2/download?download_frd=1&verifier=v2': new TextEncoder().encode('<html>Log in</html>'),
    })
    const problems: string[] = []
    const docs = await collectSyllabus(fetchPage, downloads.fetchBinary, '103', { left: 10_000_000 }, problems)
    expect(docs).toEqual([])
    expect(downloads.calls).toEqual(['/files/2/download?download_frd=1&verifier=v2']) // the big one was never downloaded
    expect(problems).toEqual(['Syllabus big.pdf is over 3 MB'])
  })

  test('downloads at most two PDFs and stays inside the shared byte budget', async () => {
    const files = [fileMeta(1, 'Syllabus A.pdf'), fileMeta(2, 'Syllabus B.pdf'), fileMeta(3, 'Syllabus C.pdf')]
    const { fetchPage } = fakeSyllabusCanvas({ [COURSE_103]: { syllabus_body: null }, [SEARCH_103]: files })
    const bytes = pdfBytes('x'.repeat(1991)) // 2000 bytes, matching the size Canvas reported
    const downloads = fakeDownloads(
      Object.fromEntries(files.map((f) => [`/files/${f.id}/download?download_frd=1&verifier=v${f.id}`, bytes])),
    )
    const many = await collectSyllabus(fetchPage, downloads.fetchBinary, '103', { left: 10_000_000 }, [])
    expect(many.map((d) => d.name)).toEqual(['Syllabus A.pdf', 'Syllabus B.pdf'])

    const budget = { left: 3000 } // room for one
    const few = await collectSyllabus(fetchPage, downloads.fetchBinary, '103', budget, [])
    expect(few.map((d) => d.name)).toEqual(['Syllabus A.pdf'])
    expect(budget.left).toBe(1000)
  })

  test('a server error is a problem; a failed download gives its reservation back', async () => {
    const { fetchPage } = fakeSyllabusCanvas({
      [COURSE_103]: new CanvasHttpError(500, 'Canvas answered 500'),
      [SEARCH_103]: [fileMeta(1, 'Syllabus.pdf')],
    })
    const downloads = fakeDownloads({ '/files/1/download?download_frd=1&verifier=v1': new TypeError('Failed to fetch') })
    const budget = { left: 10_000 }
    const problems: string[] = []
    expect(await collectSyllabus(fetchPage, downloads.fetchBinary, '103', budget, problems)).toEqual([])
    expect(problems).toEqual(['Canvas answered 500', 'Failed to fetch'])
    expect(budget.left).toBe(10_000)
  })
})

describe('syncCanvas with syllabi', () => {
  /** The usual fake Canvas from above, plus syllabus answers for course 103 and a home page for 101. */
  function fakeWithSyllabi(extra: Record<string, unknown> = {}) {
    const base = fakeCanvas()
    const syllabus = fakeSyllabusCanvas({
      [COURSE_103]: { syllabus_body: SYLLABUS_HTML },
      'courses/101/front_page': { title: 'Home', body: '<p>Welcome</p>' },
      'files/900': fileMeta(900, 'Syllabus.pdf'),
      ...extra,
    })
    const calls: string[] = []
    const fetchPage: PageFetcher = async (path) => {
      calls.push(path)
      const isSyllabusPath = /\?include\[\]=syllabus_body$|\/front_page$|\/files\?|^files\//.test(path)
      return isSyllabusPath ? syllabus.fetchPage(path) : base.fetchPage(path)
    }
    return { fetchPage, calls }
  }

  test('off by default: no syllabus requests at all', async () => {
    const { fetchPage, calls } = fakeWithSyllabi()
    const payload = await syncCanvas(fetchPage)
    expect(calls.some((c) => c.includes('syllabus') || c.includes('front_page'))).toBe(false)
    expect(payload.courses.every((c) => c.syllabus === undefined)).toBe(true)
  })

  test('adds syllabus docs to numbered courses only, with progress and no extra warnings', async () => {
    const { fetchPage, calls } = fakeWithSyllabi()
    const downloads = fakeDownloads({ '/files/900/download?download_frd=1&verifier=v900': pdfBytes() })
    const progress: string[] = []
    const payload = await syncCanvas(fetchPage, (m) => progress.push(m), { syllabus: { fetchBinary: downloads.fetchBinary } })

    const [linear, shell, stats] = payload.courses
    expect(linear.syllabus?.map((d) => d.source)).toEqual(['canvas-front-page'])
    expect(shell.syllabus).toBeUndefined() // no course number: not a real class
    expect(calls.some((c) => c.startsWith('courses/102?'))).toBe(false)
    expect(stats.syllabus?.map((d) => d.source)).toEqual(['canvas-syllabus', 'canvas-file'])
    expect(stats.syllabus?.[1].pdfBase64).toBe(bytesToBase64(pdfBytes()))
    // Only the letter-scale warning from before: 403/404 syllabus pieces are silent.
    expect(payload.warnings).toEqual([expect.stringContaining('could not read the letter scale')])
    expect(progress.at(-1)).toBe('Canvas: read 2 of 2 syllabi')
  })

  test('at most one warning per course, however many pieces fail', async () => {
    const { fetchPage } = fakeWithSyllabi({
      [COURSE_103]: new CanvasHttpError(500, 'Canvas answered 500'),
      'courses/103/front_page': new CanvasHttpError(502, 'Canvas answered 502'),
    })
    const payload = await syncCanvas(fetchPage, undefined, { syllabus: { fetchBinary: null } })
    const syllabusWarnings = payload.warnings.filter((w) => w.includes('syllabus'))
    expect(syllabusWarnings).toEqual(['Probability and Statistics: could not read the syllabus (Canvas answered 500)'])
    expect(payload.courses[2].syllabus).toBeUndefined()
  })

  test('logging out during the syllabus step keeps the grades and stays quiet', async () => {
    const { fetchPage } = fakeWithSyllabi({ [COURSE_103]: new CanvasAuthError('Log in to Canvas first') })
    const payload = await syncCanvas(fetchPage, undefined, { syllabus: { fetchBinary: null } })
    expect(payload.courses).toHaveLength(3)
    expect(payload.warnings.filter((w) => w.includes('syllabus'))).toEqual([])
  })

  test('reads at most 8 courses, newest terms first', async () => {
    const terms = ['Fall 2024', 'Spring 2025', 'Fall 2025', 'Spring 2026', 'Fall 2026']
    const list = Array.from({ length: 10 }, (_, i) => ({
      id: 500 + i,
      name: `Course ${i}`,
      course_code: `15${String(100 + i)}`,
      term: { name: terms[i % 5] },
      enrollments: [{ type: 'student' }],
    }))
    const asked: string[] = []
    const fetchPage: PageFetcher = async (path) => {
      if (path.startsWith('courses?')) return { data: list, next: null }
      if (path.includes('/assignment_groups')) return { data: [], next: null }
      if (path.endsWith('?include[]=syllabus_body')) asked.push(path.split(/[/?]/)[1])
      throw new CanvasHttpError(404, 'Canvas answered 404')
    }
    await syncCanvas(fetchPage, undefined, { syllabus: { fetchBinary: null } })
    // The two Fall 2024 courses (500, 505) are the oldest and are left out.
    expect(asked.sort()).toEqual(['501', '502', '503', '504', '506', '507', '508', '509'])
  })
})
