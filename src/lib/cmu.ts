// CMU grading rules: letter -> quality points, default letter schemes, and each college's Dean's List rule.
// Every rule here comes from the 2026-27 CMU catalog and the Registrar's grading policy page
// (checked 2026-11-12; see the research notes, section "cmu-grading").
import type { GradeCut, Level } from '../types'

/**
 * Undergraduate quality points. CMU undergrad final grades have no plus/minus, and the failing
 * grade is R (not F). X is a "conditional failure" and counts as 0 in the QPA.
 */
export const UNDERGRAD_POINTS: Record<string, number> = { A: 4, B: 3, C: 2, D: 1, R: 0, X: 0 }

/** Graduate quality points (the 4.33 scale CMU has used for all grad students since fall 1995). */
export const GRAD_POINTS: Record<string, number> = {
  'A+': 4.33,
  A: 4,
  'A-': 3.67,
  'B+': 3.33,
  B: 3,
  'B-': 2.67,
  'C+': 2.33,
  C: 2,
  'C-': 1.67,
  'D+': 1.33,
  D: 1,
  R: 0,
  X: 0,
}

/**
 * Grades that never count toward QPA (no quality points, units left out of the denominator):
 * P pass, N no pass, S satisfactory, O audit, W withdrawal, I incomplete, AD credit by exam/AP, TR transfer.
 */
export const NON_FACTORABLE = ['P', 'N', 'S', 'O', 'W', 'I', 'AD', 'TR']

/**
 * CMU has no official percent-to-letter conversion. This is the Eberly Center's sample scale,
 * which many syllabi use. Students can replace it per course.
 */
export const DEFAULT_SCHEME_UNDERGRAD: GradeCut[] = [
  { letter: 'A', min: 90 },
  { letter: 'B', min: 80 },
  { letter: 'C', min: 70 },
  { letter: 'D', min: 60 },
  { letter: 'R', min: 0 },
]

/**
 * Graduate default. CMU publishes no grad cutoffs either; this is a common 3-point-step +/- scale
 * (e.g. 15-112 gives grad students B+ for [87, 90)). No A+ because most courses never give it.
 */
export const DEFAULT_SCHEME_GRAD: GradeCut[] = [
  { letter: 'A', min: 93 },
  { letter: 'A-', min: 90 },
  { letter: 'B+', min: 87 },
  { letter: 'B', min: 83 },
  { letter: 'B-', min: 80 },
  { letter: 'C+', min: 77 },
  { letter: 'C', min: 73 },
  { letter: 'C-', min: 70 },
  { letter: 'D+', min: 67 },
  { letter: 'D', min: 60 },
  { letter: 'R', min: 0 },
]

/** The default scheme for a student level. */
export function defaultScheme(level: Level): GradeCut[] {
  return level === 'grad' ? DEFAULT_SCHEME_GRAD : DEFAULT_SCHEME_UNDERGRAD
}

/** One Dean's List rule: semester QPA of at least `qpa` on at least `minUnits` factorable units. */
export interface DeansListRule {
  qpa: number
  minUnits: number
  note: string // short human description of the rule
  alt?: { qpa: number; minUnits: number } // a second way to qualify (Dietrich, CMU-Q)
}

export interface College {
  key: string
  name: string // full name for the settings select
  short: string // short name for "Dean's List (SCS)"
  deansList: DeansListRule | null // null when the app cannot compute it
  note: string // shown when deansList is null, or extra detail
}

