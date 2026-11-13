// The browser half of the AI advisor chat. For one question it:
//   1. builds the grade summary once (context.ts),
//   2. sends the recent chat + the question + the summary + the saved notes to /api/chat,
//   3. runs any tools the AI asks for (tools.ts), saving each change right away so the QPA updates on screen,
//      and sends the results back, at most LIMITS.rounds calls per question,
//   4. returns the answer and the receipts of what changed.
// The grade summary stays the same for every call of one question, so the AI's earlier reasoning still matches
// it; tool results carry the new numbers.
import { buildContext } from './context'
import type { ChatMessage, Receipt } from './memory'
import { LIMITS, requestTextChars, type ChatItem, type ChatReply, type ChatRequest, type NoteForAi, type ToolCall } from './protocol'
import { runTool, type ToolState } from './tools'

export const CHAT_ENDPOINT = '/api/chat'
const TIMEOUT_MS = 45_000 // the server gives OpenAI 30 seconds

export interface AskOptions {
  question: string
  history: ChatMessage[] // the chat so far, oldest first, without this question
  getState: () => ToolState // the latest store and notes (a sync can change them while the AI thinks)
  onChange: (state: ToolState) => void // a tool changed something: save it now
  now?: () => Date
  fetchImpl?: typeof fetch // tests pass a fake server
  // Stops the question: the request is cancelled and no tool runs, so nothing changes (the chat sheet sends this when
  // it goes away, for example when another tab deleted everything while the answer was on its way).
  signal?: AbortSignal
}

export interface AskResult {
  text: string // the answer, or what went wrong
  receipts: Receipt[] // changes made while answering
  error: boolean
}

export async function askChat(opts: AskOptions): Promise<AskResult> {
  const now = opts.now ?? (() => new Date())
  const doFetch = opts.fetchImpl ?? fetch
  const context = buildContext(opts.getState().store, now())
  const past = historyItems(opts.history)
  const current: ChatItem[] = [{ role: 'user', content: opts.question.slice(0, LIMITS.userChars) }]
  const receipts: Receipt[] = []
  const texts: string[] = [] // answer text from every call (usually only the last one has any)

  for (let round = 1; round <= LIMITS.rounds; round++) {
    const memory: NoteForAi[] = opts.getState().notes.map((n) => ({ id: n.id, text: n.text }))
    const reply = await callServer(doFetch, fitRequest(past, current, context, memory), opts.signal)
    if (opts.signal?.aborted) return { text: 'Stopped.', receipts, error: true }
    if ('error' in reply) return { text: [...texts, reply.error].join('\n\n'), receipts, error: true }
    current.push(...reply.items)
    if (reply.text.trim()) texts.push(reply.text.trim())
    if (reply.toolCalls.length === 0) return { text: texts.join('\n\n') || 'Done.', receipts, error: false }
    if (round === LIMITS.rounds) break // no call left to send the results in: don't make changes the AI can't report
    for (const [i, call] of reply.toolCalls.entries()) {
      const output = i < LIMITS.toolCallsPerRound ? runOne(call, opts, now(), receipts) : `Error: too many changes at once. Make at most ${LIMITS.toolCallsPerRound} per step.`
      current.push({ type: 'function_call_output', call_id: call.id, output: output.slice(0, LIMITS.textChars) })
    }
  }
  const stopped = receipts.length > 0 ? 'I made the changes above, but ran out of steps before I could finish. Ask again if something is missing.' : 'That took too many steps. Try asking one thing at a time.'
  return { text: [...texts, stopped].join('\n\n'), receipts, error: receipts.length === 0 && texts.length === 0 }
}

/** Runs one tool call against the latest state and saves what it changed. Returns the text for the AI. */
function runOne(call: ToolCall, opts: AskOptions, now: Date, receipts: Receipt[]): string {
  const result = runTool(call.name, call.arguments, opts.getState(), now)
  if (result.receipt) {
    receipts.push(result.receipt)
    opts.onChange({ store: result.store, notes: result.notes })
  }
  return result.output
}

/**
 * The saved chat as conversation items: the last LIMITS.historySent messages, without error messages. Each answer
 * keeps a line about the changes made while giving it, and about any the student undid since, so the AI knows.
 */
export function historyItems(history: ChatMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  for (const m of history.slice(-LIMITS.historySent)) {
    if (m.error || m.text.trim() === '') continue
    if (m.role === 'user') {
      items.push({ role: 'user', content: m.text.slice(0, LIMITS.userChars) })
      continue
    }
    const changes = (m.receipts ?? []).map((r) => (r.undone ? `(Changed, then undone by the student: ${r.text})` : `(Changed: ${r.text})`))
    const content = [m.text, ...changes].join('\n').slice(0, LIMITS.textChars)
    items.push({ role: 'assistant', content, phase: 'final_answer' })
  }
  return items
}

/** The request, dropping the oldest chat messages until it fits the server's limits. This question always stays. */
export function fitRequest(past: ChatItem[], current: ChatItem[], context: string, memory: NoteForAi[]): ChatRequest {
  for (let start = 0; ; start++) {
    const request = { messages: [...past.slice(start), ...current], context, memory }
    const fits =
      request.messages.length <= LIMITS.items &&
      requestTextChars(request) <= LIMITS.allTextChars &&
      new TextEncoder().encode(JSON.stringify(request)).length <= LIMITS.bodyBytes - 2_000
    if (fits || start >= past.length) return request
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** The request's signal: our timeout, plus `stop` when given. Either one cancels the request. */
function requestSignal(stop?: AbortSignal): AbortSignal | undefined {
  const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined
  if (!stop || !timeout) return stop ?? timeout
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([stop, timeout]) : stop
}

/** One POST to /api/chat. Returns the reply, or { error } with a message for the student. */
async function callServer(doFetch: typeof fetch, request: ChatRequest, stop?: AbortSignal): Promise<ChatReply | { error: string }> {
  let res: Response
  try {
    res = await doFetch(CHAT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      // Keep fetch's default mode ('cors'). With mode 'same-origin', this site's no-referrer policy makes browsers
      // send "Origin: null", and the server only answers requests from its own origin.
      signal: requestSignal(stop),
    })
  } catch (err) {
    const timedOut = isObject(err) && err.name === 'TimeoutError'
    return { error: timedOut ? 'The answer took too long. Try again.' : "Couldn't reach GradeCrunch. Check your connection and try again." }
  }
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // not JSON: handled below
  }
  if (!res.ok) {
    if (isObject(data) && typeof data.error === 'string') return { error: data.error.slice(0, 300) }
    return { error: res.status === 404 ? "The AI advisor isn't available here." : 'Something went wrong. Try again in a minute.' }
  }
  return readReply(data) ?? { error: "Couldn't read the answer. Try again." }
}

/** The server's reply, checked: text, tool calls and the items to send back. */
function readReply(data: unknown): ChatReply | null {
  if (!isObject(data) || typeof data.text !== 'string' || !Array.isArray(data.toolCalls) || !Array.isArray(data.items)) return null
  const toolCalls: ToolCall[] = []
  for (const c of data.toolCalls) {
    if (!isObject(c) || typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.arguments !== 'string') return null
    toolCalls.push({ id: c.id, name: c.name, arguments: c.arguments })
  }
  if (!data.items.every(isObject)) return null
  return { text: data.text.slice(0, LIMITS.textChars), toolCalls, items: data.items as ChatItem[] }
}
