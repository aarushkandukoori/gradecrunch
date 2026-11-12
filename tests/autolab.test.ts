// Tests for the Autolab reader (beta). Fixtures are synthetic and follow Autolab's open-source templates.
import { describe, expect, test } from 'vitest'
import { parseAutolabCourses, parseAutolabGradebook, syncAutolab, termFromAutolabName } from '../src/sync/autolab'
import coursesHtml from './fixtures/autolab-courses.html?raw'
import gradebookHtml from './fixtures/autolab-gradebook.html?raw'

describe('termFromAutolabName', () => {
  test('reads term codes from names and slugs', () => {
    expect(termFromAutolabName('Introduction to Computer Systems (f26)')).toBe('Fall 2026')
    expect(termFromAutolabName('15122-s27')).toBe('Spring 2027')
    expect(termFromAutolabName('Something (M26)')).toBe('Summer 2026')
    expect(termFromAutolabName('Course fall 2026')).toBe('Fall 2026')
    expect(termFromAutolabName('No term here')).toBeNull()
  })
})

describe('parseAutolabCourses', () => {
  test('keeps student courses with a gradebook link, skips course-assistant cards', () => {
    const courses = parseAutolabCourses(coursesHtml)
    expect(courses.map((c) => c.slug)).toEqual(['15213-f26', '15112-f25'])
    expect(courses[0]).toEqual({
      slug: '15213-f26',
      name: 'Introduction to Computer Systems (f26)',
      status: 'current',
      gradebookPath: '/courses/15213-f26/course_user_data/1001/gradebook',
    })
    expect(courses[1].status).toBe('completed')
  })
})

describe('parseAutolabGradebook', () => {
  test('maps every score cell state', () => {
    const { categories, items } = parseAutolabGradebook(gradebookHtml)
    expect(categories.map((c) => c.name)).toEqual(['Lab', 'Written'])
    const byName = Object.fromEntries(items.map((i) => [i.name, i]))
    expect(byName['Data Lab']).toMatchObject({ score: 58.5, max: 63, status: 'graded', categoryId: 'Lab', id: 'datalab' })
    expect(byName['Data Lab'].url).toBe('https://autolab.andrew.cmu.edu/courses/15213-f26/assessments/datalab')
    expect(byName['Bomb Lab']).toMatchObject({ score: null, status: 'ungraded' })
    expect(byName['Attack Lab']).toMatchObject({ score: null, max: 100, status: 'unsubmitted' })
    expect(byName['Cache Lab']).toMatchObject({ score: 0, max: 60, status: 'missing' })
    expect(byName['Written 1']).toMatchObject({ score: null, status: 'excused' })
    expect(byName['Written 2']).toMatchObject({ score: 9, max: 10, status: 'graded', categoryId: 'Written' })
  })

  test('an empty page gives nothing, not an error', () => {
    expect(parseAutolabGradebook('<html><body>nothing</body></html>')).toEqual({ categories: [], items: [] })
  })
})

describe('syncAutolab', () => {
  test('syncs current courses only and builds SyncedCourse objects', async () => {
    const fetched: string[] = []
    const payload = await syncAutolab(async (path) => {
      fetched.push(path)
      if (path === '/courses') return { html: coursesHtml, url: 'https://autolab.andrew.cmu.edu/courses' }
      return { html: gradebookHtml, url: 'https://autolab.andrew.cmu.edu' + path + '/student' }
    })
    expect(fetched).toEqual(['/courses', '/courses/15213-f26/course_user_data/1001/gradebook'])
    expect(payload.kind).toBe('autolab')
    expect(payload.courses).toHaveLength(1)
    const c = payload.courses[0]
    expect(c).toMatchObject({ source: 'autolab', sourceId: '15213-f26', number: '15213', term: 'Fall 2026', title: 'Introduction to Computer Systems' })
    expect(c.items).toHaveLength(6)
    expect(payload.failedIds).toEqual([])
  })

  test('getting logged out mid-sync stops the whole sync instead of saving an empty course', async () => {
    await expect(
      syncAutolab(async (path) =>
        path === '/courses'
          ? { html: coursesHtml, url: 'https://autolab.andrew.cmu.edu/courses' }
          : { html: '<html><body>Sign in</body></html>', url: 'https://autolab.andrew.cmu.edu/auth/users/sign_in' },
      ),
    ).rejects.toThrow('Log in to Autolab first')
  })

  test('a gradebook that fails to load becomes a warning and a failed id', async () => {
    const payload = await syncAutolab(async (path) => {
      if (path === '/courses') return { html: coursesHtml, url: 'https://autolab.andrew.cmu.edu/courses' }
      throw new Error('Autolab returned an error (500) for ' + path)
    })
    expect(payload.courses).toEqual([])
    expect(payload.failedIds).toEqual(['15213-f26']) // the app keeps its stored copy
    expect(payload.warnings[0]).toMatch(/couldn't read Introduction to Computer Systems/)
  })

  test('a redirect to the login page means "log in first"', async () => {
    await expect(
      syncAutolab(async () => ({ html: '<html></html>', url: 'https://autolab.andrew.cmu.edu/auth/users/sign_in' })),
    ).rejects.toThrow('Log in to Autolab first')
    await expect(
      syncAutolab(async () => {
        throw new TypeError('Failed to fetch') // cross-origin redirect to CMU login
      }),
    ).rejects.toThrow('Log in to Autolab first')
  })

  test('nickname redirect becomes a warning', async () => {
    const payload = await syncAutolab(async (path) =>
      path === '/courses'
        ? { html: coursesHtml, url: 'https://autolab.andrew.cmu.edu/courses' }
        : { html: '', url: 'https://autolab.andrew.cmu.edu/courses/15213-f26/course_user_data/1001/edit' },
    )
    expect(payload.courses).toHaveLength(0)
    expect(payload.warnings[0]).toMatch(/nickname/)
    expect(payload.failedIds).toEqual(['15213-f26']) // left out, so keep any stored copy
  })
})
