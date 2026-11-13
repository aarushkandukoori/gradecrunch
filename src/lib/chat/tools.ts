// The tools the AI can ask for, run here in the browser (the server only describes them to OpenAI). Each one checks
// its arguments, changes the store only through the same helpers the class page and Settings use (updatePrefs,
// withWeight, withToggle, updateSettings), and returns a short text for the AI with the numbers recalculated
// (the class's percent and letter, the semester and cumulative QPA), so the AI reports real values.
//
// Every change comes with a receipt for the chat ("21-241 set to pass/fail. QPA 3.42 -> 3.71") and an undo patch:
// the values from before, for only the fields that change touched. Undo puts those back and nothing else, so a sync
// or another change made in between is kept.
//
// With SIO data the student's choice wins, the same as on the class page: set_pass_fail false counts an SIO
// pass/fail class for a letter, set_hidden false counts a class SIO doesn't list, set_units replaces SIO's units,
// and set_final_letter replaces a posted grade (and makes a class that only SIO knows count). The result then says
// what SIO shows, so the AI can tell the student.
import { normalizeName } from '../categorize'
import { COLLEGES, normalizeLetter, stripPlusMinus } from '../cmu'
import { parseCourseNumbers } from '../courseNumber'
import { formatGradePercent, formatPoints, formatQpa } from '../format'
import { gradeCourse, isCountable, neededForLetters } from '../grade'
import { rekeyPrefs } from '../merge'
import { computeQpa, letterWithBasis } from '../qpa'
import { levelFor } from '../sio'
import { randomId, updatePrefs, updateSettings, withToggle, withWeight } from '../store'
import { neededFor, neededLine, shownPercent, weightSum } from '../../ui/view'
import type { Category, Course, CoursePrefs, Item, Level, Settings, Store } from '../../types'
import { cleanName } from './context'
import { addNote, removeNote, type Note, type Receipt, type UndoPatch } from './memory'
import { LIMITS } from './protocol'
import { classLabel, gradeText, qpaText, snapshot, type Snapshot } from './snapshot'

/** What the tools read and change: the grades store and the AI advisor's saved notes. */
export interface ToolState {
  store: Store
  notes: Note[]
}

export interface ToolResult extends ToolState {
  output: string // for the AI: starts with "Done." when something changed, "Error:" when the call was refused
  receipt: Receipt | null // for the chat, when something changed
}

const UNDERGRAD_LETTERS = ['A', 'B', 'C', 'D', 'R']
const GRAD_LETTERS = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'R']
const OTHER_LETTERS = ['P', 'N', 'W'] // the same choices as the class page's "Final letter" box
const LEVELS: Record<string, Level> = { undergrad: 'undergrad', undergraduate: 'undergrad', grad: 'grad', graduate: 'grad' }
const MAX_LIST = 30 // weights or what-if scores in one call

/** Runs one tool call. Never throws: a bad call comes back as an "Error: ..." text the AI can fix. */
export function runTool(name: string, argsText: string, state: ToolState, now: Date): ToolResult {
  let args: unknown
  try {
    args = JSON.parse(argsText)
  } catch {
    return refuse(state, 'the arguments were not valid JSON.')
  }
  if (!isObject(args)) return refuse(state, 'the arguments must be a JSON object.')
  switch (name) {
    case 'set_category_weights':
      return setCategoryWeights(state, args)
    case 'set_pass_fail':
      return setToggle(state, args, 'passFail')
    case 'set_hidden':
      return setToggle(state, args, 'hidden')
    case 'set_units':
      return setUnits(state, args)
    case 'set_final_letter':
      return setFinalLetter(state, args)
    case 'set_profile':
      return setProfile(state, args)
    case 'what_if':
      return whatIf(state, args)
    case 'add_memory':
      return addMemory(state, args, now)
    case 'remove_memory':
      return removeMemory(state, args)
    default:
      return refuse(state, `there is no tool called "${cleanName(name)}".`)
  }
}

