// Tests for the AI advisor chat's browser loop (src/lib/chat/client.ts) with a fake /api/chat: tools run and their results
// go back, changes are saved right away, history and size limits, errors, and the step limits. All data is made up.
import { describe, expect, test, vi } from 'vitest'
import { demoPayloads } from '../src/lib/demo'
import { applyPayload, defaultStore } from '../src/lib/store'
import { askChat, fitRequest, historyItems } from '../src/lib/chat/client'
import type { ChatMessage, Note } from '../src/lib/chat/memory'
import { LIMITS, requestTextChars, type ChatItem, type ChatReply, type ChatRequest } from '../src/lib/chat/protocol'
import type { ToolState } from '../src/lib/chat/tools'
import type { Store } from '../src/types'

const NOW = () => new Date(2026, 10, 13, 12)
const STATS = 'Fall 2026|36200'

function demoStore(): Store {
  let store = defaultStore()
  for (const payload of demoPayloads()) store = applyPayload(store, payload)
  return store
}

function reply(r: Partial<ChatReply>): Response {
  return new Response(JSON.stringify({ text: '', toolCalls: [], items: [], ...r }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function toolReply(id: string, name: string, args: unknown): Response {
  const call = { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }
  return reply({
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    items: [{ type: 'reasoning', id: `rs_${id}`, encrypted_content: 'opaque' }, call as ChatItem],
  })
}

/** A fake server that answers with these responses in order, and records each request body. */
function fakeServer(...responses: (Response | (() => Response) | Error)[]) {
  const bodies: ChatRequest[] = []
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    const next = responses.shift()
    if (next instanceof Error) throw next
    if (!next) throw new Error('no more fake responses')
    return typeof next === 'function' ? next() : next
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies, calls: fetchImpl }
}

/** The state a component would keep: tools read it and save into it. */
function holder(store = demoStore(), notes: Note[] = []) {
  let state: ToolState = { store, notes }
  const saves: ToolState[] = []
  return {
    getState: () => state,
    onChange: (next: ToolState) => {
      saves.push(next)
      state = next
    },
    get state() {
      return state
    },
    saves,
  }
}

describe('one question', () => {
  test('runs the tool, saves the change at once, sends the result back with the reasoning, and returns the answer', async () => {
    const h = holder()
    const server = fakeServer(toolReply('call_1', 'set_pass_fail', { course: '36-200', on: true }), reply({ text: 'Done. Your QPA is now 3.33.', items: [{ role: 'assistant', content: 'Done. Your QPA is now 3.33.', phase: 'final_answer' }] }))
    const result = await askChat({ question: 'I take 36-200 pass/fail', history: [], getState: h.getState, onChange: h.onChange, now: NOW, fetchImpl: server.fetchImpl })

    expect(result).toEqual({ text: 'Done. Your QPA is now 3.33.', receipts: [expect.objectContaining({ text: '36-200 set to pass/fail. QPA 3.00 -> 3.33' })], error: false })
    expect(h.saves).toHaveLength(1)
    expect(h.state.store.prefs[STATS]).toEqual({ passFail: true })

    expect(server.calls).toHaveBeenCalledTimes(2)
    expect(server.calls.mock.calls[0][0]).toBe('/api/chat')
    const init = server.calls.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.mode).toBeUndefined() // the default ('cors'), so the browser sends the real Origin
    const [first, second] = server.bodies
    expect(first.messages).toEqual([{ role: 'user', content: 'I take 36-200 pass/fail' }])
    expect(first.context).toContain('[key: Fall 2026|36200]')
    expect(second.context).toBe(first.context) // the same summary for every call of one question
    expect(second.messages.slice(1, 3)).toEqual([
      { type: 'reasoning', id: 'rs_call_1', encrypted_content: 'opaque' },
      { type: 'function_call', call_id: 'call_1', name: 'set_pass_fail', arguments: '{"course":"36-200","on":true}' },
    ])
    const output = second.messages[3] as { type: string; call_id: string; output: string }
    expect(output.type).toBe('function_call_output')
    expect(output.call_id).toBe('call_1')
    expect(output.output).toMatch(/^Done\. 36-200 set to pass\/fail\./)
  })

  test('saved notes go with each call, including one saved during the question', async () => {
    const h = holder(demoStore(), [{ id: 'n1', text: 'Wants an A in 15-122', at: '' }])
    const server = fakeServer(toolReply('c1', 'add_memory', { text: 'Taking 36-200 pass/fail' }), reply({ text: 'Noted.' }))
    const result = await askChat({ question: 'Remember I take 36-200 pass/fail', history: [], getState: h.getState, onChange: h.onChange, now: NOW, fetchImpl: server.fetchImpl })
    expect(result.text).toBe('Noted.')
    expect(server.bodies[0].memory).toEqual([{ id: 'n1', text: 'Wants an A in 15-122' }])
    expect(server.bodies[1].memory.map((n) => n.text)).toEqual(['Wants an A in 15-122', 'Taking 36-200 pass/fail'])
  })

  test('a tool works on the latest store, even if a sync landed while the AI was thinking', async () => {
    const h = holder()
    const synced = { ...demoStore(), settings: { ...defaultStore().settings, college: 'cit' } }
    const server = fakeServer(() => {
      h.onChange({ store: synced, notes: [] }) // something else saved a new store meanwhile
      return toolReply('c1', 'set_units', { course: '36-200', units: 12 })
    }, reply({ text: 'Done.' }))
    await askChat({ question: '36-200 is 12 units', history: [], getState: h.getState, onChange: h.onChange, now: NOW, fetchImpl: server.fetchImpl })
    expect(h.state.store.settings.college).toBe('cit') // not lost
    expect(h.state.store.prefs[STATS]).toEqual({ units: 12 })
  })
})

describe('stopping a question', () => {
  test('a stopped question changes nothing, even when the answer still arrives', async () => {
    const h = holder()
    const stop = new AbortController()
    const server = fakeServer(() => {
      stop.abort() // the chat was started over (another tab deleted everything) while the AI was thinking
      return toolReply('c1', 'set_pass_fail', { course: '36-200', on: true })
    })
    const result = await askChat({ question: 'I take 36-200 pass/fail', history: [], getState: h.getState, onChange: h.onChange, now: NOW, fetchImpl: server.fetchImpl, signal: stop.signal })
    expect(result).toEqual({ text: 'Stopped.', receipts: [], error: true })
    expect(h.saves).toHaveLength(0) // the tool never ran
    expect(server.calls).toHaveBeenCalledTimes(1)
    expect((server.calls.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true) // the request itself is cancelled
  })
})

describe('errors and limits', () => {
  test("the server's own message is shown", async () => {
    const server = fakeServer(new Response(JSON.stringify({ error: 'Too many questions at once. Wait a minute and try again.' }), { status: 429 }))
    const h = holder()
    const result = await askChat({ question: 'Hi', history: [], getState: h.getState, onChange: h.onChange, now: NOW, fetchImpl: server.fetchImpl })
    expect(result).toEqual({ text: 'Too many questions at once. Wait a minute and try again.', receipts: [], error: true })
  })

  test('no connection, a missing server and a broken answer each get a plain message', async () => {
    const h = holder()
    const ask = (server: ReturnType<typeof fakeServer>) => askChat({ question: 'Hi', history: [], getState: h.getState, onChange: h.onChange, now: NOW, fetchImpl: server.fetchImpl })
    expect((await ask(fakeServer(new TypeError('Failed to fetch')))).text).toMatch(/Couldn't reach GradeCrunch/)
    expect((await ask(fakeServer(new Response('Not found', { status: 404 })))).text).toBe("The AI advisor isn't available here.")
    expect((await ask(fakeServer(new Response(JSON.stringify({ toolCalls: 'x' }), { status: 200 })))).text).toBe("Couldn't read the answer. Try again.")
  })

  test(`stops after ${LIMITS.rounds} calls, and doesn't run tools it can't report back`, async () => {
    const h = holder()
    const units = [10, 11, 12, 13]
    const server = fakeServer(...units.map((u, i) => toolReply(`c${i}`, 'set_units', { course: '36-200', units: u })))
    const result = await askChat({ question: 'Loop', history: [], getState: h.getState, onChange: h.onChange, now: NOW, fetchImpl: server.fetchImpl })
    expect(server.calls).toHaveBeenCalledTimes(LIMITS.rounds)
    expect(result.receipts).toHaveLength(LIMITS.rounds - 1)
    expect(h.state.store.prefs[STATS]).toEqual({ units: 12 }) // the 4th call's change was not made
    expect(result.text).toMatch(/ran out of steps/)
  })

  test(`runs at most ${LIMITS.toolCallsPerRound} tool calls from one answer`, async () => {
    const h = holder()
    const calls = Array.from({ length: LIMITS.toolCallsPerRound + 1 }, (_, i) => ({ id: `c${i}`, name: 'add_memory', arguments: JSON.stringify({ text: `Made-up fact ${i}` }) }))
    const server = fakeServer(
      reply({ toolCalls: calls, items: calls.map((c) => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments })) }),
      reply({ text: 'Saved.' }),
    )
    await askChat({ question: 'Remember all this', history: [], getState: h.getState, onChange: h.onChange, now: NOW, fetchImpl: server.fetchImpl })
    expect(h.state.notes).toHaveLength(LIMITS.toolCallsPerRound)
    const outputs = server.bodies[1].messages.filter((m) => 'type' in m && m.type === 'function_call_output') as { output: string }[]
    expect(outputs).toHaveLength(LIMITS.toolCallsPerRound + 1) // every call still gets an answer
    expect(outputs[LIMITS.toolCallsPerRound].output).toMatch(/^Error: too many changes at once/)
  })
})

describe('history', () => {
  test('the last 20 messages, without errors; answers say what changed and what the student undid', () => {
    const history: ChatMessage[] = [
      ...Array.from({ length: 30 }, (_, i): ChatMessage => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `Message ${i}` })),
      { id: 'q', role: 'user', text: '36-200 is pass/fail' },
      {
        id: 'a',
        role: 'assistant',
        text: 'Done.',
        receipts: [
          { id: 'r1', text: '36-200 set to pass/fail. QPA 3.00 -> 3.33', undo: { courseKey: STATS, prefs: { passFail: null } }, undone: true },
          { id: 'r2', text: 'Saved to memory: Taking 36-200 pass/fail', undo: { addedNoteId: 'n1' } },
        ],
      },
      { id: 'e', role: 'assistant', text: 'Too many questions at once.', error: true },
    ]
    const items = historyItems(history)
    expect(items).toHaveLength(LIMITS.historySent - 1) // 20 messages, minus the error
    expect(items.at(-1)).toEqual({
      role: 'assistant',
      content: 'Done.\n(Changed, then undone by the student: 36-200 set to pass/fail. QPA 3.00 -> 3.33)\n(Changed: Saved to memory: Taking 36-200 pass/fail)',
      phase: 'final_answer',
    })
  })

  test('a request that is too long drops the oldest messages first and always keeps the question', () => {
    const past: ChatItem[] = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i} ${'x'.repeat(5_000)}` }) as ChatItem)
    const question: ChatItem = { role: 'user', content: 'The question' }
    const request = fitRequest(past, [question], 'y'.repeat(24_000), [{ id: 'n1', text: 'Taking 21-241 pass/fail' }])
    expect(requestTextChars(request)).toBeLessThanOrEqual(LIMITS.allTextChars)
    expect(new TextEncoder().encode(JSON.stringify(request)).length).toBeLessThanOrEqual(LIMITS.bodyBytes)
    // 24,000 for the summary + 5,002 per message: the 3 oldest messages go, the 7 newest stay.
    expect(request.messages).toHaveLength(8)
    expect((request.messages[0] as { content: string }).content.startsWith('3 ')).toBe(true)
    expect(request.messages.at(-1)).toEqual(question)
    expect(request.memory).toEqual([{ id: 'n1', text: 'Taking 21-241 pass/fail' }])
  })
})
