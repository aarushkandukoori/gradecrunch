// Tests for src/lib/payload.ts: round trips and defensive validation. Synthetic data only.
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SyncPayload } from '../src/types'
import { decodePayload, encodePayload, fromBase64Url, toBase64Url, validatePayload } from '../src/lib/payload'

function samplePayload(): SyncPayload {
  return {
    v: 1,
    kind: 'canvas',
    at: '2026-11-12T15:00:00.000Z',
    warnings: ['Could not read the grading scheme for 99999'],
    courses: [
      {
        source: 'canvas',
        sourceId: '1001',
        number: '21241',
        alsoNumbers: [],
        title: 'Matrices and Linear Transformations — ünïcødé ✓',
        term: 'Fall 2026',
        url: 'https://canvas.cmu.edu/courses/1001',
        weighted: true,
        categories: [
          { id: '11', name: 'Quizzes', weight: 10, dropLowest: 1, dropHighest: 0, neverDrop: ['501'] },
          { id: '12', name: 'Final Exam', weight: 25, dropLowest: 0, dropHighest: 0, neverDrop: [] },
        ],
        items: [
          {
            id: '501',
            name: 'Quiz 1',
            categoryId: '11',
            score: 9.5,
            max: 10,
            status: 'graded',
            due: '2026-09-11T23:59:00-04:00',
            omit: false,
            url: 'https://canvas.cmu.edu/courses/1001/assignments/501',
          },
          {
            id: '502',
            name: 'Quiz 2',
            categoryId: '11',
            score: null,
            max: 10,
            status: 'unsubmitted',
            due: null,
            omit: false,
            url: null,
          },
        ],
        canvasScore: 91.25,
        canvasGrade: 'A-',
        scheme: [
          { letter: 'A', min: 90 },
          { letter: 'B', min: 80 },
          { letter: 'R', min: 0 },
        ],
        syncedAt: '2026-11-12T15:00:00.000Z',
      },
    ],
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('encode / decode', () => {
  test('gzip round trip gives back the same payload', async () => {
    const p = samplePayload()
    const s = await encodePayload(p)
    expect(s.startsWith('z')).toBe(true)
    expect(s.slice(1)).toMatch(/^[A-Za-z0-9_-]+$/) // URL-safe, no padding
    expect(await decodePayload(s)).toEqual(p)
  })

  test('falls back to plain base64url JSON without CompressionStream', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    const p = samplePayload()
    const s = await encodePayload(p)
    expect(s.startsWith('j')).toBe(true)
    expect(await decodePayload(s)).toEqual(p)
  })

  test('gzip output is much smaller than the JSON for repetitive data', async () => {
    const p = samplePayload()
    const item = p.courses[0].items[0]
    p.courses[0].items = Array.from({ length: 300 }, (_, i) => ({ ...item, id: String(i), name: 'Homework ' + i }))
    const s = await encodePayload(p)
    expect(s.length).toBeLessThan(JSON.stringify(p).length / 4)
    expect((await decodePayload(s)).courses[0].items).toHaveLength(300)
  })

  test('handles payloads bigger than one 32 KB base64 slice', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    const p = samplePayload()
    p.warnings = Array.from({ length: 50 }, (_, i) => 'w'.repeat(290) + i)
    p.courses = Array.from({ length: 20 }, (_, i) => ({ ...samplePayload().courses[0], sourceId: String(i) }))
    const s = await encodePayload(p)
    expect(s.length).toBeGreaterThan(0x8000)
    expect(await decodePayload(s)).toEqual(p)
  })

  test('base64url helpers round trip every byte value', () => {
    const bytes = new Uint8Array(256).map((_, i) => i)
    const s = toBase64Url(bytes)
    expect(s).not.toMatch(/[+/=]/)
    expect(Array.from(fromBase64Url(s))).toEqual(Array.from(bytes))
  })

  test('rejects garbage with a friendly error', async () => {
    await expect(decodePayload('')).rejects.toThrow(/broken/)
    await expect(decodePayload('xabc')).rejects.toThrow(/broken/)
    await expect(decodePayload('z!!!not base64')).rejects.toThrow(/broken/)
    await expect(decodePayload('zAAAAAAAAAAA')).rejects.toThrow(/broken/) // base64 but not gzip
    await expect(decodePayload('j' + toBase64Url(new TextEncoder().encode('{not json')))).rejects.toThrow(/broken/)
  })

  test('rejects valid JSON that is not a payload', async () => {
    const s = 'j' + toBase64Url(new TextEncoder().encode(JSON.stringify({ hello: 'world' })))
    await expect(decodePayload(s)).rejects.toThrow(/supported version/)
  })
})