/** Puts back what one change touched (see UndoPatch). */
export function undoChange(state: ToolState, undo: UndoPatch): ToolState {
  let { store, notes } = state
  if (undo.courseKey && (undo.prefs || undo.weights)) {
    store = updatePrefs(store, undo.courseKey, (p) => restorePrefs(p, undo))
  }
  if (undo.settings) {
    const patch: Partial<Settings> = {}
    if (undo.settings.college !== undefined) patch.college = undo.settings.college
    if (undo.settings.level) patch.level = undo.settings.level
    store = updateSettings(store, patch)
  }
  if (undo.addedNoteId) notes = removeNote(notes, undo.addedNoteId)
  const removed = undo.removedNote
  if (removed && !notes.some((n) => n.id === removed.note.id) && notes.length < LIMITS.notes) {
    notes = [...notes.slice(0, removed.index), removed.note, ...notes.slice(removed.index)]
  }
  return { store, notes }
}

function restorePrefs(p: CoursePrefs, undo: UndoPatch): CoursePrefs {
  const out = { ...p }
  const before = undo.prefs ?? {}
  if ('passFail' in before) out.passFail = before.passFail ?? undefined
  if ('hidden' in before) out.hidden = before.hidden ?? undefined
  if ('units' in before) out.units = before.units ?? undefined
  if ('letter' in before) out.letter = before.letter ?? undefined
  if ('weighted' in before) out.weighted = before.weighted ?? undefined
  if (undo.weights) {
    const weights = { ...(out.weights ?? {}) }
    for (const [key, value] of Object.entries(undo.weights)) {
      if (value === null) delete weights[key]
      else weights[key] = value
    }
    out.weights = weights
  }
  return out
}

// ---------------------------------------------------------------- the tools that change a class

/** set_pass_fail and set_hidden: the class page's two checkboxes. */
function setToggle(state: ToolState, args: Record<string, unknown>, field: 'passFail' | 'hidden'): ToolResult {
  const snap = snapshot(state.store)
  const course = findCourse(snap, args.course)
  if (typeof course === 'string') return refuse(state, course)
  const on = field === 'passFail' ? args.on : args.hidden
  if (typeof on !== 'boolean') return refuse(state, `"${field === 'passFail' ? 'on' : 'hidden'}" must be true or false.`)
  const label = classLabel(course)
  if ((course.prefs[field] === true) === on) {
    const already = field === 'passFail' ? (on ? 'pass/fail' : 'for a letter grade') : on ? 'hidden' : 'shown'
    return unchanged(state, `${label} is already ${already}.`)
  }
  // What the class does when the student sets nothing (the same rule as the class page): SIO's "P" grade option
  // means pass/fail, and a class SIO doesn't list is hidden. Going against that is saved, so it wins over SIO.
  const auto = field === 'passFail' ? course.sio?.gradeOption === 'P' : course.sio?.registered === false
  const saved = state.store.prefs[course.key] ?? {}
  const store = changePrefs(state.store, course, (p) => withToggle(p, field, on, auto))
  const what =
    field === 'passFail' ? (on ? `${label} set to pass/fail` : `${label} back to a letter grade`) : on ? `${label} hidden` : `${label} shown again`
  const before = field === 'passFail' ? { passFail: saved.passFail ?? null } : { hidden: saved.hidden ?? null }
  let note = ''
  if (auto && !on) {
    note =
      field === 'passFail'
        ? ` SIO lists ${label} as pass/fail; this counts it for a letter grade in GradeCrunch's estimate instead.`
        : ` SIO doesn't list ${label} for ${course.term ?? 'its term'}; it now counts anyway.`
  }
  return applied(state, store, snap, course.key, what, { courseKey: course.key, prefs: before }, note)
}

