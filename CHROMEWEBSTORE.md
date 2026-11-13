# Chrome Web Store Listing - GradeCrunch: Grades and QPA

> Last Updated: 2026-11-13

Copy-paste kit for the Chrome Developer Dashboard. The step-by-step guide (developer account, reviewer test
instructions, what to do after approval) is in `store/LISTING.md`. Where the two differ, this file is newer and wins.
Upload `gradecrunch-extension.zip` from `npm run build:extension` (store build: no dev "key", no localhost access).

**Which version** - This covers the extension as built today, v1.1.0 (`extension/manifest.json` and the zip). 1.1.0
adds SIO and is not committed or checked on real data yet. Lines marked **1.1.0** depend on that work shipping.

## Store Listing

**Extension Name** - GradeCrunch: Grades and QPA (matches manifest.json, 27 of 75 characters)

**Short Description** - Comes from the manifest "description" (max 132). Now (1.1.0, 122 characters): All your grades
and QPA in one place. Reads Canvas, Gradescope, Autolab and SIO in your browser. Nothing goes to a server.

**Detailed Description** - Each paragraph is one line so it pastes without broken lines (the store keeps line breaks).

```
GradeCrunch shows all your grades and your QPA in one place, for Carnegie Mellon students.

It reads your own grades from Canvas, Gradescope and Autolab using the logins you already have, merges them per class, and opens them on the GradeCrunch website (https://grades.aarushkandukoori.com):
- every class with its current percent and letter
- your estimated semester QPA, weighted by units
- what you need on the rest of the semester for each letter
- grading weights taken from each class's syllabus, so your percent is right even when Canvas is set up wrong
- what-if scores and weights you can adjust

Privacy
- Your grades stay in your browser. GradeCrunch has no server that receives them, no accounts, no ads and no analytics.
- The extension only talks to the GradeCrunch website, and only reads canvas.cmu.edu, www.gradescope.com, autolab.andrew.cmu.edu and (if you allow it) the place Canvas stores syllabus PDFs.
- It never asks for your password. If you are not logged in, it links you to the usual CMU login.
- Open source: https://github.com/aarushkandukoori/gradecrunch

GradeCrunch's use of information received from Canvas, Gradescope and Autolab follows the Chrome Web Store User Data Policy, including the Limited Use requirements.

GradeCrunch is an independent student project. It is not affiliated with or endorsed by Carnegie Mellon University, Instructure (Canvas), Turnitin (Gradescope) or the Autolab project. Grades shown are estimates; your official record is in SIO.
```

**1.1.0 additions** (paste once SIO sync is verified) - add the bullet `- your past semesters from SIO, with exact units
and your official cumulative QPA`, add `s3.andrew.cmu.edu (SIO)` to the "only reads" line, and add SIO to the
Limited Use sentence.

**Category** - Education

**Single Purpose** - Show the user their own grades from Canvas, Gradescope and Autolab, merged per class with an
estimated QPA, on the GradeCrunch website. (**1.1.0** - name SIO next to Autolab.)

**Primary Language** - English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128x128 PNG | Ready | extension/icons/icon128.png (inside the zip) |
| Screenshot 1 | 1280x800 | Ready | store/screenshot-2-dashboard.png |
| Screenshot 2 | 1280x800 | Ready | store/screenshot-3-class.png |
| Screenshot 3 | 1280x800 | Replace | store/screenshot-1-welcome.png |
| Small Promo Tile | 440x280 | Ready | store/promo-tile-440x280.png |
| Marquee Promo Tile | 1400x560 | Not made (optional) | |

All sizes checked 2026-11-13.

### Screenshot Notes

- Screenshot 1 (dashboard) - estimated semester QPA, then one row per class with percent, letter and what is needed
  for an A. Demo data.
- Screenshot 2 (class page, 15-122) - percent and letter, what you need for each letter, assignments by category with
  weights, the what-if switch. Demo data.
- Screenshot 3 - the current file is the old website home page (bookmarklet steps and "A Chrome extension is coming
  soon"), which is wrong for the extension's own listing. Replace it with the extension's welcome page (what it reads,
  where it goes, the syllabus PDF checkbox) or leave it out.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| storage | permissions | Remembers that you finished the welcome page, and keeps a copy of your last successful sync (without syllabus PDFs) on your computer so a failed sync never erases it. Removing the extension deletes it. |
