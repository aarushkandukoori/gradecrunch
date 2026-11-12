/// <reference path="./chrome.d.ts" />
// The welcome page's one button. Clicking Continue records the student's consent (the service worker refuses to sync
// without it) and takes them to the GradeCrunch site.
import { CONSENT_KEY, SITE_URL } from './rules'

const button = document.getElementById('continue') as HTMLButtonElement
const status = document.getElementById('status') as HTMLElement

// When the website opened this page, the URL carries that tab's id (?tab=123) so we can switch back to it.
const backToTab = Number(new URLSearchParams(location.search).get('tab'))

// Already agreed earlier (e.g. the student reopened this page): the button just opens the site.
void chrome.storage.local.get(CONSENT_KEY).then((stored) => {
  if (stored[CONSENT_KEY] === true) button.textContent = 'Open GradeCrunch'
})

button.addEventListener('click', async () => {
  button.disabled = true
  try {
    await chrome.storage.local.set({ [CONSENT_KEY]: true })
  } catch {
    status.textContent = 'Could not save your choice. Please try again.'
    button.disabled = false
    return
  }
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
