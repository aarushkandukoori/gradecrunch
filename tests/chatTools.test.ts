// Tests for the AI advisor chat's tools (src/lib/chat/tools.ts) on a real store built from the made-up demo data:
// pass/fail and hiding change the QPA, weights change the percent, every change reports real numbers, Undo puts
// back only what that change touched, and bad calls are refused without changing anything.
import { describe, expect, test } from 'vitest'
import { demoPayloads } from '../src/lib/demo'
import { applyPayload, defaultStore, updatePrefs } from '../src/lib/store'
import { runTool, undoChange, type ToolState } from '../src/lib/chat/tools'
import { snapshot } from '../src/lib/chat/snapshot'
import type { Note } from '../src/lib/chat/memory'
import type { SioCourse, SioSemester, Store, SyncPayload } from '../src/types'

const NOW = new Date(2026, 10, 13, 12)

/** The demo grades as if they had been synced for real (not the "See a demo" mode, which a sync would replace). */
function demoStore(): Store {
  let store = defaultStore()
  for (const payload of demoPayloads()) store = applyPayload(store, payload)
  return store
}

function state(store = demoStore(), notes: Note[] = []): ToolState {
  return { store, notes }
}

function run(s: ToolState, name: string, args: unknown) {
  return runTool(name, JSON.stringify(args), s, NOW)
}

function course(store: Store, key: string) {
  const c = snapshot(store).courses.find((x) => x.key === key)
  if (!c) throw new Error(`no course ${key}`)
  return c
}

const STATS = 'Fall 2026|36200'
const CONCEPTS = 'Fall 2026|21127'
const PIC = 'Fall 2026|15122'

describe('pass/fail and hiding', () => {
  test('pass/fail takes the class out of the QPA, and the result says the new numbers', () => {
    const s = state()
    expect(snapshot(s.store).qpa.semesterQpa).toBe(3) // B, A, C, B at 9 units each (no course catalog in tests)
    const r = run(s, 'set_pass_fail', { course: '36-200', on: true })
    expect(r.output).toMatch(/^Done\. 36-200 set to pass\/fail\./)
    expect(r.output).toContain('Semester QPA (Fall 2026): 3.00 -> 3.33')
    expect(r.receipt?.text).toBe('36-200 set to pass/fail. QPA 3.00 -> 3.33')
    expect(r.store.prefs[STATS]).toEqual({ passFail: true })
    expect(snapshot(r.store).qpa.semesterQpa).toBeCloseTo(10 / 3, 6)
    expect(r.store).not.toBe(s.store) // a new store; the old one is untouched
    expect(s.store.prefs[STATS]).toBeUndefined()
  })

  test('hiding a class leaves it out of the QPA too, and showing it again brings it back', () => {
    const hidden = run(state(), 'set_hidden', { course: STATS, hidden: true })
    expect(hidden.receipt?.text).toBe('36-200 hidden. QPA 3.00 -> 3.33')
    const shown = run(hidden, 'set_hidden', { course: STATS, hidden: false })
    expect(shown.receipt?.text).toBe('36-200 shown again. QPA 3.33 -> 3.00')
    expect(shown.store.prefs[STATS]).toBeUndefined() // back to no setting at all
  })

  test('asking for what is already so changes nothing', () => {
    const s = state()
    const r = run(s, 'set_pass_fail', { course: '36-200', on: false })
    expect(r.output).toMatch(/^No change/)
    expect(r.receipt).toBeNull()
    expect(r.store).toBe(s.store)
  })

  test('a class can be named "21-127", "21127", by its key or by its title', () => {
    for (const name of ['21-127', '21127', CONCEPTS, 'concepts of mathematics']) {
      const r = run(state(), 'set_pass_fail', { course: name, on: true })
      expect(r.output, name).toMatch(/^Done\. 21-127 set to pass\/fail/)
    }
  })
})

