// Tests for the dashboard view logic in src/ui/view.ts (and the GradeBar color). All data is synthetic.
import { describe, expect, test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Category, Course, GradeResult, Item, NeededResult } from '../src/types'
import { GradeBar } from '../src/ui/GradeBar'
import {
  collapseNeeded,
  collapseScheme,
  courseInsight,
  neededText,
  pickTerm,
  splitCourses,
  termsWithGrades,
  toGoText,
} from '../src/ui/view'
import { DEFAULT_SCHEME_UNDERGRAD } from '../src/lib/cmu'

// ---------------------------------------------------------------- builders

function cat(key: string, name: string, weight: number | null): Category {
  return { key, name, weight, dropLowest: 0, dropHighest: 0, neverDrop: [] }
}

function item(key: string, categoryKey: string, score: number | null, max: number | null, extra: Partial<Item> = {}): Item {
  return {
    key,
    name: key,
    categoryKey,
    score,
    max,
    maxEstimated: false,
    status: score === null ? 'unsubmitted' : 'graded',
    due: null,
    omit: false,
    url: null,
    source: 'canvas',
    otherScore: null,
    planned: false,
    ...extra,
  }
}

function course(overrides: Partial<Course> = {}): Course {
  return {
    key: 'Fall 2026|21241',
    number: '21241',
    alsoNumbers: [],
    title: 'Test course',
    term: 'Fall 2026',
    academic: true,
    sources: [{ source: 'canvas', sourceId: '1', url: 'https://canvas.example/courses/1', syncedAt: '2026-11-12T10:00:00Z' }],
    weighted: true,
    categories: [],
    items: [],
    canvasScore: null,
    canvasGrade: null,
    scheme: DEFAULT_SCHEME_UNDERGRAD,
    schemeSource: 'default',
    units: 9,
    unitsSource: 'catalog',
    manualPercent: null,
    prefs: {},
    ...overrides,
  }
}

const manualSource = [{ source: 'manual' as const, sourceId: 'm1', url: '', syncedAt: '' }]

function grade(overrides: Partial<GradeResult> = {}): GradeResult {
  return { percent: 84, letter: 'B', categories: [], graded: 2, remaining: 2, ...overrides }
}

function need(letter: string, min: number, status: NeededResult['status'], needed: number | null = null): NeededResult {
  return { letter, min, status, needed }
}

// ---------------------------------------------------------------- letters

describe('collapseScheme / collapseNeeded with a Unicode minus', () => {
  test("'A−' (U+2212) collapses into A for undergrads", () => {
    const scheme = [
      { letter: 'A', min: 93 },
      { letter: 'A−', min: 90 },
      { letter: 'B', min: 80 },
      { letter: 'F', min: 0 },
    ]
    expect(collapseScheme(scheme, 'undergrad')).toEqual([
      { letter: 'A', min: 90 },
      { letter: 'B', min: 80 },
      { letter: 'R', min: 0 },
    ])
    const needed = [need('A', 93, 'impossible'), need('A−', 90, 'possible', 95), need('B', 80, 'guaranteed', 0)]
    expect(collapseNeeded(needed, 'undergrad')).toEqual([
      { letter: 'A', min: 90, status: 'possible', needed: 95 },
      { letter: 'B', min: 80, status: 'guaranteed', needed: 0 },
    ])
  })
})

// ---------------------------------------------------------------- terms

describe('termsWithGrades / pickTerm', () => {
  const fall = course({ key: 'fall', term: 'Fall 2026' })
  const spring = course({ key: 'spring', term: 'Spring 2027' })
  const shell = course({ key: 'shell', term: 'Summer 2026', academic: false })
  const grades = new Map([
    ['fall', grade({ graded: 5 })],
    ['spring', grade({ graded: 0, percent: null })],
    ['shell', grade({ graded: 3 })],
  ])

  test('termsWithGrades: academic courses with at least one graded item', () => {
    expect(termsWithGrades([fall, spring, shell], grades)).toEqual(new Set(['Fall 2026']))
    expect(termsWithGrades([fall], new Map())).toEqual(new Set())
  })

  test('with no choice, picks the newest term that has grades, not an empty next semester', () => {
    const terms = ['Spring 2027', 'Fall 2026']
    expect(pickTerm(terms, null, new Set(['Fall 2026']))).toBe('Fall 2026')
    // Nothing graded anywhere: the newest term.
    expect(pickTerm(terms, null, new Set())).toBe('Spring 2027')
    // Without gradedTerms it behaves as before.
    expect(pickTerm(terms, null)).toBe('Spring 2027')
  })

  test('an explicit choice that still exists always wins; a stale one falls back', () => {
    const terms = ['Spring 2027', 'Fall 2026']
    expect(pickTerm(terms, 'Spring 2027', new Set(['Fall 2026']))).toBe('Spring 2027')
    expect(pickTerm(terms, 'Fall 2020', new Set(['Fall 2026']))).toBe('Fall 2026')
    expect(pickTerm([], null, new Set())).toBeNull()
  })
})

