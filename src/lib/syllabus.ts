// Reads the real grading weights out of a course syllabus.
//
// Why: many instructors set up Canvas weights badly (or not at all), so Canvas's own grade is often wrong. The
// syllabus is what the instructor actually grades by. The Canvas sync brings the syllabus (the Syllabus page, the
// home page, or a syllabus PDF from Files) and this file turns it into weights:
//
//   pdfToText       PDF bytes (base64) -> plain text with line breaks (pdf.js, loaded only when a PDF shows up)
//   extractWeights  text -> [{ label: "Homework", percent: 15 }, ...] plus drop rules ("lowest quiz is dropped")
//   pickSyllabus    several documents -> the one whose weights we trust
//   matchWeights    syllabus labels -> the course's categories ("Midterm 2" -> the Canvas group "Exam 2")
//   moveTargets     items sitting in the wrong group (one Canvas group holding workbooks, attendance and a midterm)
//   pdfsToText / capSyllabusText   the import path: no PDFs and at most 60 KB of syllabus text per course get saved
//
// Everything except pdfToText is plain string work, so it is easy to test with made-up syllabus text.
import type { SyllabusDoc, SyncPayload } from '../types'
import { normalizeName } from './categorize'

// ---------------------------------------------------------------- types

/** One graded part of the course as the syllabus states it. */
export interface SyllabusItem {
  label: string // cleaned up, e.g. "Homework", "Midterm 2", "Final Exam"
  percent: number // share of the course grade, 0-100
  bonus?: boolean // extra credit: not counted in `total`
}

/** "The lowest two quiz scores are dropped" -> { label: "quiz", dropLowest: 2 }. */
export interface DropRule {
  label: string
  dropLowest: number
}

export interface SyllabusWeights {
  items: SyllabusItem[]
  total: number // sum of the non-bonus items
  confident: boolean // one grading block whose items add up to 100%
  drops: DropRule[]
}

// ---------------------------------------------------------------- PDF -> text

/** A piece of text pdf.js found on a page, with its position (only the fields we use). */
export interface PdfTextPiece {
  str: string
  x: number
  y: number
  width?: number // how wide the piece is on the page; lets us tell "Of" + "fi" + "ce" (one word) from two words
  height?: number // roughly the font size
}

/**
 * Pieces of one page -> text lines. pdf.js returns text in drawing order, which for tables is often cell by cell,
 * so we group pieces by their height on the page (same y = same line) and read each line left to right. That keeps
 * a table row like "Homework | 15%" on one line, which is the shape extractWeights reads best.
 */
export function piecesToLines(pieces: PdfTextPiece[]): string[] {
  const rows: { y: number; pieces: PdfTextPiece[] }[] = []
  for (const p of pieces) {
    if (!p.str.trim()) continue
    // Pieces less than 3 units apart vertically are on the same line (superscripts and rounding wobble a bit).
    const row = rows.find((r) => Math.abs(r.y - p.y) < 3)
    if (row) row.pieces.push(p)
    else rows.push({ y: p.y, pieces: [p] })
  }
  // PDF y grows upward, so the top line has the biggest y.
  rows.sort((a, b) => b.y - a.y)
  return rows.map((r) => joinPieces(r.pieces.sort((a, b) => a.x - b.x)))
}

/**
 * One line's pieces (left to right) -> text. Usually a space goes between pieces, but PDFs often draw ligatures
 * like "fi" as their own piece, right against its neighbours: "Of" + "fi" + "ce". When a piece starts where the
 * previous one ended (a gap smaller than a tenth of the font size), they are one word and get no space.
 */
function joinPieces(pieces: PdfTextPiece[]): string {
  let text = ''
  let end: number | null = null // where the previous piece ended, when we know its width
  for (const p of pieces) {
    const gap = end === null ? Infinity : p.x - end
    const touching = gap < Math.max(0.5, 0.1 * (p.height || 10)) && !/^\s/.test(p.str)
    text += (text && !touching ? ' ' : '') + p.str.trim()
    end = p.width ? p.x + p.width : null
    if (/\s$/.test(p.str)) end = null // a piece ending in a space is never glued to the next one
  }
  return text
}

