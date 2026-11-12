// Tests for the merge module: catalog lookup, name matching, and buildCourses (synced data + prefs -> Course[]).
// All data here is synthetic.
import { beforeAll, describe, expect, test } from 'vitest'
import { loadCatalog, lookupCourse } from '../src/lib/catalog'
import { bestCategoryMatch, inferCategory, normalizeName } from '../src/lib/categorize'
import { DEFAULT_SCHEME_GRAD, DEFAULT_SCHEME_UNDERGRAD } from '../src/lib/cmu'
import { buildCourses, median, stripNumberPrefix, termSortKey, termsOf } from '../src/lib/merge'
import type { Course, CoursePrefs, ManualCourse, Settings, Store, SyncedCategory, SyncedCourse, SyncedItem } from '../src/types'

// ---------------------------------------------------------------- builders for synthetic data

// The units catalog loads lazily in the app; load it up front for these tests.
beforeAll(() => loadCatalog())

function cat(id: string, name: string, weight: number | null = null, extra: Partial<SyncedCategory> = {}): SyncedCategory {
  return { id, name, weight, dropLowest: 0, dropHighest: 0, neverDrop: [], ...extra }
}

function item(id: string, name: string, categoryId: string | null, score: number | null, max: number | null, extra: Partial<SyncedItem> = {}): SyncedItem {
  return {
    id,
    name,
    categoryId,
    score,
    max,
    status: score === null ? 'unsubmitted' : 'graded',
    due: null,
    omit: false,
    url: null,
    ...extra,
  }
}

function canvas(sourceId: string, extra: Partial<SyncedCourse> = {}): SyncedCourse {
  return {
    source: 'canvas',
    sourceId,
    number: '21241',
    alsoNumbers: [],
    title: '21241 Matrices',
    term: 'Fall 2026',
    url: `https://canvas.cmu.edu/courses/${sourceId}`,
    weighted: true,
    categories: [],
    items: [],
    canvasScore: null,
    canvasGrade: null,
    scheme: null,
    syncedAt: '2026-11-12T10:00:00Z',
    ...extra,
  }
}

function gs(sourceId: string, extra: Partial<SyncedCourse> = {}): SyncedCourse {
  return {
    ...canvas(sourceId),
    source: 'gradescope',
    title: 'Matrices and Linear Transformations',
    url: `https://www.gradescope.com/courses/${sourceId}`,
    weighted: false,
    ...extra,
  }
}

const SETTINGS: Settings = { level: 'undergrad', college: null, priorQpa: null, priorUnits: null, term: null, showAll: false }

function store(synced: SyncedCourse[], opts: { manual?: ManualCourse[]; prefs?: Record<string, CoursePrefs>; settings?: Partial<Settings> } = {}): Store {
  const map: Record<string, SyncedCourse> = {}
  for (const c of synced) map[`${c.source}:${c.sourceId}`] = c
  return {
    v: 1,
    synced: map,
    manual: opts.manual ?? [],
    prefs: opts.prefs ?? {},
    settings: { ...SETTINGS, ...opts.settings },
    lastSync: {},
  }
}

function only(courses: Course[]): Course {
  expect(courses).toHaveLength(1)
  return courses[0]
}

function itemNamed(c: Course, name: string) {
  const found = c.items.find((i) => i.name === name)
  if (!found) throw new Error(`no item ${name}`)
  return found
}

// ---------------------------------------------------------------- catalog

describe('lookupCourse', () => {
  test('fixed units', () => {
    expect(lookupCourse('15122')).toEqual({ title: 'Principles of Imperative Computation', units: 12, unitsText: '12' })
    expect(lookupCourse('21241')?.units).toBe(11)
  })
  test('accepts a dash', () => {
    expect(lookupCourse('15-122')?.units).toBe(12)
  })
  test('variable units become null, text kept', () => {
    expect(lookupCourse('15591')).toEqual({ title: 'Independent Study in Computer Science', units: null, unitsText: '3-18' })
    expect(lookupCourse('02261')?.unitsText).toBe('VAR')
  })
  test('fractional units', () => {
    expect(lookupCourse('33101')?.units).toBe(4.5)
  })
  test('unknown or malformed numbers', () => {
    expect(lookupCourse('12345')).toBeNull()
    expect(lookupCourse('')).toBeNull()
    expect(lookupCourse('1512')).toBeNull()
    expect(lookupCourse('constructor')).toBeNull()
  })
})

// ---------------------------------------------------------------- categorize

describe('normalizeName', () => {
  test('homework spellings match', () => {
    expect(normalizeName('HW01')).toBe('hw1')
    expect(normalizeName('hw 1')).toBe('hw1')
    expect(normalizeName('Homework #1')).toBe('hw1')
    expect(normalizeName('HW#2')).toBe('hw2')
  })
  test('problem sets', () => {
    expect(normalizeName('Problem Set 03')).toBe('ps3')
    expect(normalizeName('PSet 3')).toBe('ps3')
    expect(normalizeName('ps3')).toBe('ps3')
  })
  test('keeps meaningful zeros', () => {
    expect(normalizeName('Lab 10')).toBe('lab10')
    expect(normalizeName('Quiz 0')).toBe('quiz0')
    expect(normalizeName('Midterm 1A')).toBe('midterm1a')
  })
  test('junk input', () => {
    expect(normalizeName('')).toBe('')
    expect(normalizeName(undefined as unknown as string)).toBe('')
  })
})