function setUnits(state: ToolState, args: Record<string, unknown>): ToolResult {
  const snap = snapshot(state.store)
  const course = findCourse(snap, args.course)
  if (typeof course === 'string') return refuse(state, course)
  const units = args.units
  if (typeof units !== 'number' || !Number.isFinite(units) || units < 0 || units > 48) return refuse(state, '"units" must be a number from 0 to 48.')
  const label = classLabel(course)
  if (course.units === units) return unchanged(state, `${label} already has ${formatPoints(units)} units.`)
  const saved = state.store.prefs[course.key] ?? {}
  const store = changePrefs(state.store, course, (p) => ({ ...p, units }))
  // The student's units win over SIO's exact ones; say so, since SIO is the official record.
  const sioUnits = course.sio?.units ?? null
  const note = sioUnits !== null && sioUnits !== units ? ` SIO lists ${formatPoints(sioUnits)} units; this setting wins over it.` : ''
  return applied(
    state,
    store,
    snap,
    course.key,
    `${label} set to ${formatPoints(units)} units`,
    { courseKey: course.key, prefs: { units: saved.units ?? null } },
    note,
  )
}

function setFinalLetter(state: ToolState, args: Record<string, unknown>): ToolResult {
  const snap = snapshot(state.store)
  const course = findCourse(snap, args.course)
  if (typeof course === 'string') return refuse(state, course)
  const label = classLabel(course)
  const saved = state.store.prefs[course.key] ?? {}
  const undo: UndoPatch = { courseKey: course.key, prefs: { letter: saved.letter ?? null } }

  if (args.letter === null) {
    if (!course.prefs.letter) return unchanged(state, `${label} has no final letter set; it already uses the estimate.`)
    const store = changePrefs(state.store, course, (p) => ({ ...p, letter: undefined }))
    return applied(state, store, snap, course.key, `${label} final letter back to automatic`, undo)
  }
  if (typeof args.letter !== 'string') return refuse(state, '"letter" must be a letter like "A", or null.')
  // The scale of the record SIO puts the class's term in, else the Level setting (the same rule as the QPA).
  const level = levelFor(state.store.sio, course.term, state.store.settings.level)
  const letter = cmuLetter(args.letter, level)
  const allowed = [...(level === 'grad' ? GRAD_LETTERS : UNDERGRAD_LETTERS), ...OTHER_LETTERS]
  if (!allowed.includes(letter)) return refuse(state, `"${cleanName(args.letter)}" is not a final letter here. Use one of: ${allowed.join(', ')}.`)
  if (course.prefs.letter === letter) return unchanged(state, `${label} already has the final letter ${letter}.`)
  const store = changePrefs(state.store, course, (p) => ({ ...p, letter }))
  // The student's letter wins over a final grade posted in SIO; say so, since SIO is the official record.
  const posted = course.sio?.finalGrade
  const note = posted && posted !== letter ? ` SIO's posted final grade is ${posted}; this letter wins over it in GradeCrunch.` : ''
  return applied(state, store, snap, course.key, `${label} final letter set to ${letter}`, undo, note)
}

/** "a-" -> "A" for undergraduates (no plus or minus), "A-" for graduate students; F becomes R. */
function cmuLetter(raw: string, level: Level): string {
  const clean = normalizeLetter(raw)
  const letter = level === 'undergrad' && !OTHER_LETTERS.includes(clean) ? stripPlusMinus(clean) : clean
  return letter === 'F' ? 'R' : letter
}

function setCategoryWeights(state: ToolState, args: Record<string, unknown>): ToolResult {
  const snap = snapshot(state.store)
  const course = findCourse(snap, args.course)
  if (typeof course === 'string') return refuse(state, course)
  const label = classLabel(course)
  if (course.categories.length === 0) return refuse(state, `${label} has no grading categories yet, so it has no weights to set.`)
  const list = args.weights
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_LIST) return refuse(state, `"weights" must list 1 to ${MAX_LIST} categories.`)

  const chosen: { category: Category; weight: number }[] = []
  for (const entry of list) {
    if (!isObject(entry) || typeof entry.category !== 'string') return refuse(state, 'each weight needs a "category" (key or name).')
    const weight = entry.weight
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 100) {
      return refuse(state, `the weight for "${cleanName(entry.category)}" must be a percent from 0 to 100.`)
    }
    const category = findCategory(course, entry.category)
    if (typeof category === 'string') return refuse(state, category)
    if (chosen.some((c) => c.category.key === category.key)) return refuse(state, `${cleanName(category.name)} is listed twice.`)
    chosen.push({ category, weight })
  }

  const saved = state.store.prefs[course.key] ?? {}
  const weightsBefore: Record<string, number | null> = {}
  for (const { category } of chosen) weightsBefore[category.key] = saved.weights?.[category.key] ?? null
  const undo: UndoPatch = { courseKey: course.key, prefs: { weighted: saved.weighted ?? null }, weights: weightsBefore }
  const store = changePrefs(state.store, course, (p) => chosen.reduce((acc, c) => withWeight(acc, c.category.key, c.weight), p))

  const after = snapshot(store).courses.find((c) => c.key === course.key)
  const sum = after ? weightSum(after) : 100
  const note = Math.abs(sum - 100) > 0.01 ? ` Weights now add up to ${formatPoints(sum)}%.` : ''
  const set = chosen.map((c) => `${cleanName(c.category.name)} ${formatPoints(c.weight)}%`).join(', ')
  return applied(state, store, snap, course.key, `${label} weights set: ${set}`, undo, note, `${label} weights updated`)
}