/** Base64 -> bytes. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * PDF (base64) -> plain text, pages in order, one text line per line. pdf.js is big (about 1.5 MB with its
 * worker), so it is imported only here, the first time a syllabus PDF arrives. Vite bundles the worker as a local
 * file (the "?url" import), because the site's Content-Security-Policy only allows scripts from our own origin.
 */
export async function pdfToText(base64: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist')
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  }
  // No fonts, no WebAssembly: we only read the text, and the CSP would block wasm anyway. Errors only in the
  // console (it otherwise warns about font files we never need for text).
  const task = pdfjs.getDocument({
    data: base64ToBytes(base64),
    useWasm: false,
    disableFontFace: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  })
  try {
    const doc = await task.promise
    const pages: string[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      const pieces: PdfTextPiece[] = []
      for (const it of content.items) {
        // Items without `str` are marked-content markers, not text.
        if ('str' in it) {
          const x = Number(it.transform[4]) || 0
          const y = Number(it.transform[5]) || 0
          pieces.push({ str: it.str, x, y, width: Number(it.width) || 0, height: Number(it.height) || 0 })
        }
      }
      pages.push(piecesToLines(pieces).join('\n'))
    }
    return pages.join('\n')
  } finally {
    void task.destroy() // frees the worker's copy of the file
  }
}

// ---------------------------------------------------------------- text cleanup

/** HTML -> text lines, in case a source still hands us HTML. Tags that end a block become line breaks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol|section|blockquote)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '  ') // table cells on one row stay on one line
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
}

/** Text -> trimmed, non-empty lines with single spaces. */
function toLines(text: string): string[] {
  const plain = /<\/?(p|div|br|td|li|h\d|table)\b/i.test(text) ? htmlToText(text) : text
  return plain
    .split(/\r?\n/)
    .map((l) => l.replace(/[\s ]+/g, ' ').trim())
    .filter((l) => l !== '')
}

// ---------------------------------------------------------------- kinds of work

export type Kind = 'project' | 'workbook' | 'quiz' | 'lab' | 'paper' | 'final' | 'exam' | 'homework' | 'participation' | 'other'

// Checked top to bottom, first hit wins, so mixed names land right: "Final Project" is a project, "Final Paper" a
// paper, "Recitation Quiz" a quiz, "Final Exam" a final (kept apart from midterms on purpose).
const KINDS: [Kind, RegExp][] = [
  ['project', /\bprojects?\b/],
  ['workbook', /\bworkbooks?\b/],
  ['quiz', /\b(quiz|quizzes|quizes)\b/],
  ['lab', /\b(labs?|laboratory)\b/],
  ['paper', /\b(papers?|essays?|responses?|reflections?|writing|written assignments?|reports?)\b/],
  ['final', /\bfinals?\b/],
  ['exam', /\b(exams?|examinations?|midterms?|mid-terms?|tests?)\b/],
  ['homework', /\b(homeworks?|hws?|problem sets?|psets?|ps|assignments?|exercises?)\b/],
  ['participation', /\b(participation|attendance|recitations?|lectures?|clickers?|engagement|discussions?)\b/],
]

/** Lowercase, parentheses removed, letters split from digits ("HW1" -> "hw 1"). */
function plainName(name: string): string {
  return name
    .replace(/\([^()]*\)/g, ' ')
    .replace(/([a-z])(\d)/gi, '$1 $2')
    .toLowerCase()
}

/** What kind of work a name describes: "Average Quiz Score" -> quiz, "Exam 2" -> exam, "Survey" -> other. */
export function kindOf(name: string): Kind {
  const s = plainName(name)
  for (const [kind, re] of KINDS) if (re.test(s)) return kind
  return 'other'
}

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4 }
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4 }

/** The number in a name, if any: "Midterm 2" -> 2, "Exam II" -> 2, "Second Midterm" -> 2, "Homework" -> null. */
export function numberOf(name: string): number | null {
  const s = plainName(name)
  const digits = s.match(/\b(\d{1,2})\b/)
  if (digits) return Number(digits[1])
  const roman = s.match(/\b(?:midterm|exam|test|quiz|project|paper|essay)\s+(i{1,3}|iv)\b/)
  if (roman) return ROMAN[roman[1]]
  const ordinal = s.match(/\b(first|second|third|fourth)\b/)
  return ordinal ? ORDINALS[ordinal[1]] : null
}

// ---------------------------------------------------------------- percent lines

