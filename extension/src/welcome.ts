/// <reference path="./chrome.d.ts" />
// The welcome page. Clicking Continue:
//   1. asks Chrome for the optional syllabus-PDF permission when the box is ticked (see PDF_ORIGINS in rules.ts),
//   2. records the student's consent (the service worker refuses to sync without it),
//   3. takes them back to the GradeCrunch site.
import { CONSENT_KEY, PDF_ORIGINS, SITE_URL } from './rules'

const button = document.getElementById('continue') as HTMLButtonElement
const pdfBox = document.getElementById('pdfs') as HTMLInputElement
const status = document.getElementById('status') as HTMLElement

// When the website opened this page, the URL carries that tab's id (?tab=123) so we can switch back to it.
const backToTab = Number(new URLSearchParams(location.search).get('tab'))

// Already agreed earlier (e.g. the student reopened this page): the button just opens the site, and the box shows
// whether PDFs are currently allowed.
void chrome.storage.local.get(CONSENT_KEY).then(async (stored) => {
  if (stored[CONSENT_KEY] !== true) return
  button.textContent = 'Open GradeCrunch'
  pdfBox.checked = await chrome.permissions.contains({ origins: PDF_ORIGINS }).catch(() => false)
})

button.addEventListener('click', async () => {
  button.disabled = true
  // chrome.permissions.request only works during the click itself, so it must be the FIRST chrome call, made before
  // any await. We don't wait for the answer yet: consent is saved while Chrome's prompt is still open, so an
  // unanswered prompt can never leave the extension unable to sync. Saying no is fine too: syncing still works, just
  // without syllabus PDFs.
  const pdfChoice = (
    pdfBox.checked
      ? chrome.permissions.request({ origins: PDF_ORIGINS })
      : chrome.permissions.remove({ origins: PDF_ORIGINS }) // unticked: take it back
  ).catch(() => false) // an error here only means no PDFs
  try {
    await chrome.storage.local.set({ [CONSENT_KEY]: true })
  } catch {
    status.textContent = 'Could not save your choice. Please try again.'
    button.disabled = false
    return
  }
  await pdfChoice // leave this page only after the student answered Chrome's prompt
  if (Number.isInteger(backToTab) && backToTab > 0 && (await switchToTab(backToTab))) return
  location.href = SITE_URL
})

/** Bring the website tab to the front and close this one. False when that tab is gone. */
async function switchToTab(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.update(tabId, { active: true })
    const me = await chrome.tabs.getCurrent()
    if (me?.id !== undefined) await chrome.tabs.remove(me.id)
    return true
  } catch {
    return false
  }
}