// ---------------------------------------------------------------- settings

function setProfile(state: ToolState, args: Record<string, unknown>): ToolResult {
  const snap = snapshot(state.store)
  const settings = state.store.settings
  const patch: Partial<Settings> = {}
  const before: NonNullable<UndoPatch['settings']> = {}
  const said: string[] = []

  if (args.college !== null && args.college !== undefined) {
    if (typeof args.college !== 'string') return refuse(state, '"college" must be a college key, "none" or null.')
    const wanted = args.college.trim().toLowerCase()
    const college = COLLEGES.find((c) => c.key === wanted || c.short.toLowerCase() === wanted || c.name.toLowerCase() === wanted)
    if (wanted !== 'none' && !college) {
      return refuse(state, `unknown college "${cleanName(args.college)}". Use one of: ${COLLEGES.map((c) => `${c.key} (${c.short})`).join(', ')}, or "none".`)
    }
    const key = college ? college.key : null
    if (key !== settings.college) {
      patch.college = key
      before.college = settings.college
      said.push(college ? `College set to ${college.short}` : 'College cleared')
    }
  }
  if (args.level !== null && args.level !== undefined) {
    const level = typeof args.level === 'string' ? LEVELS[args.level.trim().toLowerCase()] : undefined
    if (!level) return refuse(state, '"level" must be "undergrad", "grad" or null.')
    if (level !== settings.level) {
      patch.level = level
      before.level = settings.level
      said.push(`Level set to ${level === 'grad' ? 'graduate' : 'undergraduate'}`)
    }
  }
  if (said.length === 0) return unchanged(state, 'those settings are already set that way.')

  const store = updateSettings(state.store, patch)
  const after = snapshot(store)
  const deans = after.qpa.deansList
  const onTrack = deans?.eligible ? 'on track' : 'not on track'
  let extra = patch.college !== undefined && deans ? ` Dean's List (${deans.college}): ${onTrack}. Rule: ${deans.note}` : ''
  // SIO's record wins for a term it lists, so the setting may not change the term on screen.
  if (patch.level && after.settings.level !== patch.level) {
    const record = after.settings.level === 'grad' ? 'graduate' : 'undergraduate'
    extra += ` SIO lists ${after.term ?? 'this term'} in the ${record} record, so that term keeps the ${record} scale.`
  }
  return applied(state, store, snap, null, said.join('. '), { settings: before }, extra)
}

// ---------------------------------------------------------------- what-if (changes nothing)

