// What the app does with SIO data (CMU's official record). Small pure helpers, so the rules are easy to find and test:
//   isFinished          a semester with every final grade posted
//   termInProgress      the semester in progress ("Fall 2026")
//   semestersFor        the SIO semesters behind one of the app's terms ("Fall 2026")
//   levelFor            which record (undergraduate or graduate) SIO puts a term in
//   priorFromSio        your record before a term: quality points and factorable units of every finished semester
//   officialCumulative  SIO's own cumulative QPA
//   withSioPrior        Settings for computeQpa for one term: SIO's record for it and "QPA before this semester"
//   finishedSemesters   the list for the Past semesters page
import type { Level, Settings, SioData, SioSemester } from '../types'
import { letterPoints } from './cmu'
import { canonicalTerm, termSortKey } from './courseNumber'

/**
 * True once every course of a semester has its final grade (W, I and AD count). One final grade is not enough: a mini
 * course, a withdrawal (W) or credit by exam (AD) shows a final grade while the rest of the semester is still going.
 */
export function isFinished(sem: { courses: { finalGrade: string | null }[] }): boolean {
  return sem.courses.length > 0 && sem.courses.every((c) => c.finalGrade !== null)
}

/** The sort key of the newest finished semester, in any record; -1 when none is finished. */
function newestFinishedKey(sio: SioData): number {
  return Math.max(-1, ...sio.semesters.filter(isFinished).map((s) => termSortKey(s.term)))
}

/**
 * A semester whose grades are done: every final grade is posted, or a newer semester is already finished (so a grade
 * that was never posted can't keep an old semester open).
 */
function isDone(sem: SioSemester, newestFinished: number): boolean {
  const key = termSortKey(sem.term)
  return sem.courses.length > 0 && key > 0 && (isFinished(sem) || key < newestFinished)
}

/**
 * The semester in progress: the oldest semester that is not done yet (see isDone). So a final grade posted early (a
 * mini course, a W) doesn't end a semester, an old semester with one grade never posted can't be taken for it, and
 * next semester, which shows up once you register, is newer. Both records count: the semester in progress is a date,
 * not a record. null when every semester is done.
 */
export function termInProgress(sio: SioData | undefined): string | null {
  if (!sio || !Array.isArray(sio.semesters)) return null
  const newest = newestFinishedKey(sio)
  const open = sio.semesters
    .filter((s) => s.courses.length > 0 && termSortKey(s.term) > 0 && !isDone(s, newest))
    .sort((a, b) => termSortKey(a.term) - termSortKey(b.term))
  return open.length > 0 ? canonicalTerm(open[0].term) : null
}

/**
 * The SIO semesters behind one of the app's terms. Summer One and Summer Two both count as "Summer 2026", the same
 * way the app names Canvas terms. In the rare term that has both records, the one matching `level` is used.
 */
export function semestersFor(sio: SioData | undefined, term: string | null, level: Level): SioSemester[] {
  if (!sio || !term || !Array.isArray(sio.semesters)) return []
  const all = sio.semesters.filter((s) => s && canonicalTerm(s.term) === term)
  const mine = all.filter((s) => s.level === level)
  return mine.length > 0 ? mine : all
}

/**
 * The record a term is in, undergraduate or graduate. SIO says which one, so a term SIO lists in one record uses that
 * record's grade scale, Dean's List rule and cumulative, whatever the Level setting says (a master's student who never
 * changed it still gets the 4.33 scale). A term SIO doesn't list, or lists in both records, follows the setting.
 */
export function levelFor(sio: SioData | undefined, term: string | null, level: Level): Level {
  const levels = new Set(semestersFor(sio, term, level).map((s) => s.level))
  return levels.size === 1 ? [...levels][0] : level
}

/**
 * Which record to read cumulative numbers from: your level if SIO has it, else the only record SIO has (so a grad
 * student who never changed the Level setting still gets their numbers). null when SIO has no semesters.
 */
