// Sample data for "See a demo": made-up grades for a typical first-year CMU schedule, so students can try the
// dashboard before adding the Sync button. Every name and number here is fictional.
import type { SyncedCategory, SyncedCourse, SyncedItem, SyncPayload } from '../types'
import { CANVAS_ORIGIN, GRADESCOPE_ORIGIN } from './brand'

const AT = '2026-11-10T15:00:00Z'
const TERM = 'Fall 2026'

function cat(id: string, name: string, weight: number | null, dropLowest = 0): SyncedCategory {
  return { id, name, weight, dropLowest, dropHighest: 0, neverDrop: [] }
}

/** An item: [name, score or null, max, due date (MM-DD)] in a category. */
function items(categoryId: string | null, rows: [string, number | null, number, string][], idPrefix: string): SyncedItem[] {
  return rows.map(([name, score, max, due], i) => ({
    id: `${idPrefix}${i + 1}`,
    name,
    categoryId,
    score,
    max,
    status: score === null ? 'unsubmitted' : 'graded',
    due: `2026-${due}T23:59:00-05:00`,
    omit: false,
    url: null,
  }))
}

function course(source: 'canvas' | 'gradescope', sourceId: string, number: string, title: string, extra: Partial<SyncedCourse>): SyncedCourse {
  return {
    source,
    sourceId,
    number,
    alsoNumbers: [],
    title,
    term: TERM,
    url: source === 'canvas' ? `${CANVAS_ORIGIN}/` : `${GRADESCOPE_ORIGIN}/`,
    weighted: false,
    categories: [],
    items: [],
    canvasScore: null,
    canvasGrade: null,
    scheme: null,
    syncedAt: AT,
    ...extra,
  }
}

const canvasCourses: SyncedCourse[] = [
  course('canvas', 'demo-c1', '15122', '15-122 Principles of Imperative Computation', {
    weighted: true,
    categories: [cat('g1', 'Programming Homework', 35), cat('g2', 'Written Homework', 10, 1), cat('g3', 'Midterms', 30), cat('g4', 'Final Exam', 25)],
    items: [
      ...items('g1', [['Prog 1: Pixels', 100, 100, '09-05'], ['Prog 2: Strings', 95, 100, '09-19'], ['Prog 3: Images', 88, 100, '10-03'], ['Prog 4: Clac', 97, 100, '10-24'], ['Prog 5: Lights Out', null, 100, '11-21']], 'p'),
      ...items('g2', [['Written 1', 18, 20, '09-02'], ['Written 2', 20, 20, '09-09'], ['Written 3', 12, 20, '09-16'], ['Written 4', 19, 20, '09-23'], ['Written 5', 17, 20, '10-07'], ['Written 6', null, 20, '11-18']], 'w'),
      ...items('g3', [['Midterm 1', 81, 100, '10-01'], ['Midterm 2', null, 100, '11-19']], 'm'),
    ],
    canvasScore: 89.07,
    scheme: [
      { letter: 'A', min: 90 },
      { letter: 'B', min: 80 },
      { letter: 'C', min: 70 },
      { letter: 'D', min: 60 },
      { letter: 'R', min: 0 },
    ],
  }),
  course('canvas', 'demo-c2', '76101', '76-101 Interpretation and Argument', {
    weighted: true,
    categories: [cat('h1', 'Papers', 60), cat('h2', 'Reading Responses', 20), cat('h3', 'Participation', 20)],
    items: [
      ...items('h1', [['Paper 1: Summary', 88, 100, '09-20'], ['Paper 2: Analysis', 91, 100, '10-18'], ['Paper 3: Argument', null, 100, '12-04']], 'a'),
      ...items('h2', [['Response 1', 10, 10, '09-08'], ['Response 2', 9, 10, '09-22'], ['Response 3', 10, 10, '10-06'], ['Response 4', 8, 10, '10-27']], 'r'),
      ...items('h3', [['Participation (midpoint)', 18, 20, '10-15']], 'q'),
    ],
    canvasScore: 90.2,
  }),
  course('canvas', 'demo-c3', '36200', '36-200 Reasoning with Data', {
    weighted: true,
    categories: [cat('k1', 'Homework', 20, 1), cat('k2', 'Labs', 15), cat('k3', 'Exams', 45), cat('k4', 'Project', 20)],
    items: [
      ...items('k1', [['HW 1', 9, 10, '09-04'], ['HW 2', 8, 10, '09-11'], ['HW 3', 6, 10, '09-18'], ['HW 4', 10, 10, '09-25'], ['HW 5', 7, 10, '10-09'], ['HW 6', null, 10, '11-13']], 'h'),
      ...items('k2', [['Lab 1', 5, 5, '09-03'], ['Lab 2', 4, 5, '09-17'], ['Lab 3', 5, 5, '10-01'], ['Lab 4', 3, 5, '10-22']], 'l'),
      ...items('k3', [['Exam 1', 74, 100, '10-08'], ['Exam 2', null, 100, '11-24'], ['Final Exam', null, 100, '12-11']], 'e'),
    ],
    canvasScore: 78.81,
  }),
]

// A Gradescope-only course: no weights anywhere, so the app falls back to total points until you add the syllabus's.
const gradescopeCourses: SyncedCourse[] = [
  course('gradescope', 'demo-g1', '21127', 'Concepts of Mathematics', {
    items: [
      ...items(null, [['HW 1', 46, 50, '09-05'], ['HW 2', 50, 50, '09-12'], ['HW 3', 41, 50, '09-19'], ['HW 4', 44, 50, '09-26'], ['HW 5', 48, 50, '10-10']], 'x'),
      ...items(null, [['Midterm 1', 84, 100, '10-02']], 'y'),
      { id: 'y2', name: 'Midterm 2', categoryId: null, score: null, max: null, status: 'ungraded', due: null, omit: false, url: null },
      { id: 'x6', name: 'HW 6', categoryId: null, score: null, max: null, status: 'submitted', due: '2026-11-14T23:59:00-05:00', omit: false, url: null },
    ],
  }),
  // The same 15-122 assignments also live on Gradescope; the app matches them by name instead of counting twice.
  course('gradescope', 'demo-g2', '15122', 'Principles of Imperative Computation', {
    items: items(null, [['Written 1', 18, 20, '09-02'], ['Written 2', 20, 20, '09-09'], ['Written 3', 12, 20, '09-16'], ['Written 4', 19, 20, '09-23'], ['Written 5', 17, 20, '10-07']], 'gw'),
  }),
]

/** The two payloads a demo loads, exactly as if the Sync button had run on Canvas and on Gradescope. */
export function demoPayloads(): SyncPayload[] {
  return [
    { v: 1, kind: 'canvas', at: AT, courses: structuredClone(canvasCourses), warnings: [] },
    { v: 1, kind: 'gradescope', at: AT, courses: structuredClone(gradescopeCourses), warnings: [] },
  ]
}
