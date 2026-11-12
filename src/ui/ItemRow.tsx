// One assignment inside an expanded course: name, status, score, due date, a "what if" score box, and a small
// menu to move it to another category or leave it out of the grade.
import { useState } from 'react'
import { formatDue, formatPoints, formatScore, scorePercent, statusLabel } from '../lib/format'
import { withIgnored, withIncluded, withMoved, withoutPlanned, withWhatIf } from '../lib/store'
import type { Category, CoursePrefs, Item } from '../types'
import { NumberField } from './NumberField'
import { EditIcon, ExternalIcon } from './icons'

interface Props {
  item: Item
  categories: Category[]
  whatIf: number | undefined
  ignored: boolean
  included: boolean // the student chose to count an item we had skipped automatically
  dropped: boolean
  onPrefs: (change: (p: CoursePrefs) => CoursePrefs) => void
}

const SOURCE_TAG: Record<Item['source'], string> = { canvas: 'Canvas', gradescope: 'Gradescope', autolab: 'Autolab', manual: 'You' }

export function ItemRow({ item, categories, whatIf, ignored, included, dropped, onPrefs }: Props) {
  const [editing, setEditing] = useState(false)
  const countable = !item.omit && item.status !== 'excused' && !ignored
  const remaining = item.score === null
  // Remaining work always gets a what-if box; graded work gets one after clicking the edit button.
  const showWhatIf = countable && (remaining || editing || whatIf !== undefined)
  const statusKey = item.planned ? 'planned' : item.status

  function onMenu(value: string) {
    if (value.startsWith('move:')) onPrefs((p) => withMoved(p, item.key, value.slice(5)))
    else if (value === 'ignore') onPrefs((p) => withIgnored(p, item.key, !ignored))
    else if (value === 'remove') onPrefs((p) => withoutPlanned(p, item.key))
    else if (value === 'include') onPrefs((p) => withIncluded(p, item.key, true))
    else if (value === 'uninclude') onPrefs((p) => withIncluded(p, item.key, false))
  }

  return (
    <li className={`item ${countable ? '' : 'is-muted'}`}>
      <div className="item-main">
        <span className="item-name">
          {item.url ? (
            <a href={item.url} target="_blank" rel="noopener noreferrer">
              {item.name}
              <ExternalIcon size={12} />
            </a>
          ) : (
            item.name
          )}
        </span>
        <span className="item-tags">
          <span className="tag">{SOURCE_TAG[item.source]}</span>
          <span className={`pill pill-${statusKey}`}>{statusLabel(item.status, item.planned)}</span>
          {dropped && <span className="pill pill-dropped">Dropped</span>}
          {ignored && <span className="pill pill-ignored">Ignored</span>}
          {item.omit && <span className="pill pill-ignored">Not counted</span>}
        </span>
        {item.skipReason && <span className="item-note muted small">{item.skipReason}</span>}
      </div>

      <div className="item-score">
        {item.score !== null ? (
          <span className={whatIf !== undefined ? 'num is-replaced' : 'num'}>
            {formatScore(item.score, item.max)} <span className="muted">{scorePercent(item.score, item.max)}</span>
          </span>
        ) : item.max !== null ? (
          <span className="muted num">
            {item.maxEstimated ? `~${formatPoints(item.max)} pts (estimated)` : `${formatPoints(item.max)} pts`}
          </span>
        ) : (
          <span className="muted">Points unknown</span>
        )}
        {item.otherScore !== null && (
          <span className="note-small">
            {SOURCE_TAG[item.otherSource ?? (item.source === 'canvas' ? 'gradescope' : 'canvas')]} shows{' '}
            {formatScore(item.otherScore, item.max)}
          </span>
        )}
      </div>

      <div className="item-due">{formatDue(item.due)}</div>

      <div className="item-actions">
        {showWhatIf && (
          <NumberField
            label={`What-if score for ${item.name}`}
            hideLabel
            placeholder="what if"
            className="whatif"
            suffix={item.max !== null ? `/ ${formatPoints(item.max)}` : 'pts'}
            min={0}
            value={whatIf}
            onCommit={(v) => {
              onPrefs((p) => withWhatIf(p, item.key, v))
              if (v === null) setEditing(false)
            }}
          />
        )}
        {countable && !remaining && !showWhatIf && (
          <button
            type="button"
            className="btn-icon btn-icon-sm"
            onClick={() => setEditing(true)}
            aria-label={`Try a what-if score for ${item.name}`}
            title="Try a what-if score"
          >
            <EditIcon size={14} />
          </button>
        )}
        <select
          className="row-menu"
          aria-label={`More actions for ${item.name}`}
          value=""
          onChange={(e) => onMenu(e.target.value)}
        >
          <option value="" disabled>
            More
          </option>
          {categories.length > 1 && (
            <optgroup label="Move to category">
              {categories
                .filter((c) => c.key !== item.categoryKey)
                .map((c) => (
                  <option key={c.key} value={`move:${c.key}`}>
                    {c.name}
                  </option>
                ))}
            </optgroup>
          )}
          {item.skipReason ? (
            <option value="include">Count it anyway</option>
          ) : (
            <option value="ignore">{ignored ? 'Include again' : 'Ignore in grade'}</option>
          )}
          {included && <option value="uninclude">Skip it again (alternate version)</option>}
          {item.planned && <option value="remove">Remove planned item</option>}
        </select>
      </div>
    </li>
  )
}