describe('weights', () => {
  test('weights change the class percent (total points becomes weighted)', () => {
    const s = state()
    expect(course(s.store, CONCEPTS).weighted).toBe(false)
    const r = run(s, 'set_category_weights', { course: '21-127', weights: [{ category: 'Homework', weight: 40 }, { category: 'g:Exams', weight: 60 }] })
    expect(r.output).toMatch(/^Done\. 21-127 weights set: Homework 40%, Exams 60%\./)
    expect(r.output).toContain('21-127: 90.57% A -> 89.44% B')
    expect(r.receipt?.text).toBe('21-127 weights updated. 90.57% A -> 89.44% B. QPA 3.00 -> 2.75')
    expect(r.store.prefs[CONCEPTS]).toEqual({ weights: { 'g:Homework': 40, 'g:Exams': 60 }, weighted: true })
    const after = course(r.store, CONCEPTS)
    expect(after.weighted).toBe(true)
    expect(snapshot(r.store).grades.get(CONCEPTS)?.percent).toBeCloseTo(0.4 * 91.6 + 0.6 * 88, 6)
  })

  test('says when the weights no longer add up to 100', () => {
    const r = run(state(), 'set_category_weights', { course: '15-122', weights: [{ category: 'Final Exam', weight: 35 }] })
    expect(r.output).toContain('Weights now add up to 110%.')
  })

  test.each([
    ['a weight over 100', [{ category: 'Homework', weight: 120 }], /percent from 0 to 100/],
    ['an unknown category', [{ category: 'Quizzes', weight: 10 }], /no category "Quizzes". Categories: Homework \(key g:Homework\), Exams \(key g:Exams\)/],
    ['the same category twice', [{ category: 'Homework', weight: 40 }, { category: 'homework', weight: 50 }], /listed twice/],
    ['no weights', [], /1 to 30/],
    ['a weight as text', [{ category: 'Homework', weight: '40' }], /percent from 0 to 100/],
  ])('refuses %s', (_name, weights, message) => {
    const s = state()
    const r = run(s, 'set_category_weights', { course: '21127', weights })
    expect(r.output).toMatch(/^Error: /)
    expect(r.output).toMatch(message)
    expect(r.store).toBe(s.store)
    expect(r.receipt).toBeNull()
  })
})

describe('units, final letter, profile', () => {
  test('units change the QPA weighting', () => {
    const r = run(state(), 'set_units', { course: '36-200', units: 12 })
    expect(r.receipt?.text).toBe('36-200 set to 12 units. QPA 3.00 -> 2.92') // (27 + 27 + 24 + 36) / 39
    expect(r.store.prefs[STATS]).toEqual({ units: 12 })
  })

  test('final letters follow the level: no plus or minus for undergrads, F means R', () => {
    const a = run(state(), 'set_final_letter', { course: '36-200', letter: 'a-' })
    expect(a.store.prefs[STATS]).toEqual({ letter: 'A' })
    expect(a.receipt?.text).toBe('36-200 final letter set to A. 78.81% C -> 78.81% A. QPA 3.00 -> 3.50')
    expect(run(state(), 'set_final_letter', { course: '36-200', letter: 'F' }).store.prefs[STATS]).toEqual({ letter: 'R' })
    expect(run(state(), 'set_final_letter', { course: '36-200', letter: 'P' }).store.prefs[STATS]).toEqual({ letter: 'P' })
    const grad = state({ ...demoStore(), settings: { ...defaultStore().settings, level: 'grad' } })
    expect(run(grad, 'set_final_letter', { course: '36-200', letter: 'A-' }).store.prefs[STATS]).toEqual({ letter: 'A-' })
    const back = run(a, 'set_final_letter', { course: '36-200', letter: null })
    expect(back.store.prefs[STATS]).toBeUndefined()
    expect(back.receipt?.text).toBe('36-200 final letter back to automatic. 78.81% A -> 78.81% C. QPA 3.50 -> 3.00')
  })

  test('college and level', () => {
    const r = run(state(), 'set_profile', { college: 'SCS', level: null })
    expect(r.store.settings.college).toBe('scs')
    expect(r.output).toContain("Dean's List (SCS): not on track")
    expect(r.receipt?.text).toBe('College set to SCS')
    const grad = run(r, 'set_profile', { college: null, level: 'grad' })
    expect(grad.store.settings.level).toBe('grad')
    expect(run(grad, 'set_profile', { college: 'none', level: 'grad' }).store.settings.college).toBeNull()
  })

  test.each([
    ['set_units', { course: '36-200', units: 60 }, /0 to 48/],
    ['set_units', { course: '36-200', units: '9' }, /0 to 48/],
    ['set_final_letter', { course: '36-200', letter: 'Z' }, /Use one of: A, B, C, D, R, P, N, W/],
    ['set_pass_fail', { course: '36-200', on: 'yes' }, /true or false/],
    ['set_pass_fail', { course: '99-999', on: true }, /no class "99-999". Classes: 15-122 \(key Fall 2026\|15122\), 21-127/],
    ['set_pass_fail', { on: true }, /must name a class/],
    ['set_profile', { college: 'mit', level: null }, /unknown college "mit". Use one of: cit \(CIT\)/],
    ['set_profile', { college: null, level: 'phd' }, /"level"/],
    ['delete_everything', {}, /no tool called "delete_everything"/],
  ])('%s refuses %j', (name, args, message) => {
    const s = state()
    const r = run(s, name, args)
    expect(r.output).toMatch(/^Error: /)
    expect(r.output).toMatch(message)
    expect(r.store).toBe(s.store)
  })

  test('broken arguments are refused', () => {
    const s = state()
    expect(runTool('set_units', '{"course": "36-200", ', s, NOW).output).toBe('Error: the arguments were not valid JSON.')
    expect(runTool('set_units', '[1, 2]', s, NOW).output).toBe('Error: the arguments must be a JSON object.')
  })
})