describe('splitCourses: hand-added courses with no term', () => {
  const manual = course({ key: 'manual:x', number: '15213', term: null, sources: manualSource, manualPercent: 95 })
  const fall = course({ key: 'f', term: 'Fall 2026' })
  const spring = course({ key: 's', term: 'Spring 2026' })

  test('belong to the newest term only, so they are not counted in a past term', () => {
    const list = [manual, fall, spring]
    expect(splitCourses(list, 'Fall 2026').main.map((c) => c.key)).toEqual(['manual:x', 'f'])
    expect(splitCourses(list, 'Spring 2026').main.map((c) => c.key)).toEqual(['s'])
    expect(splitCourses(list, 'Spring 2026').other.map((c) => c.key)).toEqual([])
  })

  test('with no terms at all (welcome page), they show', () => {
    expect(splitCourses([manual], null).main.map((c) => c.key)).toEqual(['manual:x'])
  })
})

// ---------------------------------------------------------------- insight and needed text

describe('courseInsight / neededText', () => {
  test("all 'locked' means every grade is in, even when the letters were missed", () => {
    expect(courseInsight([need('A', 90, 'locked'), need('D', 60, 'locked')], grade({ percent: 55, remaining: 0 }))).toBe(
      'Every grade is in',
    )
  })

  test("'unknown' explains that point values are missing instead of 'on the rest'", () => {
    const needed = [need('A', 90, 'unknown'), need('B', 80, 'unknown')]
    expect(courseInsight(needed, grade())).toBe("Point values for the rest aren't posted yet")
    expect(neededText(need('A', 90, 'unknown'), 85)).toBe("Point values aren't posted yet")
  })

  test('no rows -> no insight', () => {
    expect(courseInsight([], grade({ percent: null }))).toBeNull()
  })
})

// ---------------------------------------------------------------- "to go"

describe('toGoText', () => {
  test('counts remaining items worth points or with unknown points, not zero-point placeholders', () => {
    const c = course({
      weighted: false,
      categories: [cat('hw', 'Homework', null)],
      items: [
        item('a', 'hw', 9, 10),
        item('b', 'hw', null, 10),
        item('c', 'hw', null, null),
        item('d', 'hw', null, 0), // attendance placeholder
      ],
    })
    expect(toGoText(c, grade({ graded: 1, remaining: 2 }))).toBe('1 graded · 2 to go')
  })

  test('names a single empty weighted category (e.g. a final not posted yet)', () => {
    const c = course({
      categories: [cat('hw', 'Homework', 70), cat('final', 'Final Exam', 30)],
      items: [item('a', 'hw', 9, 10)],
    })
    expect(toGoText(c, grade({ graded: 1, remaining: 0 }))).toBe('1 graded · Final Exam to go')
  })

  test('adds empty weighted categories to the item count; ignores Extra Credit and categories already counted', () => {
    const c = course({
      categories: [
        cat('hw', 'Homework', 40),
        cat('mid', 'Midterm', 30), // only an unknown-max exam: already counted as an item
        cat('final', 'Final Exam', 30), // empty
        cat('ec', 'Extra Credit', 5), // empty bonus: not "to go"
      ],
      items: [item('a', 'hw', 9, 10), item('b', 'hw', null, 10), item('m', 'mid', null, null)],
    })
    expect(toGoText(c, grade({ graded: 1, remaining: 2 }))).toBe('1 graded · 3 to go')
  })

  test('nothing left', () => {
    const c = course({ categories: [cat('hw', 'Homework', 100)], items: [item('a', 'hw', 9, 10)] })
    expect(toGoText(c, grade({ graded: 1, remaining: 0 }))).toBe('1 graded · 0 to go')
  })
})

// ---------------------------------------------------------------- GradeBar color

describe('GradeBar', () => {
  const render = (percent: number | null) =>
    renderToStaticMarkup(createElement(GradeBar, { percent, scheme: DEFAULT_SCHEME_UNDERGRAD, level: 'undergrad' }))

  test('colors the bar with the same 2-decimal rounding as the letter chip', () => {
    expect(render(89.995)).toContain('tone-a') // rounds to 90.00 -> A, like letterFor
    expect(render(89.994)).toContain('tone-b')
    expect(render(null)).not.toContain('gbar-fill')
  })
})