describe('inferCategory', () => {
  test.each([
    ['HW 3', 'Homework'],
    ['Homework #1', 'Homework'],
    ['Problem Set 2', 'Homework'],
    ['pset4', 'Homework'],
    ['Writing Assignment 1', 'Homework'],
    ['Online Assignments', 'Homework'],
    ['Quiz #2', 'Quizzes'],
    ['Quizzes', 'Quizzes'],
    ['Midterm 1A', 'Exams'],
    ['Exam 2', 'Exams'],
    ['Final Exam', 'Exams'],
    ['Test 1', 'Exams'],
    ['Lab 4', 'Labs'],
    ['Term Project', 'Projects'],
    ['Final Project', 'Projects'],
    ['Lab Assignment 2', 'Labs'],
    ['Recitation Quiz 3', 'Quizzes'],
    ['Recitation 5', 'Participation'],
    ['Attendance', 'Participation'],
    ['Participation', 'Participation'],
    ['Preliminary Matters', 'Other'],
    ['Survey', 'Other'],
    ['Latest news', 'Other'], // "test" inside a word does not count
  ])('%s -> %s', (name, kind) => {
    expect(inferCategory(name)).toBe(kind)
  })
})

describe('bestCategoryMatch', () => {
  const cats = [
    { key: 'hw', name: 'Homework' },
    { key: 'q', name: 'Quizzes' },
    { key: 'm1', name: 'Midterm 1' },
    { key: 'e2', name: 'Exam 2' },
  ]
  test('exact normalized name first', () => {
    expect(bestCategoryMatch('Midterm 1', cats)).toBe('m1')
    expect(bestCategoryMatch('exam 2', cats)).toBe('e2')
  })
  test('category name as prefix', () => {
    expect(bestCategoryMatch('Midterm 1A', cats)).toBe('m1')
    expect(bestCategoryMatch('Exam 2A', cats)).toBe('e2')
    expect(bestCategoryMatch('HW 7', cats)).toBe('hw') // "Homework" normalizes to "hw"
  })
  test('prefix never splits a number', () => {
    expect(bestCategoryMatch('Exam 21', [{ key: 'e2', name: 'Exam 2' }])).toBe('e2') // falls to kind, still Exams
    expect(bestCategoryMatch('Exam 21', [{ key: 'e2', name: 'Exam 2' }, { key: 'ex', name: 'Exams' }])).toBe('e2')
  })
  test('same kind', () => {
    expect(bestCategoryMatch('Quiz 3', cats)).toBe('q')
    expect(bestCategoryMatch('Problem Set 1', cats)).toBe('hw')
  })
  test('same kind: shared words beat list order', () => {
    expect(bestCategoryMatch('Exam 3', cats)).toBe('e2')
    expect(bestCategoryMatch('Midterm 3', cats)).toBe('m1')
  })
  test('same kind: a positive weight breaks ties', () => {
    const list = [
      { key: 'imp', name: 'Imported Assignments', weight: 0 },
      { key: 'a', name: 'Assignments', weight: 25 },
    ]
    expect(bestCategoryMatch('HW 3', list)).toBe('a')
  })
  test('no match', () => {
    expect(bestCategoryMatch('Survey', cats)).toBeNull()
    expect(bestCategoryMatch('Lab 1', cats)).toBeNull()
    expect(bestCategoryMatch('Quiz 1', [])).toBeNull()
    expect(bestCategoryMatch('', cats)).toBeNull()
  })
})

// ---------------------------------------------------------------- terms

describe('termSortKey / termsOf', () => {
  test('long and short forms', () => {
    expect(termSortKey('Fall 2026')).toBe(20263)
    expect(termSortKey('Spring 2027')).toBe(20271)
    expect(termSortKey('Summer 2026')).toBe(20262)
    expect(termSortKey('F26')).toBe(20263)
    expect(termSortKey('S27')).toBe(20271)
    expect(termSortKey('M26')).toBe(20262)
    expect(termSortKey('N26')).toBe(20262)
    expect(termSortKey('fall 2025')).toBe(20253)
  })
  test('unknown', () => {
    expect(termSortKey(null)).toBe(-1)
    expect(termSortKey('Default Term')).toBe(-1)
    expect(termSortKey('')).toBe(-1)
  })
  test('ordering', () => {
    expect(termSortKey('Spring 2027')).toBeGreaterThan(termSortKey('Fall 2026'))
    expect(termSortKey('Fall 2026')).toBeGreaterThan(termSortKey('Summer 2026'))
    expect(termSortKey('Summer 2026')).toBeGreaterThan(termSortKey('Spring 2026'))
  })
  test('termsOf: distinct, newest first, academic only', () => {
    const courses = buildCourses(
      store([
        canvas('1', { term: 'Fall 2025' }),
        canvas('2', { term: 'Fall 2026', number: '36225', title: '36225' }),
        canvas('3', { term: 'Fall 2026' }),
        canvas('4', { term: 'Spring 2027', number: null, title: 'Career Launch' }), // not academic
        canvas('5', { term: null, number: '15122' }),
      ]),
    )
    expect(termsOf(courses)).toEqual(['Fall 2026', 'Fall 2025'])
  })
})

// ---------------------------------------------------------------- buildCourses

