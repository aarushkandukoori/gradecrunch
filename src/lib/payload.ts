// Turns a SyncPayload into a short string that fits in a URL fragment (#sync=...) and back.
//
// Format: "z" + base64url(gzip(JSON))  when the browser has CompressionStream (all modern ones)
//         "j" + base64url(UTF-8 JSON)  as a fallback
// The decoder never trusts its input: anyone can craft a #sync= link, so validatePayload rebuilds
// a clean SyncPayload field by field and throws away anything unexpected.
import type { GradeCut, ItemStatus, SyncedCategory, SyncedCourse, SyncedItem, SyncPayload } from '../types'
import { AUTOLAB_ORIGIN, CANVAS_ORIGIN, GRADESCOPE_ORIGIN } from './brand'

// Limits that keep a hostile or broken link from freezing the page.
const MAX_COURSES = 60
const MAX_ITEMS = 400
const MAX_CATEGORIES = 60
const MAX_NAME = 300
const MAX_WARNINGS = 50
const MAX_DECODED_BYTES = 10_000_000 // stops "gzip bombs" (tiny input that inflates to gigabytes)

const STATUSES: ItemStatus[] = ['graded', 'submitted', 'ungraded', 'missing', 'unsubmitted', 'excused']
const ALLOWED_HOSTS = [new URL(CANVAS_ORIGIN).host, new URL(GRADESCOPE_ORIGIN).host, new URL(AUTOLAB_ORIGIN).host]

// ---------------------------------------------------------------- encode / decode

export async function encodePayload(p: SyncPayload): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(p))
  if (typeof CompressionStream === 'function') {
    return 'z' + toBase64Url(await pipeThrough(json, new CompressionStream('gzip')))
  }
  return 'j' + toBase64Url(json)
}

