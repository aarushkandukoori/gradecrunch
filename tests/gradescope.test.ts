// Tests for the Gradescope HTML parsers and sync, using synthetic fixtures in tests/fixtures.
import { describe, expect, test, vi } from 'vitest'

// The course-number parser belongs to the merge module. Mock it with a tiny version so these tests
// only check Gradescope logic (and don't break while that module is being written).
vi.mock('../src/lib/courseNumber', () => ({
  parseCourseNumbers: (...texts: (string | null | undefined)[]) => {
    const found: string[] = []
    for (const t of texts) {
      for (const m of (t ?? '').matchAll(/(?<!\d)(\d{2})-?(\d{3})(?!\d)/g)) {
        const n = m[1] + m[2]
        if (!found.includes(n)) found.push(n)
      }
    }
    return { number: found[0] ?? null, also: found.slice(1) }
  },
}))

import { hasCourseList, isCoursePage, parseCourseList, parseCoursePage, parseGsDate, syncGradescope } from '../src/sync/gradescope'

// Vite's ?raw suffix imports a file as a string (works in vitest without Node type definitions).
import HOME from './fixtures/gradescope-home.html?raw'
import HOME_TA from './fixtures/gradescope-home-instructor.html?raw'
import COURSE from './fixtures/gradescope-course.html?raw'

describe('parseGsDate', () => {
  test('converts Gradescope datetime to ISO with offset', () => {
    expect(parseGsDate('2026-09-11 23:59:00 -0400')).toBe('2026-09-11T23:59:00-04:00')
    expect(parseGsDate('2026-11-06 23:59:00 -0500')).toBe('2026-11-06T23:59:00-05:00')
    expect(parseGsDate('2026-03-01 08:00:00 +0530')).toBe('2026-03-01T08:00:00+05:30')
  })
  test('accepts small variations', () => {
    expect(parseGsDate('  2026-09-11 23:59 -04:00 ')).toBe('2026-09-11T23:59:00-04:00')
    expect(parseGsDate('2026-09-11T23:59:00Z')).toBe('2026-09-11T23:59:00+00:00')
    expect(parseGsDate('2026-09-11 23:59:00 UTC')).toBe('2026-09-11T23:59:00+00:00')
  })
  test('returns null on bad input', () => {
    expect(parseGsDate(null)).toBeNull()
    expect(parseGsDate(undefined)).toBeNull()
    expect(parseGsDate('')).toBeNull()
    expect(parseGsDate('Sep 11 at 11:59PM')).toBeNull()
    expect(parseGsDate('2026-13-01 10:00:00 -0400')).toBeNull()
    expect(parseGsDate('2026-02-31 10:00:00 -0400')).toBeNull()
    expect(parseGsDate('2026-09-11 25:00:00 -0400')).toBeNull()
    expect(parseGsDate('2026-09-11 23:59:00')).toBeNull() // no offset: ambiguous
  })
})

describe('parseCourseList', () => {
  test('lists active student courses with terms, skipping inactive and non-course tiles', () => {
    const list = parseCourseList(HOME)
    expect(list.map((c) => c.id)).toEqual(['1000001', '1000002', '1000003', '900004', '900005'])
    expect(list[0]).toEqual({
      id: '1000001',
      shortName: '21241',
      name: 'Matrices and Linear Transformations',
      term: 'Fall 2026',
      url: 'https://www.gradescope.com/courses/1000001',
    })
    expect(list[2].name).toBe('Art & Science of ML') // HTML entities decoded
    expect(list[3].term).toBe('Spring 2026')
  })
  test('falls back to the short name when the course name is missing', () => {
    const c = parseCourseList(HOME).find((x) => x.id === '900005')!
    expect(c.name).toBe('21259-1')
    expect(c.shortName).toBe('21259-1')
  })
  test('skips the Instructor Courses list', () => {
    const list = parseCourseList(HOME_TA)
    expect(list.map((c) => c.id)).toEqual(['1000002', '1000007'])
    expect(list.every((c) => c.term === 'Fall 2026')).toBe(true)
  })
  test('never throws on odd or empty markup', () => {
    expect(parseCourseList('')).toEqual([])
    expect(parseCourseList('<div class="courseList"></div>')).toEqual([])
    // A course box with no term label and no name elements still parses.
    const odd = parseCourseList('<div class="courseList"><a class="courseBox" href="/courses/42">x</a></div>')
    expect(odd).toEqual([{ id: '42', shortName: '', name: '', term: null, url: 'https://www.gradescope.com/courses/42' }])
  })
  test('dedupes a course that appears twice', () => {
    const html = `<div class="courseList">
      <a class="courseBox" href="/courses/5"><h3 class="courseBox--shortname">15-112</h3></a>
      <a class="courseBox" href="/courses/5"><h3 class="courseBox--shortname">15-112</h3></a></div>`
    expect(parseCourseList(html)).toHaveLength(1)
  })
})