describe('buildCourses: grouping', () => {
  test('Canvas + Gradescope with the same number and term become one course', () => {
    const c = only(buildCourses(store([canvas('100'), gs('900')])))
    expect(c.key).toBe('Fall 2026|21241')
    expect(c.sources.map((s) => s.source)).toEqual(['canvas', 'gradescope'])
    expect(c.academic).toBe(true)
  })

  test('different terms never merge', () => {
    const courses = buildCourses(store([canvas('100'), gs('900', { term: 'Spring 2026' })]))
    expect(courses.map((c) => c.key).sort()).toEqual(['Fall 2026|21241', 'Spring 2026|21241'])
  })

  test('courses without a number never merge and are not academic', () => {
    const courses = buildCourses(
      store([
        canvas('1', { number: null, title: 'Career Launch - Class of 2029+', term: null }),
        canvas('2', { number: null, title: 'Placement 25', term: null }),
      ]),
    )
    expect(courses.map((c) => c.key).sort()).toEqual(['canvas:1', 'canvas:2'])
    expect(courses.every((c) => !c.academic)).toBe(true)
  })

  test('two Canvas shells for one course number merge', () => {
    const lecture = canvas('100', {
      categories: [cat('g1', 'Homework', 50)],
      items: [item('a1', 'HW1', 'g1', 9, 10)],
      canvasScore: 90,
      canvasGrade: 'A',
    })
    const recitation = canvas('101', { title: '21241 Recitation A', categories: [cat('g1', 'Recitation', 0)] })
    const c = only(buildCourses(store([recitation, lecture])))
    expect(c.categories.map((k) => k.key)).toEqual(['c:100:g1', 'c:101:g1'])
    expect(c.canvasScore).toBe(90)
    expect(c.canvasGrade).toBe('A')
    expect(c.sources).toHaveLength(2)
  })

  test('cross-listed numbers join the same course', () => {
    const c = only(
      buildCourses(
        store([
          canvas('100', { number: '10615', title: '10615 Art and ML' }),
          gs('900', { number: '10335', alsoNumbers: ['10615'], title: 'Art and Machine Learning' }),
        ]),
      ),
    )
    expect(c.number).toBe('10615')
    expect(c.alsoNumbers).toEqual(['10335'])
    expect(c.key).toBe('Fall 2026|10615')
  })

  test('result does not depend on storage order', () => {
    const a = buildCourses(store([gs('900'), canvas('100')]))
    const b = buildCourses(store([canvas('100'), gs('900')]))
    expect(a).toEqual(b)
  })
})

describe('buildCourses: Canvas categories and items', () => {
  const course = canvas('100', {
    weighted: true,
    categories: [cat('g1', 'Quizzes', 10, { dropLowest: 1, neverDrop: ['a3'] }), cat('g2', 'Midterm Exams', 55)],
    items: [
      item('a1', 'Quiz 1', 'g1', 8, 10),
      item('a2', 'Quiz 2', 'g1', 6, 10, { url: 'https://canvas.cmu.edu/courses/100/assignments/a2' }),
      item('a3', 'Quiz 3', 'g1', null, 10),
      item('a4', 'Midterm 1', 'g2', 80, 100, { due: '2026-10-01T19:00:00-04:00' }),
      item('a5', 'Syllabus quiz', 'g1', null, null, { omit: true }),
    ],
  })

  test('keys, weights, drops and fields', () => {
    const c = only(buildCourses(store([course])))
    expect(c.weighted).toBe(true)
    expect(c.categories[0]).toEqual({ key: 'c:100:g1', name: 'Quizzes', weight: 10, dropLowest: 1, dropHighest: 0, neverDrop: ['c:a3'] })
    expect(c.categories[1].key).toBe('c:100:g2')
    expect(itemNamed(c, 'Quiz 1')).toEqual({
      key: 'c:a1',
      name: 'Quiz 1',
      categoryKey: 'c:100:g1',
      score: 8,
      max: 10,
      maxEstimated: false,
      status: 'graded',
      due: null,
      omit: false,
      url: null,
      source: 'canvas',
      otherScore: null,
      planned: false,
    })
    expect(itemNamed(c, 'Quiz 2').url).toBe('https://canvas.cmu.edu/courses/100/assignments/a2')
    expect(itemNamed(c, 'Midterm 1').due).toBe('2026-10-01T19:00:00-04:00')
  })

  test('omitted items with unknown max are not guessed', () => {
    const c = only(buildCourses(store([course])))
    expect(itemNamed(c, 'Syllabus quiz').max).toBeNull()
  })

  test('unweighted course: weights become null (points mode)', () => {
    const c = only(buildCourses(store([{ ...course, weighted: false }])))
    expect(c.weighted).toBe(false)
    expect(c.categories.map((k) => k.weight)).toEqual([null, null])
  })

  test('items whose group is missing are placed by name', () => {
    const c = only(
      buildCourses(store([canvas('100', { categories: [cat('g1', 'Homework', 20)], items: [item('a1', 'HW 1', 'gone', 5, 10), item('a2', 'Survey', null, 1, 1)] })])),
    )
    expect(itemNamed(c, 'HW 1').categoryKey).toBe('c:100:g1')
    expect(itemNamed(c, 'Survey').categoryKey).toBe('g:Other')
    expect(c.categories.find((k) => k.key === 'g:Other')?.name).toBe('Other')
  })

  test('duplicate item ids are kept once', () => {
    const c = only(buildCourses(store([canvas('100', { categories: [cat('g1', 'HW', 10)], items: [item('a1', 'HW1', 'g1', 5, 10), item('a1', 'HW1', 'g1', 5, 10)] })])))
    expect(c.items).toHaveLength(1)
  })
})

