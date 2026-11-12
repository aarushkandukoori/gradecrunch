// Settings: level, theme, QPA extras (college, cumulative QPA, Dean's List), the extension's Autolab switch,
// export / import / delete everything.
import { useState, type ChangeEvent } from 'react'
import { APP_SLUG } from '../lib/brand'
import { exportStoreJson, parseStore, type Theme } from '../lib/store'
import type { QpaResult, Settings, Store } from '../types'
import { Modal } from './Modal'
import { QpaExtras } from './QpaExtras'
import { TrashIcon, WarningIcon } from './icons'

interface Props {
  open: boolean
  onClose: () => void
  store: Store
  onSettings: (patch: Partial<Settings>) => void
  theme: Theme
  onTheme: (t: Theme) => void
  onImport: (store: Store) => void
  onDeleteAll: () => void
  qpa: QpaResult
  newestTerm: boolean
  // Only when the Chrome extension is installed: whether its sync also reads Autolab (beta).
  autolab?: { on: boolean; onChange: (on: boolean) => void }
}

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/** Saves the store as a JSON file the student can import on another computer. */
function downloadStore(store: Store) {
  const blob = new Blob([exportStoreJson(store)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${APP_SLUG}-data.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function SettingsDialog(p: Props) {
  const [importError, setImportError] = useState<string | null>(null)
  const s = p.store.settings

  async function onImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // so picking the same file again still fires onChange
    if (!file) return
    setImportError(null)
    try {
      const parsed = parseStore(JSON.parse(await file.text()))
      if (!parsed) return setImportError("That file doesn't look like data exported from here.")
      if (window.confirm('Replace everything here with the data from this file?')) {
        p.onImport(parsed)
        p.onClose()
      }
    } catch {
      setImportError("Couldn't read that file. Is it the JSON file from Export data?")
    }
  }

  return (
    <Modal open={p.open} onClose={p.onClose} title="Settings">
      <div className="settings">
        <fieldset className="seg-field">
          <legend>Level</legend>
          <div className="seg">
            {(['undergrad', 'grad'] as const).map((level) => (
              <label key={level} className={s.level === level ? 'is-on' : ''}>
                <input
                  type="radio"
                  name="level"
                  checked={s.level === level}
                  onChange={() => p.onSettings({ level })}
                />
                {level === 'undergrad' ? 'Undergraduate' : 'Graduate'}
              </label>
            ))}
          </div>
          <p className="muted small">Undergrad final grades have no plus or minus. Grad grades do (A- = 3.67).</p>
        </fieldset>

        <fieldset className="seg-field">
          <legend>Theme</legend>
          <div className="seg">
            {THEMES.map((t) => (
              <label key={t.value} className={p.theme === t.value ? 'is-on' : ''}>
                <input type="radio" name="theme" checked={p.theme === t.value} onChange={() => p.onTheme(t.value)} />
                {t.label}
              </label>
            ))}
          </div>
        </fieldset>

        <QpaExtras qpa={p.qpa} settings={s} onSettings={p.onSettings} newestTerm={p.newestTerm} />

        {p.autolab && (
          <div className="settings-block">
            <h3>Chrome extension</h3>
            <label className="check">
              <input type="checkbox" checked={p.autolab.on} onChange={(e) => p.autolab?.onChange(e.target.checked)} />
              Also sync Autolab (beta)
            </label>
            <p className="muted small">For classes graded on Autolab, like 15-122 or 15-213.</p>
          </div>
        )}

        <div className="settings-block">
          <h3>Your data</h3>
          <p className="muted small">Everything lives in this browser only. Export it to move to another computer.</p>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => downloadStore(p.store)}>
              Export data
            </button>
            <label className="btn btn-secondary btn-sm file-btn">
              Import data
              <input type="file" accept="application/json,.json" onChange={onImportFile} />
            </label>
          </div>
          {importError && (
            <p className="error-line" role="alert">
              <WarningIcon /> {importError}
            </p>
          )}
        </div>

        <div className="settings-block danger-zone">
          <button type="button" className="btn btn-danger-ghost btn-sm" onClick={p.onDeleteAll}>
            <TrashIcon size={14} /> Delete everything
          </button>
          <p className="muted small">Removes your grades and settings from this browser.</p>
        </div>
      </div>
    </Modal>
  )
}
