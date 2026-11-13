// What the AI advisor chat in the browser and the /api/chat server send each other, plus the size limits both sides
// check.
// Shared by src/ (the chat panel) and functions/api/chat.ts (the server), so the two can never drift apart.
// Plain TypeScript only (no DOM, no Cloudflare types): both builds compile this file.
//
// One request = the conversation so far + a summary of the student's grades + their saved notes.
// One reply   = the AI's text and/or the tools it wants run. The browser runs the tools (they change settings
//               saved in the browser) and sends the results back in the next request.

export const LIMITS = {
  bodyBytes: 300_000, // one whole request
  items: 80, // conversation items in one request
  userChars: 2_000, // one student message
  textChars: 8_000, // one AI message or one tool result
  argsChars: 4_000, // one tool call's arguments (JSON text)
  reasoningChars: 100_000, // one encrypted reasoning item (an opaque blob from OpenAI)
  idChars: 200, // ids OpenAI gives to items and tool calls
  contextChars: 26_000, // the grade summary (context.ts keeps it under 25,000)
  // All the readable text of one request: grade summary, notes, messages, tool calls and results (everything except
  // encrypted reasoning, which OpenAI checks itself). The real chat stays well under it; it caps what a script can send.
  allTextChars: 60_000,
  notes: 50, // saved notes
  noteChars: 300, // one note
  rounds: 4, // AI calls per student message; the browser stops after this many
  toolCallsPerRound: 8, // tool calls the browser runs from one AI reply
  historyMessages: 40, // messages kept in the saved chat
  historySent: 20, // of those, how many go with each question
}

/** The tools the AI can ask for. The server describes them to OpenAI; the browser runs them (src/lib/chat/tools.ts). */
export const TOOL_NAMES = [
  'set_category_weights',
  'set_pass_fail',
  'set_units',
  'set_final_letter',
  'set_hidden',
  'set_profile',
  'what_if',
  'add_memory',
  'remove_memory',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

/** OpenAI labels the AI's messages: a short note before using a tool ("commentary") or the answer ("final_answer"). */
export type Phase = 'commentary' | 'final_answer'

/**
 * One piece of the conversation, in the shape OpenAI's Responses API takes as input (a small, checked subset).
 * Reasoning items are the AI's private notes in encrypted form: they are only passed back within one question,
 * so the AI can continue after a tool result. Nobody can read them, including us.
 */
export type ChatItem =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; phase?: Phase }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'reasoning'; id: string; encrypted_content: string }

/** A saved note as the AI sees it (the id lets it remove the note). */
export interface NoteForAi {
  id: string
  text: string
}

export interface ChatRequest {
  messages: ChatItem[]
  context: string // the grade summary from src/lib/chat/context.ts
  memory: NoteForAi[]
}

export interface ToolCall {
  id: string // OpenAI's call_id; the result must be sent back with the same id
  name: string
  arguments: string // JSON text
}

export interface ChatReply {
  text: string // what to show the student ('' while the AI only wants tools)
  toolCalls: ToolCall[]
  items: ChatItem[] // the AI's output, to send back as-is in the next request of the same question
}

// ---------------------------------------------------------------- checking a request (used by the server)

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** A string of at most `max` characters (and at least one when `nonEmpty`). */
function shortString(x: unknown, max: number, nonEmpty = false): x is string {
  return typeof x === 'string' && x.length <= max && (!nonEmpty || x.trim() !== '')
}