describe('buildCourses: Gradescope merging', () => {
  test('matched item: Gradescope fills a missing Canvas score', () => {
    const c = only(
      buildCourses(
        store([
          canvas('100', { categories: [cat('g1', 'Homework', 30)], items: [item('a1', 'Homework 1', 'g1', null, 40)] }),
          gs('900', { items: [item('5001', 'HW01', null, 36, 40, { url: 'https://www.gradescope.com/courses/900/assignments/5001' })] }),
        ]),
      ),
    )
    expect(c.items).toHaveLength(1)
    const hw = c.items[0]
    expect(hw.key).toBe('c:a1')
    expect(hw.score).toBe(36)
    expect(hw.status).toBe('graded')
    expect(hw.source).toBe('gradescope')
    expect(hw.otherScore).toBeNull()
  })

  test('matched item: both scored and different -> keep Canvas, remember Gradescope', () => {
    const c = only(
      buildCourses(
        store([
          canvas('100', { categories: [cat('g1', 'Quizzes', 10)], items: [item('a1', 'Quiz #2', 'g1', 8, 10)] }),
          gs('900', { items: [item('5001', 'Quiz 2', null, 9, 10)] }),
        ]),
      ),
    )
    const q = only([c]).items[0]
    expect(q.score).toBe(8)
    expect(q.source).toBe('canvas')
    expect(q.otherScore).toBe(9)
  })

  test('matched item: equal scores leave otherScore null', () => {
    const c = only(
      buildCourses(
        store([
          canvas('100', { categories: [cat('g1', 'Quizzes', 10)], items: [item('a1', 'Quiz 2', 'g1', 8, 10)] }),
          gs('900', { items: [item('5001', 'Quiz 2', null, 8.0004, 10)] }),
        ]),
      ),
    )
    expect(c.items[0].otherScore).toBeNull()
  })

  test('matched item with unknown Gradescope max (ungraded) keeps Canvas max', () => {
    const c = only(
      buildCourses(
        store([
          canvas('100', { categories: [cat('g1', 'Exams', 50)], items: [item('a1', 'Exam 2', 'g1', null, 100)] }),
          gs('900', { items: [item('5001', 'Exam 2', null, null, null, { status: 'ungraded' })] }),
        ]),
      ),
    )
    expect(c.items).toHaveLength(1)
    expect(c.items[0].max).toBe(100)
    expect(c.items[0].status).toBe('ungraded') // more informative than Canvas "unsubmitted"
  })

  test('Canvas missing flag is not overwritten by a Gradescope status', () => {
    const c = only(
      buildCourses(
        store([
          canvas('100', { categories: [cat('g1', 'HW', 50)], items: [item('a1', 'HW 3', 'g1', null, 10, { status: 'missing' })] }),
          gs('900', { items: [item('5001', 'HW 3', null, null, null, { status: 'submitted' })] }),
        ]),
      ),
    )
    expect(c.items[0].status).toBe('missing')
  })

  test('Canvas item with null max learns it from Gradescope', () => {
    const c = only(
      buildCourses(
        store([
          canvas('100', { categories: [cat('g1', 'HW', 50)], items: [item('a1', 'HW 1', 'g1', null, null)] }),
          gs('900', { items: [item('5001', 'HW 1', null, 7, 8)] }),
        ]),
      ),
    )
    expect(c.items[0]).toMatchObject({ score: 7, max: 8, source: 'gradescope' })
  })

  test('same name, different max: treated as one rescaled assignment', () => {
    const c = only(
      buildCourses(
        store([
          canvas('100', { categories: [cat('g1', 'Exams', 50)], items: [item('a1', 'Midterm 1', 'g1', null, 100), item('a2', 'Midterm 2', 'g1', 70, 100)] }),
          gs('900', { items: [item('5001', 'Midterm 1', null, 45, 60), item('5002', 'Midterm 2', null, 48, 60)] }),
        ]),
      ),
    )
    expect(c.items).toHaveLength(2)
    expect(itemNamed(c, 'Midterm 1').score).toBeCloseTo(75)
    expect(itemNamed(c, 'Midterm 1').max).toBe(100)
    expect(itemNamed(c, 'Midterm 2').score).toBe(70)
    expect(itemNamed(c, 'Midterm 2').otherScore).toBeCloseTo(80)
  })

  test('duplicate Canvas names: prefers the one with equal max', () => {
    const c = only(
      buildCourses(
        store([
          canvas('100', {
            categories: [cat('g1', 'Online', 5), cat('g2', 'Written', 5)],
            items: [item('a1', 'HW 1', 'g1', 10, 10), item('a2', 'HW 1', 'g2', null, 40)],
          }),
          gs('900', { items: [item('5001', 'HW01', null, 36, 40)] }),
        ]),
      ),
    )
    expect(c.items.find((i) => i.key === 'c:a1')?.score).toBe(10)
    expect(c.items.find((i) => i.key === 'c:a2')?.score).toBe(36)
  })

  test('one Gradescope course cannot match the same Canvas item twice', () => {
    const c = only(
      buildCourses(
        store([
          canvas('100', { categories: [cat('g1', 'HW', 50)], items: [item('a1', 'HW 1', 'g1', null, 10)] }),
          gs('900', { items: [item('5001', 'HW 1', null, 9, 10), item('5002', 'HW #1', null, 8, 10)] }),
        ]),
      ),
    )
    expect(c.items.map((i) => i.key)).toEqual(['c:a1', 'g:900:5002'])
    expect(c.items[0].score).toBe(9)
  })

  test('unmatched Gradescope items go to the best Canvas category or an inferred one', () => {
    const c = only(
      buildCourses(
        store([
          canvas('100', {
            categories: [cat('g1', 'Homework', 30), cat('g2', 'Midterm 1', 20), cat('g3', 'Exam 2', 20)],
            items: [item('a1', 'HW 1', 'g1', 10, 10)],
          }),
          gs('900', {
            items: [
              item('5001', 'HW 2', null, 9, 10),
              item('5002', 'Midterm 1A', null, 50, 60),
              item('5003', 'Exam 2', null, 40, 50),
              item('5004', 'Lab 1', null, 5, 5),
            ],
          }),
        ]),
      ),
    )
    expect(itemNamed(c, 'HW 2')).toMatchObject({ key: 'g:900:5001', categoryKey: 'c:100:g1', source: 'gradescope' })
    expect(itemNamed(c, 'Midterm 1A').categoryKey).toBe('c:100:g2')
    expect(itemNamed(c, 'Exam 2').categoryKey).toBe('c:100:g3')
    expect(itemNamed(c, 'Lab 1').categoryKey).toBe('g:Labs')
    expect(c.categories.find((k) => k.key === 'g:Labs')).toEqual({ key: 'g:Labs', name: 'Labs', weight: null, dropLowest: 0, dropHighest: 0, neverDrop: [] })
    expect(c.weighted).toBe(true)
  })

  test('Gradescope-only course: inferred categories, points mode', () => {
    const c = only(
      buildCourses(
        store([
          gs('900', {
            number: '36225',
            title: 'Probability',
            items: [
              item('1', 'HW01', null, 36, 40),
              item('2', 'HW02', null, 38, 40),
              item('3', 'Midterm 1', null, 80, 100),
              item('4', 'Final Exam', null, null, null, { status: 'unsubmitted' }),
              item('5', 'Survey', null, 1, 1),
            ],
          }),
        ]),
      ),
    )
    expect(c.weighted).toBe(false)
    expect(c.categories.map((k) => k.key)).toEqual(['g:Homework', 'g:Exams', 'g:Other'])
    expect(c.categories.every((k) => k.weight === null)).toBe(true)
    expect(itemNamed(c, 'Final Exam').categoryKey).toBe('g:Exams')
    expect(c.canvasScore).toBeNull()
    expect(c.schemeSource).toBe('default')
  })

  test('two Gradescope courses for one class do not duplicate items', () => {
    const c = only(
      buildCourses(
        store([gs('900', { items: [item('1', 'HW 1', null, 9, 10)] }), gs('901', { items: [item('7', 'HW 1', null, null, null, { status: 'submitted' }), item('8', 'HW 2', null, 5, 10)] })]),
      ),
    )
    expect(c.items.map((i) => i.key)).toEqual(['g:900:1', 'g:901:8'])
  })
})

