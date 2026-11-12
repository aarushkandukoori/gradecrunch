// Top bar: wordmark, term picker, "last synced" status, Sync button and the settings gear.
// The site cannot reach Canvas or Gradescope by itself (that is the privacy promise: only the Sync bookmarklet,
// running in your own logged-in tab, can), so the Sync button opens a small popover explaining how.
import { useEffect, useRef, useState } from 'react'
import { APP_NAME, AUTOLAB_ORIGIN, CANVAS_ORIGIN, GRADESCOPE_ORIGIN } from '../lib/brand'
import { timeAgo } from '../lib/format'
import type { Store } from '../types'
import { ExternalLink, NavLink, type Navigate } from './Link'
import { GearIcon, LogoMark, SyncIcon } from './icons'

interface Props {
  navigate: Navigate
  showDashboard: boolean // term picker + sync controls only make sense once there are grades
  terms: string[]
  term: string | null
  onTermChange: (term: string) => void
  lastSync: Store['lastSync']
  now: number
  onOpenSettings: () => void
}

export function Header(p: Props) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Close the popover on Escape or on a click anywhere outside it.
  useEffect(() => {
    if (!popoverOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPopoverOpen(false)
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setPopoverOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [popoverOpen])

  // Only mention Autolab once the student has used it (most classes are not on Autolab).
  const syncLine =
    `Canvas ${timeAgo(p.lastSync.canvas, p.now)} · Gradescope ${timeAgo(p.lastSync.gradescope, p.now)}` +
    (p.lastSync.autolab ? ` · Autolab ${timeAgo(p.lastSync.autolab, p.now)}` : '')

  return (
    <header className="topbar">
      <div className="container topbar-inner">
        <NavLink to="home" navigate={p.navigate} className="wordmark">
          <LogoMark />
          <span>{APP_NAME}</span>
        </NavLink>

        {p.showDashboard && p.terms.length > 1 && (
          <label className="term-select">
            <span className="sr-only">Term</span>
            <select value={p.term ?? ''} onChange={(e) => p.onTermChange(e.target.value)}>
              {p.terms.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        )}
        {p.showDashboard && p.terms.length === 1 && <span className="term-single">{p.terms[0]}</span>}

        <div className="topbar-right">
          {p.showDashboard && (
            <p className="sync-status">{syncLine}</p>
          )}
          {p.showDashboard && (
            <div className="popover-wrap" ref={wrapRef}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setPopoverOpen(!popoverOpen)}
                aria-expanded={popoverOpen}
                aria-haspopup="dialog"
              >
                <SyncIcon />
                <span className="sync-label">Sync</span>
              </button>
              {popoverOpen && (
                <div className="popover" role="dialog" aria-label="How to sync">
                  <p className="muted small">Last synced: {syncLine}</p>
                  <p>
                    Click <strong>Sync grades</strong> in your bookmarks bar while you're on Canvas, Gradescope or
                    Autolab.
                  </p>
                  <div className="popover-links">
                    <ExternalLink href={`${CANVAS_ORIGIN}/`} className="btn btn-secondary btn-sm">
                      Open Canvas
                    </ExternalLink>
                    <ExternalLink href={`${GRADESCOPE_ORIGIN}/`} className="btn btn-secondary btn-sm">
                      Open Gradescope
                    </ExternalLink>
                    <ExternalLink href={`${AUTOLAB_ORIGIN}/`} className="btn btn-secondary btn-sm">
                      Open Autolab
                    </ExternalLink>
                  </div>
                  <p className="muted small">
                    No Sync button yet?{' '}
                    <NavLink
                      to="setup"
                      navigate={(v) => {
                        setPopoverOpen(false)
                        p.navigate(v)
                      }}
                    >
                      Set it up
                    </NavLink>
                  </p>
                </div>
              )}
            </div>
          )}
          {!p.showDashboard && (
            <nav className="topnav" aria-label="Main">
              <NavLink to="setup" navigate={p.navigate}>
                Setup
              </NavLink>
              <NavLink to="privacy" navigate={p.navigate}>
                Privacy
              </NavLink>
            </nav>
          )}
          <button type="button" className="btn-icon" onClick={p.onOpenSettings} aria-label="Settings">
            <GearIcon size={18} />
          </button>
        </div>
      </div>
      {p.showDashboard && (
        // Phones have no room for the status in the top bar, so it gets its own small line under it. Without it
        // a phone user couldn't tell that Gradescope was never synced or that the grades are days old.
        <p className="container sync-status-mobile">{syncLine}</p>
      )}
    </header>
  )
}
