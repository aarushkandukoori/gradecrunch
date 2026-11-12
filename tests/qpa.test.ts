// Tests for CMU letter points, semester / cumulative QPA and Dean's List. Synthetic courses only.
import { describe, expect, it } from 'vitest'
import type { Course, CoursePrefs, GradeResult, Settings } from '../src/types'
import {
  COLLEGES,
  DEFAULT_SCHEME_GRAD,
  DEFAULT_SCHEME_UNDERGRAD,
  collegeByKey,
  defaultScheme,
  formatCourseNumber,
  letterPoints,
  stripPlusMinus,
  toCmuLetter,
} from '../src/lib/cmu'
import { computeQpa, estimatedLetter } from '../src/lib/qpa'

// ---------------------------------------------------------------- builders

let n = 0
function course(number: string | null, units: number, prefs: CoursePrefs = {}, extra: Partial<Course> = {}): Course {
  n++
  return {
    key: `Fall 2026|${number ?? `x${n}`}`,
    number,
    alsoNumbers: [],
    title: `Course ${n}`,
    term: 'Fall 2026',
    academic: number !== null,
    sources: [],
    weighted: false,
    categories: [],
    items: [],
    canvasScore: null,
    canvasGrade: null,
    scheme: DEFAULT_SCHEME_UNDERGRAD,
    schemeSource: 'default',
    units,
    unitsSource: 'catalog',
    manualPercent: null,
    prefs,
    ...extra,
  }
}

/** A course with a final letter override (the simplest way to pin a letter). */
const graded = (number: string, units: number, letter: string, prefs: CoursePrefs = {}) =>
  course(number, units, { letter, ...prefs })

function settings(extra: Partial<Settings> = {}): Settings {
  return { level: 'undergrad', college: null, priorQpa: null, priorUnits: null, term: null, showAll: false, ...extra }
}

function gradeWith(letter: string | null, percent: number | null = null): GradeResult {
  return { percent, letter, categories: [], graded: 0, remaining: 0 }
}

const noGrades = new Map<string, GradeResult>()

// ---------------------------------------------------------------- cmu.ts

describe('letterPoints', () => {
  it('undergrad scale, with +/- stripped (A- and A+ are 4.0, B+ is 3.0)', () => {
    expect(letterPoints('A', 'undergrad')).toBe(4)
    expect(letterPoints('A-', 'undergrad')).toBe(4)
    expect(letterPoints('A+', 'undergrad')).toBe(4)
    expect(letterPoints('B+', 'undergrad')).toBe(3)
    expect(letterPoints('C', 'undergrad')).toBe(2)
    expect(letterPoints('D-', 'undergrad')).toBe(1)
    expect(letterPoints('R', 'undergrad')).toBe(0)
    expect(letterPoints('X', 'undergrad')).toBe(0)
  })
  it('F counts as R, and letters are cleaned up (case, spaces, Unicode minus)', () => {
    expect(letterPoints('F', 'undergrad')).toBe(0)
    expect(letterPoints('F', 'grad')).toBe(0)
    expect(letterPoints(' a ', 'undergrad')).toBe(4)
    expect(letterPoints('A−', 'grad')).toBe(3.67)
  })
  it('graduate scale keeps +/-', () => {
    expect(letterPoints('A+', 'grad')).toBe(4.33)
    expect(letterPoints('A', 'grad')).toBe(4)
    expect(letterPoints('A-', 'grad')).toBe(3.67)
    expect(letterPoints('B+', 'grad')).toBe(3.33)
    expect(letterPoints('B-', 'grad')).toBe(2.67)
    expect(letterPoints('C+', 'grad')).toBe(2.33)
    expect(letterPoints('C-', 'grad')).toBe(1.67)
    expect(letterPoints('D+', 'grad')).toBe(1.33)
    expect(letterPoints('D', 'grad')).toBe(1)
    expect(letterPoints('R', 'grad')).toBe(0)
  })
  it('non-factorable and unknown letters give null', () => {
    for (const l of ['P', 'N', 'S', 'O', 'W', 'I', 'AD', 'TR']) {
      expect(letterPoints(l, 'undergrad')).toBeNull()
      expect(letterPoints(l, 'grad')).toBeNull()
    }
    expect(letterPoints('', 'undergrad')).toBeNull()
    expect(letterPoints('E', 'undergrad')).toBeNull()
    expect(letterPoints('CONSTRUCTOR', 'grad')).toBeNull()
    expect(letterPoints('E', 'grad')).toBeNull()
  })
  it('grad: letters not on the CMU grad scale map to the nearest CMU grade (D- -> D, F -> R)', () => {
    expect(letterPoints('D-', 'grad')).toBe(1)
    expect(letterPoints('D−', 'grad')).toBe(1) // Unicode minus
    expect(letterPoints('f', 'grad')).toBe(0)
  })
})