describe('buildCourses: unknown max points', () => {
  test('one shared max value', () => {
    const c = only(
      buildCourses(
        store([gs('900', { items: [item('1', 'HW 1', null, 36, 40), item('2', 'HW 2', null, 30, 40), item('3', 'HW 3', null, null, null, { status: 'ungraded' })] })]),
      ),
    )
    expect(itemNamed(c, 'HW 3')).toMatchObject({ max: 40, maxEstimated: true })
    expect(itemNamed(c, 'HW 1').maxEstimated).toBe(false)
  })

  test('median of different max values', () => {
    const c = only(
      buildCourses(
        store([
          gs('900', {
            items: [item('1', 'HW 1', null, 9, 10), item('2', 'HW 2', null, 18, 20), item('3', 'HW 3', null, 25, 30), item('4', 'HW 4', null, null, null)],
          }),
        ]),
      ),
    )
    expect(itemNamed(c, 'HW 4')).toMatchObject({ max: 20, maxEstimated: true })
  })

  test('only scored items in the same category count; nothing to copy -> stays null', () => {
    const c = only(
      buildCourses(
        store([gs('900', { items: [item('1', 'HW 1', null, null, 40), item('2', 'Exam 1', null, 50, 60), item('3', 'HW 2', null, null, null)] })]),
      ),
    )
    expect(itemNamed(c, 'HW 2')).toMatchObject({ max: null, maxEstimated: false })
  })

  test('median helper', () => {
    expect(median([])).toBeNull()
    expect(median([5])).toBe(5)
    expect(median([10, 30, 20])).toBe(20)
    expect(median([10, 20, 30, 40])).toBe(25)
  })
})

