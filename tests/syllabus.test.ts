// Tests for reading grading weights out of a syllabus (src/lib/syllabus.ts).
// Every syllabus below is made up. They copy the SHAPES real CMU syllabi use (a Syllabus page with a bullet list, a
// PDF table, a table split across lines), not any real course's text.
import { describe, expect, test } from 'vitest'
import {
  capSyllabusText,
  extractWeights,
  kindOf,
  matchDrop,
  matchWeights,
  MAX_SYLLABUS_TEXT,
  moveTargets,
  numberOf,
  payloadHasPdfs,
  pdfsToText,
  pdfToText,
  pickSyllabus,
  piecesToLines,
  trimText,
} from '../src/lib/syllabus'
import type { SyncedCourse, SyncPayload } from '../src/types'

// ---------------------------------------------------------------- synthetic syllabi

// Like a Canvas Syllabus page (HTML): a bullet list, a drop rule, then letter cutoffs, a late policy and an
// attendance rule that all mention percents and must be ignored.
const STATS_PAGE = `
<h2>Course Description</h2>
<p>An introduction to probability and statistical inference. Lectures meet twice a week.</p>
<h2>Grading</h2>
<p>Your course grade is computed from the components below.</p>
<ul>
  <li>Average Homework Score: 15%</li>
  <li>Average Quiz Score: 15%</li>
  <li>Midterm 1: 20%</li>
  <li>Midterm 2: 20%</li>
  <li>Final Exam: 30%</li>
</ul>
<p>The lowest homework score will be dropped. We also drop the two lowest quizzes.</p>
<h3>Letter grades</h3>
<table>
  <tr><td>A</td><td>90% - 100%</td></tr>
  <tr><td>B</td><td>80% - 89.99%</td></tr>
  <tr><td>C</td><td>70% - 79.99%</td></tr>
</table>
<p>Late homework loses 10% per day.</p>
<p>Attendance at 80% of recitations is expected.</p>`

// Like text pulled out of a syllabus PDF: a two-column table with a Total row, then a grading scale.
const PSYCH_PDF = `Introduction to Thinking, Fall 2026
Instructor office hours are listed on Canvas.
Course Requirements and Grading
Component Weight
Workbooks 25%
Attendance & Participation 10%
Midterm Exam 25%
Final Exam 40%
Total 100%
Grading Scale
A 93% and above
A- 90%
B+ 87%
B 83%`

// A table whose cells came out one per line ("Problem Sets" then "20%"), with roman numeral exams.
const TABLE_SPLIT = `Grade Breakdown
Assessment
Weight
Problem Sets
20%
Quizzes
10%
Midterm Exam I
15%
Midterm Exam II
15%
Final Exam
40%`

// ---------------------------------------------------------------- extractWeights

