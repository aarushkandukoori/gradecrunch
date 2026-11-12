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
}))

import {
  CanvasAuthError,
  CanvasHttpError,
  fetchAll,
  itemStatus,
  mapAssignment,
  mapGroup,
  mapLimit,
  mapScheme,
  nextPathFromLink,
  parseCanvasJson,
  pickEnrollment,
  sameOriginFetcher,
  syncCanvas,
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