describe('buildCourses: manual courses', () => {
  test('manual course: no items, manual percent, catalog title and units', () => {
    const c = only(buildCourses(store([], { manual: [{ key: 'manual:abc', number: '15-122', title: '', term: 'Fall 2026', percent: 88.5 }] })))
    expect(c).toMatchObject({
      key: 'manual:abc',
      number: '15122',
      title: 'Principles of Imperative Computation',
      term: 'Fall 2026',
      academic: true,
      items: [],
      categories: [],
      manualPercent: 88.5,
      units: 12,
      unitsSource: 'catalog',
      weighted: false,
    })
    expect(c.sources).toEqual([{ source: 'manual', sourceId: 'manual:abc', url: '', syncedAt: '' }])
  })

  test('manual course keeps its own title and tolerates junk', () => {
    const courses = buildCourses(
      store([], {
        manual: [
          { key: 'manual:1', number: null, title: 'Autolab class', term: null, percent: null },
          null as unknown as ManualCourse,
          { key: '', number: '15122', title: 'no key', term: null, percent: 1 },
        ],
      }),
    )
    const c = only(courses)
    expect(c).toMatchObject({ title: 'Autolab class', number: null, units: 9, unitsSource: 'default', manualPercent: null })
  })

  test('planned items in a manual course get an inferred category', () => {
    const c = only(
      buildCourses(
        store([], {
          manual: [{ key: 'manual:1', number: '15122', title: '', term: 'Fall 2026', percent: null }],
          prefs: { 'manual:1': { extra: [{ key: 'm:1', name: 'Final Exam', categoryKey: 'nope', max: 100 }] } },
        }),
      ),
    )
    expect(c.items[0]).toMatchObject({ key: 'm:1', categoryKey: 'g:Exams', planned: true, status: 'unsubmitted', score: null, max: 100, source: 'manual' })
    expect(c.categories.map((k) => k.key)).toEqual(['g:Exams'])
  })
})

describe('buildCourses: prefs', () => {
  const base = canvas('100', {
    weighted: true,
    categories: [cat('g1', 'Homework', 40), cat('g2', 'Exams', 60)],
    items: [item('a1', 'HW 1', 'g1', 9, 10), item('a2', 'Exam 1', 'g2', 80, 100)],
    scheme: [
      { letter: 'B', min: 80 },
      { letter: 'A', min: 93 },
      { letter: 'R', min: 0 },
    ],
  })
  const key = 'Fall 2026|21241'

  test('no prefs: Canvas weights, Canvas scheme sorted, catalog units', () => {
    const c = only(buildCourses(store([base])))
    expect(c.categories.map((k) => k.weight)).toEqual([40, 60])
    expect(c.scheme.map((s) => s.letter)).toEqual(['A', 'B', 'R'])
    expect(c.schemeSource).toBe('canvas')
    expect(c.units).toBe(11)
    expect(c.unitsSource).toBe('catalog')
    expect(c.prefs).toEqual({})
  })

  test('weights override per category', () => {
    const c = only(buildCourses(store([base], { prefs: { [key]: { weights: { 'c:100:g1': 25 } } } })))
    expect(c.categories.map((k) => k.weight)).toEqual([25, 60])
  })

  test('weighted override both ways', () => {
    const off = only(buildCourses(store([base], { prefs: { [key]: { weighted: false } } })))
    expect(off.weighted).toBe(false)
    expect(off.categories.map((k) => k.weight)).toEqual([null, null])
    const on = only(buildCourses(store([{ ...base, weighted: false }], { prefs: { [key]: { weighted: true, weights: { 'c:100:g2': 50 } } } })))
    expect(on.weighted).toBe(true)
    expect(on.categories.map((k) => k.weight)).toEqual([40, 50])
  })

  test('moved items, ignoring moves to missing categories', () => {
    const c = only(buildCourses(store([base], { prefs: { [key]: { moved: { 'c:a1': 'c:100:g2', 'c:a2': 'gone' } } } })))
    expect(itemNamed(c, 'HW 1').categoryKey).toBe('c:100:g2')
    expect(itemNamed(c, 'Exam 1').categoryKey).toBe('c:100:g2')
  })

  test('planned items', () => {
    const c = only(buildCourses(store([base], { prefs: { [key]: { extra: [{ key: 'm:x', name: 'Final', categoryKey: 'c:100:g2', max: 150 }] } } })))
    expect(itemNamed(c, 'Final')).toEqual({
      key: 'm:x',
      name: 'Final',
      categoryKey: 'c:100:g2',
      score: null,
      max: 150,
      maxEstimated: false,
      status: 'unsubmitted',
      due: null,
      omit: false,
      url: null,
      source: 'manual',
      otherScore: null,
      planned: true,
    })
  })

  test('saved weight applies to a category created for a planned item', () => {
    const c = only(
      buildCourses(store([base], { prefs: { [key]: { extra: [{ key: 'm:x', name: 'Lab 1', categoryKey: 'g:Labs', max: 10 }], weights: { 'g:Labs': 5 } } } })),
    )
    expect(c.categories.find((k) => k.key === 'g:Labs')?.weight).toBe(5)
  })

  test('units: custom, catalog, default', () => {
    expect(only(buildCourses(store([base], { prefs: { [key]: { units: 12 } } }))).units).toBe(12)
    expect(only(buildCourses(store([base], { prefs: { [key]: { units: 12 } } }))).unitsSource).toBe('custom')
    const unknown = only(buildCourses(store([canvas('1', { number: '12345', title: '12345 Mystery' })])))
    expect(unknown).toMatchObject({ units: 9, unitsSource: 'default' })
    const variable = only(buildCourses(store([canvas('1', { number: '15591', title: '15591' })])))
    expect(variable).toMatchObject({ units: 9, unitsSource: 'default' })
  })

  test('units fall back to a cross-listed number in the catalog', () => {
    const c = only(buildCourses(store([canvas('1', { number: '12345', alsoNumbers: ['15213'] })])))
    expect(c).toMatchObject({ units: 12, unitsSource: 'catalog' })
  })

  test('custom cutoffs win and get sorted', () => {
    const c = only(
      buildCourses(
        store([base], {
          prefs: {
            [key]: {
              cutoffs: [
                { letter: 'B', min: 78 },
                { letter: 'A', min: 88 },
                { letter: 'R', min: 0 },
              ],
            },
          },
        }),
      ),
    )
    expect(c.scheme).toEqual([
      { letter: 'A', min: 88 },
      { letter: 'B', min: 78 },
      { letter: 'R', min: 0 },
    ])
    expect(c.schemeSource).toBe('custom')
  })

  test('default scheme follows the level and is a copy', () => {
    const under = only(buildCourses(store([canvas('1')])))
    expect(under.scheme).toEqual(DEFAULT_SCHEME_UNDERGRAD)
    expect(under.scheme).not.toBe(DEFAULT_SCHEME_UNDERGRAD)
    const grad = only(buildCourses(store([canvas('1')], { settings: { level: 'grad' } })))
    expect(grad.scheme).toEqual(DEFAULT_SCHEME_GRAD)
    expect(grad.schemeSource).toBe('default')
  })

  test('prefs are passed through and never mutated', () => {
    const prefs: CoursePrefs = { hidden: true, whatIf: { 'c:a1': 10 }, ignored: ['c:a2'], letter: 'A', passFail: false, weights: { 'c:100:g1': 10 } }
    const snapshot = JSON.parse(JSON.stringify(prefs))
    const s = store([base], { prefs: { [key]: prefs } })
    const before = JSON.stringify(s)
    const c = only(buildCourses(s))
    expect(c.prefs).toEqual(snapshot)
    expect(JSON.stringify(s)).toBe(before) // the store itself is untouched
  })
})