// Dean's List table from the 2026-27 catalog (research section E). All colleges also require
// no Incompletes that semester; the app sees those only in SIO (a final grade of I), and computeQpa checks for them.
export const COLLEGES: College[] = [
  {
    key: 'cit',
    name: 'College of Engineering (CIT)',
    short: 'CIT',
    deansList: { qpa: 3.75, minUnits: 36, note: "Dean's Honor List: 3.75+ on 36+ factorable units, no incompletes." },
    note: '',
  },
  {
    key: 'scs',
    name: 'School of Computer Science',
    short: 'SCS',
    deansList: { qpa: 3.75, minUnits: 36, note: "Dean's List with High Honors: 3.75+ on 36+ factorable units (fall and spring)." },
    note: '',
  },
  {
    key: 'tepper',
    name: 'Tepper School of Business',
    short: 'Tepper',
    deansList: { qpa: 3.75, minUnits: 36, note: '3.75+ on 36+ factorable units, no incompletes (fall and spring).' },
    note: '',
  },
  {
    key: 'mcs',
    name: 'Mellon College of Science',
    short: 'MCS',
    deansList: { qpa: 3.5, minUnits: 36, note: '3.50+ on 36+ factorable units. 3.75+ earns High Honors.' },
    note: '',
  },
  {
    key: 'dietrich',
    name: 'Dietrich College of Humanities and Social Sciences',
    short: 'Dietrich',
    // Dietrich: 45+ units at 3.50+ (Honors, High Honors at 3.75+), or 36-44 units at 3.75+ (Honors).
    deansList: {
      qpa: 3.5,
      minUnits: 45,
      alt: { qpa: 3.75, minUnits: 36 },
      note: '3.50+ on 45+ factorable units (3.75+ is High Honors), or 3.75+ on 36-44 units.',
    },
    note: "Dietrich leaves PE (69-xxx) and StuCo (98-xxx) out of the QPA.",
  },
  {
    key: 'bxa',
    name: 'BXA Intercollege Degree Programs',
    short: 'BXA',
    deansList: { qpa: 3.5, minUnits: 36, note: '3.50+ on 36+ letter-graded units, no incompletes.' },
    note: '',
  },
  {
    key: 'is',
    name: 'Information Systems',
    short: 'IS',
    // No IS rule was found in the catalog; IS sits in Dietrich, so we assume Dietrich's rule.
    deansList: {
      qpa: 3.5,
      minUnits: 45,
      alt: { qpa: 3.75, minUnits: 36 },
      note: "Assumed to follow Dietrich's rule: 3.50+ on 45+ units, or 3.75+ on 36-44 units.",
    },
    note: "Assumed to follow Dietrich's rules (no IS rule found).",
  },
  {
    key: 'cfa',
    name: 'College of Fine Arts',
    short: 'CFA',
    deansList: null,
    note: "CFA's Dean's List is the top 35% of each school, so it cannot be computed here.",
  },
  {
    key: 'cmuq',
    name: 'Carnegie Mellon Qatar',
    short: 'CMU-Q',
    deansList: {
      qpa: 3.75,
      minUnits: 36,
      alt: { qpa: 3.5, minUnits: 45 },
      note: '3.75+ on 36+ factorable units, or 3.50+ on 45+ units.',
    },
    note: '',
  },
  {
    key: 'heinz',
    name: 'Heinz College',
    short: 'Heinz',
    deansList: null,
    note: 'Heinz has no undergraduate Dean\'s List.',
  },
]

/** Find a college by key, or null. */
export function collegeByKey(key: string | null): College | null {
  if (!key) return null
  return COLLEGES.find(c => c.key === key) ?? null
}

/**
 * Clean up a letter: trim, uppercase, and turn the Unicode minus sign Canvas sometimes shows ("A−")
 * into a plain hyphen.
 */
export function normalizeLetter(letter: string): string {
  return letter.trim().toUpperCase().replace(/−/g, '-')
}

/** "A-" -> "A", "B+" -> "B". CMU undergrad final grades have no plus/minus. */
export function stripPlusMinus(letter: string): string {
  return normalizeLetter(letter).replace(/[+-]+$/, '')
}

/**
 * Graduate letters CMU doesn't give, mapped to the nearest CMU grade. Canvas schemes sometimes have a D-
 * (CMU's grad scale stops at D) or call the failing grade F (CMU says R).
 */
const GRAD_NEAREST: Record<string, string> = { 'D-': 'D', F: 'R' }

/**
 * The CMU final-grade version of a letter from a Canvas scheme or an override:
 *  - Undergrad: +/- is stripped ("A-" -> "A"), and F becomes R.
 *  - Grad: +/- is kept, D- becomes D, F becomes R.
 * Anything else (P, W, unknown letters) is returned cleaned up but otherwise unchanged.
 */
export function toCmuLetter(letter: string, level: Level): string {
  const clean = normalizeLetter(letter)
  if (level === 'undergrad') {
    const base = stripPlusMinus(clean)
    return base === 'F' ? 'R' : base
  }
  return GRAD_NEAREST[clean] ?? clean
}

/**
 * Quality points per unit for a letter, or null if the letter does not factor into QPA
 * (P, N, W, ...) or is not a CMU letter at all.
 *  - Undergrad: +/- is stripped ("A-" and "A+" count as A = 4.0, "B+" as B = 3.0). An undergrad's
 *    +/- grade in a graduate course is converted the same way (research section A).
 *  - F is treated as R (Canvas schemes say F; CMU's failing grade is R). Both are 0.
 *  - Grad: a D- (not on CMU's grad scale) counts as D.
 */
export function letterPoints(letter: string, level: Level): number | null {
  const raw = normalizeLetter(letter)
  if (raw === '' || NON_FACTORABLE.includes(raw)) return null
  const l = toCmuLetter(raw, level)
  const table = level === 'grad' ? GRAD_POINTS : UNDERGRAD_POINTS
  return Object.hasOwn(table, l) ? table[l] : null
}

/** "21241" -> "21-241" */
export function formatCourseNumber(n: string): string {
  return n.length === 5 ? `${n.slice(0, 2)}-${n.slice(2)}` : n
}
