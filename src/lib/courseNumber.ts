// Finds CMU course numbers ("21-241", "15122", "10-335/615") inside messy text like Canvas course codes,
// nicknames ("1. 21241") or Gradescope short names ("21259-1"). Returns them without the dash.

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