describe('toCmuLetter', () => {
  it('undergrad strips +/- and turns F into R', () => {
    expect(toCmuLetter('A-', 'undergrad')).toBe('A')
    expect(toCmuLetter('B−', 'undergrad')).toBe('B')
    expect(toCmuLetter('F', 'undergrad')).toBe('R')
    expect(toCmuLetter('P', 'undergrad')).toBe('P')
  })
  it('grad keeps +/-, maps D- to D and F to R, leaves other letters alone', () => {
    expect(toCmuLetter('A-', 'grad')).toBe('A-')
    expect(toCmuLetter('D-', 'grad')).toBe('D')
    expect(toCmuLetter('F', 'grad')).toBe('R')
    expect(toCmuLetter(' w ', 'grad')).toBe('W')
    expect(toCmuLetter('E', 'grad')).toBe('E')
  })
})

describe('cmu helpers', () => {
  it('stripPlusMinus and formatCourseNumber', () => {
    expect(stripPlusMinus('a-')).toBe('A')
    expect(stripPlusMinus('B+')).toBe('B')
    expect(formatCourseNumber('21241')).toBe('21-241')
    expect(formatCourseNumber('1524')).toBe('1524')
  })
  it('default schemes are sorted descending and end at 0', () => {
    for (const scheme of [DEFAULT_SCHEME_UNDERGRAD, DEFAULT_SCHEME_GRAD]) {
      const mins = scheme.map(c => c.min)
      expect([...mins].sort((a, b) => b - a)).toEqual(mins)
      expect(mins[mins.length - 1]).toBe(0)
    }
    expect(defaultScheme('grad')).toBe(DEFAULT_SCHEME_GRAD)
    expect(defaultScheme('undergrad').map(c => c.letter)).toEqual(['A', 'B', 'C', 'D', 'R'])
  })
  it('every college has a unique key, a name and a note or rule', () => {
    const keys = COLLEGES.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.sort()).toEqual(['bxa', 'cfa', 'cit', 'cmuq', 'dietrich', 'heinz', 'is', 'mcs', 'scs', 'tepper'])
    for (const c of COLLEGES) {
      expect(c.name.length).toBeGreaterThan(0)
      expect(c.deansList ? c.deansList.note : c.note).not.toBe('')
    }
    expect(collegeByKey('cfa')?.deansList).toBeNull()
    expect(collegeByKey('nope')).toBeNull()
    expect(collegeByKey(null)).toBeNull()
  })
})

// ---------------------------------------------------------------- estimatedLetter

