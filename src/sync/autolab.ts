// Autolab sync (beta): reads the student's own Autolab pages (HTML, same-origin) inside the Sync bookmarklet.
// Autolab (autolab.andrew.cmu.edu) has an API, but only Autolab admins can register apps for it, so like
// Gradescope we read the pages the student can already see:
//   /courses                           -> list of courses (cards), with a "Gradebook" link per course
//   /courses/<c>/course_user_data/<id>/gradebook  -> redirects to .../gradebook/student: one table per category
// Selectors come from Autolab's open-source templates (github.com/autolab/Autolab, app/views/courses/index and
// app/views/gradebooks/student). Every lookup is defensive: a missing element is skipped, never thrown on.

import type { ItemStatus, SyncedCategory, SyncedCourse, SyncedItem, SyncPayload } from '../types'
import { AUTOLAB_ORIGIN } from '../lib/brand'
import { parseCourseNumbers } from '../lib/courseNumber'

export interface AutolabCourseRef {
  slug: string // "15213-f26"
  name: string // "Introduction to Computer Systems (f26)"
  status: string // "current", "completed", "upcoming", "disabled"
  gradebookPath: string // "/courses/15213-f26/course_user_data/1001/gradebook"
}

function toDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** A finite number from text like "87.5", or null. */
function num(text: string): number | null {
  const n = Number(text.replace(/,/g, '').trim())
  return text.trim() !== '' && Number.isFinite(n) ? n : null
}

/**
 * Autolab course names usually end with a term code like "(f26)" or "(S27)". Turn that into "Fall 2026".
 * Returns null when there is no recognizable code.
 */
export function termFromAutolabName(...texts: string[]): string | null {
  for (const t of texts) {
    const m = t.match(/(?:^|[^a-z0-9])(f|s|m|n|fall|spring|summer)[-_ ]?(\d{2}|\d{4})(?![0-9])/i)
    if (!m) continue
    const season = m[1].toLowerCase()
    const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2])
    const name = season.startsWith('f') ? 'Fall' : season.startsWith('s') && season !== 'summer' ? 'Spring' : 'Summer'
    return `${name} ${year}`
  }
  return null
}

/** Student courses from the /courses page (instructor and course-assistant cards are skipped). */
export function parseAutolabCourses(html: string): AutolabCourseRef[] {
  const doc = toDoc(html)
  const out: AutolabCourseRef[] = []
  for (const section of Array.from(doc.querySelectorAll('div.section'))) {
    const status = textOf(section.querySelector('.section-title')).toLowerCase()
    if (status.includes('disabled') || status.includes('upcoming')) continue
    for (const card of Array.from(section.querySelectorAll('div.card'))) {
      // A badge like "Instructor" or "Course Assistant" means these are not the student's own grades.
      if (card.querySelector('span.badge[data-badge-caption]')) continue
      const gradebook = card.querySelector('a[title="View your gradebook"]')?.getAttribute('href') ?? ''
      const courseHref = card.querySelector('a[title="Go to Course Page"]')?.getAttribute('href') ?? ''
      const slug = courseHref.split('/')[2] ?? ''
      // Only same-site relative links: never follow anything that leaves Autolab.
      if (!slug || !gradebook.startsWith('/courses/')) continue
      out.push({ slug, name: textOf(card.querySelector('.card-title')) || slug, status, gradebookPath: gradebook })
    }
  }
  return out
}

/** One category table of the student gradebook -> category + items. */
function parseCategoryTable(table: Element, index: number): { category: SyncedCategory; items: SyncedItem[] } {
  const name = textOf(table.querySelector('tr.header .cat_name')) || `Category ${index + 1}`
  const category: SyncedCategory = { id: name, name, weight: null, dropLowest: 0, dropHighest: 0, neverDrop: [] }
  const items: SyncedItem[] = []
  for (const row of Array.from(table.querySelectorAll('tr'))) {
    if (row.classList.contains('header') || row.classList.contains('footer')) continue
    const cells = row.querySelectorAll('td')
    if (cells.length < 2) continue
    const link = cells[0].querySelector('a')
    const itemName = textOf(cells[0])
    if (!itemName) continue
    const href = link?.getAttribute('href') ?? ''
    const slug = href.split('/').filter(Boolean).pop() ?? itemName
    const scoreCell = cells[cells.length - 1] // the final score is always the last column

    let score: number | null = null
    let max = num(textOf(scoreCell.querySelector('.max_score')))
    let status: ItemStatus = 'graded'
    if (scoreCell.querySelector('.excused')) {
      status = 'excused'
      max = null
    } else if (scoreCell.querySelector('.not-yet-submitted')) {
      status = 'unsubmitted' // not due yet: the 0.0 shown is a placeholder, not a real zero
    } else if (scoreCell.querySelector('i.material-icons, img')) {
      status = 'ungraded' // clock icon: some problem scores are not released yet (or a grading error)
    } else {
      // Graded, or past due with nothing submitted (Autolab shows a real 0.0 for that).
      score = num(textOf(scoreCell.querySelector('a')) || textOf(scoreCell).split('/')[0])
      if (score === null) status = 'unsubmitted'
      else if (scoreCell.querySelector('.not-submitted')) status = 'missing'
    }

    items.push({
      id: slug,
      name: itemName,
      categoryId: category.id,
      score,
      max,
      status,
      due: null,
      omit: false,
      url: href.startsWith('/courses/') ? AUTOLAB_ORIGIN + href : null,
    })
  }
  return { category, items }
}

