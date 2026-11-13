// Small pure helpers that turn numbers, dates and statuses into the short strings the UI shows.
// All rounding for display happens here; the grade math itself never rounds.
import type { ItemStatus } from '../types'
import { formatCourseNumber } from './cmu'
import { roundPercent } from './grade'

/** 85.123 -> "85.1%". Empty string for missing values. */
export function formatPercent(p: number | null | undefined, digits = 1): string {
  if (p == null || !Number.isFinite(p)) return ''
  return `${p.toFixed(digits)}%`
}

/**
 * A course grade the way Canvas shows it: rounded to 2 decimals, without trailing zeros.
 * 89.96 -> "89.96%", 84 -> "84%", 89.995 -> "90%". It uses the same rounding as the letter math (roundPercent),
 * so the number never says 90 while the letter says B. (One decimal would turn 89.96 into "90.0%" next to a B.)
 */
export function formatGradePercent(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return ''
  return `${roundPercent(p)}%`
}

/** 3.5149 -> "3.51". */
export function formatQpa(q: number | null | undefined): string {
  if (q == null || !Number.isFinite(q)) return ''
  return q.toFixed(2)
}

/** Points without useless zeros: 36 -> "36", 24.25 -> "24.25", 1/3 -> "0.33". Unknown -> "?". */
export function formatPoints(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '?'
  return String(Math.round(n * 100) / 100)
}

/** "36 / 40" */
export function formatScore(score: number | null, max: number | null): string {
  return `${formatPoints(score)} / ${formatPoints(max)}`
}

/** Score as a percent of max, or '' when max is unknown or 0 (extra credit). */
export function scorePercent(score: number | null, max: number | null): string {
  if (score == null || max == null || max <= 0) return ''
  return formatPercent((score / max) * 100, 0)
}

/** "just now", "5 min ago", "2 h ago", "3 d ago"; "not synced" when there is no time. */
export function timeAgo(iso: string | undefined | null, now: number): string {
  if (!iso) return 'not synced'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'not synced'
  const minutes = Math.max(0, now - t) / 60_000
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${Math.floor(minutes)} min ago`
  const hours = minutes / 60
  if (hours < 48) return `${Math.floor(hours)} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/** "Sep 11" (adds the year when it is not this year). Empty when unknown. */
export function formatDue(iso: string | null, now: number = Date.now()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** Which color family a letter chip gets. Color is never the only signal: the letter is always printed too. */
export type LetterTone = 'a' | 'b' | 'c' | 'd' | 'r' | 'n'
export function letterTone(letter: string | null | undefined): LetterTone {
  const first = (letter ?? '').trim().toUpperCase().charAt(0)
  if (first === 'A') return 'a'
  if (first === 'B') return 'b'
  if (first === 'C') return 'c'
  if (first === 'D') return 'd'
  if (first === 'R' || first === 'F' || first === 'X' || first === 'N') return 'r' // N: a pass/fail class not passed
  return 'n' // P, W, I and anything unknown
}

/** "a B" but "an A" / "an F" / "an R" (said "ar"). */
export function article(letter: string): string {
  return /^[AEFHILMNORSX]/i.test(letter) ? 'an' : 'a'
}

export function statusLabel(status: ItemStatus, planned: boolean): string {
  if (planned) return 'Planned'
  switch (status) {
    case 'graded':
      return 'Graded'
    case 'submitted':
      return 'Submitted'
    case 'ungraded':
      return 'Ungraded'
    case 'missing':
      return 'Missing'
    case 'unsubmitted':
      return 'Not submitted'
    case 'excused':
      return 'Excused'
  }
}

/** "drops lowest 1", "drops lowest 1, highest 2", or '' when there is no drop rule. */
export function dropRuleText(c: { dropLowest: number; dropHighest: number }): string {
  const parts: string[] = []
  if (c.dropLowest > 0) parts.push(`lowest ${c.dropLowest}`)
  if (c.dropHighest > 0) parts.push(`highest ${c.dropHighest}`)
  return parts.length ? `drops ${parts.join(', ')}` : ''
}

/** "21-241" for numbered courses, else the title. */
export function courseLabel(c: { number: string | null; title: string }): string {
  return c.number ? formatCourseNumber(c.number) : c.title
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
