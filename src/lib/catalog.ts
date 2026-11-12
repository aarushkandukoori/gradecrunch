// Course number -> official title and units, from src/data/units.json (built from CMU's Schedule of Classes
// and course catalog). Units are a number for fixed-unit courses, or text like "VAR" / "3-12" when they vary.
//
// The table has ~8,700 courses (about half the app's download), so it is loaded separately with
// loadCatalog() instead of being bundled into the first page load. Until it arrives, lookupCourse returns
// null and the app shows default units; App re-renders once it is ready.

export interface CatalogEntry {
  title: string
  units: number | null // null when the catalog lists variable units ("VAR", "3-12", "9,12")
  unitsText: string // what the catalog says, e.g. "12" or "3-12"
}

// Compact format on disk: { "15122": { "t": "Principles of Imperative Computation", "u": 12 } }
type RawTable = Record<string, { t?: unknown; u?: unknown }>
let DATA: RawTable | null = null
let loading: Promise<void> | null = null

/** Fetch the table once (a separate file Vite splits out). Safe to call many times. */
export function loadCatalog(): Promise<void> {
  loading ??= import('../data/units.json').then((m) => {
    DATA = m.default as unknown as RawTable
  })
  return loading
}

/** True once loadCatalog() has finished. */
export function catalogReady(): boolean {
  return DATA !== null
}

/** Look up "15122" (or "15-122"). Returns null for unknown numbers, or before the table has loaded. */
export function lookupCourse(number: string): CatalogEntry | null {
  if (typeof number !== 'string' || DATA === null) return null
  const key = number.replace(/\D/g, '') // accept "15-122" too
  if (key.length !== 5 || !Object.hasOwn(DATA, key)) return null
  const entry = DATA[key]
  if (!entry || typeof entry !== 'object') return null
  const u = entry.u
  const units = typeof u === 'number' && Number.isFinite(u) ? u : null
  return {
    title: typeof entry.t === 'string' ? entry.t : '',
    units,
    unitsText: u === undefined || u === null ? '' : String(u),
  }
}
