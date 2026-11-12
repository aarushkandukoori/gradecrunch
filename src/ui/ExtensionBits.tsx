// Small pieces shown when the GradeCrunch Chrome extension is installed: the "finish setting up" card and the
// one-line notes under a sync (a site that needs a login, or an error). Used on the welcome page and the dashboard.
import { SITE_NAMES, type SyncNote } from '../lib/extension'
import { ExternalLink } from './Link'
import { WarningIcon } from './icons'

/** Everything the UI needs to know about the extension. null in props means "not installed". */
export interface ExtensionView {
  version: string
  consent: boolean // false until the student finished the extension's welcome page
  syncing: boolean
  progress: string | null // e.g. "Canvas: 3 of 8 courses" while syncing
  notes: SyncNote[]
  onSync: () => void
  onOpenWelcome: () => void
}

/** Shown until the student clicks Continue on the extension's welcome page (it will not sync before that). */
export function FinishSetup({ onOpenWelcome }: { onOpenWelcome: () => void }) {
  return (
    <div className="ext-setup" role="status">
      <p>
        <strong>Finish setting up the extension</strong>
      </p>
      <button type="button" className="btn btn-primary btn-sm" onClick={onOpenWelcome}>
        Finish setup
      </button>
    </div>
  )
}

/** One short line per site that needs a login or failed. Renders nothing when all went well. */
export function SyncNotes({ notes }: { notes: SyncNote[] }) {
  if (notes.length === 0) return null
  return (
    <ul className="sync-notes" aria-live="polite">
      {notes.map((n, i) =>
        n.kind === 'login' ? (
          <li key={`login-${n.source}`}>
            Log in to {SITE_NAMES[n.source]} to include it.{' '}
            <ExternalLink href={n.url}>Open {SITE_NAMES[n.source]}</ExternalLink>
            {n.source === 'gradescope' && (
              <span className="muted small sync-hint">Not logged in? Open any class's Gradescope link inside Canvas.</span>
            )}
          </li>
        ) : (
          <li key={`error-${n.source ?? 'all'}-${i}`} className="sync-error">
            <WarningIcon /> {n.source ? `${SITE_NAMES[n.source]}: ` : ''}
            {n.message}
          </li>
        ),
      )}
    </ul>
  )
}
