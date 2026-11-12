// Finds CMU course numbers ("21-241", "15122", "10-335/615") inside messy text like Canvas course codes,
// nicknames ("1. 21241") or Gradescope short names ("21259-1"). Returns them without the dash.
// Also reads term names ("Fall 2026", "F26") so every site's spelling of a term compares equal.

// Two digits, optional dash, three digits, not glued to more digits on either side (so years like "2026" and
// runs like "120261" never match). The last group grabs slash shorthand: "10-335/615" means 10-335 and 10-615.
const NUMBER_RE = /(?<!\d)(\d{2})-?(\d{3})(?!\d)((?:\/\d{3}(?![\d-]))*)/g

/** Every course number in one piece of text, in order of appearance (may contain repeats). */
function numbersIn(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(NUMBER_RE)) {
    const dept = match[1]
    found.push(dept + match[2])
    // "/615" after "10-335" reuses the department: "10615". Split "/615/618" into ["615", "618"].
    const tail = match[3]
    if (tail) {
      for (const short of tail.split('/').filter(Boolean)) found.push(dept + short)
    }
  }
  return found
}

/**
 * First number found (looking at the texts in order) is the course number; every other distinct number is a
 * cross-listing. Example: ("15-213/18-213/15-513") -> { number: "15213", also: ["18213", "15513"] }.
 */
export function parseCourseNumbers(...texts: (string | null | undefined)[]): { number: string | null; also: string[] } {
  const all: string[] = []
  for (const text of texts) {
    if (typeof text !== 'string') continue // tolerate null, undefined and junk
    for (const n of numbersIn(text)) {
      if (!all.includes(n)) all.push(n)
    }
  }
  return { number: all[0] ?? null, also: all.slice(1) }
}

// ---------------------------------------------------------------- term names
// Sites write the same term differently ("Fall 2026", "fall 2026", "F26", "Summer One 2026"). These helpers
// live here (no imports) so the payload validator and the store can use them without pulling in the merge code.

const SEASONS: Record<string, number> = { spring: 1, summer: 2, fall: 3, s: 1, m: 2, n: 2, f: 3 }
const SEASON_NAMES = ['', 'Spring', 'Summer', 'Fall'] // index = season number above

/**
 * Sortable number for a term: year * 10 + season (Spring 1, Summer 2, Fall 3).
 * "Fall 2026" -> 20263, "S27" -> 20271, "M26"/"N26" (CMU summer codes) -> 20262. Unknown or null -> -1.
 */
export function termSortKey(term: string | null | undefined): number {
  if (typeof term !== 'string') return -1
  const t = term.trim().toLowerCase()
  const long = t.match(/\b(spring|summer|fall)\b\D*(\d{4})\b/) // "Fall 2026", "Summer I 2026"
  if (long) return Number(long[2]) * 10 + SEASONS[long[1]]
  const reversed = t.match(/\b(\d{4})\D*\b(spring|summer|fall)\b/) // "2026 Fall"
  if (reversed) return Number(reversed[1]) * 10 + SEASONS[reversed[2]]
  const short = t.match(/^([smnf])(\d{2})$/) // "F26"
  if (short) return (2000 + Number(short[2])) * 10 + SEASONS[short[1]]
  return -1
}

/**
 * One spelling per term, so the same class synced from two sites lands in one group:
 * "fall 2026", "F26", "Fall  2026" -> "Fall 2026"; "Summer One 2026", "M26" -> "Summer 2026".
 * A term we cannot read is kept as typed (spaces tidied); empty or missing -> null.
 * Built on termSortKey, so two terms with the same sort key always get the same name.
 */
export function canonicalTerm(term: string | null | undefined): string | null {
  if (typeof term !== 'string') return null
  const key = termSortKey(term)
  if (key > 0) return `${SEASON_NAMES[key % 10]} ${Math.floor(key / 10)}`
  const tidy = term.trim().replace(/\s+/g, ' ')
  return tidy || null
}