export async function decodePayload(s: string): Promise<SyncPayload> {
  const kind = s.charAt(0)
  let bytes: Uint8Array
  try {
    bytes = fromBase64Url(s.slice(1))
    if (kind === 'z') {
      if (typeof DecompressionStream !== 'function') throw new Error('no DecompressionStream')
      bytes = await pipeThrough(bytes, new DecompressionStream('gzip'))
    } else if (kind !== 'j') {
      throw new Error('unknown format')
    }
  } catch {
    throw new Error('This sync link is broken. Click Sync grades again.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error('This sync link is broken. Click Sync grades again.')
  }
  return validatePayload(parsed)
}

/** Push bytes through a (de)compression stream and collect everything that comes out. */
async function pipeThrough(input: Uint8Array, transform: GenericTransformStream): Promise<Uint8Array> {
  const writer = transform.writable.getWriter()
  // Write without awaiting first: the stream only drains while we read, so awaiting here could hang.
  const writing = writer.write(input as Uint8Array<ArrayBuffer>).then(() => writer.close())
  writing.catch(() => {}) // a bad input also fails the reader below; that is the error we report

  const reader = (transform.readable as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_DECODED_BYTES) {
      await reader.cancel()
      throw new Error('payload too large')
    }
    chunks.push(value)
  }
  await writing

  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/** base64url = base64 with -_ instead of +/ and no "=" padding, so it is safe in a URL. */
export function toBase64Url(bytes: Uint8Array): string {
  // String.fromCharCode(...bigArray) overflows the call stack, so convert in 32 KB slices.
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url')
  const binary = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ---------------------------------------------------------------- validation

/** Rebuild a clean SyncPayload from untrusted data. Throws if it is not a sync payload at all. */
export function validatePayload(x: unknown): SyncPayload {
  if (!isObject(x) || x.v !== 1 || (x.kind !== 'canvas' && x.kind !== 'gradescope' && x.kind !== 'autolab')) {
    throw new Error('This sync link is not from a supported version. Drag the new Sync button from Setup.')
  }
  const kind = x.kind
  const at = str(x.at, 40) ?? new Date().toISOString()
  const courses: SyncedCourse[] = []
  for (const c of arr(x.courses).slice(0, MAX_COURSES)) {
    const clean = cleanCourse(c, kind, at)
    if (clean) courses.push(clean)
  }
  const warnings = arr(x.warnings)
    .map((w) => str(w, MAX_NAME))
    .filter((w): w is string => w !== null)
    .slice(0, MAX_WARNINGS)
  return { v: 1, kind, at, courses, warnings }
}

function cleanCourse(c: unknown, kind: SyncPayload['kind'], at: string): SyncedCourse | null {
  if (!isObject(c)) return null
  const sourceId = str(c.sourceId, 100)
  if (!sourceId) return null // merge keys depend on it, so a course without one is useless
  const siteRoot = { canvas: CANVAS_ORIGIN, gradescope: GRADESCOPE_ORIGIN, autolab: AUTOLAB_ORIGIN }[kind] + '/'
  return {
    source: kind, // the payload's kind decides the source, whatever the course claims
    sourceId,
    number: courseNumber(c.number),
    alsoNumbers: arr(c.alsoNumbers)
      .map(courseNumber)
      .filter((n): n is string => n !== null)
      .slice(0, 10),
    title: str(c.title, MAX_NAME) ?? '',
    term: str(c.term, 60),
    url: safeUrl(c.url) ?? siteRoot,
    weighted: c.weighted === true,
    categories: arr(c.categories).slice(0, MAX_CATEGORIES).map(cleanCategory).filter(notNull),
    items: arr(c.items).slice(0, MAX_ITEMS).map(cleanItem).filter(notNull),
    canvasScore: num(c.canvasScore),
    canvasGrade: str(c.canvasGrade, 10),
    scheme: cleanScheme(c.scheme),
    syncedAt: str(c.syncedAt, 40) ?? at,
  }
}

function cleanCategory(c: unknown): SyncedCategory | null {
  if (!isObject(c)) return null
  const id = str(c.id, 100)
  if (!id) return null
  return {
    id,
    name: str(c.name, MAX_NAME) ?? '',
    weight: num(c.weight),
    dropLowest: count(c.dropLowest),
    dropHighest: count(c.dropHighest),
    neverDrop: arr(c.neverDrop)
      .map((d) => str(d, 100))
      .filter(notNull)
      .slice(0, MAX_ITEMS),
  }
}

function cleanItem(i: unknown): SyncedItem | null {
  if (!isObject(i)) return null
  const id = str(i.id, 200)
  if (!id) return null
  const status = STATUSES.includes(i.status as ItemStatus) ? (i.status as ItemStatus) : 'unsubmitted'
  const due = str(i.due, 40)
  return {
    id,
    name: str(i.name, MAX_NAME) ?? '',
    categoryId: str(i.categoryId, 100),
    score: num(i.score),
    max: num(i.max),
    status,
    due: due && !Number.isNaN(Date.parse(due)) ? due : null,
    omit: i.omit === true,
    url: safeUrl(i.url),
  }
}

function cleanScheme(s: unknown): GradeCut[] | null {
  if (!Array.isArray(s)) return null
  const cuts: GradeCut[] = []
  for (const cut of s.slice(0, 30)) {
    if (!isObject(cut)) continue
    const letter = str(cut.letter, 10)
    const min = num(cut.min)
    if (letter && min !== null) cuts.push({ letter, min })
  }
  return cuts.length ? cuts.sort((a, b) => b.min - a.min) : null
}

// ---------------------------------------------------------------- small coercion helpers

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function arr(x: unknown): unknown[] {
  return Array.isArray(x) ? x : []
}

function notNull<T>(x: T | null): x is T {
  return x !== null
}

/** A string cut to `max` characters, or null for anything that is not a non-empty string. */
function str(x: unknown, max: number): string | null {
  return typeof x === 'string' && x !== '' ? x.slice(0, max) : null
}

/** A finite number (numeric strings accepted), else null. Rejects NaN and Infinity. */
function num(x: unknown): number | null {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null
  if (typeof x === 'string' && x.trim() !== '') {
    const n = Number(x)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** A whole number from 0 to MAX_ITEMS (used for drop counts). */
function count(x: unknown): number {
  const n = num(x)
  return n === null || n < 0 ? 0 : Math.min(Math.floor(n), MAX_ITEMS)
}

function courseNumber(x: unknown): string | null {
  return typeof x === 'string' && /^\d{5}$/.test(x) ? x : null
}

/** Keep a link only if it is https on Canvas, Gradescope or Autolab. Blocks javascript:, data:, look-alike hosts. */
function safeUrl(x: unknown): string | null {
  if (typeof x !== 'string' || x.length > 2000) return null
  try {
    const u = new URL(x)
    return u.protocol === 'https:' && ALLOWED_HOSTS.includes(u.host) ? u.href : null
  } catch {
    return null
  }
}
