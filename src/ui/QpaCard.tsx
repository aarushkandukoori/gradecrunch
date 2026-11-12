// The big QPA card at the top of the dashboard: estimated semester QPA, one line per course, cumulative QPA,
// Dean's List check and the "Ask Claude" button.
import { useState } from 'react'
import { COLLEGES } from '../lib/cmu'
import { formatQpa, plural } from '../lib/format'
import type { QpaResult, Settings } from '../types'
import { NumberField } from './NumberField'
import { LetterChip } from './LetterChip'
import { CheckIcon, SparkleIcon } from './icons'

interface Props {
  qpa: QpaResult
  settings: Settings
  onSettings: (patch: Partial<Settings>) => void
  onAskClaude: () => void
  onOpenSettings: () => void
}

export function QpaCard({ qpa, settings, onSettings, onAskClaude, onOpenSettings }: Props) {
  const priorSet = settings.priorQpa != null && settings.priorUnits != null && settings.priorUnits > 0
  const [editing, setEditing] = useState(false)
  const college = COLLEGES.find((c) => c.key === settings.college)

  return (
    <section className="card qpa-card" aria-labelledby="qpa-title">
      <div className="qpa-main">
        <h2 id="qpa-title" className="eyebrow">
          Estimated semester QPA
        </h2>
        <p className="qpa-big">{qpa.semesterQpa != null ? formatQpa(qpa.semesterQpa) : 'No QPA yet'}</p>
        <p className="muted">
          {qpa.factorableUnits > 0
            ? `from ${plural(qpa.factorableUnits, 'factorable unit')}`
            : 'Add grades or pick final letters to see it'}
        </p>
        <button type="button" className="btn btn-secondary btn-sm claude-btn" onClick={onAskClaude}>
          <SparkleIcon /> Ask Claude about my grades
        </button>
      </div>

      <ul className="qpa-rows" aria-label="Courses in this QPA">
        {qpa.rows.map((r) => (
          <li key={r.courseKey} className={r.factorable ? '' : 'is-muted'}>
            <span className="qpa-row-label">{r.label}</span>
            {r.letter ? <LetterChip letter={r.letter} size="sm" /> : <span className="chip chip-n chip-sm">?</span>}
            <span className="qpa-row-units">{r.units}u</span>
            {!r.factorable && r.reason && <span className="qpa-row-reason">{r.reason}</span>}
          </li>
        ))}
        {qpa.rows.length === 0 && <li className="muted">No classes this term yet.</li>}
      </ul>

      <div className="qpa-side">
        <div className="qpa-block">
          <h3 className="eyebrow">Cumulative</h3>
          {priorSet && qpa.cumulativeQpa != null && !editing ? (
            <p>
              Cumulative after this semester: <strong className="num">{formatQpa(qpa.cumulativeQpa)}</strong>{' '}
              <button type="button" className="link-btn" onClick={() => setEditing(true)}>
                Edit
              </button>
            </p>
          ) : (
            <>
              <div className="qpa-inputs">
                <NumberField
                  label="Current cumulative QPA"
                  value={settings.priorQpa}
                  min={0}
                  max={4.33}
                  placeholder="3.50"
                  onCommit={(v) => onSettings({ priorQpa: v })}
                />
                <NumberField
                  label="Factorable units so far"
                  value={settings.priorUnits}
                  min={0}
                  max={1000}
                  placeholder="96"
                  onCommit={(v) => onSettings({ priorUnits: v })}
                />
              </div>
              <p className="muted small">
                Find both in SIO &gt; Academics &gt; Grades
                {editing && (
                  <>
                    {' · '}
                    <button type="button" className="link-btn" onClick={() => setEditing(false)}>
                      Done
                    </button>
                  </>
                )}
              </p>
            </>
          )}
        </div>

        <div className="qpa-block">
          <h3 className="eyebrow">Dean's List</h3>
          {qpa.deansList ? (
            <p className="deans">
              <span>
                Dean's List ({qpa.deansList.college}): {qpa.deansList.threshold.toFixed(2)}+ with{' '}
                {qpa.deansList.minUnits}+ factorable units
              </span>
              {qpa.deansList.eligible ? (
                <span className="deans-yes">
                  <CheckIcon /> On track
                </span>
              ) : (
                <span className="deans-no">Not yet</span>
              )}
            </p>
          ) : college ? (
            <p className="muted small">{college.note || "Dean's List can't be estimated for this college."}</p>
          ) : (
            <p className="muted small">
              <button type="button" className="link-btn" onClick={onOpenSettings}>
                Pick your college in settings
              </button>{' '}
              to check Dean's List
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