describe('extractWeights', () => {
  test('Syllabus page with a bullet list ("Average Homework Score: 15%")', () => {
    const w = extractWeights(STATS_PAGE)
    expect(w.items).toEqual([
      { label: 'Homework', percent: 15 },
      { label: 'Quiz', percent: 15 },
      { label: 'Midterm 1', percent: 20 },
      { label: 'Midterm 2', percent: 20 },
      { label: 'Final Exam', percent: 30 },
    ])
    expect(w.total).toBe(100)
    expect(w.confident).toBe(true)
  })

  test('letter cutoffs, late penalties and attendance rules are not weights', () => {
    const labels = extractWeights(STATS_PAGE).items.map((i) => i.label)
    expect(labels).not.toContain('A')
    expect(labels.some((l) => /late|attendance/i.test(l))).toBe(false)
    // A text with only cutoffs and policies has no weights at all.
    const policies = 'Grading scale\nA: 93% and above\nA- 90-92.99%\nB 80% - 89.99%\nLate work loses 10% per day.\nYou must attend at least 85% of lectures.'
    expect(extractWeights(policies)).toMatchObject({ items: [], confident: false })
  })

  test('drop rules in plain words', () => {
    expect(extractWeights(STATS_PAGE).drops).toEqual([
      { label: 'homework', dropLowest: 1 },
      { label: 'quizzes', dropLowest: 2 },
    ])
    expect(extractWeights('Grading\nHomework 50%\nExams 50%\nNo scores will be dropped from the lowest group.').drops).toEqual([])
  })

  test('PDF table with a Total row and a grading scale after it', () => {
    const w = extractWeights(PSYCH_PDF)
    expect(w.items).toEqual([
      { label: 'Workbooks', percent: 25 },
      { label: 'Attendance & Participation', percent: 10 },
      { label: 'Midterm Exam', percent: 25 },
      { label: 'Final Exam', percent: 40 },
    ])
    expect(w.confident).toBe(true)
  })

  test('table rows split across lines', () => {
    const w = extractWeights(TABLE_SPLIT)
    expect(w.items.map((i) => [i.label, i.percent])).toEqual([
      ['Problem Sets', 20],
      ['Quizzes', 10],
      ['Midterm Exam I', 15],
      ['Midterm Exam II', 15],
      ['Final Exam', 40],
    ])
    expect(w.confident).toBe(true)
  })

  test('"Midterms (2 x 20%)" and "Two midterms (20% each)" mean two items of 20%', () => {
    for (const text of ['Grading\nHomework 25%\nMidterms (2 x 20%)\nFinal 35%', 'Assessment\nTwo midterms (20% each)\nHomework (25%)\nFinal (35%)']) {
      const w = extractWeights(text)
      expect(w.items).toContainEqual({ label: 'Midterm 1', percent: 20 })
      expect(w.items).toContainEqual({ label: 'Midterm 2', percent: 20 })
      expect(w.total).toBe(100)
      expect(w.confident).toBe(true)
    }
  })

  test('other common shapes: "Homework 15%", "Quiz - 15%", "15% Homework", one line with commas', () => {
    expect(extractWeights('Grading\nHomework 40%\nAverage Quiz Score - 20%\nFinal (40%)').items).toEqual([
      { label: 'Homework', percent: 40 },
      { label: 'Quiz', percent: 20 },
      { label: 'Final', percent: 40 },
    ])
    expect(extractWeights('Evaluation: 40% Homework, 25% Midterm, 35% Final').items.map((i) => i.label)).toEqual(['Homework', 'Midterm', 'Final'])
    expect(extractWeights('Homework: 15% of the final grade\nQuizzes: 15% (lowest dropped)\nExams: 70% of your grade').items).toEqual([
      { label: 'Homework', percent: 15 },
      { label: 'Quizzes', percent: 15 },
      { label: 'Exams', percent: 70 },
    ])
  })

  test('dates in a label are cut off; schedule lines with a date are ignored', () => {
    const w = extractWeights('Grading Policy\nHomework 20%\nMidterm 1 (Oct 8) 20%\nMidterm 2 (Nov 12) 20%\nFinal Exam (cumulative) 40%\nOct 8: Midterm 1, 20%')
    expect(w.items.map((i) => i.label)).toEqual(['Homework', 'Midterm 1', 'Midterm 2', 'Final Exam'])
    expect(w.confident).toBe(true)
  })

  test('extra credit is kept but left out of the total', () => {
    const w = extractWeights('Grading\nHomework 30%\nExams 70%\nExtra credit: up to 5%')
    expect(w.items).toContainEqual({ label: 'Extra credit', percent: 5, bonus: true })
    expect(w.total).toBe(100)
    expect(w.confident).toBe(true)
  })

  test('a total above 100 without extra credit is not trusted', () => {
    const w = extractWeights('Grading\nHomework 30%\nExams 75%')
    expect(w.total).toBe(105)
    expect(w.confident).toBe(false)
  })

  test('picks the grading block that adds up to 100, not a percent mentioned elsewhere', () => {
    const text = [
      'Course overview',
      'About 20% of the readings are optional.',
      '',
      'Grading',
      'Homework 30%',
      'Quizzes 20%',
      'Final project 50%',
      '',
      'Projects',
      'The final project proposal counts for 10% of the project grade.',
    ].join('\n')
    const w = extractWeights(text)
    expect(w.items.map((i) => i.label)).toEqual(['Homework', 'Quizzes', 'Final project'])
    expect(w.confident).toBe(true)
  })

  test('a grading section split by long paragraphs still counts as one block', () => {
    const filler = Array.from({ length: 10 }, (_, i) => `Policy sentence number ${i + 1} about how this part works.`)
    const text = ['Grading', 'Homework: 50%', ...filler, 'Exams: 50%', ...filler].join('\n')
    const w = extractWeights(text)
    expect(w.items.map((i) => i.percent)).toEqual([50, 50])
    expect(w.confident).toBe(true)
  })

  test('empty or weightless text', () => {
    expect(extractWeights('')).toEqual({ items: [], total: 0, confident: false, drops: [] })
    expect(extractWeights('Welcome to the course! Office hours are on Tuesdays.').confident).toBe(false)
    expect(extractWeights('Grading\nYour grade is 100% based on the final exam.').confident).toBe(false)
  })
})

