// The body of a class page: "What you need", every assignment grouped by category (what-ifs behind a switch,
// move, ignore) and, folded away under "Edit this class", the class settings: weights, units, final letter,
// pass/fail, hide, letter cutoffs, planned items and remove.
import { useState, type FormEvent } from 'react'
import { courseLabel, dropRuleText, formatPercent } from '../lib/format'
import { isCountable } from '../lib/grade'
import { randomId, withCutoff, withPlanned, withWeight } from '../lib/store'
import { activeWhatIfs, whatIfApplies, withoutWhatIfs } from '../lib/whatIfs'
import type { Course, CoursePrefs, GradeCut, GradeResult, Level, NeededResult } from '../types'
import { ItemRow } from './ItemRow'
import { NumberField } from './NumberField'
import { PlusIcon, TrashIcon } from './icons'
import { collapseScheme, groupItems, isZeroPointPlaceholder, neededLine, placeholderOnlyCategories, weightSum } from './view'

interface Props {
  course: Course
  grade: GradeResult
  needed: NeededResult[]
  level: Level
  onPrefs: (change: (p: CoursePrefs) => CoursePrefs) => void
  onRemove?: () => void // only for hand-added courses
}

export function CourseDetail({ course, grade, needed, level, onPrefs, onRemove }: Props) {
  const prefs = course.prefs
  const results = new Map(grade.categories.map((c) => [c.key, c]))
  const dropped = new Set(grade.categories.flatMap((c) => c.dropped))
  const ignored = new Set(prefs.ignored ?? [])
  // Any saved what-if, even one that no longer applies (its item got a real score), so it can still be cleared.
  const hasWhatIf = Object.keys(prefs.whatIf ?? {}).length > 0
  const whatIfCount = activeWhatIfs(course).length
  // The switch starts on when this class already has what-ifs, so the student can see them.
  const [whatIfMode, setWhatIfMode] = useState(hasWhatIf)
  // Remaining items with no point values yet. When other remaining work has points, "what you need" is computed
  // from that part only, so say so.
  const unknownMax = course.items.filter((i) => i.score === null && i.max === null && isCountable(i, ignored)).length
  const someKnown = needed.some((n) => n.status !== 'unknown' && n.status !== 'locked')
  const included = new Set(prefs.included ?? [])
  // Zero-point placeholders (lecture notes, attendance) are hidden until the student asks to see them.
  const [showPlaceholders, setShowPlaceholders] = useState(false)
  const hiddenCats = showPlaceholders ? new Set<string>() : placeholderOnlyCategories(course)
  const placeholderCount = course.items.filter((i) => isZeroPointPlaceholder(i, prefs.whatIf)).length
  const groups = groupItems(course)
    .filter((g) => !hiddenCats.has(g.key))
    .map((g) => ({
      ...g,
      items: showPlaceholders ? g.items : g.items.filter((i) => !isZeroPointPlaceholder(i, prefs.whatIf)),
    }))

  function toggleWhatIf(on: boolean) {
    setWhatIfMode(on)
    // Off means "show my real grade": drop the made-up scores.
    if (!on && hasWhatIf) onPrefs(withoutWhatIfs)
  }

  return (
    <div className="detail">
      {needed.length > 0 && (
        <section className="detail-section" aria-labelledby="need-title">
          <h2 id="need-title">What you need</h2>
          <ul className="needed-list">
            {needed.map((n) => (
              <li key={n.letter} className={`needed-${n.status}`}>
                <strong>{n.letter}:</strong> {neededLine(n, grade.percent)}
              </li>
            ))}
          </ul>
          {unknownMax > 0 && someKnown && (
            <p className="muted small">
              Leaves out {unknownMax === 1 ? '1 item' : `${unknownMax} items`} whose point values aren't posted yet.
            </p>
          )}
        </section>
      )}

      {(course.items.length > 0 || course.categories.length > 0) && (
        <section className="detail-section" aria-labelledby="items-title">
          <div className="section-head">
            <h2 id="items-title">Assignments</h2>
            {course.items.length > 0 && (
              <label className="switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={whatIfMode}
                  onChange={(e) => toggleWhatIf(e.target.checked)}
                />
                <span className="switch-track" aria-hidden="true" />
                Try what-if scores
              </label>
            )}
          </div>
          {whatIfMode && (
            <p className="note-whatif">
              {whatIfCount > 0
                ? `Includes ${whatIfCount === 1 ? '1 what-if score' : `${whatIfCount} what-if scores`}, not your real grade. `
                : 'Type a score next to any assignment to see what it does to your grade. '}
              {hasWhatIf && (
                <button type="button" className="link-btn" onClick={() => onPrefs(withoutWhatIfs)}>
                  Clear what-ifs
                </button>
              )}
            </p>
          )}

          {groups.map((g) => {
            const r = results.get(g.key)
            const cat = course.categories.find((c) => c.key === g.key)
            const meta: string[] = []
            if (course.weighted && cat?.weight != null) meta.push(`${Math.round(cat.weight * 100) / 100}% of grade`)
            if (r && r.percent != null) meta.push(formatPercent(r.percent))
            const rule = cat ? dropRuleText(cat) : ''
            if (rule) meta.push(rule)
            return (
              <div key={g.key} className={`item-group ${r && !r.counted ? 'is-muted' : ''}`}>
                <h3>
                  {g.name}
                  {meta.length > 0 && <span className="group-meta"> · {meta.join(' · ')}</span>}
                </h3>
                {g.items.length > 0 ? (
                  <ul className="items">
                    {g.items.map((item) => (
                      <ItemRow
                        key={item.key}
                        item={item}
                        categories={course.categories}
                        whatIf={whatIfApplies(item, prefs) ? prefs.whatIf?.[item.key] : undefined}
                        ignored={ignored.has(item.key)}
                        included={included.has(item.key)}
                        dropped={dropped.has(item.key)}
                        whatIfMode={whatIfMode}
                        onPrefs={onPrefs}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="muted small">Nothing here yet.</p>
                )}
              </div>
            )
          })}
          {placeholderCount > 0 && (
            <button type="button" className="link-btn" onClick={() => setShowPlaceholders(!showPlaceholders)}>
              {showPlaceholders ? 'Hide' : 'Show'} {placeholderCount} zero-point {placeholderCount === 1 ? 'item' : 'items'}
            </button>
          )}
        </section>
      )}

      <details className="edit-class">
        <summary>Edit this class</summary>
        <div className="edit-body">
          {course.categories.length > 0 && <Weights course={course} onPrefs={onPrefs} />}
          <CourseSettings course={course} level={level} onPrefs={onPrefs} onRemove={onRemove} />
        </div>
      </details>
    </div>
  )
}

/** Category weights from the syllabus, and the switch between weights and plain total points. */
function Weights({ course, onPrefs }: Pick<Props, 'course' | 'onPrefs'>) {
  const hasCanvas = course.sources.some((s) => s.source === 'canvas')
  const sum = weightSum(course)
  return (
    <section className="edit-section" aria-labelledby="weights-title">
      <div className="section-head">
        <h3 id="weights-title">Weights</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={course.weighted}
            onChange={(e) => onPrefs((p) => ({ ...p, weighted: e.target.checked }))}
          />
          Use weights
        </label>
      </div>
      <p className="muted small">
        {course.weighted ? 'Each category counts for its share of the grade.' : 'Using total points. Type the syllabus weights to switch.'}
      </p>
      <div className="weight-grid">
        {course.categories.map((cat) => (
          <NumberField
            key={cat.key}
            label={cat.name}
            className="weight-field"
            suffix="%"
            min={0}
            max={100}
            placeholder={course.weighted ? '0' : '-'}
            value={cat.weight}
            onCommit={(v) => onPrefs((p) => withWeight(p, cat.key, v))}
          />
        ))}
      </div>
      {course.weighted && Math.abs(sum - 100) > 0.01 && (
        <p className="note-warn small">Weights add up to {Math.round(sum * 100) / 100}%</p>
      )}
      {course.prefs.weights && (
        <button
          type="button"
          className="link-btn"
          // Typing a weight also turned weighting on, so undo both: back to exactly what the site uses.
          onClick={() => onPrefs((p) => ({ ...p, weights: undefined, weighted: undefined }))}
        >
          Reset to {hasCanvas ? 'Canvas' : 'original'} weights
        </button>
      )}
    </section>
  )
}

/** "Add a planned assignment": a future one you know is coming (name + max points), to plan what-ifs around it. */
function AddPlanned({ course, onPrefs }: Pick<Props, 'course' | 'onPrefs'>) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [max, setMax] = useState('')
  const [categoryKey, setCategoryKey] = useState(course.categories[0]?.key ?? '')

  function submit(e: FormEvent) {
    e.preventDefault()
    const points = Number(max)
    if (!name.trim() || !categoryKey || !Number.isFinite(points) || points <= 0) return
    onPrefs((p) => withPlanned(p, { key: `m:${randomId()}`, name: name.trim(), categoryKey, max: points }))
    setName('')
    setMax('')
    setOpen(false)
  }

  if (!open) {
    return (
      <button type="button" className="link-btn add-planned" onClick={() => setOpen(true)}>
        <PlusIcon size={14} /> Add a planned assignment
      </button>
    )
  }
  return (
    <form className="planned-form" onSubmit={submit}>
      <label className="field field-grow">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Final exam" autoFocus />
      </label>
      <label className="field">
        <span>Category</span>
        <select value={categoryKey} onChange={(e) => setCategoryKey(e.target.value)}>
          {course.categories.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field field-sm">
        <span>Max points</span>
        <input value={max} onChange={(e) => setMax(e.target.value)} inputMode="decimal" placeholder="100" />
      </label>
      <button type="submit" className="btn btn-secondary btn-sm">
        Add
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  )
}

const UNDERGRAD_LETTERS = ['A', 'B', 'C', 'D', 'R']
const GRAD_LETTERS = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'R']
const OTHER_LETTERS = ['P', 'N', 'W']

const UNITS_HINT: Record<Course['unitsSource'], string> = {
  catalog: 'From the CMU catalog',
  custom: 'Set by you',
  default: 'A guess. Check SIO',
}

const SCHEME_HINT: Record<Course['schemeSource'], string> = {
  canvas: 'from Canvas',
  custom: 'set by you',
  default: 'default cutoffs',
}

function CourseSettings({ course, level, onPrefs, onRemove }: Pick<Props, 'course' | 'level' | 'onPrefs' | 'onRemove'>) {
  const prefs = course.prefs
  const letters = [...(level === 'grad' ? GRAD_LETTERS : UNDERGRAD_LETTERS), ...OTHER_LETTERS]
  // A letter set in grad mode (e.g. "B-") is still in effect after switching to undergrad. Keep it in the list
  // so the box shows it (instead of "Auto") and the student can see and clear it.
  if (prefs.letter && !letters.includes(prefs.letter)) letters.unshift(prefs.letter)
  // Undergrads edit the cuts letters are really computed with: one per letter (A from 90, B from 80...), since
  // an A- in Canvas counts as an A. Grad students edit every +/- cut.
  const cuts = collapseScheme(course.scheme, level)
  // The lowest cut (R at 0) is not editable: everything below D is R.
  const editableCuts = cuts.filter((c) => c.min > 0)

  function changeCut(index: number, min: number) {
    const cut = editableCuts[index]
    // Keep the order: a letter can't need more than the one above it, or less than the one below.
    const above = editableCuts[index - 1]?.min ?? 100
    const below = editableCuts[index + 1]?.min ?? 0
    if (min > above || min < below) return
    // Undergrad: save plain A/B/C/D cuts (starting from the collapsed list, so no +/- cut overrides them).
    const base: GradeCut[] = level === 'grad' ? course.scheme : cuts
    onPrefs((p) => withCutoff(level === 'grad' ? p : { ...p, cutoffs: undefined }, base, cut.letter, min))
  }

  function remove() {
    if (!onRemove) return
    const name = courseLabel(course) || 'this class'
    if (window.confirm(`Remove ${name}? Its units, letter and other settings are deleted too.`)) onRemove()
  }

  return (
    <section className="edit-section course-settings" aria-labelledby="settings-title">
      <h3 id="settings-title">Grade and units</h3>
      <div className="settings-row">
        <div>
          <NumberField
            label="Units"
            value={course.units}
            min={0}
            max={48}
            onCommit={(v) => onPrefs((p) => ({ ...p, units: v ?? undefined }))}
          />
          <p className="muted small">{UNITS_HINT[course.unitsSource]}</p>
        </div>
        <label className="field">
          <span>Final letter</span>
          <select
            value={prefs.letter ?? ''}
            onChange={(e) => onPrefs((p) => ({ ...p, letter: e.target.value || undefined }))}
          >
            <option value="">Auto</option>
            {letters.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.passFail ?? false}
            onChange={(e) => onPrefs((p) => ({ ...p, passFail: e.target.checked || undefined }))}
          />
          Taken pass/fail
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.hidden ?? false}
            onChange={(e) => onPrefs((p) => ({ ...p, hidden: e.target.checked || undefined }))}
          />
          Hide this class
        </label>
      </div>

      {editableCuts.length > 0 && (
        <div className="cutoffs">
          <h3>
            Letter cutoffs <span className="muted small">({SCHEME_HINT[course.schemeSource]})</span>
          </h3>
          <div className="cutoff-grid">
            {editableCuts.map((c, i) => (
              <NumberField
                key={c.letter}
                label={`${c.letter} from`}
                suffix="%"
                // The box refuses numbers that would put this letter above the one before it or below the next.
                min={editableCuts[i + 1]?.min ?? 0}
                max={editableCuts[i - 1]?.min ?? 100}
                value={c.min}
                required
                onCommit={(v) => changeCut(i, v ?? c.min)}
              />
            ))}
          </div>
          {prefs.cutoffs && (
            <button type="button" className="link-btn" onClick={() => onPrefs((p) => ({ ...p, cutoffs: undefined }))}>
              Reset
            </button>
          )}
        </div>
      )}

      {course.categories.length > 0 && <AddPlanned course={course} onPrefs={onPrefs} />}

      {onRemove && (
        <button type="button" className="btn btn-danger-ghost btn-sm" onClick={remove}>
          <TrashIcon size={14} /> Remove this class
        </button>
      )}
    </section>
  )
}