const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*%/g
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }

// Lines that mention a percent but are not a grade weight.
const CUTOFF_WORDS = /\b(above|below|or (higher|more|better|lower|less)|at least|minimum|cutoffs?|threshold)\b|[≥≤<>]/i
const RANGE = /(\d{2,3}(?:\.\d+)?\s*%?|\d\s*%)\s*(?:-|–|—|to)\s*\d{1,3}(?:\.\d+)?\s*%/ // "90-100%", "80% - 89.9%"
const PENALTY = /\b(late|penalt|deduct|per (day|hour)|reduc|lose|loss of|extensions?|plagiar)/i
const POLICY = /\b(absen|attend(ed|ing)? (at least|more than)|miss(ed|ing)? more than|of (the |all )?(classes|lectures|sessions|meetings|recitations))/i
const DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}\b|\b(mon|tues|wednes|thurs|fri)day\b/i
const LETTER_GRADE = /^(?:grade\s+)?[a-dfr][+-]?$/i
const BONUS = /\b(extra credit|bonus|optional)\b/i
// A label starting like a sentence ("About 20% of the readings...", "The proposal counts for 10%...") is prose.
const PROSE_START = /^(the|this|that|these|those|your|you|we|it|its|each|every|all|any|about|approximately|roughly|around|if|when|only|at|in|on|for|to)\s/i

/** A line that is only a heading-ish grading title: "Grading", "Grade Breakdown:", "Course Evaluation". */
const GRADING_HEADING = /\b(grading|grades?|grade breakdown|evaluation|assessments?|weights?|weighting|marking)\b/i

function isGradingHeading(line: string): boolean {
  return line.length <= 80 && GRADING_HEADING.test(line) && !/\d\s*%/.test(line)
}

/** "Midterms" -> "Midterm", "Quizzes" -> "Quiz": used when "2 x 20%" becomes "Midterm 1" and "Midterm 2". */
function singular(word: string): string {
  if (/zzes$/i.test(word)) return word.slice(0, -3)
  if (/ies$/i.test(word)) return word.slice(0, -3) + 'y'
  if (/(ss|x|ch|sh)es$/i.test(word)) return word.slice(0, -2)
  if (/[^s]s$/i.test(word)) return word.slice(0, -1)
  return word
}

/**
 * Raw text around a percent -> a short label, or null when it is not a name of graded work.
 * "• Average Homework Score:" -> "Homework", "Midterm 1 (Oct 8) -" -> "Midterm 1", "A" -> null (a letter cutoff).
 */
function cleanLabel(raw: string): string | null {
  let s = raw
    .replace(/\([^()]*\)/g, ' ') // "(in class)", "(Oct 8)"
    .replace(/\(\s*$/, ' ') // "Homework (" before "15%)"
    .replace(/^[\s•·*▪◦●○>\-–—]+/, '') // bullets
    .replace(/^(\d{1,2}|[a-h]|[ivx]{1,4})[.)]\s+/i, '') // "1. ", "a) "
    .replace(/^of (the |your )?(final |course |overall )?grade( is| for| comes from)?\s*/i, '') // "15% of your grade is homework"
  // Filler at either end: punctuation and words like "worth" / "counts for".
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/[\s:;=|,.…\-–—()]+$/, '')
      .replace(/^[\s:;=|,.…\-–—()]+/, '')
      .replace(/\s+(is|are|worth|counts?( for)?|weighted( at)?|accounts? for|will count( for)?|of|up to)$/i, '')
  }
  // "Exams: Midterm 1" -> "Midterm 1" (a group name in front of the item).
  const colon = s.lastIndexOf(':')
  if (colon > 0 && /[a-z]/i.test(s.slice(colon + 1))) s = s.slice(colon + 1)
  s = s
    .replace(/^average\s+(of\s+)?(all\s+|your\s+)?/i, '') // "Average Homework Score" -> "Homework Score"
    .replace(/\s+(scores?|grades?|average)$/i, '') // -> "Homework"
    .replace(/\s+/g, ' ')
    .trim()
  if (!/[a-z]/i.test(s)) return null
  if (s.length > 50 || s.split(' ').length > 7) return null // a sentence, not a name ("You must attend 80% of ...")
  if (PROSE_START.test(s)) return null
  if (LETTER_GRADE.test(s.replace(/[\s\d.:=\-–]+$/, ''))) return null // "A", "B+", "F 0-"
  if (/^(total|overall|course grade|final grade|grade)$/i.test(s)) return null
  if (DATE.test(s)) return null // a schedule line, not the grading section
  return s
}

