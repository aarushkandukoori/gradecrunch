// "QPA extras" in Settings: college, cumulative QPA (current QPA + units so far from SIO) and the Dean's List check.
import { COLLEGES } from '../lib/cmu'
import { formatQpa } from '../lib/format'
import type { QpaResult, Settings } from '../types'
import { NumberField } from './NumberField'
import { CheckIcon } from './icons'

interface Props {
  qpa: QpaResult
  settings: Settings
  onSettings: (patch: Partial<Settings>) => void
  newestTerm: boolean // cumulative QPA only makes sense for the newest term (the SIO QPA already has older ones)
}

export function QpaExtras({ qpa, settings, onSettings, newestTerm }: Props) {
  const college = COLLEGES.find((c) => c.key === settings.college)

  return (
    <div className="settings-block qpa-extras">
      <h3>QPA extras</h3>

      <label className="field">
        <span>College (for Dean's List)</span>
        <select value={settings.college ?? ''} onChange={(e) => onSettings({ college: e.target.value || null })}>
          <option value="">Not set</option>
          {COLLEGES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {newestTerm ? (
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
              label="Units so far"
              value={settings.priorUnits}
              min={0}
              max={1000}
              placeholder="96"
              onCommit={(v) => onSettings({ priorUnits: v })}
            />
          </div>
          <p className="muted small">
            {qpa.cumulativeQpa != null ? (
              <>
                Cumulative after this semester: <strong className="num">{formatQpa(qpa.cumulativeQpa)}</strong>.{' '}
              </>
            ) : null}
            Find both in SIO under Academics, then Grades (factorable units).
          </p>
        </>
      ) : (
        <p className="muted small">Cumulative QPA shows for your newest term only. Your SIO QPA already counts this one.</p>
      )}

      {qpa.deansList ? (
        <p className="deans">
          <span>
            Dean's List ({qpa.deansList.college}): {qpa.deansList.threshold.toFixed(2)}+ with {qpa.deansList.minUnits}+
            factorable units.
          </span>{' '}
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
        <p className="muted small">Pick your college to check Dean's List.</p>
      )}
    </div>
  )
}
