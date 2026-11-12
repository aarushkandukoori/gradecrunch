// The slim bar on each course card: runs from 50% to 100%, with a tick at each letter cutoff and a dot at the
// current percent. Purely visual (aria-hidden): the percent and letter are printed right above it.
import type { GradeCut, Level } from '../types'
import { letterTone } from '../lib/format'
import { letterFor } from '../lib/grade'
import { barPosition, collapseScheme } from './view'

export function GradeBar({ percent, scheme: fullScheme, level }: { percent: number | null; scheme: GradeCut[]; level: Level }) {
  const scheme = collapseScheme(fullScheme, level)
  // Same letter math as the chip (letterFor rounds to 2 decimals first), so 89.995 colors the bar as an A.
  const tone = letterTone(letterFor(percent, scheme))
  // Only cutoffs inside the visible 50-100 range get a tick.
  const ticks = scheme.filter((c) => c.min > 50 && c.min < 100)
  return (
    <div className="gbar" aria-hidden="true">
      <div className="gbar-track">
        {percent != null && (
          <div className={`gbar-fill tone-${tone}`} style={{ width: `${barPosition(percent)}%` }} />
        )}
        {ticks.map((c) => (
          <span key={c.letter} className="gbar-tick" style={{ left: `${barPosition(c.min)}%` }} />
        ))}
        {percent != null && <span className="gbar-dot" style={{ left: `${barPosition(percent)}%` }} />}
      </div>
      <div className="gbar-labels">
        {ticks.map((c) => (
          <span key={c.letter} style={{ left: `${barPosition(c.min)}%` }}>
            {c.letter}
          </span>
        ))}
      </div>
    </div>
  )
}
