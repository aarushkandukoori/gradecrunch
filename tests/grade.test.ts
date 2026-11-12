// Tests for the course grade math. Every course here is synthetic. The "Canvas" expectations were worked
// out by hand from the rules in canvas-lms (CourseGradeCalculator.ts, AssignmentGroupGradeCalculator.ts).
import { describe, expect, it } from 'vitest'
import type { Category, Course, CoursePrefs, Item } from '../src/types'
import {
  applyDropRules,
  gradeCourse,
  keepBestBisection,
  keepBestBruteForce,
  letterFor,
  neededForLetters,
  plannedCategories,
  roundPercent,
  type Entry,
} from '../src/lib/grade'
import { DEFAULT_SCHEME_UNDERGRAD } from '../src/lib/cmu'

// ---------------------------------------------------------------- builders

function cat(key: string, weight: number | null, extra: Partial<Category> = {}): Category {
  return { key, name: key, weight, dropLowest: 0, dropHighest: 0, neverDrop: [], ...extra }
}

let nextId = 1
function item(categoryKey: string, score: number | null, max: number | null, extra: Partial<Item> = {}): Item {
  const key = extra.key ?? `c:${nextId++}`
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

function course(categories: Category[], items: Item[], extra: Partial<Course> = {}, prefs: CoursePrefs = {}): Course {
  return {
    key: 'Fall 2026|21241',
    number: '21241',
    alsoNumbers: [],
    title: 'Test course',
    term: 'Fall 2026',
    academic: true,
    sources: [],
    weighted: true,
    categories,
    items,
    canvasScore: null,
    canvasGrade: null,
    scheme: DEFAULT_SCHEME_UNDERGRAD,
    schemeSource: 'default',
    units: 9,
    unitsSource: 'catalog',
    manualPercent: null,
    prefs,
    ...extra,
  }
}

const e = (key: string, score: number, max: number): Entry => ({ key, score, max })

// ---------------------------------------------------------------- Canvas equivalence

describe('gradeCourse: Canvas current score', () => {
  it('weighted course: weights that add to 100', () => {
    const c = course(
      [cat('hw', 40), cat('exam', 60)],
      [item('hw', 9, 10), item('hw', 8, 10), item('exam', 70, 100)],
    )
    // hw 17/20 = 85% * 40 = 34; exam 70% * 60 = 42 -> 76
    const g = gradeCourse(c)
    expect(g.percent).toBeCloseTo(76, 10)
    expect(g.letter).toBe('C')
    expect(g.graded).toBe(3)
    expect(g.remaining).toBe(0)
  })

  it('renormalizes when graded groups cover less than 100% (empty groups skipped)', () => {
    // Real shape: "Exam 3" w=15 and "Final Exam" w=20 have no assignments yet.
    const c = course(
      [cat('hw', 25), cat('exam1', 20), cat('exam2', 20), cat('exam3', 15), cat('final', 20)],
      [item('hw', 45, 50), item('exam1', 80, 100), item('exam2', 90, 100)],
    )
    // (0.9*25 + 0.8*20 + 0.9*20) / 65 * 100 = 56.5 / 65 * 100
    const g = gradeCourse(c)
    expect(g.percent).toBeCloseTo((56.5 / 65) * 100, 10)
    const exam3 = g.categories.find(x => x.key === 'exam3')!
    expect(exam3.percent).toBeNull()
    expect(exam3.counted).toBe(false)
  })

  it('does not scale down when weights add to more than 100', () => {
    const c = course([cat('a', 60), cat('b', 60)], [item('a', 10, 10), item('b', 5, 10)])
    // 1*60 + 0.5*60 = 90, fullWeight 120 >= 100 -> no scaling
    expect(gradeCourse(c).percent).toBeCloseTo(90, 10)
  })

  it('null weight counts as 0 and all-zero weights give no percent', () => {
    const c = course([cat('a', null), cat('b', 0)], [item('a', 10, 10), item('b', 5, 10)])
    expect(gradeCourse(c).percent).toBeNull()
    expect(gradeCourse(c).letter).toBeNull()
    const c2 = course([cat('a', null), cat('b', 50)], [item('a', 0, 10), item('b', 5, 10)])
    // group a counts in nothing (weight 0); b alone is 50% of 50 -> scaled to 50%
    expect(gradeCourse(c2).percent).toBeCloseTo(50, 10)
  })

  it('points mode ignores group weights (unweighted course whose groups still have weights)', () => {
    const c = course(
      [cat('hw', 0), cat('exam', 25), cat('other', 0)],
      [item('hw', 18, 20), item('hw', 10, 20), item('exam', 70, 100)],
      { weighted: false },
    )
    // (18 + 10 + 70) / (20 + 20 + 100) = 98 / 140 = 70%
    expect(gradeCourse(c).percent).toBeCloseTo(70, 10)
  })

  it('points mode with nothing graded is null', () => {
    const c = course([cat('hw', null)], [item('hw', null, 10)], { weighted: false })
    const g = gradeCourse(c)
    expect(g.percent).toBeNull()
    expect(g.remaining).toBe(1)
    expect(g.graded).toBe(0)
  })

  it('extra credit item (max 0 with a score) adds to earned, not possible', () => {
    // Real shape: "Midterm Curve 3%" with points_possible 0 and a score.
    const c = course(
      [cat('exams', 50), cat('hw', 50)],
      [item('exams', 80, 100), item('exams', 3, 0), item('hw', 9, 10)],
    )
    // exams (80+3)/100 = 83% * 50 = 41.5; hw 90% * 50 = 45 -> 86.5
    expect(gradeCourse(c).percent).toBeCloseTo(86.5, 10)
  })

  it('a weighted group with only extra credit is skipped (no points possible)', () => {
    const c = course([cat('bonus', 10), cat('hw', 90)], [item('bonus', 5, 0), item('hw', 8, 10)])
    // bonus has possible 0 -> not counted; hw alone 80% scaled from 90 -> 80
    expect(gradeCourse(c).percent).toBeCloseTo(80, 10)
  })

  it('points mode: extra credit counts even in a group with nothing possible', () => {
    const c = course([cat('bonus', null), cat('hw', null)], [item('bonus', 2, 0), item('hw', 8, 10)], {
      weighted: false,
    })
    expect(gradeCourse(c).percent).toBeCloseTo(100, 10)
  })

  it('a score with an unknown max counts as extra credit (Canvas treats missing points possible as 0)', () => {
    const c = course([cat('hw', null)], [item('hw', 5, 10), item('hw', 2, null)], { weighted: false })
    expect(gradeCourse(c).percent).toBeCloseTo(70, 10)
  })

  it('excused, omitted and ignored items do not count', () => {
    const excused = item('hw', null, 10, { status: 'excused' })
    const excusedWithScore = item('hw', 0, 10, { status: 'excused' })
    const omitted = item('hw', 0, 50, { omit: true })
    const ignored = item('hw', 0, 10, { key: 'c:ignored' })
    const c = course([cat('hw', 100)], [item('hw', 9, 10), excused, excusedWithScore, omitted, ignored], {}, {
      ignored: ['c:ignored'],
    })
    const g = gradeCourse(c)
    expect(g.percent).toBeCloseTo(90, 10)
    expect(g.graded).toBe(1)
    expect(g.remaining).toBe(0)
  })

  it('omitted not_graded item in a 0-weight group does not matter (real "Preliminary Matters" shape)', () => {
    const c = course(
      [cat('prelim', 0), cat('online', 5), cat('written', 5), cat('quiz', 10, { dropLowest: 1 }), cat('mid', 55), cat('final', 25)],
      [
        item('prelim', null, 0, { omit: true }),
        item('online', 10, 10),
        item('written', 18, 20),
        item('quiz', 2, 10),
        item('quiz', 8, 10),
        item('quiz', 10, 10),
        item('mid', 85, 100),
      ],
    )
    // online 100%*5 = 5; written 90%*5 = 4.5; quiz drop the 2 -> 18/20 = 90% * 10 = 9; mid 85%*55 = 46.75
    // total 65.25 over weight 75 -> 87%
    expect(gradeCourse(c).percent).toBeCloseTo(87, 10)
    expect(gradeCourse(c).letter).toBe('B')
  })

  it('unscored items (missing, submitted, ungraded) are ignored for the current score', () => {
    const c = course(
      [cat('hw', 100)],
      [
        item('hw', 10, 10),
        item('hw', null, 10, { status: 'missing' }),
        item('hw', null, 10, { status: 'submitted' }),
        item('hw', null, null, { status: 'ungraded' }),
      ],
    )
    const g = gradeCourse(c)
    expect(g.percent).toBeCloseTo(100, 10)
    expect(g.remaining).toBe(3)
  })

  it('items in a category that no longer exists still count, in an "Other" category', () => {
    const c = course([cat('hw', null)], [item('hw', 5, 10), item('gone', 10, 10)], { weighted: false })
    const g = gradeCourse(c)
    expect(g.percent).toBeCloseTo(75, 10)
    expect(g.categories.map(x => x.name)).toEqual(['hw', 'Other'])
  })

  it('one big weighted group behaves like total points (real "Assignments" w=25 + empty w=0)', () => {
    const c = course([cat('all', 25), cat('imported', 0)], [item('all', 30, 40), item('all', 45, 60)])
    expect(gradeCourse(c).percent).toBeCloseTo(75, 10)
  })
})

// ---------------------------------------------------------------- drop rules

describe('drop rules', () => {
  it('drop lowest with unequal max points drops what helps most, not the lowest percent', () => {
    // 1/2 is the lowest percent (50%), but dropping 60/100 (60%) gives a higher category percent:
    //   drop 1/2   -> (60+10)/(100+10) = 63.6%
    //   drop 60/100 -> (1+10)/(2+10)  = 91.7%
    const a = item('q', 1, 2, { key: 'a' })
    const b = item('q', 60, 100, { key: 'b' })
    const cc = item('q', 10, 10, { key: 'c' })
    const c = course([cat('q', 100, { dropLowest: 1 })], [a, b, cc])
    const g = gradeCourse(c)
    expect(g.categories[0].dropped).toEqual(['b'])
    expect(g.percent).toBeCloseTo((11 / 12) * 100, 10)
  })

  it('drop highest drops the set whose removal gives the lowest percent', () => {
    const c = course(
      [cat('q', 100, { dropHighest: 1 })],
      [item('q', 10, 10, { key: 'a' }), item('q', 5, 10, { key: 'b' }), item('q', 7, 10, { key: 'c' })],
    )
    const g = gradeCourse(c)
    expect(g.categories[0].dropped).toEqual(['a'])
    expect(g.percent).toBeCloseTo(60, 10)
  })

  it('never drops items in neverDrop, but still counts them when choosing', () => {
    const c = course(
      [cat('q', 100, { dropLowest: 1, neverDrop: ['low'] })],
      [item('q', 2, 10, { key: 'low' }), item('q', 6, 10, { key: 'mid' }), item('q', 9, 10, { key: 'hi' })],
    )
    const g = gradeCourse(c)
    expect(g.categories[0].dropped).toEqual(['mid'])
    expect(g.percent).toBeCloseTo(55, 10)
  })

  it('never drops every item (drop 3 of 2 keeps one)', () => {
    const c = course(
      [cat('q', 100, { dropLowest: 3 })],
      [item('q', 2, 10, { key: 'a' }), item('q', 8, 10, { key: 'b' })],
    )
    const g = gradeCourse(c)
    expect(g.categories[0].dropped).toEqual(['a'])
    expect(g.percent).toBeCloseTo(80, 10)
  })

  it('ignores drop highest when lowest + highest would remove everything', () => {
    const dropped = applyDropRules([e('a', 2, 10), e('b', 8, 10)], 1, 1, new Set())
    expect([...dropped]).toEqual(['a'])
  })

  it('only drops among scored items (unscored items are not "dropped")', () => {
    const c = course(
      [cat('q', 100, { dropLowest: 1 })],
      [item('q', 5, 10, { key: 'a' }), item('q', null, 10, { key: 'b' })],
    )
    // One scored item only -> nothing can be dropped
    const g = gradeCourse(c)
    expect(g.categories[0].dropped).toEqual([])
    expect(g.percent).toBeCloseTo(50, 10)
  })

  it('all-extra-credit group: sorts by score (Canvas drop_unpointed)', () => {
    const dropped = applyDropRules([e('a', 3, 0), e('b', 1, 0), e('c', 2, 0)], 1, 0, new Set())
    expect([...dropped]).toEqual(['b'])
  })

  it('no rules -> nothing dropped; only never-drop items -> nothing dropped', () => {
    expect(applyDropRules([e('a', 1, 10)], 0, 0, new Set()).size).toBe(0)
    expect(applyDropRules([e('a', 1, 10), e('b', 2, 10)], 1, 0, new Set(['a', 'b'])).size).toBe(0)
  })

  it('drop lowest then drop highest together', () => {
    const entries = [e('a', 1, 10), e('b', 5, 10), e('c', 6, 10), e('d', 10, 10)]
    const dropped = applyDropRules(entries, 1, 1, new Set())
    expect([...dropped].sort()).toEqual(['a', 'd'])
  })

  it('bisection (big groups) agrees with brute force on random groups', () => {
    let seed = 42
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let trial = 0; trial < 300; trial++) {
      const n = 3 + Math.floor(rand() * 8)
      const entries: Entry[] = []
      for (let i = 0; i < n; i++) {
        const max = [5, 10, 20, 25, 50, 100][Math.floor(rand() * 6)]
        entries.push(e(`i${i}`, Math.round(rand() * max * 4) / 4, max))
      }
      const fixed = rand() < 0.3 ? [e('fixed', Math.round(rand() * 10), 10)] : []
      const keep = 1 + Math.floor(rand() * (n - 1))
      for (const mode of ['highest', 'lowest'] as const) {
        const brute = keepBestBruteForce(entries, keep, fixed, mode)
        const bis = keepBestBisection(entries, keep, fixed, mode)
        const pct = (kept: Entry[]) => {
          const all = [...kept, ...fixed]
          return all.reduce((t, x) => t + x.score, 0) / all.reduce((t, x) => t + x.max, 0)
        }
        expect(bis.length).toBe(keep)
        expect(pct(bis)).toBeCloseTo(pct(brute), 9)
      }
    }
  })

  it('large group (too many combinations for brute force) still drops correctly', () => {
    // 40 quizzes, drop 5: C(40, 35) = 658,008 combinations -> bisection path
    const items: Item[] = []
    for (let i = 0; i < 40; i++) items.push(item('q', i < 5 ? 0 : 10, 10, { key: `q${i}` }))
    const c = course([cat('q', 100, { dropLowest: 5 })], items)
    const g = gradeCourse(c)
    expect(g.categories[0].dropped.sort()).toEqual(['q0', 'q1', 'q2', 'q3', 'q4'])
    expect(g.percent).toBeCloseTo(100, 10)
  })
})

