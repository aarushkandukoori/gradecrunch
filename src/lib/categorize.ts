// Name helpers for merging Canvas and Gradescope: make "HW01", "hw 1" and "Homework #1" compare equal, guess
// what kind of work an assignment is from its name, and pick the course category it most likely belongs to.

/**
 * Canonical form of an assignment name for matching across sites.
 * "Homework #01" -> "hw1", "Problem Set 3" -> "ps3", "Quiz #2" -> "quiz2".
 */
export function normalizeName(name: string): string {
  if (typeof name !== 'string') return ''
  return name
    .toLowerCase()
    .replace(/homework/g, 'hw')
    .replace(/problem\s*set/g, 'ps')
    .replace(/pset/g, 'ps')
    .replace(/[^a-z0-9]/g, '')
    .replace(/(?<!\d)0+(?=\d)/g, '') // leading zeros: "hw01" -> "hw1" (a lone "0" stays)
}

export type CategoryKind = 'Homework' | 'Quizzes' | 'Exams' | 'Labs' | 'Projects' | 'Participation' | 'Other'

// Checked top to bottom, first hit wins. The order settles mixed names: "Final Project" is a project, not an
// exam; "Lab Assignment" is a lab, not homework; "Recitation Quiz" is a quiz, not participation.
const KIND_WORDS: [CategoryKind, string[]][] = [
  ['Projects', ['project', 'projects']],
  ['Quizzes', ['quiz', 'quizzes']],
  ['Exams', ['exam', 'exams', 'midterm', 'midterms', 'final', 'finals', 'test', 'tests']],
  ['Labs', ['lab', 'labs']],
  ['Homework', ['hw', 'hws', 'homework', 'homeworks', 'ps', 'pset', 'psets', 'problem', 'assignment', 'assignments', 'writing', 'essay', 'essays']],
  ['Participation', ['participation', 'attendance', 'recitation', 'recitations']],
]

/** Lowercase letter-only words: "HW01" -> ["hw"], "Midterm 1A" -> ["midterm", "a"]. */
function words(name: string): string[] {
  return name.toLowerCase().split(/[^a-z]+/).filter(Boolean)
}

/** Guess the kind of work from a name: "HW 3" -> "Homework", "Midterm 1" -> "Exams", "Survey" -> "Other". */
export function inferCategory(itemName: string): string {
  if (typeof itemName !== 'string') return 'Other'
  const ws = words(itemName)
  for (const [kind, keywords] of KIND_WORDS) {
    if (ws.some((w) => keywords.includes(w))) return kind
  }
  return 'Other'
}

/**
 * Which existing category an assignment probably belongs to. Returns the category key, or null.
 *  1. A category with the same normalized name ("Midterm 1" -> category "Midterm 1").
 *  2. A category whose name starts the item name ("Midterm 1A" -> category "Midterm 1", "HW 3" -> "HW"),
 *     longest wins.
 *  3. A category of the same kind ("Quiz 3" -> "Quizzes"). Ties go to the one sharing the most words with the
 *     item, then to one with a positive weight (an empty "Imported Assignments" w=0 loses to "Assignments"
 *     w=25), then to list order.
 * `weight` is optional so callers can pass plain {key, name} lists.
 */
export function bestCategoryMatch(
  itemName: string,
  categories: { key: string; name: string; weight?: number | null }[],
): string | null {
  if (typeof itemName !== 'string' || !Array.isArray(categories)) return null
  const item = normalizeName(itemName)
  if (!item) return null

  // 1. exact name
  const exact = categories.find((c) => normalizeName(c.name) === item)
  if (exact) return exact.key

  // 2. prefix that ends where a letter run meets a digit run: "midterm1" + "a" and "hw" + "1" count, but
  //    "exam2" + "1" (would split a number) and "lab" + "or" (would split a word) do not.
  let prefix: { key: string; length: number } | null = null
  for (const c of categories) {
    const name = normalizeName(c.name)
    if (!name || !item.startsWith(name)) continue
    const lastIsDigit = /\d/.test(name[name.length - 1])
    const nextIsDigit = /\d/.test(item[name.length])
    if (lastIsDigit === nextIsDigit) continue
    if (!prefix || name.length > prefix.length) prefix = { key: c.key, length: name.length }
  }
  if (prefix) return prefix.key

  // 3. same kind of work
  const kind = inferCategory(itemName)
  if (kind === 'Other') return null
  const itemWords = words(itemName)
  let best: { key: string; score: number } | null = null
  for (const c of categories) {
    if (inferCategory(c.name) !== kind) continue
    const shared = words(c.name).filter((w) => itemWords.includes(w)).length
    const weighted = typeof c.weight === 'number' && c.weight > 0 ? 1 : 0
    const score = shared * 10 + weighted // shared words matter more than having a weight
    if (!best || score > best.score) best = { key: c.key, score }
  }
  return best ? best.key : null
}
