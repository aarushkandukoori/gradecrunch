// Tests for the AI advisor chat UI (src/ui/ChatPanel.tsx) and the notes list for Settings (src/ui/MemoryList.tsx), with a
// fake /api/chat: the first-use notice, sending, receipts with Undo, answers rendered as text (never HTML), clearing.
// All data is made up.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { demoPayloads } from '../src/lib/demo'
import { applyPayload, defaultStore } from '../src/lib/store'
import { CONSENT_KEY, loadChat, saveConsent, type Note } from '../src/lib/chat/memory'
import type { ChatReply } from '../src/lib/chat/protocol'
import type { Store } from '../src/types'
import { ChatPanel } from '../src/ui/ChatPanel'
import { MemoryList } from '../src/ui/MemoryList'

// Node 25 ships its own experimental global localStorage, which shadows jsdom's (see app.test.ts).
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

const STATS = 'Fall 2026|36200'
let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true })
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.restoreAllMocks()
})

function demoStore(): Store {
  let store = defaultStore()
  for (const payload of demoPayloads()) store = applyPayload(store, payload)
  return store
}

function reply(r: Partial<ChatReply>): Response {
  return new Response(JSON.stringify({ text: '', toolCalls: [], items: [], ...r }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function fakeFetch(...responses: Response[]) {
  return vi.fn(async () => {
    const next = responses.shift()
    if (!next) throw new Error('no more fake responses')
    return next
  }) as unknown as typeof fetch
}

/** Holds the store and the notes the way App does, and reports every store the panel saves. */
function Harness(props: { fetchImpl: typeof fetch; stores: Store[] }) {
  const [store, setStore] = useState(demoStore)
  const [notes, setNotes] = useState<Note[]>([])
  return createElement(ChatPanel, {
    open: true,
    onClose: () => {},
    store,
    onStoreChange: (s: Store) => {
      props.stores.push(s)
      setStore(s)
    },
    notes,
    onNotesChange: setNotes,
    fetchImpl: props.fetchImpl,
  })
}

async function render(element: ReturnType<typeof createElement>) {
  root = createRoot(container)
  await act(async () => root!.render(element))
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}

function button(label: string): HTMLButtonElement {
  const b = [...container.querySelectorAll('button')].find((el) => el.textContent?.trim() === label)
  if (!b) throw new Error(`no button "${label}"`)
  return b
}

function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ChatPanel', () => {
  test('asks first, then a question runs a tool, shows the receipt, and Undo puts the setting back', async () => {
    const stores: Store[] = []
    const fetchImpl = fakeFetch(
      reply({
        toolCalls: [{ id: 'c1', name: 'set_pass_fail', arguments: '{"course":"36-200","on":true}' }],
        items: [{ type: 'function_call', call_id: 'c1', name: 'set_pass_fail', arguments: '{"course":"36-200","on":true}' }],
      }),
      reply({ text: '**Done.** Your semester QPA goes from 3.00 to 3.33.' }),
    )
    await render(createElement(Harness, { fetchImpl, stores }))

    expect(container.querySelector('h2')?.textContent?.trim()).toBe('AI advisor')
    // The first-use notice comes first; nothing can be sent before it is accepted.
    expect(container.textContent).toContain('GradeCrunch keeps nothing on its server.')
    expect(container.textContent).toContain("OpenAI doesn't train on it and keeps it up to 30 days to check for abuse.")
    expect(container.querySelector('textarea')).toBeNull()
    await act(async () => button('OK, start').click())
    expect(localStorage.getItem(CONSENT_KEY)).toBe('yes')
    expect(container.querySelector('textarea')).not.toBeNull()
    // The sheet says it is not the student's real CMU academic advisor.
    expect(container.querySelector('.chat-foot')?.textContent).toBe('Estimates only, not your CMU academic advisor. Your official record is in SIO.')

    await act(async () => button('How does my QPA change if I take a class pass/fail?').click())
    await settle()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(container.querySelector('strong')?.textContent).toBe('Done.')
    expect(container.textContent).toContain('Your semester QPA goes from 3.00 to 3.33.')
    expect(container.textContent).toContain('36-200 set to pass/fail. QPA 3.00 -> 3.33')
    expect(stores.at(-1)?.prefs[STATS]).toEqual({ passFail: true }) // saved right away
    expect(container.querySelector('[role="progressbar"]')).toBeNull() // the typing dots are gone
    // Screen readers hear who said what.
    expect([...container.querySelectorAll('.chat-msg > .sr-only')].map((s) => s.textContent)).toEqual(['You: ', 'Advisor: '])

    await act(async () => button('Undo').click())
    expect(stores.at(-1)?.prefs[STATS]).toBeUndefined()
    expect(container.textContent).toContain('Undone')
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Undo')).toBe(false)

    const saved = loadChat()
    expect(saved.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(saved[1].receipts?.[0].undone).toBe(true)
  })

  test('answers are text, never HTML: bold and lists only', async () => {
    saveConsent(true)
    const fetchImpl = fakeFetch(reply({ text: '<img src=x onerror="alert(1)"> is just text.\n\nYou need:\n- **90%** on the final\n- 85% on HW 6' }))
    await render(createElement(Harness, { fetchImpl, stores: [] }))
    const input = container.querySelector('textarea')!
    await act(async () => typeInto(input, 'What do I need?'))
    // Enter sends (Shift+Enter would add a line).
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await settle()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror="alert(1)"> is just text.')
    const items = [...container.querySelectorAll('.chat-assistant li')].map((li) => li.textContent)
    expect(items).toEqual(['90% on the final', '85% on HW 6'])
    expect(container.querySelector('.chat-assistant li strong')?.textContent).toBe('90%')
    expect(input.value).toBe('') // the box is cleared after sending
  })

  test('an error shows in the chat, and Clear chat empties it', async () => {
    saveConsent(true)
    const fetchImpl = fakeFetch(new Response(JSON.stringify({ error: 'Too many questions at once. Wait a minute and try again.' }), { status: 429 }))
    await render(createElement(Harness, { fetchImpl, stores: [] }))
    await act(async () => button('What do I need on my finals?').click())
    await settle()
    expect(container.querySelector('.chat-error')?.textContent).toContain('Too many questions at once.')
    await act(async () => button('Clear chat').click())
    expect(container.querySelector('.chat-msg')).toBeNull()
    expect(loadChat()).toEqual([])
  })
})

describe('MemoryList', () => {
  const notes: Note[] = [
    { id: 'n1', text: 'Taking 36-200 pass/fail', at: '' },
    { id: 'n2', text: 'Wants an A in 15-122', at: '' },
  ]

  test('shows the notes; edit and delete call onChange', async () => {
    const onChange = vi.fn()
    await render(createElement(MemoryList, { notes, onChange }))
    expect(container.textContent).toContain('Taking 36-200 pass/fail')
    expect(container.textContent).toContain('Wants an A in 15-122')

    await act(async () => (container.querySelector('[aria-label="Delete note: Wants an A in 15-122"]') as HTMLButtonElement).click())
    expect(onChange).toHaveBeenLastCalledWith([notes[0]])

    await act(async () => (container.querySelector('[aria-label="Edit note: Taking 36-200 pass/fail"]') as HTMLButtonElement).click())
    const input = container.querySelector('.memory-edit input') as HTMLInputElement
    expect(input.value).toBe('Taking 36-200 pass/fail')
    await act(async () => typeInto(input, 'Taking 36-200 for a letter grade'))
    await act(async () => button('Save').click())
    expect(onChange).toHaveBeenLastCalledWith([{ ...notes[0], text: 'Taking 36-200 for a letter grade' }, notes[1]])
  })

  test('an edit that would duplicate a note is refused with a message', async () => {
    const onChange = vi.fn()
    await render(createElement(MemoryList, { notes, onChange }))
    await act(async () => (container.querySelector('[aria-label="Edit note: Taking 36-200 pass/fail"]') as HTMLButtonElement).click())
    await act(async () => typeInto(container.querySelector('.memory-edit input') as HTMLInputElement, 'wants an a in 15-122'))
    await act(async () => button('Save').click())
    expect(onChange).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('That note is already saved.')
  })

  test('says when there is nothing yet', async () => {
    await render(createElement(MemoryList, { notes: [], onChange: () => {} }))
    expect(container.textContent).toContain('Nothing yet.')
  })
})
