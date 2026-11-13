// "What the AI advisor remembers": the notes the AI advisor saved about the student, shown in Settings to read, fix
// or delete.
// Props in, callbacks out: App owns the notes and saves them (memory.ts saveNotes).
import { useId, useState, type FormEvent } from 'react'
import { editNote, removeNote, type Note } from '../lib/chat/memory'
import { LIMITS } from '../lib/chat/protocol'
import { EditIcon, TrashIcon, WarningIcon } from './icons'
import './chat.css'

interface Props {
  notes: Note[]
  onChange: (notes: Note[]) => void
}

/** A note cut short for a button label ("Delete note: Taking 21-241 pass/...") */
function short(text: string): string {
  return text.length > 40 ? `${text.slice(0, 39)}…` : text
}

export function MemoryList({ notes, onChange }: Props) {
  const [editing, setEditing] = useState<string | null>(null) // id of the note being edited
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()

  function startEdit(note: Note) {
    setEditing(note.id)
    setText(note.text)
    setError(null)
  }

  function saveEdit(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    const next = editNote(notes, editing, text)
    if (!Array.isArray(next)) return setError(next.error)
    onChange(next)
    setEditing(null)
  }

  function deleteAll() {
    if (window.confirm('Delete everything the AI advisor remembers about you?')) onChange([])
  }

  return (
    <div className="settings-block">
      <h3>What the AI advisor remembers</h3>
      <p className="muted small">
        Short notes the AI advisor saved from your chats, like a target grade or a class you take pass/fail. They are
        saved only in this browser and go to OpenAI with each question you ask.
      </p>
      {notes.length === 0 ? (
        <p className="muted small">Nothing yet.</p>
      ) : (
        <ul className="memory-list">
          {notes.map((note) => (
            <li key={note.id} className="memory-item">
              {editing === note.id ? (
                <form className="memory-edit" onSubmit={saveEdit}>
                  <label htmlFor={inputId} className="sr-only">
                    Note
                  </label>
                  <input
                    id={inputId}
                    value={text}
                    maxLength={LIMITS.noteChars}
                    autoFocus
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      // Escape cancels the edit instead of closing Settings.
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setEditing(null)
                      }
                    }}
                  />
                  <button type="submit" className="btn btn-primary btn-sm">
                    Save
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <span className="memory-text">{note.text}</span>
                  <button type="button" className="btn-icon btn-icon-sm" aria-label={`Edit note: ${short(note.text)}`} onClick={() => startEdit(note)}>
                    <EditIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn-icon btn-icon-sm"
                    aria-label={`Delete note: ${short(note.text)}`}
                    onClick={() => onChange(removeNote(notes, note.id))}
                  >
                    <TrashIcon size={14} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && editing && (
        <p className="error-line" role="alert">
          <WarningIcon /> {error}
        </p>
      )}
      {notes.length > 1 && (
        <button type="button" className="link-btn small" onClick={deleteAll}>
          Delete all notes
        </button>
      )}
    </div>
  )
}
