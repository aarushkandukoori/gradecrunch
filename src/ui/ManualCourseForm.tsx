// "Class not on Canvas or Gradescope? Add it by hand": course number, optional title, optional current percent.
import { useState, type FormEvent } from 'react'
import { parseCourseNumbers } from '../lib/courseNumber'
import { randomId } from '../lib/store'
import type { ManualCourse } from '../types'
import { PlusIcon, WarningIcon } from './icons'

interface Props {
  term: string | null // the term the dashboard shows; the new class goes there
  onAdd: (course: ManualCourse) => void
}

export function ManualCourseForm({ term, onAdd }: Props) {
  const [number, setNumber] = useState('')
  const [title, setTitle] = useState('')
  const [percent, setPercent] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit(e: FormEvent) {
    e.preventDefault()
    const parsed = number.trim() ? parseCourseNumbers(number).number : null
    if (number.trim() && !parsed) return setError('Use a course number like 15-213.')
    if (!parsed && !title.trim()) return setError('Add a course number or a title.')
    let pct: number | null = null
    if (percent.trim()) {
      pct = Number(percent.replace('%', ''))
      if (!Number.isFinite(pct) || pct < 0 || pct > 150) return setError('Current % should be a number like 87.5.')
    }
    onAdd({ key: `manual:${randomId()}`, number: parsed, title: title.trim(), term, percent: pct })
    setNumber('')
    setTitle('')
    setPercent('')
    setError(null)
  }

  return (
    <form className="manual-form" onSubmit={submit}>
      <label className="field">
        <span>Course number</span>
        <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="15-213" autoComplete="off" />
      </label>
      <label className="field field-grow">
        <span>Title (optional)</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Found from the number if blank" />
      </label>
      <label className="field field-sm">
        <span>Current % (optional)</span>
        <input value={percent} onChange={(e) => setPercent(e.target.value)} inputMode="decimal" placeholder="87.5" />
      </label>
      <button type="submit" className="btn btn-secondary">
        <PlusIcon /> Add class
      </button>
      {error && (
        <p className="error-line full-row" role="alert">
          <WarningIcon /> {error}
        </p>
      )}
    </form>
  )
}
