// Tiny router pieces. We have a few pages, so no router library: the App keeps `view` in state and mirrors it in
// the URL with history.pushState. One class opens at /class/<course key>. <NavLink> is a normal link (so
// middle-click / Cmd-click still open a new tab) that switches the view in place on a plain click.
import type { MouseEvent, ReactNode } from 'react'

export type View = 'home' | 'setup' | 'privacy' | 'past'
export type Navigate = (view: View) => void

export const VIEW_PATHS: Record<View, string> = { home: '/', setup: '/setup', privacy: '/privacy', past: '/past' }

export function viewFromPath(path: string): View {
  if (path.startsWith('/setup')) return 'setup'
  if (path.startsWith('/privacy')) return 'privacy'
  if (path.startsWith('/past')) return 'past'
  return 'home'
}

const CLASS_PREFIX = '/class/'

/** "/class/Fall%202026%7C21241" for the course key "Fall 2026|21241". */
export function classPath(courseKey: string): string {
  return CLASS_PREFIX + encodeURIComponent(courseKey)
}

/** The course key in a /class/... path, or null for any other path (or a broken one). */
export function classKeyFromPath(path: string): string | null {
  if (!path.startsWith(CLASS_PREFIX)) return null
  try {
    return decodeURIComponent(path.slice(CLASS_PREFIX.length)) || null
  } catch {
    return null // a bad % escape someone typed by hand
  }
}

export function NavLink(props: { to: View; navigate: Navigate; className?: string; children: ReactNode }) {
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    // Let the browser handle new-tab clicks.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    props.navigate(props.to)
  }
  return (
    <a href={VIEW_PATHS[props.to]} className={props.className} onClick={onClick}>
      {props.children}
    </a>
  )
}

/** A link to another site, always in a new tab, never sending our URL as referrer. */
export function ExternalLink(props: { href: string; className?: string; children: ReactNode }) {
  return (
    <a href={props.href} className={props.className} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  )
}