// ---------------------------------------------------------------- what-if and fill

describe('what-if and fillRemaining', () => {
  it('what-if replaces a real score (when typed over it) and fills an unscored item', () => {
    const graded = item('hw', 5, 10, { key: 'g' })
    const todo = item('hw', null, 10, { key: 't' })
    const c = course([cat('hw', 100)], [graded, todo], {}, { whatIfGraded: ['g'] })
    expect(gradeCourse(c).percent).toBeCloseTo(50, 10)
    expect(gradeCourse(c, { whatIf: { g: 10 } }).percent).toBeCloseTo(100, 10)
    const g = gradeCourse(c, { whatIf: { t: 10 } })
    expect(g.percent).toBeCloseTo(75, 10)
    expect(g.graded).toBe(2)
    expect(g.remaining).toBe(0)
  })

  it('a what-if set before the grade came out stops applying once the real score is in', () => {
    // The student typed 95 on Midterm 2 while it was ungraded; the real score (70) has since synced.
    const c = course([cat('ex', 100)], [item('ex', 70, 100, { key: 'mt2' })])
    expect(gradeCourse(c, { whatIf: { mt2: 95 } }).percent).toBeCloseTo(70, 10)
    // Typed over the real score on purpose (listed in whatIfGraded): it applies.
    const typedOver = course([cat('ex', 100)], [item('ex', 70, 100, { key: 'mt2' })], {}, { whatIfGraded: ['mt2'] })
    expect(gradeCourse(typedOver, { whatIf: { mt2: 95 } }).percent).toBeCloseTo(95, 10)
  })

  it("ignores a what-if on an item whose max is unknown (it would be pure extra credit)", () => {
    // Points mode: HW 70/100 x2 + a midterm with no posted max. A what-if of 85 must not push the grade to 112.5%.
    const items = [item('all', 70, 100), item('all', 70, 100), item('all', null, null, { key: 'mt' })]
    const p = course([cat('all', null)], items, { weighted: false })
    const g = gradeCourse(p, { whatIf: { mt: 85 } })
    expect(g.percent).toBeCloseTo(70, 10)
    expect(g.graded).toBe(2)
    expect(g.remaining).toBe(1) // still work to go
    // Weighted 50/50 with the unknown-max exam alone in its group: still 70, not 107.5.
    const w = course([cat('hw', 50), cat('ex', 50)], [item('hw', 70, 100), item('ex', null, null, { key: 'mt' })])
    expect(gradeCourse(w, { whatIf: { mt: 85 } }).percent).toBeCloseTo(70, 10)
  })

  it('fillRemaining gives every remaining item fill * max, including planned items', () => {
    const c = course(
      [cat('hw', null)],
      [item('hw', 8, 10), item('hw', null, 10), item('hw', null, 20, { planned: true })],
      { weighted: false },
    )
    // (8 + 0.5*10 + 0.5*20) / 40 = 23/40
    expect(gradeCourse(c, { fillRemaining: 0.5 }).percent).toBeCloseTo(57.5, 10)
  })

  it('fillRemaining skips items with unknown or zero max', () => {
    const c = course([cat('hw', null)], [item('hw', 8, 10), item('hw', null, null), item('hw', null, 0)], {
      weighted: false,
    })
    expect(gradeCourse(c, { fillRemaining: 1 }).percent).toBeCloseTo(80, 10)
  })

  it('fillRemaining adds a virtual 100-point item to empty weighted categories', () => {
    const c = course([cat('hw', 50), cat('final', 50)], [item('hw', 8, 10)])
    // hw 80% * 50 + final 0% * 50 -> 40
    expect(gradeCourse(c, { fillRemaining: 0 }).percent).toBeCloseTo(40, 10)
    expect(gradeCourse(c, { fillRemaining: 1 }).percent).toBeCloseTo(90, 10)
    // virtual items are never reported as dropped and are not counted as items
    expect(gradeCourse(c, { fillRemaining: 1 }).remaining).toBe(0)
  })

  it('no virtual items for 0-weight categories or in points mode', () => {
    const c = course([cat('hw', 100), cat('zero', 0)], [item('hw', 8, 10)])
    expect(gradeCourse(c, { fillRemaining: 0 }).percent).toBeCloseTo(80, 10)
    const p = course([cat('hw', 50), cat('final', 50)], [item('hw', 8, 10)], { weighted: false })
    expect(gradeCourse(p, { fillRemaining: 0 }).percent).toBeCloseTo(80, 10)
  })
})