describe('estimatedLetter', () => {
  const s = settings()
  it('prefers the override, then the computed grade, then Canvas score, then manual percent', () => {
    expect(estimatedLetter(course('21241', 9, { letter: 'B' }), gradeWith('A'), s)).toBe('B')
    expect(estimatedLetter(course('21241', 9), gradeWith('C'), s)).toBe('C')
    expect(estimatedLetter(course('21241', 9, {}, { canvasScore: 91 }), gradeWith(null), s)).toBe('A')
    expect(estimatedLetter(course('21241', 9, {}, { canvasScore: 91 }), undefined, s)).toBe('A')
    expect(estimatedLetter(course('21241', 9, {}, { manualPercent: 72 }), undefined, s)).toBe('C')
    expect(estimatedLetter(course('21241', 9), undefined, s)).toBeNull()
  })
  it('strips +/- for undergrads but keeps it for grads; F becomes R', () => {
    expect(estimatedLetter(course('21241', 9), gradeWith('A-'), s)).toBe('A')
    expect(estimatedLetter(course('21241', 9), gradeWith('A-'), settings({ level: 'grad' }))).toBe('A-')
    expect(estimatedLetter(course('21241', 9), gradeWith('F'), s)).toBe('R')
    expect(estimatedLetter(course('21241', 9, { letter: 'P' }), gradeWith('A'), s)).toBe('P')
  })

  it('grad: a D- from a Canvas scheme becomes D and still counts toward QPA', () => {
    const grad = settings({ level: 'grad' })
    const c = course('21241', 12)
    expect(estimatedLetter(c, gradeWith('D-'), grad)).toBe('D')
    const q = computeQpa([c, graded('15122', 12, 'A')], new Map([[c.key, gradeWith('D-')]]), grad)
    expect(q.rows[0]).toMatchObject({ letter: 'D', points: 1, factorable: true })
    expect(q.semesterQpa).toBeCloseTo(2.5, 10) // (1*12 + 4*12) / 24
  })
})

// ---------------------------------------------------------------- computeQpa

