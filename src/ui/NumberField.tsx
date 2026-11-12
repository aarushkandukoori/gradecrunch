// A small number input that keeps what you type locally and only saves on blur or Enter. Saving on every
// keystroke would turn "8." into "8" mid-typing and recompute every grade per key.
import { useEffect, useState } from 'react'

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
}

function toText(v: number | null | undefined): string {
  return v == null ? '' : String(v)
}

export function NumberField(props: Props) {
  const { label, value, onCommit, hideLabel, placeholder, suffix, min, max, className, required } = props
  const [text, setText] = useState(toText(value))

  // If the saved value changes from somewhere else (a "Reset" button, a new sync), show it.
  useEffect(() => setText(toText(value)), [value])

  function commit() {
    const t = text.trim()
    if (t === '') {
      // Show the current value again; if clearing changes it, the effect above updates the box.
      setText(toText(value))
      if (!required && value != null) onCommit(null)
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
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        {suffix && <span className="numfield-suffix">{suffix}</span>}
      </span>
    </label>
  )
}
