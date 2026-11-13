# Chrome Web Store Listing - GradeCrunch: Grades and QPA

> Last Updated: 2026-11-13

Copy-paste kit for the Chrome Developer Dashboard. The step-by-step guide (developer account, reviewer test
instructions, what to do after approval) is in `store/LISTING.md`. Where the two differ, this file is newer and wins.
Upload `gradecrunch-extension.zip` from `npm run build:extension` (store build: no dev "key", no localhost access).

**Which version** - This covers the extension as built today, v1.1.0 (`extension/manifest.json` and the zip). 1.1.0
adds SIO and is not committed or checked on real data yet. Everything below, the paste-ready text included, matches
that zip (it has the s3.andrew.cmu.edu permission). To submit before SIO is checked, build a zip without SIO instead
and take SIO back out of the text.

## Store Listing

**Extension Name** - GradeCrunch: Grades and QPA (matches manifest.json, 27 of 75 characters)

**Short Description** - Comes from the manifest "description" (max 132). Now (1.1.0, 126 characters): All your CMU
grades and QPA in one place. Reads Canvas, Gradescope, Autolab and SIO in your browser. No accounts, no tracking.
(The old ending "Nothing goes to a server." stopped being true once the website got its optional AI chat, now called
the AI advisor.)

**Detailed Description** - Each paragraph is one line so it pastes without broken lines (the store keeps line breaks).

```
GradeCrunch shows all your grades and your QPA in one place, for Carnegie Mellon students.

It reads your own grades from Canvas, Gradescope and Autolab using the logins you already have, merges them per class, and opens them on the GradeCrunch website (https://grades.aarushkandukoori.com):
- every class with its current percent and letter
- your estimated semester QPA, weighted by units
- what you need on the rest of the semester for each letter
- grading weights taken from each class's syllabus, so your percent is right even when Canvas is set up wrong
- what-if scores and weights you can adjust
- from SIO, your official record: exact units, pass/fail classes, mid-semester and final grades, and your past semesters with your official cumulative QPA
- The AI advisor, an optional AI chat on the website, answers questions about your grades and fixes settings when you tell it

Privacy
- Your grades are saved only in your browser. No accounts, no ads and no analytics.
- Only if you use the AI advisor: your question and a summary of your grades go through the GradeCrunch server to OpenAI to get an answer. GradeCrunch keeps none of it. OpenAI doesn't train on it and keeps it up to 30 days to check for abuse.
- The extension only talks to the GradeCrunch website, and only reads canvas.cmu.edu, www.gradescope.com, autolab.andrew.cmu.edu, your Grades and QPA page in SIO (s3.andrew.cmu.edu) and (if you allow it) the place Canvas stores syllabus PDFs.
- It never asks for your password. If you are not logged in, it links you to the usual CMU login.
- Open source: https://github.com/aarushkandukoori/gradecrunch

GradeCrunch's use of information received from Canvas, Gradescope, Autolab and SIO follows the Chrome Web Store User Data Policy, including the Limited Use requirements.

GradeCrunch is an independent student project. It is not affiliated with or endorsed by Carnegie Mellon University, Instructure (Canvas), Turnitin (Gradescope) or the Autolab project. Grades shown are estimates; your official record is in SIO.
```

The SIO lines (the "from SIO" bullet, SIO in the "only reads" line and in the Limited Use sentence) are in the block
above because the zip reads SIO. `store/LISTING.md` has the same text.

**Category** - Education

**Single Purpose** - Show the user their own grades from Canvas, Gradescope, Autolab and SIO, merged per class with an
estimated QPA, on the GradeCrunch website.

**Primary Language** - English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128x128 PNG | Ready | extension/icons/icon128.png (inside the zip) |
| Screenshot 1 | 1280x800 | Ready | store/screenshot-2-dashboard.png |
| Screenshot 2 | 1280x800 | Ready | store/screenshot-3-class.png |
| Screenshot 3 | 1280x800 | Ready | store/screenshot-1-welcome.png |
| Small Promo Tile | 440x280 | Ready | store/promo-tile-440x280.png |
| Marquee Promo Tile | 1400x560 | Not made (optional) | |

All sizes checked 2026-11-13.

### Screenshot Notes

- Screenshot 1 (dashboard) - estimated semester QPA, then one row per class with percent, letter, what is needed
  for an A and the P/F button, with the AI advisor button in the top bar. Demo data. Retaken 2026-11-13 (first to drop
  "Ask Claude about my grades", then again for the AI advisor name and the P/F buttons, then again for the new demo
  grades: 21-127 is now an A and 76-101 a B, so the demo QPA is 3.07 and every P/F tap changes it).