describe('computeQpa', () => {
  it('catalog test vector: 11u A + 10u R + 9u B + 9u C + 9u D = 98/48 = 2.0417', () => {
    const courses = [
      graded('21241', 11, 'A'),
      graded('15112', 10, 'R'),
      graded('36225', 9, 'B'),
      graded('85170', 9, 'C'),
      graded('76101', 9, 'D'),
    ]
    const q = computeQpa(courses, noGrades, settings())
    expect(q.qualityPoints).toBe(98)
    expect(q.factorableUnits).toBe(48)
    expect(q.semesterQpa).toBeCloseTo(2.0417, 4)
    expect(q.totalUnits).toBe(48)
  })

  it('second vector with a P course ignored: 152/47 = 3.234', () => {
    const courses = [
      graded('15122', 12, 'A'),
      graded('21127', 10, 'B'),
      graded('36225', 9, 'A'),
      graded('15150', 10, 'C'),
      graded('99101', 3, 'P'),
      graded('70100', 6, 'B'),
    ]
    const q = computeQpa(courses, noGrades, settings())
    expect(q.qualityPoints).toBe(152)
    expect(q.factorableUnits).toBe(47)
    expect(q.totalUnits).toBe(50)
    expect(q.semesterQpa).toBeCloseTo(3.234, 3)
    const p = q.rows.find(r => r.letter === 'P')!
    expect(p.factorable).toBe(false)
    expect(p.reason).toBe("P doesn't count toward QPA")
  })

  it('uses computed grades from the map', () => {
    const a = course('21241', 12)
    const b = course('15122', 12)
    const grades = new Map([
      [a.key, gradeWith('A', 95)],
      [b.key, gradeWith('B', 85)],
    ])
    const q = computeQpa([a, b], grades, settings())
    expect(q.semesterQpa).toBeCloseTo(3.5, 10)
    expect(q.rows.map(r => r.label)).toEqual(['21-241', '15-122'])
  })

  it('pass/fail, no grade yet and 0 units are not factorable, each with a reason', () => {
    const courses = [
      graded('21241', 12, 'A'),
      graded('15122', 12, 'B', { passFail: true }),
      course('36225', 9),
      graded('99101', 0, 'A'),
    ]
    const q = computeQpa(courses, noGrades, settings())
    expect(q.rows.map(r => r.reason)).toEqual([null, 'Pass/fail', 'No grade yet', '0 units'])
    expect(q.semesterQpa).toBe(4)
    expect(q.factorableUnits).toBe(12)
    expect(q.totalUnits).toBe(33)
  })

  it('skips hidden and non-academic courses entirely', () => {
    const courses = [graded('21241', 12, 'A'), graded('15122', 12, 'R', { hidden: true }), course(null, 9, { letter: 'R' })]
    const q = computeQpa(courses, noGrades, settings())
    expect(q.rows).toHaveLength(1)
    expect(q.semesterQpa).toBe(4)
  })

  it('no factorable courses -> null QPA', () => {
    const q = computeQpa([course('21241', 12)], noGrades, settings())
    expect(q.semesterQpa).toBeNull()
    expect(q.qualityPoints).toBe(0)
  })

  it('undergrad A- counts as 4.0; grad uses the +/- scale', () => {
    const courses = [graded('21241', 10, 'A-'), graded('15122', 10, 'B+')]
    expect(computeQpa(courses, noGrades, settings()).semesterQpa).toBe(3.5)
    expect(computeQpa(courses, noGrades, settings({ level: 'grad' })).semesterQpa).toBeCloseTo(3.5, 10)
    const g = computeQpa([graded('10601', 12, 'A-'), graded('10605', 12, 'A+')], noGrades, settings({ level: 'grad' }))
    expect(g.semesterQpa).toBeCloseTo(4, 10) // (3.67 + 4.33) / 2
    expect(g.rows[0].points).toBe(3.67)
  })

  it('Dietrich leaves PE (69-xxx) and StuCo (98-xxx) out; other colleges count them', () => {
    const courses = [graded('21241', 9, 'A'), graded('69101', 3, 'C'), graded('98012', 3, 'C')]
    const d = computeQpa(courses, noGrades, settings({ college: 'dietrich' }))
    expect(d.semesterQpa).toBe(4)
    expect(d.rows[1].reason).toBe("Dietrich doesn't count PE/StuCo")
    expect(computeQpa(courses, noGrades, settings({ college: 'is' })).semesterQpa).toBe(4)
    expect(computeQpa(courses, noGrades, settings({ college: 'scs' })).semesterQpa).toBeCloseTo(3.2, 10) // (36 + 6 + 6) / 15
  })

  it('cumulative QPA combines prior quality points with this semester', () => {
    const courses = [graded('21241', 12, 'A'), graded('15122', 12, 'B')] // 84 QP over 24 units
    const q = computeQpa(courses, noGrades, settings({ priorQpa: 3.0, priorUnits: 96 }))
    // (3.0 * 96 + 84) / (96 + 24) = 372 / 120 = 3.1
    expect(q.cumulativeQpa).toBeCloseTo(3.1, 10)
    expect(computeQpa(courses, noGrades, settings({ priorQpa: 3.0 })).cumulativeQpa).toBeNull()
    expect(computeQpa(courses, noGrades, settings({ priorQpa: 3.0, priorUnits: 0 })).cumulativeQpa).toBeNull()
    // Nothing factorable this semester: cumulative stays at the prior value
    const none = computeQpa([course('21241', 12)], noGrades, settings({ priorQpa: 3.2, priorUnits: 50 }))
    expect(none.cumulativeQpa).toBeCloseTo(3.2, 10)
  })

  it('includeCumulative: false (a past term, already in the SIO cumulative) gives no cumulative', () => {
    const courses = [graded('21241', 12, 'A'), graded('15122', 12, 'B')]
    const s = settings({ priorQpa: 3.5, priorUnits: 96 })
    const past = computeQpa(courses, noGrades, s, { includeCumulative: false })
    expect(past.cumulativeQpa).toBeNull()
    expect(past.semesterQpa).toBeCloseTo(3.5, 10) // the semester QPA itself is unchanged
    expect(computeQpa(courses, noGrades, s, { includeCumulative: true }).cumulativeQpa).toBeCloseTo(3.5, 10)
    expect(computeQpa(courses, noGrades, s).cumulativeQpa).not.toBeNull() // default: included
  })
})