| offscreen | permissions | Reads Gradescope, Autolab and (**1.1.0**) SIO grade pages with the browser's HTML parser, which the extension's background script cannot use. The hidden page is open only while a sync runs and closes when it finishes. |
| https://canvas.cmu.edu/* | host_permissions | Reads your own courses, assignments, scores, letter cutoffs and each class's syllabus (Syllabus page, home page, syllabus PDFs) from Canvas with the login you already have, only when the GradeCrunch website asks (when you open it or click Sync). The syllabus is used only to read grading weights. It only reads; it never submits or changes anything. |
| https://www.gradescope.com/* | host_permissions | Reads your own Gradescope courses and scores with your existing login, one page a second, only when the GradeCrunch website asks. |
| https://autolab.andrew.cmu.edu/* | host_permissions | Reads your own Autolab courses and scores with your existing login, only when the GradeCrunch website asks. |
| https://s3.andrew.cmu.edu/* | host_permissions (**1.1.0**) | SIO, CMU's official student record. Reads your own Grades and QPA pages (each semester's courses, units, grade option, mid-semester and final grades, official QPA) with your existing login, one semester at a time, only when the GradeCrunch website asks. |
| https://*.inscloudgate.net/* | optional_host_permissions | Optional, asked on the welcome page with a checkbox. Canvas keeps uploaded files such as syllabus PDFs on this Instructure storage service and redirects downloads there. GradeCrunch downloads only the syllabus PDFs of your own classes, so it can read the real grading weights. Without it, everything else still works. |
| externally_connectable | manifest key (not a permission) | Lets only the GradeCrunch website (https://grades.aarushkandukoori.com and its original address https://gradecrunch.pages.dev) connect to the extension. That is how the site asks for a sync and receives your grades, inside your browser. Chrome blocks every other website, and the extension checks the address again and answers only GradeCrunch's own requests. The dev build also allows http://localhost for testing; the store zip leaves it out. |

**Dashboard** - storage and offscreen each get their own box. Host permissions share one box: paste the host rows
(including the optional one) there together. externally_connectable has no box; its row is here so every manifest key
a reviewer sees has an answer.

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes - website content only, kept on the user's device.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | | | |
| Health info | No | | | |
| Financial info | No | | | |
| Authentication info | No | | | |
| Personal communications | No | | | |
| Location | No | | | |
| Web history | No | | | |
| User activity | No | | | |
| Website content | Yes | No (handed only to the GradeCrunch website open in the same browser) | Course names, assignment names, scores, letter cutoffs and course syllabi (text and PDFs), to show grades and grading weights. **1.1.0** adds SIO semesters, units, grade options, grades and official QPA. | No |

Checked in the store bundle on 2026-11-13 - the extension fetches only canvas.cmu.edu, www.gradescope.com,
autolab.andrew.cmu.edu, s3.andrew.cmu.edu and (through Canvas downloads, if allowed) inscloudgate.net. No analytics,
no other server, and it keeps data in local extension storage only (nothing synced to Google).

### Data Use Certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

**Remote code** - No. All code ships in the zip, and the build refuses eval and new Function.

## Privacy Policy

**Privacy Policy URL** - https://grades.aarushkandukoori.com/privacy

Live (checked 2026-11-13), but the deployed text is older than the extension: it says the extension reads "the same
three sites" and does not mention syllabi, the optional inscloudgate.net access or SIO. The committed page source
(`src/ui/PrivacyPage.tsx`) already covers syllabi and inscloudgate.net, so deploying the site fixes those two. SIO
still has to be added for 1.1.0.

## Distribution

**Visibility** - Public. **Regions** - All regions. Untick "publish automatically after review".

## Developer Info

**Publisher Name** - GradeCrunch

**Contact Email** - set in the developer console (personal Gmail, see store/LISTING.md)

**Support URL** - https://github.com/aarushkandukoori/gradecrunch/issues

**Homepage URL** - https://grades.aarushkandukoori.com

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.1.0 | 2026-11-13 | Adds SIO (s3.andrew.cmu.edu host permission): past semesters, exact units, grade options and official QPA. Built into the current zip; not committed or checked on real data yet. | Draft |
| 1.0.0 | 2026-11-12 | First version. Canvas, Gradescope and Autolab sync. Reads Canvas syllabi (Syllabus page, home page, syllabus PDFs) for grading weights; PDFs need the optional inscloudgate.net permission from the welcome page. | Draft (not submitted) |

## Review Notes

### Before Submitting

- [ ] Developer account registered (steps in `store/LISTING.md`).
- [ ] Fresh `npm run build:extension`, then upload `gradecrunch-extension.zip` (it holds only the extension's own
  files, no source, tests or docs).
- [ ] Screenshot 3 replaced (see Screenshot Notes).
- [ ] Site deployed, so the privacy policy covers syllabi and the PDF permission.
- [ ] **1.1.0** - SIO added to the store description, the privacy policy and the extension's welcome page (its "What it
  reads" still lists only Canvas, Gradescope and Autolab).
- [ ] **Ask chat** - if it ships, the site sends a summary of the student's grades (collected by this extension) and
  their saved notes to OpenAI through its `/api/chat` function whenever the student uses the chat
  (`functions/api/chat.ts`, not committed yet). "Nothing goes to a server" (manifest description, store description,
  promo tile, welcome page, privacy policy) would then be false, and the data-use answers above (transmitted
  off-device, third parties) need another look before submitting.
- [ ] Reviewer test instructions pasted from `store/LISTING.md`.

### Last Browser Test (2026-11-13)

Dev build v1.1.0 in the headless Chrome from chrome-devtools-mcp. It has no CMU logins, so no real sync was run.
- Installed (id ammnjhfalihccnpglfookiiebpiaoeak), service worker running, welcome page opened on install.
- The toolbar button opened grades.aarushkandukoori.com, which found the extension and showed "Finish setup".
- From the site, hello answered v1.1.0, consent false, sources canvas/gradescope/autolab/sio. A sync before consent
  was refused ("consent"); an unknown request and a wrong port name were refused too.
- No console errors in the service worker, welcome page or site. Nothing stored, no offscreen page opened.

### Known Issues / Limitations

- The optional permission prompt names inscloudgate.net, which students will not recognize. The welcome page explains
  that it is where Canvas stores PDFs.
- If the student declines the PDF permission, syllabus PDFs are skipped; Syllabus page and home page text still sync.
- Autolab sync is beta. Its page parsing follows Autolab's open-source code and has not been run against a live
  Autolab account.

### Rejection History

None yet.