- Screenshot 2 (class page, 15-122) - percent and letter, the syllabus weights line, "Ask the AI advisor about this
  class", what you need for each letter, assignments by category with weights, the what-if switch. Demo data.
  Retaken 2026-11-13 (again for the AI advisor name).
- Screenshot 3 (extension welcome page) - what it reads (including SIO), where it goes (including the AI advisor
  paragraph), how to remove it, the syllabus PDF checkbox and Continue, as a student sees it right after installing.
  Retaken from the v1.1.0 store build on 2026-11-13 at 73% zoom so the whole page down to Continue fits in 1280x800
  (the page is longer now), and again the same day for the AI advisor name.
- Promo tile - remade 2026-11-13 with the same layout; the line under the headline now reads "Runs in your browser.
  No accounts, no tracking." (it said "Nothing sent to a server").

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| storage | permissions | Remembers that you finished the welcome page, and keeps a copy of your last successful sync (without syllabus PDFs) on your computer so a failed sync never erases it. Removing the extension deletes it. |
| offscreen | permissions | Reads Gradescope, Autolab and (**1.1.0**) SIO grade pages with the browser's HTML parser, which the extension's background script cannot use. The hidden page is open only while a sync runs and closes when it finishes. |
| https://canvas.cmu.edu/* | host_permissions | Reads your own courses, assignments, scores, letter cutoffs and each class's syllabus (Syllabus page, home page, syllabus PDFs) from Canvas with the login you already have, only when the GradeCrunch website asks (when you open it or click Sync). The syllabus is used only to read grading weights. It only reads; it never submits or changes anything. |
| https://www.gradescope.com/* | host_permissions | Reads your own Gradescope courses and scores with your existing login, one page a second, only when the GradeCrunch website asks. |
| https://autolab.andrew.cmu.edu/* | host_permissions | Reads your own Autolab courses and scores with your existing login, only when the GradeCrunch website asks. |
| https://s3.andrew.cmu.edu/* | host_permissions (**1.1.0**) | SIO, CMU's official student record. Reads your own Grades and QPA pages (each semester's courses, units, grade option, mid-semester and final grades, official QPA) with your existing login, one semester at a time, only when the GradeCrunch website asks. That is the only SIO page it opens (/sio/mpa/grades/home, once per semester), and it never changes anything there. It gives exact course units, pass/fail classes and your past semesters. |
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
| Website content | Yes | Not by the extension: it hands the data only to the GradeCrunch website open in the same browser. The website sends a summary off the device only when the student uses its optional AI advisor chat (see below). | Course names, assignment names, scores, letter cutoffs and course syllabi (text and PDFs), to show grades and grading weights. **1.1.0** adds SIO semesters, units, grade options, grades and official QPA. | Only with OpenAI, only for the AI advisor: to answer a question the student asks about their grades. Not sold, not used for ads or training. |