/** One conversation item, rebuilt with only the fields we know (so nothing unexpected reaches OpenAI), or an error. */
function parseItem(x: unknown, i: number): ChatItem | string {
  const where = `Message ${i + 1}`
  if (!isObject(x)) return `${where} is not an object.`
  if (x.role === 'user') {
    if (!shortString(x.content, LIMITS.userChars, true)) return `${where} is empty or longer than ${LIMITS.userChars} characters.`
    return { role: 'user', content: x.content }
  }
  if (x.role === 'assistant') {
    if (!shortString(x.content, LIMITS.textChars)) return `${where} is longer than ${LIMITS.textChars} characters.`
    if (x.phase !== undefined && x.phase !== 'commentary' && x.phase !== 'final_answer') return `${where} has an unknown phase.`
    return x.phase ? { role: 'assistant', content: x.content, phase: x.phase } : { role: 'assistant', content: x.content }
  }
  if (x.type === 'function_call') {
    if (!shortString(x.call_id, LIMITS.idChars, true)) return `${where} has a bad tool call id.`
    if (!(TOOL_NAMES as readonly unknown[]).includes(x.name)) return `${where} calls an unknown tool.`
    if (!shortString(x.arguments, LIMITS.argsChars)) return `${where} has tool arguments that are too long.`
    return { type: 'function_call', call_id: x.call_id, name: x.name as string, arguments: x.arguments }
  }
  if (x.type === 'function_call_output') {
    if (!shortString(x.call_id, LIMITS.idChars, true)) return `${where} has a bad tool call id.`
    if (!shortString(x.output, LIMITS.textChars)) return `${where} has a tool result that is too long.`
    return { type: 'function_call_output', call_id: x.call_id, output: x.output }
  }
  if (x.type === 'reasoning') {
    if (!shortString(x.id, LIMITS.idChars, true) || !shortString(x.encrypted_content, LIMITS.reasoningChars, true)) {
      return `${where} is a broken reasoning item.`
    }
    return { type: 'reasoning', id: x.id, encrypted_content: x.encrypted_content }
  }
  return `${where} has an unknown type.`
}

/** How much readable text a request carries (see LIMITS.allTextChars). */
export function requestTextChars(req: ChatRequest): number {
  let n = req.context.length
  for (const note of req.memory) n += note.id.length + note.text.length
  for (const m of req.messages) {
    if ('role' in m) n += m.content.length
    else if (m.type === 'function_call') n += m.name.length + m.arguments.length
    else if (m.type === 'function_call_output') n += m.output.length
  }
  return n
}

/**
 * Checks a request body and returns a clean copy, or a short error message for the student.
 * Rules: 1 to LIMITS.items messages, each one a known shape within its size limit; every tool result answers a tool
 * call that came before it, and every tool call has its result (OpenAI rejects a call left without one); the last
 * message is the student's question or a tool result (something to answer); the grade summary and the notes within
 * their limits, and all the text together within LIMITS.allTextChars.
 */
export function parseChatRequest(x: unknown): { ok: true; value: ChatRequest } | { ok: false; error: string } {
  if (!isObject(x)) return { ok: false, error: 'The request must be a JSON object.' }
  if (!Array.isArray(x.messages) || x.messages.length === 0) return { ok: false, error: 'There is no message to answer.' }
  if (x.messages.length > LIMITS.items) return { ok: false, error: 'This chat is too long. Clear the chat and try again.' }

  const messages: ChatItem[] = []
  const waiting = new Set<string>() // tool calls with no result yet
  for (const [i, raw] of x.messages.entries()) {
    const item = parseItem(raw, i)
    if (typeof item === 'string') return { ok: false, error: item }
    if ('type' in item && item.type === 'function_call') waiting.add(item.call_id)
    if ('type' in item && item.type === 'function_call_output') {
      if (!waiting.has(item.call_id)) return { ok: false, error: `Message ${i + 1} answers a tool call that isn't in the chat.` }
      waiting.delete(item.call_id)
    }
    messages.push(item)
  }
  if (waiting.size > 0) return { ok: false, error: 'A tool call in the chat has no result.' }
  const last = messages[messages.length - 1]
  const answerable = ('role' in last && last.role === 'user') || ('type' in last && last.type === 'function_call_output')
  if (!answerable) return { ok: false, error: 'The last message must be a question or a tool result.' }

  if (!shortString(x.context, LIMITS.contextChars)) return { ok: false, error: 'The grade summary is missing or too long.' }

  if (!Array.isArray(x.memory) || x.memory.length > LIMITS.notes) return { ok: false, error: 'The saved notes are missing or too many.' }
  const memory: NoteForAi[] = []
  for (const n of x.memory) {
    if (!isObject(n) || !shortString(n.id, 40, true) || !shortString(n.text, LIMITS.noteChars, true)) {
      return { ok: false, error: 'A saved note is broken or too long.' }
    }
    memory.push({ id: n.id, text: n.text })
  }

  const value = { messages, context: x.context, memory }
  if (requestTextChars(value) > LIMITS.allTextChars) return { ok: false, error: 'This chat is too long. Clear the chat and try again.' }
  return { ok: true, value }
}