describe('what-if', () => {
  test('saves nothing and reports the class and the QPA with those scores', () => {
    const s = state()
    const r = run(s, 'what_if', { course: '36-200', scores: [{ target: 'Final Exam', percent: 90 }, { target: 'Exam 2', percent: 85 }] })
    expect(r.store).toBe(s.store)
    expect(r.receipt).toBeNull()
    expect(r.output).toMatch(/^Not saved \(what-if only\)\. Tried: Final Exam 90%, Exam 2 85%\./)
    expect(r.output).toContain('36-200 would be 83.88% B (now 78.81% C).')
    expect(r.output).toContain('Semester QPA would be 3.25 (now 3.00).')
    expect(r.output).toContain('Needed on the rest after that: A: Out of reach')
  })

  test('a category with nothing posted yet stands in a 100-point assignment', () => {
    const r = run(state(), 'what_if', { course: '15-122', scores: [{ target: 'final exam', percent: 85 }] })
    expect(r.output).toContain('Tried: rest of Final Exam 85%.')
    expect(r.output).toContain('Assumed the rest of Final Exam is one 100-point assignment.')
    expect(r.output).toContain('15-122 would be 88.05% B (now 89.07% B).')
  })

  test('a score typed over a real one counts, and a pass/fail class says its QPA does not change', () => {
    const pf = run(state(), 'set_pass_fail', { course: '36-200', on: true })
    const r = run(pf, 'what_if', { course: '36-200', scores: [{ target: 'Exam 1', percent: 100 }] })
    expect(r.output).toContain('36-200 would be 93.44% A') // Exam 1 74 -> 100; only graded work counts: (17 + 12.75 + 45) / 80
    expect(r.output).toContain("36-200 is pass/fail, so it isn't in the QPA.")
  })

  test('an unknown target lists the categories and the work still to come', () => {
    const r = run(state(), 'what_if', { course: '36-200', scores: [{ target: 'Quiz 9', percent: 90 }] })
    expect(r.output).toMatch(/^Error: 36-200 has no assignment or category "Quiz 9"\. Categories: Homework/)
    expect(r.output).toContain('Assignments still to come: HW 6, Exam 2, Final Exam.')
  })
})