describe('hasCourseList', () => {
  test('detects logged-in vs logged-out home pages', () => {
    expect(hasCourseList(HOME)).toBe(true)
    expect(hasCourseList('<html><body><h1>Gradescope</h1><a href="/login">Log In</a></body></html>')).toBe(false)
  })
})

describe('isCoursePage', () => {
  test('a course page has the header or the student table; home and login pages do not', () => {
    expect(isCoursePage(COURSE)).toBe(true)
    expect(isCoursePage('<table id="assignments-student-table"></table>')).toBe(true)
    expect(isCoursePage(HOME)).toBe(false)
    expect(isCoursePage('<form action="/login"><input type="password"></form>')).toBe(false)
  })
})

describe('parseCoursePage', () => {
  const page = parseCoursePage(COURSE, '1000002')
  const byName = (name: string) => page.items.find((i) => i.name === name)!

  test('reads the header', () => {
    expect(page.title).toBe('36225')
    expect(page.term).toBe('Fall 2026')
    expect(page.items).toHaveLength(6)
  })
  test('graded row: score, max, id, url and due date', () => {
    expect(byName('HW01')).toEqual({
      id: 'name:hw1', // name-based even though the row links to the assignment
      name: 'HW01',
      categoryId: null,
      score: 36,
      max: 40,
      status: 'graded',
      due: '2026-09-11T23:59:00-04:00',
      omit: false,
      url: 'https://www.gradescope.com/courses/1000002/assignments/5000001/submissions/9000001',
    })
  })
  test('decimal scores and the late due date is ignored', () => {
    const hw2 = byName('HW02')
    expect(hw2.score).toBe(24.25)
    expect(hw2.max).toBe(25)
    expect(hw2.due).toBe('2026-09-18T23:59:00-04:00')
  })
  test('no submission row: plain-text name, name-based id, no url, no due date', () => {
    expect(byName('Midterm 1A')).toMatchObject({
      id: 'name:midterm1a',
      score: null,
      max: null,
      status: 'unsubmitted',
      due: null,
      url: null,
    })
  })
  test('submitted and ungraded rows have no score or max', () => {
    expect(byName('HW07')).toMatchObject({ status: 'submitted', score: null, max: null, due: '2026-11-06T23:59:00-05:00' })
    expect(byName('Exam 2')).toMatchObject({ status: 'ungraded', score: null, max: null, due: null })
  })
  test('row with a score but no time element', () => {
    expect(byName('Quiz #2')).toMatchObject({ score: 9.5, max: 10, status: 'graded', due: null })
  })
  test('unknown status text with no score counts as unsubmitted', () => {
    const html = `<table id="assignments-student-table"><tbody><tr><th>Lab 3</th>
      <td class="submissionStatus"><div class="submissionStatus--text">Something New</div></td></tr></tbody></table>`
    expect(parseCoursePage(html, '1').items[0].status).toBe('unsubmitted')
  })
  test('off-site or absolute links are not trusted as urls', () => {
    const html = `<table id="assignments-student-table"><tbody>
      <tr><th><a href="https://evil.example/courses/1/assignments/2">A</a></th><td class="submissionStatus"></td></tr>
      <tr><th><a href="javascript:alert(1)">B</a></th><td class="submissionStatus"></td></tr></tbody></table>`
    const items = parseCoursePage(html, '1').items
    expect(items.map((i) => i.url)).toEqual([null, null])
    expect(items[1].id).toBe('name:b')
  })
  test('the id stays the same when the student submits (the row gains a link)', () => {
    const before = `<table id="assignments-student-table"><tbody><tr><th>HW 3</th>
      <td class="submissionStatus"><div class="submissionStatus--text">No Submission</div></td></tr></tbody></table>`
    const after = `<table id="assignments-student-table"><tbody><tr>
      <th><a href="/courses/1/assignments/55/submissions/99">HW 3</a></th>
      <td class="submissionStatus"><div class="submissionStatus--text">Submitted</div></td></tr></tbody></table>`
    const a = parseCoursePage(before, '1').items[0]
    const b = parseCoursePage(after, '1').items[0]
    expect(a.id).toBe('name:hw3')
    expect(b.id).toBe(a.id) // what-ifs and other per-item settings keyed by it keep working
    expect(b.status).toBe('submitted')
  })
  test('duplicate names get #2, #3 suffixes, linked or not', () => {
    const html = `<table id="assignments-student-table"><tbody>
      <tr><th><a href="/courses/1/assignments/7/submissions/1">Quiz</a></th><td></td></tr>
      <tr><th>Quiz</th><td></td></tr><tr><th>quiz</th><td></td></tr></tbody></table>`
    expect(parseCoursePage(html, '1').items.map((i) => i.id)).toEqual(['name:quiz', 'name:quiz#2', 'name:quiz#3'])
  })
  test('duplicate unlinked names get unique ids', () => {
    const html = `<table id="assignments-student-table"><tbody>
      <tr><th>Quiz</th><td></td></tr><tr><th>Quiz</th><td></td></tr><tr><th>  </th><td></td></tr></tbody></table>`
    expect(parseCoursePage(html, '1').items.map((i) => i.id)).toEqual(['name:quiz', 'name:quiz#2'])
  })
  test('falls back to any table when the student table id changes', () => {
    const html = `<h1 class="courseHeader--title">X</h1><table><thead><tr><th>Name</th></tr></thead><tbody>
      <tr><th><a href="/courses/9/assignments/77/submissions/1">HW 1</a></th>
      <td class="submissionStatus"><div class="submissionStatus--score">5 / 10</div></td></tr></tbody></table>`
    const p = parseCoursePage(html, '9')
    expect(p.term).toBeNull()
    expect(p.items).toHaveLength(1)
    expect(p.items[0]).toMatchObject({ id: 'name:hw1', score: 5, max: 10 })
  })
  test('empty or broken pages give no items instead of throwing', () => {
    expect(parseCoursePage('', '1')).toEqual({ term: null, title: null, items: [] })
    expect(parseCoursePage('<table><tbody><tr></tr></tbody>', '1').items).toEqual([])
  })
})

