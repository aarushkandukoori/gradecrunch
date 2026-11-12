// A small number input that keeps what you type locally and only saves on blur or Enter. Saving on every
// keystroke would turn "8." into "8" mid-typing and recompute every grade per key.
import { useEffect, useRef, useState } from 'react'

interface Props {
  label: string
  value: number | null | undefined
  onCommit: (value: number | null) => void // null = the field was cleared
  hideLabel?: boolean // label still exists for screen readers, just not shown
  placeholder?: string
  suffix?: string
  min?: number
  max?: number
  className?: string
  required?: boolean // clearing the box puts the old value back instead of saving null
  autoFocus?: boolean // focus the box when it appears (e.g. right after clicking the pencil button)
  onCancel?: () => void // Escape, or leaving the box empty when nothing was saved: the caller can close it
}

function toText(v: number | null | undefined): string {
  return v == null ? '' : String(v)
}

export function NumberField(props: Props) {
  const { label, value, onCommit, hideLabel, placeholder, suffix, min, max, className, required, autoFocus, onCancel } =
    props
  const [text, setText] = useState(toText(value))
  const cancelled = useRef(false) // set by Escape so the blur that may follow doesn't save what was typed

  // If the saved value changes from somewhere else (a "Reset" button, a new sync), show it.
  useEffect(() => setText(toText(value)), [value])

  function commit() {
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    const t = text.trim()
    if (t === '') {
      // Show the current value again; if clearing changes it, the effect above updates the box.
      setText(toText(value))
      if (!required && value != null) onCommit(null)
      else if (value == null) onCancel?.() // left empty and nothing to clear: let the caller close the box
      return
    }
    const n = Number(t)
    const bad = !Number.isFinite(n) || (min != null && n < min) || (max != null && n > max)
    if (bad) {
      setText(toText(value)) // put the old value back instead of saving nonsense
      return
    }
    if (n !== value) onCommit(n)
  }

  return (
    <label className={`numfield ${className ?? ''}`}>
      <span className={hideLabel ? 'sr-only' : 'numfield-label'}>{label}</span>
      <span className="numfield-box">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onChange={(e) => {
            cancelled.current = false // typing again after Escape: save as usual
            setText(e.target.value)
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape' && onCancel) {
              // Throw away what was typed and close, without saving.
              e.preventDefault()
              cancelled.current = true
              setText(toText(value))
              onCancel()
            }
          }}
        />
        {suffix && <span className="numfield-suffix">{suffix}</span>}
      </span>
    </label>
  )
}