describe('undo', () => {
  test('puts back only what that change touched: later changes and a sync in between stay', () => {
    const passFail = run(state(), 'set_pass_fail', { course: '36-200', on: true })
    const units = run(passFail, 'set_units', { course: '15-122', units: 12 })
    // A sync lands: 36-200's Exam 2 gets a score.
    const canvas = demoPayloads()[0] as SyncPayload
    const stats = canvas.courses.find((c) => c.number === '36200')!
    stats.items = stats.items.map((i) => (i.name === 'Exam 2' ? { ...i, score: 88, status: 'graded' } : i))
    const synced = applyPayload(units.store, canvas)

    const after = undoChange({ store: synced, notes: [] }, passFail.receipt!.undo)
    expect(after.store.prefs[STATS]).toBeUndefined() // pass/fail undone
    expect(after.store.prefs[PIC]).toEqual({ units: 12 }) // the later change stays
    expect(course(after.store, STATS).items.find((i) => i.name === 'Exam 2')?.score).toBe(88) // the sync stays
  })

  test('weights: puts back the student own weights and the weighted switch as they were', () => {
    const mine = updatePrefs(demoStore(), CONCEPTS, () => ({ weights: { 'g:Homework': 50 }, weighted: true }))
    const r = run(state(mine), 'set_category_weights', { course: '21127', weights: [{ category: 'Homework', weight: 40 }, { category: 'Exams', weight: 60 }] })
    expect(r.store.prefs[CONCEPTS]).toEqual({ weights: { 'g:Homework': 40, 'g:Exams': 60 }, weighted: true })
    const back = undoChange(r, r.receipt!.undo)
    expect(back.store.prefs[CONCEPTS]).toEqual({ weights: { 'g:Homework': 50 }, weighted: true })

    const fresh = run(state(), 'set_category_weights', { course: '21127', weights: [{ category: 'Homework', weight: 40 }] })
    expect(undoChange(fresh, fresh.receipt!.undo).store.prefs[CONCEPTS]).toBeUndefined()
    expect(course(undoChange(fresh, fresh.receipt!.undo).store, CONCEPTS).weighted).toBe(false)
  })

  test('settings: puts back the old college and level', () => {
    const r = run(state(), 'set_profile', { college: 'cit', level: 'grad' })
    const back = undoChange(r, r.receipt!.undo)
    expect(back.store.settings).toEqual(defaultStore().settings)
  })
})

describe('memory', () => {
  test('add, refuse a duplicate, remove, and undo both', () => {
    const added = run(state(), 'add_memory', { text: '  Taking 36-200   pass/fail ' })
    expect(added.notes.map((n) => n.text)).toEqual(['Taking 36-200 pass/fail'])
    const id = added.notes[0].id
    expect(added.output).toBe(`Done. Saved note ${id}: Taking 36-200 pass/fail`)
    expect(added.receipt?.text).toBe('Saved to memory: Taking 36-200 pass/fail')
    expect(run(added, 'add_memory', { text: 'taking 36-200 PASS/FAIL' }).output).toBe('Error: That note is already saved.')

    const second = run(added, 'add_memory', { text: 'Wants an A in 15-122' })
    const removed = run(second, 'remove_memory', { id })
    expect(removed.notes.map((n) => n.text)).toEqual(['Wants an A in 15-122'])
    expect(removed.receipt?.text).toBe('Removed from memory: Taking 36-200 pass/fail')
    expect(undoChange(removed, removed.receipt!.undo).notes.map((n) => n.text)).toEqual(['Taking 36-200 pass/fail', 'Wants an A in 15-122'])
    expect(undoChange(added, added.receipt!.undo).notes).toEqual([])
    expect(run(second, 'remove_memory', { id: 'nope' }).output).toMatch(/^Error: no saved note has that id\. Saved note ids: /)
  })

  test('refuses a note that is too long', () => {
    expect(run(state(), 'add_memory', { text: 'x'.repeat(301) }).output).toBe('Error: Notes can be at most 300 characters.')
  })
})

