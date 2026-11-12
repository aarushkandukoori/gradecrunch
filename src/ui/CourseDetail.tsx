// The expanded part of a course card: "What you need", the categories table (edit weights), every assignment
// (what-ifs, move, ignore, planned items) and the course settings (units, final letter, pass/fail, cutoffs, hide).
import { useState, type FormEvent } from 'react'
import { courseLabel, dropRuleText, formatPercent, formatPoints } from '../lib/format'
import { isCountable } from '../lib/grade'
import { randomId, withCutoff, withPlanned, withWeight } from '../lib/store'
import { whatIfApplies, withoutWhatIfs } from '../lib/whatIfs'
import type { Course, CoursePrefs, GradeCut, GradeResult, Level, NeededResult } from '../types'
import { ItemRow } from './ItemRow'
import { LetterChip } from './LetterChip'
import { NumberField } from './NumberField'
import { PlusIcon, TrashIcon } from './icons'
import { collapseScheme, groupItems, isZeroPointPlaceholder, neededText, placeholderOnlyCategories } from './view'

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
  // Remaining items with no point values yet. When other remaining work has points, "what you need" is computed
  // from that part only, so say so.
  const unknownMax = course.items.filter((i) => i.score === null && i.max === null && isCountable(i, ignored)).length
  const someKnown = needed.some((n) => n.status !== 'unknown' && n.status !== 'locked')
  const hasCanvas = course.sources.some((s) => s.source === 'canvas')
  const included = new Set(prefs.included ?? [])
  // Zero-point placeholders (lecture notes, attendance) are hidden until the student asks to see them.
  const [showPlaceholders, setShowPlaceholders] = useState(false)
  const hiddenCats = showPlaceholders ? new Set<string>() : placeholderOnlyCategories(course)
  const placeholderCount = course.items.filter((i) => isZeroPointPlaceholder(i, prefs.whatIf)).length
  const visibleCategories = course.categories.filter((c) => !hiddenCats.has(c.key))

  return (
    <div className="detail">
      {needed.length > 0 && (
        <section className="detail-section">
          <h4>What you need</h4>
          <table className="table needed-table">
            <thead>
              <tr>
                <th scope="col">Letter</th>
                <th scope="col">Cutoff</th>
                <th scope="col">On the rest of the semester</th>
              </tr>
            </thead>
            <tbody>
              {needed.map((n) => (
                <tr key={n.letter} className={`needed-${n.status}`}>
                  <td data-label="Letter">
                    <LetterChip letter={n.letter} size="sm" />
                  </td>
                  <td data-label="Cutoff" className="num">
                    {formatPoints(n.min)}%
                  </td>
                  <td data-label="Need">{neededText(n, grade.percent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {unknownMax > 0 && someKnown && (
            <p className="muted small">
              Leaves out {unknownMax === 1 ? '1 item' : `${unknownMax} items`} whose point values aren't posted yet.
            </p>
          )}
        </section>
      )}

      {visibleCategories.length > 0 && (
        <section className="detail-section">
          <div className="section-head">
            <h4>Categories</h4>
            <label className="check">
              <input
                type="checkbox"
                checked={course.weighted}
                onChange={(e) => onPrefs((p) => ({ ...p, weighted: e.target.checked }))}
              />
              Use category weights
            </label>
            {prefs.weights && (
              <button
                type="button"
                className="link-btn"
                // Typing a weight also turned weighting on, so undo both: back to exactly what the site uses.
                onClick={() => onPrefs((p) => ({ ...p, weights: undefined, weighted: undefined }))}
              >
                Reset to {hasCanvas ? 'Canvas' : 'original'} weights
              </button>
            )}
          </div>
          <table className="table cat-table">
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Weight</th>
                <th scope="col">Score</th>
                <th scope="col">Points</th>
              </tr>
            </thead>
            <tbody>
              {visibleCategories.map((cat) => {
                const r = results.get(cat.key)
                const rule = dropRuleText(cat)
                return (
                  <tr key={cat.key} className={r && !r.counted ? 'is-muted' : ''}>
                    <td data-label="Category">
                      <span className="cat-name">{cat.name}</span>
                      {rule && <span className="muted small"> · {rule}</span>}
                    </td>
                    <td data-label="Weight">
                      <NumberField
                        label={`Weight for ${cat.name}`}
                        hideLabel
                        className="weight-field"
                        suffix="%"
                        min={0}
                        max={100}
                        placeholder={course.weighted ? '0' : '-'}
                        value={cat.weight}
                        onCommit={(v) => onPrefs((p) => withWeight(p, cat.key, v))}
                      />
                    </td>
                    <td data-label="Score" className="num">
                      {r && r.percent != null ? formatPercent(r.percent) : <span className="muted">Nothing graded</span>}
                    </td>
                    <td data-label="Points" className="num muted">
                      {r && r.possible > 0 ? `${formatPoints(r.earned)} / ${formatPoints(r.possible)}` : ''}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}

      {(course.items.length > 0 || course.categories.length > 0) && (
        <section className="detail-section">
          <div className="section-head">
            <h4>Assignments</h4>
            {placeholderCount > 0 && (
              <button type="button" className="link-btn" onClick={() => setShowPlaceholders(!showPlaceholders)}>
                {showPlaceholders ? 'Hide' : 'Show'} {placeholderCount} zero-point {placeholderCount === 1 ? 'item' : 'items'}
              </button>
            )}
            {hasWhatIf && (
              <button type="button" className="link-btn" onClick={() => onPrefs(withoutWhatIfs)}>
                Clear what-ifs
              </button>
            )}
          </div>
          {groupItems(course)
            .filter((g) => !hiddenCats.has(g.key))
            .map((g) => ({
              ...g,
              items: showPlaceholders ? g.items : g.items.filter((i) => !isZeroPointPlaceholder(i, prefs.whatIf)),
            }))
            .map((g) => (
            <div key={g.key} className="item-group">
              <h5>{g.name}</h5>
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
                      onPrefs={onPrefs}
                    />
                  ))}
                </ul>
              ) : (
                <p className="muted small">Nothing here yet.</p>
              )}
              {g.key !== '__other' && <AddPlanned categoryKey={g.key} categoryName={g.name} onPrefs={onPrefs} />}
            </div>
          ))}
        </section>
      )}

      <CourseSettings course={course} level={level} onPrefs={onPrefs} onRemove={onRemove} />
    </div>
  )
}

/** "Add planned item": a future assignment you know is coming (name + max points), to plan what-ifs around it. */
function AddPlanned({ categoryKey, categoryName, onPrefs }: { categoryKey: string; categoryName: string; onPrefs: Props['onPrefs'] }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [max, setMax] = useState('')

  function submit(e: FormEvent) {
    e.preventDefault()
    const points = Number(max)
    if (!name.trim() || !Number.isFinite(points) || points <= 0) return
    onPrefs((p) => withPlanned(p, { key: `m:${randomId()}`, name: name.trim(), categoryKey, max: points }))
    setName('')
    setMax('')
    setOpen(false)
  }

  if (!open) {
    return (
      <button type="button" className="link-btn add-planned" onClick={() => setOpen(true)}>
        <PlusIcon size={14} /> Add planned item
      </button>
    )
  }
  return (
    <form className="planned-form" onSubmit={submit}>
      <label className="field field-grow">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`Next ${categoryName.toLowerCase()}`} autoFocus />
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
  catalog: 'catalog',
  custom: 'set by you',
  default: 'default 9 - check SIO',
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
    <section className="detail-section course-settings">
      <h4>Course settings</h4>
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
          Hide this course
        </label>
      </div>

      {editableCuts.length > 0 && (
        <details className="cutoffs">
          <summary>
            Letter cutoffs <span className="muted small">({SCHEME_HINT[course.schemeSource]})</span>
          </summary>
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
        </details>
      )}

      {onRemove && (
        <button type="button" className="btn btn-danger-ghost btn-sm" onClick={remove}>
          <TrashIcon size={14} /> Remove this class
        </button>
      )}
    </section>
  )
}
