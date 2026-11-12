// Top bar: wordmark, term picker (only with more than one term), Sync button and the settings gear.
// The site cannot reach Canvas or Gradescope by itself (that is the privacy promise: only the Sync bookmarklet,
// running in your own logged-in tab, can), so the Sync button opens a small popover saying how.
import { useEffect, useRef, useState } from 'react'
import { APP_NAME, AUTOLAB_ORIGIN, CANVAS_ORIGIN, GRADESCOPE_ORIGIN } from '../lib/brand'
import { timeAgo } from '../lib/format'
import type { Store } from '../types'
import { ExternalLink, NavLink, type Navigate } from './Link'
import { GearIcon, LogoMark, SyncIcon } from './icons'

interface Props {
  navigate: Navigate
  showDashboard: boolean // term picker + Sync only make sense once there are grades
  terms: string[]
  term: string | null
  onTermChange: (term: string) => void
  lastSync: Store['lastSync']
  now: number
  onOpenSettings: () => void
}

/** "Canvas 5 min ago · Gradescope not synced" (Autolab only once it has been used). */
export function syncLine(lastSync: Store['lastSync'], now: number): string {
  return (
    `Canvas ${timeAgo(lastSync.canvas, now)} · Gradescope ${timeAgo(lastSync.gradescope, now)}` +
    (lastSync.autolab ? ` · Autolab ${timeAgo(lastSync.autolab, now)}` : '')
  )
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

  return (
    <header className="topbar">
      <div className="container topbar-inner">
        <NavLink to="home" navigate={p.navigate} className="wordmark">
          <LogoMark />
          <span>{APP_NAME}</span>
        </NavLink>

        <div className="topbar-right">
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
                  <p>
                    Click <strong>Sync grades</strong> in your bookmarks bar while you're on Canvas or Gradescope.
                  </p>
                  <div className="popover-links">
                    <ExternalLink href={`${CANVAS_ORIGIN}/`} className="btn btn-secondary btn-sm">
                      Open Canvas
                    </ExternalLink>
                    <ExternalLink href={`${GRADESCOPE_ORIGIN}/`} className="btn btn-secondary btn-sm">
                      Open Gradescope
                    </ExternalLink>
                  </div>
                  <p className="muted small sync-when">Last sync: {syncLine(p.lastSync, p.now)}</p>
                  <p className="muted small">
                    Also works on <ExternalLink href={`${AUTOLAB_ORIGIN}/`}>Autolab</ExternalLink>. No Sync button?{' '}
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
    </header>
  )
}