function recordLevel(sio: SioData, level: Level): Level | null {
  const levels = new Set(sio.semesters.map((s) => s.level))
  if (levels.has(level)) return level
  return levels.size === 1 ? [...levels][0] : null
}

/** Quality points and factorable units of one semester: SIO's own numbers, or added up from its final grades. */
export function semesterTotals(sem: SioSemester): { qualityPoints: number; units: number } {
  const { qualityPoints, factorableUnits } = sem.qpa
  if (qualityPoints !== null && factorableUnits !== null) return { qualityPoints, units: factorableUnits }
  let points = 0
  let units = 0
  for (const c of sem.courses) {
    const perUnit = c.finalGrade && c.gradeOption !== 'P' ? letterPoints(c.finalGrade, sem.level) : null
    if (perUnit === null || c.units === null) continue // P, W, I ... and pass/fail classes don't count
    points += perUnit * c.units
    units += c.units
  }
  return { qualityPoints: points, units }
}

/**
 * Your record before `term`: every finished SIO semester that comes before it, in one record (undergrad and grad
 * records have separate cumulatives). The semester in progress isn't done, so it is never counted, and AP credit is
 * not a semester here. Returns the QPA and factorable units, or null when there is nothing to add up, or when the last
 * sync couldn't read a semester we have no copy of (`unread`): a record with a hole would give a wrong cumulative.
 */
export function priorFromSio(sio: SioData | undefined, term: string | null, level: Level): { qpa: number; units: number } | null {
  if (!sio || !Array.isArray(sio.semesters) || (sio.unread?.length ?? 0) > 0) return null
  const record = recordLevel(sio, level)
  const newest = newestFinishedKey(sio)
  const before = term === null ? Infinity : termSortKey(term)
  let points = 0
  let units = 0
  for (const sem of sio.semesters) {
    if (sem.level !== record || !isDone(sem, newest) || termSortKey(sem.term) >= before) continue
    const totals = semesterTotals(sem)
    points += totals.qualityPoints
    units += totals.units
  }
  return units > 0 ? { qpa: points / units, units } : null
}

/** SIO's own cumulative QPA (through the last finished semester), from the newest semester that shows one. */
export function officialCumulative(sio: SioData | undefined, level: Level): number | null {
  if (!sio) return null
  const record = recordLevel(sio, level)
  const newest = sio.semesters
    .filter((s) => s.level === record && s.qpa.cumulativeQpa !== null)
    .sort((a, b) => termSortKey(b.term) - termSortKey(a.term))[0]
  return newest ? newest.qpa.cumulativeQpa : null
}

/**
 * Settings for computeQpa for one term, with what SIO knows filled in:
 *  - the level of the record SIO puts the term in (levelFor), so the grade scale and Dean's List match SIO,
 *  - "QPA before this semester" from that record, unless you typed both numbers in Settings (yours always win).
 * `fromSio` says whether the QPA before this semester came from SIO. SIO's numbers only count semesters before
 * `term`, so unlike typed ones they are right for any term, not just the newest.
 */
export function withSioPrior(
  settings: Settings,
  sio: SioData | undefined,
  term: string | null,
): { settings: Settings; fromSio: boolean } {
  const level = levelFor(sio, term, settings.level)
  const base = level === settings.level ? settings : { ...settings, level }
  const typed = settings.priorQpa !== null && settings.priorUnits !== null
  const prior = typed ? null : priorFromSio(sio, term, level)
  if (!prior) return { settings: base, fromSio: false }
  return { settings: { ...base, priorQpa: prior.qpa, priorUnits: prior.units }, fromSio: true }
}

/** Finished semesters (see isDone), newest first (Summer Two before Summer One). */
export function finishedSemesters(sio: SioData | undefined): SioSemester[] {
  if (!sio || !Array.isArray(sio.semesters)) return []
  const newest = newestFinishedKey(sio)
  return sio.semesters
    .filter((s) => isDone(s, newest))
    .sort((a, b) => termSortKey(b.term) - termSortKey(a.term) || b.code.localeCompare(a.code))
}
