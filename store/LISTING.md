# Chrome Web Store listing (copy-paste kit)

Upload: `gradecrunch-extension.zip` (build it with `npm run build:extension`; the store build has no dev "key" and
no localhost access). Images are in this folder.

## Developer account (owner does this once)

1. Use a **personal Gmail** with 2-Step Verification on (not @andrew.cmu.edu; the account email can't be changed later).
2. Open https://chrome.google.com/webstore/devconsole, accept the developer agreement, pay the one-time registration fee.
3. Publisher name: `GradeCrunch`. Verify the contact email. Trader status: **Non-trader** (free, not a business).

## Store listing tab

- **Name** (from the manifest): GradeCrunch: Grades and QPA
- **Summary** (manifest description, max 132): See all your grades and your QPA in one place. Reads your own Canvas, Gradescope and Autolab grades in your browser; nothing is sent to a server.
- **Category:** Education
- **Language:** English
- **Description:**

```
GradeCrunch shows all your grades and your QPA in one place, for Carnegie Mellon students.

It reads your own grades from Canvas, Gradescope and Autolab using the logins you already have, merges them per
class, and opens them on the GradeCrunch website (https://grades.aarushkandukoori.com):
- every class with its current percent and letter
- your estimated semester QPA, weighted by units
- what you need on the rest of the semester for each letter
- what-if scores and syllabus weights you can adjust

Privacy
- Your grades stay in your browser. GradeCrunch has no server that receives them, no accounts, no ads and no analytics.
- The extension only talks to the GradeCrunch website, and only reads canvas.cmu.edu, www.gradescope.com and
  autolab.andrew.cmu.edu.
- It never asks for your password. If you are not logged in, it links you to the usual CMU login.
- Open source: https://github.com/aarushkandukoori/gradecrunch

GradeCrunch's use of information received from Canvas, Gradescope and Autolab follows the Chrome Web Store User Data
Policy, including the Limited Use requirements.

GradeCrunch is an independent student project. It is not affiliated with or endorsed by Carnegie Mellon University,
Instructure (Canvas), Turnitin (Gradescope) or the Autolab project. Grades shown are estimates; your official record
is in SIO.
```

- **Icon:** from the zip (icons/icon128.png)
- **Screenshots (1280x800):** screenshot-2-dashboard.png, screenshot-3-class.png, screenshot-1-welcome.png
- **Small promo tile (440x280):** promo-tile-440x280.png
- **Homepage URL:** https://grades.aarushkandukoori.com
- **Support URL:** https://github.com/aarushkandukoori/gradecrunch/issues

## Privacy tab

- **Single purpose:** Show the user their own grades from Canvas, Gradescope and Autolab, merged per class with an
  estimated QPA, on the GradeCrunch website.
- **Permission justifications:**
  - `storage`: Remembers that you finished the welcome page, and keeps a copy of your last successful sync on your
    computer so a failed sync never erases it.
  - `offscreen`: Reads Gradescope and Autolab course pages with the browser's HTML parser (DOMParser), which extension
    service workers cannot use.
  - Host permissions (canvas.cmu.edu, www.gradescope.com, autolab.andrew.cmu.edu): Reads your own courses, assignments,
    scores and letter cutoffs from these sites with the login you already have, only when the GradeCrunch website asks
    (when you open it or click Sync).
- **Remote code:** No, I am not using remote code.
- **Data usage:** collects **Website content** only (course names, assignment names, scores and letter cutoffs read from
  those sites). It stays on the user's device and is shown only on the GradeCrunch website.
- **Certifications:** tick all three (not sold to third parties; not used or transferred for purposes unrelated to the
  single purpose; not used to determine creditworthiness or for lending).
- **Privacy policy URL:** https://grades.aarushkandukoori.com/privacy

## Distribution tab

- Visibility: **Public**. Regions: all.
- Untick "publish automatically after review" so we can test the approved build before it goes live (30-day window).

## Test instructions (for the reviewer)

```
GradeCrunch needs a Carnegie Mellon Canvas or Gradescope login, which reviewers won't have.
To see what students see without one: open https://grades.aarushkandukoori.com and click "See a demo".
With the extension installed and no CMU login: on the website, click "Sync my grades". The extension checks
canvas.cmu.edu and www.gradescope.com and the site shows "Log in to Canvas" and "Log in to Gradescope" with links to
the normal login pages. That is the expected behavior when logged out.
On install the extension opens a welcome page that explains what it reads; it syncs nothing until you click Continue.
```

## After approval

1. Copy the store's extension id into `KNOWN_EXTENSION_IDS` in `extension/protocol.ts`.
2. Set `CHROME_STORE_URL` in `src/lib/brand.ts` to the listing URL (the welcome page then shows "Add to Chrome").
3. Rebuild and deploy the site (`./scripts/deploy.sh`).
4. Optional: submit the same zip to Microsoft Edge Add-ons (free).