// ---------------------------------------------------------------- names

describe('kindOf and numberOf', () => {
  test('kinds', () => {
    expect(kindOf('Average Homework Score')).toBe('homework')
    expect(kindOf('HW1')).toBe('homework')
    expect(kindOf('Problem Sets')).toBe('homework')
    expect(kindOf('Recitation Quiz 3')).toBe('quiz')
    expect(kindOf('Exam 2')).toBe('exam')
    expect(kindOf('Midterm 1')).toBe('exam')
    expect(kindOf('Final Exam')).toBe('final')
    expect(kindOf('Final Project')).toBe('project')
    expect(kindOf('Reading Responses')).toBe('paper')
    expect(kindOf('Workbook 4')).toBe('workbook')
    expect(kindOf('Attendance')).toBe('participation')
    expect(kindOf('Survey')).toBe('other')
  })

  test('numbers', () => {
    expect(numberOf('Midterm 2')).toBe(2)
    expect(numberOf('Exam II')).toBe(2)
    expect(numberOf('Second Midterm')).toBe(2)
    expect(numberOf('HW03')).toBe(3)
    expect(numberOf('Midterm (Oct 8)')).toBeNull()
    expect(numberOf('Homework')).toBeNull()
  })
})

// ---------------------------------------------------------------- matching

describe('matchWeights', () => {
  const stats = extractWeights(STATS_PAGE).items

  test('"Midterm 2" matches a Canvas group "Exam 2"; a missing Final becomes a planned category; others get 0', () => {
    const plan = matchWeights(stats, [
      { key: 'hw', name: 'Homework', size: 8 },
      { key: 'q', name: 'Quizzes', size: 6 },
      { key: 'm1', name: 'Midterm 1', size: 1 },
      { key: 'e2', name: 'Exam 2', size: 1 },
      { key: 'rec', name: 'Recitation', size: 0 },
      { key: 'lec', name: 'Lecture', size: 0 },
    ])
    expect(plan.weights).toEqual({ hw: 15, q: 15, m1: 20, e2: 20, rec: 0, lec: 0 })
    expect(plan.added).toEqual([{ key: 's:finalexam', name: 'Final Exam', weight: 30 }])
  })

  test('numbered midterms share one unnumbered "Exams" group; the final stays separate', () => {
    const plan = matchWeights(stats, [
      { key: 'hw', name: 'Homework' },
      { key: 'q', name: 'Quiz' },
      { key: 'ex', name: 'Exams' },
      { key: 'fin', name: 'Final' },
    ])
    expect(plan.weights).toEqual({ hw: 15, q: 15, ex: 40, fin: 30 })
    expect(plan.added).toEqual([])
  })

  test('an unnumbered "Midterms" weight splits across numbered groups', () => {
    const plan = matchWeights([{ label: 'Midterms', percent: 40 }, { label: 'Final', percent: 60 }], [
      { key: 'a', name: 'Exam 1' },
      { key: 'b', name: 'Exam 2' },
    ])
    expect(plan.weights).toEqual({ a: 20, b: 20 })
    expect(plan.added).toEqual([{ key: 's:final', name: 'Final', weight: 60 }])
  })

  test('roman numerals and synonyms', () => {
    const plan = matchWeights(extractWeights(TABLE_SPLIT).items, [
      { key: 'ps', name: 'Homework' },
      { key: 'q', name: 'Quizzes' },
      { key: 'm1', name: 'Midterm 1' },
      { key: 'm2', name: 'Midterm 2' },
      { key: 'f', name: 'Final Exam' },
    ])
    expect(plan.weights).toEqual({ ps: 20, q: 10, m1: 15, m2: 15, f: 40 })
  })

  test('with two groups of the same kind, the one holding work wins', () => {
    const plan = matchWeights([{ label: 'Homework', percent: 100 }], [
      { key: 'empty', name: 'Homework (old)', size: 0 },
      { key: 'real', name: 'Homework', size: 5 },
    ])
    expect(plan.weights.real).toBe(100)
    expect(plan.weights.empty).toBe(0)
  })

  test('drop rules point at the weighted category of their kind', () => {
    const cats = [
      { key: 'hw', name: 'Homework', weight: 15 },
      { key: 'q', name: 'Quizzes', weight: 15 },
      { key: 'rec', name: 'Recitation', weight: 0 },
    ]
    expect(matchDrop('homework', cats)).toBe('hw')
    expect(matchDrop('quizzes', cats)).toBe('q')
    expect(matchDrop('recitation', cats)).toBeNull()
  })
})