describe('with SIO data', () => {
  function sioCourse(number: string, extra: Partial<SioCourse> = {}): SioCourse {
    return { title: `Made-up ${number}`, number, alsoNumbers: [], section: 'A', gradeOption: 'L', units: 9, midGrade: null, finalGrade: null, ...extra }
  }
  function withSio(extra: SioCourse[] = []): Store {
    const fall: SioSemester = {
      code: 'F26',
      term: 'Fall 2026',
      level: 'undergrad',
      // 36-200 isn't listed (so it's hidden), and 21-127 is taken pass/fail.
      courses: [sioCourse('15122', { units: 12 }), sioCourse('21127', { gradeOption: 'P', units: 10 }), sioCourse('76101'), ...extra],
      qpa: { midSemQpa: null, unitsCarried: null, unitsPassed: null, factorableUnits: null, qualityPoints: null, finalQpa: null, cumulativeQpa: null },
    }
    return { ...demoStore(), sio: { semesters: [fall], syncedAt: '2026-11-12T10:00:00Z' } }
  }

  test('a class SIO does not list can be counted anyway, and SIO pass/fail can be turned off', () => {
    const s = state(withSio())
    expect(course(s.store, STATS).prefs.hidden).toBe(true)
    const shown = run(s, 'set_hidden', { course: '36-200', hidden: false })
    expect(shown.store.prefs[STATS]).toEqual({ hidden: false }) // saved as false so it wins over SIO
    expect(snapshot(shown.store).main.some((c) => c.key === STATS)).toBe(true)
    expect(shown.output).toContain("SIO doesn't list 36-200 for Fall 2026; it now counts anyway.")
    expect(undoChange(shown, shown.receipt!.undo).store.prefs[STATS]).toBeUndefined()

    const letter = run(s, 'set_pass_fail', { course: '21-127', on: false })
    expect(letter.store.prefs[CONCEPTS]).toEqual({ passFail: false })
    expect(letter.output).toContain('21-127 back to a letter grade')
    expect(letter.output).toContain('SIO lists 21-127 as pass/fail; this counts it for a letter grade')
    expect(snapshot(letter.store).qpa.rows.find((r) => r.courseKey === CONCEPTS)?.factorable).toBe(true) // back in the QPA
  })

  test('units the student sets win over SIO units, and Undo goes back to SIO', () => {
    const s = state(withSio())
    expect(course(s.store, PIC).units).toBe(12)
    expect(course(s.store, PIC).unitsSource).toBe('sio')
    const r = run(s, 'set_units', { course: '15-122', units: 10 })
    expect(r.output).toMatch(/^Done\. 15-122 set to 10 units\./)
    expect(r.output).toContain('SIO lists 12 units; this setting wins over it.')
    expect(course(r.store, PIC).units).toBe(10)
    expect(course(r.store, PIC).unitsSource).toBe('custom')
    const undone = undoChange(r, r.receipt!.undo)
    expect(course(undone.store, PIC).units).toBe(12)
    expect(course(undone.store, PIC).unitsSource).toBe('sio')
  })

  test('a final letter makes a class that only SIO knows count toward the QPA', () => {
    const SEMINAR = 'Fall 2026|07128'
    const s = state(withSio([sioCourse('07128', { units: 3 })]))
    const before = snapshot(s.store)
    expect(before.qpa.rows.find((r) => r.courseKey === SEMINAR)).toMatchObject({ factorable: false, reason: 'No grade yet', units: 3 })
    const r = run(s, 'set_final_letter', { course: '07-128', letter: 'A' })
    expect(r.output).toMatch(/^Done\. 07-128 final letter set to A\./)
    const after = snapshot(r.store)
    expect(after.qpa.rows.find((r) => r.courseKey === SEMINAR)).toMatchObject({ factorable: true, letter: 'A', points: 4, units: 3 })
    expect(after.qpa.factorableUnits).toBe(before.qpa.factorableUnits + 3)
    expect(r.store.prefs[SEMINAR]).toEqual({ letter: 'A' })
  })

  test('a final letter over a grade posted in SIO says what SIO shows', () => {
    const fall = withSio()
    const posted: Store = {
      ...fall,
      sio: { ...fall.sio!, semesters: [{ ...fall.sio!.semesters[0], courses: [sioCourse('15122', { units: 12, finalGrade: 'B' })] }] },
    }
    const r = run(state(posted), 'set_final_letter', { course: '15-122', letter: 'A' })
    expect(r.output).toContain("SIO's posted final grade is B; this letter wins over it in GradeCrunch.")
    expect(snapshot(r.store).qpa.rows.find((x) => x.courseKey === PIC)).toMatchObject({ letter: 'A', basis: 'you' })
  })
})
