# Chrome Web Store Listing - GradeCrunch: Grades and QPA

> Last Updated: 2026-11-12

Copy-paste kit for the Chrome Developer Dashboard. The longer step-by-step guide (developer account, reviewer test
instructions, what to do after approval) is in `store/LISTING.md`. Upload `gradecrunch-extension.zip` from
`npm run build:extension` (store build: no dev "key", no localhost access).

## Store Listing

**Extension Name** - GradeCrunch: Grades and QPA (matches manifest.json)

**Short Description** - All your grades and QPA in one place. Reads your Canvas, Gradescope and Autolab grades in your
browser. Nothing goes to a server.

**Detailed Description**

```
GradeCrunch shows all your grades and your QPA in one place, for Carnegie Mellon students.

It reads your own grades from Canvas, Gradescope and Autolab using the logins you already have, merges them per
class, and opens them on the GradeCrunch website (https://grades.aarushkandukoori.com):
- every class with its current percent and letter
- your estimated semester QPA, weighted by units
- what you need on the rest of the semester for each letter
- grading weights taken from each class's syllabus, so your percent is right even when Canvas is set up wrong
- what-if scores and weights you can adjust

Privacy
- Your grades stay in your browser. GradeCrunch has no server that receives them, no accounts, no ads and no analytics.
- The extension only talks to the GradeCrunch website, and only reads canvas.cmu.edu, www.gradescope.com,
  autolab.andrew.cmu.edu and (if you allow it) the place Canvas stores syllabus PDFs.
- It never asks for your password. If you are not logged in, it links you to the usual CMU login.
- Open source: https://github.com/aarushkandukoori/gradecrunch

GradeCrunch's use of information received from Canvas, Gradescope and Autolab follows the Chrome Web Store User Data
Policy, including the Limited Use requirements.

GradeCrunch is an independent student project. It is not affiliated with or endorsed by Carnegie Mellon University,
Instructure (Canvas), Turnitin (Gradescope) or the Autolab project. Grades shown are estimates; your official record
is in SIO.
```

**Category** - Education

**Single Purpose** - Show the user their own grades from Canvas, Gradescope and Autolab, merged per class with an
estimated QPA, on the GradeCrunch website.

**Primary Language** - English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128x128 PNG | Ready | extension/icons/icon128.png |
| Screenshot 1 | 1280x800 | Ready | store/screenshot-2-dashboard.png |
| Screenshot 2 | 1280x800 | Ready | store/screenshot-3-class.png |
| Screenshot 3 | 1280x800 | Needs update (welcome page now has the syllabus PDF checkbox) | store/screenshot-1-welcome.png |
| Small Promo Tile | 440x280 | Ready | store/promo-tile-440x280.png |

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| storage | permissions | Remembers that you finished the welcome page, and keeps a copy of your last successful sync on your computer so a failed sync never erases it. |
| offscreen | permissions | Reads Gradescope and Autolab course pages with the browser's HTML parser, which the extension's background script cannot use. |
| https://canvas.cmu.edu/* | host_permissions | Reads your own courses, assignments, scores, letter cutoffs and syllabus pages from Canvas with the login you already have, only when the GradeCrunch website asks (when you open it or click Sync). |
| https://www.gradescope.com/* | host_permissions | Reads your own Gradescope courses and scores with your existing login, only when the GradeCrunch website asks. |
| https://autolab.andrew.cmu.edu/* | host_permissions | Reads your own Autolab courses and scores with your existing login, only when the GradeCrunch website asks. |
| https://*.inscloudgate.net/* | optional_host_permissions | Optional, asked on the welcome page with a checkbox. Canvas keeps uploaded files such as syllabus PDFs on this Instructure storage service and redirects downloads there. GradeCrunch downloads only the syllabus PDFs of your own classes, so it can read the real grading weights. Without it, everything else still works. |

## Privacy & Data Use

**Does the extension collect user data?** Yes, website content only, kept on the user's device.

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
| Website content | Yes | No (handed only to the GradeCrunch page in the same browser) | Course names, assignment names, scores, letter cutoffs and course syllabi (text and PDFs), to show grades and grading weights | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

**Remote code** - No.

## Privacy Policy

**Privacy Policy URL** - https://grades.aarushkandukoori.com/privacy (mention that syllabi are read too, on-device only)

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
| 1.0.0 | 2026-11-12 | First version. Canvas, Gradescope and Autolab sync. Reads Canvas syllabi (Syllabus page, home page, syllabus PDFs) for grading weights; PDFs need the optional inscloudgate.net permission from the welcome page. | Draft |

## Review Notes

### Known Issues / Limitations
- The optional permission prompt names inscloudgate.net, which students will not recognize. The welcome page explains
  that it is where Canvas stores PDFs.
- If the student declines the PDF permission, syllabus PDFs are skipped; Syllabus page and home page text still sync.

### Rejection History
None yet.