// ---------------------------------------------------------------- Dean's List

describe("Dean's List", () => {
  const four = (letters: string[], units = 12) => letters.map((l, i) => graded(`1500${i}`, units, l))

  it('null without a college, or for colleges where it cannot be computed', () => {
    const courses = four(['A', 'A', 'A'])
    expect(computeQpa(courses, noGrades, settings()).deansList).toBeNull()
    expect(computeQpa(courses, noGrades, settings({ college: 'cfa' })).deansList).toBeNull()
    expect(computeQpa(courses, noGrades, settings({ college: 'heinz' })).deansList).toBeNull()
  })

  it('null for grad students (Dean\'s List is an undergraduate honor)', () => {
    const courses = four(['A', 'A', 'A'])
    expect(computeQpa(courses, noGrades, settings({ college: 'scs' })).deansList).not.toBeNull()
    expect(computeQpa(courses, noGrades, settings({ college: 'scs', level: 'grad' })).deansList).toBeNull()
  })

  it('SCS: 3.75 on 36 units', () => {
    const yes = computeQpa(four(['A', 'A', 'A']), noGrades, settings({ college: 'scs' })).deansList!
    expect(yes).toMatchObject({ eligible: true, threshold: 3.75, minUnits: 36, college: 'SCS' })
    // 3 x 12u with A, A, B = 3.67 < 3.75
    expect(computeQpa(four(['A', 'A', 'B']), noGrades, settings({ college: 'scs' })).deansList!.eligible).toBe(false)
    // 4.0 but only 24 units
    expect(computeQpa(four(['A', 'A']), noGrades, settings({ college: 'scs' })).deansList!.eligible).toBe(false)
  })

  it('MCS: 3.50 on 36 units', () => {
    const q = computeQpa(four(['A', 'A', 'B', 'B']), noGrades, settings({ college: 'mcs' }))
    expect(q.deansList).toMatchObject({ eligible: true, threshold: 3.5, minUnits: 36, college: 'MCS' })
  })

  it('Dietrich: 3.50 on 45+ units, or 3.75 on 36-44', () => {
    const s = settings({ college: 'dietrich' })
    // 48 units at 3.5 -> eligible under the 45-unit rule
    expect(computeQpa(four(['A', 'A', 'B', 'B']), noGrades, s).deansList).toMatchObject({
      eligible: true,
      threshold: 3.5,
      minUnits: 45,
    })
    // 36 units at 3.67 -> not eligible; shows the rule that fits 36 units (3.75 / 36)
    expect(computeQpa(four(['A', 'A', 'B']), noGrades, s).deansList).toMatchObject({
      eligible: false,
      threshold: 3.75,
      minUnits: 36,
    })
    // 36 units at 4.0 -> eligible under the 36-44 rule
    expect(computeQpa(four(['A', 'A', 'A']), noGrades, s).deansList).toMatchObject({
      eligible: true,
      threshold: 3.75,
      minUnits: 36,
    })
    // 24 units -> shows the main rule, not eligible
    expect(computeQpa(four(['A', 'A']), noGrades, s).deansList).toMatchObject({
      eligible: false,
      threshold: 3.5,
      minUnits: 45,
    })
  })

  it('CMU-Q: 3.75 on 36, or 3.50 on 45', () => {
    const s = settings({ college: 'cmuq' })
    expect(computeQpa(four(['A', 'A', 'B', 'B']), noGrades, s).deansList).toMatchObject({
      eligible: true,
      threshold: 3.5,
      minUnits: 45,
      college: 'CMU-Q',
    })
    expect(computeQpa(four(['A', 'A', 'B']), noGrades, s).deansList!.eligible).toBe(false)
  })

  it('pass/fail units do not count toward the minimum', () => {
    const courses = [...four(['A', 'A']), graded('99101', 12, 'A', { passFail: true })]
    expect(computeQpa(courses, noGrades, settings({ college: 'cit' })).deansList!.eligible).toBe(false)
  })
})
