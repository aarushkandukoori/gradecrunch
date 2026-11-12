/// <reference path="./chrome.d.ts" />
// The offscreen document: a hidden extension page the service worker opens only while a sync runs. It exists because
// the sync code parses Gradescope and Autolab HTML with DOMParser, which service workers do not have.
// Offscreen documents only get chrome.runtime, so this page just runs the sync and messages the results back;
// the service worker does everything else (storage, talking to the website).
//
// Expected console lines here: "Executing inline event handler violates ... Content Security Policy" when a parsed page
// has onclick="..." attributes (Gradescope's logged-out home page has four). DOMParser builds an inert copy of the
// page, and Chrome still checks those attributes against the extension's CSP and blocks them. Nothing from the grade
// sites ever runs here; the message just shows the CSP doing its job.
import { isOffscreenSyncRequest, type OffscreenProgress } from './rules'
import { runSource } from './sync'

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isOffscreenSyncRequest(message)) return undefined // not for us (e.g. our own progress messages)
  const { source } = message

  // Each progress line goes back to the service worker, which relays it to the website.
  const onProgress = (text: string) => {
    const progress: OffscreenProgress = { target: 'background', type: 'progress', source, message: text }
    chrome.runtime.sendMessage(progress).catch(() => {}) // the service worker may be busy restarting: skip one line
  }

  void runSource(source, onProgress).then(sendResponse)
  return true // tells Chrome we will call sendResponse later, after the sync finishes
})
