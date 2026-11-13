// Tests for what the AI advisor chat keeps in the browser (src/lib/chat/memory.ts): note caps, the saved chat, the consent
// flag, clearing, and blocked or hand-edited storage. All data is made up.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { STORE_KEY } from '../src/lib/store'
import {
  addNote,
  canUndo,
  CHAT_KEY,
  clearChatData,
  CONSENT_KEY,
  editNote,
  loadChat,
  loadConsent,
  loadNotes,
  MEMORY_KEY,
  removeNote,
  saveChat,
  saveConsent,
  saveNotes,
  type ChatMessage,
  type Note,
} from '../src/lib/chat/memory'

// Node 25 ships its own experimental global localStorage, which shadows jsdom's (see app.test.ts). Use a small
// in-memory Storage so the tests behave like a browser.
class MemoryStorage implements Storage {
  private data = new Map<string, string>()
  get length() {
    return this.data.size
  }
  clear() {
    this.data.clear()
  }
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value))
  }
}

beforeEach(() => {
  const storage = new MemoryStorage()
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const NOW = new Date('2026-11-13T15:00:00Z')

function notes(n: number): Note[] {
  return Array.from({ length: n }, (_, i) => ({ id: `n${i}`, text: `Made-up note ${i}`, at: '' }))
}

describe('notes', () => {
  test('caps: 300 characters, no empty or duplicate notes, at most 50', () => {
    const ok = addNote([], 'x'.repeat(300), NOW)
    expect('notes' in ok && ok.notes).toHaveLength(1)
    expect(addNote([], 'x'.repeat(301), NOW)).toEqual({ error: 'Notes can be at most 300 characters.' })
    expect(addNote([], '   ', NOW)).toEqual({ error: 'The note is empty.' })
    expect(addNote(notes(1), '  made-up NOTE 0 ', NOW)).toEqual({ error: 'That note is already saved.' })
    expect(addNote(notes(49), 'One more', NOW)).toMatchObject({ notes: expect.any(Array) })
    expect(addNote(notes(50), 'One too many', NOW)).toEqual({ error: 'Memory is full (50 notes). Remove one first.' })
  })

  test('a new note gets a short unique id and the time', () => {
    const added = addNote(notes(3), 'Wants an A in 15-122', NOW)
    if (!('note' in added)) throw new Error(added.error)
    expect(added.note.id).toMatch(/^[a-z0-9]{1,6}$/)
    expect(added.notes.filter((n) => n.id === added.note.id)).toHaveLength(1)
    expect(added.note.at).toBe('2026-11-13T15:00:00.000Z')
  })

  test('edit and remove', () => {
    const list = notes(3)
    expect(editNote(list, 'n1', ' Taking 21-241   pass/fail ')).toEqual([list[0], { ...list[1], text: 'Taking 21-241 pass/fail' }, list[2]])
    expect(editNote(list, 'n1', 'made-up note 2')).toEqual({ error: 'That note is already saved.' })
    expect(editNote(list, 'n1', '')).toEqual({ error: 'The note is empty.' })
    expect(removeNote(list, 'n0')).toEqual([list[1], list[2]])
  })

  test('saved and loaded; junk in storage is skipped', () => {
    saveNotes(notes(2))
    expect(loadNotes()).toEqual(notes(2))
    localStorage.setItem(
      MEMORY_KEY,
      JSON.stringify([{ id: 'a', text: 'Fine' }, { id: 'a', text: 'Same id' }, { id: 'b' }, 'text', { id: 'c', text: 'y'.repeat(500) }, { id: 'd', text: '   ' }]),
    )
    expect(loadNotes()).toEqual([
      { id: 'a', text: 'Fine', at: '' },
      { id: 'c', text: 'y'.repeat(300), at: '' },
    ])
    localStorage.setItem(MEMORY_KEY, '{not json')
    expect(loadNotes()).toEqual([])
    localStorage.setItem(MEMORY_KEY, JSON.stringify(notes(60)))
    expect(loadNotes()).toHaveLength(50)
  })
})

describe('the saved chat', () => {
  test('keeps the last 40 messages', () => {
    const many: ChatMessage[] = Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `Message ${i}` }))
    saveChat(many)
    const loaded = loadChat()
    expect(loaded).toHaveLength(40)
    expect(loaded[0].text).toBe('Message 5')
  })

  test('an empty chat stores nothing (no key for someone who never used the AI advisor; Clear chat removes it)', () => {
    saveChat([])
    expect(localStorage.getItem(CHAT_KEY)).toBeNull()
    saveChat([{ id: 'm1', role: 'user', text: 'Hi' }])
    expect(localStorage.getItem(CHAT_KEY)).not.toBeNull()
    saveChat([])
    expect(localStorage.getItem(CHAT_KEY)).toBeNull()
  })

  test('receipts keep their undo data; without readable undo data they lose only the Undo button', () => {
    localStorage.setItem(
      CHAT_KEY,
      JSON.stringify([
        { id: 'u1', role: 'user', text: '21-241 is pass/fail' },
        {
          id: 'a1',
          role: 'assistant',
          text: 'Done.',
          receipts: [
            { id: 'r1', text: '21-241 set to pass/fail. QPA 3.42 -> 3.71', undo: { courseKey: 'Fall 2026|21241', prefs: { passFail: null } } },
            { id: 'r2', text: 'Weights updated', undo: 'garbage' },
            { id: 'r3', text: 'College set to SCS', undo: { settings: { college: null } }, undone: true },
          ],
        },
        { id: 'x', role: 'system', text: 'not ours' },
        { id: 'e1', role: 'assistant', text: 'Too many questions.', error: true },
      ]),
    )
    const [question, answer, error] = loadChat()
    expect(question).toEqual({ id: 'u1', role: 'user', text: '21-241 is pass/fail' })
    expect(answer.receipts?.map(canUndo)).toEqual([true, false, false])
    expect(answer.receipts?.[0].undo).toEqual({ courseKey: 'Fall 2026|21241', prefs: { passFail: null } })
    expect(answer.receipts?.[2].undone).toBe(true)
    expect(error.error).toBe(true)
  })
})

describe('consent and clearing', () => {
  test('consent is remembered', () => {
    expect(loadConsent()).toBe(false)
    saveConsent(true)
    expect(loadConsent()).toBe(true)
    saveConsent(false)
    expect(loadConsent()).toBe(false)
  })

  test('clearChatData removes the chat, the notes and the consent, and leaves the grades', () => {
    saveNotes(notes(1))
    saveChat([{ id: 'm1', role: 'user', text: 'Hi' }])
    saveConsent(true)
    localStorage.setItem(STORE_KEY, '{"v":1}')
    clearChatData()
    expect([MEMORY_KEY, CHAT_KEY, CONSENT_KEY].map((k) => localStorage.getItem(k))).toEqual([null, null, null])
    expect(localStorage.getItem(STORE_KEY)).toBe('{"v":1}')
  })

  test('blocked storage: loading gives defaults and saving does not throw', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      },
    })
    expect(loadNotes()).toEqual([])
    expect(loadChat()).toEqual([])
    expect(loadConsent()).toBe(false)
    expect(() => {
      saveNotes(notes(1))
      saveChat([])
      saveConsent(true)
      clearChatData()
    }).not.toThrow()
  })
})