describe('moveTargets', () => {
  test('one catch-all group: workbooks, attendance and the midterm go to their syllabus categories', () => {
    const cats = [
      { key: 'asg', name: 'Assignments' },
      { key: 's:workbooks', name: 'Workbooks' },
      { key: 's:attendance', name: 'Attendance & Participation' },
      { key: 's:midterm', name: 'Midterm Exam' },
      { key: 's:final', name: 'Final Exam' },
    ]
    const weights = { asg: 0, 's:workbooks': 25, 's:attendance': 10, 's:midterm': 25, 's:final': 40 }
    const items = [
      { key: 'i1', name: 'Workbook 1', categoryKey: 'asg' },
      { key: 'i2', name: 'Attendance', categoryKey: 'asg' },
      { key: 'i3', name: 'Midterm', categoryKey: 'asg' },
      { key: 'i4', name: 'Welcome survey', categoryKey: 'asg' },
    ]
    expect(moveTargets(items, cats, weights)).toEqual({ i1: 's:workbooks', i2: 's:attendance', i3: 's:midterm' })
  })

  test('a weighted group keeps its items, except a final sitting with the midterms', () => {
    const cats = [
      { key: 'hw', name: 'Homework' },
      { key: 'ex', name: 'Exams' },
      { key: 'ef', name: 'Exam 2' },
      { key: 's:final', name: 'Final' },
    ]
    const weights = { hw: 30, ex: 40, ef: 0, 's:final': 30 }
    const items = [
      { key: 'a', name: 'Exam 2 practice problems', categoryKey: 'hw' },
      { key: 'b', name: 'Final Exam', categoryKey: 'ex' },
      { key: 'c', name: 'Midterm 1', categoryKey: 'ex' },
    ]
    expect(moveTargets(items, cats, weights)).toEqual({ b: 's:final' })
  })
})

// ---------------------------------------------------------------- picking a document

describe('pickSyllabus', () => {
  test('the first document with trusted weights wins, Syllabus page first', () => {
    const picked = pickSyllabus([
      { source: 'canvas-front-page', name: 'Home page', url: null, text: 'Welcome! See the syllabus PDF.' },
      { source: 'canvas-file', name: 'syllabus.pdf', url: null, text: PSYCH_PDF },
      { source: 'canvas-syllabus', name: 'Syllabus page', url: null, text: 'Office hours: Monday 2-3pm.' },
    ])
    expect(picked?.doc.name).toBe('syllabus.pdf')
    expect(picked?.weights.items).toHaveLength(4)
  })

  test('null when nothing has weights', () => {
    expect(pickSyllabus([{ source: 'canvas-syllabus', name: 'Syllabus page', url: null, text: 'TBA' }])).toBeNull()
    expect(pickSyllabus([{ source: 'canvas-file', name: 'x.pdf', url: null, pdfBase64: 'AAAA' }])).toBeNull()
  })
})

// ---------------------------------------------------------------- PDF text

/** A tiny real PDF (built here, not stored): "Grading", then a table row drawn as two pieces. */
function tinyPdfBase64(): string {
  const lines: [number, number, string][] = [
    [72, 720, 'Grading'],
    [72, 700, 'Homework'],
    [300, 700, '40%'],
    [72, 680, 'Final Exam'],
    [300, 680, '60%'],
  ]
  const content = 'BT /F1 12 Tf ' + lines.map(([x, y, t]) => `1 0 0 1 ${x} ${y} Tm (${t}) Tj`).join(' ') + ' ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return btoa(pdf)
}

describe('PDF to text', () => {
  test('pieces on the same height join into one line, top to bottom, left to right', () => {
    expect(
      piecesToLines([
        { str: '15%', x: 300, y: 700 },
        { str: 'Homework', x: 72, y: 700.5 },
        { str: 'Grading', x: 72, y: 720 },
        { str: ' ', x: 10, y: 600 },
      ]),
    ).toEqual(['Grading', 'Homework 15%'])
  })

  test('a ligature drawn as its own piece stays inside its word ("Of" + "fi" + "ce" = "Office")', () => {
    expect(
      piecesToLines([
        { str: 'Instructor office hours. Of', x: 57.75, y: 680, width: 141.38, height: 12 },
        { str: 'fi', x: 199.13, y: 680, width: 6, height: 12 },
        { str: 'ce', x: 205.13, y: 680, width: 12, height: 12 },
        { str: 'Final project', x: 57.75, y: 600, width: 70, height: 12 },
        { str: 'fi', x: 131, y: 600, width: 6, height: 12 }, // a real gap before it: a new word
        { str: 'nal paper 20%', x: 137, y: 600, width: 70, height: 12 },
      ]),
    ).toEqual(['Instructor office hours. Office', 'Final project final paper 20%'])
  })

  test('pdfToText reads a real (tiny) PDF with pdf.js', async () => {
    const text = await pdfToText(tinyPdfBase64())
    expect(text).toBe('Grading\nHomework 40%\nFinal Exam 60%')
    expect(extractWeights(text).confident).toBe(true)
  }, 20_000)
})

