// Little messages at the bottom of the screen ("Synced 6 courses from Gradescope"). They disappear after 5
// seconds (8 when they have a button like Undo), and wait while the mouse is over them, while one of their
// buttons has keyboard focus, or while their details are open. Screen readers hear them through aria-live.
import { useCallback, useEffect, useRef, useState } from 'react'
import { CloseIcon } from './icons'

export interface ToastOptions {
  tone?: 'info' | 'error'
  details?: string[] // extra lines behind a "2 warnings" button
  detailsLabel?: string
  action?: { label: string; onClick: () => void }
}

export interface Toast extends ToastOptions {
  id: number
  message: string
}

export type PushToast = (message: string, opts?: ToastOptions) => void

const AUTO_DISMISS_MS = 5000
const AUTO_DISMISS_ACTION_MS = 8000 // longer when there is a button to press (Undo, Open Setup)

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const push = useCallback<PushToast>((message, opts = {}) => {
    const id = nextId.current++
    // Keep at most 4 on screen so a burst of messages never covers the page.
    setToasts((list) => [...list.slice(-3), { id, message, ...opts }])
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  return { toasts, push, dismiss }
}

function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const [focused, setFocused] = useState(false)
  const delay = toast.action || toast.details?.length ? AUTO_DISMISS_ACTION_MS : AUTO_DISMISS_MS

  // Auto-dismiss, paused while the details are open, the mouse is over it, or keyboard focus is inside it
  // (so keyboard and screen-reader users can reach the buttons). The timer starts over when the pause ends.
  useEffect(() => {
    if (open || hover || focused) return
    const t = setTimeout(() => onDismiss(toast.id), delay)
    return () => clearTimeout(t)
  }, [open, hover, focused, delay, toast.id, onDismiss])

  return (
    <div
      className={`toast ${toast.tone === 'error' ? 'toast-error' : ''}`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        // Focus moving between two buttons of the same toast still counts as "inside".
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      <div className="toast-row">
        <span className="toast-msg">{toast.message}</span>
        {toast.details && toast.details.length > 0 && (
          <button type="button" className="toast-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
            {toast.detailsLabel ?? 'Details'}
          </button>
        )}
        {toast.action && (
          <button
            type="button"
            className="toast-btn"
            onClick={() => {
              toast.action?.onClick()
              onDismiss(toast.id)
            }}
          >
            {toast.action.label}
          </button>
        )}
        <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
          <CloseIcon size={14} />
        </button>
      </div>
      {open && toast.details && (
        <ul className="toast-details">
          {toast.details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <ToastView key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}