/** Categories and items from a student gradebook page. */
export function parseAutolabGradebook(html: string): { categories: SyncedCategory[]; items: SyncedItem[] } {
  const doc = toDoc(html)
  const categories: SyncedCategory[] = []
  const items: SyncedItem[] = []
  Array.from(doc.querySelectorAll('table.grades')).forEach((table, i) => {
    const parsed = parseCategoryTable(table, i)
    if (parsed.items.length === 0) return
    categories.push(parsed.category)
    items.push(...parsed.items)
  })
  return { categories, items }
}

/**
 * Sync every current/completed student course. `fetchPage(path)` fetches a same-origin path and returns the
 * HTML plus the final URL after redirects; it throws when the request fails (e.g. a redirect to the CMU login).
 */
export async function syncAutolab(
  fetchPage: (path: string) => Promise<{ html: string; url: string }>,
  onProgress?: (msg: string) => void,
): Promise<SyncPayload> {
  const progress = onProgress ?? (() => {})
  progress('Autolab: reading your course list')
  let list: { html: string; url: string }
  try {
    list = await fetchPage('/courses')
  } catch {
    throw new Error('Log in to Autolab first')
  }
  if (new URL(list.url, AUTOLAB_ORIGIN).pathname.startsWith('/auth/')) throw new Error('Log in to Autolab first')

  const refs = parseAutolabCourses(list.html).filter((r) => r.status.includes('current'))
  const warnings: string[] = []
  const courses: SyncedCourse[] = []
  const failedIds: string[] = [] // courses we could not read: the app keeps their previously stored copy
  const at = new Date().toISOString()
  // One request at a time: Autolab is a small CMU server, be gentle.
  for (const [i, ref] of refs.entries()) {
    progress(`Autolab: ${i + 1} of ${refs.length} courses`)
    let page: { html: string; url: string }
    try {
      page = await fetchPage(ref.gradebookPath)
    } catch (err) {
      warnings.push(`Autolab: couldn't read ${ref.name} (${err instanceof Error ? err.message : String(err)})`)
      failedIds.push(ref.slug)
      continue
    }
    const path = new URL(page.url, AUTOLAB_ORIGIN).pathname
    // The session ran out mid-sync (Autolab redirected to its login page). Without this check the login page
    // would look like a gradebook with zero assignments and replace the good stored copy.
    if (path.startsWith('/auth/')) throw new Error('Log in to Autolab first')
    if (path.endsWith('/edit')) {
      warnings.push(`Autolab: set your nickname in ${ref.name} first, then sync again`)
      failedIds.push(ref.slug)
      continue
    }
    // The parsers never throw (a missing element is skipped), so no try/catch is needed here.
    const { categories, items } = parseAutolabGradebook(page.html)
    const { number, also } = parseCourseNumbers(ref.slug, ref.name)
    courses.push({
      source: 'autolab',
      sourceId: ref.slug,
      number,
      alsoNumbers: also,
      title: ref.name.replace(/\s*\([^)]*\)\s*$/, '') || ref.slug,
      term: termFromAutolabName(ref.name, ref.slug),
      url: `${AUTOLAB_ORIGIN}/courses/${ref.slug}`,
      weighted: false,
      categories,
      items,
      canvasScore: null,
      canvasGrade: null,
      scheme: null,
      syncedAt: at,
    })
  }
  return { v: 1, kind: 'autolab', at, courses, warnings, failedIds }
}