/** A pair found on one line, before blocks are formed. */
interface RawPair extends SyllabusItem {
  line: number
}

/** "2 x 20%" / "2 @ 20%" just before a percent -> 2, else 1. */
function countBefore(text: string): { count: number; rest: string } {
  const m = text.match(/(\d|one|two|three|four|five|six)\s*(?:x|×|\*|@)\s*$/i)
  if (!m) return { count: 1, rest: text }
  const word = m[1].toLowerCase()
  return { count: NUMBER_WORDS[word] ?? Number(word), rest: text.slice(0, m.index) }
}

/** "Two Midterms" / "2 Midterms" at the start of a label -> 2 (used with "20% each"). */
function countInLabel(label: string): { count: number; label: string } {
  const m = label.match(/^(\d|one|two|three|four|five|six)\s+(.+)$/i)
  if (!m) return { count: 1, label }
  const word = m[1].toLowerCase()
  return { count: NUMBER_WORDS[word] ?? Number(word), label: m[2] }
}

/** One label + percent, possibly "N of them", turned into syllabus items ("Midterms" x2 -> Midterm 1, Midterm 2). */
function expand(rawLabel: string, each: number, count: number, line: number, bonusLine: boolean): RawPair[] {
  const label = rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1)
  const bonus = bonusLine || BONUS.test(label)
  if (count <= 1) return [{ label, percent: each, line, ...(bonus ? { bonus } : {}) }]
  // A handful of separate exams/papers become numbered items so they can match "Exam 1" / "Exam 2" groups.
  // "10 x 1%" quizzes stay one item: ten numbered quiz categories would only clutter the class page.
  if (count > 4) return [{ label, percent: each * count, line, ...(bonus ? { bonus } : {}) }]
  const words = label.split(' ')
  words[words.length - 1] = singular(words[words.length - 1])
  const base = words.join(' ')
  const out: RawPair[] = []
  for (let n = 1; n <= count; n++) out.push({ label: `${base} ${n}`, percent: each, line, ...(bonus ? { bonus } : {}) })
  return out
}

/** Should this whole line be ignored? (letter cutoffs, late penalties, attendance rules) */
function skipLine(line: string): boolean {
  return CUTOFF_WORDS.test(line) || RANGE.test(line) || PENALTY.test(line) || POLICY.test(line)
}

/** Every label/percent pair on one line. Handles "Homework: 15%", "Homework (15%)", "15% Homework", "2 x 20%". */
function pairsInLine(line: string, index: number): RawPair[] {
  if (skipLine(line)) return []
  const tokens = [...line.matchAll(PERCENT)].filter((m) => Number(m[1]) > 0 && Number(m[1]) <= 100)
  if (tokens.length === 0) return []
  const bonusLine = BONUS.test(line)
  const out: RawPair[] = []

  // Percent first ("15% Homework, 15% Quizzes", or "Evaluation: 40% Homework, 60% Exams"): the label is the text
  // after each percent.
  const beforeFirst = line.slice(0, tokens[0].index)
  const last = tokens[tokens.length - 1]
  const afterLast = line.slice((last.index as number) + last[0].length)
  // ("Homework: 15% of the final grade" is still label first: nothing after the percent is a name.)
  const percentFirst = !/[a-z]/i.test(beforeFirst) || (/:\s*$/.test(beforeFirst) && cleanLabel(afterLast) !== null)

  tokens.forEach((t, i) => {
    const start = t.index as number
    const end = start + t[0].length
    const prevEnd = i === 0 ? 0 : (tokens[i - 1].index as number) + tokens[i - 1][0].length
    const nextStart = i + 1 < tokens.length ? (tokens[i + 1].index as number) : line.length
    const percent = Number(t[1])
    let count = 1
    let rawLabel: string
    if (percentFirst) {
      rawLabel = line.slice(end, nextStart)
    } else {
      const before = countBefore(line.slice(prevEnd, start))
      count = before.count
      rawLabel = before.rest
    }
    // "Two midterms (20% each)": the percent is per item.
    const each = /^\s*\)?\s*each\b/i.test(line.slice(end, end + 12))
    let label = cleanLabel(rawLabel)
    if (!label) return
    // "Readings 20% of which are optional": a label that names no kind of work, followed by a sentence, is prose.
    const after = line.slice(end, nextStart).replace(/\([^()]*\)/g, ' ')
    const sentenceAfter = after.trim().split(/\s+/).length >= 3 && !/^\s*of (the |your )?(final |course |overall |total )?grade/i.test(after)
    if (!percentFirst && kindOf(label) === 'other' && sentenceAfter) return
    if (each && count === 1) {
      const c = countInLabel(label)
      count = c.count
      label = c.label
    }
    out.push(...expand(label, percent, count, index, bonusLine))
  })
  return out
}

