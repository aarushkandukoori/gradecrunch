// Turns a SyncPayload into a short string that fits in a URL fragment (#sync=...) and back.
//
// Format: "z" + base64url(gzip(JSON))  when the browser has CompressionStream (all modern ones)
//         "j" + base64url(UTF-8 JSON)  as a fallback
// The decoder never trusts its input: anyone can craft a #sync= link, so validatePayload rebuilds
// a clean SyncPayload field by field and throws away anything unexpected.
import type { GradeCut, ItemStatus, SyncedCategory, SyncedCourse, SyncedItem, SyncPayload } from '../types'
import { AUTOLAB_ORIGIN, CANVAS_ORIGIN, GRADESCOPE_ORIGIN } from './brand'
import { termSortKey } from './courseNumber'

// Limits that keep a hostile or broken link from freezing the page (the grade math runs on every course on
// every render). Real CMU data is far below them. Whenever something is cut, the payload gets a warning.
const MAX_COURSES = 40
const MAX_ITEMS = 400 // per course
const MAX_TOTAL_ITEMS = 4000 // across all courses
const MAX_CATEGORIES = 40 // per course
const MAX_CUTS = 15 // letter-scheme rows (A+ ... R is 13)
const MAX_FAILED_IDS = 100
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
  const ours: string[] = [] // warnings about what we cut here

  let rawCourses = arr(x.courses)
  if (rawCourses.length > MAX_COURSES) {
    // Keep the newest terms (the ones the dashboard shows). sort is stable, so same-term courses keep their order.
    const termOf = (c: unknown) => termSortKey(isObject(c) && typeof c.term === 'string' ? c.term : null)
    rawCourses = [...rawCourses].sort((a, b) => termOf(b) - termOf(a))
    ours.push(`Only the first ${MAX_COURSES} of ${rawCourses.length} courses were kept (newest terms first).`)
    rawCourses = rawCourses.slice(0, MAX_COURSES)
  }

  const courses: SyncedCourse[] = []
  let itemBudget = MAX_TOTAL_ITEMS // shrinks as courses use it up
  let unreadable = 0
  for (const c of rawCourses) {
    const clean = cleanCourse(c, kind, at, itemBudget, ours)
    if (!clean) {
      unreadable++
      continue
    }
    itemBudget -= clean.items.length
    courses.push(clean)
  }
  if (unreadable > 0) ours.push(`${plural(unreadable, 'course')} could not be read and ${unreadable === 1 ? 'was' : 'were'} skipped.`)

  const theirs = arr(x.warnings)
    .map((w) => str(w, MAX_NAME))
    .filter((w): w is string => w !== null)
  // Ours first, so a sync that already sent many warnings cannot push out the news that data was cut.
  const warnings = [...ours, ...theirs].slice(0, MAX_WARNINGS)

  const failedIds = arr(x.failedIds)
    .map((id) => str(id, 100))
    .filter(notNull)
    .slice(0, MAX_FAILED_IDS)
  return { v: 1, kind, at, courses, warnings, ...(failedIds.length > 0 ? { failedIds } : {}) }
}

/**
 * One clean course, or null when it has no sourceId. `itemBudget` is how many items are still allowed across
 * the whole payload; anything cut is reported in `warnings`.
 */
function cleanCourse(c: unknown, kind: SyncPayload['kind'], at: string, itemBudget: number, warnings: string[]): SyncedCourse | null {
  if (!isObject(c)) return null
  const sourceId = str(c.sourceId, 100)
  if (!sourceId) return null // merge keys depend on it, so a course without one is useless
  const siteRoot = { canvas: CANVAS_ORIGIN, gradescope: GRADESCOPE_ORIGIN, autolab: AUTOLAB_ORIGIN }[kind] + '/'
  const title = str(c.title, MAX_NAME) ?? ''
  const label = title || `course ${sourceId}`

  // Items: drop unreadable ones, then cut to the per-course and whole-payload limits.
  const rawItems = arr(c.items)
  const readable = rawItems.map(cleanItem).filter(notNull)
  const limit = Math.max(0, Math.min(MAX_ITEMS, itemBudget))
  const items = readable.slice(0, limit)
  const skipped = rawItems.length - readable.length
  if (skipped > 0) warnings.push(`${label}: ${plural(skipped, 'unreadable item')} skipped.`)
  if (readable.length > limit) warnings.push(`${label}: only the first ${limit} of ${readable.length} items were kept.`)

  const rawCategories = arr(c.categories)
  if (rawCategories.length > MAX_CATEGORIES) {
    warnings.push(`${label}: only the first ${MAX_CATEGORIES} of ${rawCategories.length} assignment groups were kept.`)
  }
  const categories = rawCategories
    .slice(0, MAX_CATEGORIES)
    .map((cat) => cleanCategory(cat, items))
    .filter(notNull)

  const rawScheme = arr(c.scheme)
  if (rawScheme.length > MAX_CUTS) warnings.push(`${label}: only the first ${MAX_CUTS} rows of the letter scheme were kept.`)

  return {
    source: kind, // the payload's kind decides the source, whatever the course claims
    sourceId,
    number: courseNumber(c.number),
    alsoNumbers: arr(c.alsoNumbers)
      .map(courseNumber)
      .filter((n): n is string => n !== null)
      .slice(0, 10),
    title,
    term: str(c.term, 60),
    url: safeUrl(c.url) ?? siteRoot,
    weighted: c.weighted === true,
    categories,
    items,
    canvasScore: num(c.canvasScore),
    canvasGrade: str(c.canvasGrade, 10),
    scheme: cleanScheme(c.scheme),
    syncedAt: str(c.syncedAt, 40) ?? at,
  }
}

/** One clean category. Drop counts are capped at how many items it has (more would only slow the grade math). */
function cleanCategory(c: unknown, items: SyncedItem[]): SyncedCategory | null {
  if (!isObject(c)) return null
  const id = str(c.id, 100)
  if (!id) return null
  const size = items.filter((i) => i.categoryId === id).length
  return {
    id,
    name: str(c.name, MAX_NAME) ?? '',
    weight: num(c.weight),
    dropLowest: Math.min(count(c.dropLowest), size),
    dropHighest: Math.min(count(c.dropHighest), size),
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
  for (const cut of s.slice(0, MAX_CUTS)) {
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

/** "1 course", "3 courses". */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
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
