// What the AI advisor chat remembers, saved in this browser only (localStorage), next to the grades:
//   APP_SLUG + ':memory'       short notes about the student ("Taking 21-241 pass/fail"), sent with every question
//   APP_SLUG + ':chat'         the last messages of the chat, with the receipts of changes the AI advisor made
//                              (and their Undo)
//   APP_SLUG + ':chatConsent'  set once the student accepted the notice about sending questions to OpenAI
// "Delete everything" in Settings already removes these (store.ts clearAll removes every APP_SLUG key);
// clearChatData() removes just these three.
//
// Like store.ts, every storage access is wrapped in try/catch: storage can be blocked (private windows), and the
// chat must still work then, it just forgets on reload. Anything read back is checked, since it can be hand-edited.
import { APP_SLUG } from '../brand'
import { randomId } from '../store'
import type { Level } from '../../types'
import { LIMITS } from './protocol'

export const MEMORY_KEY = `${APP_SLUG}:memory`
export const CHAT_KEY = `${APP_SLUG}:chat`
export const CONSENT_KEY = `${APP_SLUG}:chatConsent`

/** One thing the AI advisor remembers about the student. */
export interface Note {
  id: string // short random id; the AI uses it to remove the note
  text: string // at most LIMITS.noteChars characters
  at: string // when it was saved (ISO time)
}

/**
 * What one change touched, with the values from before it, so Undo puts back exactly those values and nothing
 * else (a sync or another change made since then stays). null means "was not set".
 */
export interface UndoPatch {
  courseKey?: string // the class whose settings changed
  prefs?: { passFail?: boolean | null; hidden?: boolean | null; units?: number | null; letter?: string | null; weighted?: boolean | null }
  weights?: Record<string, number | null> // category key -> weight before
  settings?: { college?: string | null; level?: Level }
  addedNoteId?: string // a note this change saved: Undo removes it
  removedNote?: { note: Note; index: number } // a note this change removed: Undo puts it back where it was
}

/** The small line under an answer for a change the AI advisor made: "21-241 set to pass/fail. QPA 3.42 -> 3.71". */
export interface Receipt {
  id: string
  text: string
  undo: UndoPatch
  undone?: boolean
}

/** A receipt shows an Undo button while it has something to put back and hasn't been undone. */
export function canUndo(r: Receipt): boolean {
  return !r.undone && Object.keys(r.undo).length > 0
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  receipts?: Receipt[] // changes made while answering this question
  error?: boolean // an error shown in the chat (never sent to the AI)
}

// ---------------------------------------------------------------- raw storage (same pattern as store.ts)

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeKey(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Full or blocked storage: the chat keeps working in memory.
  }
}

function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