/** A line that is only a percent: the second half of a table row split across lines ("Homework" / "15%"). */
const PERCENT_ONLY = /^\(?(\d{1,3}(?:\.\d+)?)\s*%\)?$/

/** All pairs in the text, with the line each came from. */
function findPairs(lines: string[]): RawPair[] {
  const pairs: RawPair[] = []
  lines.forEach((line, i) => {
    const only = line.match(PERCENT_ONLY)
    if (only && i > 0 && !/\d\s*%/.test(lines[i - 1]) && !skipLine(lines[i - 1])) {
      const label = cleanLabel(lines[i - 1])
      const percent = Number(only[1])
      if (label && percent > 0 && percent <= 100) pairs.push(...expand(label, percent, 1, i, false))
      return
    }
    pairs.push(...pairsInLine(line, i))
  })
  return pairs
}

// ---------------------------------------------------------------- grading blocks

/** Pairs this many lines apart (or closer) belong to the same block. Room for a short description under each. */
const BLOCK_GAP = 8

interface Block {
  pairs: RawPair[]
  first: number // first line
  last: number // last line
}

function totalOf(items: SyllabusItem[]): number {
  return Math.round(items.filter((i) => !i.bonus).reduce((t, i) => t + i.percent, 0) * 100) / 100
}

/** The same label and percent twice in one block (a table and a sentence repeating it) counts once. */
function dedupe(pairs: RawPair[]): RawPair[] {
  const seen = new Set<string>()
  return pairs.filter((p) => {
    const key = `${normalizeName(p.label)}|${p.percent}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function blocksOf(pairs: RawPair[]): Block[] {
  const blocks: Block[] = []
  for (const p of pairs) {
    const last = blocks[blocks.length - 1]
    if (last && p.line - last.last <= BLOCK_GAP) {
      last.pairs.push(p)
      last.last = p.line
    } else {
      blocks.push({ pairs: [p], first: p.line, last: p.line })
    }
  }
  return blocks
}

const close100 = (total: number) => total >= 99 && total <= 101

/** "The lowest homework score is dropped", "We drop the two lowest quizzes" -> drop rules. */
function findDrops(lines: string[]): DropRule[] {
  const drops: DropRule[] = []
  const sentences = lines.flatMap((l) => l.split(/(?<=[.!?;])\s+/))
  for (const s of sentences) {
    if (!/\bdrop/i.test(s) || !/\b(lowest|worst)\b/i.test(s)) continue
    if (/\b(not|no|never|cannot|can't|won't)\b/i.test(s)) continue
    const n =
      s.match(/\b(?:lowest|worst)\s+(\d|one|two|three|four|five)\b/i) ?? s.match(/\b(\d|one|two|three|four|five)\s+(?:lowest|worst)\b/i)
    const count = n ? (NUMBER_WORDS[n[1].toLowerCase()] ?? Number(n[1])) : 1
    // The kind of work named first in the sentence.
    let best: { label: string; at: number } | null = null
    const lower = plainName(s)
    for (const [kind, re] of KINDS) {
      if (kind === 'final') continue // "the final can replace..." is never a drop rule
      const m = lower.match(re)
      if (m && m.index !== undefined && (!best || m.index < best.at)) best = { label: m[0], at: m.index }
    }
    if (!best || count < 1) continue
    if (!drops.some((d) => kindOf(d.label) === kindOf(best.label))) drops.push({ label: best.label, dropLowest: count })
  }
  return drops
}

/**
 * Finds the grading weights in a syllabus. Picks the block of label/percent lines that adds up to 100 (preferring
 * one right after a "Grading" heading). `confident` is true only when one block adds up to 100% (99-101 for
 * rounding; extra credit items are left out of the total).
 */
export function extractWeights(text: string): SyllabusWeights {
  const empty: SyllabusWeights = { items: [], total: 0, confident: false, drops: [] }
  if (typeof text !== 'string' || text.trim() === '') return empty
  const lines = toLines(text)
  const drops = findDrops(lines)
  const blocks = blocksOf(findPairs(lines))
  if (blocks.length === 0) return { ...empty, drops }

  const headings = lines.map((l, i) => (isGradingHeading(l) ? i : -1)).filter((i) => i >= 0)
  const nearHeading = (b: Block) => headings.some((h) => h <= b.last && b.first - h <= 15)

  // Candidates: every block, plus runs of neighboring blocks after a grading heading (a long paragraph under each
  // item can split one grading section into several blocks).
  interface Candidate {
    pairs: RawPair[]
    merged: boolean
    heading: boolean
  }
  const candidates: Candidate[] = []
  blocks.forEach((b, i) => {
    candidates.push({ pairs: dedupe(b.pairs), merged: false, heading: nearHeading(b) })
    if (!nearHeading(b)) return
    let pairs = [...b.pairs]
    for (let j = i + 1; j < blocks.length && j <= i + 6 && blocks[j].first - blocks[j - 1].last <= 40; j++) {
      pairs = [...pairs, ...blocks[j].pairs]
      candidates.push({ pairs: dedupe(pairs), merged: true, heading: true })
    }
  })

  // Best: adds up to 100, then near a heading, then not merged, then first in the text.
  let best: Candidate | null = null
  let bestScore = -Infinity
  for (const c of candidates) {
    const score = (close100(totalOf(c.pairs)) ? 100 : 0) + (c.heading ? 10 : 0) + (c.merged ? 0 : 5) + Math.min(c.pairs.length, 4)
    if (score > bestScore) {
      best = c
      bestScore = score
    }
  }
  const chosen = best as Candidate
  const items: SyllabusItem[] = chosen.pairs.map(({ label, percent, bonus }) => (bonus ? { label, percent, bonus } : { label, percent }))
  const total = totalOf(items)
  // A merged run only counts when a grading heading starts it; at least two parts (a lone "100%" is not a breakdown).
  const confident = close100(total) && items.filter((i) => !i.bonus).length >= 2 && (!chosen.merged || chosen.heading)
  return { items, total, confident, drops }
}

// Building courses runs on every change (each typed what-if), so remember results for texts we already read.
const cache = new Map<string, SyllabusWeights>()

function extractCached(text: string): SyllabusWeights {
  const hit = cache.get(text)
  if (hit) return hit
  const result = extractWeights(text)
  if (cache.size > 50) cache.clear()
  cache.set(text, result)
  return result
}

// The Syllabus page is the instructor's own grading page; a PDF in Files is next; the home page is a last resort.
const SOURCE_ORDER: SyllabusDoc['source'][] = ['canvas-syllabus', 'canvas-file', 'canvas-front-page']

/** The first document (in SOURCE_ORDER) whose weights we trust, or null. */
export function pickSyllabus(docs: SyllabusDoc[]): { doc: SyllabusDoc; weights: SyllabusWeights } | null {
  const sorted = [...docs].sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source))
  for (const doc of sorted) {
    if (typeof doc.text !== 'string' || !doc.text) continue
    const weights = extractCached(doc.text)
    if (weights.confident) return { doc, weights }
  }
  return null
}

// ---------------------------------------------------------------- matching syllabus labels to categories

/** What matching needs to know about a category. `size` = items worth points in it (used to break ties). */
export interface CategoryRef {
  key: string
  name: string
  size?: number
  weight?: number | null
}

export interface WeightPlan {
  weights: Record<string, number> // every given category key -> its weight (0 when the syllabus doesn't mention it)
  added: { key: string; name: string; weight: number }[] // syllabus items with no category: new, empty, planned
}

/** Among several fitting categories, the one that holds work, then one Canvas already weights, then the first. */
function bestOf(cats: CategoryRef[]): CategoryRef {
  return [...cats].sort((a, b) => Number((b.size ?? 0) > 0) - Number((a.size ?? 0) > 0) || Number((b.weight ?? 0) > 0) - Number((a.weight ?? 0) > 0))[0]
}

/**
 * The categories a syllabus label belongs to:
 *  1. same name ("Quizzes" = "Quizzes"),
 *  2. same kind and number ("Midterm 2" -> "Exam 2"),
 *  3. same kind, category without a number ("Midterm 2" -> "Exams", "Average Homework Score" -> "Homework"),
 *  4. a label without a number and only numbered categories of its kind ("Midterms 40%" -> "Exam 1" and "Exam 2",
 *     split evenly).
 * Empty when nothing fits.
 */
function targetsFor(label: string, categories: CategoryRef[]): CategoryRef[] {
  const name = normalizeName(label)
  const exact = categories.filter((c) => normalizeName(c.name) === name || singular(normalizeName(c.name)) === singular(name))
  if (exact.length > 0) return [bestOf(exact)]
  const kind = kindOf(label)
  if (kind === 'other') return []
  const sameKind = categories.filter((c) => kindOf(c.name) === kind)
  const n = numberOf(label)
  const unnumbered = sameKind.filter((c) => numberOf(c.name) === null)
  if (n !== null) {
    const sameNumber = sameKind.filter((c) => numberOf(c.name) === n)
    if (sameNumber.length > 0) return [bestOf(sameNumber)]
    return unnumbered.length > 0 ? [bestOf(unnumbered)] : []
  }
  if (unnumbered.length > 0) return [bestOf(unnumbered)]
  return sameKind
}

/** A stable key for a category the syllabus adds ("Final Exam" -> "s:finalexam"), so saved prefs keep working. */
function addedKey(label: string): string {
  return `s:${normalizeName(label) || 'item'}`
}

/**
 * Syllabus items -> a weight for every category. Unmatched syllabus items become new planned categories (empty
 * but weighted, so "what do I need" counts them, like a Final Exam with no Canvas group yet). Categories the
 * syllabus doesn't mention get 0: they stay visible but don't count.
 */
export function matchWeights(items: SyllabusItem[], categories: CategoryRef[]): WeightPlan {
  const weights: Record<string, number> = {}
  for (const c of categories) weights[c.key] = 0
  const added: WeightPlan['added'] = []
  for (const item of items) {
    const targets = targetsFor(item.label, categories)
    if (targets.length === 0) {
      const key = addedKey(item.label)
      const existing = added.find((a) => a.key === key)
      if (existing) existing.weight += item.percent
      else if (!Object.hasOwn(weights, key)) added.push({ key, name: item.label, weight: item.percent })
      continue
    }
    const share = item.percent / targets.length
    for (const t of targets) weights[t.key] = Math.round((weights[t.key] + share) * 1000) / 1000
  }
  return { weights, added }
}

/** The one category a drop rule's label ("quiz") points at, among weighted categories, or null. */
export function matchDrop(label: string, categories: CategoryRef[]): string | null {
  const targets = targetsFor(label, categories.filter((c) => (c.weight ?? 0) > 0))
  return targets.length === 1 ? targets[0].key : null
}

/**
 * Items that sit in a group of a different kind, moved to the syllabus category of their own kind. Example: one
 * Canvas group "Assignments" holds "Workbook 3", "Attendance" and "Midterm"; the syllabus weights workbooks,
 * attendance and the midterm separately, so each item goes to its own weighted category. Returns itemKey -> categoryKey.
 */
export function moveTargets(
  items: { key: string; name: string; categoryKey: string }[],
  categories: CategoryRef[],
  weights: Record<string, number>,
): Record<string, string> {
  const moves: Record<string, string> = {}
  const weighted = categories.filter((c) => (weights[c.key] ?? 0) > 0)
  for (const item of items) {
    const kind = kindOf(item.name)
    if (kind === 'other') continue
    const current = categories.find((c) => c.key === item.categoryKey)
    const currentKind = current ? kindOf(current.name) : 'other'
    if (currentKind === kind) continue
    // Only out of a group the syllabus gave no weight, plus one special case: a final sitting in the midterms' group
    // when the syllabus weights the final on its own. (Moving more eagerly sends "Exam 2 practice problems" homework
    // into the exam group.)
    const currentWeight = current ? (weights[current.key] ?? 0) : 0
    if (currentWeight > 0 && !(kind === 'final' && currentKind === 'exam')) continue
    const sameKind = weighted.filter((c) => kindOf(c.name) === kind)
    if (sameKind.length === 0) continue
    const n = numberOf(item.name)
    const sameNumber = n === null ? [] : sameKind.filter((c) => numberOf(c.name) === n)
    const unnumbered = sameKind.filter((c) => numberOf(c.name) === null)
    const target = sameNumber[0] ?? unnumbered[0] ?? (sameKind.length === 1 && n === null ? sameKind[0] : null)
    if (target && target.key !== item.categoryKey) moves[item.key] = target.key
  }
  return moves
}

// ---------------------------------------------------------------- import path

/** Most syllabus text kept per course. Enough for any real syllabus; keeps localStorage small. */
export const MAX_SYLLABUS_TEXT = 60_000

/**
 * Text cut to `max` characters, keeping the grading section: when the text is too long, the cut starts a little
 * before the first "Grading" heading instead of at the top.
 */
export function trimText(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 0) return ''
  const lines = text.split('\n')
  let offset = 0
  for (const line of lines) {
    if (isGradingHeading(line.trim()) && line.trim() !== '') {
      const start = Math.max(0, Math.min(offset - 500, text.length - max))
      return text.slice(start, start + max)
    }
    offset += line.length + 1
  }
  return text.slice(0, max)
}

/** Does this payload carry any syllabus PDF that still needs turning into text? */
export function payloadHasPdfs(payload: SyncPayload): boolean {
  return payload.courses.some((c) => (c.syllabus ?? []).some((d) => typeof d.pdfBase64 === 'string' && d.pdfBase64 !== ''))
}

/**
 * Every syllabus document reduced to text that fits the 60 KB-per-course budget, with PDFs dropped (they must be
 * turned into text first, see pdfsToText). Documents left with no text are removed. Pure: returns new courses.
 */
export function capSyllabusText(payload: SyncPayload): SyncPayload {
  const courses = payload.courses.map((c) => {
    if (!Array.isArray(c.syllabus)) return c
    const docs = c.syllabus.filter((d) => typeof d.text === 'string' && d.text.trim() !== '')
    let budget = MAX_SYLLABUS_TEXT
    const kept: SyllabusDoc[] = []
    docs.forEach((d, i) => {
      // An even share of what is left, so one huge home page can't push out the syllabus PDF after it.
      const share = Math.floor(budget / (docs.length - i))
      const text = trimText(d.text as string, share)
      budget -= text.length
      if (text) kept.push({ source: d.source, name: d.name, url: d.url, text })
    })
    const rest = { ...c }
    delete rest.syllabus
    return kept.length > 0 ? { ...rest, syllabus: kept } : rest
  })
  return { ...payload, courses }
}

/** How long one PDF may take to read. A broken or huge file must not hold up saving the grades forever. */
export const PDF_TIMEOUT_MS = 20_000

/** `promise`, or a rejection after `ms` milliseconds, whichever comes first. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Turns every syllabus PDF in a payload into text (then capSyllabusText keeps it small). A PDF that can't be read
 * (or takes longer than PDF_TIMEOUT_MS) is dropped with a warning; the rest of the sync still goes through.
 * `toText` is swappable for tests.
 */
export async function pdfsToText(
  payload: SyncPayload,
  toText: (base64: string) => Promise<string> = pdfToText,
  timeoutMs = PDF_TIMEOUT_MS,
): Promise<SyncPayload> {
  const warnings = [...payload.warnings]
  const courses = []
  for (const c of payload.courses) {
    if (!Array.isArray(c.syllabus)) {
      courses.push(c)
      continue
    }
    const docs: SyllabusDoc[] = []
    for (const d of c.syllabus) {
      if (typeof d.pdfBase64 === 'string' && d.pdfBase64 !== '') {
        try {
          const text = (await withTimeout(toText(d.pdfBase64), timeoutMs)).slice(0, 200_000)
          docs.push({ source: d.source, name: d.name, url: d.url, text })
        } catch {
          warnings.push(`${c.title || 'A course'}: couldn't read the syllabus file ${d.name}.`)
        }
      } else {
        docs.push(d)
      }
    }
    courses.push({ ...c, syllabus: docs })
  }
  return capSyllabusText({ ...payload, courses, warnings })
}