describe('plannedCategories (empty weighted categories planned for)', () => {
  it('skips categories named like extra credit or bonus', () => {
    const c = course(
      [cat('hw', 50), cat('final', 45), { ...cat('ec', 5), name: 'Extra Credit' }, { ...cat('b', 3), name: 'Bonus points' }],
      [item('hw', 9, 10)],
    )
    expect(plannedCategories(c).map(x => x.key)).toEqual(['final'])
  })

  it('only adds categories while the total weight stays at or under 100, biggest first', () => {
    // hw 50 has points. Empty: final 30, project 20, participation 10. 50 + 30 + 20 = 100; participation would make 110.
    const c = course([cat('hw', 50), cat('part', 10), cat('final', 30), cat('proj', 20)], [item('hw', 9, 10)])
    expect(plannedCategories(c).map(x => x.key)).toEqual(['final', 'proj'])
    // Weights already reach 100 with posted work: an extra empty 5% is bonus, not planned.
    const full = course([cat('hw', 50), cat('ex', 50), cat('quiz', 5)], [item('hw', 9, 10), item('ex', null, 100)])
    expect(plannedCategories(full)).toEqual([])
  })

  it('none in points mode, for 0-weight categories, or for categories with posted work', () => {
    expect(plannedCategories(course([cat('hw', 50), cat('final', 50)], [item('hw', 9, 10)], { weighted: false }))).toEqual([])
    expect(plannedCategories(course([cat('hw', 100), cat('zero', 0)], [item('hw', 9, 10)]))).toEqual([])
    // A category whose only item has an unknown max still has nothing worth points: it is planned for.
    const c = course([cat('hw', 50), cat('ex', 50)], [item('hw', 9, 10), item('ex', null, null)])
    expect(plannedCategories(c).map(x => x.key)).toEqual(['ex'])
  })
})