**AI advisor (the website's optional AI chat)** - Off until the student opens it and accepts a notice. Each question
sends the question, the recent chat, the notes the AI advisor saved and a grade summary (classes, scores, weights,
units, QPA, SIO grades; no name, links or syllabus text) through the site's `/api/chat` Pages Function to OpenAI. The function stores
nothing and logs only error codes; OpenAI doesn't train on API data and keeps it up to 30 days for abuse monitoring.
The chat and notes stay in the browser's local storage.

Checked in the store bundle on 2026-11-13 - the extension fetches only canvas.cmu.edu, www.gradescope.com,
autolab.andrew.cmu.edu, s3.andrew.cmu.edu and (through Canvas downloads, if allowed) inscloudgate.net. No analytics,
no other server, and it keeps data in local extension storage only (nothing synced to Google). The website's only
server code is the AI advisor function above.

### Data Use Certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

**Remote code** - No. All code ships in the zip, and the build refuses eval and new Function.

## Privacy Policy

**Privacy Policy URL** - https://grades.aarushkandukoori.com/privacy

Live (checked 2026-11-13), but the deployed text is older than the extension: it says the extension reads "the same
three sites" and does not mention syllabi, the optional inscloudgate.net access or SIO. The committed page source
(`src/ui/PrivacyPage.tsx`) already covers syllabi and inscloudgate.net; the working tree also covers SIO (what is read
on s3.andrew.cmu.edu) and the AI advisor (what goes to OpenAI and when, what OpenAI keeps, the chat's storage keys, no
more "no server code" claim). Deploying the site after that ships fixes all of it.

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
| 1.1.0 | 2026-11-13 | Same draft, new name: the website's chat is now called "AI advisor" (it was "Ask"). The welcome page paragraph, the store description (here and in store/LISTING.md), the data-use answers and all three screenshots use the new name. The extension's code is unchanged; the rebuilt zip differs only in the welcome page text, so it stays 1.1.0 (never submitted). | Draft |
| 1.1.0 | 2026-11-13 | Adds SIO (s3.andrew.cmu.edu host permission): past semesters, exact units, grade options, mid-semester and final grades, official QPA. Its hello lists the sites it can sync, so the website asks only for those. The unpacked dev build (only) answers the website's reload request so a rebuilt copy updates itself; the store build refuses it (decided at build time). Summary and welcome page reworded for the website's optional Ask chat (no more "nothing goes to a server"). Built into the current zip; not committed or checked on real data yet. | Draft |
| 1.0.0 | 2026-11-12 | First version. Canvas, Gradescope and Autolab sync. Reads Canvas syllabi (Syllabus page, home page, syllabus PDFs) for grading weights; PDFs need the optional inscloudgate.net permission from the welcome page. | Draft (not submitted) |

## Review Notes

### Before Submitting

- [ ] Developer account registered (steps in `store/LISTING.md`).
- [ ] Fresh `npm run build:extension`, then upload `gradecrunch-extension.zip` (it holds only the extension's own
  files, no source, tests or docs).
- [x] Screenshot 3 replaced with the extension's welcome page (2026-11-13).
- [ ] Site deployed, so the privacy policy covers syllabi and the PDF permission.
- [x] **1.1.0** - SIO is in the store description, the single purpose and the Limited Use sentence above (2026-11-13),
  matching the zip. The extension's welcome page and the privacy policy source cover SIO too (working tree, not
  committed); screenshot 3 already shows that page.
- [x] **AI advisor wording** (2026-11-13, working tree) - manifest description, store description, welcome page,
  privacy policy and the data-use answers above now say what goes to OpenAI and when. The chat was renamed from "Ask"
  to "AI advisor" the same day; all of these use the new name.
- [x] **AI advisor images** (2026-11-13) - promo tile remade without "Nothing sent to a server" (it never named the
  chat); all three screenshots retaken (welcome page with the SIO and AI advisor paragraphs, dashboard and class page
  with the AI advisor button).
- [ ] **AI advisor and Limited Use** - The AI advisor sends a summary of grades this extension collected to OpenAI, on
  the student's request. Decide whether the single purpose should say so (for example "... on the GradeCrunch website,
  and answer the student's questions about them there"), since Limited Use allows transfers only for the single
  purpose.
- [ ] Reviewer test instructions pasted from `store/LISTING.md`.

### Last Browser Test (2026-11-13)

Dev build v1.1.0 in the headless Chrome from chrome-devtools-mcp. It has no CMU logins, so no real sync was run.
- Installed (id ammnjhfalihccnpglfookiiebpiaoeak), service worker running, welcome page opened on install.
- The toolbar button opened grades.aarushkandukoori.com, which found the extension and showed "Finish setup".
- From the site, hello answered v1.1.0, consent false, sources canvas/gradescope/autolab/sio. A sync before consent
  was refused ("consent"); an unknown request and a wrong port name were refused too.
- No console errors in the service worker, welcome page or site. Nothing stored, no offscreen page opened.
- Later the same day, the store build v1.1.0 with the new wording: installed in the same kind of headless throwaway
  Chrome, the welcome page opened on install with the SIO and Ask paragraphs, no console errors.
- After the rename (same day): the rebuilt store build v1.1.0, loaded in a headless throwaway Chrome for Testing,
  opened its welcome page on install with the AI advisor paragraph; screenshot 3 was retaken from that page.

### Known Issues / Limitations

- The optional permission prompt names inscloudgate.net, which students will not recognize. The welcome page explains
  that it is where Canvas stores PDFs.
- If the student declines the PDF permission, syllabus PDFs are skipped; Syllabus page and home page text still sync.
- Autolab sync is beta. Its page parsing follows Autolab's open-source code and has not been run against a live
  Autolab account.
- SIO ends idle sessions (its pages carry a "session is about to expire" warning), so the site may often show "Log in
  to SIO". That is expected: the student logs in the usual CMU way and the site syncs SIO again when they come back to
  its tab. How long an SIO session lasts has not been measured.
- Once a version is live, an update that adds a required host permission makes Chrome turn the extension off until
  each user accepts it. 1.1.0 will be the first version submitted, so s3.andrew.cmu.edu is in it from the start.

### Rejection History

None yet.