describe('buildCourses: titles and sorting', () => {
  test('catalog title wins', () => {
    expect(only(buildCourses(store([canvas('1', { title: '1. 21241' })]))).title).toBe('Matrices and Linear Transformations')
  })

  test('source title without the number prefix when not in the catalog', () => {
    expect(only(buildCourses(store([canvas('1', { number: '12345', title: '12-345: Mystery Course' })]))).title).toBe('Mystery Course')
    expect(only(buildCourses(store([gs('9', { number: '12345', title: 'GS Mystery' })]))).title).toBe('GS Mystery')
    expect(only(buildCourses(store([canvas('1', { number: '12345', title: '12345' })]))).title).toBe('12-345')
  })

  test('Canvas title preferred over Gradescope title', () => {
    const c = only(buildCourses(store([gs('9', { number: '12345', title: 'From GS' }), canvas('1', { number: '12345', title: '12345 From Canvas' })])))
    expect(c.title).toBe('From Canvas')
  })

  test('stripNumberPrefix', () => {
    expect(stripNumberPrefix('21-241 Matrices')).toBe('Matrices')
    expect(stripNumberPrefix('85170-A Brain')).toBe('Brain')
    expect(stripNumberPrefix('99101-DC F25 Core')).toBe('Core')
    expect(stripNumberPrefix('15-213/18-213: Systems')).toBe('Systems')
    expect(stripNumberPrefix('10-335/615 Art')).toBe('Art')
    expect(stripNumberPrefix('1. 21241')).toBe('')
    expect(stripNumberPrefix('Matrices')).toBe('Matrices')
  })

  test('non-academic shells keep their name', () => {
    const c = only(buildCourses(store([canvas('1', { number: null, term: null, title: 'Career Launch - Class of 2029+' })])))
    expect(c.title).toBe('Career Launch - Class of 2029+')
    expect(c.key).toBe('canvas:1')
  })

  test('academic first, then by number', () => {
    const courses = buildCourses(
      store([
        canvas('1', { number: null, title: 'Career Launch', term: null }),
        canvas('2', { number: '36225', title: '36225' }),
        gs('3', { number: '15122', title: 'PIC' }),
        canvas('4', { number: '21241' }),
      ]),
    )
    expect(courses.map((c) => c.number)).toEqual(['15122', '21241', '36225', null])
  })
})