function readJson(key: string): unknown {
  const raw = readKey(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

// ---------------------------------------------------------------- notes

/** A note's text tidied up: spaces collapsed, trimmed. */
export function cleanNoteText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function parseNote(x: unknown): Note | null {
  if (!isObject(x) || typeof x.id !== 'string' || typeof x.text !== 'string') return null
  const text = cleanNoteText(x.text).slice(0, LIMITS.noteChars)
  if (!x.id || x.id.length > 40 || !text) return null
  return { id: x.id, text, at: typeof x.at === 'string' ? x.at : '' }
}

export function loadNotes(): Note[] {
  const raw = readJson(MEMORY_KEY)
  if (!Array.isArray(raw)) return []
  const notes: Note[] = []
  for (const x of raw) {
    const note = parseNote(x)
    if (note && !notes.some((n) => n.id === note.id)) notes.push(note)
  }
  return notes.slice(0, LIMITS.notes)
}

/** Saves the notes. No notes leaves no key at all, like an empty chat. */
export function saveNotes(notes: Note[]): void {
  if (notes.length === 0) removeKey(MEMORY_KEY)
  else writeKey(MEMORY_KEY, JSON.stringify(notes.slice(0, LIMITS.notes)))
}

/** Checks a note's text: an error message, or null when it is fine. */
function noteProblem(text: string): string | null {
  if (!text) return 'The note is empty.'
  if (text.length > LIMITS.noteChars) return `Notes can be at most ${LIMITS.noteChars} characters.`
  return null
}

/** Adds a note (pure). Refuses empty or long text, a note that is already saved, and a full memory. */
export function addNote(notes: Note[], rawText: string, now: Date): { notes: Note[]; note: Note } | { error: string } {
  const text = cleanNoteText(rawText)
  const problem = noteProblem(text)
  if (problem) return { error: problem }
  if (notes.some((n) => n.text.toLowerCase() === text.toLowerCase())) return { error: 'That note is already saved.' }
  if (notes.length >= LIMITS.notes) return { error: `Memory is full (${LIMITS.notes} notes). Remove one first.` }
  let id = randomId().slice(0, 6)
  while (notes.some((n) => n.id === id)) id = randomId().slice(0, 6)
  const note = { id, text, at: now.toISOString() }
  return { notes: [...notes, note], note }
}

/** Changes a note's text (pure), with the same checks as addNote. */
export function editNote(notes: Note[], id: string, rawText: string): Note[] | { error: string } {
  const text = cleanNoteText(rawText)
  const problem = noteProblem(text)
  if (problem) return { error: problem }
  if (notes.some((n) => n.id !== id && n.text.toLowerCase() === text.toLowerCase())) return { error: 'That note is already saved.' }
  return notes.map((n) => (n.id === id ? { ...n, text } : n))
}

export function removeNote(notes: Note[], id: string): Note[] {
  return notes.filter((n) => n.id !== id)
}

// ---------------------------------------------------------------- the chat transcript

function parseUndo(x: unknown): UndoPatch | null {
  if (!isObject(x)) return null
  const out: UndoPatch = {}
  if (typeof x.courseKey === 'string') out.courseKey = x.courseKey
  if (isObject(x.prefs)) {
    const p = x.prefs
    const prefs: NonNullable<UndoPatch['prefs']> = {}
    const flag = (v: unknown) => (typeof v === 'boolean' || v === null ? v : undefined)
    if (flag(p.passFail) !== undefined) prefs.passFail = flag(p.passFail)
    if (flag(p.hidden) !== undefined) prefs.hidden = flag(p.hidden)
    if (flag(p.weighted) !== undefined) prefs.weighted = flag(p.weighted)
    if (p.units === null || (typeof p.units === 'number' && Number.isFinite(p.units))) prefs.units = p.units
    if (p.letter === null || typeof p.letter === 'string') prefs.letter = p.letter
    out.prefs = prefs
  }
  if (isObject(x.weights)) {
    const weights: Record<string, number | null> = {}
    for (const [k, v] of Object.entries(x.weights)) {
      if (k !== '__proto__' && (v === null || (typeof v === 'number' && Number.isFinite(v)))) weights[k] = v
    }
    out.weights = weights
  }
  if (isObject(x.settings)) {
    const s = x.settings
    out.settings = {}
    if (s.college === null || typeof s.college === 'string') out.settings.college = s.college
    if (s.level === 'undergrad' || s.level === 'grad') out.settings.level = s.level
  }
  if (typeof x.addedNoteId === 'string') out.addedNoteId = x.addedNoteId
  if (isObject(x.removedNote)) {
    const note = parseNote(x.removedNote.note)
    const index = x.removedNote.index
    if (note && typeof index === 'number' && Number.isInteger(index) && index >= 0) out.removedNote = { note, index }
  }
  return out
}

function parseMessage(x: unknown): ChatMessage | null {
  if (!isObject(x) || typeof x.id !== 'string' || typeof x.text !== 'string') return null
  if (x.role !== 'user' && x.role !== 'assistant') return null
  const message: ChatMessage = { id: x.id, role: x.role, text: x.text.slice(0, LIMITS.textChars) }
  if (x.error === true) message.error = true
  if (Array.isArray(x.receipts)) {
    const receipts: Receipt[] = []
    for (const r of x.receipts) {
      if (!isObject(r) || typeof r.id !== 'string' || typeof r.text !== 'string') continue
      // Without readable undo data the receipt stays, but its Undo button doesn't (see canUndo).
      receipts.push({ id: r.id, text: r.text.slice(0, 300), undo: parseUndo(r.undo) ?? {}, ...(r.undone === true ? { undone: true } : {}) })
    }
    if (receipts.length > 0) message.receipts = receipts
  }
  return message
}

export function loadChat(): ChatMessage[] {
  const raw = readJson(CHAT_KEY)
  if (!Array.isArray(raw)) return []
  return raw.map(parseMessage).filter((m): m is ChatMessage => m !== null).slice(-LIMITS.historyMessages)
}

/** Saves the last LIMITS.historyMessages messages (older ones are dropped). An empty chat leaves no key at all, so
 * nothing is stored for someone who never used the AI advisor, and Clear chat removes it. */
export function saveChat(messages: ChatMessage[]): void {
  if (messages.length === 0) removeKey(CHAT_KEY)
  else writeKey(CHAT_KEY, JSON.stringify(messages.slice(-LIMITS.historyMessages)))
}

// ---------------------------------------------------------------- consent and clearing

export function loadConsent(): boolean {
  return readKey(CONSENT_KEY) === 'yes'
}

export function saveConsent(on: boolean): void {
  if (on) writeKey(CONSENT_KEY, 'yes')
  else removeKey(CONSENT_KEY)
}

/** Forgets the chat, the notes and the consent (for "Delete all data"). */
export function clearChatData(): void {
  for (const key of [MEMORY_KEY, CHAT_KEY, CONSENT_KEY]) removeKey(key)
}
