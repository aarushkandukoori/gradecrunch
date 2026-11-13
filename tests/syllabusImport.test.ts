// End to end, offline: a fake Canvas (made-up courses and syllabi) -> the real Canvas sync -> the #sync encoding ->
// validatePayload -> pdf.js -> the store -> merged courses -> the course grade. It checks that the grade really uses
// the syllabus weights, not Canvas's broken ones.
//
// tests/fixtures/syllabus-table.pdf is a made-up syllabus printed to PDF by headless Chrome (--print-to-pdf) from a
// small HTML page with a grading table: Workbooks 30%, Attendance 10%, Midterm Exam 25%, Final Exam 35%.
import { describe, expect, test } from 'vitest'
import { syncCanvas, CanvasHttpError, type BinaryFetcher, type PageFetcher } from '../src/sync/canvas'
import { decodePayload, encodePayload } from '../src/lib/payload'
import { payloadHasPdfs, pdfsToText } from '../src/lib/syllabus'
import { applyPayload, defaultStore } from '../src/lib/store'
import { buildCourses } from '../src/lib/merge'
import { gradeCourse } from '../src/lib/grade'
import PDF_DATA_URL from './fixtures/syllabus-table.pdf?inline' // Vite hands us the file as a base64 data: URL

const PDF = Uint8Array.from(atob(PDF_DATA_URL.slice(PDF_DATA_URL.indexOf(',') + 1)), (ch) => ch.charCodeAt(0))

// Like a Canvas Syllabus page whose instructor never turned on group weights (made-up text).
const PROBABILITY_SYLLABUS = `
<h2>Course Description</h2>
<p>A made-up probability course for testing. Lectures meet twice a week.</p>
<h2>Grading</h2>
<p>Your final grade is computed as follows:</p>
<ul>
  <li>Average Homework Score: 15%</li>
  <li>Average Quiz Score: 15%</li>
  <li>Midterm 1: 20%</li>
  <li>Midterm 2: 20%</li>
  <li>Final Exam: 30%</li>
</ul>
<p>Grade cutoffs: A 90% or higher, B 80% or higher, C 70% or higher.</p>
<p>Homework turned in late loses 10% per day.</p>`

const student = [{ type: 'student' }]

function assignment(id: number, name: string, max: number, score: number | null) {
  return {
    id,
    name,
    points_possible: max,
    published: true,
    html_url: `https://canvas.cmu.edu/courses/1/assignments/${id}`,
    submission: score === null ? { score: null, workflow_state: 'unsubmitted' } : { score, workflow_state: 'graded' },
  }
}

/** A fake Canvas API with two made-up courses, shaped like the real broken setups. */
const pages: Record<string, unknown> = {
  courses: [
    // Points mode (groups at 0%), real weights on the Syllabus page, no "Final Exam" group yet.
    { id: 101, name: 'Made-Up Probability', course_code: '36999', term: { name: 'Fall 2026' }, apply_assignment_group_weights: false, enrollments: student },
    // One weighted catch-all group holding workbooks, attendance and the midterm; real weights in a syllabus PDF.
    { id: 102, name: 'Made-Up Psychology', course_code: '85999', term: { name: 'Fall 2026' }, apply_assignment_group_weights: true, enrollments: student },
  ],
  'courses/101/assignment_groups': [
    { id: 1, name: 'Homework', group_weight: 0, assignments: [assignment(11, 'HW1', 10, 9), assignment(12, 'HW2', 20, 18)] },
    { id: 2, name: 'Quizzes', group_weight: 0, assignments: [assignment(21, 'Quiz 1', 5, 4), assignment(22, 'Quiz 2', 10, 8)] },
    { id: 3, name: 'Midterm 1', group_weight: 0, assignments: [assignment(31, 'Midterm 1', 100, 70)] },
    { id: 4, name: 'Exam 2', group_weight: 0, assignments: [assignment(41, 'Exam 2', 100, null)] },
    { id: 5, name: 'Recitation', group_weight: 0, assignments: [] },
    { id: 6, name: 'Lecture', group_weight: 0, assignments: [] },
  ],
  'courses/101?include[]=syllabus_body': { id: 101, syllabus_body: PROBABILITY_SYLLABUS },
  'courses/102/assignment_groups': [
    {
      id: 7,
      name: 'Assignments',
      group_weight: 25,
      assignments: [
        assignment(71, 'Attendance', 10, 10),
        assignment(72, 'Workbook 1', 10, 8),
        assignment(73, 'Workbook 2', 10, 9),
        assignment(74, 'Midterm', 50, 40),
      ],
    },
    { id: 8, name: 'Imported Assignments', group_weight: 0, assignments: [] },
  ],
  'courses/102?include[]=syllabus_body': { id: 102, syllabus_body: null },
  'courses/102/files?search_term=syllabus&per_page=20': [
    {
      id: 555,
      display_name: 'Made-up Syllabus.pdf',
      'content-type': 'application/pdf',
      size: PDF.length,
      url: 'https://canvas.cmu.edu/files/555/download?download_frd=1&verifier=test',
    },
  ],
}