describe('buildCourses: messy stored data', () => {
  test('empty store', () => {
    expect(buildCourses(store([]))).toEqual([])
  })

  test('garbage entries and missing fields are tolerated', () => {
    const s = store([])
    s.synced = {
      'canvas:x': null as unknown as SyncedCourse,
      'weird:1': { source: 'blackboard' } as unknown as SyncedCourse,
      'canvas:2': { source: 'canvas', sourceId: '2', number: '21-241', title: '21241', term: 'Fall 2026' } as unknown as SyncedCourse,
      'gradescope:3': {
        source: 'gradescope',
        sourceId: '3',
        number: '21241',
        term: 'Fall 2026',
        items: [{ id: '1', name: 'HW 1', score: 'NaN', max: Infinity, status: 'bogus' }, null, { name: 'no id' }],
      } as unknown as SyncedCourse,
    }
    const c = only(buildCourses(s))
    expect(c.number).toBe('21241')
    expect(c.items).toHaveLength(1)
    expect(c.items[0]).toMatchObject({ score: null, max: null, status: 'unsubmitted', name: 'HW 1' })
    expect(c.title).toBe('Matrices and Linear Transformations')
  })

  test('malformed prefs are ignored', () => {
    const s = store([canvas('1', { categories: [cat('g1', 'HW', 10)], items: [item('a1', 'HW 1', 'g1', 5, 10)] })])
    s.prefs = { 'Fall 2026|21241': { units: Number.NaN, weights: { 'c:1:g1': 'x' as unknown as number }, moved: { 'c:a1': 5 as unknown as string }, extra: [null as unknown as never], cutoffs: [{ letter: '', min: 3 }] } }
    const c = only(buildCourses(s))
    expect(c).toMatchObject({ units: 11, unitsSource: 'catalog', schemeSource: 'default' })
    expect(c.categories[0].weight).toBe(10)
    expect(c.items).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- Autolab (beta)

function autolab(sourceId: string, extra: Partial<SyncedCourse> = {}): SyncedCourse {
  return { ...gs(sourceId, extra), source: 'autolab', url: `https://autolab.andrew.cmu.edu/courses/${sourceId}`, ...extra }
}

describe('Autolab courses', () => {
  test('an Autolab-only course keeps Autolab categories (unweighted)', () => {
    const c = only(
      buildCourses(
        store([
          autolab('15213-f26', {
            number: '15213',
            term: 'Fall 2026',
            categories: [cat('Lab', 'Lab'), cat('Written', 'Written')],
            items: [item('datalab', 'Data Lab', 'Lab', 58.5, 63), item('written2', 'Written 2', 'Written', 9, 10)],
          }),
        ]),
      ),
    )
    expect(c.categories.map((k) => k.name)).toEqual(['Lab', 'Written'])
    expect(c.items.map((i) => i.source)).toEqual(['autolab', 'autolab'])
    expect(c.items[0].key).toBe('a:15213-f26:datalab')
    expect(c.weighted).toBe(false)
  })

  test('Autolab items with the same name as Canvas items fill gaps and flag disagreements', () => {
    const c = only(
      buildCourses(
        store([
          canvas('500', {
            number: '15213',
            term: 'Fall 2026',
            weighted: true,
            categories: [cat('g1', 'Labs', 50), cat('g2', 'Exams', 50)],
            items: [item('1', 'Data Lab', 'g1', 50, 63), item('2', 'Bomb Lab', 'g1', null, 70)],
          }),
          autolab('15213-f26', {
            number: '15213',
            term: 'Fall 2026',
            categories: [cat('Lab', 'Lab')],
            items: [item('datalab', 'Data Lab', 'Lab', 58.5, 63), item('bomblab', 'Bomb Lab', 'Lab', 66, 70), item('cachelab', 'Cache Lab', 'Lab', 55, 60)],
          }),
        ]),
      ),
    )
    const byName = Object.fromEntries(c.items.map((i) => [i.name, i]))
    expect(byName['Data Lab']).toMatchObject({ score: 50, otherScore: 58.5, otherSource: 'autolab', source: 'canvas' })
    expect(byName['Bomb Lab']).toMatchObject({ score: 66, source: 'autolab' })
    // Not on Canvas at all: lands in the matching Canvas category ("Labs"), not a new one.
    expect(byName['Cache Lab'].categoryKey).toBe(byName['Data Lab'].categoryKey)
    expect(c.items).toHaveLength(3)
  })
})

// ---------------------------------------------------------------- alternate exam versions

describe('alternate exam versions', () => {
  const exams = (items: SyncedItem[], prefs?: CoursePrefs) =>
    only(
      buildCourses(
        store([canvas('7', { weighted: false, categories: [cat('m', 'Midterm 1'), cat('h', 'Homework')], items })], {
          prefs: prefs ? { 'Fall 2026|21241': prefs } : undefined,
        }),
      ),
    )

  test('skips the unscored alternate when the main exam has a score', () => {
    const c = exams([item('1', 'Midterm 1', 'm', 22.5, 25), item('2', 'Midterm 1A', 'm', null, 25)])
    const alt = c.items.find((i) => i.name === 'Midterm 1A')!
    expect(alt.omit).toBe(true)
    expect(alt.skipReason).toBe('Alternate version of Midterm 1')
    expect(c.items.find((i) => i.name === 'Midterm 1')!.omit).toBe(false)
  })

  test('skips the main exam when the student took the alternate', () => {
    const c = exams([item('1', 'Exam 2', 'm', null, 25), item('2', 'Exam 2 (Alt)', 'm', 20, 25)])
    expect(c.items.find((i) => i.name === 'Exam 2')!.skipReason).toBe('You took Exam 2 (Alt) instead')
  })

  test('neither graded yet: the alternate is skipped, the main one stays as remaining work', () => {
    const c = exams([item('1', 'Final Exam', 'm', null, 100), item('2', 'Final Exam Makeup', 'm', null, 100)])
    expect(c.items.find((i) => i.name === 'Final Exam Makeup')!.omit).toBe(true)
    expect(c.items.find((i) => i.name === 'Final Exam')!.omit).toBe(false)
  })

  test('never touches non-exam items or exams without a base version', () => {
    const c = exams([item('1', 'HW 1', 'h', 10, 10), item('2', 'HW 1B', 'h', null, 10), item('3', 'Midterm 2A', 'm', null, 25)])
    expect(c.items.every((i) => !i.omit)).toBe(true)
  })

  test('the student can count a skipped alternate anyway', () => {
    const c = exams([item('1', 'Midterm 1', 'm', 22.5, 25), item('2', 'Midterm 1A', 'm', null, 25)], { included: ['c:2'] })
    expect(c.items.find((i) => i.name === 'Midterm 1A')!.omit).toBe(false)
  })
})