describe('syncGradescope', () => {
  // Fake fetchText serving the fixtures; every listed course returns the same course page.
  function fakeFetch(pages: Record<string, string | Error>) {
    const calls: string[] = []
    const fetchText = async (path: string) => {
      calls.push(path)
      const page = pages[path]
      if (page instanceof Error) throw page
      if (page === undefined) throw new Error('HTTP 404')
      return page
    }
    return { fetchText, calls }
  }

  test('builds a gradescope payload from active student courses', async () => {
    const pages: Record<string, string> = { '/': HOME }
    for (const id of ['1000001', '1000002', '1000003', '900004', '900005']) pages[`/courses/${id}`] = COURSE
    const { fetchText, calls } = fakeFetch(pages)
    const progress: string[] = []

    const payload = await syncGradescope(fetchText, (m) => progress.push(m))

    expect(payload.v).toBe(1)
    expect(payload.kind).toBe('gradescope')
    expect(payload.warnings).toEqual([])
    expect(payload.failedIds).toEqual([])
    expect(payload.courses).toHaveLength(5)
    expect(calls).not.toContain('/courses/800006') // inactive course never fetched
    expect(progress.at(-1)).toBe('Gradescope: 5 of 5 courses')

    const ml = payload.courses.find((c) => c.sourceId === '1000003')!
    expect(ml).toMatchObject({
      source: 'gradescope',
      number: '10335',
      title: 'Art & Science of ML',
      term: 'Fall 2026',
      url: 'https://www.gradescope.com/courses/1000003',
      weighted: false,
      categories: [],
      canvasScore: null,
      canvasGrade: null,
      scheme: null,
    })
    expect(ml.items).toHaveLength(6)
    expect(ml.syncedAt).toBe(payload.at)
    // Order follows the home page even though fetches run in parallel.
    expect(payload.courses.map((c) => c.sourceId)).toEqual(['1000001', '1000002', '1000003', '900004', '900005'])
  })

  test('passes cross-listed numbers through as alsoNumbers', async () => {
    const home = '<div class="courseList"><a class="courseBox" href="/courses/8"><h3 class="courseBox--shortname">15-213/18-213</h3></a></div>'
    const { fetchText } = fakeFetch({ '/': home, '/courses/8': COURSE })
    const payload = await syncGradescope(fetchText)
    expect(payload.courses[0]).toMatchObject({ number: '15213', alsoNumbers: ['18213'] })
  })

  test('falls back to the course page term when the list has none', async () => {
    const home = '<div class="courseList"><a class="courseBox" href="/courses/7"><h3 class="courseBox--shortname">36225</h3></a></div>'
    const { fetchText } = fakeFetch({ '/': home, '/courses/7': COURSE })
    const payload = await syncGradescope(fetchText)
    expect(payload.courses[0]).toMatchObject({ term: 'Fall 2026', number: '36225', title: '36225' })
  })

  test('a failing course becomes a warning and a failed id, the rest still sync', async () => {
    const { fetchText } = fakeFetch({ '/': HOME_TA, '/courses/1000002': COURSE, '/courses/1000007': new Error('HTTP 500') })
    const payload = await syncGradescope(fetchText)
    expect(payload.courses.map((c) => c.sourceId)).toEqual(['1000002'])
    expect(payload.warnings).toEqual(["Gradescope: couldn't read 36202 (HTTP 500)"])
    expect(payload.failedIds).toEqual(['1000007']) // the app keeps its stored copy of this course
  })

  test('a page that is not a course page is a failed course, not an empty one', async () => {
    // e.g. Gradescope sent its home page instead of the course
    const { fetchText } = fakeFetch({ '/': HOME_TA, '/courses/1000002': COURSE, '/courses/1000007': HOME_TA })
    const payload = await syncGradescope(fetchText)
    expect(payload.courses.map((c) => c.sourceId)).toEqual(['1000002'])
    expect(payload.failedIds).toEqual(['1000007'])
    expect(payload.warnings[0]).toMatch(/couldn't read 36202/)
  })

  test('getting logged out mid-sync stops the whole sync', async () => {
    const login = '<html><body><form action="/login" method="post"><input name="session[email]"><input type="password" name="session[password]"></form></body></html>'
    const { fetchText } = fakeFetch({ '/': HOME_TA, '/courses/1000002': COURSE, '/courses/1000007': login })
    await expect(syncGradescope(fetchText)).rejects.toThrow('Log in to Gradescope first')
  })

  test('throws a clear error when logged out', async () => {
    const { fetchText } = fakeFetch({ '/': '<html><body><a href="/login">Log In</a></body></html>' })
    await expect(syncGradescope(fetchText)).rejects.toThrow('Log in to Gradescope first')
  })

  test('a logged-in account with no courses gives an empty payload', async () => {
    const { fetchText } = fakeFetch({ '/': '<div class="courseList"></div>' })
    const payload = await syncGradescope(fetchText)
    expect(payload.courses).toEqual([])
    expect(payload.warnings).toEqual([])
  })

  test('fetches course pages one at a time', async () => {
    let running = 0
    let peak = 0
    const home = `<div class="courseList">${[1, 2, 3, 4, 5, 6, 7]
      .map((i) => `<a class="courseBox" href="/courses/${i}"><h3 class="courseBox--shortname">1511${i}</h3></a>`)
      .join('')}</div>`
    const fetchText = async (path: string) => {
      if (path === '/') return home
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return COURSE
    }
    const payload = await syncGradescope(fetchText)
    expect(payload.courses).toHaveLength(7)
    expect(peak).toBe(1)
  })
})
