// Tiny router pieces. We have three pages, so no router library: the App keeps `view` in state and mirrors it in
// the URL with history.pushState. <NavLink> is a normal link (so middle-click / Cmd-click still open a new tab)
// that switches the view in place on a plain click.
import type { MouseEvent, ReactNode } from 'react'

export type View = 'home' | 'setup' | 'privacy'
export type Navigate = (view: View) => void

export const VIEW_PATHS: Record<View, string> = { home: '/', setup: '/setup', privacy: '/privacy' }

export function viewFromPath(path: string): View {
  if (path.startsWith('/setup')) return 'setup'
  if (path.startsWith('/privacy')) return 'privacy'
  return 'home'
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