// ---------------------------------------------------------------- import path

function course(syllabus: SyncedCourse['syllabus']): SyncedCourse {
  return {
    source: 'canvas',
    sourceId: '1',
    number: '36225',
    alsoNumbers: [],
    title: 'Probability',
    term: 'Fall 2026',
    url: 'https://canvas.cmu.edu/courses/1',
    weighted: false,
    categories: [],
    items: [],
    canvasScore: null,
    canvasGrade: null,
    scheme: null,
    syncedAt: '2026-11-12T10:00:00Z',
    syllabus,
  }
}

function payload(courses: SyncedCourse[]): SyncPayload {
  return { v: 1, kind: 'canvas', at: '2026-11-12T10:00:00Z', courses, warnings: [] }
}

describe('import path', () => {
  test('pdfsToText turns PDFs into text and drops the base64', async () => {
    const p = payload([course([{ source: 'canvas-file', name: 'syllabus.pdf', url: null, pdfBase64: 'UERG' }])])
    expect(payloadHasPdfs(p)).toBe(true)
    const out = await pdfsToText(p, async () => 'Grading\nHomework 50%\nExams 50%')
    expect(out.courses[0].syllabus).toEqual([{ source: 'canvas-file', name: 'syllabus.pdf', url: null, text: 'Grading\nHomework 50%\nExams 50%' }])
    expect(payloadHasPdfs(out)).toBe(false)
  })

  test('an unreadable PDF is dropped with a warning; the rest of the sync stays', async () => {
    const p = payload([
      course([
        { source: 'canvas-syllabus', name: 'Syllabus page', url: null, text: 'Grading\nHomework 50%\nExams 50%' },
        { source: 'canvas-file', name: 'broken.pdf', url: null, pdfBase64: 'AAAA' },
      ]),
    ])
    const out = await pdfsToText(p, async () => {
      throw new Error('bad pdf')
    })
    expect(out.courses[0].syllabus?.map((d) => d.name)).toEqual(['Syllabus page'])
    expect(out.warnings).toEqual(["Probability: couldn't read the syllabus file broken.pdf."])
  })

  test('a PDF that never finishes reading is dropped after the timeout, so the grades still save', async () => {
    const p = payload([course([{ source: 'canvas-file', name: 'stuck.pdf', url: null, pdfBase64: 'UERG' }])])
    const out = await pdfsToText(p, () => new Promise<string>(() => {}), 20)
    expect(out.courses[0].syllabus).toBeUndefined()
    expect(out.warnings).toEqual(["Probability: couldn't read the syllabus file stuck.pdf."])
  })

  test('capSyllabusText keeps at most 60 KB per course, shared between documents, and no PDFs', () => {
    const big = 'x'.repeat(100_000)
    const out = capSyllabusText(
      payload([
        course([
          { source: 'canvas-front-page', name: 'Home', url: null, text: big },
          { source: 'canvas-syllabus', name: 'Syllabus page', url: null, text: 'Grading\nHomework 100%' },
          { source: 'canvas-file', name: 'only.pdf', url: null, pdfBase64: 'UERG' },
        ]),
      ]),
    )
    const docs = out.courses[0].syllabus ?? []
    expect(docs.map((d) => d.name)).toEqual(['Home', 'Syllabus page'])
    expect(docs.reduce((t, d) => t + (d.text?.length ?? 0), 0)).toBeLessThanOrEqual(MAX_SYLLABUS_TEXT)
    expect(docs[1].text).toBe('Grading\nHomework 100%') // the short one is not squeezed out by the big one
    expect(docs.some((d) => 'pdfBase64' in d)).toBe(false)
  })

  test('trimText keeps the grading section of a long text', () => {
    const text = 'intro line\n'.repeat(10_000) + 'Grading\nHomework 50%\nExams 50%\n' + 'appendix\n'.repeat(10_000)
    const cut = trimText(text, 5_000)
    expect(cut.length).toBe(5_000)
    expect(cut).toContain('Grading\nHomework 50%\nExams 50%')
  })
})