// ---------------------------------------------------------------- letters

describe('letterFor', () => {
  const plusMinus = [
    { letter: 'A', min: 93.17 },
    { letter: 'A-', min: 86.33 },
    { letter: 'B', min: 75 },
    { letter: 'R', min: 0 },
  ]
  it('picks the highest cut reached', () => {
    expect(letterFor(95, plusMinus)).toBe('A')
    expect(letterFor(93.17, plusMinus)).toBe('A')
    expect(letterFor(90, plusMinus)).toBe('A-')
    expect(letterFor(10, plusMinus)).toBe('R')
  })
  it('rounds the percent to 2 decimals first (89.995 -> 90.00 earns an A at 90)', () => {
    expect(letterFor(89.995, DEFAULT_SCHEME_UNDERGRAD)).toBe('A')
    expect(letterFor(89.994, DEFAULT_SCHEME_UNDERGRAD)).toBe('B')
    expect(letterFor(93.1650001, plusMinus)).toBe('A')
  })
  it('handles min values with float noise (0.9317 * 100)', () => {
    expect(letterFor(93.17, [{ letter: 'A', min: 0.9317 * 100 }, { letter: 'B', min: 0 }])).toBe('A')
  })
  it('works on unsorted schemes, gives the lowest letter below every cut, null without percent/scheme', () => {
    const unsorted = [{ letter: 'B', min: 80 }, { letter: 'A', min: 90 }, { letter: 'C', min: 70 }]
    expect(letterFor(85, unsorted)).toBe('B')
    expect(letterFor(50, unsorted)).toBe('C')
    expect(letterFor(-5, DEFAULT_SCHEME_UNDERGRAD)).toBe('R')
    expect(letterFor(null, DEFAULT_SCHEME_UNDERGRAD)).toBeNull()
    expect(letterFor(90, [])).toBeNull()
  })
  it('roundPercent rounds half up like Canvas', () => {
    expect(roundPercent(89.995)).toBe(90)
    expect(roundPercent(86.666666)).toBe(86.67)
    expect(roundPercent((56.5 / 65) * 100)).toBe(86.92)
    expect(roundPercent(0.1 + 0.2)).toBe(0.3)
  })
})