/** Answers like Canvas: the page for a known path (query strings for lists ignored), 404 otherwise. */
const fetchPage: PageFetcher = async (path) => {
  if (path in pages) return { data: pages[path], next: null }
  const base = path.split('?')[0]
  if (base in pages && !path.includes('syllabus')) return { data: pages[base], next: null }
  if (path === 'courses/101/files?search_term=syllabus&per_page=20') throw new CanvasHttpError(403, 'Canvas answered 403') // Files tab hidden
  throw new CanvasHttpError(404, 'Canvas answered 404')
}

const downloads: string[] = []
const fetchBinary: BinaryFetcher = async (path) => {
  downloads.push(path)
  if (path === '/files/555/download?download_frd=1&verifier=test') return { contentType: 'application/pdf', bytes: PDF }
  throw new CanvasHttpError(404, 'Canvas answered 404')
}

describe('syllabus import, end to end (offline)', () => {
  test('the course grades use the syllabus weights from an HTML Syllabus page and from a Chrome-printed PDF', async () => {
    // 1. The real Canvas sync, with syllabus collection on (as the bookmarklet and extension do).
    const synced = await syncCanvas(fetchPage, () => {}, { syllabus: { fetchBinary } })
    expect(downloads).toEqual(['/files/555/download?download_frd=1&verifier=test'])
    expect(payloadHasPdfs(synced)).toBe(true)

    // 2. Through the same encoding and validation a #sync link or the postMessage handoff uses.
    const received = await decodePayload(await encodePayload(synced))
    expect(payloadHasPdfs(received)).toBe(true)

    // 3. The App's import step: PDFs -> text with the real pdf.js, then saved.
    const asText = await pdfsToText(received)
    expect(asText.warnings).toEqual([])
    const store = applyPayload(defaultStore(), asText)
    expect(JSON.stringify(store)).not.toContain('pdfBase64')
    const pdfText = store.synced['canvas:102'].syllabus?.[0].text ?? ''
    expect(pdfText).toContain('Workbooks 30%')
    expect(pdfText).toContain('Final Exam 35%')
    expect(pdfText).toContain('Office hours') // Chrome draws "fi" as its own piece; it must stay inside the word
    expect(pdfText).toContain('one final exam')

    const courses = buildCourses(store)
    const probability = courses.find((c) => c.number === '36999')!
    const psychology = courses.find((c) => c.number === '85999')!

    // Probability: Canvas would say (27 + 12 + 70) / (30 + 15 + 100) = 75.17% in points mode. The syllabus weights
    // the graded parts: (15 x 90% + 15 x 80% + 20 x 70%) / 50 = 79%.
    expect(probability.weighted).toBe(true)
    expect(probability.syllabusUsed?.name).toBe('Syllabus page')
    const pWeights = Object.fromEntries(probability.categories.map((c) => [c.name, c.weight]))
    expect(pWeights).toMatchObject({ Homework: 15, Quizzes: 15, 'Midterm 1': 20, 'Exam 2': 20, 'Final Exam': 30 })
    expect(gradeCourse(probability).percent).toBeCloseTo(79, 6)

    // Psychology: Canvas's single group gives 67 / 80 = 83.75%. The syllabus gives workbooks 17/20 = 85% (30),
    // attendance 100% (10), midterm 80% (25); the final (35) isn't graded yet: (2550 + 1000 + 2000) / 65 = 85.38%.
    expect(psychology.weighted).toBe(true)
    expect(psychology.syllabusUsed?.name).toBe('Made-up Syllabus.pdf')
    expect(gradeCourse(psychology).percent).toBeCloseTo(5550 / 65, 6)
  }, 30_000)
})
