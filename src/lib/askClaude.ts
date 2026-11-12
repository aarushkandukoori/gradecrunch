// Builds the plain-text grade summary for the "Ask Claude about my grades" button. The student pastes it into
// Claude themselves; nothing is sent anywhere by us. It only contains course numbers, titles and numbers: no
// student names, no Canvas/Gradescope ids and no URLs.
import type { Course, GradeResult, NeededResult, QpaResult, Settings } from '../types'
import { courseLabel, dropRuleText, formatPercent, formatPoints, formatQpa } from './format'
import { estimatedLetter } from './qpa'

function neededLine(needed: NeededResult[], percent: number | null): string {
  const parts = needed.map((n) => {
    if (n.status === 'guaranteed') return `${n.letter}: guaranteed`
    if (n.status === 'possible' && n.needed != null) return `${n.letter}: need ${n.needed.toFixed(1)}% average`
    if (n.status === 'locked') return `${n.letter}: ${percent != null && percent >= n.min ? 'locked in' : 'out of reach'}`
    return `${n.letter}: out of reach`
  })
  return parts.join('; ')
}

export function buildClaudePrompt(
  courses: Course[],
  grades: Map<string, GradeResult>,
  needed: Map<string, NeededResult[]>,
  qpa: QpaResult,
  settings: Settings,
): string {
  const lines: string[] = []
  lines.push('Here are my current grades at Carnegie Mellon. They are estimates computed from Canvas and Gradescope, not official grades.')
  lines.push('Please help me understand where I stand, which classes need the most attention, and what to focus on for the rest of the semester.')
  lines.push('')

  const terms = [...new Set(courses.map((c) => c.term).filter((t): t is string => !!t))]
  if (terms.length) lines.push(`Semester: ${terms.join(', ')}`)
  lines.push(`Level: ${settings.level === 'grad' ? 'Graduate' : 'Undergraduate'}`)
  lines.push(
    settings.level === 'grad'
      ? 'CMU QPA is the units-weighted average of grade points (A+ 4.33, A 4, A- 3.67, B+ 3.33, B 3, and so on).'
      : 'CMU QPA is the units-weighted average of grade points (A 4, B 3, C 2, D 1, R 0; no plus or minus grades).',
  )
  if (qpa.semesterQpa != null) {
    lines.push(`Estimated semester QPA: ${formatQpa(qpa.semesterQpa)} from ${qpa.factorableUnits} factorable units`)
  }
  if (qpa.cumulativeQpa != null) lines.push(`Estimated cumulative QPA after this semester: ${formatQpa(qpa.cumulativeQpa)}`)
  lines.push('')

  for (const course of courses) {
    const grade = grades.get(course.key)
    const percent = grade?.percent ?? course.canvasScore ?? course.manualPercent
    const letter = estimatedLetter(course, grade, settings)

    lines.push(`${courseLabel(course)} ${course.number ? course.title : ''}`.trim() + ` (${course.units} units)`)
    lines.push(`  Current: ${percent != null ? formatPercent(percent) : 'no grades yet'}${letter ? ` (${letter})` : ''}`)
    if (course.prefs.passFail) lines.push('  Taken pass/fail')
    if (course.prefs.letter) lines.push(`  Final letter set by me: ${course.prefs.letter}`)
    if (course.categories.length) {
      lines.push(`  Grading: ${course.weighted ? 'weighted categories' : 'total points'}`)
      for (const cat of course.categories) {
        const r = grade?.categories.find((c) => c.key === cat.key)
        const bits: string[] = []
        if (course.weighted) bits.push(`weight ${formatPoints(cat.weight ?? 0)}%`)
        bits.push(
          r && r.percent != null
            ? `${formatPercent(r.percent)} (${formatPoints(r.earned)} / ${formatPoints(r.possible)} pts)`
            : 'nothing graded yet',
        )
        const drop = dropRuleText(cat)
        if (drop) bits.push(drop)
        lines.push(`  - ${cat.name}: ${bits.join(', ')}`)
      }
    }
    const need = needed.get(course.key) ?? []
    if (need.length) lines.push(`  What I need on the remaining work: ${neededLine(need, percent)}`)
    if (grade && course.items.length > 0) lines.push(`  ${grade.graded} graded, ${grade.remaining} still to come`)
    lines.push('')
  }
  return lines.join('\n').trim() + '\n'
}