// ---------------------------------------------------------------- needed

describe('neededForLetters', () => {
  it('possible / impossible with remaining items (points mode)', () => {
    // 70/100 graded, 50 points remaining. Grade at average x on the rest = (70 + 50x) / 150.
    const c = course([cat('all', null)], [item('all', 70, 100), item('all', null, 50)], { weighted: false })
    expect(neededForLetters(c)).toEqual([
      { letter: 'A', min: 90, needed: null, status: 'impossible' }, // even 100% gives 80%
      { letter: 'B', min: 80, needed: 100, status: 'possible' },
      { letter: 'C', min: 70, needed: 70, status: 'possible' },
      { letter: 'D', min: 60, needed: 40, status: 'possible' },
    ])
  })

  it('guaranteed when 0% on the rest still earns the letter', () => {
    // 95/100 graded, 10 remaining: at 0% -> 86.4% (B guaranteed); A needs (95+10x)/110 >= 90 -> 40%
    const c = course([cat('all', null)], [item('all', 95, 100), item('all', null, 10)], { weighted: false })
    const [a, b, cc] = neededForLetters(c)
    expect(a).toEqual({ letter: 'A', min: 90, needed: 40, status: 'possible' })
    expect(b).toEqual({ letter: 'B', min: 80, needed: 0, status: 'guaranteed' })
    expect(cc.status).toBe('guaranteed')
  })

  it('rounds needed UP to 0.1', () => {
    // 88/100 graded, 30 remaining. A: (88 + 30x)/130 >= 89.995% -> x >= 0.96645 -> 96.7
    const c = course([cat('all', null)], [item('all', 88, 100), item('all', null, 30)], { weighted: false })
    expect(neededForLetters(c)[0]).toEqual({ letter: 'A', min: 90, needed: 96.7, status: 'possible' })
  })

  it('counts empty weighted categories as remaining work', () => {
    // hw 80% (w 50) done, final (w 50) empty. A needs 40 + 50x >= 89.995 -> x >= 0.9999 -> 100
    const c = course([cat('hw', 50), cat('final', 50)], [item('hw', 8, 10)])
    const [a, b] = neededForLetters(c)
    expect(a).toEqual({ letter: 'A', min: 90, needed: 100, status: 'possible' })
    expect(b).toEqual({ letter: 'B', min: 80, needed: 80, status: 'possible' })
  })

  it("every letter is 'locked' when no work remains (even ones below the grade; the UI checks the percent)", () => {
    const c = course([cat('all', null)], [item('all', 85, 100), item('all', null, 0)], { weighted: false })
    const needed = neededForLetters(c)
    expect(needed[0]).toEqual({ letter: 'A', min: 90, needed: null, status: 'locked' })
    expect(needed.every(n => n.status === 'locked' && n.needed === null)).toBe(true)
    // Fully graded below every cut: still 'locked', never "even 100% on the rest" (there is no rest).
    const low = course([cat('all', null)], [item('all', 55, 100)], { weighted: false })
    expect(neededForLetters(low).map(n => n.status)).toEqual(['locked', 'locked', 'locked', 'locked'])
  })

  it("'unknown' when the only work left has no known point value (never 'locked')", () => {
    // HW 95/100 graded, an exam with no posted max: we can't say anything is locked in.
    const c = course([cat('all', null)], [item('all', 95, 100), item('all', null, null)], { weighted: false })
    const needed = neededForLetters(c)
    expect(needed).toHaveLength(4)
    expect(needed.every(n => n.status === 'unknown' && n.needed === null)).toBe(true)
  })

  it('known and unknown remaining work together: computed from the known part', () => {
    // 10 x 9.5/10 graded, one 10-pt HW left, plus an exam with no max. Math uses the HW only.
    const items = [...Array.from({ length: 10 }, () => item('all', 9.5, 10)), item('all', null, 10), item('all', null, null)]
    const needed = neededForLetters(course([cat('all', null)], items, { weighted: false }))
    // Same as 95/100 graded + 10 left: A needs (95 + 10x)/110 >= 90 -> 40%; at 0% it's 86.4%, so B is guaranteed.
    expect(needed[0]).toEqual({ letter: 'A', min: 90, needed: 40, status: 'possible' })
    expect(needed[1]).toEqual({ letter: 'B', min: 80, needed: 0, status: 'guaranteed' })
  })

  it('no rows when no grade can be computed and nothing can be planned', () => {
    // Only ungraded items with unknown max.
    expect(neededForLetters(course([cat('all', null)], [item('all', null, null)], { weighted: false }))).toEqual([])
    // Only zero-point items.
    expect(neededForLetters(course([cat('all', null)], [item('all', null, 0)], { weighted: false }))).toEqual([])
    // Weighted course whose only work sits in a 0% group: even 100% gives no grade.
    expect(neededForLetters(course([cat('w0', 0)], [item('w0', 8, 10), item('w0', null, 10)]))).toEqual([])
  })

  it('what-ifs count as scores, not remaining work', () => {
    const c = course([cat('all', null)], [item('all', 70, 100), item('all', null, 50, { key: 't' })], {
      weighted: false,
    })
    const needed = neededForLetters(c, { t: 50 })
    // (70 + 50) / 150 = 80% with nothing left
    expect(needed.map(n => n.status)).toEqual(['locked', 'locked', 'locked', 'locked'])
  })

  it('an empty Extra Credit group is not treated as work you must earn', () => {
    // HW 90/100 (w 50) graded, exam 100 pts (w 50) ungraded, EC (w 5) empty. A needs 90% on the exam,
    // not the 81.9% you'd get by assuming the bonus is earned.
    const c = course(
      [cat('hw', 50), cat('ex', 50), { ...cat('ec', 5), name: 'Extra Credit' }],
      [item('hw', 90, 100), item('ex', null, 100)],
    )
    expect(neededForLetters(c)[0]).toEqual({ letter: 'A', min: 90, needed: 90, status: 'possible' })
  })

  it('caps the number of letters at 15', () => {
    const scheme = Array.from({ length: 30 }, (_, k) => ({ letter: `L${k}`, min: 99 - k * 3.3 }))
    const c = course([cat('all', null)], [item('all', 50, 100), item('all', null, 100)], { weighted: false, scheme })
    const needed = neededForLetters(c)
    expect(needed).toHaveLength(15)
    expect(needed[0].letter).toBe('L0') // the highest letters are kept
  })

  it('stays fast on a big course with heavy drop rules (400 items, drop 150 lowest / 40 highest, 30 cuts)', () => {
    const items = Array.from({ length: 400 }, (_, j) =>
      item('all', j % 2 ? (j * 7) % 10 : null, (j % 13) + 1, { key: `big${j}` }),
    )
    const scheme = Array.from({ length: 30 }, (_, k) => ({ letter: `L${k}`, min: 99 - k * 3.3 }))
    const c = course([cat('all', null, { dropLowest: 150, dropHighest: 40 })], items, { weighted: false, scheme })
    const start = performance.now()
    const needed = neededForLetters(c)
    const ms = performance.now() - start
    expect(needed).toHaveLength(15)
    expect(ms).toBeLessThan(1000) // about 130 ms on a laptop; it was about 1.8 s before the caps
  })

  it('uses the course scheme, skipping its lowest letter', () => {
    const scheme = [
      { letter: 'A', min: 93 },
      { letter: 'A-', min: 90 },
      { letter: 'B+', min: 87 },
      { letter: 'F', min: 0 },
    ]
    const c = course([cat('all', null)], [item('all', 80, 100), item('all', null, 100)], {
      weighted: false,
      scheme,
    })
    const needed = neededForLetters(c)
    expect(needed.map(n => n.letter)).toEqual(['A', 'A-', 'B+'])
    // B+: (80 + 100x)/200 >= 86.995 -> x >= 0.9399 -> 94
    expect(needed[2]).toEqual({ letter: 'B+', min: 87, needed: 94, status: 'possible' })
  })

  it('works with drop rules (the dropped item is the worst one)', () => {
    // Quizzes drop lowest 1: 0/10 graded, 10/10 graded, one 10-pt quiz left. At any x the 0 is dropped.
    const c = course(
      [cat('q', 100, { dropLowest: 1 })],
      [item('q', 0, 10), item('q', 10, 10), item('q', null, 10)],
    )
    const [a] = neededForLetters(c)
    // (10 + 10x)/20 >= 89.995% -> x >= 0.7999 -> 80
    expect(a).toEqual({ letter: 'A', min: 90, needed: 80, status: 'possible' })
  })
})
