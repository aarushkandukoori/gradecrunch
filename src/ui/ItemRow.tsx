// One assignment on the class page: name, score (or status), due date, and a small menu to move it to another
// category or leave it out of the grade. With "Try what-if scores" on, it also gets a what-if score box.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { formatDue, formatPoints, formatScore, scorePercent, statusLabel } from '../lib/format'
import { withIgnored, withIncluded, withMoved, withoutPlanned, withWhatIf } from '../lib/store'
import type { Category, CoursePrefs, Item } from '../types'
import { NumberField } from './NumberField'
import { EditIcon, ExternalIcon } from './icons'

interface Props {
  item: Item
  categories: Category[]
  whatIf: number | undefined // only a what-if the grade math actually uses (see whatIfApplies)
  ignored: boolean
  included: boolean // the student chose to count an item we had skipped automatically
  dropped: boolean
  whatIfMode: boolean // "Try what-if scores" is on: show the what-if box / pencil
  onPrefs: (change: (p: CoursePrefs) => CoursePrefs) => void
}

const SOURCE_TAG: Record<Item['source'], string> = { canvas: 'Canvas', gradescope: 'Gradescope', autolab: 'Autolab', manual: 'You' }

export function ItemRow({ item, categories, whatIf, ignored, included, dropped, whatIfMode, onPrefs }: Props) {
  const [editing, setEditing] = useState(false)
  const pencilRef = useRef<HTMLButtonElement>(null)
  const refocusPencil = useRef(false) // after the what-if box closes, put focus back on the pencil
  const countable = !item.omit && item.status !== 'excused' && !ignored
  const remaining = item.score === null
  // With unknown points possible a what-if can't be turned into a percent (it would count as pure extra credit),
  // so those items get no what-if box until the site posts the points.
  const canWhatIf = whatIfMode && countable && item.max !== null
  // Remaining work always gets a what-if box; graded work gets one after clicking the edit button.
  const showWhatIf = canWhatIf && (remaining || editing || whatIf !== undefined)
  const statusKey = item.planned ? 'planned' : item.status
  // A graded score speaks for itself; any other status (missing, submitted, planned...) gets a small pill.
  const showStatus = item.planned || item.status !== 'graded'

  // When the what-if box closes, the pencil button comes back. If focus was lost with the box (Escape or Enter),
  // give it to the pencil so keyboard users keep their place; if the student moved on to something else, leave it.
  useEffect(() => {
    if (showWhatIf || !refocusPencil.current) return
    refocusPencil.current = false
    const lost = document.activeElement === null || document.activeElement === document.body
    if (lost) pencilRef.current?.focus()
  }, [showWhatIf])

  function closeWhatIf() {
    if (!remaining) refocusPencil.current = true // only graded items have a pencil to go back to
    setEditing(false)
  }

  // The "More" menu: moving to another category, ignoring, and so on.
  const actions: MenuAction[] = []
  if (categories.length > 1) {
    for (const c of categories) {
      if (c.key === item.categoryKey) continue
      actions.push({ label: `Move to ${c.name}`, run: () => onPrefs((p) => withMoved(p, item.key, c.key)) })
    }
  }
  if (item.skipReason) {
    actions.push({ label: 'Count it anyway', run: () => onPrefs((p) => withIncluded(p, item.key, true)) })
  } else {
    actions.push({
      label: ignored ? 'Include again' : 'Ignore in grade',
      run: () => onPrefs((p) => withIgnored(p, item.key, !ignored)),
    })
  }
  if (included) {
    actions.push({ label: 'Skip it again (alternate version)', run: () => onPrefs((p) => withIncluded(p, item.key, false)) })
  }
  if (item.planned) actions.push({ label: 'Remove planned item', run: () => onPrefs((p) => withoutPlanned(p, item.key)) })

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
        {(showStatus || dropped || ignored || item.omit) && (
          <span className="item-tags">
            {showStatus && <span className={`pill pill-${statusKey}`}>{statusLabel(item.status, item.planned)}</span>}
            {dropped && <span className="pill pill-dropped">Dropped</span>}
            {ignored && <span className="pill pill-ignored">Ignored</span>}
            {item.omit && <span className="pill pill-ignored">Not counted</span>}
          </span>
        )}
        {item.skipReason && <span className="item-note muted small">{item.skipReason}</span>}
      </div>

      <div className="item-score">
        {item.score !== null ? (
          <span className={whatIf !== undefined ? 'num is-replaced' : 'num'}>
            {formatScore(item.score, item.max)} <span className="muted">{scorePercent(item.score, item.max)}</span>
          </span>
        ) : item.max !== null ? (
          <span className="muted num">
            {item.maxEstimated ? `~${formatPoints(item.max)} pts` : `${formatPoints(item.max)} pts`}
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
            suffix={`/ ${formatPoints(item.max)}`}
            min={0}
            value={whatIf}
            autoFocus={editing && whatIf === undefined}
            onCommit={(v) => {
              // Typed over a real score: remember that, so the what-if keeps applying after the next sync.
              onPrefs((p) => withWhatIf(p, item.key, v, item.score !== null))
              if (v === null) closeWhatIf()
            }}
            onCancel={!remaining && whatIf === undefined ? closeWhatIf : undefined}
          />
        )}
        {canWhatIf && !remaining && !showWhatIf && (
          <button
            ref={pencilRef}
            type="button"
            className="btn-icon btn-icon-sm"
            onClick={() => setEditing(true)}
            aria-label={`Try a what-if score for ${item.name}`}
            title="Try a what-if score"
          >
            <EditIcon size={14} />
          </button>
        )}
        <RowMenu label={`More actions for ${item.name}`} actions={actions} />
      </div>
    </li>
  )
}

interface MenuAction {
  label: string
  run: () => void
}

/**
 * A "More" button that opens a small list of actions. A real button + menu (not a <select>), because a select
 * fires its change event when a keyboard user presses an arrow key on it, which would run an action by accident.
 * Keyboard: Enter / Space / Down opens it and focuses the first action, Up / Down move, Escape closes.
 */
function RowMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // On open: focus the first action, and close on a click anywhere outside.
  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  function close() {
    setOpen(false)
    buttonRef.current?.focus()
  }

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let next = -1
    if (e.key === 'ArrowDown') next = (at + 1) % buttons.length
    else if (e.key === 'ArrowUp') next = (at - 1 + buttons.length) % buttons.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = buttons.length - 1
    else if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    } else if (e.key === 'Tab') {
      setOpen(false) // let Tab move on as usual
      return
    }
    if (next >= 0) {
      e.preventDefault()
      buttons[next]?.focus()
    }
  }

  return (
    <div className="row-menu-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="row-menu"
        aria-label={label}
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span aria-hidden="true">&#8943;</span>
      </button>
      {open && (
        <div id={menuId} ref={menuRef} className="row-menu-list" role="menu" aria-label={label} onKeyDown={onMenuKey}>
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close()
                a.run()
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