function whatIf(state: ToolState, args: Record<string, unknown>): ToolResult {
  const snap = snapshot(state.store)
  const course = findCourse(snap, args.course)
  if (typeof course === 'string') return refuse(state, course)
  const label = classLabel(course)
  const list = args.scores
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_LIST) return refuse(state, `"scores" must list 1 to ${MAX_LIST} scores.`)

  // A copy of the class with the made-up scores as what-ifs (in points), the same way the class page tries them.
  const whatIfs: Record<string, number> = { ...(course.prefs.whatIf ?? {}) }
  const overGraded = [...(course.prefs.whatIfGraded ?? [])] // what-ifs typed over a real score
  const items = [...course.items]
  const ignored = new Set(course.prefs.ignored ?? [])
  const tried: string[] = []
  const assumed: string[] = []
  for (const entry of list) {
    if (!isObject(entry) || typeof entry.target !== 'string') return refuse(state, 'each score needs a "target": an assignment or a category.')
    const pct = entry.percent
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 150) {
      return refuse(state, `the score for "${cleanName(entry.target)}" must be a percent from 0 to 150.`)
    }
    const target = findTarget(course, entry.target)
    if (typeof target === 'string') return refuse(state, target)
    if ('categoryKey' in target) {
      const item = target
      if (item.max === null || item.max <= 0) {
        return refuse(state, `the points for "${cleanName(item.name)}" aren't posted yet. Try its category instead.`)
      }
      whatIfs[item.key] = (pct / 100) * item.max
      if (item.score !== null && !overGraded.includes(item.key)) overGraded.push(item.key)
      tried.push(`${cleanName(item.name)} ${formatPoints(pct)}%`)
      continue
    }
    // A category: every assignment still to come in it gets that percent. With nothing posted yet (a final exam
    // that isn't on Canvas), stand in one 100-point assignment, like the "what do I need" math does.
    const category = target
    const open = items.filter((i) => i.categoryKey === category.key && i.score === null && isCountable(i, ignored) && (i.max ?? 0) > 0)
    if (open.length > 0) {
      for (const i of open) whatIfs[i.key] = (pct / 100) * (i.max ?? 0)
    } else {
      const key = `whatif:${category.key}`
      items.push(standIn(key, category))
      whatIfs[key] = pct
      assumed.push(cleanName(category.name))
    }
    tried.push(`rest of ${cleanName(category.name)} ${formatPoints(pct)}%`)
  }

  const tryCourse: Course = { ...course, items, prefs: { ...course.prefs, whatIf: whatIfs, whatIfGraded: overGraded } }
  const grade = gradeCourse(tryCourse, { whatIf: whatIfs })
  const grades = new Map(snap.grades)
  grades.set(course.key, grade)
  const inQpa = snap.main.some((c) => c.key === course.key)
  const main = snap.main.map((c) => (c.key === course.key ? tryCourse : c))
  const qpa = computeQpa(main, grades, snap.settings, { includeCumulative: snap.includeCumulative })
  const { letter, basis } = letterWithBasis(tryCourse, grade, snap.settings)
  const percent = shownPercent(tryCourse, grade)
  const wouldBe = [percent !== null ? formatGradePercent(percent) : 'no percent', letter ?? ''].join(' ').trim()

  const lines = [`Not saved (what-if only). Tried: ${tried.join(', ')}.`]
  if (assumed.length > 0) lines.push(`Assumed the rest of ${assumed.join(', ')} is one 100-point assignment.`)
  lines.push(`${label} would be ${wouldBe} (now ${gradeText(snap, course)}).`)
  if (course.prefs.passFail) lines.push(`${label} is pass/fail, so it isn't in the QPA.`)
  else if (basis === 'you' || basis === 'sio-final') {
    const from = basis === 'you' ? 'set by the student' : 'from SIO'
    lines.push(`The QPA uses ${label}'s final letter ${letter} (${from}), so these scores don't change it.`)
  }
  if (inQpa) {
    lines.push(`Semester QPA would be ${qpaText(qpa.semesterQpa)} (now ${qpaText(snap.qpa.semesterQpa)}).`)
    if (qpa.cumulativeQpa !== null) lines.push(`Cumulative QPA would be ${formatQpa(qpa.cumulativeQpa)} (now ${qpaText(snap.qpa.cumulativeQpa)}).`)
  } else {
    lines.push(`${label} isn't in the QPA for ${snap.term ?? 'this term'} (hidden or another term).`)
  }
  const needed = neededFor(tryCourse, (c) => neededForLetters(c, whatIfs), snap.settings.level)
  if (needed.length > 0) lines.push(`Needed on the rest after that: ${needed.map((n) => `${n.letter}: ${neededLine(n, percent)}`).join('; ')}.`)
  return { ...state, output: lines.join(' '), receipt: null }
}