describe('validatePayload', () => {
  test('keeps a well-formed payload unchanged', () => {
    const p = samplePayload()
    expect(validatePayload(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })

  test('rejects the wrong version, kind or type', () => {
    for (const bad of [null, 'x', 42, [], {}, { v: 2, kind: 'canvas' }, { v: 1, kind: 'manual' }, { v: '1', kind: 'canvas' }]) {
      expect(() => validatePayload(bad)).toThrow()
    }
  })

  test('drops javascript:, http and look-alike URLs', () => {
    const p = samplePayload() as unknown as { courses: Record<string, unknown>[] }
    const c = p.courses[0] as { url: unknown; items: { url: unknown }[] }
    c.url = 'javascript:alert(1)'
    c.items[0].url = 'https://canvas.cmu.edu.evil.example/courses/1'
    c.items[1].url = 'http://canvas.cmu.edu/courses/1'
    const out = validatePayload(p)
    expect(out.courses[0].url).toBe('https://canvas.cmu.edu/') // falls back to the site root
    expect(out.courses[0].items[0].url).toBeNull()
    expect(out.courses[0].items[1].url).toBeNull()
  })

  test('accepts Gradescope URLs and falls back to the Gradescope root for its courses', () => {
    const p = samplePayload()
    p.kind = 'gradescope'
    p.courses[0].url = 'data:text/html,hi'
    p.courses[0].items[0].url = 'https://www.gradescope.com/courses/1/assignments/2'
    const out = validatePayload(p)
    expect(out.courses[0].source).toBe('gradescope') // the payload kind wins
    expect(out.courses[0].url).toBe('https://www.gradescope.com/')
    expect(out.courses[0].items[0].url).toBe('https://www.gradescope.com/courses/1/assignments/2')
  })

  test('caps counts and string lengths', () => {
    const p = samplePayload()
    const course = p.courses[0]
    course.title = 'x'.repeat(10_000)
    course.items = Array.from({ length: 1000 }, (_, i) => ({ ...course.items[0], id: String(i) }))
    course.categories = Array.from({ length: 100 }, (_, i) => ({ ...course.categories[0], id: String(i) }))
    p.courses = Array.from({ length: 100 }, (_, i) => ({ ...course, sourceId: String(i) }))
    p.warnings = Array.from({ length: 500 }, () => 'warn')
    const out = validatePayload(p)
    expect(out.courses).toHaveLength(60)
    expect(out.courses[0].items).toHaveLength(400)
    expect(out.courses[0].categories).toHaveLength(60)
    expect(out.courses[0].title).toHaveLength(300)
    expect(out.warnings).toHaveLength(50)
  })

  test('coerces wrong types to safe values', () => {
    const raw = {
      v: 1,
      kind: 'canvas',
      at: 12345,
      warnings: ['ok', 7, null],
      courses: [
        'not a course',
        { title: 'no source id' },
        {
          sourceId: '1',
          number: '2124', // not 5 digits
          alsoNumbers: ['10615', 'abc', 5],
          title: { evil: true },
          term: '',
          weighted: 'yes',
          canvasScore: 'NaN',
          canvasGrade: 3,
          scheme: [{ letter: 'B', min: '80' }, { letter: 'A', min: 90 }, { letter: 'C' }, 'x'],
          categories: [{ id: '5', name: 'HW', weight: 'abc', dropLowest: -3, dropHighest: 2.7, neverDrop: 'x' }, { name: 'no id' }],
          items: [
            { id: '9', name: 'HW 1', score: '8.5', max: Infinity, status: 'hacked', due: 'not a date', omit: 1 },
            { name: 'no id' },
          ],
        },
      ],
    }
    const out = validatePayload(raw)
    expect(typeof out.at).toBe('string')
    expect(out.warnings).toEqual(['ok'])
    expect(out.courses).toHaveLength(1)
    const c = out.courses[0]
    expect(c.number).toBeNull()
    expect(c.alsoNumbers).toEqual(['10615'])
    expect(c.title).toBe('')
    expect(c.term).toBeNull()
    expect(c.weighted).toBe(false)
    expect(c.canvasScore).toBeNull()
    expect(c.canvasGrade).toBeNull()
    expect(c.scheme).toEqual([
      { letter: 'A', min: 90 },
      { letter: 'B', min: 80 },
    ])
    expect(c.syncedAt).toBe(out.at)
    expect(c.categories).toEqual([{ id: '5', name: 'HW', weight: null, dropLowest: 0, dropHighest: 2, neverDrop: [] }])
    expect(c.items).toEqual([
      { id: '9', name: 'HW 1', categoryId: null, score: 8.5, max: null, status: 'unsubmitted', due: null, omit: false, url: null },
    ])
  })

  test('an empty scheme becomes null', () => {
    const p = samplePayload()
    p.courses[0].scheme = []
    expect(validatePayload(p).courses[0].scheme).toBeNull()
  })
})
