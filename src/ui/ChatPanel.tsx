// The AI advisor: a chat about your grades, in a side sheet (full screen on phones). The AI answers from a summary of
// the grades and can change GradeCrunch settings when asked (weights, pass/fail, units, final letter, hide, college,
// level). Each change saves at once, so the QPA behind the sheet updates, and shows a receipt with Undo.
//
// The sheet is a native modal <dialog>: the browser keeps focus inside, closes it on Escape and puts focus back on
// the button that opened it. Props in, callbacks out: App owns the store and the notes; the sheet keeps its own
// transcript and the consent flag in localStorage (memory.ts). The AI's text is rendered as React text nodes.
import { Fragment, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { askChat } from '../lib/chat/client'
import { canUndo, loadChat, loadConsent, saveChat, saveConsent, type ChatMessage, type Note, type Receipt } from '../lib/chat/memory'
import { LIMITS } from '../lib/chat/protocol'
import { parseRichText, type Span } from '../lib/chat/richText'
import { undoChange, type ToolState } from '../lib/chat/tools'
import { randomId } from '../lib/store'
import type { Store } from '../types'
import { ExternalLink } from './Link'
import { CheckIcon, CloseIcon, SparkleIcon } from './icons'
import './chat.css'

interface Props {
  open: boolean
  topic?: string | null // opened from a class page: that class, e.g. "15-122" (the question box starts with it)
  onClose: () => void
  store: Store
  onStoreChange: (store: Store) => void
  notes: Note[]
  onNotesChange: (notes: Note[]) => void
  fetchImpl?: typeof fetch // tests pass a fake server
}

const STARTERS = [
  'What do I need on my finals?',
  'How does my QPA change if I take a class pass/fail?',
  'The weights for one of my classes are wrong. Can you fix them?',
]

// OpenAI's page on what happens to data sent to its API (checked 2026-11-13).
const OPENAI_DATA_URL = 'https://developers.openai.com/api/docs/guides/your-data'

export function ChatPanel({ open, topic, onClose, store, onStoreChange, notes, onNotesChange, fetchImpl }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(loadChat)
  const [consent, setConsent] = useState(loadConsent)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pressedOutside = useRef(false)
  const sendingRef = useRef(false)
  const titleId = useId()
  const inputId = useId()

  // The latest store and notes, for tools that run while an answer is on its way (a sync may land meanwhile).
  const stateRef = useRef<ToolState>({ store, notes })
  useEffect(() => {
    stateRef.current = { store, notes }
  }, [store, notes])

  // The question being answered. It is stopped when this sheet goes away: App starts the chat over when another tab
  // clears the chat or deletes everything, or when the demo ends. Its tools must not save the store this sheet saw
  // before that (it would bring deleted grades back, with no receipt to undo it).
  const questionRef = useRef<AbortController | null>(null)
  useEffect(() => () => questionRef.current?.abort(), [])

  useEffect(() => saveChat(messages), [messages])

  // Open and close the native dialog to match `open` (same as Modal.tsx).
  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal()
      else d.setAttribute('open', '') // test environments without showModal
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    } else if (!open && d.open) {
      if (typeof d.close === 'function') d.close()
      else d.removeAttribute('open')
    }
  }, [open])

  // Opened from a class page: start the question with that class ("About 15-122: "); opened from anywhere else, no
  // start. Only over an empty box, or over the start put there before, so a question the student began typing is
  // never lost.
  const topicStart = useRef('')
  useEffect(() => {
    if (!open) return
    const start = topic ? `About ${topic}: ` : ''
    setDraft((d) => (d.trim() === '' || d === topicStart.current ? start : d))
    topicStart.current = start
  }, [open, topic])

  // Keep the newest message in view.
  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [messages, busy, open])

  function closeSheet() {
    const d = dialogRef.current
    if (d && typeof d.close === 'function' && d.open) d.close() // fires 'close', which calls onClose
    else onClose()
  }

  /** Saves a new store and notes from a tool or an Undo, and remembers them for the next tool. */
  function save(next: ToolState) {
    if (questionRef.current?.signal.aborted) return // this sheet is gone: change nothing
    const before = stateRef.current
    stateRef.current = next
    if (next.store !== before.store) onStoreChange(next.store)
    if (next.notes !== before.notes) onNotesChange(next.notes)
  }

  async function send(text: string) {
    const question = text.trim().slice(0, LIMITS.userChars)
    // A ref, not `busy`: two quick clicks can both run before React re-renders with busy = true.
    if (!question || sendingRef.current) return
    sendingRef.current = true
    const stop = new AbortController()
    questionRef.current = stop
    const history = messages
    setMessages([...history, { id: randomId(), role: 'user', text: question }])
    setDraft('')
    setBusy(true)
    let answer: ChatMessage
    try {
      const result = await askChat({ question, history, getState: () => stateRef.current, onChange: save, fetchImpl, signal: stop.signal })
      answer = { id: randomId(), role: 'assistant', text: result.text }
      if (result.receipts.length > 0) answer.receipts = result.receipts
      if (result.error) answer.error = true
    } catch {
      answer = { id: randomId(), role: 'assistant', text: 'Something went wrong. Try again.', error: true }
    }
    setMessages((list) => [...list, answer])
    setBusy(false)
    sendingRef.current = false
  }

  function undo(messageId: string, receipt: Receipt) {
    save(undoChange(stateRef.current, receipt.undo))
    const markUndone = (m: ChatMessage): ChatMessage =>
      m.id !== messageId ? m : { ...m, receipts: m.receipts?.map((r) => (r.id === receipt.id ? { ...r, undone: true } : r)) }
    setMessages((list) => list.map(markUndone))
    inputRef.current?.focus() // the Undo button that had focus goes away
  }

  function clearChat() {
    setMessages([]) // the saved notes stay
    inputRef.current?.focus() // the Clear chat button turns disabled and loses focus
  }

  function accept() {
    saveConsent(true)
    setConsent(true)
  }

  // After "OK, start" the question box replaces the notice: move focus there (the button that had it is gone).
  useEffect(() => {
    if (consent && dialogRef.current?.open) inputRef.current?.focus()
  }, [consent])

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void send(draft)
  }

  // Enter sends, Shift+Enter adds a line. Not while an input method (Japanese, Chinese, Korean...) is composing:
  // there Enter confirms the characters.
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    e.currentTarget.form?.requestSubmit()
  }

  // Click outside the sheet closes it. The press and the release both have to be outside, so selecting text in the
  // sheet and letting go over the page doesn't close it.
  function outside(e: PointerEvent<HTMLDialogElement>): boolean {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
  }

  return (
    <dialog
      ref={dialogRef}
      className="chat-sheet"
      aria-labelledby={titleId}
      onClose={onClose}
      onPointerDown={(e) => {
        pressedOutside.current = outside(e)
      }}
      onPointerUp={(e) => {
        if (pressedOutside.current && outside(e)) closeSheet()
        pressedOutside.current = false
      }}
    >
      <div className="chat-head">
        <h2 id={titleId}>
          <SparkleIcon size={18} /> AI advisor
        </h2>
        {consent && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={clearChat} disabled={busy || messages.length === 0}>
            Clear chat
          </button>
        )}
        <button type="button" className="btn-icon" aria-label="Close" onClick={closeSheet}>
          <CloseIcon size={18} />
        </button>
      </div>

      {!consent ? (
        <section className="chat-consent" aria-label="Before you start">
          <p>
            To answer, GradeCrunch sends your question, the recent chat, the notes the AI advisor saved and a summary of
            your grades (classes, scores, weights, units, QPA and past semesters, but not your name) through its server
            to OpenAI.
          </p>
          <ul>
            <li>GradeCrunch keeps nothing on its server.</li>
            <li>
              OpenAI doesn't train on it and keeps it up to 30 days to check for abuse.{' '}
              <ExternalLink href={OPENAI_DATA_URL}>OpenAI's policy</ExternalLink>
            </li>
            <li>
              Your chat and the AI advisor's notes about you are saved only in this browser. See or delete the notes in
              Settings.
            </li>
            <li>The AI advisor can change your settings when you ask it to. Every change has an Undo.</li>
          </ul>
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-sm" data-autofocus="" onClick={accept}>
              OK, start
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={closeSheet}>
              Not now
            </button>
          </div>
        </section>
      ) : (
        <>
          <div className="chat-log" ref={logRef} role="log" aria-label="Chat" tabIndex={0}>
            {messages.length === 0 && (
              <div className="chat-empty">
                <p className="muted">
                  Ask about your grades, or tell the AI advisor what's different, like "21-241 is pass/fail" or the
                  weights from a syllabus. It remembers what you tell it.
                </p>
                <div className="chat-starters">
                  {STARTERS.map((s) => (
                    <button key={s} type="button" className="btn btn-secondary btn-sm" onClick={() => void send(s)} disabled={busy}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`chat-msg chat-${m.role}${m.error ? ' chat-error' : ''}`}>
                <span className="sr-only">{m.role === 'user' ? 'You: ' : 'Advisor: '}</span>
                {m.role === 'user' ? <p className="chat-plain">{m.text}</p> : <RichText text={m.text} />}
                {m.receipts?.map((r) => (
                  <p key={r.id} className={`chat-receipt${r.undone ? ' is-undone' : ''}`}>
                    <CheckIcon size={14} />
                    <span className="chat-receipt-text">{r.text}</span>
                    {canUndo(r) && (
                      <button type="button" className="link-btn" onClick={() => undo(m.id, r)}>
                        Undo
                      </button>
                    )}
                    {r.undone && <span className="muted">Undone</span>}
                  </p>
                ))}
              </div>
            ))}
          </div>
          {busy && (
            <div className="chat-typing" role="progressbar" aria-label="Getting an answer">
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
            </div>
          )}
          <form className="chat-form" onSubmit={onSubmit}>
            <label htmlFor={inputId} className="sr-only">
              Your question
            </label>
            <textarea
              id={inputId}
              ref={inputRef}
              className="chat-input"
              rows={1}
              value={draft}
              maxLength={LIMITS.userChars}
              placeholder="Ask about your grades"
              data-autofocus=""
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || draft.trim() === ''}>
              Send
            </button>
          </form>
          <p className="chat-foot muted small">Estimates only, not your CMU academic advisor. Your official record is in SIO.</p>
        </>
      )}
    </dialog>
  )
}

/** An answer with its **bold** and lists, as React elements (never HTML). */
function RichText({ text }: { text: string }) {
  return (
    <>
      {parseRichText(text).map((block, i) => {
        if (block.kind === 'p') return <p key={i}>{spans(block.spans)}</p>
        const items = block.items.map((item, j) => <li key={j}>{spans(item)}</li>)
        return block.kind === 'ul' ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>
      })}
    </>
  )
}

function spans(list: Span[]) {
  return list.map((s, i) => (s.bold ? <strong key={i}>{s.text}</strong> : <Fragment key={i}>{s.text}</Fragment>))
}