/** A made-up 100-point assignment for the rest of a category, for what-ifs only (never saved). */
function standIn(key: string, category: Category): Item {
  return {
    key,
    name: `${category.name} (rest)`,
    categoryKey: category.key,
    score: null,
    max: 100,
    maxEstimated: false,
    status: 'unsubmitted',
    due: null,
    omit: false,
    url: null,
    source: 'manual',
    otherScore: null,
    planned: true,
  }
}

// ---------------------------------------------------------------- memory

function addMemory(state: ToolState, args: Record<string, unknown>, now: Date): ToolResult {
  if (typeof args.text !== 'string') return refuse(state, '"text" must be the note to save.')
  const added = addNote(state.notes, args.text, now)
  if ('error' in added) return refuse(state, added.error)
  const { note } = added
  return {
    store: state.store,
    notes: added.notes,
    output: `Done. Saved note ${note.id}: ${note.text}`,
    receipt: { id: randomId(), text: `Saved to memory: ${note.text}`, undo: { addedNoteId: note.id } },
  }
}

function removeMemory(state: ToolState, args: Record<string, unknown>): ToolResult {
  const index = state.notes.findIndex((n) => n.id === args.id)
  if (index === -1) {
    const ids = state.notes.map((n) => n.id).join(', ')
    return refuse(state, `no saved note has that id.${ids ? ` Saved note ids: ${ids}.` : ' There are no saved notes.'}`)
  }
  const note = state.notes[index]
  return {
    store: state.store,
    notes: removeNote(state.notes, note.id),
    output: `Done. Removed note ${note.id}: ${note.text}`,
    receipt: { id: randomId(), text: `Removed from memory: ${note.text}`, undo: { removedNote: { note, index } } },
  }
}

// ---------------------------------------------------------------- finding classes, categories and assignments

/** "21-241", "21241", a course key or an exact title -> the class, or an error that lists the classes. */
export function findCourse(snap: Snapshot, raw: unknown): Course | string {
  const here = [...snap.main, ...snap.other].filter((c) => c.academic) // the term on screen, hidden classes too
  const list = here.length > 0 ? `Classes: ${here.map((c) => `${classLabel(c)} (key ${c.key})`).join(', ')}.` : 'There are no classes yet.'
  if (typeof raw !== 'string' || raw.trim() === '') return `"course" must name a class. ${list}`
  const text = raw.trim()
  const byKey = snap.courses.find((c) => c.key === text)
  if (byKey) return byKey

  const academic = snap.courses.filter((c) => c.academic)
  const number = parseCourseNumbers(text).number
  let matches = number ? academic.filter((c) => c.number === number || c.alsoNumbers.includes(number)) : []
  if (matches.length === 0) matches = academic.filter((c) => c.title.toLowerCase() === text.toLowerCase())
  // The same class in two terms (a retake): the term on screen wins.
  const inTerm = matches.filter((c) => here.includes(c))
  const pick = inTerm.length > 0 ? inTerm : matches
  if (pick.length === 1) return pick[0]
  if (pick.length > 1) return `"${cleanName(text)}" matches more than one class: ${pick.map((c) => `${c.term ?? 'no term'} (key ${c.key})`).join(', ')}. Use the key.`
  return `there is no class "${cleanName(text)}". ${list}`
}

/** A category of the class by key or name, or an error that lists the categories. */
function findCategory(course: Course, raw: string): Category | string {
  const found = matchOne(course.categories, raw, (c) => c.name)
  if (found) return found
  return `${classLabel(course)} has no category "${cleanName(raw)}". Categories: ${course.categories.map((c) => `${cleanName(c.name)} (key ${c.key})`).join(', ')}.`
}

/** An assignment (by key or name) or a category (by key or name), or an error that lists what there is. */
function findTarget(course: Course, raw: string): Item | Category | string {
  const items = course.items.filter((i) => !i.omit)
  const exact = matchOne(items, raw, (i) => i.name, false) ?? matchOne(course.categories, raw, (c) => c.name, false)
  if (exact) return exact
  const loose = matchOne(items, raw, (i) => i.name) ?? matchOne(course.categories, raw, (c) => c.name)
  if (loose) return loose
  const open = items.filter((i) => i.score === null).map((i) => cleanName(i.name)).slice(0, 15)
  return (
    `${classLabel(course)} has no assignment or category "${cleanName(raw)}". ` +
    `Categories: ${course.categories.map((c) => `${cleanName(c.name)} (key ${c.key})`).join(', ') || 'none'}.` +
    (open.length > 0 ? ` Assignments still to come: ${open.join(', ')}.` : '')
  )
}

/**
 * The one entry whose key is `raw`, or whose name matches it (same letters and digits, ignoring case and spaces).
 * With `loose`, a name that contains it also counts, but only when exactly one name does.
 */
function matchOne<T extends { key: string }>(list: T[], raw: string, nameOf: (x: T) => string, loose = true): T | null {
  const byKey = list.find((x) => x.key === raw)
  if (byKey) return byKey
  const wanted = normalizeName(raw)
  if (!wanted) return null
  const same = list.filter((x) => normalizeName(nameOf(x)) === wanted)
  if (same.length === 1) return same[0]
  if (same.length > 1 || !loose) return null
  const containing = list.filter((x) => normalizeName(nameOf(x)).includes(wanted))
  return containing.length === 1 ? containing[0] : null
}

// ---------------------------------------------------------------- results

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** One class's prefs changed exactly like the class page does it (App.tsx changePrefs). */
function changePrefs(store: Store, course: Course, change: (p: CoursePrefs) => CoursePrefs): Store {
  return updatePrefs(store, course.key, change, rekeyPrefs(store.prefs[course.key] ?? {}, course.items))
}

function refuse(state: ToolState, why: string): ToolResult {
  return { ...state, output: `Error: ${why}`, receipt: null }
}

function unchanged(state: ToolState, why: string): ToolResult {
  return { ...state, output: `No change: ${why}`, receipt: null }
}

/**
 * A change went through: the text for the AI (with the numbers before and after) and the receipt for the chat.
 * `receiptWhat` is a shorter version of `what` for the receipt, when `what` is long.
 */
function applied(
  state: ToolState,
  store: Store,
  before: Snapshot,
  courseKey: string | null,
  what: string,
  undo: UndoPatch,
  extra = '',
  receiptWhat = what,
): ToolResult {
  const after = snapshot(store)
  const lines = [`Done. ${what}.`]
  const receipt = [receiptWhat]
  const b = courseKey ? before.courses.find((c) => c.key === courseKey) : undefined
  const a = courseKey ? after.courses.find((c) => c.key === courseKey) : undefined
  if (b && a) {
    const was = gradeText(before, b)
    const now = gradeText(after, a)
    lines.push(was === now ? `${classLabel(a)}: ${now}.` : `${classLabel(a)}: ${was} -> ${now}.`)
    if (was !== now) receipt.push(`${was} -> ${now}`)
  }
  const semester = [qpaText(before.qpa.semesterQpa), qpaText(after.qpa.semesterQpa)]
  lines.push(`Semester QPA${after.term ? ` (${after.term})` : ''}: ${semester[0] === semester[1] ? `stays ${semester[1]}` : `${semester[0]} -> ${semester[1]}`}.`)
  if (semester[0] !== semester[1]) receipt.push(`QPA ${semester[0]} -> ${semester[1]}`)
  if (before.qpa.cumulativeQpa !== null || after.qpa.cumulativeQpa !== null) {
    lines.push(`Cumulative QPA: ${qpaText(before.qpa.cumulativeQpa)} -> ${qpaText(after.qpa.cumulativeQpa)}.`)
  }
  if (a && !after.main.some((c) => c.key === a.key)) lines.push(`${classLabel(a)} is not in this QPA (hidden or another term).`)
  return {
    store,
    notes: state.notes,
    output: lines.join(' ') + extra,
    receipt: { id: randomId(), text: receipt.join('. '), undo },
  }
}
